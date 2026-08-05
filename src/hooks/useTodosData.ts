import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type TodoEntry,
  type TriagedNote,
  parseTodos,
  parseTriagedFile,
} from "../inbox";
import { readTriaged, readTodos } from "../lib/commands";

// One todo row in the merged Todos view: `entryIndex` is the entry's
// position in that project's on-disk (chronological) entries array, so a
// toggle/delete can write back with `serializeTodos` without disturbing
// order.
export interface TodoRow {
  project: string;
  entryIndex: number;
  entry: TodoEntry;
}

// The Todos view's flat nav list interleaves two row kinds — project todo
// entries and triaged-note cards — in section order (projects A-Z, then
// tags A-Z, untagged last). `j`/`k`/arrows walk this list regardless of
// section/kind boundaries. A COLLAPSED section contributes one "header"
// row instead of its cards, so it stays reachable by keyboard (→/Enter
// expands it).
export type MergedRow =
  | ({ kind: "todo" } & TodoRow)
  | { kind: "triaged"; note: TriagedNote }
  | { kind: "header"; section: string };

export interface UseTodosDataParams {
  // Which view is showing — drives the refetch-on-switch effect and the
  // scroll-selected-into-view effect below (both no-ops in the Inbox view).
  view: "inbox" | "todos";
  // From useSearch. `searchLower` is what the filtering memos below list in
  // their dep arrays (they intentionally omit `matchesSearch`, which is a
  // fresh closure every render — see the eslint-disable comments, carried
  // over from App.tsx unchanged).
  searchLower: string;
  matchesSearch: (body: string, tags: string[], extra?: string) => boolean;
}

// Todos view data + selection: the two on-disk sources (triaged notes,
// project todo files), the sectioned/merged lists built from them, and the
// three effects that keep the selection following that merged list. Actions
// that MUTATE this data (status flips, tag edits, delete, reroute, copy)
// live in useTodosActions — this hook is read + navigate only.
export function useTodosData({
  view,
  searchLower,
  matchesSearch,
}: UseTodosDataParams) {
  // Collapsed Todos sections (`←`/`→` or header click), keyed
  // `project::<name>` / `tag::<tag|untagged>` / `icebox`. Session-only.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [triaged, setTriaged] = useState<TriagedNote[]>([]);
  // Raw file content by filename, alongside the parsed `triaged` list —
  // needed to round-trip `setTriagedStatus` (rewrite just the frontmatter
  // status line) without reconstructing the rest of the file from parsed
  // parts.
  const [triagedContent, setTriagedContent] = useState<Map<string, string>>(
    new Map(),
  );
  const [triagedExpanded, setTriagedExpanded] = useState<Set<string>>(
    new Set(),
  );
  // Titled TODO entries clamp their raw body to one line (style C) —
  // Enter/click expands, keyed `project::entryIndex`. Session-only, like
  // triagedExpanded.
  const [todoExpanded, setTodoExpanded] = useState<Set<string>>(new Set());
  // Show-done toggle for the merged Todos view (small header button, only
  // visible there).
  const [showDone, setShowDone] = useState(false);
  // Todos view data: one (project, on-disk entries) pair per
  // ~/notes/todos/<project>.md, in the mtime-DESC order Rust returns
  // (re-sorted A-Z for display — see `projectSections` below).
  const [todos, setTodos] = useState<
    { project: string; entries: TodoEntry[] }[]
  >([]);
  // Selection index into the merged flat list (`mergedFlat`), shared by both
  // row kinds.
  const [todosSelected, setTodosSelected] = useState(0);
  // Indexes the merged flat list (`mergedFlat`), shared by both row kinds.
  const todosCardRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Key of the row to re-select once the merged flat list recomputes —
  // set by status flips so the selection follows the card to its new
  // section instead of landing on whatever slid into the old index.
  const pendingSelectKeyRef = useRef<string | null>(null);

  // Failure-tolerant: an unreadable notes/ dir just means an empty list.
  const loadTriaged = useCallback(async () => {
    try {
      const pairs = await readTriaged();
      setTriaged(
        pairs.map(([filename, content]) => parseTriagedFile(filename, content)),
      );
      setTriagedContent(new Map(pairs));
    } catch {
      setTriaged([]);
      setTriagedContent(new Map());
    }
  }, []);

  // Failure-tolerant: an unreadable todos/ dir just means an empty list.
  const loadTodos = useCallback(async () => {
    try {
      const pairs = await readTodos();
      setTodos(
        pairs.map(([project, content]) => ({
          project,
          entries: parseTodos(content),
        })),
      );
    } catch {
      setTodos([]);
    }
  }, []);

  // The fs watcher only covers ~/notes NonRecursive, so notes/ and todos/
  // edits never emit inbox-changed — refetch both sources explicitly on
  // every switch into the merged Todos view.
  useEffect(() => {
    if (view === "todos") {
      loadTriaged();
      loadTodos();
    }
  }, [view, loadTriaged, loadTodos]);

  // Also load both on mount so the tab's pending count is right before the
  // view is ever opened. Routing writes refresh todos via loadTodos() calls.
  useEffect(() => {
    loadTriaged();
    loadTodos();
  }, [loadTriaged, loadTodos]);

  // Pending count shown on the Todos tab: ⬜ todo entries across all
  // projects + triaged notes not yet marked done. Iced rows of either kind
  // don't count — the icebox is excluded from every count.
  const todosPending = useMemo(
    () =>
      todos.reduce(
        (sum, t) =>
          sum + t.entries.filter((e) => e.status === "pending").length,
        0,
      ) +
      triaged.filter((n) => n.status !== "done" && n.status !== "iced").length,
    [todos, triaged],
  );

  // Triaged cards: hidden when done unless showDone is on, then filtered by
  // search — same predicate order for both concerns everywhere they appear.
  // Iced notes never show here: they render in the pooled Icebox section
  // instead (see `icedTriaged`), same as iced todo entries.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const visibleTriaged = useMemo(() => {
    return triaged.filter((n) => {
      if (n.status === "iced") return false;
      if (!showDone && n.status === "done") return false;
      return matchesSearch(n.body, n.tags, n.title ?? undefined);
    });
  }, [triaged, showDone, searchLower]);

  // Tag sections (2nd group in the merged Todos view): triaged notes grouped
  // by first tag, sections ordered A-Z, untagged forced last regardless of
  // where it'd alphabetize. Within a section, keep the mtime-DESC order
  // `triaged` already arrives in from Rust.
  const tagSections = useMemo(() => {
    const byTag = new Map<string, TriagedNote[]>();
    const untagged: TriagedNote[] = [];
    for (const n of visibleTriaged) {
      const tag = n.tags[0];
      if (!tag) {
        untagged.push(n);
        continue;
      }
      const existing = byTag.get(tag);
      if (existing) {
        existing.push(n);
      } else {
        byTag.set(tag, [n]);
      }
    }
    // Oldest first inside each section (matches the todo sections): Rust
    // returns mtime-DESC, so reverse each section's list.
    const sections: { tag: string | null; notes: TriagedNote[] }[] = [
      ...byTag.keys(),
    ]
      .sort((a, b) => a.localeCompare(b))
      .map((tag) => ({ tag, notes: byTag.get(tag)!.slice().reverse() }));
    if (untagged.length)
      sections.push({ tag: null, notes: untagged.slice().reverse() });
    return sections;
  }, [visibleTriaged]);

  // Project sections (1st group in the merged Todos view): one section per
  // project, A-Z. Pending entries first (⬜ newest-first — entries are
  // appended oldest-first on disk, so reverse for display), done entries
  // collapsed behind showDone (also newest-first). `entryIndex` keeps each
  // row's position in the project's on-disk entries array so a
  // toggle/delete can rewrite via `serializeTodos` without disturbing order.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const projectSections = useMemo(() => {
    return todos
      .map(({ project, entries }) => {
        const indexed: TodoRow[] = entries.map((entry, entryIndex) => ({
          project,
          entryIndex,
          entry,
        }));
        const passesSearch = (row: TodoRow) =>
          matchesSearch(
            row.entry.body,
            row.entry.tags,
            `${project} ${row.entry.title ?? ""}`,
          );
        // Oldest first (user's call): work tasks in the order captured —
        // on-disk append order IS chronological, so no reverse. Iced rows
        // live in their own pooled Icebox section at the very bottom (see
        // `icedRows`), so project sections show only what's workable and
        // their counts match what's visible; done rows hide behind the
        // Show done toggle.
        const pending = indexed.filter(
          (r) => r.entry.status === "pending" && passesSearch(r),
        );
        const done = showDone
          ? indexed.filter((r) => r.entry.status === "done" && passesSearch(r))
          : [];
        return { project, rows: [...pending, ...done] };
      })
      .filter((s) => s.rows.length > 0)
      .sort((a, b) => a.project.localeCompare(b.project));
  }, [todos, showDone, searchLower]);

  // The pooled 🧊 Icebox: every iced entry across all projects, projects
  // A-Z then file order — one section at the very bottom, so parked items
  // stay visible without polluting the working sections or their counts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const icedRows = useMemo<TodoRow[]>(() => {
    return [...todos]
      .sort((a, b) => a.project.localeCompare(b.project))
      .flatMap(({ project, entries }) =>
        entries
          .map((entry, entryIndex) => ({ project, entryIndex, entry }))
          .filter(
            (r) =>
              r.entry.status === "iced" &&
              matchesSearch(
                r.entry.body,
                r.entry.tags,
                `${r.project} ${r.entry.title ?? ""}`,
              ),
          ),
      );
  }, [todos, searchLower]);

  // Iced triaged notes pool into the same Icebox section, after the iced
  // todo entries. Oldest first (Rust returns mtime-DESC, so reverse) —
  // matches every other section's capture order.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const icedTriaged = useMemo(() => {
    return triaged
      .filter(
        (n) =>
          n.status === "iced" &&
          matchesSearch(n.body, n.tags, n.title ?? undefined),
      )
      .slice()
      .reverse();
  }, [triaged, searchLower]);

  // Flat nav list across BOTH row kinds, in section order (projects A-Z,
  // then tags A-Z, untagged last, icebox at the very bottom) — arrows
  // navigate this regardless of section or row-kind boundaries.
  const mergedFlat = useMemo<MergedRow[]>(() => {
    const rows: MergedRow[] = [];
    for (const section of projectSections) {
      const key = `project::${section.project}`;
      if (collapsed.has(key)) {
        rows.push({ kind: "header", section: key });
        continue;
      }
      for (const row of section.rows) rows.push({ kind: "todo", ...row });
    }
    for (const section of tagSections) {
      const key = `tag::${section.tag ?? "untagged"}`;
      if (collapsed.has(key)) {
        rows.push({ kind: "header", section: key });
        continue;
      }
      for (const note of section.notes) rows.push({ kind: "triaged", note });
    }
    if (icedRows.length + icedTriaged.length > 0 && collapsed.has("icebox")) {
      rows.push({ kind: "header", section: "icebox" });
    } else {
      for (const row of icedRows) rows.push({ kind: "todo", ...row });
      for (const note of icedTriaged) rows.push({ kind: "triaged", note });
    }
    return rows;
  }, [projectSections, tagSections, icedRows, icedTriaged, collapsed]);

  const rowKey = (row: MergedRow) =>
    row.kind === "todo"
      ? `todo::${row.project}::${row.entryIndex}`
      : row.kind === "triaged"
        ? `triaged::${row.note.filename}`
        : `header::${row.section}`;

  // The section a row lives in — iced rows belong to the pooled icebox, not
  // their project/tag section.
  const sectionKeyOf = (row: MergedRow): string => {
    if (row.kind === "header") return row.section;
    if (row.kind === "todo") {
      return row.entry.status === "iced" ? "icebox" : `project::${row.project}`;
    }
    return row.note.status === "iced"
      ? "icebox"
      : `tag::${row.note.tags[0] ?? "untagged"}`;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const mergedIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    mergedFlat.forEach((row, i) => {
      m.set(rowKey(row), i);
    });
    return m;
  }, [mergedFlat]);

  // Selection follows the card: a status flip (or section collapse) stashes
  // the key to chase; once the flat list recomputes, land on it. A key that
  // vanished (e.g. done + Show done off) leaves the clamped selection alone.
  useEffect(() => {
    const key = pendingSelectKeyRef.current;
    if (!key) return;
    pendingSelectKeyRef.current = null;
    const idx = mergedIndexByKey.get(key);
    if (idx !== undefined) setTodosSelected(idx);
  }, [mergedIndexByKey]);

  useEffect(() => {
    setTodosSelected((s) => Math.max(0, Math.min(s, mergedFlat.length - 1)));
  }, [mergedFlat]);

  useEffect(() => {
    if (view !== "todos") return;
    todosCardRefs.current[todosSelected]?.scrollIntoView({ block: "nearest" });
  }, [todosSelected, view]);

  return {
    collapsed,
    setCollapsed,
    triaged,
    setTriaged,
    triagedContent,
    setTriagedContent,
    triagedExpanded,
    setTriagedExpanded,
    todoExpanded,
    setTodoExpanded,
    showDone,
    setShowDone,
    todos,
    setTodos,
    todosSelected,
    setTodosSelected,
    todosCardRefs,
    pendingSelectKeyRef,
    loadTriaged,
    loadTodos,
    todosPending,
    tagSections,
    projectSections,
    icedRows,
    icedTriaged,
    mergedFlat,
    mergedIndexByKey,
    sectionKeyOf,
  };
}

export type TodosDataHook = ReturnType<typeof useTodosData>;
