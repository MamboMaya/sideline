//! "Add project…": the native folder picker behind the tray menu item and
//! Settings' "Choose folder…" button. Picking a folder is the CLICK path to
//! a `projects` entry in `.sideline.json` (docs/data-model.md); the
//! frontend's AddProjectModal turns the folder name into a tag and writes
//! the config — nothing here touches the config file.
//!
//! No new TCC surface: NSOpenPanel is the OS's own consent UI (never
//! prompts), and Sideline only ever stores the chosen path as a string —
//! it never reads or writes inside the picked folder, so a repo under
//! ~/Documents is fine. Keep it that way (CLAUDE.md: notes I/O stays in
//! ~/notes).
//!
//! Why `rfd` directly and not `tauri-plugin-dialog`'s file dialogs: the
//! plugin's picker attaches as a SHEET to the app's first NSWindow. For a
//! menu-bar popover that window is hidden (tray path) or hides itself the
//! moment the panel takes focus (`hide_on_focus_loss`) — the sheet never
//! appears and macOS just beeps. `rfd::FileDialog` (sync) with no parent
//! runs a standalone `runModal` panel at shielding level that activates the
//! app itself, which is what a tray-launched picker needs.

use std::sync::atomic::Ordering;

use tauri::Emitter;

use crate::window::{show_or_focus_window, SUPPRESS_HIDE};

/// Native folder picker; `None` when cancelled. Blocks the CALLING thread
/// until the panel closes, so never call it from the main thread: the panel
/// itself has to run there (AppKit), hence `run_on_main_thread` + a channel.
/// The tray handler spawns a thread; the IPC command is `async`, which
/// Tauri runs off the main thread. `SUPPRESS_HIDE` keeps the popover from
/// hiding when the panel takes focus; the callers re-focus it afterwards.
pub(crate) fn pick_folder(app: &tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    SUPPRESS_HIDE.store(true, Ordering::SeqCst);
    let queued = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("Add project")
            .pick_folder();
        let _ = tx.send(picked);
    });
    let picked = if queued.is_ok() {
        rx.recv().ok().flatten()
    } else {
        None
    };
    SUPPRESS_HIDE.store(false, Ordering::SeqCst);
    picked.map(|p| p.to_string_lossy().into_owned())
}

/// Settings → Tags → Project routing → "Choose folder…". Re-focuses the
/// popover on return (the panel took key status from it).
#[tauri::command]
pub(crate) async fn pick_project_folder(app: tauri::AppHandle) -> Option<String> {
    let picked = pick_folder(&app);
    show_or_focus_window(&app);
    picked
}

/// Tray-menu "Add project…": pick, then raise the popover and hand the
/// path to the frontend (`project-picked`), which opens the same
/// AddProjectModal the Settings button does.
pub(crate) fn add_project_from_tray(app: &tauri::AppHandle) {
    let Some(path) = pick_folder(app) else {
        return;
    };
    show_or_focus_window(app);
    let _ = app.emit("project-picked", path);
}

/// The `.command` file `setup_project_repo` hands to the terminal — inside
/// ~/notes like `open_ask_session`'s (docs/backend.md).
const SETUP_SCRIPT: &str = ".sideline-setup.command";

/// The one-line pointer a repo's CLAUDE.local.md needs so a Claude session
/// there finds its routed todos. Frontend shows this too (AddProjectModal
/// fetches the whole script via `project_setup_script`), so it lives here
/// only.
fn claude_local_snippet(tag: &str) -> String {
    format!(
        "Pending {tag} todos: `~/notes/todos/{tag}.md` — flip ⬜→✅ when done.\n\
         Skip 🧊 (iced) entries: deliberately parked — don't work them.\n"
    )
}

/// Validates the (folder, tag) pair before either goes near a shell line:
/// the tag is what `sanitizeTag` produces (`[a-z0-9_-]`, 1–24 chars) and
/// the folder is an absolute path to an existing directory with no
/// single quote or control character (it's single-quoted in the script).
fn validate_setup_args(path: &str, tag: &str) -> Result<(), String> {
    let tag_ok = !tag.is_empty()
        && tag.len() <= 24
        && tag
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if !tag_ok {
        return Err("Invalid project tag".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() || path.chars().any(|c| c == '\'' || c.is_control()) {
        return Err("Invalid project folder".to_string());
    }
    if !p.is_dir() {
        return Err("Project folder not found".to_string());
    }
    Ok(())
}

/// The shell script the "Set up repo in Terminal" button runs (and "Copy
/// command" copies): append the CLAUDE.local.md pointer to the picked
/// folder, idempotently (a second run is a no-op). The TERMINAL does this
/// write — Sideline itself never writes outside ~/notes, and Claude Code
/// already keeps CLAUDE.local.md out of git via .git/info/exclude.
fn setup_script(path: &str, tag: &str) -> String {
    format!(
        "#!/bin/zsh\n\
         cd '{path}' || exit 1\n\
         grep -q 'todos/{tag}.md' CLAUDE.local.md 2>/dev/null || cat >> CLAUDE.local.md <<'EOF'\n\
         {snippet}\
         EOF\n\
         echo \"CLAUDE.local.md updated in $PWD\"\n",
        snippet = claude_local_snippet(tag),
    )
}

/// AddProjectModal's done state shows/copies this — same text the button
/// runs, so the user can see exactly what will happen.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn project_setup_script(path: String, tag: String) -> Result<String, String> {
    validate_setup_args(&path, &tag)?;
    Ok(setup_script(&path, &tag))
}

/// "Set up repo in Terminal": writes the script to ~/notes and opens it in
/// the configured terminal (`terminal` = `.sideline.json`'s key, None =
/// auto) — the same hand-off `open_ask_session` uses.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn setup_project_repo(
    path: String,
    tag: String,
    terminal: Option<String>,
) -> Result<(), String> {
    validate_setup_args(&path, &tag)?;
    let terminal = crate::commands::open::resolve_terminal(terminal)?;
    crate::commands::open::open_command_script(SETUP_SCRIPT, &setup_script(&path, &tag), &terminal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_is_idempotent_append_in_the_picked_folder() {
        let s = setup_script("/Users/me/projects/Content-Studio", "content-studio");
        assert!(s.starts_with("#!/bin/zsh\ncd '/Users/me/projects/Content-Studio' || exit 1\n"));
        assert!(s.contains("grep -q 'todos/content-studio.md' CLAUDE.local.md 2>/dev/null || cat >> CLAUDE.local.md <<'EOF'\n"));
        assert!(s.contains("Pending content-studio todos: `~/notes/todos/content-studio.md`"));
        assert!(s.contains("\nEOF\n"));
    }

    #[test]
    fn rejects_shell_unsafe_args() {
        let dir = std::env::temp_dir();
        let dir = dir.to_str().unwrap();
        assert!(validate_setup_args(dir, "content-studio").is_ok());
        assert!(validate_setup_args(dir, "Content Studio").is_err());
        assert!(validate_setup_args(dir, "").is_err());
        assert!(validate_setup_args("relative/dir", "ok").is_err());
        assert!(validate_setup_args(&format!("{dir}/it's"), "ok").is_err());
        assert!(validate_setup_args("/definitely/not/here", "ok").is_err());
    }
}
