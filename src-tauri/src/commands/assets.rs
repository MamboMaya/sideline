//! Tauri commands for `~/notes/inbox-assets/`: saving a clipboard image as a
//! PNG (⌘V on a card / in the edit textarea), and reading/opening an
//! existing asset for the cards' thumbnails.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypePNG,
    NSPasteboardTypeTIFF,
};
use objc2_foundation::{NSData, NSDictionary};

use crate::paths::{confine, notes_dir};

const ASSETS_DIR: &str = "inbox-assets";

/// Error sentinel the frontend matches on: the clipboard holds no image.
/// Not a failure worth a toast when the paste came from the edit textarea
/// (an ordinary text paste takes this path too).
const NO_IMAGE: &str = "no-image";

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Generous for a Retina full-screen capture (~10 MB); refuses anything
/// absurd rather than filling `~/notes`.
const MAX_IMAGE_BYTES: usize = 40 * 1024 * 1024;

/// PNG bytes of the image on the general pasteboard, if any. A macOS
/// screenshot-to-clipboard (⌃⇧⌘4) carries `public.png` directly; an image
/// copied out of Preview or a browser is often TIFF-only, so that is
/// re-encoded through NSBitmapImageRep.
fn clipboard_png() -> Option<Vec<u8>> {
    let pasteboard = NSPasteboard::generalPasteboard();
    // SAFETY: the pasteboard type statics are valid for the process lifetime.
    if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
        return Some(data.to_vec());
    }
    let tiff: Retained<NSData> = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF })?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    // SAFETY: an empty properties dictionary is valid for every file type.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

/// Writes `bytes` as `<dir>/shot-<stamp>.png`, never clobbering: a second
/// paste within the same second gets `-1`, `-2`, … (`create_new` makes the
/// existence check and the create one atomic step). Returns the file name.
fn save_png(dir: &Path, bytes: &[u8], stamp: &str) -> Result<String, String> {
    if !bytes.starts_with(PNG_MAGIC) {
        return Err("not a PNG image".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image too large".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for n in 0..100 {
        let name = if n == 0 {
            format!("shot-{stamp}.png")
        } else {
            format!("shot-{stamp}-{n}.png")
        };
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(&name))
        {
            Ok(mut f) => {
                f.write_all(bytes).map_err(|e| e.to_string())?;
                return Ok(name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("too many screenshots this second".into())
}

/// Saves the clipboard's image into `~/notes/inbox-assets/` and returns its
/// notes-relative ref (`inbox-assets/shot-....png`) — the frontend embeds
/// it in a note body as `![screenshot](<ref>)` (docs/data-model.md). Errors
/// with `NO_IMAGE` when the clipboard holds no image.
#[tauri::command]
pub(crate) fn paste_clipboard_image() -> Result<String, String> {
    let bytes = clipboard_png().ok_or(NO_IMAGE)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let name = save_png(&notes_dir().join(ASSETS_DIR), &bytes, &stamp)?;
    Ok(format!("{ASSETS_DIR}/{name}"))
}

/// Resolves a note-body asset ref to an existing file. Refs come out of
/// user-editable markdown, so beyond `confine` (no traversal, no symlink
/// escape from `~/notes`) the ref must sit under `inbox-assets/` — this is
/// never a way to read an arbitrary notes file.
fn asset_path(rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if !rel.starts_with(ASSETS_DIR) {
        return Err("not an asset ref".into());
    }
    let path = confine(rel)?;
    if !path.is_file() {
        return Err("asset not found".into());
    }
    Ok(path)
}

/// Raw bytes of one asset, for the cards' thumbnails (the frontend wraps
/// them in a blob: URL — see `src/lib/assets.ts`).
#[tauri::command]
pub(crate) fn read_asset(rel: String) -> Result<tauri::ipc::Response, String> {
    let path = asset_path(&rel)?;
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Thumbnail click: open the full-size image in the default app (Preview).
#[tauri::command]
pub(crate) fn open_asset(rel: String) -> Result<(), String> {
    let path = asset_path(&rel)?;
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "sideline-assets-test-{label}-{}-{n}",
            std::process::id()
        ))
    }

    fn png(payload: &[u8]) -> Vec<u8> {
        [PNG_MAGIC, payload].concat()
    }

    #[test]
    fn save_png_writes_and_names_by_stamp() {
        let dir = temp_dir("write");
        let name = save_png(&dir, &png(b"a"), "20260919-101500").unwrap();
        assert_eq!(name, "shot-20260919-101500.png");
        assert_eq!(fs::read(dir.join(&name)).unwrap(), png(b"a"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_png_never_clobbers_same_second() {
        let dir = temp_dir("collide");
        let first = save_png(&dir, &png(b"a"), "20260919-101500").unwrap();
        let second = save_png(&dir, &png(b"b"), "20260919-101500").unwrap();
        assert_eq!(second, "shot-20260919-101500-1.png");
        assert_eq!(fs::read(dir.join(&first)).unwrap(), png(b"a"));
        assert_eq!(fs::read(dir.join(&second)).unwrap(), png(b"b"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_png_rejects_non_png() {
        let dir = temp_dir("non-png");
        assert!(save_png(&dir, b"GIF89a...", "20260919-101500").is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn asset_path_rejects_refs_outside_inbox_assets() {
        assert!(asset_path("inbox.md").is_err());
        assert!(asset_path("todos/sideline.md").is_err());
        assert!(asset_path("inbox-assets/../inbox.md").is_err());
        assert!(asset_path("/etc/passwd").is_err());
        // Path::starts_with is component-wise: a sibling dir sharing the
        // prefix is not under inbox-assets/.
        assert!(asset_path("inbox-assets-evil/x.png").is_err());
    }
}
