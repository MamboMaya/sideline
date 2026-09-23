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
        }
    }

    /// True for the states where no recording session is live and a hotkey
    /// press should start one — Idle, plus the transient Copied/Failed
    /// notices.
    fn can_start(self) -> bool {
        matches!(self, RecState::Idle | RecState::Copied | RecState::Failed)
    }
}

/// How long the pill's "Copied — ⌘V to paste" notice stays up.
const COPIED_NOTICE: Duration = Duration::from_millis(1500);
/// How long the pill's failure notice stays up — longer than
/// `COPIED_NOTICE` since it's a sentence to read, not a glance.
const FAILED_NOTICE: Duration = Duration::from_millis(3000);

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

/// What the capture thread hands back when recording stops: downmixed mono
/// samples at the device's native sample rate (resampling to 16 kHz happens
/// after handoff, off the audio thread).
struct CaptureResult {
    samples: Vec<f32>,
    sample_rate: u32,
}

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
/// Idle/Copied/Failed also shows `⏰` while a fired reminder is undismissed
/// — but recording/transcribing always wins, so a reminder firing
/// mid-recording never clobbers the live "🔴 m:ss" title (see
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
        RecState::Idle | RecState::Copied | RecState::Failed => {
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
    session_err: Arc<Mutex<Option<String>>>,
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
            move |err| {
                // Device died mid-recording (Bluetooth drop, USB unplug):
                // route it to the session-error slot so the ticker tears the
                // session down NOW, instead of the user dictating into a dead
                // stream until they press stop.
                let mut slot = session_err.lock().unwrap_or_else(|p| p.into_inner());
                slot.get_or_insert_with(|| format!("Recording stopped: {err}"));
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Runs entirely on its own OS thread: `cpal::Stream` isn't `Send`, so it
/// must be built, played, and dropped on the thread that owns it. Blocks on
/// `stop_rx` until `toggle_recording`'s stop branch signals it, then reports
/// the buffered samples back over `result_tx`.
fn capture_thread(
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
    let device = match select_device(device_filter.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            fail(e);
            return;
        }
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            fail(e.to_string());
            return;
        }
    };
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_stream::<f32>(
            &device,
            &stream_config,
            buffer.clone(),
            level.clone(),
            channels,
            session_err.clone(),
        ),
        cpal::SampleFormat::I16 => build_stream::<i16>(
            &device,
            &stream_config,
            buffer.clone(),
            level.clone(),
            channels,
            session_err.clone(),
        ),
        cpal::SampleFormat::I32 => build_stream::<i32>(
            &device,
            &stream_config,
            buffer.clone(),
            level.clone(),
            channels,
            session_err.clone(),
        ),
        cpal::SampleFormat::I8 => build_stream::<i8>(
            &device,
            &stream_config,
            buffer.clone(),
            level.clone(),
            channels,
            session_err.clone(),
        ),
        other => Err(format!("unsupported sample format: {other:?}")),
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            fail(e);
            return;
        }
    };
    if let Err(e) = stream.play() {
        fail(e.to_string());
        return;
    }

    // Block until told to stop; the stream stays alive (and callbacks keep
    // firing) for the whole wait.
    let _ = stop_rx.recv();
    drop(stream);

    let samples = buffer.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let _ = result_tx.send(Ok(CaptureResult {
        samples,
        sample_rate,
    }));
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
        RecState::Idle | RecState::Copied | RecState::Failed => {
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (result_tx, result_rx) = mpsc::channel::<Result<CaptureResult, String>>();
            let level = Arc::new(AtomicU32::new(0));
            let recording_flag = Arc::new(AtomicBool::new(true));
            let session_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let device_filter = configured_device_name();

            {
                let level = level.clone();
                let session_err = session_err.clone();
                std::thread::spawn(move || {
                    capture_thread(device_filter, stop_rx, result_tx, level, session_err);
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
            // TCC denied, stream died mid-recording) must reach the user
            // NOW, not when they press stop after dictating into the void.
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
        RecState::Recording => {
            let stop_tx = inner.stop_tx.take();
            let result_rx = inner.result_rx.take();
            let recording_flag = inner.recording_flag.take();
            let mode = inner.mode; // == `mode` param here (checked above); read back for finish_recording
            inner.state_val = Some(RecState::Transcribing);
            drop(inner);

            if let Some(f) = recording_flag {
                f.store(false, Ordering::Relaxed);
            }
            emit_state(&app, RecState::Transcribing);
            if let Some(tx) = stop_tx {
                let _ = tx.send(());
            }

            let app2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || finish_recording(app2, result_rx, mode));

            Ok(RecState::Transcribing.as_str().to_string())
        }
        busy => Ok(busy.as_str().to_string()),
    }
}

/// Puts up a pill notice — dictation's "Copied — ⌘V to paste" or the
/// Failed error text: flips state, emits it, and spawns the hide timer that
/// drops back to Idle after `COPIED_NOTICE`/`FAILED_NOTICE` — unless the
/// state has moved on (a new recording started, or a newer notice replaced
/// this one; see `Inner::notice_gen`).
fn show_notice(app: &AppHandle, state: RecState) {
    let audio = app.state::<AudioState>();
    let gen = audio.lock().enter_notice(state);
    start_notice(app, state, gen);
}

/// Emits a notice state already entered via `Inner::enter_notice` and
/// spawns its hide timer.
fn start_notice(app: &AppHandle, state: RecState, gen: u64) {
    emit_state(app, state);
    let hold = if state == RecState::Failed {
        FAILED_NOTICE
    } else {
        COPIED_NOTICE
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

    if capture.samples.is_empty() {
        return fail(&app, "No audio captured".to_string());
    }

    let pcm = resample_to_16k(&capture.samples, capture.sample_rate);

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
        for s in [RecState::Idle, RecState::Copied, RecState::Failed] {
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
