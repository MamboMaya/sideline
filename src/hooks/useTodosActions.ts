import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type TodoEntry,
  type TodoStatus,
  type TriagedNote,
  archiveBlock,
  parseTodos,
  parseTriagedFile,
  serializeTodos,
  setTriagedStatus,
  setTriagedTags,
  tagString,
} from "../inbox";
import { needsTitle } from "../lib/format";
import { appendToArchive, undoArchiveAppend } from "../lib/archive";
import {
  deleteTriaged,
  readTodos,
  triageNote,
  writeTodos,
  writeTriaged,
} from "../lib/commands";
import type { MergedRow } from "./useTodosData";

type TodosState = { project: string; entries: TodoEntry[] }[];

export interface UseTodosActionsParams {
  // The data slices from useTodosData these actions read and write back.
  todos: TodosState;
  setTodos: Dispatch<SetStateAction<TodosState>>;
  setTodoExpanded: Dispatch<SetStateAction<Set<string>>>;
  triagedContent: Map<string, string>;
  setTriaged: Dispatch<SetStateAction<TriagedNote[]>>;
  setTriagedContent: Dispatch<SetStateAction<Map<string, string>>>;
  pendingSelectKeyRef: MutableRefObject<string | null>;
  loadTodos: () => Promise<void>;
  showToast: (message: string, undo?: () => void) => void;
  dismissToast: () => void;
  // Project tags a note can be routed on — adding one to a triaged card
  // re-routes it instead of just editing its frontmatter.
  projectTags: string[];
  // Stays in App.tsx (the inbox triage flow owns it) and is passed down:
  // re-routing a header-less note generates one on the way out.
  generateTitles: (
    notesToTitle: { raw: string; body: string }[],
  ) => Promise<Map<string, string>>;
}

// Every mutating action the Todos view can perform on a row: status flips,
// tag edits, re-route, archive, copy. The data these read lives in
// useTodosData — this hook only receives the slices it writes back to.
export function useTodosActions({
  todos,
  setTodos,
  setTodoExpanded,
  triagedContent,
  setTriaged,
  setTriagedContent,
  pendingSelectKeyRef,
  loadTodos,
  showToast,
  dismissToast,
  projectTags,
  generateTitles,
}: UseTodosActionsParams) {
  // Optimistic in-place patch of one triaged note + its raw content, then
  // the file write. Every triaged mutation that keeps the file (status
  // flips, tag edits) goes through this — the patch is `{ status }` or
  // `{ tags }`; undo calls it again with the pre-change values.
  const applyTriagedPatch = useCallback(
    (filename: string, patch: Partial<TriagedNote>, fileContent: string) => {
      setTriaged((prev) =>
        prev.map((n) => (n.filename === filename ? { ...n, ...patch } : n)),
      );
      setTriagedContent((prev) => new Map(prev).set(filename, fileContent));
      return writeTriaged(filename, fileContent);
    },
    [setTriaged, setTriagedContent],
  );

  // Todos view status actions for triaged cards, `d` (done) and `i` (ice):
  // flips the frontmatter `status:` in place via `setTriagedStatus` +
  // `write_triaged`. Status flow (same for both row kinds): pending → done
  // or iced; iced → pending or done; done → pending ONLY (done can never be
  // iced). Marking gets a u/Undo toast; un-marking back to plain `triaged`
  // is silent — toggling back is just the same key again (with showDone on
  // so the now-done card is still visible to re-select).
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const setTriagedStatusAction = useCallback(
    async (note: TriagedNote, action: "done" | "iced") => {
      // Ice is a no-op on a done note; the done action has no such guard
      // (it's what un-marks one).
      if (action === "iced" && note.status === "done") return;
      const content = triagedContent.get(note.filename);
      if (content === undefined) return;
      const prevStatus = note.status;
      const nextStatus = prevStatus === action ? "triaged" : action;
      const nextContent = setTriagedStatus(content, nextStatus);
      try {
        await applyTriagedPatch(
          note.filename,
          { status: nextStatus },
          nextContent,
        );
        pendingSelectKeyRef.current = `triaged::${note.filename}`;
        if (nextStatus === action) {
          // The card vanishes from the default list — say so, and give the
          // same u/Undo escape hatch as triage/delete. The two actions
          // restore differently, and deliberately so: `d` always undoes to
          // plain `triaged` (marking an iced note done and undoing thaws
          // it), while `i` restores whatever status the note actually had.
          const restore = action === "done" ? "triaged" : prevStatus;
          const label = action === "done" ? "Done" : "Iced 🧊";
          showToast(`${label} → ${note.filename}`, () => {
            applyTriagedPatch(
              note.filename,
              { status: restore },
              setTriagedStatus(nextContent, restore),
            ).catch((e) => showToast(`Undo failed: ${String(e)}`));
            dismissToast();
          });
        }
      } catch (e) {
        showToast(`Failed to update ${note.filename}: ${String(e)}`);
      }
    },
    [triagedContent, applyTriagedPatch],
  );

  const toggleTriagedDone = useCallback(
    (note: TriagedNote) => setTriagedStatusAction(note, "done"),
    [setTriagedStatusAction],
  );

  const toggleTriagedIced = useCallback(
    (note: TriagedNote) => setTriagedStatusAction(note, "iced"),
    [setTriagedStatusAction],
  );

  // Todos view: rewrites one entry's status marker in its project file
  // (entries are never reordered — only removed via `deleteTodoEntry`).
  // Same status flow as the triaged cards above. `d`/✓ = done action
  // (pending/iced → done; done → pending); `i`/🧊 = ice action (pending ↔
  // iced; no-op on done). Marking done or iced gets a u/Undo toast
  // restoring the file content captured just before the flip; un-marking
  // back to pending is silent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const setTodoStatus = useCallback(
    async (project: string, entryIndex: number, status: TodoStatus) => {
      const section = todos.find((t) => t.project === project);
      const entry = section?.entries[entryIndex];
      if (!section || !entry || entry.status === status) return;
      const prevContent = serializeTodos(section.entries);
      const nextEntries = section.entries.map((e, i) =>
        i === entryIndex ? { ...e, status } : e,
      );
      const apply = (entries: TodoEntry[]) => {
        setTodos((prev) =>
          prev.map((t) => (t.project === project ? { ...t, entries } : t)),
        );
        return writeTodos(project, serializeTodos(entries));
      };
      try {
        await apply(nextEntries);
        // Selection follows the card to its new section (icebox, done) once
        // the flat list recomputes — see pendingSelectKeyRef.
        pendingSelectKeyRef.current = `todo::${project}::${entryIndex}`;
        if (status !== "pending") {
          const label = status === "done" ? "Done" : "Iced 🧊";
          showToast(`${label} → ${project}`, () => {
            apply(parseTodos(prevContent)).catch((e) =>
              showToast(`Undo failed: ${String(e)}`),
            );
            dismissToast();
          });
        }
      } catch (e) {
        showToast(`Failed to update ${project}.md: ${String(e)}`);
      }
    },
    [todos],
  );

  // The todo-entry side of `d`/`i`: flip to the action's status, or back to
  // pending if the entry is already there. Icing a done entry is a no-op
  // (done can never be iced) — the done action has no such guard.
  const toggleTodoStatus = useCallback(
    (project: string, entryIndex: number, action: "done" | "iced") => {
      const entry = todos.find((t) => t.project === project)?.entries[
        entryIndex
      ];
      if (!entry) return;
      if (action === "iced" && entry.status === "done") return;
      setTodoStatus(
        project,
        entryIndex,
        entry.status === action ? "pending" : action,
      );
    },
    [todos, setTodoStatus],
  );

  const toggleTodoEntry = useCallback(
    (project: string, entryIndex: number) =>
      toggleTodoStatus(project, entryIndex, "done"),
    [toggleTodoStatus],
  );

  const toggleTodoIced = useCallback(
    (project: string, entryIndex: number) =>
      toggleTodoStatus(project, entryIndex, "iced"),
    [toggleTodoStatus],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const toggleTodoExpanded = useCallback(
    (project: string, entryIndex: number) => {
      const key = `${project}::${entryIndex}`;
      setTodoExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [],
  );

  // Todos view tag editing (`a` / chip click): a todo entry's tags update
  // in place in its project file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const updateTodoTags = useCallback(
    async (project: string, entryIndex: number, tag: string) => {
      const section = todos.find((t) => t.project === project);
      const entry = section?.entries[entryIndex];
      if (!section || !entry) return;
      const removing = entry.tags.includes(tag);
      const nextTags = removing
        ? entry.tags.filter((t) => t !== tag)
        : [...entry.tags, tag];
      const prevContent = serializeTodos(section.entries);
      const nextEntries = section.entries.map((e, i) =>
        i === entryIndex ? { ...e, tags: nextTags } : e,
      );
      const apply = (entries: TodoEntry[]) => {
        setTodos((prev) =>
          prev.map((t) => (t.project === project ? { ...t, entries } : t)),
        );
        return writeTodos(project, serializeTodos(entries));
      };
      try {
        await apply(nextEntries);
        showToast(removing ? `Removed #${tag}` : `Added #${tag}`, () => {
          apply(parseTodos(prevContent)).catch((e) =>
            showToast(`Undo failed: ${String(e)}`),
          );
          dismissToast();
        });
      } catch (e) {
        showToast(`Failed to update ${project}.md: ${String(e)}`);
      }
    },
    [todos],
  );

  // Adding a project tag to a triaged note RE-ROUTES it: the note leaves
  // notes/ entirely and becomes a pending ⬜ entry in
  // ~/notes/todos/<project>.md — one record per routed note, same rule as
  // triage-time routing. The Claude reply rides along inside the entry body
  // under its `## Claude` heading so nothing is lost. Undo restores both
  // files.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const rerouteTriagedNote = useCallback(
    async (note: TriagedNote, project: string) => {
      const content = triagedContent.get(note.filename);
      if (content === undefined) return;
      const nextTags = note.tags.includes(project)
        ? note.tags
        : [...note.tags, project];
      const body = note.reply
        ? `${note.body}\n\n## Claude\n\n${note.reply}`
        : note.body;
      // The todo header needs a parseable `YYYY-MM-DD HH:MM`; roundup files
      // carry a captured RANGE (starts with one, fine) but a missing value
      // falls back to the filename's date.
      let timestamp = note.captured;
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(timestamp)) {
        const d = note.filename.match(/^(\d{4}-\d{2}-\d{2})/);
        timestamp = `${d ? d[1] : "2000-01-01"} 00:00`;
      }
      // A note re-routed here may never have gotten a Haiku header (it was
      // short at capture time, or predates headers entirely) — generate one
      // now, same mechanism as `generateTitles`, so it doesn't land in the
      // todo queue permanently header-less just because it took this path
      // instead of triage. Failure-tolerant: never blocks the re-route.
      let title = note.title ?? undefined;
      if (!title && needsTitle(note.body)) {
        try {
          const titles = await generateTitles([
            { raw: note.filename, body: note.body },
          ]);
          title = titles.get(note.filename);
        } catch {
          // No header this round — the re-route still proceeds.
        }
      }
      try {
        const pairs = await readTodos();
        const prevTodoContent = pairs.find(([p]) => p === project)?.[1] ?? "";
        const entries = parseTodos(prevTodoContent);
        entries.push({
          status: "pending",
          timestamp,
          tags: nextTags,
          ...(title ? { title } : {}),
          body,
        });
        await writeTodos(project, serializeTodos(entries));
        await deleteTriaged(note.filename);
        setTriaged((prev) => prev.filter((n) => n.filename !== note.filename));
        setTriagedContent((prev) => {
          const next = new Map(prev);
          next.delete(note.filename);
          return next;
        });
        await loadTodos();
        pendingSelectKeyRef.current = `todo::${project}::${entries.length - 1}`;
        showToast(`→ ${project} todos`, () => {
          writeTodos(project, prevTodoContent)
            .then(() => loadTodos())
            .catch((e) => showToast(`Undo failed: ${String(e)}`));
          triageNote(note.filename, content)
            .then((finalFilename) => {
              setTriaged((prev) => [
                ...prev,
                parseTriagedFile(finalFilename, content),
              ]);
              setTriagedContent((prev) =>
                new Map(prev).set(finalFilename, content),
              );
            })
            .catch((e) => showToast(`Undo failed: ${String(e)}`));
          dismissToast();
        });
      } catch (e) {
        showToast(`Re-route to ${project} failed: ${String(e)}`);
      }
    },
    [triagedContent, loadTodos, generateTitles],
  );

  // Tag toggle on a triaged card: removal and non-project adds rewrite the
  // frontmatter `tags:` line in place; adding a PROJECT tag re-routes the
  // note into that project's queue instead (see rerouteTriagedNote).
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const toggleTriagedTag = useCallback(
    async (note: TriagedNote, tag: string) => {
      const removing = note.tags.includes(tag);
      if (!removing && projectTags.includes(tag)) {
        rerouteTriagedNote(note, tag);
        return;
      }
      const content = triagedContent.get(note.filename);
      if (content === undefined) return;
      const nextTags = removing
        ? note.tags.filter((t) => t !== tag)
        : [...note.tags, tag];
      const nextContent = setTriagedTags(content, nextTags);
      try {
        await applyTriagedPatch(note.filename, { tags: nextTags }, nextContent);
        // Removing/changing the FIRST tag moves the card to another section
        // — chase it.
        pendingSelectKeyRef.current = `triaged::${note.filename}`;
        showToast(removing ? `Removed #${tag}` : `Added #${tag}`, () => {
          applyTriagedPatch(note.filename, { tags: note.tags }, content).catch(
            () => {},
          );
          dismissToast();
        });
      } catch (e) {
        showToast(`Failed to update ${note.filename}: ${String(e)}`);
      }
    },
    [triagedContent, projectTags, rerouteTriagedNote, applyTriagedPatch],
  );

  // Todos view `x`: archives the selected row to ~/notes/archive.md, with an
  // undo toast. Todo row → archive the entry block + rewrite the project
  // file without it; undo restores both files.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const deleteTodoEntry = useCallback(
    async (project: string, entryIndex: number) => {
      const section = todos.find((t) => t.project === project);
      if (!section) return;
      const entry = section.entries[entryIndex];
      if (!entry) return;
      const prevContent = serializeTodos(section.entries);
      const nextEntries = section.entries.filter((_, i) => i !== entryIndex);
      const block = archiveBlock("📥", entry.timestamp, entry.tags, entry.body);
      try {
        await appendToArchive(block);
        setTodos((prev) =>
          prev.map((t) =>
            t.project === project ? { ...t, entries: nextEntries } : t,
          ),
        );
        await writeTodos(project, serializeTodos(nextEntries));
        showToast(`Archived from ${project}`, () => {
          // Inverse op, not a pre-append snapshot restore (which would
          // erase archive entries added since).
          undoArchiveAppend(block).catch((e) =>
            showToast(`Undo failed: ${String(e)}`),
          );
          writeTodos(project, prevContent)
            .then(() => {
              setTodos((prev) =>
                prev.map((t) =>
                  t.project === project
                    ? { ...t, entries: parseTodos(prevContent) }
                    : t,
                ),
              );
            })
            .catch((e) => showToast(`Undo failed: ${String(e)}`));
          dismissToast();
        });
      } catch (e) {
        showToast(`Failed to archive from ${project}.md: ${String(e)}`);
      }
    },
    [todos],
  );

  // Todos view `x`: triaged card → archive its content to archive.md (body
  // plus the `## Claude` reply, so nothing is lost), then remove the file
  // (fs remove — content lives on in the archive). Undo restores the
  // archive and re-creates the file via `triage_note`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const deleteTriagedNote = useCallback(
    async (note: TriagedNote) => {
      const content = triagedContent.get(note.filename);
      const block = archiveBlock(
        "📥",
        note.captured || "undated",
        note.tags,
        note.body,
        note.reply,
      );
      try {
        await appendToArchive(block);
        await deleteTriaged(note.filename);
        setTriaged((prev) => prev.filter((n) => n.filename !== note.filename));
        setTriagedContent((prev) => {
          const next = new Map(prev);
          next.delete(note.filename);
          return next;
        });
        showToast(`Archived ${note.filename}`, () => {
          undoArchiveAppend(block).catch((e) =>
            showToast(`Undo failed: ${String(e)}`),
          );
          if (content !== undefined) {
            triageNote(note.filename, content)
              .then((finalFilename) => {
                setTriaged((prev) => [
                  ...prev,
                  parseTriagedFile(finalFilename, content),
                ]);
                setTriagedContent((prev) =>
                  new Map(prev).set(finalFilename, content),
                );
              })
              .catch((e) => showToast(`Undo failed: ${String(e)}`));
          }
          dismissToast();
        });
      } catch (e) {
        showToast(`Failed to archive ${note.filename}: ${String(e)}`);
      }
    },
    [triagedContent],
  );

  // Todos view `c`: copies just the SELECTED row — a todo entry or a
  // triaged note (body + reply) — for pasting one task into a session. The
  // per-section ⧉ button remains the whole-tag bundle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const copyRow = useCallback(async (row: MergedRow) => {
    if (row.kind === "header") return;
    let md: string;
    if (row.kind === "todo") {
      const tagStr = tagString(row.entry.tags);
      const titlePart = row.entry.title ? `**${row.entry.title}**\n\n` : "";
      md = `### ${row.entry.timestamp}${tagStr}\n\n${titlePart}${row.entry.body}\n`;
    } else {
      const titlePart = row.note.title ? `**${row.note.title}**\n\n` : "";
      const replyPart = row.note.reply
        ? `\n\n## Claude\n\n${row.note.reply}`
        : "";
      md = `${titlePart}${row.note.body}${replyPart}\n`;
    }
    try {
      await writeText(md);
      showToast(row.kind === "todo" ? "Copied todo" : "Copied note");
    } catch (e) {
      showToast(`Copy failed: ${String(e)}`);
    }
  }, []);

  // Per-section ⧉ copy button: bundles a project's PENDING
  // entries (no status markers — they're pending by definition) as markdown
  // for pasting into a repo Claude session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const copyProjectTodos = useCallback(
    async (project: string) => {
      const section = todos.find((t) => t.project === project);
      if (!section) return;
      const pending = section.entries.filter((e) => e.status === "pending");
      const body = pending
        .map((e) => {
          const tagStr = tagString(e.tags);
          const titlePart = e.title ? `**${e.title}**\n\n` : "";
          return `### ${e.timestamp}${tagStr}\n\n${titlePart}${e.body}`;
        })
        .join("\n\n");
      const md = `# Sideline todos — ${project}\n\n${body}\n`;
      try {
        await writeText(md);
        showToast(`Copied ${pending.length} pending todos`);
      } catch (e) {
        showToast(`Copy failed: ${String(e)}`);
      }
    },
    [todos],
  );

  return {
    toggleTriagedDone,
    toggleTriagedIced,
    toggleTodoEntry,
    toggleTodoIced,
    toggleTodoExpanded,
    updateTodoTags,
    rerouteTriagedNote,
    toggleTriagedTag,
    deleteTodoEntry,
    deleteTriagedNote,
    copyRow,
    copyProjectTodos,
  };
}

export type TodosActionsHook = ReturnType<typeof useTodosActions>;
