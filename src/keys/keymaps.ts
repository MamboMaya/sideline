import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { todoRowDisplay } from "../inbox";
import { QUICK_TAGS } from "../lib/format";
import { openInboxInVscode, openTriaged, openTodos } from "../lib/commands";
import type {
  CommandKeymap,
  KeyContext,
  KeyEvent,
  KeyHandler,
  Keymap,
  SearchKeyEvent,
  TodosCardRow,
} from "./types";

// Every key the app binds, as four tables. `dispatchKey` (useKeyboard.ts)
// owns the LAYERING between them — ⌘ layer first, then the in-field and
// modifier guards, then global keys, then the active view's map. The tables
// themselves only say what each key DOES; docs/ui.md is the user-facing
// spec of the same set.

// ── ⌘ layer ────────────────────────────────────────────────────────────
// Runs before the in-field guard, so these work from the search input too.
// Keyed by lowercased `e.key`. Every entry preventDefaults (dispatchKey does
// it); ⌘ combos with no entry here — ⌘C, ⌘V, … — are left untouched.
export const commandKeymap: CommandKeymap = {
  "1": { firesInFields: true, run: (ctx) => ctx.setView("inbox") },
  "2": { firesInFields: true, run: (ctx) => ctx.setView("todos") },
  // ⌘+ arrives as "=" unshifted and "+" shifted, depending on layout.
  "=": { firesInFields: true, run: (ctx) => ctx.adjustZoom(0.1) },
  "+": { firesInFields: true, run: (ctx) => ctx.adjustZoom(0.1) },
  "-": { firesInFields: true, run: (ctx) => ctx.adjustZoom(-0.1) },
  "0": { firesInFields: true, run: (ctx) => ctx.adjustZoom(0) },
  // ⌘, — the standard macOS Preferences shortcut — toggles Settings. This
  // entry only ever fires while Settings is CLOSED: dispatchKey's
  // settingsOpen gate returns before the ⌘ layer runs, and handles the
  // open→close direction itself (see useKeyboard.ts's step-0 comment).
  ",": { firesInFields: true, run: (ctx) => ctx.toggleSettings() },
  // The one ⌘ binding that yields to a focused field: inside an input,
  // native text undo wins.
  z: { firesInFields: false, run: (ctx) => ctx.runUndo() },
};

const expandSection = (ctx: KeyContext, section: string) =>
  ctx.setCollapsed((prev) => {
    const next = new Set(prev);
    next.delete(section);
    return next;
  });

const toggleTriagedExpanded = (ctx: KeyContext, filename: string) =>
  ctx.setTriagedExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(filename)) next.delete(filename);
    else next.add(filename);
    return next;
  });

// ── Global keys ────────────────────────────────────────────────────────
// Bound in BOTH views and checked before the view maps, so a view map can
// never shadow one of these.
export const globalKeymap: Keymap = {
  // Esc closes the popover from ANY view; open UI layers absorb one Esc
  // first, in this order. The search input handles its own Esc (it's an
  // INPUT target, so dispatchKey's in-field guard never lets Escape reach
  // this handler while the input has focus).
  Escape: (ctx) => {
    if (ctx.showShortcuts) ctx.setShowShortcuts(false);
    else if (ctx.tagInputOpen) ctx.dismissTagInput();
    else ctx.hideWindow();
  },
  "?": (ctx) => ctx.setShowShortcuts((v) => !v),
  u: (ctx) => ctx.runUndo(),
  "/": (ctx, e) => {
    // Without this, the same keystroke's default action types "/" into the
    // input that autoFocuses on open (same pattern as the `a` key).
    e.preventDefault();
    ctx.setSearchOpen(true);
  },
  // `r` toggles voice-note recording, in either view — mirrors the ⌥⌘R
  // global hotkey. State/level feedback arrives via the
  // recording-state/audio-level events, not this call's return value.
  r: (ctx) => ctx.toggleRecording(),
};

// ── Inbox view ─────────────────────────────────────────────────────────

// Every Inbox key except `o` and `T` acts on the SELECTED note, resolved the
// way it always has been: `selected` indexes the REVERSED (newest-first)
// filtered list, while the actions want that note's index in the full
// `notes` array. An empty list or an unresolvable note means the key does
// nothing at all — not even preventDefault.
const withSelectedNote =
  (run: (ctx: KeyContext, idx: number, e: KeyEvent) => void): KeyHandler =>
  (ctx, e) => {
    if (ctx.filteredNotes.length === 0) return;
    const note = ctx.filteredNotes[ctx.filteredNotes.length - 1 - ctx.selected];
    const idx = note ? ctx.notes.findIndex((n) => n.raw === note.raw) : -1;
    if (idx === -1) return;
    run(ctx, idx, e);
  };

// Keys 1-9 toggle a tag on the selected note: 1-3 are the three built-in
// quick tags, 4-9 the six pinned-tag slots (an empty slot is a no-op).
const tagSlotKeys = (): Keymap => {
  const map: Keymap = {};
  for (let n = 1; n <= 9; n++) {
    map[String(n)] = withSelectedNote((ctx, idx) => {
      const tag = n <= 3 ? QUICK_TAGS[n - 1] : ctx.pinnedTags[n - 4];
      if (tag) ctx.toggleTag(idx, tag);
    });
  }
  return map;
};

export const inboxKeymap: Keymap = {
  // `o` = "open the relevant file in VS Code" in every view: inbox.md here,
  // the selected row's file in Todos. Finder-reveal lives in the tray menu.
  o: () => openInboxInVscode(),
  T: (ctx) => {
    if (ctx.notes.length === 0 || ctx.batchRunning) return;
    ctx.triageBatch();
  },
  ArrowDown: withSelectedNote((ctx, _idx, e) => {
    e.preventDefault();
    ctx.setSelected((s) => Math.min(s + 1, ctx.filteredNotes.length - 1));
  }),
  ArrowUp: withSelectedNote((ctx, _idx, e) => {
    e.preventDefault();
    ctx.setSelected((s) => Math.max(s - 1, 0));
  }),
  ...tagSlotKeys(),
  a: withSelectedNote((ctx, _idx, e) => {
    // Without this, the same keystroke's default action types "a" into the
    // input that autoFocuses on open.
    e.preventDefault();
    ctx.openTagEditor();
  }),
  t: withSelectedNote((ctx, idx) => {
    if (ctx.sending.has(ctx.notes[idx].raw)) return;
    ctx.triageWithClaude(idx);
  }),
  e: withSelectedNote((ctx, idx, e) => {
    e.preventDefault();
    const note = ctx.notes[idx];
    if (ctx.sending.has(note.raw)) return;
    ctx.openEdit({ kind: "inbox", key: note.raw }, note.body);
  }),
  // `x` archives in the Inbox too — consistent with the Todos view, where
  // `d` means done. (`d` deliberately unbound here so the two views never
  // disagree about what it does.)
  x: withSelectedNote((ctx, idx) => {
    if (ctx.sending.has(ctx.notes[idx].raw)) return;
    ctx.remove(idx);
  }),
  // `c` copies in the Inbox too — same key as the Todos view's
  // copy-selected-row, here it's the note body.
  c: withSelectedNote((ctx, idx) => {
    writeText(ctx.notes[idx].body)
      .then(() => ctx.showToast("Copied note"))
      .catch((err) => ctx.showToast(`Copy failed: ${String(err)}`));
  }),
};

// ── Todos view ─────────────────────────────────────────────────────────

// Every Todos ACTION key acts on a card — inert on the header row a
// collapsed section contributes to the flat list. (Nav keys are not wrapped:
// they preventDefault before this guard, and ←/→/Enter have their own
// header behavior.)
const withCard =
  (
    run: (ctx: KeyContext, row: TodosCardRow, e: KeyEvent) => void,
  ): KeyHandler =>
  (ctx, e) => {
    const row = ctx.mergedFlat[ctx.todosSelected];
    if (!row || row.kind === "header") return;
    run(ctx, row, e);
  };

export const todosKeymap: Keymap = {
  // Flat nav across BOTH row kinds, in section order — see `mergedFlat`.
  // The actions below dispatch per the selected row's `kind`.
  ArrowDown: (ctx, e) => {
    e.preventDefault();
    if (ctx.mergedFlat.length)
      ctx.setTodosSelected((s) => Math.min(s + 1, ctx.mergedFlat.length - 1));
  },
  ArrowUp: (ctx, e) => {
    e.preventDefault();
    if (ctx.mergedFlat.length) ctx.setTodosSelected((s) => Math.max(s - 1, 0));
  },
  // ← collapses the selected row's section (selection lands on the collapsed
  // header row); → / Enter on a header expands it (the header's index
  // becomes the section's first card, so selection naturally lands there).
  ArrowLeft: (ctx, e) => {
    e.preventDefault();
    const row = ctx.mergedFlat[ctx.todosSelected];
    if (!row || row.kind === "header") return;
    const key = ctx.sectionKeyOf(row);
    ctx.setCollapsed((prev) => new Set(prev).add(key));
    ctx.pendingSelectKeyRef.current = `header::${key}`;
  },
  ArrowRight: (ctx, e) => {
    e.preventDefault();
    const row = ctx.mergedFlat[ctx.todosSelected];
    if (row?.kind === "header") expandSection(ctx, row.section);
  },
  // Enter ONLY expands/collapses — it never flips status (that's `d` and
  // `i`). A todo entry with nothing to expand (short, untitled, no embedded
  // reply — see `todoRowDisplay`) is a no-op.
  Enter: (ctx) => {
    const row = ctx.mergedFlat[ctx.todosSelected];
    if (row?.kind === "header") expandSection(ctx, row.section);
    else if (row?.kind === "triaged")
      toggleTriagedExpanded(ctx, row.note.filename);
    else if (row?.kind === "todo" && todoRowDisplay(row.entry).expandable)
      ctx.toggleTodoExpanded(row.project, row.entryIndex);
  },
  d: withCard((ctx, row) => {
    if (row.kind === "triaged") ctx.toggleTriagedDone(row.note);
    else ctx.toggleTodoEntry(row.project, row.entryIndex);
  }),
  i: withCard((ctx, row) => {
    if (row.kind === "todo") ctx.toggleTodoIced(row.project, row.entryIndex);
    else ctx.toggleTriagedIced(row.note);
  }),
  x: withCard((ctx, row) => {
    if (row.kind === "triaged") ctx.deleteTriagedNote(row.note);
    else ctx.deleteTodoEntry(row.project, row.entryIndex);
  }),
  o: withCard((_ctx, row) => {
    if (row.kind === "triaged") openTriaged(row.note.filename);
    else openTodos(row.project);
  }),
  c: withCard((ctx, row) => ctx.copyRow(row)),
  e: withCard((ctx, row, e) => {
    e.preventDefault();
    if (row.kind === "todo") {
      ctx.openEdit(
        { kind: "todo", project: row.project, entryIndex: row.entryIndex },
        row.entry.body,
      );
    } else {
      ctx.openEdit(
        { kind: "triaged", filename: row.note.filename },
        row.note.body,
      );
    }
  }),
  // `a` opens the same tag editor as the Inbox, on the selected row (adding
  // a project tag to a triaged card re-routes it).
  a: withCard((ctx, _row, e) => {
    e.preventDefault();
    ctx.openTagEditor();
  }),
  // Inbox-only keys (t, T, 1-9) are simply absent here, so they stay inert
  // in this view.
};

// The active view's map. Inbox and Todos are the only two, and a key missing
// from the active one does nothing — it never falls through to the other.
export const viewKeymap = (view: KeyContext["view"]): Keymap =>
  view === "todos" ? todosKeymap : inboxKeymap;

// ── Search input ───────────────────────────────────────────────────────
// The keys of the header search input, which `dispatchKey` never sees: it
// bails on INPUT targets, so this IS that input's layer.
//
//   Escape — the input's own: the first one clears and closes search, a
//     later one (focus back on the window) does the view's normal thing.
//   ↑/↓/Enter — delegated verbatim to the ACTIVE VIEW's map, so navigating
//     from the search bar runs the same entries as navigating from the list
//     (Enter is a Todos-only entry; in the Inbox nothing is bound, so it
//     stays plain typing).
//   everything else — typing.
export const searchKeyDown = (ctx: KeyContext, e: SearchKeyEvent): void => {
  if (e.key === "Escape") {
    e.stopPropagation();
    ctx.setSearchQuery("");
    ctx.setSearchOpen(false);
    (e.target as HTMLInputElement).blur();
    return;
  }
  // Prevented here rather than left to the delegate: while the arrows are
  // driving the list they must never also walk the text caret, and the
  // Inbox entries skip their own preventDefault when the filtered list is
  // empty.
  if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault();
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
    viewKeymap(ctx.view)[e.key]?.(ctx, e);
  }
};
