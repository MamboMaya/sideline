# Changelog

Notable, user-visible changes to Sideline. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/) (0.x: minor = new feature, patch = fix).

## [Unreleased]

### Added

- **Transcription dictionary** (Settings → Voice → Dictionary, or
  `dictionary` in `.sideline.json`): teach the transcriber your project
  vocabulary. One row per term with the ways it gets mis-heard — terms bias
  whisper toward the right spelling, mis-hearings are corrected after
  transcription (whole words, any case). Applies to the next recording, no
  restart; the Raycast capture script reads the same list.

### Fixed

- At any zoom other than 100%, the bottom of the popover was cut off (the
  last inbox card, Settings' Zoom section) — WebKit scales `100vh` by the
  zoom. The app now sizes itself against the real window height.
- ⌘+ / ⌘− / ⌘0 now work while Settings is open, so a too-large zoom can be
  undone without scrolling to the Zoom section.

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

[Unreleased]: https://github.com/MamboMaya/sideline/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MamboMaya/sideline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MamboMaya/sideline/releases/tag/v0.1.0
