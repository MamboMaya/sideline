import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/commands", () => ({
  openInboxInVscode: vi.fn(),
  openTriaged: vi.fn(),
  openTodos: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));

import { openInboxInVscode, openTriaged, openTodos } from "../lib/commands";
import {
  commandKeymap,
  globalKeymap,
  inboxKeymap,
  searchKeyDown,
  todosKeymap,
} from "./keymaps";
import { dispatchKey } from "./useKeyboard";
import type { DispatchableKeyEvent, KeyContext } from "./types";
import type { Note, TodoEntry, TriagedNote } from "../inbox";
import type { MergedRow } from "../hooks/useTodosData";

// The keyboard layer's contract, as tests: the four tables bind exactly the
// documented key list (docs/ui.md + the `?` shortcuts panel), and
// dispatchKey layers them in the documented order. Pure — no jsdom, no
// React; the context is a bag of spies and the events are plain objects.

const note = (raw: string, body = raw, tags: string[] = []): Note => ({
  icon: "📥",
  timestamp: "2026-01-01 09:00",
  tags,
  body,
  raw,
});

const entry = (body: string): TodoEntry => ({
  status: "pending",
  timestamp: "2026-01-01 09:00",
  tags: [],
  body,
});

const triagedNote = (filename: string): TriagedNote => ({
  filename,
  captured: "2026-01-01 09:00",
  tags: ["idea"],
  status: "triaged",
  title: null,
  body: "body",
  reply: null,
});

// Every ctx member is a spy, so a test asserts "this key called exactly
// this action with these arguments" without any real state.
function makeCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    view: "inbox",
    setView: vi.fn(),
    showShortcuts: false,
    setShowShortcuts: vi.fn(),
    settingsOpen: false,
    closeSettings: vi.fn(),
    toggleSettings: vi.fn(),
    hotkeyCapturing: false,
    setSearchOpen: vi.fn(),
    setSearchQuery: vi.fn(),
    hideWindow: vi.fn(),
    adjustZoom: vi.fn(),
    runUndo: vi.fn(),
    toggleRecording: vi.fn(),
    showToast: vi.fn(),
    tagInputOpen: false,
    openTagEditor: vi.fn(),
    dismissTagInput: vi.fn(),
    openEdit: vi.fn(),
    notes: [],
    filteredNotes: [],
    selected: 0,
    setSelected: vi.fn(),
    pinnedTags: [],
    toggleTag: vi.fn(),
    sending: new Set<string>(),
    batchRunning: false,
    triageWithClaude: vi.fn(),
    triageBatch: vi.fn(),
    remove: vi.fn(),
    mergedFlat: [],
    todosSelected: 0,
    setTodosSelected: vi.fn(),
    setCollapsed: vi.fn(),
    pendingSelectKeyRef: { current: null },
    sectionKeyOf: vi.fn(() => "project::sideline"),
    setTriagedExpanded: vi.fn(),
    toggleTodoExpanded: vi.fn(),
    toggleTriagedDone: vi.fn(),
    toggleTriagedIced: vi.fn(),
    toggleTodoEntry: vi.fn(),
    toggleTodoIced: vi.fn(),
    deleteTriagedNote: vi.fn(),
    deleteTodoEntry: vi.fn(),
    copyRow: vi.fn(),
    ...overrides,
  };
}

const event = (
  key: string,
  opts: Partial<DispatchableKeyEvent> & { tagName?: string } = {},
): DispatchableKeyEvent & { preventDefault: ReturnType<typeof vi.fn> } => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: { tagName: opts.tagName ?? "DIV" } as unknown as EventTarget,
  ...opts,
  preventDefault: vi.fn(),
});

// Dispatch `key` and return the ctx that saw it, for compact assertions.
const press = (
  key: string,
  ctx: KeyContext,
  opts: Parameters<typeof event>[1] = {},
) => {
  const e = event(key, opts);
  dispatchKey(e, ctx);
  return e;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("keymap tables", () => {
  it("binds exactly the documented ⌘ layer", () => {
    expect(Object.keys(commandKeymap).sort()).toEqual(
      ["+", "-", "0", "1", "2", "=", ",", "z"].sort(),
    );
  });

  it("binds exactly the documented global keys", () => {
    expect(Object.keys(globalKeymap).sort()).toEqual(
      ["/", "?", "Escape", "r", "u"].sort(),
    );
  });

  it("binds exactly the documented Inbox keys", () => {
    expect(Object.keys(inboxKeymap).sort()).toEqual(
      [
        "ArrowDown",
        "ArrowUp",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "T",
        "a",
        "c",
        "e",
        "o",
        "t",
        "x",
      ].sort(),
    );
  });

  it("binds exactly the documented Todos keys", () => {
    expect(Object.keys(todosKeymap).sort()).toEqual(
      [
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "Enter",
        "a",
        "c",
        "d",
        "e",
        "i",
        "o",
        "x",
      ].sort(),
    );
  });

  it("leaves `d` unbound in the Inbox and the Inbox-only keys unbound in Todos", () => {
    expect(inboxKeymap.d).toBeUndefined();
    for (const key of ["t", "T", "1", "9"]) {
      expect(todosKeymap[key]).toBeUndefined();
    }
  });

  it("never lets a view map shadow a global key", () => {
    for (const key of Object.keys(globalKeymap)) {
      expect(inboxKeymap[key]).toBeUndefined();
      expect(todosKeymap[key]).toBeUndefined();
    }
  });
});

describe("dispatchKey — ⌘ layer runs before the in-field guard", () => {
  it("switches view and zooms from inside a focused input", () => {
    const ctx = makeCtx();
    const e1 = press("1", ctx, { metaKey: true, tagName: "INPUT" });
    expect(ctx.setView).toHaveBeenCalledWith("inbox");
    expect(e1.preventDefault).toHaveBeenCalled();

    press("2", ctx, { metaKey: true, tagName: "INPUT" });
    expect(ctx.setView).toHaveBeenCalledWith("todos");

    press("=", ctx, { metaKey: true, tagName: "TEXTAREA" });
    press("+", ctx, { metaKey: true, tagName: "INPUT" });
    press("-", ctx, { metaKey: true, tagName: "INPUT" });
    press("0", ctx, { metaKey: true, tagName: "INPUT" });
    expect((ctx.adjustZoom as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [0.1],
      [0.1],
      [-0.1],
      [0],
    ]);
  });

  it("gives ⌘Z to the field's native undo, but undoes outside one", () => {
    const inField = makeCtx();
    press("z", inField, { metaKey: true, tagName: "INPUT" });
    expect(inField.runUndo).not.toHaveBeenCalled();

    const ctx = makeCtx();
    press("z", ctx, { metaKey: true });
    expect(ctx.runUndo).toHaveBeenCalledTimes(1);
    // ⌘⇧Z reports `Z`, and undoes just the same.
    press("Z", ctx, { metaKey: true });
    expect(ctx.runUndo).toHaveBeenCalledTimes(2);
  });

  it("opens Settings with ⌘, — including from inside a focused field", () => {
    const ctx = makeCtx();
    const e = press(",", ctx, { metaKey: true, tagName: "INPUT" });
    expect(ctx.toggleSettings).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("leaves unbound ⌘ combos and ⌃/⌥ variants alone", () => {
    const ctx = makeCtx({ view: "todos" });
    const copy = press("c", ctx, { metaKey: true });
    expect(copy.preventDefault).not.toHaveBeenCalled();
    expect(ctx.copyRow).not.toHaveBeenCalled();
    // ⌃⌘1 / ⌥⌘1 are not the ⌘1 binding.
    press("1", ctx, { metaKey: true, ctrlKey: true });
    press("1", ctx, { metaKey: true, altKey: true });
    expect(ctx.setView).not.toHaveBeenCalled();
  });
});

describe("dispatchKey — guards", () => {
  it("ignores every non-⌘ key while an input or textarea has focus", () => {
    const ctx = makeCtx({ view: "todos", mergedFlat: [] });
    for (const tagName of ["INPUT", "TEXTAREA"]) {
      press("r", ctx, { tagName });
      press("Escape", ctx, { tagName });
      press("?", ctx, { tagName });
    }
    expect(ctx.toggleRecording).not.toHaveBeenCalled();
    expect(ctx.hideWindow).not.toHaveBeenCalled();
    expect(ctx.setShowShortcuts).not.toHaveBeenCalled();
  });

  it("ignores ⌃/⌥ combos, but treats Shift as a plain key", () => {
    const ctx = makeCtx();
    press("r", ctx, { ctrlKey: true });
    press("r", ctx, { altKey: true });
    expect(ctx.toggleRecording).not.toHaveBeenCalled();
    // `?` and `T` only exist as shifted keys.
    press("?", ctx);
    expect(ctx.setShowShortcuts).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchKey — Settings gate", () => {
  it("suppresses every key except a non-field Escape while Settings is open", () => {
    const ctx = makeCtx({ view: "todos", mergedFlat: [], settingsOpen: true });
    press("r", ctx);
    press("t", ctx);
    press("ArrowDown", ctx);
    press("?", ctx);
    press("z", ctx, { metaKey: true });
    expect(ctx.toggleRecording).not.toHaveBeenCalled();
    expect(ctx.setShowShortcuts).not.toHaveBeenCalled();
    expect(ctx.setTodosSelected).not.toHaveBeenCalled();
    expect(ctx.runUndo).not.toHaveBeenCalled();
    expect(ctx.closeSettings).not.toHaveBeenCalled();
  });

  it("lets ⌘= / ⌘+ / ⌘− / ⌘0 zoom through the gate, even from a field, but not ⌘1/⌘2", () => {
    const ctx = makeCtx({ settingsOpen: true });
    const e = press("=", ctx, { metaKey: true, tagName: "INPUT" });
    press("+", ctx, { metaKey: true });
    press("-", ctx, { metaKey: true });
    press("0", ctx, { metaKey: true });
    press("1", ctx, { metaKey: true });
    expect(e.preventDefault).toHaveBeenCalled();
    expect((ctx.adjustZoom as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [0.1],
      [0.1],
      [-0.1],
      [0],
    ]);
    expect(ctx.setView).not.toHaveBeenCalled();
    expect(ctx.closeSettings).not.toHaveBeenCalled();
  });

  it("closes Settings on Escape when focus is outside a field", () => {
    const ctx = makeCtx({ settingsOpen: true });
    const e = press("Escape", ctx, { tagName: "DIV" });
    expect(ctx.closeSettings).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("does NOT close Settings on Escape while an input/textarea has focus — the field blurs first", () => {
    for (const tagName of ["INPUT", "TEXTAREA"]) {
      const ctx = makeCtx({ settingsOpen: true });
      press("Escape", ctx, { tagName });
      expect(ctx.closeSettings).not.toHaveBeenCalled();
    }
  });

  it("leaves a SELECT/BUTTON target's Escape to the close-Settings branch (not treated as a field)", () => {
    for (const tagName of ["SELECT", "BUTTON"]) {
      const ctx = makeCtx({ settingsOpen: true });
      press("Escape", ctx, { tagName });
      expect(ctx.closeSettings).toHaveBeenCalledTimes(1);
    }
  });

  it("closes Settings on ⌘, regardless of field focus, via toggleSettings not closeSettings", () => {
    for (const tagName of ["DIV", "INPUT", "TEXTAREA", "SELECT"]) {
      const ctx = makeCtx({ settingsOpen: true });
      const e = press(",", ctx, { metaKey: true, tagName });
      expect(ctx.toggleSettings).toHaveBeenCalledTimes(1);
      expect(ctx.closeSettings).not.toHaveBeenCalled();
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it("does nothing at all — not even ⌘, or a non-field Escape — while a hotkey field is capturing", () => {
    const capturingCtx = () =>
      makeCtx({ settingsOpen: true, hotkeyCapturing: true });

    let ctx = capturingCtx();
    press("Escape", ctx, { tagName: "DIV" });
    expect(ctx.closeSettings).not.toHaveBeenCalled();

    ctx = capturingCtx();
    press(",", ctx, { metaKey: true, tagName: "BUTTON" });
    expect(ctx.toggleSettings).not.toHaveBeenCalled();
  });
});

describe("dispatchKey — Escape layering", () => {
  it("peels the shortcuts modal, then the tag input, then hides the window", () => {
    const both = makeCtx({ showShortcuts: true, tagInputOpen: true });
    press("Escape", both);
    expect(both.setShowShortcuts).toHaveBeenCalledWith(false);
    expect(both.dismissTagInput).not.toHaveBeenCalled();
    expect(both.hideWindow).not.toHaveBeenCalled();

    const tagOnly = makeCtx({ tagInputOpen: true });
    press("Escape", tagOnly);
    expect(tagOnly.dismissTagInput).toHaveBeenCalledTimes(1);
    expect(tagOnly.hideWindow).not.toHaveBeenCalled();

    const bare = makeCtx();
    press("Escape", bare);
    expect(bare.hideWindow).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchKey — global keys", () => {
  it("undoes, opens search, records", () => {
    const ctx = makeCtx();
    press("u", ctx);
    expect(ctx.runUndo).toHaveBeenCalledTimes(1);

    const slash = press("/", ctx);
    expect(ctx.setSearchOpen).toHaveBeenCalledWith(true);
    expect(slash.preventDefault).toHaveBeenCalled();

    press("r", ctx);
    expect(ctx.toggleRecording).toHaveBeenCalledTimes(1);
  });
});

describe("inbox keymap", () => {
  // `selected` counts from the NEWEST note (the list renders reversed), so
  // the action index is the far end of `notes`.
  const notes = [note("a"), note("b"), note("c")];
  const inboxCtx = (over: Partial<KeyContext> = {}) =>
    makeCtx({ view: "inbox", notes, filteredNotes: notes, ...over });

  it("resolves the selected note through the reversed filtered list", () => {
    const ctx = inboxCtx({ selected: 0 });
    press("t", ctx);
    expect(ctx.triageWithClaude).toHaveBeenCalledWith(2);

    const second = inboxCtx({ selected: 2 });
    press("t", second);
    expect(second.triageWithClaude).toHaveBeenCalledWith(0);
  });

  it("does nothing at all when the list is empty", () => {
    const ctx = makeCtx({ view: "inbox", notes, filteredNotes: [] });
    const down = press("ArrowDown", ctx);
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(ctx.setSelected).not.toHaveBeenCalled();
    press("x", ctx);
    press("1", ctx);
    expect(ctx.remove).not.toHaveBeenCalled();
    expect(ctx.toggleTag).not.toHaveBeenCalled();
  });

  it("skips t/e/x on a note with triage in flight", () => {
    const ctx = inboxCtx({ selected: 0, sending: new Set(["c"]) });
    press("t", ctx);
    press("e", ctx);
    press("x", ctx);
    expect(ctx.triageWithClaude).not.toHaveBeenCalled();
    expect(ctx.openEdit).not.toHaveBeenCalled();
    expect(ctx.remove).not.toHaveBeenCalled();
  });

  it("maps 1-3 to the quick tags and 4-9 to the pinned slots", () => {
    const ctx = inboxCtx({ selected: 0, pinnedTags: ["p4", "p5"] });
    press("1", ctx);
    press("3", ctx);
    press("4", ctx);
    press("5", ctx);
    // Slot 6 is empty — no-op, not a toggle of `undefined`.
    press("6", ctx);
    expect((ctx.toggleTag as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [2, "bug"],
      [2, "idea"],
      [2, "p4"],
      [2, "p5"],
    ]);
  });

  it("runs o/T without a selection, and T only with notes and no batch", () => {
    const ctx = makeCtx({ view: "inbox", notes, filteredNotes: [] });
    press("o", ctx);
    expect(openInboxInVscode).toHaveBeenCalledTimes(1);
    press("T", ctx);
    expect(ctx.triageBatch).toHaveBeenCalledTimes(1);

    const busy = makeCtx({ view: "inbox", notes, batchRunning: true });
    press("T", busy);
    const empty = makeCtx({ view: "inbox", notes: [] });
    press("T", empty);
    expect(busy.triageBatch).not.toHaveBeenCalled();
    expect(empty.triageBatch).not.toHaveBeenCalled();
  });
});

describe("todos keymap", () => {
  const rows: MergedRow[] = [
    { kind: "header", section: "project::sideline" },
    { kind: "todo", project: "sideline", entryIndex: 3, entry: entry("short") },
    { kind: "triaged", note: triagedNote("n.md") },
  ];
  const todosCtx = (todosSelected: number, over: Partial<KeyContext> = {}) =>
    makeCtx({ view: "todos", mergedFlat: rows, todosSelected, ...over });

  it("dispatches the action keys per row kind", () => {
    const todo = todosCtx(1);
    press("d", todo);
    press("i", todo);
    press("x", todo);
    press("o", todo);
    press("e", todo);
    expect(todo.toggleTodoEntry).toHaveBeenCalledWith("sideline", 3);
    expect(todo.toggleTodoIced).toHaveBeenCalledWith("sideline", 3);
    expect(todo.deleteTodoEntry).toHaveBeenCalledWith("sideline", 3);
    expect(openTodos).toHaveBeenCalledWith("sideline");
    expect(todo.openEdit).toHaveBeenCalledWith(
      { kind: "todo", project: "sideline", entryIndex: 3 },
      "short",
    );

    const triaged = todosCtx(2);
    press("d", triaged);
    press("i", triaged);
    press("x", triaged);
    press("o", triaged);
    const note2 = triagedNote("n.md");
    expect(triaged.toggleTriagedDone).toHaveBeenCalledWith(note2);
    expect(triaged.toggleTriagedIced).toHaveBeenCalledWith(note2);
    expect(triaged.deleteTriagedNote).toHaveBeenCalledWith(note2);
    expect(openTriaged).toHaveBeenCalledWith("n.md");
  });

  it("makes every action key inert on a collapsed section's header row", () => {
    const ctx = todosCtx(0);
    for (const key of ["d", "i", "x", "o", "c", "e", "a"]) press(key, ctx);
    expect(ctx.toggleTodoEntry).not.toHaveBeenCalled();
    expect(ctx.toggleTriagedDone).not.toHaveBeenCalled();
    expect(ctx.deleteTodoEntry).not.toHaveBeenCalled();
    expect(ctx.copyRow).not.toHaveBeenCalled();
    expect(ctx.openEdit).not.toHaveBeenCalled();
    expect(ctx.openTagEditor).not.toHaveBeenCalled();
    expect(openTriaged).not.toHaveBeenCalled();
    expect(openTodos).not.toHaveBeenCalled();
  });

  it("expands with →/Enter on a header and never flips status", () => {
    const header = todosCtx(0);
    press("ArrowRight", header);
    press("Enter", header);
    expect(
      (header.setCollapsed as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(2);
    const drop = (header.setCollapsed as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect([...drop(new Set(["project::sideline", "tag::x"]))]).toEqual([
      "tag::x",
    ]);
    expect(header.toggleTodoEntry).not.toHaveBeenCalled();
    expect(header.toggleTriagedDone).not.toHaveBeenCalled();
  });

  it("collapses the selected row's section with ← and chases its header", () => {
    const ctx = todosCtx(1);
    press("ArrowLeft", ctx);
    const add = (ctx.setCollapsed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect([...add(new Set())]).toEqual(["project::sideline"]);
    expect(ctx.pendingSelectKeyRef.current).toBe("header::project::sideline");
  });

  it("expands a triaged row on Enter, and a todo row only when expandable", () => {
    const triaged = todosCtx(2);
    press("Enter", triaged);
    expect(triaged.setTriagedExpanded).toHaveBeenCalledTimes(1);

    // `short` has no title, no reply and fits in two rows — nothing to show.
    const flat = todosCtx(1);
    press("Enter", flat);
    expect(flat.toggleTodoExpanded).not.toHaveBeenCalled();

    const long: MergedRow[] = [
      {
        kind: "todo",
        project: "sideline",
        entryIndex: 0,
        entry: { ...entry("a\nb\nc\nd"), title: "t" },
      },
    ];
    const ctx = makeCtx({ view: "todos", mergedFlat: long, todosSelected: 0 });
    press("Enter", ctx);
    expect(ctx.toggleTodoExpanded).toHaveBeenCalledWith("sideline", 0);
  });

  it("clamps arrow navigation to the flat list", () => {
    const ctx = todosCtx(0);
    const down = press("ArrowDown", ctx);
    expect(down.preventDefault).toHaveBeenCalled();
    const next = (ctx.setTodosSelected as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(next(2)).toBe(2);
    expect(next(0)).toBe(1);

    press("ArrowUp", ctx);
    const prev = (ctx.setTodosSelected as ReturnType<typeof vi.fn>).mock
      .calls[1][0];
    expect(prev(0)).toBe(0);
    expect(prev(2)).toBe(1);

    // An empty list still preventDefaults, but moves nothing.
    const empty = makeCtx({ view: "todos", mergedFlat: [] });
    const e = press("ArrowDown", empty);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(empty.setTodosSelected).not.toHaveBeenCalled();
  });
});

describe("searchKeyDown", () => {
  const searchEvent = (key: string) => ({
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: { blur: vi.fn() } as unknown as EventTarget,
  });

  it("clears, closes and blurs on Escape without reaching the window", () => {
    const ctx = makeCtx();
    const e = searchEvent("Escape");
    searchKeyDown(ctx, e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(ctx.setSearchQuery).toHaveBeenCalledWith("");
    expect(ctx.setSearchOpen).toHaveBeenCalledWith(false);
    expect(
      (e.target as unknown as { blur: () => void }).blur,
    ).toHaveBeenCalled();
    // NOT the window Escape chain.
    expect(ctx.hideWindow).not.toHaveBeenCalled();
    expect(ctx.setShowShortcuts).not.toHaveBeenCalled();
  });

  it("delegates ↑/↓ to the active view's own entry", () => {
    const notes = [note("a"), note("b")];
    const inbox = makeCtx({ notes, filteredNotes: notes, selected: 0 });
    searchKeyDown(inbox, searchEvent("ArrowDown"));
    const next = (inbox.setSelected as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(next(0)).toBe(1);
    expect(next(1)).toBe(1);

    const todos = makeCtx({
      view: "todos",
      mergedFlat: [{ kind: "triaged", note: triagedNote("n.md") }],
    });
    searchKeyDown(todos, searchEvent("ArrowUp"));
    expect(todos.setTodosSelected).toHaveBeenCalledTimes(1);
  });

  it("preventDefaults ↑/↓ even when the view entry bails", () => {
    const ctx = makeCtx({ filteredNotes: [] });
    const e = searchEvent("ArrowDown");
    searchKeyDown(ctx, e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ctx.setSelected).not.toHaveBeenCalled();
  });

  it("expands on Enter in Todos and leaves Enter alone in the Inbox", () => {
    const todos = makeCtx({
      view: "todos",
      mergedFlat: [{ kind: "triaged", note: triagedNote("n.md") }],
    });
    const e = searchEvent("Enter");
    searchKeyDown(todos, e);
    expect(todos.setTriagedExpanded).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).not.toHaveBeenCalled();

    const notes = [note("a")];
    const inbox = makeCtx({ notes, filteredNotes: notes });
    searchKeyDown(inbox, searchEvent("Enter"));
    expect(inbox.setSelected).not.toHaveBeenCalled();
    expect(inbox.openEdit).not.toHaveBeenCalled();
  });

  it("leaves every other key to typing", () => {
    const notes = [note("a")];
    const ctx = makeCtx({ notes, filteredNotes: notes });
    for (const key of ["s", "x", "?", "1", "t", "/"]) {
      const e = searchEvent(key);
      searchKeyDown(ctx, e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(ctx.setView).not.toHaveBeenCalled();
    expect(ctx.remove).not.toHaveBeenCalled();
    expect(ctx.toggleTag).not.toHaveBeenCalled();
    expect(ctx.setSearchOpen).not.toHaveBeenCalled();
  });
});
