//! Filesystem watcher on `~/notes`: emits `inbox-changed` (debounced) so the
//! frontend reloads after an external write (Raycast capture, editing a
//! file directly, etc).

use std::sync::mpsc::channel;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::Emitter;

use crate::paths::notes_dir;

pub(crate) fn spawn_inbox_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Every exit path emits `watcher-dead` (frontend toasts it): a dead
        // watcher means external edits silently stop appearing for the rest
        // of the session, which the user must not have to discover by
        // noticing staleness.
        let dead = |why: String| {
            let _ = app.emit("watcher-dead", why);
        };
        let (tx, rx) = channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => return dead(e.to_string()),
        };
        let dir = notes_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            return dead(e.to_string());
        }
        loop {
            match rx.recv() {
                Ok(_) => {
                    // Debounce bursts of fs events.
                    while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
                    let _ = app.emit("inbox-changed", ());
                }
                // Sender gone — without this break the old `if .is_ok()`
                // shape would busy-spin at 100% CPU.
                Err(_) => return dead("watch channel closed".to_string()),
            }
        }
    });
}
