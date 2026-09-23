# Data model — DO NOT change without updating capture/ scripts too

- **`~/notes/inbox.md`** — single append-only capture file. One entry per note:

  ```
  ### 🎙️ 2026-07-29 14:32 #bug #kafka
  The consumer group keeps rebalancing when...
  ```

  Entry = a line starting with `### `, then body lines until the next `### `.
  Header: icon, `YYYY-MM-DD HH:MM` timestamp, optional inline `#tags`.
  Icons: 🎙️ voice, 🔗 link, 📸 screenshot, ❓ saved quick question (body is
  `**question**` then a blank line then the answer — see docs/ui.md's Quick
  question section). The parser is icon-agnostic —
  🎙️ comes from in-app recording, 🔗 from `capture/link-note.sh` (body:
  page title line, then URL line — title omitted if empty), 📸 remains
  reserved for hand-written entries or a future capture path, and ❓ is
  appended by `append_inbox_entry` (⌘S in the Ask pane) rather than going
  through the normal read-modify-write `write_inbox` path.
  Arbitrary text above the first `### ` entry (e.g. a hand-written comment)
  is a preamble, preserved verbatim by every rewrite
  (`parseInbox`/`serializeInbox` in `src/inbox.ts`).

- **`~/notes/inbox-assets/`** — screenshot PNGs, referenced from entries as
  relative markdown image links (`![screenshot](inbox-assets/shot-....png)`,
  path relative to `~/notes`). Written by the app's ⌘V paste
  (`shot-YYYYMMDD-HHMMSS.png`, docs/ui.md's "Screenshots on cards"); a link
  is an ordinary body line in all three note formats, so it survives
  triage, routing, and archiving with its note. Files are write-once and
  only ever removed by Purge Archive.

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

- **`~/notes/.sideline-continue.command`** — scratch launcher rewritten on
  every Ask-view "Continue in Terminal" (`open_ask_session`, docs/backend.md):
  a two-line zsh script that resumes one `claude` CLI session. Safe to
  delete at any time; never read back.
- **`~/notes/.sideline-reminders.json`** — reminders auto-detected in note
  bodies (see docs/ui.md's Reminders section): a JSON array of
  `{ id, text, due_ms, note_timestamp, fired, dismissed }`. `id` is the
  source note's own timestamp (or timestamp+icon on the rare collision of
  two notes captured in the same minute), so re-scanning the SAME note on a
  later reload — even after it's been edited — resolves to the same
  reminder: an unchanged note is a no-op, an edited one upserts in place
  (`reminders::upsert`, `src-tauri/src/reminders.rs`), and an edit that
  removes whatever made the note parse as a reminder drops the not-yet-fired
  entry (`remove_reminder`). A reminder is never removed just because its
  source note leaves the inbox (triaged or deleted) — once registered, it
  stands on its own. Written atomically, each write to its own uniquely-
  named temp file (pid + a counter, not a shared fixed name — the
  background ticker and a command can write concurrently) and guarded by a
  process-wide lock across every read-modify-write; a dismissed entry is
  pruned once its `due_ms` is more than 24h in the past, on every write.
  Never read or written by `capture/` scripts — detection runs frontend-side
  against whatever `read_inbox` just returned, so it covers in-app voice,
  typed notes, and external Raycast captures alike without any capture-side
  changes.
- **`~/notes/.sideline.json`** — app config: `{ "pinnedTags": [...] }` (up to 6
  pinned tags), optional `"hiddenTags": [...]` (tags deleted from
  autocomplete via the suggest dropdown's ✕ — excluded from suggestions and
  the auto-tagger; notes already carrying one keep it), optional `"zoom"`
  (0.7–1.5 UI scale, ⌘+/⌘-/⌘0, omitted at
  1), optional `"prompts": { "triage": "...", "batch": "..." }`
  overriding the built-in triage/batch-triage prompt templates, optional
  `"models": { "triage": "haiku", "batch": "haiku", "ask": "sonnet" }`
  (Haiku is the default for triage/batch — triage just files and routes;
  `ask` — the Quick question / Ask view, docs/ui.md — defaults to Sonnet instead,
  since a web-search answer needs more judgment than Haiku reliably gives),
  and optional
  `"projects": { "<tag>": "<repo path>" }` or a plain array of tags — opts
  a tag into todo routing. Only the tag itself matters; the path is
  informational (what the folder-picked "Add project" flow stores, see
  docs/ui.md's Settings section — a typed tag gets `""`, or the array
  shape) and is never read or written to. Also
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
"record": "alt+cmd+r", "dictate": "alt+cmd+v", "ask": "alt+cmd+a" }` —
  human-friendly combo strings for the four global shortcuts (`dictate`
  triggers the same record→transcribe pipeline as `record`, but the
  transcript is copied to the clipboard and auto-pasted into the frontmost
  app instead of being appended to inbox.md; `ask` shows the popover,
  switches to the Ask view (`ask-open`), and starts a spoken question — the
  recorder's `ask` mode — whose finished transcript arrives as
  `ask-transcript` — see docs/backend.md and docs/ui.md; aliases:
  `cmd`/`command`/`super`/`meta`, `opt`/`option`/`alt`, `ctrl`/`control`,
  `shift`; key token is a bare letter/digit/`space` or a W3C `Code` name like
  `F5`/`Comma`); missing or invalid falls back to the
  ⌥⌘Space/⌥⌘R/⌥⌘V/⌥⌘A default, read once at startup — changing it needs an
  app restart to take
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
  `"terminal": "iTerm"` (default: absent = auto) — the macOS app name
  (`open -a` name) Ask's "Continue in Terminal" (`o`, `open_ask_session`)
  opens the resumed session in (Settings → Claude → "Continue in"); absent
  lets Rust auto-pick the first installed terminal from its own preference
  list (iTerm2 first, Terminal always last and always available — see
  `list_terminals` in docs/backend.md). Also optional
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
  Raycast captures get the identical prompt and corrections. Also optional
  `"staleDays": 5` (default 3, positive integer; `0` turns the feature off) —
  an inbox note at least this many whole days old gets an amber age badge on
  its card and counts toward the header's "N stale" badge (Settings → Inbox
  — see docs/ui.md's Views & navigation and Settings sections,
  `src/lib/stale.ts`). Frontend-only — no Rust command reads or writes it;
  recomputed on inbox reload and at least hourly, never from a file watch. Also optional
  `"cleanFillers": false` (default `true`) — filler-word cleanup for in-app
  voice transcripts (Settings → Voice → "Remove filler words (um, uh,
  repeats)"): strips hesitation words (um, uh, erm, hmm, ...), comma-delimited
  discourse fillers ("you know", "I mean", "like", "sort of", "kind of"), and
  immediate stutter repeats, purely rule-based (no network call, no LLM — see
  `src-tauri/src/cleanup.rs`). Runs in `finish_recording` (audio.rs) after the
  dictionary corrections above and before the Note/Dictate/Ask hand-off; read
  Rust-side fresh on every recording, same as `dictionary`. Absent or a
  non-boolean value both mean enabled — `false` is the only way to keep the
  raw (dictionary-corrected) transcript. `capture/voice-note.sh` does NOT
  read this key, so external Raycast captures are never cleaned up. Also optional
  `"classifier": { "provider": "off"|"claude"|"local", "url":
"http://127.0.0.1:4410" }` (default `provider: "off"`, `url:
"http://127.0.0.1:4410"`; missing or invalid = off = today's keyword-only
  auto-tagging, unchanged) — auto-tags inbox notes with a type
  (bug/todo/idea) and, if any projects are configured, a project, on top of
  the existing keyword auto-tagger (src/lib/autotag.ts): `"claude"` sends
  one `send_to_claude` call per note (`models.triage`, respects `"claude":
false`); `"local"` POSTs to `<url>/decide` on a local classifier (a
  loopback-only HTTP decision service — see `classify_local` in
  docs/backend.md) and only accepts an answer at/above a confidence
  threshold. Either way, a tag is only added if the note doesn't already
  carry one of that kind, and a tag the user removed this session is never
  re-added (src/lib/classify.ts). `url` must be `http`/`https` and resolve to
  127.0.0.1/localhost/::1 — enforced both in the Settings pane and by
  `classify_local`/`classifier_health` Rust-side, so a note's text never
  leaves the machine. Frontend-owned
  schema (the `audio` key is read/written Rust-side by audio.rs, `hotkeys`
  is read-only Rust-side at startup by lib.rs — the Settings pane's
  live-apply path is the one exception, reading it only via the frontend's
  already-loaded config state, never re-reading the file itself; `overlay`
  is read-only Rust-side by window.rs, on every sync rather than once at
  startup; `pushToTalk` is read-only Rust-side by lib.rs's global-shortcut
  handler, fresh on every keypress; `dictionary` and `cleanFillers` are
  read-only Rust-side by whisper.rs and audio.rs respectively, fresh on every
  transcription/recording — everything
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
