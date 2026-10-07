//! Spoken-list display sidecar: `~/notes/.sideline-lists.json`, a JSON
//! object `{ "<key>": { "starts": [12, 40] | null, "show": true }, ... }`.
//! The key (`<timestamp>|<body hash>`) and the split logic live in the
//! frontend (`src/lib/listFormat.ts`); this module only stores and serves
//! the entries. It never touches a note file — see docs/data-model.md.
//!
//! Same discipline as `reminders.rs`: `LOCK` is held across every
//! read-modify-write, a present-but-corrupt file is an error rather than
//! being read as empty and overwritten, and writes go to a per-call temp
//! file that is renamed into place.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::paths::notes_dir;

/// Held across every read-modify-write below — see the module doc comment.
static LOCK: Mutex<()> = Mutex::new(());

/// Counter mixed into every write's temp file name (with the process id) so
/// two writes never share one.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MAX_KEY_LEN: usize = 200;
const MAX_STARTS: usize = 100;

fn lists_path() -> PathBuf {
    notes_dir().join(".sideline-lists.json")
}

/// Pure parse step, split out so it's testable without the filesystem.
/// Empty/whitespace-only content (a missing file reads as this) is an empty
/// map; anything else must be a JSON object — a truncated or corrupt file
/// is an error so the caller never writes an empty map over real data.
fn parse_lists(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("lists file is corrupt: not a JSON object".into()),
        Err(e) => Err(format!("lists file is corrupt: {e}")),
    }
}

/// Reads the sidecar at `path`. ONLY a missing file (`NotFound`) reads as no
/// entries; any other read error (permissions, an I/O failure, a non-file
/// at the path) is an error, since the caller would otherwise write an empty
/// map over a file it merely failed to read. A present-but-unparseable file
/// is an error too — see `parse_lists`.
fn read_path(path: &std::path::Path) -> Result<Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse_lists(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("lists file is unreadable: {e}")),
    }
}

fn read_all() -> Result<Map<String, Value>, String> {
    read_path(&lists_path())
}

fn write_all(map: &Map<String, Value>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let path = lists_path();
    let parent = path.parent().ok_or("path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(
        ".sideline-lists.json.{}.{n}.tmp",
        std::process::id()
    ));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.chars().count() > MAX_KEY_LEN || key.contains('\n') {
        return Err("bad key".into());
    }
    Ok(())
}

/// Strict shape check: an object with exactly `starts` (null, or at most
/// `MAX_STARTS` ascending u32s) and `show` (bool) — nothing else is stored.
fn validate_entry(entry: &Value) -> Result<(), String> {
    let obj = entry.as_object().ok_or("entry must be an object")?;
    if obj.len() != 2 {
        return Err("entry must have exactly `starts` and `show`".into());
    }
    if !obj.get("show").is_some_and(Value::is_boolean) {
        return Err("`show` must be a boolean".into());
    }
    match obj.get("starts") {
        Some(Value::Null) => Ok(()),
        Some(Value::Array(starts)) => {
            if starts.len() > MAX_STARTS {
                return Err("too many starts".into());
            }
            let mut prev: Option<u32> = None;
            for s in starts {
                let n = s
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or("`starts` must be u32 offsets")?;
                if prev.is_some_and(|p| n <= p) {
                    return Err("`starts` must be ascending".into());
                }
                prev = Some(n);
            }
            Ok(())
        }
        _ => Err("`starts` must be null or an array".into()),
    }
}

/// Inserts, replaces or (entry `None`) removes `key`. With `if_absent`, an
/// insert is a no-op when the key already exists. Returns whether the map
/// actually changed, so an identical re-set skips the write.
fn apply_entry(
    map: &mut Map<String, Value>,
    key: &str,
    entry: Option<Value>,
    if_absent: bool,
) -> bool {
    match entry {
        Some(v) => {
            if if_absent && map.contains_key(key) {
                return false;
            }
            if map.get(key) == Some(&v) {
                return false;
            }
            map.insert(key.to_string(), v);
            true
        }
        None => map.remove(key).is_some(),
    }
}

/// The sidecar as a raw JSON string (`{}` if absent); the frontend parses
/// and validates it. Errors if the file is corrupt.
#[tauri::command]
pub(crate) fn read_lists() -> Result<String, String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = read_all()?;
    serde_json::to_string(&map).map_err(|e| e.to_string())
}

/// Sets (or, with `entry` null, removes) one note's list entry. `if_absent`
/// makes a set a no-op when the key already exists: the auto-formatter's
/// Claude call is slow, and its result must not overwrite what an `l` press
/// stored in the meantime.
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn set_list_entry(
    key: String,
    entry: Option<Value>,
    if_absent: bool,
) -> Result<(), String> {
    validate_key(&key)?;
    if let Some(e) = &entry {
        validate_entry(e)?;
    }
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = read_all()?;
    if apply_entry(&mut map, &key, entry, if_absent) {
        write_all(&map)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_lists_empty_is_empty_map() {
        assert!(parse_lists("").unwrap().is_empty());
        assert!(parse_lists("  \n").unwrap().is_empty());
    }

    #[test]
    fn parse_lists_rejects_corrupt_content() {
        // A garbled file must be an error, not "no entries" — the caller
        // would otherwise write an empty map over whatever was on disk.
        assert!(parse_lists("{not json").is_err());
        assert!(parse_lists("[]").is_err());
        assert!(parse_lists("3").is_err());
    }

    #[test]
    fn parse_lists_reads_an_object() {
        let m = parse_lists(r#"{"a|1":{"starts":[0,5],"show":true}}"#).unwrap();
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn validate_key_rules() {
        assert!(validate_key("2026-01-02 11:00|deadbeef").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("a\nb").is_err());
        assert!(validate_key(&"x".repeat(200)).is_ok());
        assert!(validate_key(&"x".repeat(201)).is_err());
    }

    #[test]
    fn validate_entry_accepts_valid_shapes() {
        assert!(validate_entry(&json!({"starts": [0, 5, 9], "show": true})).is_ok());
        assert!(validate_entry(&json!({"starts": null, "show": false})).is_ok());
        assert!(validate_entry(&json!({"starts": [], "show": false})).is_ok());
    }

    #[test]
    fn validate_entry_rejects_bad_shapes() {
        assert!(validate_entry(&json!("x")).is_err());
        assert!(validate_entry(&json!({"starts": null})).is_err());
        assert!(validate_entry(&json!({"show": true})).is_err());
        assert!(validate_entry(&json!({"starts": null, "show": 1})).is_err());
        assert!(validate_entry(&json!({"starts": null, "show": true, "x": 1})).is_err());
        assert!(validate_entry(&json!({"starts": "a", "show": true})).is_err());
    }

    #[test]
    fn validate_entry_rejects_bad_starts() {
        assert!(validate_entry(&json!({"starts": [5, 5], "show": true})).is_err());
        assert!(validate_entry(&json!({"starts": [5, 2], "show": true})).is_err());
        assert!(validate_entry(&json!({"starts": [-1, 2], "show": true})).is_err());
        assert!(validate_entry(&json!({"starts": [1.5, 2], "show": true})).is_err());
        assert!(validate_entry(&json!({"starts": ["a"], "show": true})).is_err());
        assert!(validate_entry(&json!({"starts": [4294967296u64], "show": true})).is_err());
        assert!(validate_entry(&json!({"starts": [4294967295u64], "show": true})).is_ok());
    }

    #[test]
    fn validate_entry_caps_starts_at_100() {
        let ok: Vec<u32> = (0..100).collect();
        let too_many: Vec<u32> = (0..101).collect();
        assert!(validate_entry(&json!({"starts": ok, "show": true})).is_ok());
        assert!(validate_entry(&json!({"starts": too_many, "show": true})).is_err());
    }

    #[test]
    fn apply_entry_inserts_replaces_and_skips_unchanged() {
        let mut m = Map::new();
        let e = json!({"starts": [0, 5], "show": true});
        assert!(apply_entry(&mut m, "k", Some(e.clone()), false));
        assert!(!apply_entry(&mut m, "k", Some(e), false));
        assert!(apply_entry(
            &mut m,
            "k",
            Some(json!({"starts": [0, 5], "show": false})),
            false
        ));
        assert_eq!(m["k"]["show"], json!(false));
    }

    #[test]
    fn apply_entry_if_absent_never_overwrites_an_existing_key() {
        let mut m = Map::new();
        let mine = json!({"starts": [0, 5], "show": true});
        let auto = json!({"starts": null, "show": false});
        // Absent: the insert goes through.
        assert!(apply_entry(&mut m, "k", Some(mine.clone()), true));
        // Present: a late auto-formatter write is a no-op.
        assert!(!apply_entry(&mut m, "k", Some(auto.clone()), true));
        assert_eq!(m["k"], mine);
        // Without the flag, the same write replaces it.
        assert!(apply_entry(&mut m, "k", Some(auto.clone()), false));
        assert_eq!(m["k"], auto);
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sideline-lists-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_path_missing_file_is_empty_map() {
        let dir = scratch("missing");
        assert!(read_path(&dir.join("nope.json")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_path_reads_a_valid_file() {
        let dir = scratch("valid");
        let f = dir.join("l.json");
        std::fs::write(&f, r#"{"a|1":{"starts":null,"show":false}}"#).unwrap();
        assert_eq!(read_path(&f).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_path_unreadable_is_an_error_not_an_empty_map() {
        // A directory where the file should be: read_to_string fails with a
        // kind other than NotFound, which must NOT read as "no entries" (the
        // caller would write an empty map over it).
        let dir = scratch("unreadable");
        assert!(read_path(&dir).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn apply_entry_none_removes_and_reports_change() {
        let mut m = Map::new();
        m.insert("k".into(), json!({"starts": null, "show": false}));
        assert!(apply_entry(&mut m, "k", None, false));
        assert!(m.is_empty());
        assert!(!apply_entry(&mut m, "k", None, false));
    }
}
