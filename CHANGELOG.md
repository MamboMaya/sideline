# Changelog

Notable, user-visible changes to Sideline. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/) (0.x: minor = new feature, patch = fix).

## [Unreleased]

### Added

- Screenshots on cards: copy a screenshot (⌃⇧⌘4), select a card in the Todos
  view, and press ⌘V to attach it — or paste while editing any note (`e`).
  The image is saved to `~/notes/inbox-assets/` and shows as a thumbnail on
  the card; click it to open the full image in Preview.

## [0.5.0] - 2026-09-16

### Added

- Add a project with the mouse: tray menu "Add project…" or Settings → Tags →
  "Choose folder…" opens the native folder picker, prefills the routing tag
  from the folder name, pins it (optional), and then sets the repo up:
  "Set up repo in Terminal" runs a small script in your terminal that
  appends the `CLAUDE.local.md` todos pointer (or copy the command and run
  it yourself). No new permissions — Sideline only stores the path; the
  terminal does the write.

## [0.4.0] - 2026-09-16

### Added

- **Quick question / Ask view** (⌘3 or the header's "Ask" tab; `q` opens it,
  ⌥⌘A speaks a question straight into it): ask Claude a one-off question
  with web search enabled, without leaving Sideline. Threads persist for
  the whole session, newest first — asking again, or switching away and
  back, never loses an earlier question or answer. `↑`/`↓` select a
  thread, `c` copies its answer, `x` removes it; each thread also has its
  own Copy / Save to inbox / ✕ buttons, and `⌘S` saves the selected
  thread's answer to the inbox as a ❓ entry. Answers are kept short (about
  60 words, one source); `o` / "Continue in Terminal" resumes that answer's
  Claude session interactively in Terminal for a deeper follow-up
  (iTerm2 and other terminals auto-detected; Settings → Claude → Continue
  in). Model configurable in Settings → Claude → Question model (default
  Sonnet).

## [0.3.0] - 2026-09-08

### Added

- **Transcription dictionary** (Settings → Voice → Dictionary, or
  `dictionary` in `.sideline.json`): teach the transcriber your project
  vocabulary. One row per term with the ways it gets mis-heard — terms bias
  whisper toward the right spelling, mis-hearings are corrected after
  transcription (whole words, any case). Applies to the next recording, no
  restart; the Raycast capture script reads the same list.
- **Link capture** (Raycast `capture/link-note.sh`): appends the frontmost
  Chrome tab as a 🔗 entry (title + URL) to the inbox.
- **Hide the recording pill** (Settings → Voice → Show recording pill): turn
  the on-screen pill off, e.g. while screen sharing; the tray 🔴 REC timer
  still shows.
- **Add to dictionary from a note**: select a mis-heard word while editing a
  note and a bar offers to add it to the transcription dictionary with the
  right spelling, fixing the note at the same time.
- **Hold to record** (Settings → Voice): push-to-talk mode — hold the
  record or dictate hotkey to record, release to transcribe. Off by
  default; the tray menu still toggles.

### Changed

- The recording pill now shows a **Capture** badge in orange for voice
  notes, matching the dictate pill's layout, so the two modes read the
  same way at a glance.
- **Triage all** is keyboard-only now (Shift+T) and asks for a second
  Shift+T to confirm; the header button is gone.
- Settings: the triage/batch model fields are dropdowns (haiku, sonnet,
  opus, or the default) instead of free text, and the input-device picker
  sits on its own line — it used to be squeezed out of view by its hint.
- Settings → Hotkeys: shortcuts render as macOS key caps in fixed-width
  fields (dashed while at the default), with a "default ⌥⌘R · reset" line
  only under a changed key and one instruction hint for the section.

### Fixed

- At any zoom other than 100%, the bottom of the popover was cut off (the
  last inbox card, Settings' Zoom section) — WebKit scales `100vh` by the
  zoom. The app now sizes itself against the real window height.
- ⌘+ / ⌘− / ⌘0 now work while Settings is open, so a too-large zoom can be
  undone without scrolling to the Zoom section.
- Clicking a card now selects it, so `t`/`d`/`e` and the arrows act on the
  card you clicked.

## [0.2.0] - 2026-08-13

### Added

- **Dictation mode** (⌥⌘V by default): record and transcribe like a capture,
  but the transcript goes to the clipboard and auto-pastes into the frontmost
  app instead of the inbox. Auto-paste uses a synthetic ⌘V and asks once for
  the Accessibility permission; without it, dictation still lands on the
  clipboard. Every dictation ends with the pill showing "Copied — ⌘V to
  paste", so a paste that went nowhere is never lost.
- **Settings pane** (⌘, or the header gear): remap the three global hotkeys
  live, pick the input mic, toggle/tune Claude triage, manage tags, adjust
  zoom — everything `.sideline.json` holds, editable in-app.
- Project triage routes instantly; Claude-written headers backfill in the
  background instead of blocking the route.

### Fixed

- Crash on quit after a transcription (ggml Metal exit abort).
- Launching a second instance no longer puts up a duplicate tray icon.

## [0.1.0] - 2026-08-05

Initial public release: hotkey voice capture (⌥⌘R) with local Whisper
transcription into `~/notes/inbox.md`, live inbox popover (⌥⌘Space) with
tag-based keyboard-first triage, per-project todo routing, Todos view,
optional Claude-assisted headers (with a no-Claude mode), floating recording
pill, and Raycast capture scripts.

[Unreleased]: https://github.com/MamboMaya/sideline/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/MamboMaya/sideline/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MamboMaya/sideline/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MamboMaya/sideline/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MamboMaya/sideline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MamboMaya/sideline/releases/tag/v0.1.0
