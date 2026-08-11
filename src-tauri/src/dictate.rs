//! Dictation mode's finish-side handoff: clipboard write + synthetic ⌘V
//! auto-paste into the frontmost app, gated on the macOS Accessibility (AX)
//! permission. This is the ONE deliberate exception to CLAUDE.md's
//! mic-only TCC rule — discussed and approved 2026-08-11 (see CLAUDE.md,
//! docs/backend.md). Never touches inbox.md or any `~/notes` file: the
//! clipboard is the whole destination for dictated text.

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

// ApplicationServices (HIServices) — not wrapped by any crate already in
// the dependency tree, so declared by hand per the spec: a trust check that
// never prompts, and the `WithOptions` variant that does (guarded by the
// `kAXTrustedCheckOptionPrompt` dictionary key). No new Info.plist key is
// needed for Accessibility — unlike the mic, macOS gates it entirely
// through this API + the System Settings > Privacy & Security >
// Accessibility list.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CFStringRef;
    fn AXIsProcessTrusted() -> core_foundation::base::Boolean;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> core_foundation::base::Boolean;
}

/// True if Sideline currently holds the Accessibility permission. Never
/// prompts — safe to call on every dictation stop.
fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Triggers the one-time system Accessibility dialog (a no-op if already
/// trusted, or if the user dismissed it earlier this run — macOS itself
/// debounces repeat prompts).
fn prompt_for_trust() {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let opts = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef());
    }
}

/// Posts a synthetic ⌘V (key down + key up, keycode 9 = kVK_ANSI_V, Command
/// flag set) through the HID event tap — the same tap real keyboard
/// hardware posts into, so it lands on whatever app is currently
/// frontmost. Requires AX trust; posting without it is simply a no-op from
/// the OS's point of view, which is why callers must check `is_trusted`
/// first rather than relying on this to fail loudly.
fn post_cmd_v() -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "failed to create event source".to_string())?;
    let down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
        .map_err(|_| "failed to create key-down event".to_string())?;
    down.set_flags(CGEventFlags::CGEventFlagCommand);
    down.post(CGEventTapLocation::HID);
    let up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
        .map_err(|_| "failed to create key-up event".to_string())?;
    up.set_flags(CGEventFlags::CGEventFlagCommand);
    up.post(CGEventTapLocation::HID);
    Ok(())
}

/// Dictation-mode finish: clipboard write ALWAYS happens first — even if
/// everything after it fails, the transcript is never lost — then, only if
/// Sideline is AX-trusted, a ~50ms settle delay and a synthetic ⌘V. If not
/// trusted, triggers the one-time system prompt instead of pasting and
/// tells the user the text is on the clipboard for a manual ⌘V. Called from
/// `audio::finish_recording`, off the async runtime (inside
/// `spawn_blocking`), so the blocking sleep here is fine.
pub(crate) fn finish_dictation(app: &AppHandle, text: &str) {
    if let Err(e) = app.clipboard().write_text(text.to_string()) {
        let _ = app.emit("capture-error", format!("Clipboard write failed: {e}"));
        return;
    }

    if is_trusted() {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if let Err(e) = post_cmd_v() {
            let _ = app.emit(
                "capture-error",
                format!("Copied to clipboard — auto-paste failed: {e}"),
            );
        }
    } else {
        prompt_for_trust();
        let _ = app.emit(
            "capture-error",
            "Copied to clipboard — grant Accessibility (System Settings) to auto-paste",
        );
    }
}
