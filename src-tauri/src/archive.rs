//! Archive purge: after confirmation, empties `archive.md` and moves any
//! screenshot referenced only by the archive (not by anything still live)
//! into the macOS Trash.

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{confine, inbox_path, notes_dir};

/// Every `inbox-assets/...` reference in a blob of markdown (same shape the
/// frontend's assetPaths() matches: up to whitespace or a closing paren).
pub(crate) fn asset_refs(text: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for (i, _) in text.match_indices("inbox-assets/") {
        let rest = &text[i..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == ')')
            .unwrap_or(rest.len());
        out.insert(rest[..end].to_string());
    }
    out
}

/// Move a file into the user's Trash by plain rename (same volume, no
/// Finder automation, no TCC prompt), suffixing on name collisions.
pub(crate) fn move_to_user_trash(p: &Path) -> Result<(), String> {
    let trash_dir = dirs::home_dir().ok_or("no home dir")?.join(".Trash");
    let name = p
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or("bad filename")?
        .to_string();
    let mut dest = trash_dir.join(&name);
    let mut n = 1;
    while dest.exists() {
        let path = std::path::Path::new(&name);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        dest = trash_dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    fs::rename(p, dest).map_err(|e| e.to_string())
}

/// Tray-menu "Purge Archive…": after a native confirmation, empty
/// archive.md and move screenshots referenced ONLY by the archive into the
/// macOS Trash. The Trash is the final safety net — this is the one place
/// Sideline actually lets go of data. Runs on its own thread (the confirm
/// dialog blocks).
pub(crate) fn purge_archive(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let archive_path = notes_dir().join("archive.md");
    let archive = fs::read_to_string(&archive_path).unwrap_or_default();
    if archive.trim().is_empty() {
        app.dialog()
            .message("The archive is already empty.")
            .title("Purge Archive")
            .blocking_show();
        return;
    }
    let entry_count = archive.lines().filter(|l| l.starts_with("### ")).count();

    // An asset is purgeable only if nothing OUTSIDE the archive still
    // references it: check inbox.md plus every notes/ and todos/ file.
    let mut live = String::new();
    live.push_str(&fs::read_to_string(inbox_path()).unwrap_or_default());
    for sub in ["notes", "todos"] {
        if let Ok(dir) = fs::read_dir(notes_dir().join(sub)) {
            for entry in dir.flatten() {
                live.push_str(&fs::read_to_string(entry.path()).unwrap_or_default());
                live.push('\n');
            }
        }
    }
    let live_refs = asset_refs(&live);
    let purgeable: Vec<PathBuf> = asset_refs(&archive)
        .into_iter()
        .filter(|r| !live_refs.contains(r))
        .filter_map(|r| confine(Path::new(&r)).ok())
        .filter(|p| p.is_file())
        .collect();

    let msg = format!(
        "Permanently purge {entry_count} archived entr{} and move {} screenshot{} to the Trash?",
        if entry_count == 1 { "y" } else { "ies" },
        purgeable.len(),
        if purgeable.len() == 1 { "" } else { "s" },
    );
    let confirmed = app
        .dialog()
        .message(msg)
        .title("Purge Archive")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Purge".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !confirmed {
        return;
    }

    let mut trashed = 0;
    for p in &purgeable {
        if move_to_user_trash(p).is_ok() {
            trashed += 1;
        }
    }
    let _ = fs::write(&archive_path, "");
    app.dialog()
        .message(format!(
            "Purged {entry_count} entr{}; {trashed} screenshot{} moved to Trash.",
            if entry_count == 1 { "y" } else { "ies" },
            if trashed == 1 { "" } else { "s" },
        ))
        .title("Purge Archive")
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- asset_refs -------------------------------------------------------

    #[test]
    fn asset_refs_zero_refs() {
        assert_eq!(
            asset_refs("no assets mentioned here"),
            std::collections::HashSet::new()
        );
    }

    #[test]
    fn asset_refs_one_ref_terminated_by_whitespace() {
        let refs = asset_refs("see inbox-assets/foo.png for details");
        let expected: std::collections::HashSet<String> =
            ["inbox-assets/foo.png".to_string()].into_iter().collect();
        assert_eq!(refs, expected);
    }

    #[test]
    fn asset_refs_ref_terminated_by_closing_paren() {
        let refs = asset_refs("![shot](inbox-assets/shot.png)");
        let expected: std::collections::HashSet<String> =
            ["inbox-assets/shot.png".to_string()].into_iter().collect();
        assert_eq!(refs, expected);
    }

    #[test]
    fn asset_refs_ref_runs_to_end_of_text() {
        // No trailing whitespace or ')' — the match runs to the end of
        // the string (the `.unwrap_or(rest.len())` fallback).
        let refs = asset_refs("inbox-assets/tail.png");
        let expected: std::collections::HashSet<String> =
            ["inbox-assets/tail.png".to_string()].into_iter().collect();
        assert_eq!(refs, expected);
    }

    #[test]
    fn asset_refs_multiple_distinct_refs() {
        let refs = asset_refs("inbox-assets/a.png then inbox-assets/b.png");
        let expected: std::collections::HashSet<String> = [
            "inbox-assets/a.png".to_string(),
            "inbox-assets/b.png".to_string(),
        ]
        .into_iter()
        .collect();
        assert_eq!(refs, expected);
    }

    #[test]
    fn asset_refs_duplicate_refs_dedup_to_one() {
        let refs = asset_refs("inbox-assets/dup.png ... inbox-assets/dup.png");
        assert_eq!(refs.len(), 1);
        assert!(refs.contains("inbox-assets/dup.png"));
    }
}
