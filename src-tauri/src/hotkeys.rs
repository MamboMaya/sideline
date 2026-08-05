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

/// Reads `hotkeys.toggle` / `hotkeys.record` from `.sideline.json`. Fully
/// failure-tolerant: missing file, malformed JSON, and a missing/invalid
/// key each just fall back to the hardcoded default (current ⌥⌘Space /
/// ⌥⌘R behavior). Changing this file requires an app restart to take
/// effect.
pub(crate) fn load_hotkeys() -> (Shortcut, Shortcut) {
    let raw = fs::read_to_string(notes_dir().join(".sideline.json")).unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let hotkeys = parsed.get("hotkeys");
    let toggle_raw = hotkeys
        .and_then(|h| h.get("toggle"))
        .and_then(|v| v.as_str());
    let record_raw = hotkeys
        .and_then(|h| h.get("record"))
        .and_then(|v| v.as_str());
    (
        parse_hotkey_or_default(toggle_raw, "toggle", default_toggle_shortcut()),
        parse_hotkey_or_default(record_raw, "record", default_record_shortcut()),
    )
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
}
