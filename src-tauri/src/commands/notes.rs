//! Tauri commands for reading/writing `~/notes` files: the inbox, archive,
//! triaged notes, todos, and the JSON config.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::paths::{inbox_path, notes_dir, validate_component};

/// Shared body of `read_inbox`/`read_archive`/`read_config`: a missing file
/// reads as an empty string (not an error); any other I/O error is
/// stringified.
fn read_file_or_empty(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Shared body of every full-file write (inbox, archive, config, triaged,
/// todos): create the parent dir if needed, write to a sibling `.tmp`, then
/// rename into place — atomic on APFS, so a crash or power loss mid-write
/// can never leave a notes file empty or truncated (`fs::write` alone is
/// open-truncate-then-write).
pub(crate) fn write_file(path: &Path, content: String) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp_name = path
        .file_name()
        .ok_or("path has no file name")?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = parent.join(tmp_name);
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Error sentinel the frontend matches on to detect a refused stale write.
pub(crate) const INBOX_CONFLICT: &str = "inbox-conflict";

/// Version token for the inbox write guard: a content hash. DefaultHasher
/// is only stable within one process run, which is exactly the lifetime a
/// token lives (frontend holds it between a read and the next write; both
/// hashes are computed here).
fn content_version(content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut h);
    format!("{:x}", h.finish())
}

fn read_with_version(path: &Path) -> Result<(String, String), String> {
    let content = read_file_or_empty(path)?;
    let version = content_version(&content);
    Ok((content, version))
}

/// Compare-and-swap write: refuses (with `INBOX_CONFLICT`) unless the file
/// still hashes to `base_version` — the token the caller got from its last
/// read. This is what makes full-file snapshot writes safe against the
/// appends the frontend hasn't seen yet (in-app voice capture, Raycast):
/// without it, a tag toggle landing in the watcher-debounce window after an
/// append would silently erase the appended note. The check-then-write pair
/// isn't atomic, but it shrinks the race from the ~150-300 ms reload window
/// to microseconds.
fn write_if_version(path: &Path, content: String, base_version: &str) -> Result<String, String> {
    let (current, current_version) = read_with_version(path)?;
    if current_version != base_version {
        let _ = current;
        return Err(INBOX_CONFLICT.to_string());
    }
    let new_version = content_version(&content);
    write_file(path, content)?;
    Ok(new_version)
}

#[tauri::command]
pub(crate) fn read_inbox() -> Result<(String, String), String> {
    read_with_version(&inbox_path())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn write_inbox(content: String, base_version: String) -> Result<String, String> {
    write_if_version(&inbox_path(), content, &base_version)
}

/// Appends a voice-note block in O_APPEND mode (not read-modify-write) so it
/// can never race the frontend's full-file `write_inbox` or the Raycast
/// capture script's own append. Called directly by the native recording
/// pipeline in audio.rs — no `#[tauri::command]` wrapper, since nothing else
/// calls it.
pub(crate) fn append_inbox_text(text: &str) -> Result<(), String> {
    let p = inbox_path();
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| e.to_string())?;
    write!(f, "\n### 🎙️ {now}\n{text}\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn triage_note(filename: String, content: String) -> Result<String, String> {
    validate_component(&filename)?;
    let dir = notes_dir().join("notes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut path = dir.join(&filename);
    // Never clobber: append a counter if the slug already exists.
    let mut n = 1;
    while path.exists() {
        let stem = filename.trim_end_matches(".md");
        path = dir.join(format!("{stem}-{n}.md"));
        n += 1;
    }
    write_file(&path, content)?;
    let final_filename = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(&filename)
        .to_string();
    Ok(final_filename)
}

#[tauri::command]
pub(crate) fn read_archive() -> Result<String, String> {
    read_file_or_empty(&notes_dir().join("archive.md"))
}

#[tauri::command]
pub(crate) fn write_archive(content: String) -> Result<(), String> {
    write_file(&notes_dir().join("archive.md"), content)
}

/// Which part of a listed `.md` file's name becomes its key in
/// `list_md_dir`'s output — see that function.
enum DirKey {
    /// The full file name, e.g. `"my-note.md"` (what `read_triaged` uses).
    Name,
    /// The file stem with the extension dropped, e.g. `"my-project"` (what
    /// `read_todos` uses).
    Stem,
}

/// Shared body of `read_triaged`/`read_todos`: lists every `*.md` file
/// directly inside `dir`, sorted by modified time DESC, keyed per `key`,
/// capped at `limit` entries if `Some`. Missing dir -> empty list, not an
/// error.
fn list_md_dir(
    dir: &Path,
    key: DirKey,
    limit: Option<usize>,
) -> Result<Vec<(String, String)>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((path, modified));
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.1));
    if let Some(limit) = limit {
        entries.truncate(limit);
    }

    let mut out = Vec::with_capacity(entries.len());
    for (path, _) in entries {
        let key_str = match key {
            DirKey::Name => path.file_name().and_then(|f| f.to_str()),
            DirKey::Stem => path.file_stem().and_then(|f| f.to_str()),
        };
        let Some(key_str) = key_str else {
            continue;
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        out.push((key_str.to_string(), content));
    }
    Ok(out)
}

/// Lists ~/notes/notes/*.md sorted by modified time DESC, capped at 200
/// entries, for the sections view. Missing dir -> empty list, not an error.
#[tauri::command]
pub(crate) fn read_triaged() -> Result<Vec<(String, String)>, String> {
    list_md_dir(&notes_dir().join("notes"), DirKey::Name, Some(200))
}

/// Removes `~/notes/notes/<filename>` outright via fs::remove_file — used
/// after the note's content has been preserved elsewhere (archive.md, or
/// the inbox on triage-undo). Deliberately NOT the `trash` crate: on macOS
/// that goes through Finder automation and triggers a TCC prompt, which
/// this app must never do.
#[tauri::command]
pub(crate) fn delete_triaged(filename: String) -> Result<(), String> {
    validate_component(&filename)?;
    let p = notes_dir().join("notes").join(&filename);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn read_config() -> Result<String, String> {
    read_file_or_empty(&notes_dir().join(".sideline.json"))
}

#[tauri::command]
pub(crate) fn write_config(content: String) -> Result<(), String> {
    write_file(&notes_dir().join(".sideline.json"), content)
}

/// All `~/notes/todos/*.md` files as (project, content) pairs — project is
/// the file stem — sorted by modified time DESC, for the Todos view.
/// Missing dir -> empty list, not an error. Deliberately uncapped, unlike
/// `read_triaged`'s 200-entry limit: a `todos/<project>.md` file is the
/// only record of its routed notes, so nothing here may be silently
/// dropped.
#[tauri::command]
pub(crate) fn read_todos() -> Result<Vec<(String, String)>, String> {
    list_md_dir(&notes_dir().join("todos"), DirKey::Stem, None)
}

#[tauri::command]
pub(crate) fn write_todos(project: String, content: String) -> Result<(), String> {
    validate_component(&project)?;
    let dir = notes_dir().join("todos");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(format!("{project}.md"));
    write_file(&p, content)
}

/// Overwrites an existing `~/notes/notes/<filename>` in place — used for the
/// Library view's done-status flip. Unlike `triage_note` this never
/// collision-suffixes; it's an error if the file doesn't already exist.
#[tauri::command]
pub(crate) fn write_triaged(filename: String, content: String) -> Result<(), String> {
    validate_component(&filename)?;
    let p = notes_dir().join("notes").join(&filename);
    if !p.exists() {
        return Err("file does not exist".into());
    }
    write_file(&p, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// A fresh, unique scratch dir under `std::env::temp_dir()`, removed on
    /// drop. Never touches the real `~/notes`.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "sideline-notes-test-{label}-{}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Writes `name` under `dir` with `content` and backdates its mtime by
    /// `age_secs`, so ordering assertions don't depend on filesystem mtime
    /// resolution or write-loop timing.
    fn write_with_age(dir: &Path, name: &str, content: &str, age_secs: u64) {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        let mtime = SystemTime::now() - Duration::from_secs(age_secs);
        let f = fs::File::open(&path).unwrap();
        f.set_modified(mtime).unwrap();
    }

    // --- versioned inbox writes ------------------------------------------

    #[test]
    fn version_of_missing_file_matches_empty_content() {
        let dir = TempDir::new("ver-missing");
        let p = dir.path().join("inbox.md");
        assert_eq!(read_with_version(&p).unwrap().1, content_version(""));
    }

    #[test]
    fn write_with_current_version_succeeds_and_returns_new_version() {
        let dir = TempDir::new("ver-ok");
        let p = dir.path().join("inbox.md");
        fs::write(&p, "old").unwrap();
        let (_, ver) = read_with_version(&p).unwrap();
        let new_ver = write_if_version(&p, "new".to_string(), &ver).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        assert_eq!(new_ver, content_version("new"));
    }

    #[test]
    fn write_with_stale_version_conflicts_and_preserves_file() {
        // The file gained an appended entry after the caller's last read —
        // the write must be refused, not clobber the append.
        let dir = TempDir::new("ver-stale");
        let p = dir.path().join("inbox.md");
        fs::write(&p, "old").unwrap();
        let (_, ver) = read_with_version(&p).unwrap();
        fs::write(&p, "old\n### appended").unwrap();
        let err = write_if_version(&p, "new".to_string(), &ver).unwrap_err();
        assert_eq!(err, INBOX_CONFLICT);
        assert_eq!(fs::read_to_string(&p).unwrap(), "old\n### appended");
    }

    #[test]
    fn write_against_missing_file_with_empty_version_succeeds() {
        // First write ever: baseline is the empty-content version.
        let dir = TempDir::new("ver-first");
        let p = dir.path().join("inbox.md");
        let ver = content_version("");
        write_if_version(&p, "first".to_string(), &ver).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "first");
    }

    #[test]
    fn list_md_dir_missing_dir_is_empty_not_error() {
        let missing = std::env::temp_dir().join("sideline-notes-test-does-not-exist");
        let result = list_md_dir(&missing, DirKey::Name, None);
        assert_eq!(result.unwrap(), Vec::new());
    }

    #[test]
    fn list_md_dir_filters_to_md_extension_only() {
        let dir = TempDir::new("filter");
        write_with_age(dir.path(), "a.md", "a", 0);
        write_with_age(dir.path(), "b.txt", "b", 0);
        write_with_age(dir.path(), "c.mdx", "c", 0);

        let result = list_md_dir(dir.path(), DirKey::Name, None).unwrap();
        assert_eq!(result, vec![("a.md".to_string(), "a".to_string())]);
    }

    #[test]
    fn list_md_dir_sorts_by_modified_time_descending() {
        let dir = TempDir::new("order");
        write_with_age(dir.path(), "oldest.md", "1", 30);
        write_with_age(dir.path(), "newest.md", "2", 0);
        write_with_age(dir.path(), "middle.md", "3", 15);

        let result = list_md_dir(dir.path(), DirKey::Name, None).unwrap();
        let names: Vec<_> = result.into_iter().map(|(k, _)| k).collect();
        assert_eq!(names, vec!["newest.md", "middle.md", "oldest.md"]);
    }

    #[test]
    fn list_md_dir_name_key_keeps_extension() {
        let dir = TempDir::new("name-key");
        write_with_age(dir.path(), "project.md", "x", 0);

        let result = list_md_dir(dir.path(), DirKey::Name, None).unwrap();
        assert_eq!(result, vec![("project.md".to_string(), "x".to_string())]);
    }

    #[test]
    fn list_md_dir_stem_key_drops_extension() {
        let dir = TempDir::new("stem-key");
        write_with_age(dir.path(), "project.md", "x", 0);

        let result = list_md_dir(dir.path(), DirKey::Stem, None).unwrap();
        assert_eq!(result, vec![("project".to_string(), "x".to_string())]);
    }

    #[test]
    fn list_md_dir_limit_some_truncates_to_most_recent() {
        let dir = TempDir::new("limit-some");
        write_with_age(dir.path(), "a.md", "a", 2);
        write_with_age(dir.path(), "b.md", "b", 1);
        write_with_age(dir.path(), "c.md", "c", 0);

        let result = list_md_dir(dir.path(), DirKey::Name, Some(2)).unwrap();
        let names: Vec<_> = result.into_iter().map(|(k, _)| k).collect();
        assert_eq!(names, vec!["c.md", "b.md"]);
    }

    #[test]
    fn list_md_dir_limit_none_keeps_all() {
        let dir = TempDir::new("limit-none");
        for i in 0..5u64 {
            write_with_age(dir.path(), &format!("{i}.md"), "x", i);
        }

        let result = list_md_dir(dir.path(), DirKey::Name, None).unwrap();
        assert_eq!(result.len(), 5);
    }
}
