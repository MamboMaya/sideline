//! Native mic capture (cpal) + recorder state machine. Transcription itself
//! lives in `whisper.rs`; this module owns the record→stop→handoff pipeline,
//! the tray REC indicator, and the level/state events the frontend listens
//! for (see docs/backend.md).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use tauri::{AppHandle, Emitter, Manager};

/// Recorder lifecycle, mirrored to the frontend via the `recording-state`
/// event (string payload) and to the tray title.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecState {
    Idle,
    Recording,
    Transcribing,
    DownloadingModel,
    /// Dictation finished and the transcript is on the clipboard — the
    /// pill shows "Copied — ⌘V to paste" for `COPIED_NOTICE` and
    /// then drops to Idle. Idle-equivalent for the hotkeys: a press during
    /// the notice starts a fresh recording (see `toggle_recording_mode`).
    Copied,
    /// The session ended in an error (no speech detected, device died,
    /// transcription failed…) — the pill shows the `capture-error` text for
    /// `FAILED_NOTICE`, then drops to Idle. Without it the pill just
    /// vanished and the error only reached the popover's toast, which is
    /// invisible whenever the popover is closed. Idle-equivalent for the
    /// hotkeys, same as Copied.
    Failed,
    /// A background-tick reminder fired while the recorder could otherwise
    /// start a session — the pill shows "⏰ <text>" for `REMINDER_NOTICE`,
    /// then drops to Idle. Entered only via `show_reminder_notice`
    /// (reminders.rs's `tick` calls it instead of ever focusing the
    /// popover — see that function's doc comment). Idle-equivalent for the
    /// hotkeys, same as Copied/Failed.
    Reminder,
}

impl RecState {
    pub fn as_str(self) -> &'static str {
        match self {
            RecState::Idle => "idle",
            RecState::Recording => "recording",
            RecState::Transcribing => "transcribing",
            RecState::DownloadingModel => "downloading-model",
            RecState::Copied => "copied",
            RecState::Failed => "failed",
            RecState::Reminder => "reminder",
        }
    }

    /// True for the states where no recording session is live and a hotkey
    /// press should start one — Idle, plus the transient Copied/Failed/
    /// Reminder notices.
    pub(crate) fn can_start(self) -> bool {
        matches!(
            self,
            RecState::Idle | RecState::Copied | RecState::Failed | RecState::Reminder
        )
    }
}

/// How long the pill's "Copied — ⌘V to paste" notice stays up.
const COPIED_NOTICE: Duration = Duration::from_millis(1500);
/// How long the pill's failure notice stays up — longer than
/// `COPIED_NOTICE` since it's a sentence to read, not a glance.
const FAILED_NOTICE: Duration = Duration::from_millis(3000);
/// How long the pill's reminder notice stays up — long enough to read a
/// short line without needing to reopen the popover.
const REMINDER_NOTICE: Duration = Duration::from_millis(8000);

/// What a recording session is for: `Note` appends the transcript to
/// inbox.md (⌥⌘R, "Record voice note"), `Dictate` copies it to the
/// clipboard and auto-pastes into the frontmost app instead (⌥⌘V default,
/// "Dictate to clipboard" — see dictate.rs). Only meaningful while `state`
/// is non-`Idle`; carried on `Inner` alongside `state_val` so a press of
/// the OTHER mode's hotkey while a session is active can be told apart from
/// a same-mode stop/no-op (see `toggle_recording_mode`). `Ask` (⌥⌘A
/// default, "Ask a question") hands the transcript to the frontend's Ask
/// view as the `ask-transcript` event — it never touches inbox.md or the
/// clipboard; the frontend sends it to `ask_claude` (claude.rs).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum RecMode {
    #[default]
    Note,
    Dictate,
    Ask,
}

impl RecMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RecMode::Note => "note",
            RecMode::Dictate => "dictate",
            RecMode::Ask => "ask",
        }
    }
}

/// What the capture thread hands back when recording stops: one segment of
/// downmixed mono samples per device used, each at that device's native
/// sample rate — more than one only when the mic vanished mid-recording and
/// capture failed over to the system default (see `capture_thread`).
/// Resampling to 16 kHz happens after handoff, off the audio thread.
struct CaptureResult {
    segments: Vec<(Vec<f32>, u32)>,
}

/// How long `capture_thread` keeps retrying after the recording device
/// vanishes — macOS needs a moment to promote a new default input.
const FAILOVER_WAIT: Duration = Duration::from_secs(2);
/// Failovers allowed per session, so a flapping device (loose USB cable)
/// can't keep the capture thread reopening streams forever.
const MAX_FAILOVERS: u32 = 5;

/// Managed via `app.manage(AudioState::default())`. Only ever one recording
/// session at a time; the lock is held just long enough to flip `state` or
/// hand off channel ends, never across a blocking op.
#[derive(Default)]
pub struct AudioState {
    inner: Mutex<Inner>,
}

impl AudioState {
    /// Poison-tolerant lock: a panic while holding the mutex would poison
    /// it, and treating that as fatal would brick recording for the rest
    /// of the session. `Inner` is a handful of Option fields that are
    /// valid in any order of assignment, so recovering the guard is safe.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[derive(Default)]
struct Inner {
    state_val: Option<RecState>, // None == Idle
    mode: RecMode,               // only meaningful while state_val != Idle
    stop_tx: Option<mpsc::Sender<()>>,
    result_rx: Option<mpsc::Receiver<Result<CaptureResult, String>>>,
    recording_flag: Option<Arc<AtomicBool>>,
    // Bumped each time a Copied/Failed notice goes up, so its hide timer
    // only fires for ITS notice — a back-to-back session that lands on a
    // notice again isn't hidden early by the first notice's timer.
    notice_gen: u64,
}

impl Inner {
    fn state(&self) -> RecState {
        self.state_val.unwrap_or(RecState::Idle)
    }

    /// Flips to a notice state (Copied/Failed) and returns its generation
    /// for `start_notice`'s hide timer. Split out so the ticker's teardown
    /// can enter Failed under the same lock it clears the session with.
    fn enter_notice(&mut self, state: RecState) -> u64 {
        self.state_val = Some(state);
        self.notice_gen = self.notice_gen.wrapping_add(1);
        self.notice_gen
    }
}

/// Emits the `recording-state` event, updates the tray title, and
/// shows/positions/hides the recording-pill overlay window to match. Shared
/// with whisper.rs so the download/transcribe phases (which happen inside
/// `toggle_recording`'s spawned finish work) report through the same path
/// as start/stop.
pub(crate) fn emit_state(app: &AppHandle, state: RecState) {
    let _ = app.emit("recording-state", state.as_str());
    // Recording-start only: tells the overlay pill (and anything else
    // listening) which mode this session is in, so it can show a hint that
    // dictated words are going to the clipboard, not the inbox. Read from
    // AudioState rather than threaded through every emit_state call site —
    // by the time this fires `Inner::mode` is already committed (set
    // before the caller drops its lock and calls in).
    if state == RecState::Recording {
        let mode = app.state::<AudioState>().lock().mode;
        let _ = app.emit("recording-mode", mode.as_str());
    }
    set_tray_title(app, state, None);
    crate::window::sync_overlay(app, state);
}

/// Tray title: `🔴 m:ss` while recording, `…` while transcribing or
/// downloading the model, cleared (`None`) otherwise. No icon swap — title
/// only, per CLAUDE.md's "no new macOS permission surfaces" constraint.
///
/// Idle/Copied/Failed/Reminder also shows `⏰` while a fired reminder is
/// undismissed — but recording/transcribing always wins, so a reminder
/// firing mid-recording never clobbers the live "🔴 m:ss" title (see
/// `refresh_tray_title` below for how the indicator gets applied OUTSIDE a
/// recorder state change).
fn set_tray_title(app: &AppHandle, state: RecState, elapsed: Option<Duration>) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    let title = match state {
        RecState::Recording => {
            let secs = elapsed.unwrap_or_default().as_secs();
            Some(format!("🔴 {}:{:02}", secs / 60, secs % 60))
        }
        RecState::Transcribing | RecState::DownloadingModel => Some("…".to_string()),
        RecState::Idle | RecState::Copied | RecState::Failed | RecState::Reminder => {
            crate::reminders::any_fired_pending().then(|| "⏰".to_string())
        }
    };
    let _ = tray.set_title(title.as_deref());
}

/// Re-applies the tray title for the CURRENT recorder state — reminders.rs's
/// hook for updating the `⏰` indicator outside of any recorder state change
/// (a reminder firing, or its banner being dismissed/snoozed, while the
/// recorder just sits at Idle). Only touches the title when the recorder
/// can start a session (`can_start`: Idle/Copied/Failed) — if a recording
/// is in progress, its own ticker (see `toggle_recording_mode`) owns the
/// title and must not be clobbered with a stale "elapsed: None".
pub(crate) fn refresh_tray_title(app: &AppHandle) {
    let state = app.state::<AudioState>().lock().state();
    if state.can_start() {
        set_tray_title(app, state, None);
    }
}

#[tauri::command]
pub fn get_recording_state(app: AppHandle) -> String {
    let state = app.state::<AudioState>();
    let inner = state.lock();
    inner.state().as_str().to_string()
}

#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    Ok(devices.map(|d| d.to_string()).collect())
}

/// Case-insensitive substring match against `.sideline.json`'s
/// `audio.device`, falling back to the system default input device — same
/// failure-tolerant shape as the frontend's `loadConfig` (a
/// missing/unparseable config just means the default).
fn select_device(name_filter: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(filter) = name_filter {
        let lower = filter.to_lowercase();
        let found = host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.to_string().to_lowercase().contains(&lower));
        if let Some(d) = found {
            return Ok(d);
        }
    }
    host.default_input_device()
        .ok_or_else(|| "no input device available".to_string())
}

/// Reads `audio.device` from `~/notes/.sideline.json`, if present.
fn configured_device_name() -> Option<String> {
    let p = crate::paths::notes_dir().join(".sideline.json");
    let raw = std::fs::read_to_string(p).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("audio")?
        .get("device")?
        .as_str()
        .map(|s| s.to_string())
}

/// Reads `cleanFillers` from `~/notes/.sideline.json` — same
/// failure-tolerant shape as `configured_device_name` above, but the
/// opposite default: a missing file, a missing key, or a non-boolean value
/// all mean the default (enabled), so `cleanFillers: false` is the only way
/// to turn this off. See cleanup.rs.
fn clean_fillers_enabled() -> bool {
    let p = crate::paths::notes_dir().join(".sideline.json");
    let Ok(raw) = std::fs::read_to_string(p) else {
        return true;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    parsed
        .get("cleanFillers")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Reads `autoList` from `~/notes/.sideline.json` — same failure-tolerant
/// shape and default (enabled) as `clean_fillers_enabled`. One setting for
/// spoken-list formatting everywhere: popover cards and dictation pastes.
fn auto_list_enabled() -> bool {
    let p = crate::paths::notes_dir().join(".sideline.json");
    let Ok(raw) = std::fs::read_to_string(p) else {
        return true;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    parsed
        .get("autoList")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Linear-interpolation resample to 16 kHz mono — whisper.cpp's required
/// input rate. Good enough for speech; avoids pulling in a full resampling
/// crate for what's a short voice note.
fn resample_to_16k(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == 16_000 || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / 16_000.0;
    let out_len = ((samples.len() as f64) / ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = samples.get(idx).copied().unwrap_or(0.0);
        let b = samples.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Whisper hallucinates caption-like text ("Don't forget to subscribe…")
/// when given non-speech audio, so recordings are gated on loudness before
/// transcription: if no 100 ms window ever reaches this RMS floor, the
/// recording is treated as silence and rejected. 0.01 sits well below
/// normal speech into a mic (~0.03+) but above mic self-noise.
const SPEECH_RMS_FLOOR: f32 = 0.01;
/// Gate window: 100 ms at whisper's 16 kHz input rate (the gate runs on
/// the post-resample buffer). Windowed, not global, so one short utterance
/// inside a long quiet recording still passes.
const SPEECH_WINDOW_SAMPLES: usize = 1_600;

fn max_window_rms(samples: &[f32]) -> f32 {
    samples
        .chunks(SPEECH_WINDOW_SAMPLES)
        .map(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt())
        .fold(0.0, f32::max)
}

/// Builds + plays a mono-downmixed capture stream for one cpal sample
/// format. The callback runs on cpal's own audio thread, so all state it
/// touches (`buffer`, `level`) is behind atomics/a mutex.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<Vec<f32>>>,
    level: Arc<AtomicU32>,
    channels: usize,
    lost: Arc<Mutex<Option<StreamLoss>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    device
        .build_input_stream(
            *config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut buf = match buffer.lock() {
                    Ok(b) => b,
                    Err(_) => return,
                };
                let mut sum_sq = 0f32;
                let mut n = 0usize;
                for frame in data.chunks(channels) {
                    let mut acc = 0f32;
                    for &s in frame {
                        acc += f32::from_sample(s);
                    }
                    let mono = acc / frame.len().max(1) as f32;
                    buf.push(mono);
                    sum_sq += mono * mono;
                    n += 1;
                }
                if n > 0 {
                    let rms = (sum_sq / n as f32).sqrt().min(1.0);
                    level.store(rms.to_bits(), Ordering::Relaxed);
                }
            },
            move |err: cpal::Error| {
                // Device died mid-recording (Bluetooth drop, USB unplug) or
                // its stream was invalidated: `capture_thread` polls this
                // slot and fails over to the system default input.
                let mut slot = lost.lock().unwrap_or_else(|p| p.into_inner());
                slot.get_or_insert_with(|| StreamLoss {
                    device_gone: err.kind() == cpal::ErrorKind::DeviceNotAvailable,
                    msg: err.to_string(),
                });
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// A mid-recording stream failure, as reported by cpal's error callback
/// (or synthesized by `capture_thread`'s stall watchdog).
struct StreamLoss {
    /// The device itself disappeared (unplugged, Bluetooth dropped), as
    /// opposed to its stream being invalidated (e.g. a sample-rate change).
    device_gone: bool,
    msg: String,
}

/// One live capture stream plus the buffer it fills. `lost` is per-segment
/// so a late error callback from an already-replaced stream can't trigger a
/// second, spurious failover.
struct Segment {
    stream: cpal::Stream,
    ident: DeviceIdent,
    buffer: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    lost: Arc<Mutex<Option<StreamLoss>>>,
}

/// Which device a segment records from, kept after its stream is dropped so
/// `reopen_after_loss` can tell "same mic" from "different mic".
struct DeviceIdent {
    device: cpal::Device,
    /// `device_key` of `device`.
    key: String,
    /// Display name, captured at open — a dead device may fail the query.
    name: String,
}

/// Stable identity for a device: cpal's id (CoreAudio's device UID) when
/// available, else the display name — two mics can share a name.
fn device_key(device: &cpal::Device) -> String {
    match device.id() {
        Ok(id) => format!("{id:?}"),
        Err(_) => device.to_string(),
    }
}

/// Opens + plays a capture stream on `device`.
fn open_segment(device: cpal::Device, level: &Arc<AtomicU32>) -> Result<Segment, String> {
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let lost: Arc<Mutex<Option<StreamLoss>>> = Arc::new(Mutex::new(None));

    let (b, l, x) = (buffer.clone(), level.clone(), lost.clone());
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &stream_config, b, l, channels, x),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &stream_config, b, l, channels, x),
        cpal::SampleFormat::I32 => build_stream::<i32>(&device, &stream_config, b, l, channels, x),
        cpal::SampleFormat::I8 => build_stream::<i8>(&device, &stream_config, b, l, channels, x),
        other => Err(format!("unsupported sample format: {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Segment {
        stream,
        ident: DeviceIdent {
            key: device_key(&device),
            name: device.to_string(),
            device,
        },
        buffer,
        sample_rate,
        lost,
    })
}

/// How `reopen_after_loss` ended.
enum Reopen {
    Opened(Segment),
    /// Stop was pressed (or the session torn down) mid-retry.
    Stopped,
    Failed,
}

/// After the recording stream dies, reopens capture. A stream that was
/// merely invalidated (device still there) is reopened on the same device
/// first. Otherwise — or if that fails — on whatever `select_device` now
/// resolves to: the configured device if it's still present, else the
/// system default. Retries for up to `FAILOVER_WAIT`: right after an unplug
/// macOS may still report the dead device as the default, so it's skipped
/// until the deadline, when it's accepted as a probable replug. Checks
/// `stop_rx` between attempts so a stop press isn't held up by the retry.
fn reopen_after_loss(
    device_filter: Option<&str>,
    level: &Arc<AtomicU32>,
    lost: &DeviceIdent,
    device_gone: bool,
    stop_rx: &mpsc::Receiver<()>,
) -> Reopen {
    let deadline = Instant::now() + FAILOVER_WAIT;
    loop {
        if !matches!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty)) {
            return Reopen::Stopped;
        }
        if !device_gone {
            if let Ok(seg) = open_segment(lost.device.clone(), level) {
                return Reopen::Opened(seg);
            }
        }
        let past_deadline = Instant::now() >= deadline;
        let attempt = select_device(device_filter).and_then(|d| {
            // Key OR name: a just-removed device can fail the UID query, so
            // its fresh key may fall back to the name.
            let is_lost = device_key(&d) == lost.key || d.to_string() == lost.name;
            if device_gone && !past_deadline && is_lost {
                Err("old device still the default".to_string())
            } else {
                open_segment(d, level)
            }
        });
        match attempt {
            Ok(seg) => return Reopen::Opened(seg),
            Err(_) if past_deadline => return Reopen::Failed,
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// A live stream whose buffer hasn't grown for this long is treated as lost
/// — catches a stream opened on a device that died before its disconnect
/// listener registered, which would otherwise record nothing, silently.
const STALL_TIMEOUT: Duration = Duration::from_secs(2);
/// The same watchdog before a stream's first samples arrive — longer, since
/// a Bluetooth mic can take a few seconds to deliver its first callback.
const FIRST_AUDIO_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs entirely on its own OS thread: `cpal::Stream` isn't `Send`, so it
/// must be built, played, and dropped on the thread that owns it. Waits on
/// `stop_rx` until `toggle_recording`'s stop branch signals it, then reports
/// the buffered samples back over `result_tx`. If the device dies
/// mid-recording (mic unplugged), it keeps what was captured, reopens
/// (`reopen_after_loss`), and emits `mic-switched` with the new device's
/// name when the mic changed. If nothing can be reopened, what was captured
/// is still transcribed (`stop_if_recording`); only a session with no audio
/// at all fails.
fn capture_thread(
    app: AppHandle,
    device_filter: Option<String>,
    stop_rx: mpsc::Receiver<()>,
    result_tx: mpsc::Sender<Result<CaptureResult, String>>,
    level: Arc<AtomicU32>,
    session_err: Arc<Mutex<Option<String>>>,
) {
    // Every pre-stop failure goes to BOTH channels: the session-error slot
    // (the ticker surfaces it immediately and resets to Idle) and result_tx
    // (covers the race where stop was pressed before the ticker noticed).
    let fail = |e: String| {
        session_err
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert_with(|| e.clone());
        let _ = result_tx.send(Err(e));
    };
    let mut seg =
        match select_device(device_filter.as_deref()).and_then(|d| open_segment(d, &level)) {
            Ok(s) => s,
            Err(e) => return fail(e),
        };
    let mut done: Vec<(Vec<f32>, u32)> = Vec::new();
    let mut failovers = 0;
    let (mut last_len, mut last_growth) = (0usize, Instant::now());

    // Wait for stop (Ok) or session teardown (Disconnected), polling the
    // live segment's loss slot and stall watchdog in between; the stream
    // stays alive (and callbacks keep firing) the whole time.
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop_rx.recv_timeout(Duration::from_millis(50))
    {
        let len = seg.buffer.lock().unwrap_or_else(|p| p.into_inner()).len();
        if len != last_len {
            (last_len, last_growth) = (len, Instant::now());
        }
        let reported = seg.lost.lock().unwrap_or_else(|p| p.into_inner()).take();
        let stall_after = if last_len == 0 {
            FIRST_AUDIO_TIMEOUT
        } else {
            STALL_TIMEOUT
        };
        // A stall isn't proof the device is gone, so the reopen tries the
        // same device first; if it's really dead that open fails fast.
        let Some(loss) = reported.or_else(|| {
            (last_growth.elapsed() >= stall_after).then(|| StreamLoss {
                device_gone: false,
                msg: "mic stopped sending audio".to_string(),
            })
        }) else {
            continue;
        };
        // Stop the dead stream but keep the rest of `seg` for its identity.
        let Segment {
            stream,
            ident,
            buffer,
            sample_rate,
            ..
        } = seg;
        drop(stream);
        done.push((take_samples(&buffer), sample_rate));
        level.store(0, Ordering::Relaxed);

        failovers += 1;
        let reopened = if failovers > MAX_FAILOVERS {
            Reopen::Failed
        } else {
            let filter = device_filter.as_deref();
            reopen_after_loss(filter, &level, &ident, loss.device_gone, &stop_rx)
        };
        match reopened {
            Reopen::Opened(next) => {
                if next.ident.key != ident.key {
                    let _ = app.emit("mic-switched", next.ident.name.clone());
                }
                seg = next;
                (last_len, last_growth) = (0, Instant::now());
            }
            Reopen::Stopped => {
                let _ = result_tx.send(Ok(CaptureResult { segments: done }));
                return;
            }
            Reopen::Failed if done.iter().any(|(s, _)| !s.is_empty()) => {
                // No mic left, but there's audio: hand it over and end the
                // session as if stop were pressed, rather than discard it.
                // Stop BEFORE sending: once the result is out, a fast
                // finish_recording could free the recorder for a new
                // session that this stop would then end by mistake.
                // finish_recording just blocks on recv until the send.
                let _ = app.emit(
                    "capture-error",
                    "Mic disconnected — transcribing what was recorded",
                );
                stop_if_recording(&app);
                let _ = result_tx.send(Ok(CaptureResult { segments: done }));
                return;
            }
            Reopen::Failed => return fail(format!("Recording stopped: {}", loss.msg)),
        }
    }
    drop(seg.stream);
    done.push((take_samples(&seg.buffer), seg.sample_rate));
    let _ = result_tx.send(Ok(CaptureResult { segments: done }));
}

fn take_samples(buffer: &Mutex<Vec<f32>>) -> Vec<f32> {
    std::mem::take(&mut *buffer.lock().unwrap_or_else(|p| p.into_inner()))
}

/// Resamples each captured segment to 16 kHz and joins them in order.
fn segments_to_16k(segments: &[(Vec<f32>, u32)]) -> Vec<f32> {
    segments
        .iter()
        .flat_map(|(samples, rate)| resample_to_16k(samples, *rate))
        .collect()
}

/// Starts or stops+transcribes a voice note in `RecMode::Note` (⌥⌘R / tray
/// "Record voice note" / popover `r`) — the transcript is appended to
/// inbox.md. Returns the new state immediately (`"recording"` /
/// `"transcribing"`) — the eventual `"idle"` transition (and any
/// `capture-error`) arrives later via the `recording-state`/`capture-error`
/// events, since transcription runs in the background after this returns.
#[tauri::command]
pub fn toggle_recording(app: AppHandle) -> Result<String, String> {
    toggle_recording_mode(app, RecMode::Note)
}

/// Starts or stops+transcribes a voice note in `RecMode::Dictate` (⌥⌘V
/// default / tray "Dictate to clipboard") — the transcript goes to the
/// clipboard and an auto-paste attempt instead of inbox.md (see
/// dictate.rs). Not exposed to the frontend as a `#[tauri::command]`:
/// unlike `toggle_recording`, nothing in the popover UI ever needs to
/// trigger it — only the global hotkey handler and the tray menu do, both
/// Rust-side already.
pub(crate) fn toggle_dictation(app: AppHandle) -> Result<String, String> {
    toggle_recording_mode(app, RecMode::Dictate)
}

/// Starts or stops+transcribes a spoken question in `RecMode::Ask` (⌥⌘A
/// default) — the transcript is emitted as `ask-transcript` for the Ask
/// view to submit to Claude (see lib.rs's hotkey handler, which also shows
/// the popover and emits `ask-open` so the view is up while you speak).
/// Hotkey-only, like `toggle_dictation`: typing a question in the popover
/// never goes through the recorder.
pub(crate) fn toggle_ask(app: AppHandle) -> Result<String, String> {
    toggle_recording_mode(app, RecMode::Ask)
}

/// Shared toggle implementation behind `toggle_recording`/`toggle_dictation`.
/// A press while a session is active in the OTHER mode is ignored outright
/// (`capture-error` "Already recording") — the recorder never silently
/// switches modes mid-recording; a same-mode press follows the existing
/// state machine unchanged (Idle → Recording → stop triggers Transcribing,
/// Transcribing/DownloadingModel just no-ops). The transient Copied notice
/// counts as idle here — either hotkey during it starts a fresh session
/// (its hide timer sees the state moved on and stands down).
fn toggle_recording_mode(app: AppHandle, mode: RecMode) -> Result<String, String> {
    let audio_state = app.state::<AudioState>();
    let mut inner = audio_state.lock();
    let state = inner.state();

    if !state.can_start() && inner.mode != mode {
        drop(inner);
        let _ = app.emit("capture-error", "Already recording");
        return Ok(state.as_str().to_string());
    }

    match state {
        s if s.can_start() => {
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (result_tx, result_rx) = mpsc::channel::<Result<CaptureResult, String>>();
            let level = Arc::new(AtomicU32::new(0));
            let recording_flag = Arc::new(AtomicBool::new(true));
            let session_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let device_filter = configured_device_name();

            {
                let level = level.clone();
                let session_err = session_err.clone();
                let app = app.clone();
                std::thread::spawn(move || {
                    capture_thread(app, device_filter, stop_rx, result_tx, level, session_err);
                });
            }

            inner.state_val = Some(RecState::Recording);
            inner.mode = mode;
            inner.stop_tx = Some(stop_tx);
            inner.result_rx = Some(result_rx);
            inner.recording_flag = Some(recording_flag.clone());
            drop(inner);

            emit_state(&app, RecState::Recording);

            // ~20 Hz level events + 1 Hz tray elapsed title, for as long as
            // `recording_flag` stays true (cleared by the stop branch). Also
            // the watchdog for `session_err`: a capture failure (no device,
            // TCC denied, mic lost with no fallback and nothing captured)
            // must reach the user NOW, not when they press stop after
            // dictating into the void.
            let app_ticker = app.clone();
            let started = Instant::now();
            std::thread::spawn(move || {
                let mut last_secs = u64::MAX;
                while recording_flag.load(Ordering::Relaxed) {
                    if let Some(err) = session_err.lock().unwrap_or_else(|p| p.into_inner()).take()
                    {
                        let state = app_ticker.state::<AudioState>();
                        let mut inner = state.lock();
                        // Only tear down if stop hasn't raced us there:
                        // once Transcribing, finish_recording owns the error
                        // path (it gets the same failure via result_rx).
                        if inner.state() == RecState::Recording {
                            inner.stop_tx = None;
                            inner.result_rx = None;
                            if let Some(f) = inner.recording_flag.take() {
                                f.store(false, Ordering::Relaxed);
                            }
                            let gen = inner.enter_notice(RecState::Failed);
                            drop(inner);
                            let _ = app_ticker.emit("capture-error", err);
                            start_notice(&app_ticker, RecState::Failed, gen);
                        }
                        break;
                    }
                    let rms = f32::from_bits(level.load(Ordering::Relaxed));
                    let _ = app_ticker.emit("audio-level", rms);
                    let secs = started.elapsed().as_secs();
                    if secs != last_secs {
                        last_secs = secs;
                        set_tray_title(&app_ticker, RecState::Recording, Some(started.elapsed()));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });

            Ok(RecState::Recording.as_str().to_string())
        }
        RecState::Recording => Ok(stop_session(&app, inner)),
        busy => Ok(busy.as_str().to_string()),
    }
}

/// The stop branch: Recording → Transcribing, signal the capture thread,
/// and hand off to `finish_recording`. Caller must have checked the state
/// is Recording under the same lock it passes in.
fn stop_session(app: &AppHandle, mut inner: std::sync::MutexGuard<'_, Inner>) -> String {
    let stop_tx = inner.stop_tx.take();
    let result_rx = inner.result_rx.take();
    let recording_flag = inner.recording_flag.take();
    let mode = inner.mode;
    inner.state_val = Some(RecState::Transcribing);
    drop(inner);

    if let Some(f) = recording_flag {
        f.store(false, Ordering::Relaxed);
    }
    emit_state(app, RecState::Transcribing);
    if let Some(tx) = stop_tx {
        let _ = tx.send(());
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || finish_recording(app2, result_rx, mode));

    RecState::Transcribing.as_str().to_string()
}

/// `capture_thread`'s salvage path: stops the session as if the hotkey were
/// pressed, but only if it's still Recording — a real stop press may have
/// raced it, in which case `finish_recording` is already on its way.
fn stop_if_recording(app: &AppHandle) {
    let audio = app.state::<AudioState>();
    let inner = audio.lock();
    if inner.state() == RecState::Recording {
        stop_session(app, inner);
    }
}

/// Puts up a pill notice — dictation's "Copied — ⌘V to paste", the Failed
/// error text, or a fired reminder's text: flips state, emits it, and
/// spawns the hide timer that drops back to Idle after
/// `COPIED_NOTICE`/`FAILED_NOTICE`/`REMINDER_NOTICE` — unless the state has
/// moved on (a new recording started, or a newer notice replaced this one;
/// see `Inner::notice_gen`).
fn show_notice(app: &AppHandle, state: RecState) {
    let audio = app.state::<AudioState>();
    let gen = audio.lock().enter_notice(state);
    start_notice(app, state, gen);
}

/// reminders.rs's `tick` calls this instead of `show_notice` directly: only
/// puts the reminder notice up when the recorder `can_start()` (Idle/
/// Copied/Failed/Reminder) — a live recording/transcription/model-download
/// keeps the pill showing its own state, and the tray `⏰` plus the
/// popover's banner (once opened) still cover the reminder. NEVER shows or
/// focuses the popover itself — see this crate's `window::show_or_focus_window`,
/// which is deliberately not called from here (a reminder firing must not
/// steal keyboard focus from whatever the user is typing into).
pub(crate) fn show_reminder_notice(app: &AppHandle) {
    let can_show = app.state::<AudioState>().lock().state().can_start();
    if can_show {
        show_notice(app, RecState::Reminder);
    }
}

/// Emits a notice state already entered via `Inner::enter_notice` and
/// spawns its hide timer.
fn start_notice(app: &AppHandle, state: RecState, gen: u64) {
    emit_state(app, state);
    let hold = match state {
        RecState::Failed => FAILED_NOTICE,
        RecState::Reminder => REMINDER_NOTICE,
        _ => COPIED_NOTICE,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(hold);
        let audio = app.state::<AudioState>();
        let mut inner = audio.lock();
        if inner.state() == state && inner.notice_gen == gen {
            inner.state_val = Some(RecState::Idle);
            drop(inner);
            emit_state(&app, RecState::Idle);
        }
    });
}

/// Error tail of `finish_recording`: emits `capture-error` (the popover's
/// toast) and holds the pill up on the same text via the Failed notice.
fn fail(app: &AppHandle, msg: String) {
    let _ = app.emit("capture-error", msg);
    show_notice(app, RecState::Failed);
}

/// Resets the managed state to Idle and emits the transition — the tail of
/// every successful `finish_recording` exit (errors go through `fail`).
fn reset_idle(app: &AppHandle) {
    let state = app.state::<AudioState>();
    let mut inner = state.lock();
    inner.state_val = Some(RecState::Idle);
    drop(inner);
    emit_state(app, RecState::Idle);
}

/// The stop-side tail: receive the buffered samples from the capture
/// thread, resample, transcribe, hand the transcript off per `mode`
/// (inbox.md for `Note`, clipboard+paste for `Dictate` — see dictate.rs —
/// the `ask-transcript` event for `Ask`),
/// and always land back on Idle — directly on success, via the Copied or
/// Failed pill notice otherwise. Runs inside `spawn_blocking` — never on
/// the async runtime.
fn finish_recording(
    app: AppHandle,
    result_rx: Option<mpsc::Receiver<Result<CaptureResult, String>>>,
    mode: RecMode,
) {
    let capture = match result_rx.and_then(|rx| rx.recv().ok()) {
        Some(Ok(c)) => c,
        Some(Err(e)) => return fail(&app, e),
        None => return fail(&app, "recording thread vanished".to_string()),
    };

    let pcm = segments_to_16k(&capture.segments);
    if pcm.is_empty() {
        return fail(&app, "No audio captured".to_string());
    }

    if max_window_rms(&pcm) < SPEECH_RMS_FLOOR {
        // Usually the mic, not the speaker: input gain at zero or a muted
        // interface records near-silence, so point at the likely fix.
        return fail(
            &app,
            "No speech detected — check mic input level".to_string(),
        );
    }

    match crate::whisper::transcribe(&app, &pcm) {
        // `transcribe` already runs the Claude mis-hear correction pass for
        // every caller, so `text` here is corrected regardless of mode.
        // Filler-word cleanup (cleanup.rs) runs next, before the mode
        // hand-off, so Note/Dictate/Ask all see the cleaned transcript —
        // opt out via Settings → Voice, `.sideline.json`'s `cleanFillers`.
        Ok(text) if !text.trim().is_empty() => {
            let text = if clean_fillers_enabled() {
                crate::cleanup::strip_fillers(&text)
            } else {
                text
            };
            if text.trim().is_empty() {
                return fail(&app, "Transcription came back empty".to_string());
            }
            match mode {
                RecMode::Note => {
                    if let Err(e) = crate::commands::notes::append_inbox_text(&text) {
                        return fail(&app, e);
                    }
                }
                RecMode::Dictate => {
                    // An explicitly enumerated dictation pastes as a
                    // numbered list (listrules.rs); anything else as-is.
                    let text = if auto_list_enabled() {
                        crate::listrules::number_list(&text).unwrap_or(text)
                    } else {
                        text
                    };
                    // Copied: the transcript is on the clipboard — say so,
                    // whether or not the auto-paste landed anywhere useful.
                    // Failed: dictate.rs already emitted the `capture-error`.
                    let notice = match crate::dictate::finish_dictation(&app, &text) {
                        crate::dictate::DictationOutcome::Copied => RecState::Copied,
                        crate::dictate::DictationOutcome::Failed => RecState::Failed,
                    };
                    return show_notice(&app, notice);
                }
                RecMode::Ask => {
                    // The frontend owns everything from here (thread list,
                    // `ask_claude` call); Tauri events aren't visibility-gated,
                    // so this lands even if the popover was hidden meanwhile.
                    let _ = app.emit("ask-transcript", text.trim().to_string());
                }
            }
        }
        Ok(_) => return fail(&app, "Transcription came back empty".to_string()),
        Err(e) => return fail(&app, e),
    }

    reset_idle(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_are_idle_equivalent_but_live_states_are_not() {
        for s in [
            RecState::Idle,
            RecState::Copied,
            RecState::Failed,
            RecState::Reminder,
        ] {
            assert!(s.can_start(), "{s:?} should let a hotkey start a session");
        }
        for s in [
            RecState::Recording,
            RecState::Transcribing,
            RecState::DownloadingModel,
        ] {
            assert!(!s.can_start(), "{s:?} should not start a session");
        }
    }

    #[test]
    fn notice_generation_bumps_on_every_notice() {
        let mut inner = Inner::default();
        let first = inner.enter_notice(RecState::Failed);
        let second = inner.enter_notice(RecState::Copied);
        assert_ne!(first, second);
        assert_eq!(inner.state(), RecState::Copied);
    }

    #[test]
    fn resample_empty_input_returns_empty() {
        assert_eq!(resample_to_16k(&[], 44_100), Vec::<f32>::new());
    }

    #[test]
    fn resample_already_16k_is_identity() {
        let samples = vec![0.1, -0.2, 0.3, 0.0, 0.5];
        assert_eq!(resample_to_16k(&samples, 16_000), samples);
    }

    #[test]
    fn resample_downsample_ratio_determines_output_length() {
        // 48 kHz -> 16 kHz is a 3:1 ratio, so 300 samples become 100.
        let samples = vec![0.0f32; 300];
        let out = resample_to_16k(&samples, 48_000);
        assert_eq!(out.len(), 100);
    }

    #[test]
    fn segments_resample_independently_and_join_in_order() {
        // A failover from a 48 kHz mic to a 16 kHz one: 300 samples at
        // 48 kHz become 100, then the 16 kHz segment's 50 pass through.
        let segments = vec![(vec![0.5f32; 300], 48_000), (vec![-0.5f32; 50], 16_000)];
        let out = segments_to_16k(&segments);
        assert_eq!(out.len(), 150);
        assert!(out[..100].iter().all(|&s| s == 0.5));
        assert!(out[100..].iter().all(|&s| s == -0.5));
    }

    #[test]
    fn segments_all_empty_yield_no_audio() {
        assert!(segments_to_16k(&[(vec![], 48_000), (vec![], 44_100)]).is_empty());
    }

    #[test]
    fn silence_gate_rejects_pure_silence() {
        let samples = vec![0.0f32; 32_000]; // 2 s of silence at 16 kHz
        assert!(max_window_rms(&samples) < SPEECH_RMS_FLOOR);
    }

    #[test]
    fn silence_gate_rejects_faint_noise() {
        // Constant 0.002 amplitude ≈ mic self-noise; RMS is 0.002.
        let samples = vec![0.002f32; 32_000];
        assert!(max_window_rms(&samples) < SPEECH_RMS_FLOOR);
    }

    #[test]
    fn silence_gate_passes_short_speech_burst_in_long_silence() {
        // 2 s of silence with a single 100 ms burst at 0.1 amplitude: the
        // windowed max must see the burst even though the global RMS is tiny.
        let mut samples = vec![0.0f32; 32_000];
        for s in &mut samples[16_000..17_600] {
            *s = 0.1;
        }
        assert!(max_window_rms(&samples) >= SPEECH_RMS_FLOOR);
    }

    #[test]
    fn silence_gate_passes_recording_shorter_than_one_window() {
        // 50 ms of speech-level audio: the final partial chunk still counts.
        let samples = vec![0.1f32; 800];
        assert!(max_window_rms(&samples) >= SPEECH_RMS_FLOOR);
    }

    #[test]
    fn silence_gate_empty_input_is_silent() {
        assert_eq!(max_window_rms(&[]), 0.0);
    }

    #[test]
    fn resample_known_waveform_linear_interpolation() {
        // 24 kHz -> 16 kHz is a 1.5:1 ratio.
        // i=0: src_pos=0.0   -> exact sample 0            -> 0.0
        // i=1: src_pos=1.5   -> halfway between idx 1 & 2  -> 15.0
        // i=2: src_pos=3.0   -> exact sample 3 (idx+1 OOB, clamps to a) -> 30.0
        let samples = vec![0.0, 10.0, 20.0, 30.0];
        let out = resample_to_16k(&samples, 24_000);
        assert_eq!(out, vec![0.0, 15.0, 30.0]);
    }
}
