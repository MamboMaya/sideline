//! First-run autostart consent. The old behavior called
//! `autolaunch().enable()` on every launch, silently re-adding the Login
//! Item after a user removed it in System Settings. Now the app asks ONCE
//! (native dialog), records that the question was answered via a sentinel
//! file in Application Support — which survives app updates, so the prompt
//! can never come back — and after that System Settings > Login Items is
//! the single source of truth.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const SENTINEL_NAME: &str = "autostart-prompted";

fn prompt_needed(sentinel: &Path) -> bool {
    !sentinel.exists()
}

/// Existence is the record; content is irrelevant. Creates parent dirs
/// because Application Support/<identifier>/ may not exist yet.
fn record_prompted(sentinel: &Path) -> std::io::Result<()> {
    if let Some(dir) = sentinel.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(sentinel, b"")
}

fn sentinel_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(SENTINEL_NAME))
}

/// Shows the one-time "launch at login?" dialog if it has never been
/// answered. "Not Now" actively disables rather than just skipping the
/// enable: installs that predate the prompt already have the Login Item
/// registered by the old force-enable, and declining must remove it. The
/// sentinel is written only after an answer, so quitting the dialog
/// unanswered re-asks on the next launch.
pub fn ensure_consent(app: &AppHandle) {
    let Some(sentinel) = sentinel_path(app) else {
        return;
    };
    if !prompt_needed(&sentinel) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(
            "Launch Sideline automatically when you log in?\n\n\
             You can change this anytime in System Settings > General > Login Items.",
        )
        .title("Sideline")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Launch at Login".to_string(),
            "Not Now".to_string(),
        ))
        .show(move |launch_at_login| {
            let autolaunch = handle.autolaunch();
            let _ = if launch_at_login {
                autolaunch.enable()
            } else {
                autolaunch.disable()
            };
            let _ = record_prompted(&sentinel);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_sentinel(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("sideline-autostart-test-{}", std::process::id()))
            .join(name)
            .join("autostart-prompted")
    }

    #[test]
    fn prompt_needed_when_sentinel_missing() {
        let sentinel = scratch_sentinel("missing");
        assert!(prompt_needed(&sentinel));
    }

    #[test]
    fn prompt_not_needed_after_recording() {
        let sentinel = scratch_sentinel("recorded");
        record_prompted(&sentinel).expect("record should succeed");
        assert!(!prompt_needed(&sentinel));
        let _ = std::fs::remove_dir_all(sentinel.parent().unwrap());
    }

    #[test]
    fn record_creates_missing_parent_dirs() {
        // Application Support/<identifier>/ may not exist on a fresh
        // machine; recording must create the whole path, not fail.
        let sentinel = scratch_sentinel("deep/nested/dirs");
        assert!(!sentinel.parent().unwrap().exists());
        record_prompted(&sentinel).expect("record should create parents");
        assert!(sentinel.exists());
        let _ = std::fs::remove_dir_all(
            std::env::temp_dir().join(format!("sideline-autostart-test-{}", std::process::id())),
        );
    }
}
