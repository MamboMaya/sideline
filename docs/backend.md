# Backend — src-tauri/src/

Module map: `lib.rs` (plugin/builder wiring, `invoke_handler`, `.setup()`)
delegates to `paths.rs` (notes-dir helpers, `validate_component()`, `confine()`),
`commands/notes.rs` + `commands/open.rs` (the IPC commands below, grouped by
concern), `claude.rs` (`send_to_claude`), `archive.rs` (purge-archive flow),
`window.rs` (popover positioning + the recording-pill overlay window),
`hotkeys.rs` (config + registration),
`tray.rs` (tray menu construction/events), `watcher.rs` (the inbox fs
watcher), and `autostart.rs` (one-time launch-at-login consent: a native
dialog on first run — "Launch at Login" enables, "Not Now" disables, either
answer writes an `autostart-prompted` sentinel to Application Support so the
question never returns, and System Settings > Login Items is authoritative
from then on) — plus `audio.rs`, `whisper.rs`, and `dictate.rs` for in-app
voice recording (note capture and dictation-to-clipboard), documented
separately below.

Quit path: the run-loop callback in lib.rs handles `RunEvent::Exit` with
`libc::_exit(0)`, skipping C-runtime exit finalizers — ggml (whisper's Metal
backend) otherwise aborts in a static destructor on every quit after a
transcription, which died as a SIGABRT crash report and could leave a ghost
tray icon. All notes writes are atomic temp+rename, so nothing needs those
finalizers.

`tauri-plugin-single-instance` is registered first (its docs require it): a
second launch of the app — a stale AppleScript-era login item firing
alongside the current LaunchAgent registration, or a manual open while
already running — exits immediately instead of showing a second tray icon.

Tray icon + popover window toggle (tray click anchors under the icon for that
click only; the ⌥⌘Space hotkey opens top-center of the monitor holding the
cursor), global hotkeys (⌥⌘Space popover, ⌥⌘R recording, ⌥⌘V dictation), fs
watcher on `~/notes` emitting `inbox-changed`, and the commands:

- Hotkeys are configurable via `.sideline.json`'s `hotkeys.toggle`/
  `hotkeys.record`/`hotkeys.dictate` (see docs/data-model.md), read directly
  at startup (`load_hotkeys` in hotkeys.rs, not through `read_config`) and
  normalized (modifier aliases, bare letter/digit/`space` → `Code` name)
  before `Shortcut::from_str`; a missing key, unparseable combo, or OS-level
  registration failure all fall back to the hardcoded ⌥⌘Space/⌥⌘R/⌥⌘V
  default — the app never loses a hotkey to a typo. An OS-level registration
  failure (combo claimed by another app; the default also failing)
  additionally emits `hotkey-fallback`, which the frontend toasts — a
  silently-switched or silently-dead binding must not be discoverable only by
  pressing it. This startup path is unchanged and still governs a
  hand-edited `.sideline.json` — those still need a restart to take effect.
- `apply_hotkeys` (hotkeys.rs) is the Settings pane's LIVE counterpart: takes
  the three raw combo strings straight from the pane's text inputs (missing/
  blank = default for that key) and, for each key that actually changed,
  swaps the OS-level registration in place — no restart. The three
  `Arc<Mutex<Shortcut>>` the global-shortcut handler in `lib.rs` compares
  against (`active_toggle`/`active_record`/`active_dictate`) are cloned a
  second time into a managed `hotkeys::ActiveShortcuts` struct
  (`app.manage(...)`) precisely so this command can reach and mutate the
  SAME Arcs the handler reads — updating one here is what the handler sees
  on the very next keypress. Per key: resolve the raw string to a `Shortcut`
  (reusing `normalize_combo`, but UNLIKE `parse_hotkey_or_default` this
  returns an `Err` on a bad combo instead of silently substituting the
  default — the pane needs to tell the user their edit didn't take, not
  hide it); if it resolves to what's already active, no-op; otherwise
  unregister the current shortcut, register the new one, and on failure
  (OS conflict) re-register the CURRENT one so the hotkey is never left
  dead. Returns one `{ ok, error }` result per key (`toggle`/`record`/
  `dictate`), which the pane uses to mark the failing field and toast the
  reason — `.sideline.json` itself is written separately by the frontend
  (`write_config`, same path every other Settings field uses); this command
  only syncs the live registration to match what was just written.

- The fs watcher emits `watcher-dead` (frontend toasts "restart Sideline")
  on any exit path — setup failure or channel close — since a dead watcher
  otherwise means external edits silently stop appearing all session. All
  full-file writes (inbox, archive, config, triaged, todos) go through one
  atomic temp+rename helper (`write_file` in commands/notes.rs), so a crash
  mid-write can never leave a notes file empty or truncated.

- `read_inbox`, `write_inbox` — versioned compare-and-swap pair:
  `read_inbox` returns `(content, version)` (a content hash), and
  `write_inbox` takes the version from the caller's last read as
  `base_version`, refusing with the `inbox-conflict` sentinel if the file
  has changed since (an append the frontend hasn't absorbed yet). On
  conflict the frontend reloads and toasts "redo your last action" —
  refusing beats silently erasing a just-captured note. Undo closures
  additionally apply inverse operations against live state (`src/lib/undo.ts`)
  rather than restoring pre-action snapshots, since a snapshot restore
  passes the version check yet still erases notes captured in between.
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
- `get_recording_state` (registered but not called by the frontend today —
  intentional surface for a planned recording-state-polling UI);
  `list_audio_devices` (enumerates input device names — the Settings pane's
  Voice section device picker is its one caller)
- `apply_hotkeys` (hotkeys.rs) — see the hotkeys bullet above

`append_inbox_text` (`commands/notes.rs`) is an O_APPEND write of one
voice-note block — not an IPC command, just a plain fn the native recording
pipeline (audio.rs) calls directly. O_APPEND makes the append itself atomic
against other writers; protection in the other direction (a frontend
full-file write clobbering an append it hasn't seen) comes from
`write_inbox`'s compare-and-swap version check above. `reveal_inbox`
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
DownloadingModel sub-state of Transcribing and a terminal Copied notice
state — dictation-only, see below) is managed via
`app.manage(AudioState::default())`. Every transition emits
`recording-state` (string payload) and updates the tray title via
`app.tray_by_id("main")` — `🔴 m:ss` while recording (1 Hz ticker, same
thread also emits `audio-level` at ~20 Hz, a 0..1 RMS float from the
capture callback), `…` while transcribing or downloading, cleared at idle.
Title only, no icon swap. A transcript that comes back empty (or any
failure — no input device, model download error, etc.) emits
`capture-error` (string payload) and the state machine still lands back on
Idle.

Orthogonal to `RecState` is `audio::RecMode` (`Note` | `Dictate`), carried on
the same managed `Inner` alongside the state — which pipeline a session
feeds, not what phase it's in. `toggle_recording` (⌥⌘R / tray "Record voice
note" / popover `r`) and `toggle_dictation` (⌥⌘V / tray "Dictate to
clipboard") both funnel into one `toggle_recording_mode(app, mode)`: Idle
starts a session and records `mode`; a same-mode press while Recording stops
it exactly as before; a press in the OTHER mode while a session is already
active is ignored outright and emits `capture-error` "Already recording" —
the recorder never silently switches modes mid-recording. The transient
Copied notice counts as idle for all of this (`RecState::can_start`):
either hotkey during it starts a fresh session, and the notice's hide
timer stands down when it sees the state has moved on. `emit_state` additionally emits `recording-mode` (`"note"`/
`"dictate"` string payload) once, at the moment a session enters Recording,
so the overlay pill can tell the two apart; it does not change the
`recording-state` payload shape.

Every transition also drives the recording-pill overlay: `sync_overlay`
(window.rs), called from the same `emit_state` choke point, shows the
`overlay` window (declared hidden in tauri.conf.json — 340×48, transparent,
no decorations, always-on-top, `focusable: false`) bottom-center of the
monitor holding the cursor (its bottom edge 20% up the screen, mirroring
the popover's 20%-down top edge) while recording, keeps it up through
transcribing/downloading and dictation's Copied notice, and hides it at
idle — UNLESS `overlay.hidden` is `true` in `~/notes/.sideline.json`
(Settings → Voice → "Show recording pill"), read fresh on every call
(`window::overlay_hidden`, same failure-tolerant shape as
`audio::configured_device_name` — missing/malformed file just means not
hidden), in which case every non-Idle transition hides the window instead
of showing it — so switching the toggle off hides an already-visible pill
on the very next state change, not just future recordings. `focusable: false` is what
makes showing it safe: tao's macOS `show()` is `makeKeyAndOrderFront`, so a
focusable window steals keyboard focus every time it appears (which also
closed the popover via hide-on-focus-loss); non-focusable means
`canBecomeKeyWindow` is false and the pill can never take a keystroke. The
window also needs its own capability grant — capabilities/overlay.json
gives it `core:event:default` and nothing else — because
capabilities/default.json only covers `main`, and a webview without an
event grant fails `listen()` silently: the window shows but never hears
`recording-state`. Both invariants are locked by
`src/overlay-config.test.ts`. Its frontend is the tiny Overlay root (src/main.tsx
branches on `?window=overlay` before importing App) listening only to
`recording-state`/`audio-level`. Window transparency on macOS requires
Tauri's `macos-private-api` cargo feature + `macOSPrivateApi` config flag —
enabled deliberately: it affects compositing only and is NOT a TCC
permission surface (no prompt, no System Settings entry); the only cost is
Mac App Store ineligibility, which doesn't apply to this directly-signed
app.

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
Tauri, triage, inbox" plus every term of the user's `dictionary` from
`~/notes/.sideline.json` (`load_dictionary`, re-read on every
transcription — same failure tolerance as audio.rs's device read: missing/
malformed = empty; whisper's prompt window is ~224 tokens, plenty for a few
dozen terms). Output runs through the same Claude mis-hear correction
regexes as capture/voice-note.sh's perl pass (`clod`/`claw(ed)`/`clawd`/
`clode` → `Claude`/`Claude Code`), then the dictionary's corrections
(`build_corrections`: per term, one `(?i)\b(?:…)\b` alternation of its
regex-escaped mis-hearings, interior whitespace → `\s+`; a term with no
mis-hearings only biases the prompt) before `whisper::transcribe` returns —
this runs for BOTH modes, so `audio::finish_recording` branches
purely on destination: `RecMode::Note` appends via `append_inbox_text` as
before; `RecMode::Dictate` hands the corrected text to
`dictate::finish_dictation` and never touches inbox.md.

Dictation mode (`dictate.rs`): the clipboard write happens first and
unconditionally (`app.clipboard().write_text(...)` via the
`tauri-plugin-clipboard-manager` `ClipboardExt` trait, Rust-side), so the
transcript is never lost even if everything below fails. A plain write,
deliberately: hiding dictations from clipboard-history managers (Raycast,
Maccy, …) via the org.nspasteboard transient/concealed marker types was
built and then dropped, because that history is the recovery path when a
paste doesn't land where the user wanted. Then an Accessibility (AX) trust
check gates the synthetic paste.
Trusted (`AXIsProcessTrusted()`): a ~50ms settle delay, then a synthetic
⌘V — a `core-graphics` `CGEventSource` (HID system state) posts a
keycode-9 (kVK_ANSI_V) key-down + key-up, Command flag set, to the HID
event tap, so it lands on whatever app is currently frontmost (Sideline's
own windows never take focus, so this is never Sideline itself — see the
popover/overlay focus notes above). Not trusted:
`AXIsProcessTrustedWithOptions` is called with `kAXTrustedCheckOptionPrompt`
set, which triggers the one-time system Accessibility dialog, the paste is
skipped, and `capture-error` explains the text is on the clipboard for a
manual ⌘V. Both trust calls are declared by hand as `extern "C"` from the
`ApplicationServices` framework (no crate wraps them); no Info.plist key is
needed for Accessibility — macOS gates it entirely through System
Settings > Privacy & Security > Accessibility plus this API.

Either way `finish_dictation` returns `DictationOutcome::Copied`, which
routes to `audio::show_copied_notice`: the pill shows "Copied — ⌘V
to paste" for ~1.5s (`COPIED_NOTICE`) before a timer drops the state
machine back to Idle. EVERY dictation gets that notice — Sideline never
inspects the frontmost app or what it has focused. An AX focused-element
design was tried and dropped (2026-08-12) as both too invasive and
unworkable: `AXUIElementCreateSystemWide`'s focused-element query returns
`kAXErrorCannotComplete` unconditionally on current macOS, and Finder's
desktop answers `AXSelectedTextRange` exactly like a text field, so a
paste that landed nowhere is indistinguishable from one that landed. The
notice states the one thing that's always true: the text is on the
clipboard. `DictationOutcome::Failed` (clipboard write failed — nothing
to recover, error already emitted) skips the notice and goes straight to
Idle.

⌥⌘R (global hotkey, alongside ⌥⌘Space) and the tray menu's "Record voice
note" both call `audio::toggle_recording` directly, appending to inbox.md.
⌥⌘V and the tray menu's "Dictate to clipboard" call `audio::toggle_dictation`
the same way, routing to the clipboard/paste flow above instead — dictation
output is never appended to inbox.md, `notes/`, or `todos/`. Mic access
requires `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`, auto-merged
by Tauri) and `src-tauri/Entitlements.plist`
(`com.apple.security.device.audio-input`, wired via
`tauri.conf.json`'s `bundle.macOS.entitlements`). Accessibility (dictation's
auto-paste, above) is the one other TCC surface in the app — see CLAUDE.md's
"exactly ONE... plus Accessibility" convention bullet for why that's a
deliberate, discussed exception rather than scope creep.

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
`tauri-plugin-clipboard-manager` plugin (write-text only — frontend copy
actions plus dictation's transcript write) and dictation's synthetic-paste
path (`dictate.rs`, above) are the only other capabilities beyond notes
I/O.
