//! Path helpers that confine all notes I/O to `~/notes`.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

static NOTES_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolves `~/notes`, computing it once per process (the app can't run
/// without a home dir, so the panic is unavoidable — it now happens at most
/// once instead of on every call site).
pub(crate) fn notes_dir() -> PathBuf {
    NOTES_DIR
        .get_or_init(|| dirs::home_dir().expect("no home dir").join("notes"))
        .clone()
}

pub(crate) fn inbox_path() -> PathBuf {
    notes_dir().join("inbox.md")
}

/// Reject any project/filename component that could escape its fixed parent
/// dir under notes_dir() (path separator, traversal, or empty). Every path
/// built from a validated component is confined to ~/notes with no
/// exceptions — see CLAUDE.md's Conventions section. Deliberately no
/// canonicalization here: `base.join(validated_component)` is safe by
/// construction, so this stays a cheap string check.
pub(crate) fn validate_component(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return Err("bad name".into());
    }
    Ok(())
}

/// Confine a multi-component RELATIVE path — the shape of an
/// `inbox-assets/...` ref scraped out of archive.md, which is user-editable
/// text and the one place attacker-ish input exists — to `notes_dir()`. Thin
/// wrapper around `confine_within`; see it for the algorithm.
pub(crate) fn confine(rel: &Path) -> Result<PathBuf, String> {
    confine_within(&notes_dir(), rel)
}

/// Confine `rel` to `base`. `rel` must be relative and every component must
/// be `Component::Normal` (this rejects `..`, `.`, and any root/prefix
/// component, and also rejects an empty path, which parses to zero
/// components). If the joined path DOES exist, both it and `base` are
/// canonicalized and the former must start with the latter; this defeats a
/// symlink planted at an intermediate directory, and also handles `base`
/// itself being a symlink (canonicalizing both sides before comparing).
/// This is conservative: a confined file that is itself a symlink pointing
/// outside `base` is rejected too, since canonicalize() resolves it before
/// the starts_with check.
///
/// If the joined path does NOT exist, it is returned as-is: it is
/// lexically under `base`, but NOT symlink-checked. A symlink at an
/// intermediate component (or a dangling final symlink) could still
/// resolve outside `base` once something is written through it — so a
/// caller MUST NOT write through a result this fn hasn't confirmed exists.
/// The only caller today, `purge_archive`, only ever reads/moves paths it
/// has separately filtered with `.is_file()`, which is always false for
/// anything out of this branch — deeper hardening (canonicalizing the
/// deepest existing ancestor so even the non-existent case is
/// symlink-checked) is deliberately deferred, not needed by that caller.
fn confine_within(base: &Path, rel: &Path) -> Result<PathBuf, String> {
    if rel.as_os_str().is_empty() {
        return Err("empty path refused".into());
    }
    if rel.is_absolute() {
        return Err("absolute path refused".into());
    }
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("path outside base refused".into());
    }

    let joined = base.join(rel);
    if !joined.exists() {
        return Ok(joined);
    }

    let canon_joined = joined.canonicalize().map_err(|e| e.to_string())?;
    let canon_base = base.canonicalize().map_err(|e| e.to_string())?;
    if canon_joined.starts_with(&canon_base) {
        Ok(canon_joined)
    } else {
        Err("path outside base refused".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A path under `std::env::temp_dir()` unique to this test process and
    /// call (pid + monotonic counter — tests run in parallel, so a plain
    /// timestamp risks collisions), not yet created on disk.
    fn unique_temp_path(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "sideline-paths-test-{label}-{}-{n}",
            std::process::id()
        ))
    }

    /// A fresh, unique scratch dir under `std::env::temp_dir()`, removed on
    /// drop. Never touches the real `~/notes`.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = unique_temp_path(label);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // --- confine_within -----------------------------------------------

    #[test]
    fn confine_within_rejects_traversal() {
        let base = TempDir::new("traversal");
        assert!(confine_within(base.path(), Path::new("../escape")).is_err());
        assert!(confine_within(base.path(), Path::new("a/../../escape")).is_err());
    }

    #[test]
    fn confine_within_rejects_absolute_path() {
        let base = TempDir::new("absolute");
        assert!(confine_within(base.path(), Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn confine_within_rejects_empty_path() {
        let base = TempDir::new("empty");
        assert!(confine_within(base.path(), Path::new("")).is_err());
    }

    #[test]
    fn confine_within_accepts_normal_nested_path_that_exists() {
        let base = TempDir::new("nested-exists");
        std::fs::create_dir_all(base.path().join("sub")).unwrap();
        std::fs::write(base.path().join("sub/file.txt"), b"hi").unwrap();

        let result = confine_within(base.path(), Path::new("sub/file.txt"));
        assert!(result.is_ok());
        let expected = base.path().join("sub/file.txt").canonicalize().unwrap();
        assert_eq!(result.unwrap(), expected);
    }

    #[test]
    fn confine_within_accepts_normal_nested_path_that_does_not_exist() {
        let base = TempDir::new("nested-missing");
        std::fs::create_dir_all(base.path().join("sub")).unwrap();

        let result = confine_within(base.path(), Path::new("sub/newfile.txt"));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), base.path().join("sub/newfile.txt"));
    }

    #[test]
    fn confine_within_rejects_symlinked_intermediate_dir_escape() {
        let base = TempDir::new("symlink-dir-base");
        let outside = TempDir::new("symlink-dir-outside");
        std::fs::write(outside.path().join("f.txt"), b"secret").unwrap();
        symlink(outside.path(), base.path().join("link")).unwrap();

        let result = confine_within(base.path(), Path::new("link/f.txt"));
        assert!(result.is_err());
    }

    #[test]
    fn confine_within_rejects_direct_file_symlink_escape() {
        let base = TempDir::new("symlink-file-base");
        let outside = TempDir::new("symlink-file-outside");
        std::fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            base.path().join("link.txt"),
        )
        .unwrap();

        let result = confine_within(base.path(), Path::new("link.txt"));
        assert!(result.is_err());
    }

    #[test]
    fn confine_within_accepts_when_base_itself_is_a_symlink() {
        let real_base = TempDir::new("base-symlink-real");
        std::fs::create_dir_all(real_base.path().join("sub")).unwrap();
        std::fs::write(real_base.path().join("sub/file.txt"), b"hi").unwrap();

        let base_link = unique_temp_path("base-symlink-link");
        symlink(real_base.path(), &base_link).unwrap();

        let result = confine_within(&base_link, Path::new("sub/file.txt"));
        assert!(result.is_ok());
        let expected = real_base
            .path()
            .join("sub/file.txt")
            .canonicalize()
            .unwrap();
        assert_eq!(result.unwrap(), expected);

        let _ = std::fs::remove_file(&base_link);
    }

    // --- validate_component ---------------------------------------------

    #[test]
    fn validate_component_rejects_empty() {
        assert!(validate_component("").is_err());
    }

    #[test]
    fn validate_component_rejects_traversal() {
        assert!(validate_component("..").is_err());
    }

    #[test]
    fn validate_component_rejects_path_separator() {
        assert!(validate_component("a/b").is_err());
    }

    #[test]
    fn validate_component_accepts_plain_name() {
        assert!(validate_component("my-project").is_ok());
    }
}
