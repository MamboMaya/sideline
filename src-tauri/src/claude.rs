//! `send_to_claude`: shells out to the `claude` CLI for note-triage
//! completions. `ask_claude`: shells out to the same CLI for the Quick
//! Question (Ask) pane, with web search enabled instead of triage's
//! all-tools-off stance.

use std::path::PathBuf;

use crate::paths::notes_dir;

/// Resolves the `claude` CLI binary the same way for every command in this
/// module: Finder-launched apps don't inherit the shell's PATH, so a bare
/// `Command::new("claude")` would only work when Sideline happens to be
/// launched from a terminal. Checks a few well-known install locations
/// first and falls back to the bare name (which still works if PATH does
/// contain it, e.g. when running via `pnpm tauri dev`).
fn claude_bin() -> std::ffi::OsString {
    let home = dirs::home_dir();
    let mut candidates = Vec::new();
    if let Some(home) = &home {
        candidates.push(home.join(".local/bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates
        .iter()
        .find(|p| p.exists())
        .map(|p| p.as_os_str().to_owned())
        .unwrap_or_else(|| "claude".into())
}

#[tauri::command]
pub(crate) async fn send_to_claude(
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(claude_bin());
        // Triage calls are pure text completions — load NO user settings
        // (hooks, plugins) and no MCP servers. Anything the CLI's startup
        // touches runs under Sideline's TCC identity, so a hook or MCP
        // server reading a protected folder (e.g. ~/Documents) makes macOS
        // blame Sideline with a permissions popup on every triage. Bare
        // calls are also faster and cheaper (no hook context in the prompt).
        // (--bare would be ideal but it disables OAuth keychain auth.)
        // `--tools ""` disables the CLI's entire built-in tool set: note
        // bodies are untrusted input, and without it a prompt-injected note
        // could make the CLI read files (cwd is ~/notes, so reads there are
        // auto-allowed in -p mode) or otherwise act instead of just
        // completing text. Verified: with the flag, a "read inbox.md" probe
        // can only hallucinate — no tool runs.
        cmd.arg("-p")
            .arg(&prompt)
            .arg("--setting-sources")
            .arg("")
            .arg("--strict-mcp-config")
            .arg("--tools")
            .arg("");
        if let Some(m) = model {
            cmd.arg("--model").arg(m);
        }
        let out = cmd
            .current_dir(notes_dir())
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(err.lines().next().unwrap_or("claude failed").to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// System prompt for `ask_claude`: keeps answers short and plain-text (the
/// Ask pane is a small popover, not a chat transcript) and steers the model
/// toward web search whenever the question is the kind a search engine
/// would answer better than memorized training data.
const ASK_SYSTEM_PROMPT: &str = "You answer quick, zero-context questions for a busy person who would otherwise open a search engine. Reply in plain text, at most about 120 words: no markdown headers or tables (a short dash bullet list is fine). Use web search when the answer depends on current facts, product options, prices, or a term you are not sure about. When you searched, end with 1-3 source URLs, one per line, prefixed 'Source: '. If the question is ambiguous, answer the most likely meaning and say in a few words which one you picked.";

#[tauri::command]
pub(crate) async fn ask_claude(question: String, model: Option<String>) -> Result<String, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("Empty question".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(claude_bin());
        // Same no-hooks/no-MCP stance as send_to_claude — see its comment —
        // but this command DOES need tools: `--tools` narrows the CLI's
        // built-in set to exactly WebSearch/WebFetch (no file/Bash tools,
        // same untrusted-input reasoning as send_to_claude's `--tools ""`:
        // the question is untrusted input, so it must never be able to make
        // the CLI touch the filesystem or run commands). `--allowedTools`
        // pre-approves those two so non-interactive `-p` mode actually runs
        // them instead of asking for permission — verified: without it the
        // CLI refuses to search and just answers from memory.
        cmd.arg("-p")
            .arg(&question)
            .arg("--setting-sources")
            .arg("")
            .arg("--strict-mcp-config")
            .arg("--tools")
            .arg("WebSearch,WebFetch")
            .arg("--allowedTools")
            .arg("WebSearch,WebFetch")
            .arg("--max-turns")
            .arg("6")
            .arg("--append-system-prompt")
            .arg(ASK_SYSTEM_PROMPT);
        if let Some(m) = model {
            cmd.arg("--model").arg(m);
        }
        let out = cmd
            .current_dir(notes_dir())
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(err.lines().next().unwrap_or("claude failed").to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
