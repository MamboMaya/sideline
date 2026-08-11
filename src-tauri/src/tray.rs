//! Tray icon: menu construction and click/menu event handling.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::window::toggle_window;
use crate::{archive, audio, commands};

pub(crate) fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let record_item = MenuItem::with_id(app, "record", "Record voice note", true, None::<&str>)?;
    let dictate_item =
        MenuItem::with_id(app, "dictate", "Dictate to clipboard", true, None::<&str>)?;
    let reveal = MenuItem::with_id(
        app,
        "reveal",
        "Reveal inbox.md in Finder",
        true,
        None::<&str>,
    )?;
    let purge = MenuItem::with_id(app, "purge", "Purge Archive…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Sideline", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&record_item, &dictate_item, &reveal, &purge, &quit])?;

    // `with_id("main")`: the REC ticker (audio.rs) fetches this tray
    // via `app.tray_by_id("main")` rather than holding its own handle.
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "record" => {
                let _ = audio::toggle_recording(app.clone());
            }
            "dictate" => {
                let _ = audio::toggle_dictation(app.clone());
            }
            "reveal" => {
                let _ = commands::open::reveal_inbox();
            }
            "purge" => {
                // Own thread: the confirm dialog blocks.
                let handle = app.clone();
                std::thread::spawn(move || archive::purge_archive(&handle));
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                toggle_window(tray.app_handle(), Some(position));
            }
        })
        .build(app)?;

    Ok(())
}
