# Sideline

macOS menu-bar app (Tauri 2 + React) for capturing and triaging quick notes.
⌥⌘R records in-app (cpal mic capture → whisper-rs local transcription) and
appends to `~/notes/inbox.md`; Sideline is also the live view + triage UI for
that file. The scripts in `capture/` are the optional external capture path
(Raycast).

## Map — read the doc that matches the task

- **docs/data-model.md** — every on-disk format (`inbox.md`, `notes/`,
  `todos/`, `archive.md`, `.sideline.json`). DO NOT change a format without
  updating the `capture/` scripts too.
- **docs/ui.md** — full UI behavior spec: views, every keyboard shortcut,
  tag system, triage flows, Todos view, status flow, undo. Covers
  `src/App.tsx` (shell), `src/components/`, `src/hooks/`, `src/keys/`, and
  `src/lib/`.
- **docs/backend.md** — `src-tauri/src/`: tray, hotkey, fs watcher, all
  Tauri commands and their validation rules; backend.md's Module map lists
  which file owns what.
- `src/inbox.ts` — parser/serializer for all three on-disk note formats
  (inbox.md, notes/*.md, todos/<project>.md). All format knowledge lives
  here; round-trips must be lossless for untouched entries.
- `capture/voice-note.sh` — Raycast record+transcribe script (ffmpeg
  avfoundation + whisper-cli); appends to inbox.md.

## Data model in one breath

Everything lives under `~/notes`. `inbox.md`: append-only capture file,
entry = `### <icon> YYYY-MM-DD HH:MM #tags` + body (🎙️/🔗/📸).
`notes/*.md`: triaged non-project notes, YAML frontmatter (`captured`,
`type`, `tags`, optional `title`, `status: triaged|done|iced`).
`todos/<project>.md`: routed project todos, `### ⬜|✅|🧊 <timestamp> #tags`,
never deleted, the ONLY record of a routed note; long entries may lead with a
`**title**` body line, re-routed ones may embed a `## Claude` reply.
`archive.md`: append-only deleted notes. `.sideline.json`: frontend config
(pinnedTags, hiddenTags, zoom, prompts, models, projects → routing tags).
Exact rules: docs/data-model.md.

## Commands

- `pnpm install` — once
- `pnpm tauri icon assets/icon.png` — regenerates `src-tauri/icons/` (once, or after icon changes)
- `pnpm tauri dev` — run the app
- `APPLE_SIGNING_IDENTITY="Apple Development: <Name> (<TEAMID>)" pnpm tauri build`
  — produce `Sideline.app`. ALWAYS build signed: a stable code-signing
  identity is what makes macOS remember TCC answers (mic, etc.) across
  rebuilds; unsigned rebuilds re-prompt every time (see README).
- `cargo check --release` (in `src-tauri/`) — type-check Rust. Always pass
  `--release`: a plain `cargo check` rebuilds the large `target/debug`
  cache that only `pnpm tauri dev` needs.

## Conventions

- No new macOS permission surfaces without discussion. The app needs exactly
  TWO TCC permissions — the microphone (in-app recording) and Accessibility
  (dictation mode's synthetic ⌘V auto-paste only, requested on first use,
  deliberately approved 2026-08-11) — and nothing else (no screen recording,
  no protected folders): notes I/O stays in `~/notes`. This covers child
  processes too: `send_to_claude` runs the `claude` CLI with
  `--setting-sources "" --strict-mcp-config` so no user hook/plugin/MCP
  server runs under Sideline's TCC identity (one touching ~/Documents would
  trigger a popup blamed on Sideline).
- Frontend mutations: parse → modify in TS → `write_inbox` full content.
  In-app voice capture is the exception: Rust `append_inbox_text` appends
  directly so it can't race frontend writes or external capture scripts.
- Never clobber triaged files; `triage_note` appends `-1`, `-2` on collision.
  `write_triaged` is the deliberate exception (in-place overwrite for the
  done-status flip) — it errors instead of writing if the file is missing,
  so it can never create a file outside the normal triage path.
- The only subprocesses besides `open` are the `claude` CLI calls from
  `send_to_claude` (absolute-path candidates, since Finder-launched apps
  don't inherit the shell PATH; non-interactive `-p` mode).
- All notes file access is confined to `~/notes` (see `validate_component`
  for single-component names, `confine` for the multi-component asset-ref
  case). The one path outside it is the Whisper model dir
  `~/.whisper-models/` (read + first-run download; shared with
  `capture/voice-note.sh`) — never widen further.
- Never use the `trash` crate (its macOS path triggers a Finder-automation
  TCC prompt) — plain `fs::remove_file` / rename into `~/.Trash` instead.
- Keep this file lean; put detail in `docs/` and update the matching doc
  when behavior changes.
