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

/// One user dictionary entry from `.sideline.json`'s `dictionary` key: the
/// correctly-spelled term plus the mis-hearings whisper produces for it
/// (may be empty — a bare term still biases the initial prompt).
#[derive(Debug, Clone, PartialEq)]
pub struct DictEntry {
    pub term: String,
    pub mishears: Vec<String>,
}

/// Reads `dictionary` from `~/notes/.sideline.json` — `{ "Tauri":
/// ["towery", "tory"], "Raycast": ["ray cast"] }`, term → mis-hearings.
/// Same failure tolerance as audio.rs's `configured_device_name`: a
/// missing file, malformed JSON, or wrong-shaped key just means an empty
/// dictionary. Non-string entries are dropped; blank terms are skipped.
/// Re-read on every transcription so a Settings-pane edit applies to the
/// very next recording with no restart. Entries come back sorted by term
/// (serde_json's default map is a BTreeMap) — order is irrelevant to the
/// prompt and each correction is independent.
fn load_dictionary() -> Vec<DictEntry> {
    let p = crate::paths::notes_dir().join(".sideline.json");
    let Ok(raw) = std::fs::read_to_string(p) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    parse_dictionary(&parsed)
}

fn parse_dictionary(parsed: &serde_json::Value) -> Vec<DictEntry> {
    let Some(map) = parsed.get("dictionary").and_then(|d| d.as_object()) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(term, v)| {
            let term = term.trim();
            if term.is_empty() {
                return None;
            }
            let mishears = v
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.as_str())
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some(DictEntry {
                term: term.to_string(),
                mishears,
            })
        })
        .collect()
}

/// The built-in vocabulary prompt with every user dictionary term appended,
/// so whisper is biased toward the right spelling before any regex
/// correction runs. Whisper's prompt window is ~224 tokens; a few dozen
/// terms fits comfortably.
fn build_prompt(dict: &[DictEntry]) -> String {
    let mut prompt = String::from(VOCAB_PROMPT);
    for e in dict {
        prompt.push_str(", ");
        prompt.push_str(&e.term);
    }
    prompt
}

/// One case-insensitive, word-bounded regex per dictionary term that has
/// mis-hearings, matching any of them. Mis-hearings are regex-escaped
/// (they're literal words, not patterns); interior whitespace becomes
/// `\s+` so a two-word mis-hearing like "cal she" still matches across
/// whatever spacing whisper emitted. A term whose regex somehow fails to
/// compile is skipped rather than failing the whole transcription.
fn build_corrections(dict: &[DictEntry]) -> Vec<(Regex, String)> {
    dict.iter()
        .filter(|e| !e.mishears.is_empty())
        .filter_map(|e| {
            let alts: Vec<String> = e
                .mishears
                .iter()
                .map(|m| {
                    regex::escape(m)
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(r"\s+")
                })
                .collect();
            let pattern = format!(r"(?i)\b(?:{})\b", alts.join("|"));
            Regex::new(&pattern).ok().map(|re| (re, e.term.clone()))
        })
        .collect()
}

fn apply_corrections(text: &str, corrections: &[(Regex, String)]) -> String {
    let mut out = text.to_string();
    for (re, term) in corrections {
        out = re.replace_all(&out, term.as_str()).into_owned();
    }
    out
}

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

/// Minimum silence that counts as a deliberate pause — `line_breaks` mode
/// turns one into a new line. Well above between-sentence breaths and
/// short thinking pauses (~0.3–1.5 s): only a clear stop breaks the line
/// (the user's call, 2026-10-07 — 1 s broke lines too often).
const PAUSE_LINE_BREAK_SECS: f32 = 2.0;
/// Silence-detection window: 20 ms at 16 kHz.
const SILENCE_WINDOW: usize = 320;

/// Silent stretches of at least `PAUSE_LINE_BREAK_SECS`, as (start, end)
/// seconds. "Silent" is relative to the recording's own speech level (10%
/// of the 95th-percentile window RMS, floored for near-silent recordings),
/// so it works for a quiet built-in mic and a hot USB one alike.
fn long_pauses(pcm: &[f32]) -> Vec<(f32, f32)> {
    let rms: Vec<f32> = pcm
        .chunks(SILENCE_WINDOW)
        .map(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt())
        .collect();
    if rms.is_empty() {
        return Vec::new();
    }
    let mut sorted = rms.clone();
    sorted.sort_by(f32::total_cmp);
    let p95 = sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)];
    let threshold = (p95 * 0.1).max(0.004);
    let win_secs = SILENCE_WINDOW as f32 / 16_000.0;

    let mut pauses = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &r) in rms.iter().chain(std::iter::once(&f32::MAX)).enumerate() {
        match (r < threshold, start) {
            (true, None) => start = Some(i),
            (false, Some(st)) => {
                let (a, b) = (st as f32 * win_secs, i as f32 * win_secs);
                if b - a >= PAUSE_LINE_BREAK_SECS {
                    pauses.push((a, b));
                }
                start = None;
            }
            _ => {}
        }
    }
    pauses
}

/// Up to this many pauses, each pause-separated chunk is transcribed on its
/// own (one extra whisper pass per chunk). Past it — a long rambling note —
/// latency matters more, so it's one pass with `join_on_pauses`.
const MAX_PAUSE_CHUNKS: usize = 8;

/// Cuts `pcm` at the middle of each pause.
fn split_at_pauses<'a>(pcm: &'a [f32], pauses: &[(f32, f32)]) -> Vec<&'a [f32]> {
    let mut chunks = Vec::new();
    let mut from = 0;
    for &(s, e) in pauses {
        let cut = (((s + e) / 2.0) * 16_000.0) as usize;
        if cut > from && cut < pcm.len() {
            chunks.push(&pcm[from..cut]);
            from = cut;
        }
    }
    chunks.push(&pcm[from..]);
    chunks
}

/// A chunk with no 100 ms window above mic self-noise — transcribing it
/// would only invite whisper's silence hallucinations ("Thank you.").
fn chunk_is_silent(chunk: &[f32]) -> bool {
    !chunk
        .chunks(1_600)
        .any(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt() >= 0.01)
}

/// Joins whisper segments (text, t0, t1 in centiseconds), putting a line
/// break at a segment boundary only where a long pause sits at it. Whisper's
/// segment times abut and it also splits mid-sentence, so the boundary
/// alone means nothing — the measured silence is what counts. Its boundary
/// lands near the END of the silence (where speech resumes), hence the
/// asymmetric tolerance.
fn join_on_pauses(segments: &[(String, i64, i64)], pauses: &[(f32, f32)]) -> String {
    let mut out = String::new();
    for (i, (text, _, _)) in segments.iter().enumerate() {
        let at_pause = i > 0 && {
            let b = segments[i - 1].2 as f32 / 100.0;
            pauses.iter().any(|&(s, e)| s - 0.3 <= b && b <= e + 0.5)
        };
        if at_pause {
            out.truncate(out.trim_end().len());
            out.push('\n');
            out.push_str(text.trim_start());
        } else {
            out.push_str(text);
        }
    }
    out
}

/// Transcribes 16 kHz mono f32 PCM, English, greedy, with the
/// vocabulary-bias initial prompt (built-in list + the user's `dictionary`
/// terms), then applies the Claude mis-hear correction pass followed by the
/// user dictionary's corrections. `line_breaks` (dictation) turns a long
/// pause into a new line (`join_on_pauses`); otherwise segments run
/// together as one paragraph. Downloads the model first if it's missing
/// (emitting `downloading-model` via the shared recorder-state path).
pub fn transcribe(app: &AppHandle, pcm: &[f32], line_breaks: bool) -> Result<String, String> {
    let path = ensure_model(app)?;
    emit_state(app, RecState::Transcribing);
    transcribe_with_model(&path, pcm, line_breaks)
}

/// `transcribe` minus the model download and state events — split out so a
/// test can run the real model without an `AppHandle`.
fn transcribe_with_model(path: &Path, pcm: &[f32], line_breaks: bool) -> Result<String, String> {
    let dict = load_dictionary();
    let prompt = build_prompt(&dict);
    let corrections = build_corrections(&dict);

    let ctx = get_ctx(path)?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("whisper state error: {e}"))?;
    let mut run = |audio: &[f32], prompt: &str| -> Result<Vec<(String, i64, i64)>, String> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_initial_prompt(prompt);
        state
            .full(params, audio)
            .map_err(|e| format!("transcription failed: {e}"))?;
        let mut segments = Vec::new();
        for i in 0..state.full_n_segments() {
            if let Some(seg) = state.get_segment(i) {
                if let Ok(s) = seg.to_str() {
                    segments.push((s.to_string(), seg.start_timestamp(), seg.end_timestamp()));
                }
            }
        }
        Ok(segments)
    };

    let pauses = if line_breaks {
        long_pauses(pcm)
    } else {
        Vec::new()
    };
    let text = if !pauses.is_empty() && pauses.len() < MAX_PAUSE_CHUNKS {
        // Whisper often runs one segment straight across a pause, and its
        // word timestamps drift by a word around silence, so the only
        // reliable way to break exactly at a pause is to transcribe each
        // pause-separated chunk on its own.
        let mut lines = Vec::new();
        for chunk in split_at_pauses(pcm, &pauses) {
            if chunk_is_silent(chunk) {
                continue;
            }
            // Condition each chunk on what came before (after the vocab
            // prompt), as a single pass would be — a short chunk alone
            // loses context and mis-hears ("call mom back" → "Colm on back").
            let context = format!("{prompt} {}", lines.join(" "));
            let line: String = run(chunk, &context)?
                .iter()
                .map(|(s, _, _)| s.as_str())
                .collect();
            if !line.trim().is_empty() {
                lines.push(line.trim().to_string());
            }
        }
        lines.join("\n")
    } else {
        let segments = run(pcm, &prompt)?;
        if line_breaks {
            join_on_pauses(&segments, &pauses)
        } else {
            segments.iter().map(|(s, _, _)| s.as_str()).collect()
        }
    };

    let corrected = correct_claude_mishears(text.trim());
    Ok(apply_corrections(&corrected, &corrections))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(text: &str, t0: i64, t1: i64) -> (String, i64, i64) {
        (text.to_string(), t0, t1)
    }

    // Segment times and pauses measured from a real whisper-cli run on a
    // synthetic clip with two 1.5 s pauses (boundaries 4.40 and 8.48 s sit
    // at the end of a pause; 10.60 s is a mid-sentence split, no pause).
    #[test]
    fn line_break_only_at_boundaries_with_a_long_pause() {
        let segments = [
            seg(" Pick up milk.", 0, 440),
            seg(" Call the dentist.", 440, 848),
            seg(" Email Sam the slides,", 848, 1060),
            seg(" and also check the budget.", 1060, 1334),
        ];
        let pauses = [(2.7, 4.38), (6.8, 8.46)];
        assert_eq!(
            join_on_pauses(&segments, &pauses),
            " Pick up milk.\nCall the dentist.\nEmail Sam the slides, and also check the budget."
        );
    }

    #[test]
    fn no_pauses_joins_as_one_paragraph() {
        let segments = [seg(" One.", 0, 100), seg(" Two.", 100, 200)];
        assert_eq!(join_on_pauses(&segments, &[]), " One. Two.");
    }

    #[test]
    fn long_pauses_finds_only_silences_of_two_seconds_or_more() {
        let speech = |secs: f32| vec![0.2f32; (secs * 16_000.0) as usize];
        let silence = |secs: f32| vec![0.0f32; (secs * 16_000.0) as usize];
        let pcm: Vec<f32> = [
            speech(1.0),
            silence(1.5),
            speech(1.0),
            silence(2.5),
            speech(1.0),
        ]
        .concat();
        let pauses = long_pauses(&pcm);
        assert_eq!(pauses.len(), 1, "{pauses:?}");
        let (s, e) = pauses[0];
        assert!(
            (s - 3.5).abs() < 0.05 && (e - 6.0).abs() < 0.05,
            "{pauses:?}"
        );
    }

    /// End-to-end against the real model: `SIDELINE_PAUSE_WAV=<16 kHz mono
    /// 16-bit wav with 2+ pauses of ≥2 s> cargo test --release -- --ignored
    /// real_model` (e.g. macOS `say` with `[[slnc 2500]]` between items). The test
    /// binary may then SIGABRT at exit in ggml's Metal teardown — after the
    /// result line prints; it's whisper.cpp's static destructor, not this.
    #[test]
    #[ignore]
    fn real_model_breaks_lines_at_pauses() {
        let wav = std::fs::read(std::env::var("SIDELINE_PAUSE_WAV").unwrap()).unwrap();
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let pcm: Vec<f32> = wav[data..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&b| i16::from_le_bytes(b) as f32 / 32768.0)
            .collect();
        let t = std::time::Instant::now();
        let single = transcribe_with_model(&model_path(), &pcm, false).unwrap();
        println!("single pass {:?}: {single}", t.elapsed());
        let t = std::time::Instant::now();
        let text = transcribe_with_model(&model_path(), &pcm, true).unwrap();
        println!("chunked {:?}:\n{text}", t.elapsed());
        println!(
            "--- as dictation:\n{:?}",
            crate::listrules::number_list(&text)
        );
        assert!(text.lines().count() >= 3, "{text}");
    }

    #[test]
    fn split_at_pauses_cuts_mid_pause() {
        let pcm = vec![0.1f32; 16_000 * 4];
        let chunks = split_at_pauses(&pcm, &[(1.0, 2.0)]);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 24_000);
        assert!(chunk_is_silent(&[0.0; 3_200]));
        assert!(!chunk_is_silent(&pcm[..3_200]));
    }

    #[test]
    fn long_pauses_empty_input() {
        assert!(long_pauses(&[]).is_empty());
    }

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

    // ---- user dictionary ----

    fn dict(json: &str) -> Vec<DictEntry> {
        parse_dictionary(&serde_json::from_str(json).unwrap())
    }

    fn correct(json: &str, text: &str) -> String {
        apply_corrections(text, &build_corrections(&dict(json)))
    }

    #[test]
    fn parses_terms_and_mishears_dropping_junk() {
        // Terms come back alphabetical (serde_json's map is a BTreeMap).
        let d = dict(
            r#"{"dictionary": {"Tauri": ["towery", " tory ", 3, ""], "Whisper": [], "  ": ["x"], "Raycast": "not-an-array"}}"#,
        );
        assert_eq!(
            d,
            vec![
                DictEntry {
                    term: "Raycast".into(),
                    mishears: vec![],
                },
                DictEntry {
                    term: "Tauri".into(),
                    mishears: vec!["towery".into(), "tory".into()],
                },
                DictEntry {
                    term: "Whisper".into(),
                    mishears: vec![],
                },
            ]
        );
    }

    #[test]
    fn missing_or_malformed_dictionary_is_empty() {
        assert!(dict(r#"{}"#).is_empty());
        assert!(dict(r#"{"dictionary": ["Tauri"]}"#).is_empty());
        assert!(dict(r#"{"dictionary": "Tauri"}"#).is_empty());
    }

    #[test]
    fn prompt_appends_every_term_after_the_builtins() {
        let d = dict(r#"{"dictionary": {"Tauri": ["towery"], "Whisper": []}}"#);
        assert_eq!(build_prompt(&d), format!("{VOCAB_PROMPT}, Tauri, Whisper"));
        assert_eq!(build_prompt(&[]), VOCAB_PROMPT);
    }

    #[test]
    fn corrects_mishears_case_insensitively_on_word_boundaries() {
        let j = r#"{"dictionary": {"Tauri": ["towery", "tory"], "Whisper": ["wisper"]}}"#;
        assert_eq!(
            correct(j, "Check Towery and wisper builds, then TORY again."),
            "Check Tauri and Whisper builds, then Tauri again."
        );
        // No partial-word hits: "history" is not "tory".
        assert_eq!(correct(j, "history"), "history");
    }

    #[test]
    fn multi_word_mishears_match_across_spacing() {
        let j = r#"{"dictionary": {"Raycast": ["ray cast"]}}"#;
        assert_eq!(correct(j, "open ray  cast now"), "open Raycast now");
    }

    #[test]
    fn mishears_are_literal_not_regex() {
        let j = r#"{"dictionary": {"C++": ["c plus plus", "see.plus"]}}"#;
        assert_eq!(correct(j, "learn c plus plus"), "learn C++");
        // The "." is escaped: "seeXplus" must NOT match.
        assert_eq!(correct(j, "seeXplus"), "seeXplus");
        assert_eq!(correct(j, "see.plus"), "C++");
    }

    #[test]
    fn term_without_mishears_produces_no_correction() {
        let j = r#"{"dictionary": {"Whisper": []}}"#;
        assert!(build_corrections(&dict(j)).is_empty());
        assert_eq!(correct(j, "wisper"), "wisper");
    }
}
