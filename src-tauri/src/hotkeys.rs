//! Global-hotkey configuration: hardcoded defaults, `.sideline.json` combo
//! parsing/normalization, and registration with graceful fallback.

use std::fs;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::paths::notes_dir;

pub(crate) fn default_toggle_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::Space)
}

pub(crate) fn default_record_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyR)
}

pub(crate) fn default_dictate_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyV)
}

/// Normalizes a human-friendly hotkey combo (e.g. `"opt+cmd+v"`) into the
/// `"alt+super+KeyV"` form `Shortcut::from_str` expects. Modifier tokens are
/// matched case-insensitively via aliases; the one remaining token is the
/// key — a bare letter/digit/`space` maps to its W3C `Code` name, anything
/// else (e.g. `F5`, `Comma`, `KeyV`) passes through unchanged. Returns None
/// for malformed input (no key token, or more than one).
pub(crate) fn normalize_combo(raw: &str) -> Option<String> {
    let mut mods: Vec<&'static str> = Vec::new();
    let mut key: Option<String> = None;
    for tok in raw.split('+') {
        let tok = tok.trim();
        if tok.is_empty() {
            return None;
        }
        match tok.to_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" => mods.push("super"),
            "opt" | "option" | "alt" => mods.push("alt"),
            "ctrl" | "control" => mods.push("ctrl"),
            "shift" => mods.push("shift"),
            lower => {
                if key.is_some() {
                    return None;
                }
                key = Some(if lower.chars().count() == 1 {
                    let c = lower.chars().next().unwrap();
                    if c.is_ascii_alphabetic() {
                        format!("Key{}", c.to_ascii_uppercase())
                    } else if c.is_ascii_digit() {
                        format!("Digit{c}")
                    } else {
                        tok.to_string()
                    }
                } else if lower == "space" {
                    "Space".to_string()
                } else {
                    tok.to_string()
                });
            }
        }
    }
    let mut parts: Vec<String> = mods.into_iter().map(String::from).collect();
    parts.push(key?);
    Some(parts.join("+"))
}

/// Parses one `hotkeys.<label>` entry from `.sideline.json`; a missing key,
/// unparseable combo, or `Shortcut::from_str` failure all fall back to
/// `default` (with an eprintln! for the latter two — a typo must never cost
/// the app its hotkeys).
pub(crate) fn parse_hotkey_or_default(
    raw: Option<&str>,
    label: &str,
    default: Shortcut,
) -> Shortcut {
    let Some(raw) = raw else {
        return default;
    };
    let Some(normalized) = normalize_combo(raw) else {
        eprintln!("invalid hotkeys.{label} combo {raw:?} in .sideline.json; using default");
        return default;
    };
    match Shortcut::from_str(&normalized) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "invalid hotkeys.{label} combo {raw:?} in .sideline.json ({e}); using default"
            );
            default
        }
    }
}

/// Reads `hotkeys.toggle` / `hotkeys.record` / `hotkeys.dictate` from
/// `.sideline.json`. Fully failure-tolerant: missing file, malformed JSON,
/// and a missing/invalid key each just fall back to the hardcoded default
/// (current ⌥⌘Space / ⌥⌘R / ⌥⌘V behavior). Changing this file requires an
/// app restart to take effect.
pub(crate) fn load_hotkeys() -> (Shortcut, Shortcut, Shortcut) {
    let raw = fs::read_to_string(notes_dir().join(".sideline.json")).unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let hotkeys = parsed.get("hotkeys");
    let toggle_raw = hotkeys
        .and_then(|h| h.get("toggle"))
        .and_then(|v| v.as_str());
    let record_raw = hotkeys
        .and_then(|h| h.get("record"))
        .and_then(|v| v.as_str());
    let dictate_raw = hotkeys
        .and_then(|h| h.get("dictate"))
        .and_then(|v| v.as_str());
    (
        parse_hotkey_or_default(toggle_raw, "toggle", default_toggle_shortcut()),
        parse_hotkey_or_default(record_raw, "record", default_record_shortcut()),
        parse_hotkey_or_default(dictate_raw, "dictate", default_dictate_shortcut()),
    )
}

/// The three hotkeys' live-registered state, managed via
/// `app.manage(ActiveShortcuts { .. })` in lib.rs — the same three
/// `Arc<Mutex<Shortcut>>` the global-shortcut handler compares against,
/// bundled so `apply_hotkeys` (below) can reach all three through one
/// `tauri::State`.
pub struct ActiveShortcuts {
    pub toggle: Arc<Mutex<Shortcut>>,
    pub record: Arc<Mutex<Shortcut>>,
    pub dictate: Arc<Mutex<Shortcut>>,
}

/// One key's outcome from `apply_hotkeys`: `ok: true` means the combo (or
/// the default, if blank/omitted) is now the live-registered shortcut for
/// that key; `ok: false` means the PREVIOUS shortcut is still registered
/// (see `apply_one`) and `error` explains why the new one wasn't — invalid
/// combo syntax or an OS-level registration conflict.
#[derive(serde::Serialize)]
pub struct HotkeyApplyResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// `apply_hotkeys`'s full return value — one result per key, frontend-toasted
/// per failing key.
#[derive(serde::Serialize)]
pub struct ApplyHotkeysResponse {
    pub toggle: HotkeyApplyResult,
    pub record: HotkeyApplyResult,
    pub dictate: HotkeyApplyResult,
}

/// Resolves one `apply_hotkeys` argument to a target `Shortcut`: `None` or a
/// blank string means "use the default" (same as a missing/empty
/// `.sideline.json` key); a non-blank string must normalize AND parse, or
/// this returns an error — UNLIKE `parse_hotkey_or_default`, which silently
/// falls back to `default` on a bad combo. Startup wants "never lose the
/// hotkey to a typo"; a live edit wants "tell the user their typo didn't
/// take" — the caller (`apply_one`) is what still guarantees the hotkey
/// itself is never left dead, by never touching the live registration when
/// this returns Err.
fn resolve_combo(raw: Option<&str>, default: Shortcut) -> Result<Shortcut, String> {
    let raw = match raw {
        None => return Ok(default),
        Some(s) if s.trim().is_empty() => return Ok(default),
        Some(s) => s,
    };
    let normalized = normalize_combo(raw).ok_or_else(|| format!("Invalid combo {raw:?}"))?;
    Shortcut::from_str(&normalized).map_err(|e| format!("Invalid combo {raw:?}: {e}"))
}

/// Applies one key's new combo live. A no-op (`ok: true`, nothing
/// registered/unregistered) when the resolved target already matches what's
/// active. Otherwise: unregister the current shortcut, register the target;
/// on failure, re-register the current shortcut so the hotkey is never left
/// dead, update nothing, and report the error. `resolve_combo` failing
/// (invalid syntax) is reported the same way, without touching the live
/// registration at all — there's nothing to unregister/re-register for a
/// combo that was never resolved.
fn apply_one(
    app: &tauri::AppHandle,
    active: &Arc<Mutex<Shortcut>>,
    raw: Option<&str>,
    default: Shortcut,
    label: &str,
) -> HotkeyApplyResult {
    let target = match resolve_combo(raw, default) {
        Ok(t) => t,
        Err(e) => {
            return HotkeyApplyResult {
                ok: false,
                error: Some(e),
            }
        }
    };
    let current = *active.lock().unwrap();
    if target == current {
        return HotkeyApplyResult {
            ok: true,
            error: None,
        };
    }
    let _ = app.global_shortcut().unregister(current);
    match app.global_shortcut().register(target) {
        Ok(()) => {
            *active.lock().unwrap() = target;
            HotkeyApplyResult {
                ok: true,
                error: None,
            }
        }
        Err(e) => {
            if let Err(e2) = app.global_shortcut().register(current) {
                eprintln!(
                    "failed to re-register previous {label} shortcut after a failed live update ({e2}); {label} hotkey may be unregistered"
                );
            }
            HotkeyApplyResult {
                ok: false,
                error: Some(format!("Couldn't register — {e}")),
            }
        }
    }
}

/// Live hotkey apply — the Settings pane's `apply_hotkeys` IPC command.
/// Takes the three raw combo strings straight from the pane's text inputs
/// (`None`/blank = default); for each key that actually changed, swaps the
/// OS-level registration in place (see `apply_one`) so the new combo works
/// immediately, no restart. `.sideline.json` itself is written separately by
/// the frontend (`write_config`, same read-modify-write path as every other
/// setting) — this command only syncs the live registration to match.
#[tauri::command]
pub fn apply_hotkeys(
    app: tauri::AppHandle,
    state: tauri::State<'_, ActiveShortcuts>,
    toggle: Option<String>,
    record: Option<String>,
    dictate: Option<String>,
) -> ApplyHotkeysResponse {
    ApplyHotkeysResponse {
        toggle: apply_one(
            &app,
            &state.toggle,
            toggle.as_deref(),
            default_toggle_shortcut(),
            "toggle",
        ),
        record: apply_one(
            &app,
            &state.record,
            record.as_deref(),
            default_record_shortcut(),
            "record",
        ),
        dictate: apply_one(
            &app,
            &state.dictate,
            dictate.as_deref(),
            default_dictate_shortcut(),
            "dictate",
        ),
    }
}

/// Registers `resolved`; on failure (e.g. the combo is already claimed by
/// another app) falls back to registering `default` instead and updates
/// `active` so the shared handler's `==` comparison follows the switch —
/// the app must never silently lose a hotkey to a registration failure.
pub(crate) fn register_hotkey_with_fallback(
    app: &tauri::AppHandle,
    active: &Arc<Mutex<Shortcut>>,
    resolved: Shortcut,
    default: Shortcut,
    label: &str,
) {
    if let Err(e) = app.global_shortcut().register(resolved) {
        eprintln!("failed to register {label} shortcut ({e}); falling back to default");
        // Also emitted as `hotkey-fallback` (frontend toasts it): a
        // Finder-launched app's stderr goes nowhere the user looks, and a
        // silently-switched or silently-dead binding is exactly the
        // fighting-the-user failure this app tries never to have.
        use tauri::Emitter;
        if resolved != default {
            match app.global_shortcut().register(default) {
                Ok(()) => {
                    *active.lock().unwrap() = default;
                    let _ = app.emit(
                        "hotkey-fallback",
                        format!(
                            "Custom {label} hotkey is taken by another app — using the default instead"
                        ),
                    );
                }
                Err(e2) => {
                    eprintln!(
                        "failed to register default {label} shortcut too ({e2}); {label} hotkey disabled"
                    );
                    let _ = app.emit(
                        "hotkey-fallback",
                        format!("{label} hotkey couldn't be registered — disabled this session"),
                    );
                }
            }
        } else {
            let _ = app.emit(
                "hotkey-fallback",
                format!("{label} hotkey couldn't be registered — disabled this session"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- normalize_combo -----------------------------------------------

    #[test]
    fn normalize_combo_canonical() {
        assert_eq!(
            normalize_combo("alt+cmd+r"),
            Some("alt+super+KeyR".to_string())
        );
    }

    #[test]
    fn normalize_combo_docstring_example() {
        // Verbatim example from the function's doc comment.
        assert_eq!(
            normalize_combo("opt+cmd+v"),
            Some("alt+super+KeyV".to_string())
        );
    }

    #[test]
    fn normalize_combo_modifier_aliases() {
        for (alias, canonical) in [
            ("cmd", "super"),
            ("command", "super"),
            ("super", "super"),
            ("meta", "super"),
            ("opt", "alt"),
            ("option", "alt"),
            ("alt", "alt"),
            ("ctrl", "ctrl"),
            ("control", "ctrl"),
            ("shift", "shift"),
        ] {
            assert_eq!(
                normalize_combo(&format!("{alias}+r")),
                Some(format!("{canonical}+KeyR")),
                "alias {alias:?} should normalize to {canonical:?}"
            );
        }
    }

    #[test]
    fn normalize_combo_preserves_input_order_not_canonical_order() {
        // The function does not sort modifiers into a fixed order — it
        // alias-maps each token in place, so the output order tracks
        // whatever order the caller wrote them in.
        assert_eq!(
            normalize_combo("cmd+alt+r"),
            Some("super+alt+KeyR".to_string())
        );
        assert_eq!(
            normalize_combo("alt+cmd+r"),
            Some("alt+super+KeyR".to_string())
        );
    }

    #[test]
    fn normalize_combo_trims_whitespace_around_tokens() {
        assert_eq!(
            normalize_combo(" cmd + alt + r "),
            Some("super+alt+KeyR".to_string())
        );
    }

    #[test]
    fn normalize_combo_case_insensitive() {
        assert_eq!(
            normalize_combo("CMD+ALT+R"),
            Some("super+alt+KeyR".to_string())
        );
        assert_eq!(
            normalize_combo("Cmd+Option+V"),
            Some("super+alt+KeyV".to_string())
        );
    }

    #[test]
    fn normalize_combo_single_key_no_modifier() {
        assert_eq!(normalize_combo("r"), Some("KeyR".to_string()));
        assert_eq!(normalize_combo("R"), Some("KeyR".to_string()));
        assert_eq!(normalize_combo("5"), Some("Digit5".to_string()));
        assert_eq!(normalize_combo("space"), Some("Space".to_string()));
        assert_eq!(normalize_combo("SPACE"), Some("Space".to_string()));
    }

    #[test]
    fn normalize_combo_multichar_key_passes_through_unchanged() {
        // Anything besides a bare letter/digit/"space" is passed through
        // as-is (e.g. `Code` names like "F5" or "Comma") — including
        // whatever case the caller used. Pinning current behavior: unlike
        // the single-char case, this is NOT case-normalized, so a
        // lower-cased multi-char key (e.g. a hand-typed "f5") is passed
        // through lowercase too rather than corrected to "F5".
        assert_eq!(normalize_combo("cmd+F5"), Some("super+F5".to_string()));
        assert_eq!(
            normalize_combo("cmd+Comma"),
            Some("super+Comma".to_string())
        );
        assert_eq!(normalize_combo("cmd+f5"), Some("super+f5".to_string()));
    }

    #[test]
    fn normalize_combo_rejects_empty_input() {
        assert_eq!(normalize_combo(""), None);
    }

    #[test]
    fn normalize_combo_rejects_modifiers_only() {
        assert_eq!(normalize_combo("cmd+alt"), None);
        assert_eq!(normalize_combo("shift"), None);
    }

    #[test]
    fn normalize_combo_rejects_more_than_one_key() {
        assert_eq!(normalize_combo("cmd+r+t"), None);
    }

    #[test]
    fn normalize_combo_rejects_stray_plus_signs() {
        assert_eq!(normalize_combo("cmd+alt+"), None); // trailing
        assert_eq!(normalize_combo("+cmd+r"), None); // leading
        assert_eq!(normalize_combo("cmd++r"), None); // doubled
    }

    // --- resolve_combo ---------------------------------------------------
    // The live-apply path's stricter counterpart to parse_hotkey_or_default:
    // a bad combo is an Err here, never a silent fallback to `default`.

    #[test]
    fn resolve_combo_none_is_the_default() {
        assert_eq!(
            resolve_combo(None, default_record_shortcut()),
            Ok(default_record_shortcut())
        );
    }

    #[test]
    fn resolve_combo_blank_string_is_the_default() {
        assert_eq!(
            resolve_combo(Some("   "), default_record_shortcut()),
            Ok(default_record_shortcut())
        );
    }

    #[test]
    fn resolve_combo_valid_combo_resolves_to_its_shortcut() {
        assert_eq!(
            resolve_combo(Some("alt+cmd+v"), default_record_shortcut()),
            Ok(default_dictate_shortcut())
        );
    }

    #[test]
    fn resolve_combo_invalid_syntax_is_an_error_not_a_silent_default() {
        // Two key tokens — normalize_combo itself rejects this.
        assert!(resolve_combo(Some("cmd+r+t"), default_record_shortcut()).is_err());
    }

    #[test]
    fn resolve_combo_modifiers_only_is_an_error() {
        assert!(resolve_combo(Some("cmd+alt"), default_record_shortcut()).is_err());
    }
}
