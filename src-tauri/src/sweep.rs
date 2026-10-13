//! Done-todo sweep: moves `✅` entries a week past completion out of
//! `~/notes/todos/<project>.md` into `~/notes/todos/done/<project>.md`, and
//! stores when each done entry was first seen in `~/notes/.sideline-done.json`
//! (`{ "<key>": "YYYY-MM-DD", ... }`). Which entries move, and the keys, are
//! decided in the frontend (`src/lib/sweep.ts`) — all todo-format knowledge
//! stays in `src/inbox.ts`. This module only stores the dates and performs a
//! move as a compare-and-swap, so an agent's edit that lands between the
//! frontend's read and this write is never overwritten.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::commands::notes::write_file;
use crate::paths::{notes_dir, validate_component};

/// Held across every sidecar write and every move.
static LOCK: Mutex<()> = Mutex::new(());

const MAX_KEY_LEN: usize = 300;
const MAX_KEYS: usize = 20_000;

fn dates_path() -> PathBuf {
    notes_dir().join(".sideline-done.json")
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// Strict shape check: a JSON object of at most `MAX_KEYS` short keys, each
/// mapped to a `YYYY-MM-DD` string — nothing else is stored.
fn validate_dates(raw: &str) -> Result<Map<String, Value>, String> {
    let Value::Object(map) = serde_json::from_str::<Value>(raw).map_err(|e| e.to_string())? else {
        return Err("done dates must be a JSON object".into());
    };
    if map.len() > MAX_KEYS {
        return Err("too many done dates".into());
    }
    for (k, v) in &map {
        if k.is_empty() || k.chars().count() > MAX_KEY_LEN || k.contains('\n') {
            return Err("bad key".into());
        }
        if !v.as_str().is_some_and(is_day) {
            return Err("dates must be YYYY-MM-DD strings".into());
        }
    }
    Ok(map)
}

/// The sidecar as raw JSON (`{}` if absent). A present-but-corrupt file is
/// an error, so the frontend never writes fresh dates over it.
#[tauri::command]
pub(crate) fn read_done_dates() -> Result<String, String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    match fs::read_to_string(dates_path()) {
        Ok(raw) if raw.trim().is_empty() => Ok("{}".into()),
        Ok(raw) => validate_dates(&raw).map(|_| raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(format!("done dates file is unreadable: {e}")),
    }
}

#[tauri::command]
pub(crate) fn write_done_dates(content: String) -> Result<(), String> {
    let map = validate_dates(&content)?;
    let json = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    write_file(&dates_path(), json)
}

/// Joins `done` onto the end of `existing` with exactly one blank line
/// between entries.
fn append_block(existing: &str, done: &str) -> String {
    let sep = if existing.is_empty() || existing.ends_with("\n\n") {
        ""
    } else if existing.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    format!("{existing}{sep}{done}")
}

/// Writes `content` to a temp file beside `path`, for a later rename.
fn stage(path: &Path, content: &str) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut name = path
        .file_name()
        .ok_or("path has no file name")?
        .to_os_string();
    name.push(".sweep.tmp");
    let tmp = parent.join(name);
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    Ok(tmp)
}

/// The move itself, against an explicit `todos` dir so tests never touch
/// `~/notes`. Returns false (and writes nothing) when the live file no
/// longer holds exactly `expected`. Both new files are staged BEFORE the
/// compare, so only two renames follow it — an outside edit can't slip into
/// a slow write. The done file is renamed first: a failure between the two
/// renames leaves a duplicate, never a lost entry.
fn sweep_in(
    todos: &Path,
    project: &str,
    expected: &str,
    live: String,
    done: &str,
) -> Result<bool, String> {
    validate_component(project)?;
    let live_path = todos.join(format!("{project}.md"));
    let done_path = todos.join("done").join(format!("{project}.md"));
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let existing = match fs::read_to_string(&done_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    let done_tmp = stage(&done_path, &append_block(&existing, done))?;
    let live_tmp = match stage(&live_path, &live) {
        Ok(t) => t,
        Err(e) => {
            let _ = fs::remove_file(&done_tmp);
            return Err(e);
        }
    };
    let unchanged = matches!(fs::read_to_string(&live_path), Ok(current) if current == expected);
    if !unchanged {
        let _ = fs::remove_file(&done_tmp);
        let _ = fs::remove_file(&live_tmp);
        return Ok(false);
    }
    fs::rename(&done_tmp, &done_path).map_err(|e| e.to_string())?;
    fs::rename(&live_tmp, &live_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Moves swept entries: appends `done` to `todos/done/<project>.md`, then
/// replaces `todos/<project>.md` with `live` — only if that file still
/// reads exactly `expected`. Returns whether the move happened.
#[tauri::command]
pub(crate) fn sweep_todos(
    project: String,
    expected: String,
    live: String,
    done: String,
) -> Result<bool, String> {
    sweep_in(&notes_dir().join("todos"), &project, &expected, live, &done)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "sideline-sweep-test-{label}-{}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn validate_dates_accepts_day_strings_only() {
        assert!(validate_dates(r#"{"a::1": "2026-10-13"}"#).is_ok());
        assert!(validate_dates(r#"{"a": "2026-10-13 09:00"}"#).is_err());
        assert!(validate_dates(r#"{"a": 5}"#).is_err());
        assert!(validate_dates(r#"["2026-10-13"]"#).is_err());
        assert!(validate_dates(r#"{"": "2026-10-13"}"#).is_err());
    }

    #[test]
    fn append_block_keeps_one_blank_line() {
        assert_eq!(append_block("", "### ✅ b\n"), "### ✅ b\n");
        assert_eq!(
            append_block("### ✅ a\n", "### ✅ b\n"),
            "### ✅ a\n\n### ✅ b\n"
        );
        assert_eq!(
            append_block("### ✅ a", "### ✅ b\n"),
            "### ✅ a\n\n### ✅ b\n"
        );
        assert_eq!(
            append_block("### ✅ a\n\n", "### ✅ b\n"),
            "### ✅ a\n\n### ✅ b\n"
        );
    }

    #[test]
    fn sweep_moves_when_unchanged() {
        let t = TempDir::new("move");
        fs::write(t.0.join("demo.md"), "old").unwrap();
        fs::create_dir_all(t.0.join("done")).unwrap();
        fs::write(t.0.join("done").join("demo.md"), "### ✅ a\n").unwrap();
        assert!(sweep_in(&t.0, "demo", "old", "### ⬜ c\n".into(), "### ✅ b\n").unwrap());
        assert_eq!(
            fs::read_to_string(t.0.join("demo.md")).unwrap(),
            "### ⬜ c\n"
        );
        assert_eq!(
            fs::read_to_string(t.0.join("done").join("demo.md")).unwrap(),
            "### ✅ a\n\n### ✅ b\n"
        );
    }

    #[test]
    fn sweep_refuses_a_changed_file() {
        let t = TempDir::new("cas");
        fs::write(t.0.join("demo.md"), "edited by an agent").unwrap();
        assert!(!sweep_in(&t.0, "demo", "old", "new".into(), "### ✅ b\n").unwrap());
        assert_eq!(
            fs::read_to_string(t.0.join("demo.md")).unwrap(),
            "edited by an agent"
        );
        assert!(!t.0.join("done").join("demo.md").exists());
        assert!(!t.0.join("done").join("demo.md.sweep.tmp").exists());
        assert!(!t.0.join("demo.md.sweep.tmp").exists());
    }

    #[test]
    fn sweep_rejects_escaping_project_names() {
        let t = TempDir::new("escape");
        assert!(sweep_in(&t.0, "../x", "", String::new(), "").is_err());
    }
}
