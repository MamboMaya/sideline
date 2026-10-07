# Sideline

Notes you take _on the side_ while the real work is happening. Sideline lives
in your macOS menu bar: press a hotkey, talk, and a locally-transcribed note
lands in your inbox — tag it, triage it into its own file, route it to a
project todo list, or delete it. Everything is plain Markdown under `~/notes`,
and nothing ever leaves your machine except the (optional) Claude-assisted
triage calls and quick questions.

What's new in each version: [CHANGELOG.md](CHANGELOG.md).

## What it does

- **Capture** (⌥⌘R): records a voice note, transcribes it on-device with
  Whisper (Metal-accelerated), and appends it to `~/notes/inbox.md`. The tray
  shows a live 🔴 REC timer; the popover shows a level meter.
- **Dictate anywhere** (⌥⌘V): same recording, but the transcript is copied to
  the clipboard and pasted into the frontmost app instead of the inbox. The
  auto-paste needs Accessibility (see [Permissions](#permissions)); without
  it, the text is still on the clipboard for a manual ⌘V.
- **Quick questions** (⌥⌘A, or `q` in the popover): speak or type a one-off
  question and get a short web-searched answer from Claude in the Ask tab.
  Nothing is written unless you save it with ⌘S; `o` continues the thread in
  your terminal. Needs the `claude` CLI.
- **Live inbox** (⌥⌘Space): every note appears the second it lands. Quick
  tags (`#bug` `#todo` `#idea`), pinned custom tags, `@project` tags, and
  keyboard-first triage.
- **Triage**: notes become YAML-frontmattered files in `~/notes/notes/`, or
  route to per-project todo lists in `~/notes/todos/` — optionally with
  Claude-generated headers (your existing `claude` CLI, cheap models).
- **Todos view**: grouped, collapsible, searchable, with done/icebox states
  and undo. Paste a screenshot onto a card (⌘V) and it's saved to
  `~/notes/inbox-assets/` and linked from the todo file.
- **Projects**: tray → Add project… (or Settings → Tags → Choose folder…)
  picks a repo folder, prefills the routing tag from its name, and can append
  the todos pointer to that repo's `CLAUDE.local.md` so a Claude Code session
  there knows where its routed notes live.
- **Voice extras**: a dictionary that biases Whisper toward your vocabulary
  and corrects mis-hearings, filler-word removal, and spoken lists ("first…
  second…", "bullet …") shown as bullets — all rule-based and instant, and
  the note on disk always keeps exactly what you said.
- **Settings in-app** (⌘,): remap all four hotkeys live, pick the mic,
  tune or disable Claude, manage tags and projects, zoom.

![Record a voice note, watch it land in the inbox, triage it to a project todo](assets/demo.gif)

_In the demo I record with ⌥⌘V instead of the default ⌥⌘R — all four
hotkeys are remappable in Settings (⌘,)._

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
after that, System Settings > General > Login Items is authoritative.

Optional: install the [`claude` CLI](https://claude.com/claude-code) to enable
Claude-assisted triage, note headers, and quick questions. Everything else
works without it.

### Using without Claude

Flip the Claude toggle off in Settings (⌘,), or set `"claude": false` in
`~/notes/.sideline.json`. Capture and transcription are already fully local;
with this set, triage stops calling out too and notes get locally-derived
headers (the note's own first line). Quick questions are the one thing that
genuinely needs the CLI.

## Permissions

Sideline needs exactly **two** macOS permissions: the microphone, asked once
on your first recording, and Accessibility, asked once on your first
dictation (⌥⌘V) — used only for the synthetic ⌘V that auto-pastes the
transcript. Decline it and dictation still works via the clipboard.
Everything else is deliberately prompt-free: notes live in `~/notes`, which
is not a TCC-protected folder (Documents/Desktop/Downloads are; that's why
the location is fixed). The "Add project" folder picker is macOS's own
dialog; Sideline stores the path and never reads or writes inside that
folder — the repo setup script runs in your terminal, under its permissions.

If you rebuild the app yourself, sign it with a stable identity so macOS
remembers your permission answers across builds:

```bash
APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm tauri build
```

Without it, each rebuild is a "new app" to macOS and the mic prompt returns
once per build. Any Apple Development certificate works, including the free
one from Xcode.

## Alternative capture: external scripts

`capture/` contains shell scripts for capturing _without_ the app — handy if
you want recording off the app's permission identity or you live in Raycast:

- `voice-note.sh` — Raycast toggle: record (ffmpeg) → transcribe (whisper-cli)
  → append. Needs `brew install ffmpeg whisper-cpp` and the model file.
- `link-note.sh` — Raycast: append the frontmost Google Chrome tab's title
  and URL as a 🔗 entry. Reads the tab via AppleScript; macOS will ask once
  whether to let Raycast control Chrome (a permission for Raycast, not
  Sideline).
- `delete-last-note.sh` — remove the most recent inbox entry.

## Configuration

`~/notes/.sideline.json` holds every setting (tags, hotkeys, Claude
prompts/models, project routing, mic, zoom, …). The Settings pane (⌘,)
edits all of it live; it's plain JSON if you'd rather hand-edit (hotkey edits
made that way need a restart). Schema in
[docs/data-model.md](docs/data-model.md).

## Docs

- [CHANGELOG.md](CHANGELOG.md) — what changed in each version
- [docs/data-model.md](docs/data-model.md) — every on-disk format
- [docs/ui.md](docs/ui.md) — views, all keyboard shortcuts (or press `?` in-app)
- [docs/backend.md](docs/backend.md) — tray, hotkeys, watcher, Tauri commands

Working on it with Claude Code? `CLAUDE.md` is the session entry point.

## License

[MIT](LICENSE)
