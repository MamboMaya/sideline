# Data model — DO NOT change without updating capture/ scripts too

- **`~/notes/inbox.md`** — single append-only capture file. One entry per note:

  ```
  ### 🎙️ 2026-07-29 14:32 #bug #kafka
  The consumer group keeps rebalancing when...
  ```

  Entry = a line starting with `### `, then body lines until the next `### `.
  Header: icon, `YYYY-MM-DD HH:MM` timestamp, optional inline `#tags`.
  Icons: 🎙️ voice, 🔗 link, 📸 screenshot. The parser is icon-agnostic —
  🎙️ comes from in-app recording, 🔗 from `capture/link-note.sh` (body:
  page title line, then URL line — title omitted if empty), and 📸 remains
  reserved for hand-written entries or a future capture path.
  Arbitrary text above the first `### ` entry (e.g. a hand-written comment)
  is a preamble, preserved verbatim by every rewrite
  (`parseInbox`/`serializeInbox` in `src/inbox.ts`).

- **`~/notes/inbox-assets/`** — screenshot PNGs, referenced from entries as
  relative markdown image links (`![screenshot](inbox-assets/shot-....png)`).

- **`~/notes/notes/`** — non-project triaged notes, one file each, named
  `YYYY-MM-DD-<slug-from-content>.md`, with YAML frontmatter
  (`captured`, `type`, `tags`, optional `title` — a Haiku-generated header
  for notes longer than ~2 rows, shown above the body in the Todos view —
  and `status` — `triaged`, `done`, or `iced`;
  iced = deliberately parked, pooled into the Todos view's 🧊 icebox
  section). Triage = write file here + remove
  block from inbox.md. Batch triage can also produce a group roundup file,
  `<date>-<tag>-roundup.md` — multiple captures sharing a first tag merged
  into one file with one merged `## Claude` reply (extra frontmatter:
  `notes: <count>`, `captured` as an earliest–latest range). A
  project-tagged note is never filed here — see `todos/<project>.md` below,
  its only record.

- **`~/notes/archive.md`** — append-only archive of deleted notes, same entry
  format as inbox.md.

- **`~/notes/.sideline.json`** — app config: `{ "pinnedTags": [...] }` (up to 6
  pinned tags), optional `"hiddenTags": [...]` (tags deleted from
  autocomplete via the suggest dropdown's ✕ — excluded from suggestions and
  the auto-tagger; notes already carrying one keep it), optional `"zoom"`
  (0.7–1.5 UI scale, ⌘+/⌘-/⌘0, omitted at
  1), optional `"prompts": { "triage": "...", "batch": "..." }`
  overriding the built-in triage/batch-triage prompt templates, optional
  `"models": { "triage": "haiku", "batch": "haiku" }` (Haiku is the default
  for both — triage just files and routes), and optional
  `"projects": { "<tag>": "<repo path>" }` (legacy shape, path unused) or a
  plain array of tags — opts a tag into todo routing. Only the
  tag itself matters; no repo path is ever read or written to. Also
  optional `"claude": false` (default `true`) — no-Claude mode: every
  non-project triage flow (single-note and batch) skips `send_to_claude`
  entirely, deriving titles locally instead of a Haiku call (first
  non-empty line of the body, sanitized) and filing notes plain with a
  normal success toast — for users without the `claude` CLI or a
  subscription (see docs/ui.md's Triage section). Also
  optional `"audio": { "device": "<substring>" }` — case-insensitive
  substring match against the system's input device names, picking the
  in-app recorder's mic (see docs/backend.md); omitted = system default
  input device. Also optional `"hotkeys": { "toggle": "alt+cmd+space",
"record": "alt+cmd+r", "dictate": "alt+cmd+v" }` — human-friendly combo
  strings for the three global shortcuts (`dictate` triggers the same
  record→transcribe pipeline as `record`, but the transcript is copied to
  the clipboard and auto-pasted into the frontmost app instead of being
  appended to inbox.md — see docs/backend.md; aliases:
  `cmd`/`command`/`super`/`meta`, `opt`/`option`/`alt`, `ctrl`/`control`,
  `shift`; key token is a bare letter/digit/`space` or a W3C `Code` name like
  `F5`/`Comma`); missing or invalid falls back to the ⌥⌘Space/⌥⌘R/⌥⌘V
  default, read once at startup — changing it needs an app restart to take
  effect, UNLESS it's changed through the Settings pane's Hotkeys section
  (the gear button in the header), which additionally calls the
  `apply_hotkeys` command to swap the OS-level registration live, no
  restart needed (see docs/backend.md); a hand-edit to this file directly
  still only takes effect on next launch. Also optional `"overlay": {
"hidden": true }` (default `false`) — hides the recording-pill overlay
  entirely (Settings → Voice → "Show recording pill"), e.g. while screen
  sharing; the tray's 🔴 REC timer still shows either way. Unlike `hotkeys`,
  this is read Rust-side by window.rs's `sync_overlay` fresh on EVERY
  recording-state transition (see docs/backend.md), so a Settings toggle —
  or a hand-edit — applies immediately, including hiding an
  already-visible pill mid-recording; no restart. Also optional
  `"pushToTalk": true` (default `false`) — push-to-talk mode for the
  record/dictate hotkeys: hold the hotkey down to record, release to
  transcribe, instead of press-to-start/press-to-stop (Settings → Voice →
  "Hold to record"). Unlike `hotkeys`, this is read Rust-side by lib.rs's
  global-shortcut handler fresh on every keypress rather than once at
  startup, so a Settings toggle — or a hand-edit — takes effect on the very
  next press, no restart; the tray menu's "Record voice note"/"Dictate to
  clipboard" items always toggle, in either mode. Also optional
  `"dictionary":
{ "Tauri": ["towery", "tory"], "Raycast": ["ray cast"], "Whisper": [] }`
  — the transcription vocabulary, correctly-spelled term → the ways whisper
  mis-hears it (may be empty). Every term is appended to whisper's
  initial prompt (biasing it toward that spelling); every mis-hearing is
  replaced by its term after transcription — whole words, case-insensitive,
  literal (not regex), interior spaces matching any whitespace — after the
  built-in Claude corrections (see docs/backend.md). Read from the file on
  EVERY transcription, so a Settings-pane edit (Voice → Dictionary, one row per term) applies to the next recording
  with no restart; `capture/voice-note.sh` reads the same key via jq so
  Raycast captures get the identical prompt and corrections. Frontend-owned
  schema (the `audio` key is read/written Rust-side by audio.rs, `hotkeys`
  is read-only Rust-side at startup by lib.rs — the Settings pane's
  live-apply path is the one exception, reading it only via the frontend's
  already-loaded config state, never re-reading the file itself; `overlay`
  is read-only Rust-side by window.rs, on every sync rather than once at
  startup; `pushToTalk` is read-only Rust-side by lib.rs's global-shortcut
  handler, fresh on every keypress; `dictionary` is read-only Rust-side by
  whisper.rs — everything
  else by src/App.tsx); the ONLY key a capture/ script reads is
  `dictionary` (voice-note.sh, read-only) — none writes the file.

- **`~/notes/todos/<project>.md`** — todo entries routed from triage, one
  file per project tag (`project` IS the tag — no repo path involved).
  Project-tagged notes skip Claude entirely (see docs/ui.md), so a
  routed entry is the raw note only, in the same block shape as inbox.md
  but with a status-marker icon instead of a capture-source icon:
  `### ⬜ <timestamp> #tags` pending, `### ✅` done, `### 🧊` iced
  (deliberately parked: excluded from the copy bundle, and agent sessions
  working a project's queue should skip it). A long
  entry (>2 rows at capture) may carry a Haiku-generated header stored as a
  leading `**title**` body line — display-parsed back out, plain markdown to
  every other consumer. A re-routed entry (project tag added to an
  already-triaged note) may also carry the earlier triage reply embedded in
  its body under a `## Claude` line. Entries
  are never deleted, so this file is history and queue at once. This is the
  ONLY record of a routed note — triage never also
  writes a `notes/` file for it (a pre-existing duplicate from before this
  rule is left alone). Lives entirely inside
  `~/notes` — Sideline never writes to the project repo itself; a repo opts
  in to reading its queue by adding one line to its own CLAUDE.md —
  `Pending Sideline todos: ~/notes/todos/<tag>.md — flip ⬜→✅ when done` —
  and a Claude session working there flips the marker directly in the file
  (or works from the Todos view's `⧉ Copy` bundle, which pastes just the
  pending entries with markers stripped).

- Deleting a note = remove its block from inbox.md and append it to
  `~/notes/archive.md` (append-only, same entry format); referenced assets
  stay in `inbox-assets/` so archived links keep working. Nothing is
  hard-deleted in daily use. The ONE deliberate exception: the tray menu's
  "Purge Archive…" (native confirm → empties archive.md; screenshots
  referenced only by the archive move to the macOS Trash via plain rename —
  no Finder automation, no TCC prompt; the Trash is the final safety net).
