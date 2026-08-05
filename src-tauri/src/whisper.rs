//! Local transcription via whisper-rs (bundles whisper.cpp, Metal-accelerated
//! on macOS via the `metal` feature). Model lives at
//! `~/.whisper-models/ggml-base.en.bin` — deliberately OUTSIDE `~/notes` and
//! its `validate_component`/`confine` confinement (see CLAUDE.md's
//! Must-NOT-change list); it's a one-time per-machine download, not part of
//! the notes data model.

use std::io::copy as io_copy;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};

use regex::Regex;
use tauri::AppHandle;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::audio::{emit_state, RecState};

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const VOCAB_PROMPT: &str = "Claude, Claude Code, Sideline, Raycast, Tauri, triage, inbox";

fn model_dir() -> PathBuf {
    dirs::home_dir()
        .expect("no home dir")
        .join(".whisper-models")
}

fn model_path() -> PathBuf {
    model_dir().join("ggml-base.en.bin")
}

/// Whisper mis-hears "Claude" a handful of predictable ways. Fix only safe,
/// unambiguous patterns; leave real words ("claw", "clawed" on their own)
/// untouched. Ported verbatim from capture/voice-note.sh's perl pass.
static CLAUDE_CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:clod|claw|clawed|clawd|clode)\s+code\b").unwrap());
static CLAUDE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:clod|clawd|clode)\b").unwrap());

fn correct_claude_mishears(text: &str) -> String {
    let step1 = CLAUDE_CODE_RE.replace_all(text, "Claude Code");
    CLAUDE_RE.replace_all(&step1, "Claude").into_owned()
}

/// Downloads the model to a `.part` file then renames — so a crash/kill
/// mid-download never leaves a truncated file at the real path.
fn download_model(app: &AppHandle, path: &Path) -> Result<(), String> {
    emit_state(app, RecState::DownloadingModel);
    std::fs::create_dir_all(model_dir()).map_err(|e| e.to_string())?;
    let part_path = path.with_extension("bin.part");

    // No whole-request timeout: reqwest's blocking default is 30 s for the
    // ENTIRE transfer, which a ~148 MB model can't finish on slower
    // connections — first-run capture would fail forever. Connect timeout
    // stays finite so a dead network still errors promptly.
    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("model download failed: {e}"))?;
    let mut resp = client
        .get(MODEL_URL)
        .send()
        .map_err(|e| format!("model download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("model download failed: HTTP {}", resp.status()));
    }
    let mut file = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;
    io_copy(&mut resp, &mut file).map_err(|e| format!("model download failed: {e}"))?;
    drop(file);
    std::fs::rename(&part_path, path).map_err(|e| format!("model finalize failed: {e}"))?;
    Ok(())
}

fn ensure_model(app: &AppHandle) -> Result<PathBuf, String> {
    let path = model_path();
    if path.exists() {
        return Ok(path);
    }
    download_model(app, &path)?;
    Ok(path)
}

static WHISPER_CTX: OnceLock<WhisperContext> = OnceLock::new();

/// Lazily loads the whisper context once and keeps it for the app's
/// lifetime so repeat recordings don't re-load the model. Concurrent
/// transcription never actually happens (gated by the recorder state
/// machine in audio.rs), so a plain get-or-init race is fine — worst case
/// two threads both build a context and one is dropped.
fn get_ctx(path: &Path) -> Result<&'static WhisperContext, String> {
    if let Some(ctx) = WHISPER_CTX.get() {
        return Ok(ctx);
    }
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load whisper model: {e}"))?;
    let _ = WHISPER_CTX.set(ctx);
    Ok(WHISPER_CTX.get().expect("just set"))
}

/// Transcribes 16 kHz mono f32 PCM, English, greedy, no timestamps, with the
/// vocabulary-bias initial prompt, then applies the Claude mis-hear
/// correction pass. Downloads the model first if it's missing (emitting
/// `downloading-model` via the shared recorder-state path).
pub fn transcribe(app: &AppHandle, pcm: &[f32]) -> Result<String, String> {
    let path = ensure_model(app)?;
    emit_state(app, RecState::Transcribing);

    let ctx = get_ctx(&path)?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("whisper state error: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_initial_prompt(VOCAB_PROMPT);

    state
        .full(params, pcm)
        .map_err(|e| format!("transcription failed: {e}"))?;

    let n = state.full_n_segments();
    let mut text = String::new();
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(s) = seg.to_str() {
                text.push_str(s);
            }
        }
    }

    Ok(correct_claude_mishears(text.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrects_code_variants_to_claude_code() {
        assert_eq!(correct_claude_mishears("clod code"), "Claude Code");
        assert_eq!(correct_claude_mishears("claw code"), "Claude Code");
        assert_eq!(correct_claude_mishears("clawed code"), "Claude Code");
        assert_eq!(correct_claude_mishears("clawd code"), "Claude Code");
        assert_eq!(correct_claude_mishears("clode code"), "Claude Code");
    }

    #[test]
    fn corrects_standalone_mishears_to_claude() {
        assert_eq!(correct_claude_mishears("clod"), "Claude");
        assert_eq!(correct_claude_mishears("clawd"), "Claude");
        assert_eq!(correct_claude_mishears("clode"), "Claude");
    }

    #[test]
    fn leaves_claw_and_clawed_alone_when_standalone() {
        // "claw"/"clawed" are real words; only corrected when followed by
        // "code" (see corrects_code_variants_to_claude_code).
        assert_eq!(correct_claude_mishears("claw"), "claw");
        assert_eq!(correct_claude_mishears("clawed"), "clawed");
    }

    #[test]
    fn correction_is_case_insensitive() {
        assert_eq!(correct_claude_mishears("Clod Code"), "Claude Code");
        assert_eq!(correct_claude_mishears("CLOD"), "Claude");
    }

    #[test]
    fn applies_both_passes_together() {
        assert_eq!(
            correct_claude_mishears("clod code review, then clod again"),
            "Claude Code review, then Claude again"
        );
    }

    #[test]
    fn text_needing_no_correction_is_unchanged() {
        let text = "let's grab coffee and talk about the roadmap";
        assert_eq!(correct_claude_mishears(text), text);
    }

    #[test]
    fn already_correct_claude_code_is_unchanged() {
        assert_eq!(correct_claude_mishears("Claude Code"), "Claude Code");
    }

    #[test]
    fn empty_string_is_unchanged() {
        assert_eq!(correct_claude_mishears(""), "");
    }
}
