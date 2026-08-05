//! Commands (and the plain-fn tray helper `reveal_inbox`) that hand a file
//! or folder off to Finder or VS Code.

use std::path::Path;

use crate::paths::{inbox_path, notes_dir, validate_component};

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

/// Opens inbox.md itself in VS Code — the Inbox view's `o`, so `o` means
/// "open the relevant file in VS Code" in every view.
#[tauri::command]
pub(crate) fn open_inbox_in_vscode() -> Result<(), String> {
    open_in_vscode(inbox_path())
}
