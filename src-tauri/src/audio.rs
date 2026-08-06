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
}

impl RecState {
    pub fn as_str(self) -> &'static str {
        match self {
            RecState::Idle => "idle",
            RecState::Recording => "recording",
            RecState::Transcribing => "transcribing",
            RecState::DownloadingModel => "downloading-model",
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
    stop_tx: Option<mpsc::Sender<()>>,
    result_rx: Option<mpsc::Receiver<Result<CaptureResult, String>>>,
    recording_flag: Option<Arc<AtomicBool>>,
}

impl Inner {
    fn state(&self) -> RecState {
        self.state_val.unwrap_or(RecState::Idle)
    }
}

/// Emits the `recording-state` event, updates the tray title, and
/// shows/positions/hides the recording-pill overlay window to match. Shared
/// with whisper.rs so the download/transcribe phases (which happen inside
/// `toggle_recording`'s spawned finish work) report through the same path
/// as start/stop.
pub(crate) fn emit_state(app: &AppHandle, state: RecState) {
    let _ = app.emit("recording-state", state.as_str());
    set_tray_title(app, state, None);
    crate::window::sync_overlay(app, state);
}

/// Tray title: `🔴 m:ss` while recording, `…` while transcribing or
/// downloading the model, cleared (`None`) otherwise. No icon swap — title
/// only, per CLAUDE.md's "no new macOS permission surfaces" constraint.
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
        RecState::Idle => None,
    };
    let _ = tray.set_title(title.as_deref());
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

/// Starts or stops+transcribes+appends a voice note. Returns the new state
/// immediately (`"recording"` / `"transcribing"`) — the eventual `"idle"`
/// transition (and any `capture-error`) arrives later via the
/// `recording-state`/`capture-error` events, since transcription runs in
/// the background after this returns.
#[tauri::command]
pub fn toggle_recording(app: AppHandle) -> Result<String, String> {
    let audio_state = app.state::<AudioState>();
    let mut inner = audio_state.lock();
    match inner.state() {
        RecState::Idle => {
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
                            inner.state_val = Some(RecState::Idle);
                            drop(inner);
                            let _ = app_ticker.emit("capture-error", err);
                            emit_state(&app_ticker, RecState::Idle);
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
            tauri::async_runtime::spawn_blocking(move || finish_recording(app2, result_rx));

            Ok(RecState::Transcribing.as_str().to_string())
        }
        busy => Ok(busy.as_str().to_string()),
    }
}

/// Resets the managed state to Idle and emits the transition — the shared
/// tail of every `finish_recording` exit path (success, empty transcript,
/// or any error).
fn reset_idle(app: &AppHandle) {
    let state = app.state::<AudioState>();
    let mut inner = state.lock();
    inner.state_val = Some(RecState::Idle);
    drop(inner);
    emit_state(app, RecState::Idle);
}

/// The stop-side tail: receive the buffered samples from the capture
/// thread, resample, transcribe, append to inbox.md, and always land back
/// on Idle. Runs inside `spawn_blocking` — never on the async runtime.
fn finish_recording(
    app: AppHandle,
    result_rx: Option<mpsc::Receiver<Result<CaptureResult, String>>>,
) {
    let capture = match result_rx.and_then(|rx| rx.recv().ok()) {
        Some(Ok(c)) => c,
        Some(Err(e)) => {
            let _ = app.emit("capture-error", e);
            reset_idle(&app);
            return;
        }
        None => {
            let _ = app.emit("capture-error", "recording thread vanished".to_string());
            reset_idle(&app);
            return;
        }
    };

    if capture.samples.is_empty() {
        let _ = app.emit("capture-error", "No audio captured".to_string());
        reset_idle(&app);
        return;
    }

    let pcm = resample_to_16k(&capture.samples, capture.sample_rate);

    if max_window_rms(&pcm) < SPEECH_RMS_FLOOR {
        let _ = app.emit("capture-error", "No speech detected".to_string());
        reset_idle(&app);
        return;
    }

    match crate::whisper::transcribe(&app, &pcm) {
        Ok(text) if !text.trim().is_empty() => {
            if let Err(e) = crate::commands::notes::append_inbox_text(&text) {
                let _ = app.emit("capture-error", e);
            }
        }
        Ok(_) => {
            let _ = app.emit("capture-error", "Transcription came back empty".to_string());
        }
        Err(e) => {
            let _ = app.emit("capture-error", e);
        }
    }

    reset_idle(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

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
