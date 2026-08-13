//! Popover window positioning: toggling visibility and resolving which
//! monitor — and where on it — to show at, for both tray-click and hotkey
//! invocations. Also owns the recording-pill overlay window (show/position/
//! hide, driven by audio.rs's recorder state machine) — see the bottom of
//! this file.

use tauri::{LogicalPosition, Manager, PhysicalPosition};

use crate::audio::RecState;

/// Toggle the popover window: hide if visible, otherwise position and show.
/// Tray clicks pass the click position and anchor the popover under the
/// icon for that invocation only; the global hotkey passes None and the
/// popover goes top-center of whichever monitor holds the cursor.
pub(crate) fn toggle_window(app: &tauri::AppHandle, position: Option<PhysicalPosition<f64>>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            if let Some(pos) = position {
                // Tray coords are physical, in the scale of the monitor the
                // menu bar is on. Positioning with PhysicalPosition would
                // convert them using the WINDOW's current monitor scale —
                // wrong whenever the popover last sat on a different-DPI
                // screen. Convert with the click's own monitor scale and
                // position in logical points, which macOS applies directly.
                let scale = monitor_at(app, pos.x, pos.y)
                    .map(|m| m.scale_factor())
                    .unwrap_or(1.0);
                let _ = win.set_position(LogicalPosition::new(
                    pos.x / scale - 190.0,
                    pos.y / scale + 8.0,
                ));
            } else if let Some(pos) = hotkey_position(app, &win) {
                let _ = win.set_position(pos);
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// The monitor whose physical bounds contain the point.
pub(crate) fn monitor_at(app: &tauri::AppHandle, x: f64, y: f64) -> Option<tauri::Monitor> {
    app.available_monitors().ok()?.into_iter().find(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x as f64
            && x < (p.x + s.width as i32) as f64
            && y >= p.y as f64
            && y < (p.y + s.height as i32) as f64
    })
}

/// The monitor whose LOGICAL bounds contain the logical point. tao reports
/// monitor bounds as physical in each monitor's OWN scale, so mixed-DPI
/// monitors don't share one physical coordinate space — containment must be
/// tested in logical points.
pub(crate) fn monitor_at_logical(app: &tauri::AppHandle, x: f64, y: f64) -> Option<tauri::Monitor> {
    app.available_monitors().ok()?.into_iter().find(|m| {
        let s = m.scale_factor();
        let p = m.position();
        let sz = m.size();
        let (mx, my) = (p.x as f64 / s, p.y as f64 / s);
        x >= mx && x < mx + sz.width as f64 / s && y >= my && y < my + sz.height as f64 / s
    })
}

/// Logical-point bounds `(origin_x, origin_y, width, height)` of the
/// monitor holding the cursor. Shared by `hotkey_position` (popover) and
/// `overlay_position` (recording pill) — both want "whichever screen the
/// user is looking at", not just the primary monitor. None if the cursor or
/// its monitor can't be resolved.
fn cursor_monitor_bounds(app: &tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    // tao's cursor_position() is the global logical point scaled by the
    // PRIMARY monitor's factor (not the cursor's monitor), so divide that
    // factor back out and match monitors in logical points — with mixed-DPI
    // monitors the raw value lands outside every monitor's reported bounds.
    let raw = app.cursor_position().ok()?;
    let primary_scale = app.primary_monitor().ok()??.scale_factor();
    let mon = monitor_at_logical(app, raw.x / primary_scale, raw.y / primary_scale)?;
    let scale = mon.scale_factor();
    let origin_x = mon.position().x as f64 / scale;
    let origin_y = mon.position().y as f64 / scale;
    let width = mon.size().width as f64 / scale;
    let height = mon.size().height as f64 / scale;
    Some((origin_x, origin_y, width, height))
}

/// Spotlight-style spot for the hotkey: horizontally centered, 20% down the
/// monitor containing the cursor, in logical points (see toggle_window for
/// why logical). None (→ keep last position) if the cursor or monitor can't
/// be resolved — never block the popover over a positioning failure.
pub(crate) fn hotkey_position(
    app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
) -> Option<LogicalPosition<f64>> {
    let (origin_x, origin_y, width, height) = cursor_monitor_bounds(app)?;
    let win_w = win
        .outer_size()
        .ok()
        .and_then(|sz| win.scale_factor().ok().map(|ws| sz.width as f64 / ws))
        .unwrap_or(380.0);
    Some(LogicalPosition::new(
        origin_x + (width - win_w) / 2.0,
        origin_y + height * 0.20,
    ))
}

/// Hide the popover when it loses focus (standard popover behavior).
pub(crate) fn hide_on_focus_loss(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let win_clone = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = win_clone.hide();
            }
        });
    }
}

// --- Recording-pill overlay -------------------------------------------
//
// A small always-on-top HUD (see tauri.conf.json's `overlay` window entry:
// transparent, decorations off, skip-taskbar, visible on all workspaces,
// fixed 340x48 size) that surfaces the mic-hot indicator even while the
// popover is closed. Created hidden at app startup — same pattern as
// `main` — so its frontend is already listening for
// `recording-state`/`audio-level` by the time a recording actually starts;
// creating it lazily on first use would risk losing that very first event.
// Two config invariants matter (guarded by src/overlay-config.test.ts):
// `focusable: false` — tao's macOS show() is makeKeyAndOrderFront, so a
// focusable overlay would steal key status on every show and hide the
// popover via hide_on_focus_loss — and its own capability file
// (capabilities/overlay.json), since a webview label without an event
// grant fails listen() silently and the pill would render nothing.

/// Fallback size if `outer_size()` can't be read yet — kept in sync with
/// the `overlay` window's `width`/`height` in tauri.conf.json. The window
/// is wider than the pill it holds (the pill hugs its content — see
/// styles.css); the slack either side is transparent.
const OVERLAY_WIDTH: f64 = 340.0;
const OVERLAY_HEIGHT: f64 = 48.0;

/// Bottom-center spot for the recording pill, on the monitor holding the
/// cursor — same monitor resolution as `hotkey_position`, with the pill's
/// bottom edge 20% up the monitor, mirroring the popover's top edge
/// sitting 20% down (see `hotkey_position`). None (→ caller skips
/// repositioning, keeps the pill's last spot) if the cursor/monitor can't
/// be resolved.
fn overlay_position(
    app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
) -> Option<LogicalPosition<f64>> {
    let (origin_x, origin_y, width, height) = cursor_monitor_bounds(app)?;
    let scale = win.scale_factor().ok();
    let size = win.outer_size().ok();
    let win_w = size
        .and_then(|sz| scale.map(|ws| sz.width as f64 / ws))
        .unwrap_or(OVERLAY_WIDTH);
    let win_h = size
        .and_then(|sz| scale.map(|ws| sz.height as f64 / ws))
        .unwrap_or(OVERLAY_HEIGHT);
    Some(LogicalPosition::new(
        origin_x + (width - win_w) / 2.0,
        origin_y + height * 0.80 - win_h,
    ))
}

/// Show/position/hide the recording-pill overlay to track the recorder
/// state machine. Called from `audio::emit_state` — the same choke point
/// that already emits the `recording-state` event and updates the tray
/// title — so every transition (including the DownloadingModel sub-state
/// emitted from whisper.rs) reaches the pill with no separate wiring.
///
/// Only repositions on entering Recording: a fresh ⌥⌘R press might be on a
/// different monitor than last time, but Transcribing/DownloadingModel —
/// and dictation's terminal Copied notice — always follow a Recording on
/// the same monitor, so they just keep the pill visible where it already
/// is (no jitter).
///
/// Never steals focus: `show()` alone (never `set_focus()`) on a window
/// created with `focus: false` — see tauri.conf.json — leaves keyboard
/// input wherever the user was typing.
pub(crate) fn sync_overlay(app: &tauri::AppHandle, state: RecState) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    match state {
        RecState::Idle => {
            let _ = win.hide();
        }
        RecState::Recording => {
            if let Some(pos) = overlay_position(app, &win) {
                let _ = win.set_position(pos);
            }
            let _ = win.show();
        }
        RecState::Transcribing | RecState::DownloadingModel | RecState::Copied => {
            let _ = win.show();
        }
    }
}
