//! Reminders auto-detected in notes. Detection itself (`parseReminder`)
//! lives in the frontend (`src/lib/reminders.ts`) — this module only
//! stores what the frontend registers (`add_reminder`), fires due ones on
//! a background tick, and backs the banner's list/dismiss/snooze actions.
//! Storage is `~/notes/.sideline-reminders.json`, a JSON array of
//! `Reminder` — see docs/data-model.md for the on-disk shape.
//!
//! Every read-modify-write below (each command, and the ticker's `tick`)
//! holds `LOCK` for the whole span: the ticker thread and a command
//! invocation can land at the same moment, and without a lock a
//! read-then-write from each would interleave and one's write could undo
//! the other's. `write_all` also gives every write its own `.tmp` file name
//! (pid + a counter) rather than one shared name, so even a write that
//! somehow ran outside the lock can't collide mid-write with another.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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

/// Held across every read-modify-write below (commands and `tick`) — see
/// the module doc comment.
static LOCK: Mutex<()> = Mutex::new(());

fn reminders_path() -> PathBuf {
    notes_dir().join(".sideline-reminders.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Pure parse step of `read_all`, split out so it's testable without
/// touching the filesystem. Empty/whitespace-only content (a missing file
/// reads as this via `read_all`) means no reminders yet — not an error. Any
/// other content that fails to parse as a `Reminder` array IS an error: a
/// truncated or corrupt file must never be silently treated as empty, since
/// the caller would then write that empty list right back and erase
/// whatever was actually on disk.
fn parse_reminders(raw: &str) -> Result<Vec<Reminder>, String> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(raw).map_err(|e| format!("reminders file is corrupt: {e}"))
}

/// A missing/unreadable file reads as no reminders (same failure-tolerance
/// idiom as the rest of the crate's own-file config reads, e.g.
/// `audio::configured_device_name`); a present-but-unparseable file is an
/// error the caller must not paper over — see `parse_reminders`.
fn read_all() -> Result<Vec<Reminder>, String> {
    match std::fs::read_to_string(reminders_path()) {
        Ok(raw) => parse_reminders(&raw),
        Err(_) => Ok(Vec::new()),
    }
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

/// Counter mixed into every write's temp file name (alongside the process
/// id) so back-to-back writes from different threads never share one — see
/// the module doc comment.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_all(reminders: &[Reminder]) -> Result<(), String> {
    let pruned = prune(reminders.to_vec());
    let json = serde_json::to_string_pretty(&pruned).map_err(|e| e.to_string())?;
    let path = reminders_path();
    let parent = path.parent().ok_or("path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(
        ".sideline-reminders.json.{}.{n}.tmp",
        std::process::id()
    ));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Adds `r`, or updates the existing entry with the same id: same `due_ms`
/// and `text` is a no-op (the idempotency a re-scan of an unchanged note
/// relies on — see `src/lib/reminders.ts`'s id shape, the note's own
/// timestamp), a changed `due_ms` or `text` updates the entry in place, and
/// a changed `due_ms` specifically re-arms it (`fired`/`dismissed` reset to
/// false) so the new due time actually fires. Pure: returns the new list
/// and whether anything changed.
fn upsert(mut reminders: Vec<Reminder>, r: Reminder) -> (Vec<Reminder>, bool) {
    if let Some(existing) = reminders.iter_mut().find(|e| e.id == r.id) {
        if existing.due_ms == r.due_ms && existing.text == r.text {
            return (reminders, false);
        }
        let due_changed = existing.due_ms != r.due_ms;
        existing.text = r.text;
        existing.due_ms = r.due_ms;
        if due_changed {
            existing.fired = false;
            existing.dismissed = false;
        }
        return (reminders, true);
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

/// Drops the entry with `id` UNLESS it has already fired — a note edited
/// so it no longer parses as a reminder (see useInbox.ts) shouldn't cancel
/// a reminder the user has already seen fire; they dismiss/snooze that one
/// from the banner like any other. Pure: returns the new list.
fn remove_unfired(mut reminders: Vec<Reminder>, id: &str) -> Vec<Reminder> {
    reminders.retain(|r| r.id != id || r.fired);
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
/// `⏰` indicator (see `audio::set_tray_title`). A corrupt reminders file
/// reads as "none pending" rather than propagating the error — this is a
/// best-effort indicator, not a write path.
pub(crate) fn any_fired_pending() -> bool {
    read_all()
        .unwrap_or_default()
        .iter()
        .any(|r| r.fired && !r.dismissed)
}

fn notify_changed(app: &AppHandle) {
    let _ = app.emit("reminders-changed", ());
}

/// Registers a detected reminder, or updates it if one with the same id
/// already exists — see `upsert`. `id` is the source note's stable key
/// (its timestamp, or timestamp+icon if that alone isn't unique — see
/// `src/lib/reminders.ts`'s `reminderId`), so re-scanning the same
/// UNCHANGED note on a later reload is a no-op, and an EDITED note updates
/// its existing reminder in place instead of registering a second one.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn add_reminder(
    app: AppHandle,
    id: String,
    text: String,
    due_ms: i64,
    note_timestamp: String,
) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let all = read_all()?;
    let (all, changed) = upsert(
        all,
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
        notify_changed(&app);
    }
    Ok(())
}

/// Drops a reminder that hasn't fired yet — useInbox.ts's call when a note
/// that previously produced a reminder is edited and no longer parses as
/// one. A reminder that already fired is left alone (see `remove_unfired`);
/// the user dismisses/snoozes it from the banner like any other. Note: a
/// reminder is NEVER cancelled just because its source note leaves the
/// inbox (triaged or deleted) — this command is only called for an edit
/// that changes what the note parses as, never for triage/delete.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn remove_reminder(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let all = read_all()?;
    write_all(&remove_unfired(all, &id))?;
    notify_changed(&app);
    Ok(())
}

/// Undismissed reminders, soonest due first — the banner's (fired ones) and
/// header hint's (upcoming ones) one source of truth.
#[tauri::command]
pub(crate) fn list_reminders() -> Result<Vec<Reminder>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    Ok(undismissed_sorted(read_all()?))
}

#[tauri::command]
pub(crate) fn dismiss_reminder(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let all = read_all()?;
    write_all(&mark_dismissed(all, &id))?;
    drop(_guard);
    crate::audio::refresh_tray_title(&app);
    notify_changed(&app);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn snooze_reminder(app: AppHandle, id: String, minutes: i64) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let all = read_all()?;
    write_all(&apply_snooze(all, &id, minutes, now_ms()))?;
    drop(_guard);
    crate::audio::refresh_tray_title(&app);
    notify_changed(&app);
    Ok(())
}

/// One tick of the background thread spawned from `lib.rs`'s `.setup()`:
/// fires every due-and-unfired reminder, emits `reminder-fired` for each,
/// puts the reminder pill notice up (`audio::show_reminder_notice` — NEVER
/// `window::show_or_focus_window`: a reminder firing must not steal
/// keyboard focus from whatever app the user is typing into, or from a
/// mid-dictation ⌘V paste), and refreshes the tray's `⏰`. Skips writing
/// entirely on a parse failure (logs and returns) rather than treating a
/// corrupt file as empty and overwriting it — see `read_all`.
fn tick(app: &AppHandle) {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let all = match read_all() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("reminders: skipping tick, {e}");
            return;
        }
    };
    let due = due_now(&all, now_ms());
    if due.is_empty() {
        return;
    }
    let mut all = all;
    let mut fired = Vec::with_capacity(due.len());
    for i in due {
        all[i].fired = true;
        fired.push(all[i].clone());
    }
    if write_all(&all).is_err() {
        return;
    }
    drop(_guard);
    for r in &fired {
        let _ = app.emit("reminder-fired", r);
    }
    crate::audio::show_reminder_notice(app);
    crate::audio::refresh_tray_title(app);
    notify_changed(app);
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
    fn parse_reminders_empty_string_is_empty_vec() {
        assert_eq!(parse_reminders("").unwrap(), Vec::new());
        assert_eq!(parse_reminders("   \n").unwrap(), Vec::new());
    }

    #[test]
    fn parse_reminders_rejects_corrupt_nonempty_content() {
        // A truncated/garbled write must surface as an error, not silently
        // read as "no reminders" — the caller must not then write that
        // empty list back and erase what was actually on disk.
        assert!(parse_reminders("{not valid json").is_err());
    }

    #[test]
    fn parse_reminders_round_trips_a_valid_array() {
        let json = serde_json::to_string(&vec![reminder("a", 100, false, false)]).unwrap();
        let parsed = parse_reminders(&json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "a");
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
    fn upsert_skips_an_unchanged_existing_id() {
        let existing = vec![reminder("x", 100, false, false)];
        let (all, changed) = upsert(existing, reminder("x", 100, false, false));
        assert!(!changed);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].due_ms, 100);
    }

    #[test]
    fn upsert_appends_a_new_id() {
        let existing = vec![reminder("x", 100, false, false)];
        let (all, changed) = upsert(existing, reminder("y", 200, false, false));
        assert!(changed);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn upsert_updates_text_without_rearming_when_due_is_unchanged() {
        let mut existing = reminder("x", 100, true, true);
        existing.text = "old text".into();
        let mut updated = reminder("x", 100, false, false);
        updated.text = "new text".into();
        let (all, changed) = upsert(vec![existing], updated);
        assert!(changed);
        assert_eq!(all[0].text, "new text");
        // due_ms unchanged, so fired/dismissed are left as they were.
        assert!(all[0].fired);
        assert!(all[0].dismissed);
    }

    #[test]
    fn upsert_rearms_when_due_changes() {
        let existing = reminder("x", 100, true, true);
        let updated = reminder("x", 200, false, false);
        let (all, changed) = upsert(vec![existing], updated);
        assert!(changed);
        assert_eq!(all[0].due_ms, 200);
        assert!(!all[0].fired);
        assert!(!all[0].dismissed);
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
    fn remove_unfired_drops_the_matching_unfired_entry() {
        let all = remove_unfired(
            vec![
                reminder("a", 1, false, false),
                reminder("b", 2, false, false),
            ],
            "a",
        );
        let ids: Vec<_> = all.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn remove_unfired_leaves_an_already_fired_entry() {
        let all = remove_unfired(vec![reminder("a", 1, true, false)], "a");
        let ids: Vec<_> = all.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
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
