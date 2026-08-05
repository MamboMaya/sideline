use std::sync::{Arc, Mutex};

use tauri_plugin_global_shortcut::ShortcutState;

mod archive;
mod audio;
mod autostart;
mod claude;
mod commands;
mod hotkeys;
mod paths;
mod tray;
mod watcher;
mod whisper;
mod window;

pub fn run() {
    let (toggle, record) = hotkeys::load_hotkeys();
    let active_toggle = Arc::new(Mutex::new(toggle));
    let active_record = Arc::new(Mutex::new(record));
    let handler_toggle = active_toggle.clone();
    let handler_record = active_record.clone();

    tauri::Builder::default()
        .manage(audio::AudioState::default())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if *shortcut == *handler_toggle.lock().unwrap() {
                        window::toggle_window(app, None);
                    } else if *shortcut == *handler_record.lock().unwrap() {
                        let _ = audio::toggle_recording(app.clone());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::notes::read_inbox,
            commands::notes::write_inbox,
            commands::notes::triage_note,
            commands::notes::read_archive,
            commands::notes::write_archive,
            commands::notes::delete_triaged,
            claude::send_to_claude,
            commands::notes::read_todos,
            commands::notes::write_todos,
            commands::notes::write_triaged,
            commands::open::open_inbox_in_vscode,
            commands::notes::read_config,
            commands::notes::write_config,
            commands::notes::read_triaged,
            commands::open::open_triaged,
            commands::open::open_todos,
            audio::toggle_recording,
            // Not called by the frontend today: intentional surface for a
            // planned recording-device-picker UI.
            audio::get_recording_state,
            audio::list_audio_devices
        ])
        .setup(move |app| {
            // One-time launch-at-login consent dialog; after it's answered,
            // System Settings > Login Items is authoritative (see autostart.rs).
            autostart::ensure_consent(app.handle());

            // Global hotkeys: toggle popover / toggle recording from anywhere.
            hotkeys::register_hotkey_with_fallback(
                app.handle(),
                &active_toggle,
                toggle,
                hotkeys::default_toggle_shortcut(),
                "toggle",
            );
            hotkeys::register_hotkey_with_fallback(
                app.handle(),
                &active_record,
                record,
                hotkeys::default_record_shortcut(),
                "record",
            );

            tray::setup_tray(app.handle())?;
            window::hide_on_focus_loss(app.handle());
            watcher::spawn_inbox_watcher(app.handle().clone());

            // Menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sideline");
}
