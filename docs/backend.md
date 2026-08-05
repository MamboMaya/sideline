# Backend — src-tauri/src/

Module map: `lib.rs` (plugin/builder wiring, `invoke_handler`, `.setup()`)
delegates to `paths.rs` (notes-dir helpers, `validate_component()`, `confine()`),
`commands/notes.rs` + `commands/open.rs` (the IPC commands below, grouped by
concern), `claude.rs` (`send_to_claude`), `archive.rs` (purge-archive flow),
`window.rs` (popover positioning), `hotkeys.rs` (config + registration),
`tray.rs` (tray menu construction/events), `watcher.rs` (the inbox fs
watcher), and `autostart.rs` (one-time launch-at-login consent: a native
dialog on first run — "Launch at Login" enables, "Not Now" disables, either
answer writes an `autostart-prompted` sentinel to Application Support so the
question never returns, and System Settings > Login Items is authoritative
from then on) — plus `audio.rs` and `whisper.rs` for in-app voice recording,
documented separately below.

Tray icon + popover window toggle (tray click anchors under the icon for that
click only; the ⌥⌘Space hotkey opens top-center of the monitor holding the
cursor), global hotkeys (⌥⌘Space popover, ⌥⌘R recording), fs watcher on
`~/notes` emitting `inbox-changed`, and the commands:

- Hotkeys are configurable via `.sideline.json`'s `hotkeys.toggle`/
  `hotkeys.record` (see docs/data-model.md), read directly at startup
  (`load_hotkeys` in hotkeys.rs, not through `read_config`) and normalized
  (modifier aliases, bare letter/digit/`space` → `Code` name) before
  `Shortcut::from_str`; a missing key, unparseable combo, or OS-level
  registration failure all `eprintln!` and fall back to the hardcoded
  ⌥⌘Space/⌥⌘R default — the app never loses a hotkey to a typo. Takes
  effect on next launch only, no live reload.

- `read_inbox`, `write_inbox`
- `triage_note` (returns final filename)
- `read_archive`, `write_archive`
- `send_to_claude` (async, shells out to the `claude` CLI; optional `model`
  arg; absolute-path candidates since Finder-launched apps don't inherit the
  shell PATH; non-interactive `-p` mode; runs with `--setting-sources ""`
  and `--strict-mcp-config` so NO user hooks/plugins/MCP servers boot inside
  Sideline's process identity — a hook touching a TCC-protected folder like
  ~/Documents would otherwise make macOS blame Sideline with a permissions
  popup on every triage; bare-config calls are also faster and cheaper)
- `read_todos` (all `~/notes/todos/*.md` as project/content pairs, mtime DESC;
  shares a `list_md_dir` listing helper with `read_triaged` below but is
  deliberately uncapped — a `todos/<project>.md` file is the only record of
  its routed notes, so nothing here may be silently dropped)
- `write_todos` (writes one project's todo file, creating `todos/` as needed)
- `write_triaged` (overwrites an existing `~/notes/notes/<filename>` in place
  for the Todos view's done-status flip — no collision-suffix, errors if the
  file doesn't exist)
- `open_inbox_in_vscode`
- `read_config`, `write_config`
- `read_triaged` (lists `notes/*.md` sorted by mtime DESC, capped at 200)
- `open_triaged` (opens one triaged file in VS Code; same filename validation
  as `delete_triaged`)
- `open_todos` (opens `todos/<project>.md` in VS Code; same component
  validation as `write_todos`, mirrors `open_triaged`)
- `delete_triaged` (plain `fs::remove_file` of a `notes/` file whose content
  was already preserved elsewhere — never the `trash` crate, whose macOS
  route goes through Finder automation and triggers a TCC prompt)
- `toggle_recording` (starts or stops+transcribes+appends a voice note;
  returns the new state immediately — `"recording"`/`"transcribing"` — the
  eventual `"idle"` or a `capture-error` arrives later via events, since
  transcription runs in the background after the call returns)
- `get_recording_state`, `list_audio_devices` (registered but not called by
  the frontend today — intentional surface for a planned recording-device-
  picker UI)

`append_inbox_text` (`commands/notes.rs`) is an O_APPEND write of one
voice-note block — not an IPC command, just a plain fn the native recording
pipeline (audio.rs) calls directly — so it can never race the frontend's
full-file `write_inbox` or the Raycast script's own append. `reveal_inbox`
(`commands/open.rs`, tray-menu "Reveal inbox.md in Finder") is likewise a
plain fn, called only from the tray menu below.

The tray menu also carries "Purge Archive…" (see docs/data-model.md),
implemented Rust-side with `tauri-plugin-dialog` native confirms and
`move_to_user_trash` (plain rename into `~/.Trash`, collision-suffixed).

## In-app voice recording (audio.rs + whisper.rs)

Native capture — no ffmpeg/whisper-cli subprocesses, no temp WAV files.
`cpal` records on a dedicated OS thread (its `Stream` isn't `Send`, so it's
built, played, and dropped entirely on that thread) into an in-RAM
`Arc<Mutex<Vec<f32>>>`, downmixed to mono at the device's native sample
rate; a linear-interpolation resample to 16 kHz happens after handoff, off
the audio thread. Device selection: the system default input, unless
`~/notes/.sideline.json` has `audio: { "device": "<substring>" }` (see
docs/data-model.md), matched case-insensitively against `list_audio_devices`.

State machine (`audio::RecState`: Idle → Recording → Transcribing, plus a
DownloadingModel sub-state of Transcribing) is managed via
`app.manage(AudioState::default())`. Every transition emits
`recording-state` (string payload) and updates the tray title via
`app.tray_by_id("main")` — `🔴 m:ss` while recording (1 Hz ticker, same
thread also emits `audio-level` at ~20 Hz, a 0..1 RMS float from the
capture callback), `…` while transcribing or downloading, cleared at idle.
Title only, no icon swap. A transcript that comes back empty (or any
failure — no input device, model download error, etc.) emits
`capture-error` (string payload) and the state machine still lands back on
Idle.

Silence gate: before transcription, the post-resample buffer is scanned in
100 ms RMS windows (`max_window_rms`); if no window reaches
`SPEECH_RMS_FLOOR` (0.01), the recording is rejected with a
`capture-error` of "No speech detected" instead of being transcribed —
whisper hallucinates caption-like text ("Don't forget to subscribe…") on
non-speech audio, so silent recordings must never reach it.

Transcription (whisper-rs, bundling whisper.cpp with the `metal` feature —
Metal-accelerated on macOS): the model
(`~/.whisper-models/ggml-base.en.bin` — deliberately OUTSIDE `~/notes` and
its confinement, a one-time per-machine download, not part of the notes
data model) is downloaded on first use if missing (`downloading-model`
state, `.part` file then rename, `capture-error` on network failure), then
loaded once into a `OnceLock<WhisperContext>` and reused for every
subsequent recording. `FullParams` greedy, English, no timestamps,
`set_initial_prompt` biased toward "Claude, Claude Code, Sideline, Raycast,
Tauri, triage, inbox". Output runs through the same Claude mis-hear
correction regexes as capture/voice-note.sh's perl pass (`clod`/`claw(ed)`/
`clawd`/`clode` → `Claude`/`Claude Code`) before being appended via
`append_inbox_text`.

⌥⌘R (global hotkey, alongside ⌥⌘Space) and the tray menu's "Record voice
note" both call `audio::toggle_recording` directly. Mic access requires
`src-tauri/Info.plist` (`NSMicrophoneUsageDescription`, auto-merged by
Tauri) and `src-tauri/Entitlements.plist`
(`com.apple.security.device.audio-input`, wired via
`tauri.conf.json`'s `bundle.macOS.entitlements`) — no other new TCC
surface.

All notes file access is confined to `~/notes` via one of two mechanisms in
`paths.rs`. Single-component names (project names, triaged filenames) go
through `validate_component` (reject `/`, `..`, empty) before being joined
onto a path fixed under `notes_dir()` — cheap by construction, no
canonicalization needed. The one multi-component case — asset refs
(`inbox-assets/...`) scraped out of archive.md, user-editable text and the
one place attacker-ish input exists — goes through `confine`, which rejects
absolute paths and any non-`Normal` component (so `..`/`.`/root all fail
before any I/O happens), then, if the joined path exists, canonicalizes it
and `notes_dir()` and requires `starts_with` — this defeats a symlink
planted at an intermediate directory (and handles `~/notes` itself being a
symlink) at the cost of also rejecting a confined file that is itself a
symlink pointing outside `~/notes`. No exceptions beyond that; the
`tauri-plugin-clipboard-manager` plugin (write-text only) is the one other
capability beyond notes I/O.
