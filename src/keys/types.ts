import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Note, TriagedNote } from "../inbox";
import type { EditTarget } from "../hooks/useEditRow";
import type { MergedRow } from "../hooks/useTodosData";

// The slice of a keyboard event a handler may touch. BOTH event flavors
// satisfy it — the window listener's native `KeyboardEvent` and the search
// input's React synthetic one — which is what lets the search bar reuse the
// view keymaps' ↑/↓/Enter entries instead of duplicating them.
export interface KeyEvent {
  key: string;
  preventDefault: () => void;
}

// What `dispatchKey` itself needs on top of that: the modifier flags for the
// ⌘ layer and the target for the in-field guard.
export interface DispatchableKeyEvent extends KeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

// What the search input's own handler needs on top of a KeyEvent: its
// Escape stops propagating and blurs the input. React's synthetic keyboard
// event satisfies this.
export interface SearchKeyEvent extends KeyEvent {
  stopPropagation: () => void;
  target: EventTarget | null;
}

export type KeyHandler = (ctx: KeyContext, e: KeyEvent) => void;

// A keymap maps a RAW `e.key` to its handler, so it is case-SENSITIVE by
// construction: `t` (triage this note) and `T` (triage all) are separate
// entries, as are `/` and `?`. A key with no entry is left alone entirely —
// no preventDefault, so the keystroke keeps its browser default.
export type Keymap = Record<string, KeyHandler>;

// A ⌘-layer binding, keyed by the LOWERCASED `e.key` so ⌘⇧Z undoes exactly
// like ⌘Z (the pre-keymap handler compared `e.key.toLowerCase() === "z"`).
export interface CommandBinding {
  // Whether the binding still fires while an INPUT/TEXTAREA has focus. True
  // for every ⌘ binding except ⌘Z, where the field's native text undo wins.
  firesInFields: boolean;
  run: KeyHandler;
}

export type CommandKeymap = Record<string, CommandBinding>;

// A merged Todos row that is an actual card — what every Todos action key
// (`d` `i` `x` `o` `c` `e` `a`) operates on. Collapsed-section header rows
// are navigable but inert for those keys, so they are excluded here and the
// exclusion is enforced once, by `withCard` in keymaps.ts.
export type TodosCardRow = Exclude<MergedRow, { kind: "header" }>;

// Everything the keymaps are allowed to touch — the handlers' whole world.
// App.tsx builds one of these per render out of the hooks it already calls;
// useKeyboard keeps the latest in a ref, so no handler ever closes over
// stale state and the listener never re-registers. Deliberately explicit
// (no whole-hook objects) so this type IS the keyboard layer's contract:
// anything not listed here, a key cannot do.
export interface KeyContext {
  // ── View + chrome ────────────────────────────────────────────────────
  view: "inbox" | "todos";
  setView: Dispatch<SetStateAction<"inbox" | "todos">>;
  showShortcuts: boolean;
  setShowShortcuts: Dispatch<SetStateAction<boolean>>;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  // Hides the popover (Escape's last resort). Injected rather than called
  // directly so the Escape chain stays pure/testable.
  hideWindow: () => void;
  adjustZoom: (delta: number) => void;
  runUndo: () => void;
  toggleRecording: () => void;
  showToast: (message: string, undo?: () => void) => void;

  // ── Tag editor (`a`, both views) ─────────────────────────────────────
  tagInputOpen: boolean;
  openTagEditor: () => void;
  // Escape's tag-input layer clears ONLY the open flag — not the typed
  // value or suggestion index — matching useTagEditor's raw `setTagInputOpen`
  // setter rather than its `close()`.
  dismissTagInput: () => void;

  // ── Edit in place (`e`, all three row kinds) ─────────────────────────
  openEdit: (edit: EditTarget, body: string) => void;

  // ── Inbox view ───────────────────────────────────────────────────────
  notes: Note[];
  filteredNotes: Note[];
  // Index into the REVERSED (newest-first) filtered list — see
  // `withSelectedNote` in keymaps.ts.
  selected: number;
  setSelected: Dispatch<SetStateAction<number>>;
  pinnedTags: string[];
  toggleTag: (idx: number, tag: string) => void;
  // Note.raw values with a triage call in flight — those notes ignore
  // `t`/`e`/`x`.
  sending: Set<string>;
  batchRunning: boolean;
  triageWithClaude: (idx: number) => void;
  triageBatch: () => void;
  remove: (idx: number) => void;

  // ── Todos view ───────────────────────────────────────────────────────
  mergedFlat: MergedRow[];
  todosSelected: number;
  setTodosSelected: Dispatch<SetStateAction<number>>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  pendingSelectKeyRef: MutableRefObject<string | null>;
  sectionKeyOf: (row: MergedRow) => string;
  setTriagedExpanded: Dispatch<SetStateAction<Set<string>>>;
  toggleTodoExpanded: (project: string, entryIndex: number) => void;
  toggleTriagedDone: (note: TriagedNote) => void;
  toggleTriagedIced: (note: TriagedNote) => void;
  toggleTodoEntry: (project: string, entryIndex: number) => void;
  toggleTodoIced: (project: string, entryIndex: number) => void;
  deleteTriagedNote: (note: TriagedNote) => void;
  deleteTodoEntry: (project: string, entryIndex: number) => void;
  copyRow: (row: MergedRow) => void;
}
