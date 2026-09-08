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

Card list (newest first). Two views, jumped to by `⌘1`/`⌘2` or the header
tabs (`Inbox (N)` / `Todos (P)`). Selection moves with `↑`/`↓` — and with a
click: clicking a card (anywhere except an interactive child that handles
its own click, like a button or the tag input) selects it too, exactly as
arrowing to it would, so `t`/`d`/`e` and the rest of the keyboard layer act
on the card you just clicked rather than whatever was selected before.
`Esc` hides the popover from
any view — open layers like a pending batch-triage confirm (see Triage
below), the shortcuts panel, the Settings pane, or the tag input absorb one
Esc first, in that order; `?` toggles a shortcuts panel (its Everywhere
column now also lists the dictate-to-clipboard hotkey, default ⌥⌘V, and
`⌘,` — see docs/backend.md and Settings below). Reopening the popover resets
scroll/selection/search to the top but keeps the last-used tab (and closes
Settings/the shortcuts panel if either was open); tab switches
within one open session keep their place. `/` opens a compact header search
input filtering the active view's list (body + tags +, in a todo row, project
name); `Esc` on the input itself clears and closes it first. `⌘+`/`⌘-` step
UI zoom 0.7–1.5 (`⌘0` resets; persisted as `zoom` in .sideline.json, applied
as CSS zoom on body, with `--zoom` mirrored on `<html>` so `.app` can divide
its `100vh` back down — WebKit scales viewport units by the zoom, which
otherwise pushes the bottom of the popover off the clipped body at any zoom
≠ 1; see `src/hooks/useZoom.ts`). `r` toggles in-app voice recording from either view —
the same action as the ⌥⌘R global hotkey, but only while the popover has
focus (and always a toggle, even in push-to-talk mode — see Settings below;
only the ⌥⌘R/⌥⌘V global hotkeys themselves hold-to-record). While recording, a small pill HUD (🔴 elapsed m:ss + live level
bars, then "Transcribing…"/"Downloading model…") floats bottom-center of
the monitor holding the cursor, 20% up the screen — mirroring the popover's
20%-down spot — always on top, never focused, visible whether
or not the popover is open — and disappears at idle; the popover header
keeps its own identical indicator (both render `RecBars` off the same
`audio-level` stream). The pill hugs its content (the window behind it is
wider and fully transparent), so each state gets even padding rather than
the longest message running into the rounded edge. Every pill carries a
mode badge — "Capture" in orange for voice notes, "Dictate" in the
project-tag blue for dictation — so the two read the same way at a glance
while the words are still in flight; every dictation ends with the badge
dropping away and the pill showing "Copied
— ⌘V to paste" for ~1.5s before hiding — whether or not the auto-paste landed
(Sideline can't tell, and doesn't look; see docs/backend.md), so a
dictation that went nowhere is visibly recoverable instead of silently
gone. The popover header deliberately does NOT mirror that notice (the
pill owns it), and pressing either record hotkey during the notice starts
a fresh session immediately.

## Settings

The header's ⚙ button (`src/components/Header.tsx`) or `⌘,` (the standard
macOS Preferences shortcut, works from anywhere including a focused search
field) opens the Settings pane (`src/components/SettingsPane.tsx`) — a
swapped-in view over the `.cards` region, not a new window or overlay: the
popover keeps its normal size and the pane itself scrolls. `Esc` closes it
(absorbed as the first Esc layer, per Views & navigation above); while focus
is inside one of its text inputs/textareas, Esc blurs the field first, and a
second Esc then closes the pane. `⌘,` closes it too, from anywhere,
including with a field focused — no blur-first step, unlike Esc. While
Settings is open, none of the app's list/card keymap
actions fire — `src/keys/useKeyboard.ts`'s `dispatchKey` gates on
`ctx.settingsOpen` before anything else runs, so a stray `t`/`d`/arrow key
landing on a focused dropdown or button inside the pane can never triage,
delete, or navigate the list underneath. The one ⌘ binding that still
fires through the gate is zoom (`⌘+`/`⌘−`/`⌘0`): the pane's own Zoom
section sits at the very bottom, and a too-large zoom is exactly when the
shortcut is needed to reach it. One consolidated surface over every
key `.sideline.json` knows about (see docs/data-model.md); no new keys, no
format change.

SAVE MODEL: there is no Save button. Every control writes the full config
file on change/commit — same read-modify-write path pinned-tag toggles and
every other existing config write already use (`useConfig`'s `updateConfig`
in `src/hooks/useConfig.ts`, feeding `writeConfig`). A pane write always
round-trips the 9 opaque overrides (`prompts`, `models`, `projects`,
`claude`, `audio`, `hotkeys`, `overlay`, `pushToTalk`, `dictionary`) it
isn't touching, so a key the pane doesn't render — or an unknown key
hand-edited into one it does — survives untouched. Five sections, one
scrollable pane:

1. **Hotkeys** — press-to-record capture fields for `hotkeys.toggle`/
   `record`/`dictate` (`HotkeyCaptureField` in
   `src/components/SettingsPane.tsx`), each showing its current effective
   combo next to the field (override, or the ⌥⌘Space/⌥⌘R/⌥⌘V default) as an
   ⌥⌘-style symbol hint. There is no typing: the field is a button, not a
   text input. Click it (or Tab to it — focus alone starts capture) and it
   shows "press shortcut…"; press the actual shortcut and it captures the
   very next valid keystroke instead of doing anything else with it. The
   combo is built from the keydown's PHYSICAL key (`e.code` — `KeyV`→`v`,
   `Digit3`→`3`, `Space`→`space`; other codes like `F5`/`Comma` pass through
   exactly as `e.code` spells them) plus its modifier flags, joined in
   macOS's own display order — control, option, shift, cmd
   (`comboFromKeyEvent` in `src/lib/format.ts`, round-tripped through
   `macHotkeyCombo` same as before once committed). Holding a modifier alone
   just updates a live preview of what's held; a bare key pressed with no
   modifier shows an inline "add a modifier (⌘⌥⌃⇧)" hint and does NOT commit
   (a modifier-less global hotkey would shadow ordinary typing system-wide);
   a non-modifier key WITH at least one modifier commits immediately —
   writes `.sideline.json` (same as every other section) AND calls the
   `apply_hotkeys` Tauri command (`src-tauri/src/hotkeys.rs`) to swap the
   OS-level registration live — no restart, unlike a hand-edited
   `.sideline.json` (see docs/backend.md and the data-model.md caveat on
   `hotkeys`). Escape cancels the capture and reverts to the prior display;
   Delete/Backspace clears the override (commits blank, so that key reverts
   to its default) — both exit capture mode. While a field is capturing, its
   own keydown handler isolates every key with `preventDefault`/
   `stopPropagation` so nothing leaks to the app's global keymap — in
   particular `⌘,` will not close the pane and Esc will not close it either;
   `KeyContext.hotkeyCapturing` (`src/keys/types.ts`) is a second, redundant
   guard the Settings gate in `src/keys/useKeyboard.ts` checks for the same
   two keys, in case that isolation ever doesn't win the DOM race on its
   own. A per-key failure (the combo is claimed by another app) marks that
   field's border red, shows an inline error, and toasts the reason; the
   PREVIOUS shortcut for that key stays live either way — a bad capture here
   can never leave a hotkey dead, only fail to update it.
2. **Voice** — a device `<select>` for `audio.device`, populated from the
   `list_audio_devices` command (registered since the recording-device-
   picker was scaffolded, previously uncalled), plus a "System default"
   entry (removes the key). Writes the exact device name Rust-side matches
   as a case-insensitive substring (see docs/data-model.md); a hint notes it
   only takes effect on the NEXT recording, not the one in progress. Below
   it, a **Dictionary** editor for `dictionary` (`DictionaryEditor` in
   `src/components/SettingsPane.tsx`): one row per term — a term input, a
   comma-separated mis-hearings input (may be empty; a bare term only
   biases whisper's prompt), and a remove ✕ — plus a blank draft row at the
   bottom that becomes a real row on Enter or its + button (same footprint
   as the rows' ✕, so the inputs line up). Edits to an
   existing row commit on blur; add/remove commit immediately. Rows map to
   the on-disk object via `dictionaryRows`/`dictionaryFromRows` in
   `src/lib/config.ts` (blank terms skipped, duplicate terms merged);
   removing the last row removes the key. Whisper re-reads the file per
   transcription, so it applies to the next recording, no restart (see
   docs/data-model.md). A term can also be added straight from a note —
   see the add-to-dictionary bar in the Todos view section's `e` (edit)
   entry below. Below that, a **Show recording pill** on/off switch (iOS-style: orange, knob right = on)
   for `overlay.hidden` (On is default): Off hides the on-screen pill, e.g.
   while screen sharing — the tray's 🔴 REC timer still shows. window.rs
   reads the key fresh on every recording-state transition, so toggling it
   mid-recording hides an already-visible pill immediately, no restart (see
   docs/data-model.md, docs/backend.md). Below that, a **Hold to record**
   on/off switch for `pushToTalk` (Off is default): On switches the
   record/dictate hotkeys to push-to-talk — hold to record, release to
   transcribe — instead of press-to-start/press-to-stop; the tray menu's
   record/dictate items always toggle either way. lib.rs's global-shortcut
   handler reads the key fresh on every keypress, so toggling it takes
   effect on the very next press, no restart (see
   docs/data-model.md, docs/backend.md).
3. **Claude** — an on/off switch for `claude` (default on; off is
   no-Claude mode, see the Triage section below), plus text inputs for
   `models.triage`/`models.batch` and textareas for `prompts.triage`/
   `prompts.batch`. Each field shows its raw override value (blank if
   unset) with the CURRENT EFFECTIVE value as its placeholder; a blank
   field on blur removes that key from the override entirely so the
   built-in default applies again — the one write path in the app that can
   put a key back to "unset" rather than just changing its value.
4. **Tags** — three chip lists, each with a trailing add-input: pinned tags
   (max 6, same `togglePin` used everywhere a pinned-tag chip is clicked),
   hidden tags (excluded from autocomplete — adding here is `hideTag`,
   removing is the new `unhideTag`), and project routing tags (`projects`
   — add/remove preserve whichever shape, array or legacy `{tag: path}`
   map, is already on disk; a brand-new key is always written as an array,
   since the map shape only exists for old hand-edited files).
5. **Zoom** — the current `zoom` value as a percentage, with −/+ steppers
   and a Reset button (all three just call the existing `adjustZoom`, so
   they toast and clamp exactly like ⌘+/⌘−/⌘0 do) plus a hint pointing at
   those same shortcuts, since they already own this and the pane doesn't
   need to duplicate the behavior, just expose it.

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
out. Triage is instant — no Claude call at all before routing — for
project-tagged notes, which append a pending entry to that project's
`~/notes/todos/<tag>.md`; a long note's Haiku header (see HEADERS) is never
waited on here, even in single-note triage — it backfills into the entry in
the background moments later. Claude (`prompts.triage` / `models.triage`,
default Haiku) still runs for everything else. Batch triage (`Shift+T`,
keyboard-only — there is no header button) triages the whole inbox in one
pass: project-tagged notes route instantly as above, and every other note is
triaged in a single `send_to_claude` call (`prompts.batch` / `models.batch`,
default Haiku) instead of one call per note. Because it's one CLI call over
the whole inbox, `Shift+T` needs a second confirming press: the first press
toasts "Triage N notes with one Claude call? Press Shift+T again to confirm
· Esc cancels" (N = however many notes it would actually act on — 0
untagged-only notes falls through to the plain "tag them first" toast
instead, no confirm step) without triaging anything; a second `Shift+T`
within 6 seconds runs it, `Esc` or the 6 seconds elapsing cancels. A card
mid-triage is unmistakable: pulsing amber border + a "Triaging…" badge while
it's in the `sending` set.

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
along in the copy bundles. Group roundup files skip it — the tag names them.
Re-route (see Tags) generates a missing header too.

Single-note PROJECT triage is the one path where the header call never
blocks filing: the entry routes immediately with no title, then the Haiku
call runs in the background and, on success, patches the title into that
same entry (matched by timestamp + body) and refreshes the Todos view.
Nothing waits on it and nothing surfaces if it fails or never lands — if the
entry was undone, edited, completed, or archived before the title arrives,
the backfill silently does nothing rather than resurrecting or misfiling it.
This is also still the one exception to $0 project routing (short routed
notes route with no Claude call at all, foreground or background); batch
triage's project routing is unaffected — its title call already runs
concurrently with the rest of the batch, same as before.

NO-CLAUDE MODE: `.sideline.json`'s `"claude": false` (default `true`) turns
every non-project triage flow CLI-free — no `send_to_claude` call anywhere,
so users without the `claude` CLI or a subscription never see a failure
toast. Headers fall back to the note's own first non-empty line (sanitized)
instead of a Haiku headline; single-note triage files plain with the normal
`Triaged → notes/<filename>` toast (no `## Claude` appendix, no error
wording); batch triage files every unit plain too, one file per note — no
merged replies means no group roundup files. Project-tagged routing is
unaffected either way (it never called Claude).

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
once run). Selecting text inside the edit textarea (mouse or keyboard) — a
non-empty, single-line selection ≤40 characters after trimming — shows a
compact bar right under it: `Add "<selection>" to dictionary as` a term
input (prefilled with the selection) and an Add button. The field does NOT
take focus automatically — the textarea stays focused while selecting, so
selecting text never ends the edit; Tab or click into the field to edit it.
Save/cancel-on-blur only fires once focus leaves the textarea AND the bar
entirely — moving focus between the textarea and the bar's input/button
never saves or cancels. Add (button or Enter) adds the typed term to the
transcription dictionary — with the selection recorded as a mis-hearing of
it, unless the two are the same word — and replaces the selected text in
the draft with the term, so the note gets fixed too; the edit continues
normally (save/cancel as usual). The bar disappears when the selection
collapses, on Esc in its own input (focus returns to the textarea without
cancelling the edit), or once Add runs.

In Todos, `←` collapses the selected row's section — the header becomes the
nav row (amber inset when selected); `→`/`Enter`/click re-expands; collapse
state is session-only. A status flip (`d`/`i`) keeps the SAME card selected
in its new section (key-chase after the flat list recomputes; a card the flip
hides — done with Show done off — leaves the clamped selection alone). On
launch, done rows of both kinds captured 30+ days ago sweep to archive.md
(append-only, best-effort, toast reports the count; capture time is the proxy
since done-time isn't recorded).
