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

/// What survives a confirmed purge: the confirm dialog can sit open for
/// minutes while the frontend keeps appending to archive.md, and only the
/// snapshot the user saw was confirmed. The archive is append-only, so
/// content added meanwhile is a suffix — return it (to be written back,
/// leading newlines trimmed). Any non-append divergence (external edit,
/// truncation) returns None: abort rather than destroy unconfirmed data.
fn purge_remainder(snapshot: &str, current: &str) -> Option<String> {
    current
        .strip_prefix(snapshot)
        .map(|tail| tail.trim_start_matches('\n').to_string())
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
    // Refs kept alongside paths: after the confirm dialog the survivors of
    // the snapshot-vs-now diff must be re-excluded by ref string.
    let purgeable: Vec<(String, PathBuf)> = asset_refs(&archive)
        .into_iter()
        .filter(|r| !live_refs.contains(r))
        .filter_map(|r| confine(Path::new(&r)).ok().map(|p| (r, p)))
        .filter(|(_, p)| p.is_file())
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

    // The dialog may have sat open for minutes; only the snapshot the user
    // saw was confirmed. Preserve anything appended meanwhile, abort on
    // any other change.
    let current = fs::read_to_string(&archive_path).unwrap_or_default();
    let Some(remainder) = purge_remainder(&archive, &current) else {
        app.dialog()
            .message("archive.md changed while confirming — nothing was purged. Try again.")
            .title("Purge Archive")
            .blocking_show();
        return;
    };
    let kept = remainder.lines().filter(|l| l.starts_with("### ")).count();

    // Entries appended during the dialog may reference assets that were
    // purgeable a moment ago — keep those out of the Trash.
    let remainder_refs = asset_refs(&remainder);
    let mut trashed = 0;
    for (r, p) in &purgeable {
        if !remainder_refs.contains(r) && move_to_user_trash(p).is_ok() {
            trashed += 1;
        }
    }

    // Checked, not `let _ =`: this is the one write that destroys data — a
    // failure must not be reported as success (screenshots above are
    // already in the Trash either way; say so).
    if let Err(e) = fs::write(&archive_path, &remainder) {
        app.dialog()
            .message(format!(
                "Failed to rewrite archive.md ({e}). No entries were purged; \
                 {trashed} screenshot{} already moved to Trash (restorable there).",
                if trashed == 1 { " was" } else { "s were" },
            ))
            .title("Purge Archive")
            .blocking_show();
        return;
    }
    let kept_note = if kept > 0 {
        format!(
            " Kept {kept} entr{} added while confirming.",
            if kept == 1 { "y" } else { "ies" }
        )
    } else {
        String::new()
    };
    app.dialog()
        .message(format!(
            "Purged {entry_count} entr{}; {trashed} screenshot{} moved to Trash.{kept_note}",
            if entry_count == 1 { "y" } else { "ies" },
            if trashed == 1 { "" } else { "s" },
        ))
        .title("Purge Archive")
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- purge_remainder --------------------------------------------------

    #[test]
    fn purge_remainder_unchanged_archive_leaves_nothing() {
        assert_eq!(
            purge_remainder("### old entry\nbody\n", "### old entry\nbody\n"),
            Some(String::new())
        );
    }

    #[test]
    fn purge_remainder_preserves_entries_appended_during_confirm() {
        let snapshot = "### old entry\nbody\n";
        let current = "### old entry\nbody\n\n### new entry\nnew body\n";
        assert_eq!(
            purge_remainder(snapshot, current),
            Some("### new entry\nnew body\n".to_string())
        );
    }

    #[test]
    fn purge_remainder_aborts_on_non_append_divergence() {
        // Anything other than a pure append (external edit, truncation)
        // must abort the purge rather than destroy unconfirmed content.
        assert_eq!(
            purge_remainder("### old entry\nbody\n", "### rewritten\n"),
            None
        );
    }

    #[test]
    fn purge_remainder_aborts_on_truncation() {
        assert_eq!(purge_remainder("### old entry\nbody\n", ""), None);
    }

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
