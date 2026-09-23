//! Reminders auto-detected in notes. Detection itself (`parseReminder`)
//! lives in the frontend (`src/lib/reminders.ts`) — this module only
//! stores what the frontend registers (`add_reminder`), fires due ones on
//! a background tick, and backs the banner's list/dismiss/snooze actions.
//! Storage is `~/notes/.sideline-reminders.json`, a JSON array of
//! `Reminder` — see docs/data-model.md for the on-disk shape.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::notes::write_file;
use crate::paths::notes_dir;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Reminder {
    pub id: String,
    pub text: String,
    pub due_ms: i64,
    pub note_timestamp: String,
    #[serde(default)]
    pub fired: bool,
    #[serde(default)]
    pub dismissed: bool,
}

fn reminders_path() -> PathBuf {
    notes_dir().join(".sideline-reminders.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// A missing/unreadable/malformed file reads as no reminders — same
/// failure-tolerance idiom as the rest of the crate's own-file config reads
/// (e.g. `audio::configured_device_name`), since nothing else ever writes
/// this file concurrently.
fn read_all() -> Vec<Reminder> {
    let Ok(raw) = std::fs::read_to_string(reminders_path()) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Drops dismissed entries whose due time is more than 24h in the past —
/// applied on every write so the file never grows unbounded with old,
/// already-handled reminders. Undismissed entries are always kept, however
/// old (the banner is what surfaces them; this module never expires a
/// reminder the user hasn't acted on).
fn prune(reminders: Vec<Reminder>) -> Vec<Reminder> {
    let cutoff = now_ms() - 24 * 60 * 60 * 1000;
    reminders
        .into_iter()
        .filter(|r| !r.dismissed || r.due_ms >= cutoff)
        .collect()
}

fn write_all(reminders: &[Reminder]) -> Result<(), String> {
    let pruned = prune(reminders.to_vec());
    let json = serde_json::to_string_pretty(&pruned).map_err(|e| e.to_string())?;
    write_file(&reminders_path(), json)
}

/// Adds `r` unless a reminder with the same id already exists — the
/// idempotency a re-scan of an unchanged note relies on (see
/// `src/lib/reminders.ts`'s id shape: note timestamp + a hash of the body).
/// Pure: returns the new list and whether anything changed.
fn add_dedup(mut reminders: Vec<Reminder>, r: Reminder) -> (Vec<Reminder>, bool) {
    if reminders.iter().any(|existing| existing.id == r.id) {
        return (reminders, false);
    }
    reminders.push(r);
    (reminders, true)
}

fn mark_dismissed(mut reminders: Vec<Reminder>, id: &str) -> Vec<Reminder> {
    for r in reminders.iter_mut() {
        if r.id == id {
            r.dismissed = true;
        }
    }
    reminders
}

/// Sets a new due time `minutes` from `now_ms` and clears `fired`, so the
/// background tick fires it again — the banner's "+10 min" button.
fn apply_snooze(
    mut reminders: Vec<Reminder>,
    id: &str,
    minutes: i64,
    now_ms: i64,
) -> Vec<Reminder> {
    for r in reminders.iter_mut() {
        if r.id == id {
            r.due_ms = now_ms + minutes * 60_000;
            r.fired = false;
        }
    }
    reminders
}

fn undismissed_sorted(mut reminders: Vec<Reminder>) -> Vec<Reminder> {
    reminders.retain(|r| !r.dismissed);
    reminders.sort_by_key(|r| r.due_ms);
    reminders
}

/// Indices of reminders that are due (or overdue — covers a reminder whose
/// due time passed while the app was closed, which fires on the first tick
/// after launch) and not yet fired. Pure so it's testable without a clock
/// or the filesystem.
fn due_now(reminders: &[Reminder], now_ms: i64) -> Vec<usize> {
    reminders
        .iter()
        .enumerate()
        .filter(|(_, r)| !r.fired && r.due_ms <= now_ms)
        .map(|(i, _)| i)
        .collect()
}

/// Whether any reminder is fired and not yet dismissed — the tray title's
/// `⏰` indicator (see `audio::set_tray_title`).
pub(crate) fn any_fired_pending() -> bool {
    read_all().iter().any(|r| r.fired && !r.dismissed)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn add_reminder(
    id: String,
    text: String,
    due_ms: i64,
    note_timestamp: String,
) -> Result<(), String> {
    let (all, changed) = add_dedup(
        read_all(),
        Reminder {
            id,
            text,
            due_ms,
            note_timestamp,
            fired: false,
            dismissed: false,
        },
    );
    if changed {
        write_all(&all)?;
    }
    Ok(())
}

/// Undismissed reminders, soonest due first — the banner's (fired ones) and
/// header hint's (upcoming ones) one source of truth.
#[tauri::command]
pub(crate) fn list_reminders() -> Result<Vec<Reminder>, String> {
    Ok(undismissed_sorted(read_all()))
}

#[tauri::command]
pub(crate) fn dismiss_reminder(app: AppHandle, id: String) -> Result<(), String> {
    write_all(&mark_dismissed(read_all(), &id))?;
    crate::audio::refresh_tray_title(&app);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn snooze_reminder(app: AppHandle, id: String, minutes: i64) -> Result<(), String> {
    write_all(&apply_snooze(read_all(), &id, minutes, now_ms()))?;
    crate::audio::refresh_tray_title(&app);
    Ok(())
}

/// One tick of the background thread spawned from `lib.rs`'s `.setup()`:
/// fires every due-and-unfired reminder, emits `reminder-fired` for each,
/// shows the popover (the same function the tray/hotkey use — see
/// `window::show_or_focus_window`), and refreshes the tray's `⏰`.
fn tick(app: &AppHandle) {
    let mut all = read_all();
    let due = due_now(&all, now_ms());
    if due.is_empty() {
        return;
    }
    let mut fired = Vec::with_capacity(due.len());
    for i in due {
        all[i].fired = true;
        fired.push(all[i].clone());
    }
    if write_all(&all).is_err() {
        return;
    }
    for r in &fired {
        let _ = app.emit("reminder-fired", r);
    }
    crate::window::show_or_focus_window(app);
    crate::audio::refresh_tray_title(app);
}

/// Spawns the ~5s polling loop that fires due reminders — started once from
/// `lib.rs`'s `.setup()`. A missed reminder (app was off when due passed)
/// fires on this thread's first tick after launch.
pub(crate) fn spawn_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        tick(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(id: &str, due_ms: i64, fired: bool, dismissed: bool) -> Reminder {
        Reminder {
            id: id.into(),
            text: "test".into(),
            due_ms,
            note_timestamp: "2026-01-01 12:00".into(),
            fired,
            dismissed,
        }
    }

    #[test]
    fn due_now_selects_unfired_reminders_at_or_before_now() {
        let reminders = vec![
            reminder("a", 100, false, false),
            reminder("b", 200, false, false),
            reminder("c", 50, true, false),
        ];
        assert_eq!(due_now(&reminders, 150), vec![0]);
    }

    #[test]
    fn due_now_treats_overdue_as_due_too() {
        // A reminder whose due time passed while the app was closed must
        // still fire on the first tick after launch.
        let reminders = vec![reminder("a", 100, false, false)];
        assert_eq!(due_now(&reminders, 100_000), vec![0]);
    }

    #[test]
    fn due_now_ignores_already_fired() {
        let reminders = vec![reminder("a", 50, true, false)];
        assert!(due_now(&reminders, 1_000).is_empty());
    }

    #[test]
    fn prune_drops_dismissed_entries_older_than_24h() {
        let now = now_ms();
        let old = reminder("old", now - 25 * 60 * 60 * 1000, true, true);
        let recent = reminder("recent", now - 1_000, true, true);
        let kept_undismissed = reminder("keep", now - 25 * 60 * 60 * 1000, true, false);
        let pruned = prune(vec![old, recent, kept_undismissed]);
        let ids: Vec<_> = pruned.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["recent", "keep"]);
    }

    #[test]
    fn add_dedup_skips_an_existing_id() {
        let existing = vec![reminder("x", 100, false, false)];
        let (all, changed) = add_dedup(existing, reminder("x", 999, false, false));
        assert!(!changed);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].due_ms, 100);
    }

    #[test]
    fn add_dedup_appends_a_new_id() {
        let existing = vec![reminder("x", 100, false, false)];
        let (all, changed) = add_dedup(existing, reminder("y", 200, false, false));
        assert!(changed);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn mark_dismissed_only_touches_the_matching_id() {
        let all = mark_dismissed(
            vec![
                reminder("a", 1, false, false),
                reminder("b", 2, false, false),
            ],
            "a",
        );
        assert!(all[0].dismissed);
        assert!(!all[1].dismissed);
    }

    #[test]
    fn apply_snooze_clears_fired_and_sets_a_new_due_time() {
        let all = apply_snooze(vec![reminder("a", 1, true, false)], "a", 10, 1_000_000);
        assert_eq!(all[0].due_ms, 1_000_000 + 10 * 60_000);
        assert!(!all[0].fired);
    }

    #[test]
    fn undismissed_sorted_drops_dismissed_and_orders_by_due() {
        let all = vec![
            reminder("late", 200, false, false),
            reminder("gone", 50, false, true),
            reminder("early", 100, false, false),
        ];
        let sorted = undismissed_sorted(all);
        let ids: Vec<_> = sorted.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["early", "late"]);
    }
}
