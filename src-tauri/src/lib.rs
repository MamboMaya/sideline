use std::sync::{Arc, Mutex};

use tauri_plugin_global_shortcut::ShortcutState;

mod archive;
mod audio;
mod autostart;
mod claude;
mod commands;
mod dictate;
mod hotkeys;
mod paths;
mod tray;
mod watcher;
mod whisper;
mod window;

/// Push-to-talk bookkeeping: which of the two toggleable hotkeys (record or
/// dictate) is currently being held down and is the one that started the
/// live session — so its Released event, and only its Released event, is
/// allowed to stop that session. See the global-shortcut handler in `run()`
/// below.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeldShortcut {
    Record,
    Dictate,
}

pub fn run() {
    let (toggle, record, dictate) = hotkeys::load_hotkeys();
    let active_toggle = Arc::new(Mutex::new(toggle));
    let active_record = Arc::new(Mutex::new(record));
    let active_dictate = Arc::new(Mutex::new(dictate));
    let handler_toggle = active_toggle.clone();
    let handler_record = active_record.clone();
    let handler_dictate = active_dictate.clone();
    // A second clone of each Arc, managed as one struct so the Settings
    // pane's `apply_hotkeys` command can reach all three through a single
    // `tauri::State` — same Arcs the handler closure above compares
    // against, so updating one here is what the handler sees too.
    let managed_shortcuts = hotkeys::ActiveShortcuts {
        toggle: active_toggle.clone(),
        record: active_record.clone(),
        dictate: active_dictate.clone(),
    };
    // Push-to-talk-only state: the hotkey (if any) whose hold is currently
    // "open" — set on a Pressed that starts a session, cleared on the
    // matching Released that stops it. Irrelevant in toggle mode (the
    // default), where every press is handled without touching this at all.
    let held_shortcut: Arc<Mutex<Option<HeldShortcut>>> = Arc::new(Mutex::new(None));
    let handler_held = held_shortcut.clone();

    tauri::Builder::default()
        // First plugin on purpose (its docs require it): a second launch —
        // e.g. a stale AppleScript-era login item firing alongside the
        // current LaunchAgent, or a manual open while already running —
        // exits immediately instead of putting a second tray icon up. The
        // first instance just keeps running; there's nothing to focus for a
        // tray-only app, so the callback is a no-op.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .manage(audio::AudioState::default())
        .manage(managed_shortcuts)
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // Toggle popover is Pressed-only either way — it has no
                    // hold behavior to speak of.
                    if *shortcut == *handler_toggle.lock().unwrap() {
                        if event.state() == ShortcutState::Pressed {
                            window::toggle_window(app, None);
                        }
                        return;
                    }

                    let held_variant = if *shortcut == *handler_record.lock().unwrap() {
                        HeldShortcut::Record
                    } else if *shortcut == *handler_dictate.lock().unwrap() {
                        HeldShortcut::Dictate
                    } else {
                        return;
                    };
                    let fire = || {
                        let _ = match held_variant {
                            HeldShortcut::Record => audio::toggle_recording(app.clone()),
                            HeldShortcut::Dictate => audio::toggle_dictation(app.clone()),
                        };
                    };

                    if !hotkeys::push_to_talk_enabled() {
                        // Toggle mode (default, and the only mode before
                        // this feature existed): Pressed flips recording on
                        // or off, Released is a no-op.
                        if event.state() == ShortcutState::Pressed {
                            fire();
                        }
                        return;
                    }

                    // Push-to-talk: a Pressed on an idle (or Copied-notice)
                    // recorder starts a session and remembers THIS shortcut
                    // as the one holding it open. A Pressed while a session
                    // is already running — started from the tray, or
                    // started in toggle mode before the setting flipped —
                    // instead behaves like a toggle-mode press and stops it
                    // (same `fire()` call either way; `toggle_recording`/
                    // `toggle_dictation` themselves decide start vs. stop),
                    // and leaves `held` exactly as it was: not touching it
                    // here matters when the OTHER hotkey is the one
                    // currently held (see below), so this branch must never
                    // clobber someone else's hold. Released only stops the
                    // session if `held` still names THIS shortcut — a stray
                    // release of the other hotkey (e.g. it was pressed and
                    // released while the first was still held, and got
                    // "Already recording") or of this one after the session
                    // already ended some other way, is ignored.
                    match event.state() {
                        ShortcutState::Pressed => {
                            let can_start = matches!(
                                audio::get_recording_state(app.clone()).as_str(),
                                "idle" | "copied"
                            );
                            if can_start {
                                *handler_held.lock().unwrap() = Some(held_variant);
                            }
                            fire();
                        }
                        ShortcutState::Released => {
                            let mut held = handler_held.lock().unwrap();
                            if *held == Some(held_variant) {
                                *held = None;
                                drop(held);
                                fire();
                            }
                        }
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
            // planned recording-state-polling UI (get_recording_state) — the
            // frontend currently only ever reads state off the
            // `recording-state` event. list_audio_devices IS called now, by
            // the Settings pane's Voice section device picker.
            audio::get_recording_state,
            audio::list_audio_devices,
            hotkeys::apply_hotkeys
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
            hotkeys::register_hotkey_with_fallback(
                app.handle(),
                &active_dictate,
                dictate,
                hotkeys::default_dictate_shortcut(),
                "dictate",
            );

            tray::setup_tray(app.handle())?;
            window::hide_on_focus_loss(app.handle());
            watcher::spawn_inbox_watcher(app.handle().clone());

            // Menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Sideline")
        .run(|_app, event| {
            // Quit-path workaround for a whisper.cpp/ggml bug: once a
            // transcription has run, ggml's Metal device is torn down by a
            // C++ static destructor during normal `exit()` finalizers — and
            // that teardown calls ggml_abort (SIGABRT), so every quit after
            // a recording died as a crash (see the ggml_metal_rsets_free
            // reports in ~/Library/Logs/DiagnosticReports) and could leave
            // a ghost tray icon behind. Nothing needs those finalizers:
            // every notes write is already atomic (temp+rename) and long
            // flushed by the time RunEvent::Exit fires, so skip straight to
            // _exit(), which ends the process without running them.
            if let tauri::RunEvent::Exit = event {
                unsafe { libc::_exit(0) }
            }
        });
}
