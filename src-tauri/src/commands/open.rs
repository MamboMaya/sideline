//! Commands (and the plain-fn tray helper `reveal_inbox`) that hand a file
//! or folder off to Finder or VS Code.

use std::path::Path;

use crate::paths::{inbox_path, notes_dir, validate_component};

/// Scratch launcher the Ask view's "Continue in Terminal" writes and
/// `open`s — inside ~/notes, like every other file Sideline touches.
const CONTINUE_SCRIPT: &str = ".sideline-continue.command";

/// Terminals `open_ask_session` knows how to hand a `.command` file to, as
/// macOS app names (`open -a <name>`), in auto-pick preference order —
/// a third-party terminal the user bothered to install beats the stock
/// one. Every one of these executes a `.command`/shell file it's asked to
/// open (verified for iTerm2 and Terminal). "Terminal" is the fallback and
/// lives under /System/Applications, so it's treated as always present.
const KNOWN_TERMINALS: &[&str] = &[
    "iTerm",
    "Ghostty",
    "Warp",
    "kitty",
    "WezTerm",
    "Alacritty",
    "Terminal",
];

fn terminal_installed(name: &str) -> bool {
    name == "Terminal" || Path::new(&format!("/Applications/{name}.app")).exists()
}

/// Installed known terminals in preference order (always ends with
/// "Terminal") — the Settings → Claude "Continue in" dropdown's options.
/// The frontend shows `iTerm` as "iTerm2".
#[tauri::command]
pub(crate) fn list_terminals() -> Vec<String> {
    KNOWN_TERMINALS
        .iter()
        .filter(|n| terminal_installed(n))
        .map(|n| n.to_string())
        .collect()
}

/// Shared body of `open_triaged`/`open_todos`/`open_inbox_in_vscode`: hand
/// `path` to VS Code via `open -a "Visual Studio Code"`.
fn open_in_vscode(path: impl AsRef<Path>) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Visual Studio Code"])
        .arg(path.as_ref())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn open_triaged(filename: String) -> Result<(), String> {
    validate_component(&filename)?;
    open_in_vscode(notes_dir().join("notes").join(&filename))
}

#[tauri::command]
pub(crate) fn open_todos(project: String) -> Result<(), String> {
    validate_component(&project)?;
    open_in_vscode(notes_dir().join("todos").join(format!("{project}.md")))
}

/// Tray-menu "Reveal inbox.md in Finder". Not a `#[tauri::command]`: only
/// the tray menu calls this, as a plain fn.
pub(crate) fn reveal_inbox() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(inbox_path())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Ask view's `o` / "Continue in Terminal": resumes the CLI session an Ask
/// thread's answer came from (`AskReply::session_id`) as a full
/// interactive `claude` session, for the follow-ups the one-shot Ask view
/// deliberately doesn't do. The mechanism is a `.command` file: Terminal
/// is the default handler for that extension, so `open` alone launches it
/// — no `osascript`/Apple Events (which would be a new TCC automation
/// prompt blamed on Sideline) and no new subprocess beyond the ones
/// CLAUDE.md already allows. The script `cd`s to ~/notes first because the
/// CLI stores sessions per working directory and `ask_claude` ran there.
/// `session_id` is validated to the UUID alphabet before it goes anywhere
/// near a shell line. `terminal` is `.sideline.json`'s `terminal` key (an
/// app name from `KNOWN_TERMINALS`; anything else is rejected rather than
/// passed to `open -a`); None = auto, the first installed known terminal.
/// "Terminal" is a plain `open` (it's the `.command` default handler);
/// the others get `open -a <name>`.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn open_ask_session(session_id: String, terminal: Option<String>) -> Result<(), String> {
    let terminal = match terminal.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            if !KNOWN_TERMINALS.contains(&t) {
                return Err(format!("Unknown terminal {t:?}"));
            }
            t.to_string()
        }
        None => KNOWN_TERMINALS
            .iter()
            .find(|n| terminal_installed(n))
            .unwrap_or(&"Terminal")
            .to_string(),
    };
    let ok = session_id.len() == 36
        && session_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !ok {
        return Err("Invalid session id".to_string());
    }
    let bin = crate::claude::claude_bin();
    let script = format!(
        "#!/bin/zsh\ncd \"{notes}\" || exit 1\nexec \"{bin}\" --resume {session_id}\n",
        notes = notes_dir().display(),
        bin = Path::new(&bin).display(),
    );
    let path = notes_dir().join(CONTINUE_SCRIPT);
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new("open");
    if terminal != "Terminal" {
        cmd.args(["-a", &terminal]);
    }
    cmd.arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens inbox.md itself in VS Code — the Inbox view's `o`, so `o` means
/// "open the relevant file in VS Code" in every view.
#[tauri::command]
pub(crate) fn open_inbox_in_vscode() -> Result<(), String> {
    open_in_vscode(inbox_path())
}
