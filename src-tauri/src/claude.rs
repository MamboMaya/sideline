//! `send_to_claude`: shells out to the `claude` CLI for note-triage
//! completions.

use std::path::PathBuf;

use crate::paths::notes_dir;

#[tauri::command]
pub(crate) async fn send_to_claude(
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or("no home dir")?;
        let candidates = [
            home.join(".local/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        let bin = candidates
            .iter()
            .find(|p| p.exists())
            .map(|p| p.as_os_str().to_owned())
            .unwrap_or_else(|| "claude".into());
        let mut cmd = std::process::Command::new(bin);
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
