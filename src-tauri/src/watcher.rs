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
        let (tx, rx) = channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(_) => return,
        };
        let dir = notes_dir();
        let _ = std::fs::create_dir_all(&dir);
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        loop {
            if rx.recv().is_ok() {
                // Debounce bursts of fs events.
                while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
                let _ = app.emit("inbox-changed", ());
            }
        }
    });
}
