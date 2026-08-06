# Sideline

Notes you take _on the side_ while the real work is happening. Sideline lives
in your macOS menu bar: press a hotkey, talk, and a locally-transcribed note
lands in your inbox — tag it, triage it into its own file, route it to a
project todo list, or delete it. Everything is plain Markdown under `~/notes`,
and nothing ever leaves your machine except the (optional) Claude-assisted
triage calls.

## What it does

- **Capture**: global hotkey (⌥⌘R) records a voice note, transcribes it
  on-device with Whisper (Metal-accelerated), and appends it to
  `~/notes/inbox.md`. The tray shows a live 🔴 REC timer; the popover shows a
  level meter so you know the mic is hot.
- **Live inbox**: the popover (⌥⌘Space) shows every note the second it lands.
  Quick tags (`#bug` `#todo` `#idea`), pinned custom tags, and `@project` tags
  with keyboard-first triage.
- **Triage**: notes become YAML-frontmattered files in `~/notes/notes/`, or
  route to per-project todo lists in `~/notes/todos/` — optionally with
  Claude-generated headers (uses your existing `claude` CLI, non-interactive,
  cheap models).
- **Todos view**: grouped, collapsible, searchable, with done/icebox states
  and undo.

<!-- demo GIF goes here: assets/demo.gif -->

## How this was built

I designed and built Sideline over roughly two weeks of supervised Claude
Code sessions. `CLAUDE.md` at the repo root is the standing contract those
sessions follow. Every change is gated by CI: tsc, Biome, Prettier
(markdown/YAML), vitest, cargo fmt, cargo test, and clippy with warnings as
errors — 260+ tests in total. The public history starts from a single
squashed commit; the working history lived locally.

## Setup

```bash
# Prereqs (skip any you have)
xcode-select --install          # Rust needs the Command Line Tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # install Rust
brew install node pnpm cmake        # cmake builds whisper.cpp

git clone https://github.com/MamboMaya/sideline.git
cd sideline
pnpm install
pnpm tauri build
# → src-tauri/target/release/bundle/macos/Sideline.app — drag it into /Applications
```

First build takes 10–15 minutes (it compiles whisper.cpp). The first recording
downloads the Whisper model (~148 MB) to `~/.whisper-models/`. macOS 10.15
(Catalina) or later; Apple Silicon recommended (transcription runs on Metal).

On first launch, Sideline asks once whether to launch automatically at login;
after that, System Settings > General > Login Items is authoritative (change
it there anytime).

Optional: install the [`claude` CLI](https://claude.com/claude-code) to enable
Claude-assisted triage and note headers. Everything else works without it.

### Using without Claude

No `claude` CLI or subscription? Set `"claude": false` in
`~/notes/.sideline.json`. Capture and transcription are already fully local
(Whisper); with this set, triage stops calling out too — notes file with
locally-derived headers (the note's own first line) instead of Haiku-written
ones, and no `## Claude` reply appendix.

## Permissions

Sideline needs exactly **one** macOS permission: the microphone, asked once on
your first recording. Everything else is deliberately prompt-free — notes live
in `~/notes`, which is not a TCC-protected folder (Documents/Desktop/Downloads
are; that's why the location is fixed).

If you rebuild the app yourself, sign it with a stable identity so macOS
remembers your permission answers across builds:

```bash
APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm tauri build
```

Without it, each rebuild is a "new app" to macOS and the mic prompt returns
once per build. (Any Apple Development certificate works, including the free
one from Xcode.)

## Alternative capture: external scripts

`capture/` contains shell scripts for capturing _without_ the app — handy if
you want recording off the app's permission identity or you live in Raycast:

- `voice-note.sh` — Raycast toggle: record (ffmpeg) → transcribe (whisper-cli)
  → append. Needs `brew install ffmpeg whisper-cpp` and the model file.
- `delete-last-note.sh` — remove the most recent inbox entry.

## Configuration

`~/notes/.sideline.json` — pinned tags, hidden tags, zoom, triage prompts and
models, project routing, the no-Claude toggle, audio input device. Schema in
[docs/data-model.md](docs/data-model.md).

## Docs

- [docs/data-model.md](docs/data-model.md) — every on-disk format
- [docs/ui.md](docs/ui.md) — views, all keyboard shortcuts (or press `?` in-app)
- [docs/backend.md](docs/backend.md) — tray, hotkeys, watcher, Tauri commands

Working on it with Claude Code? `CLAUDE.md` is the session entry point.

## License

[MIT](LICENSE)
