import { useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  Note,
  TodoEntry,
  TriagedNote,
  parseTriagedFile,
  serializeTodos,
  setTriagedBody,
} from "../inbox";
import { writeTodos, writeTriaged } from "../lib/commands";

// Which row is being edited, keyed per kind — inbox note = its raw block,
// todo = project::entryIndex, triaged = filename. Mirrors the union that
// used to live inline as App.tsx's `editing` state type.
export type EditTarget =
  | { kind: "inbox"; key: string }
  | { kind: "todo"; project: string; entryIndex: number }
  | { kind: "triaged"; filename: string };

type TodosState = { project: string; entries: TodoEntry[] }[];

export interface UseEditRowParams {
  // Inbox save path (useInbox): notesRef for the pre-edit snapshot (async
  // flows read live state, not a closed-over value — see useInbox's own
  // comment on notesRef/persist), persist for the write.
  notesRef: MutableRefObject<Note[]>;
  persist: (next: Note[]) => Promise<void>;
  // Todo save path (useTodosData/App.tsx-owned state).
  todos: TodosState;
  setTodos: Dispatch<SetStateAction<TodosState>>;
  loadTodos: () => Promise<void>;
  // Triaged save path (useTodosData-owned state).
  triagedContent: Map<string, string>;
  setTriaged: Dispatch<SetStateAction<TriagedNote[]>>;
  setTriagedContent: Dispatch<SetStateAction<Map<string, string>>>;
  showToast: (message: string, onUndo?: () => void) => void;
  dismissToast: () => void;
}

// Edit-in-place (`e`): the row currently being edited (across all three
// kinds — only one at a time, like the tag editor), the shared textarea's
// draft value, and the save/cancel plumbing `EditArea` renders against. The
// textarea itself lives in `components/EditArea.tsx`; this hook is state +
// the 3-way save router only.
export function useEditRow({
  notesRef,
  persist,
  todos,
  setTodos,
  loadTodos,
  triagedContent,
  setTriaged,
  setTriagedContent,
  showToast,
  dismissToast,
}: UseEditRowParams) {
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [editValue, setEditValue] = useState("");
  // Set by EditArea's Escape handler just before it blurs the textarea, so
  // the blur handler that follows knows to cancel instead of save. Cleared
  // the moment it's read.
  const editCancelRef = useRef(false);

  // Opens the shared textarea on one row. Callers (the two `e` keybinds, the
  // five ghost ✎ buttons) still own any accompanying selection change
  // (setSelected/setTodosSelected) themselves — this hook only knows about
  // the row being edited, not the list it lives in.
  const open = (edit: EditTarget, body: string) => {
    setEditValue(body);
    setEditing(edit);
  };

  const cancel = () => setEditing(null);

  // Inbox note body → useInbox's persist path. Undo restores the full
  // pre-edit notes array.
  const saveInboxBody = async (
    edit: Extract<EditTarget, { kind: "inbox" }>,
    body: string,
  ) => {
    const prev = notesRef.current;
    const idx = prev.findIndex((n) => n.raw === edit.key);
    if (idx === -1 || prev[idx].body === body) return;
    const next = prev.map((n, i) => (i === idx ? { ...n, body } : n));
    persist(next);
    showToast("Edited", () => {
      persist(prev);
      dismissToast();
    });
  };

  // Todo entry body → write_todos path. Undo rewrites the project file back
  // to its pre-edit serialization, then reloads (matching every other
  // Todos-view undo).
  const saveTodoBody = async (
    edit: Extract<EditTarget, { kind: "todo" }>,
    body: string,
  ) => {
    const section = todos.find((t) => t.project === edit.project);
    const entry = section?.entries[edit.entryIndex];
    if (!section || !entry || entry.body === body) return;
    const prevContent = serializeTodos(section.entries);
    const nextEntries = section.entries.map((en, i) =>
      i === edit.entryIndex ? { ...en, body } : en,
    );
    try {
      setTodos((prev) =>
        prev.map((t) =>
          t.project === edit.project ? { ...t, entries: nextEntries } : t,
        ),
      );
      await writeTodos(edit.project, serializeTodos(nextEntries));
      showToast("Edited", () => {
        writeTodos(edit.project, prevContent).then(() => loadTodos());
        dismissToast();
      });
    } catch (e) {
      showToast(`Edit failed: ${String(e)}`);
      loadTodos();
    }
  };

  // Triaged file body → inbox.ts's setTriagedBody + write_triaged. Undo
  // restores the exact pre-edit file content; unlike the forward direction's
  // cheap `{ ...n, body }` patch, it re-parses that content via
  // parseTriagedFile to recover the original body (the closure only ever
  // captured the whole pre-edit file text, not the body string alone).
  const saveTriagedBody = async (
    edit: Extract<EditTarget, { kind: "triaged" }>,
    body: string,
  ) => {
    const content = triagedContent.get(edit.filename);
    if (content === undefined) return;
    const nextContent = setTriagedBody(content, body);
    if (nextContent === content) return;
    try {
      await writeTriaged(edit.filename, nextContent);
      setTriaged((prev) =>
        prev.map((n) => (n.filename === edit.filename ? { ...n, body } : n)),
      );
      setTriagedContent((prev) =>
        new Map(prev).set(edit.filename, nextContent),
      );
      showToast("Edited", () => {
        writeTriaged(edit.filename, content);
        setTriaged((prev) =>
          prev.map((n) =>
            n.filename === edit.filename
              ? parseTriagedFile(edit.filename, content)
              : n,
          ),
        );
        setTriagedContent((prev) => new Map(prev).set(edit.filename, content));
        dismissToast();
      });
    } catch (e) {
      showToast(`Edit failed: ${String(e)}`);
    }
  };

  // Edit-in-place save: dispatch on the edited row's kind. Each path
  // snapshots the pre-edit state for the undo toast (see the savers above).
  const saveEdit = async () => {
    const edit = editing;
    if (!edit) return;
    setEditing(null);
    const body = editValue.trim();
    if (!body) return; // empty edit = no-op, never blank a note
    if (edit.kind === "inbox") return saveInboxBody(edit, body);
    if (edit.kind === "todo") return saveTodoBody(edit, body);
    return saveTriagedBody(edit, body);
  };

  return {
    editing,
    editValue,
    setEditValue,
    editCancelRef,
    open,
    cancel,
    saveEdit,
  };
}

export type EditRowHook = ReturnType<typeof useEditRow>;
