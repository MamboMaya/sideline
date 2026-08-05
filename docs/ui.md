# UI behavior

`src/inbox.ts` is the parser/serializer for all three on-disk note formats
(inbox.md, notes/*.md, todos/<project>.md); round-trips must be lossless for
untouched entries. Where the rest of the code lives: `src/App.tsx` (state
wiring, the shell), `src/components/` (rendering), `src/hooks/` (state/data
logic, one hook per concern), `src/keys/` (the keyboard layer — keymap
tables in `keymaps.ts`, dispatch in `useKeyboard.ts`), `src/lib/` (pure
helpers: formatting, commands, config, batch, archive, autotag). Everything
below is a behavior spec over that surface, not a file-by-file walkthrough.

## Views & navigation

Card list (newest first). Two views, toggled by `s`, jumped to by `⌘1`/`⌘2`,
or the header tabs (`Inbox (N)` / `Todos (P)`). `Esc` hides the popover from
any view — open layers like the shortcuts panel or tag input absorb one Esc
first; `?` toggles a shortcuts panel. Reopening the popover resets
scroll/selection/search to the top but keeps the last-used tab; tab switches
within one open session keep their place. `/` opens a compact header search
input filtering the active view's list (body + tags +, in a todo row, project
name); `Esc` on the input itself clears and closes it first. `⌘+`/`⌘-` step
UI zoom 0.7–1.5 (`⌘0` resets; persisted as `zoom` in .sideline.json, applied
as CSS zoom on body). `r` toggles in-app voice recording from either view —
the same action as the ⌥⌘R global hotkey, but only while the popover has
focus.

## Tags

Quick-tag chips (`QUICK_TAGS = ["bug", "todo", "idea"]`, keys `1-3`,
independent checkboxes — a note can hold several quick tags at once; rendered
set apart from custom tags — amber-tinted, filled when active); pinned tags
keys `4-9`, six slots; every tag is capped at 24 chars by `sanitizeTag`. A
PROJECT tag renders as `@tag` in blue — `tagLabel` helper +
`.tag.project`/`.suggest-tag.project` — at every display site incl. Todos
project section headers and autocomplete rows, DISPLAY-ONLY: stored/serialized
form stays `#tag` on disk and in copy bundles; quick tags always `#`. An
active (on) project chip fills solid blue (`.tag.project.on`), mirroring
the amber fill of active non-project chips.

Chip class assignment is two families only: project tags = blue outline,
filled blue when active; every other tag (quick and custom alike — they
deliberately share one look) = grey outline inactive, filled amber active.
It's centralized in one `tagChipClass(tag, active)` helper next to
`tagLabel`, so every chip site — Inbox card tags, pinned-tag chips, and all
four Todos card-tag sites (project rows and tag-section rows) — resolves
the same classes off the same lookups (`projectTags`, active state) instead
of each view reimplementing the ternary. Project section headers in Todos render the
project name in a `.project-name` span so it reads blue like `.tag.project`
rather than inheriting the header's default amber.

On every reload, the app auto-tags each note in code (regex vs known tags:
inbox ∪ archive ∪ pinned ∪ project tags ∪ quick tags, no Claude call) —
case-insensitive whole-word match that tolerates one space/hyphen between the
tag's letters ("to do" → `#todo`, "side line" → `#sideline`), applied once per
note per app run (tracked by `note.raw` in a `useRef` Set) — and a tag the
user manually removes is remembered (`removedTagsRef`, keyed timestamp::tag)
so the auto-tagger never re-adds it that session, even though removal changes
`note.raw`.

`a` opens the tag editor in BOTH views (Todos: on the selected row of either
kind; chips on Todos cards are click-to-remove) — the shared autocomplete
offers a "create" row for a brand-new typed tag with a 📌 that creates AND
pins in one stroke (⌘Enter does the same from the keyboard), per-row 📌
pin/unpin plus ✕ delete (adds the tag to `hiddenTags`; quick tags show
neither button). Adding a PROJECT tag to a triaged note RE-ROUTES it: the
notes/ file is removed and the note becomes a pending ⬜ entry in
`todos/<project>.md` (reply preserved inside the entry body under `## Claude`;
a long note missing a header gets one generated at re-route; undo restores
both files).

## Triage

Triage (✓ / `t`) and delete (✕ / `x`) per card. Untagged notes cannot be
triaged: `t` toasts "tag it first" and batch triage leaves them in the inbox
(reported as "N untagged left") — only `x` (archive) moves an untagged note
out. Triage is instant — no Claude call at all — for project-tagged notes,
which append a pending entry to that project's `~/notes/todos/<tag>.md`;
Claude (`prompts.triage` / `models.triage`, default Haiku) still runs for
everything else. Batch triage (`Shift+T` / "✨ All (N)" button) triages the
whole inbox in one pass: project-tagged notes route instantly as above, and
every other note is triaged in a single `send_to_claude` call
(`prompts.batch` / `models.batch`, default Haiku) instead of one call per
note. A card mid-triage is unmistakable: pulsing amber border + a "Triaging…"
badge while it's in the `sending` set.

A note tagged with a routing project (`projectTags`, from `.sideline.json`'s
`projects`) is filed ONLY to `~/notes/todos/<project>.md` — triage never also
writes a `notes/` file for it, so there's one record per routed note, not
two. Batch triage groups the non-project remainder by first tag before the
single `send_to_claude` call: a 2+ note group gets one merged reply and one
combined roundup file instead of one reply/file per note; a parse miss or
whole-call failure falls back to per-note plain filing so nothing's ever
stuck (a project group whose `write_todos` call fails gets the same
plain-filing fallback, exceptionally, so a routed note is never stuck
either).

HEADERS: any note longer than ~2 rows (3+ non-blank lines or >120 chars) gets
a Haiku-generated `title` at triage via ONE extra `send_to_claude` call per
triage action (numbered bodies in, `<n>: <headline>` lines out; runs
concurrently with the main call, failure = no header, never a stuck note) —
stored as frontmatter `title:` on triaged files and a leading `**title**`
body line on todo entries. A titled card leads with the 14px bold headline
and clamps the raw body to ONE grey line until expanded — Enter or card click
toggles, for BOTH row kinds (`todoExpanded` joins `triagedExpanded`,
session-only; chip/tag clicks don't toggle). Titles are searchable and ride
along in the copy bundles. This is the one exception to $0 project routing
(short routed notes still route with no Claude call); group roundup files
skip it — the tag names them. Re-route (see Tags) generates a missing header
too.

## Todos view

The merged **Todos** view — one post-triage view over both `~/notes/notes/*.md`
and `~/notes/todos/*.md`, refetched fresh on every switch into it (the fs
watcher doesn't cover `notes/` or `todos/`). Sections, in order: (1) project
sections, one per `todos/<project>.md`, A-Z, pending entries only (⬜
oldest-first; `i` key / 🧊 button parks an entry), done entries collapsed
behind the "Show done" header toggle; all 🧊 iced rows of BOTH kinds — todo
entries AND triaged notes (`status: iced` frontmatter; `i`/🧊 parks any row
uniformly, thaw restores a note's pre-ice status, `d` on an iced row thaws
it) — pool into ONE "🧊 icebox" section at the very bottom of the view
(dashed border, ↺ thaws, excluded from every count and the copy bundle),
each section keeping its `⧉ Copy` button (pending entries → clipboard); (2)
tag sections, triaged notes from `notes/*.md` grouped by first tag, A-Z,
`status: done` notes hidden unless "Show done", `status: iced` notes always
in the icebox section instead; (3) untagged, last. Within every section,
entries run OLDEST first (work in capture order). Arrow keys walk one flat
list that interleaves both row kinds across every section in this order, so
navigation is seamless regardless of kind.

A todo row whose body embeds a `## Claude` reply (re-routed notes) renders
only the note part on the card; the reply shows on expand, same as a triaged
card's reply. Long rows without a title clamp collapsed too (same >2-row
heuristic) — any row with a title, a reply, or a long body expands/collapses
via Enter/click.

STATUS FLOW (one status per row, both kinds): pending → iced or done; iced →
pending or done; done → pending ONLY (done can never be iced — `i` is a no-op
on done rows). `Enter` ONLY expands/collapses a card — it never changes
status (the ⬜/✅ glyph is still a click target for the done flip; clicking
elsewhere on a row only selects it); `d` is the done action for both (todo →
flip marker via `write_todos`; triaged → `setTriagedStatus` +
`write_triaged`), with the `Done → …` toast+undo on marking done for both
kinds; `x` ARCHIVES the selected row to `~/notes/archive.md` with an undo
toast — todo → archive the entry block + rewrite the project file without it;
triaged → archive body + `## Claude` reply, then remove the file via
`delete_triaged` (plain fs remove — never the `trash` crate, whose macOS path
goes through Finder automation and triggers a TCC prompt); undo restores the
archive and the source. `x` archives in the Inbox too (`d` is deliberately
unbound there so the views never disagree).

`o` means "open the relevant file in VS Code" in EVERY view: inbox.md in
the Inbox (`open_inbox_in_vscode`; Finder-reveal lives in the tray menu),
the selected row's file in Todos
(`open_triaged` / `open_todos` for a todo row's project file); `c` copies the
SELECTED row in both views (inbox note body; todo entry; triaged note
body+reply); the per-section `⧉` button copies a whole project's pending
entries. Per-card ghost buttons mirror `d`/`x` for mouse use; the triaged
card additionally still expands on click. Cards also grow a hover-only ✎
button mirroring `e`.

`e` edits the selected row's body in place (all three kinds — inbox note,
todo entry, triaged file body; the triaged file's frontmatter and `## Claude`
reply are preserved): textarea saves on Enter/⌘Enter/blur (Shift+Enter
inserts a newline), cancels on Esc, empty text is a no-op, every save gets an
Edited toast with undo. Undo is `u` or `⌘Z`; the last undoable action is
retained for 2 minutes past its toast (replaced by the next action, cleared
once run).

In Todos, `←` collapses the selected row's section — the header becomes the
nav row (amber inset when selected); `→`/`Enter`/click re-expands; collapse
state is session-only. A status flip (`d`/`i`) keeps the SAME card selected
in its new section (key-chase after the flat list recomputes; a card the flip
hides — done with Show done off — leaves the clamped selection alone). On
launch, done rows of both kinds captured 30+ days ago sweep to archive.md
(append-only, best-effort, toast reports the count; capture time is the proxy
since done-time isn't recorded).
