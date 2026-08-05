import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Note, parseInbox, serializeInbox } from "../inbox";
import { autoTag } from "../lib/autotag";
import { appendToArchive } from "../lib/archive";
import {
  readInbox,
  writeInbox,
  readArchive,
  writeArchive,
} from "../lib/commands";
import { loadConfig, SidelineConfig } from "../lib/config";

export interface UseInboxParams {
  // Current config state App.tsx owns — read here only for the `knownTags`
  // memo (the auto-tagger's OWN known-tags set, computed inside `reload()`,
  // uses same-invocation locals instead; see the comment there).
  pinnedTags: string[];
  hiddenTags: string[];
  projectTags: string[];
  // The three built-in quick tags (bug/todo/idea) — a plain App.tsx module
  // constant, passed through rather than duplicated so there's one source
  // of truth for both `reload()`'s known-tags set and the quick-tag keys
  // (1/2/3) App.tsx's keydown handler still owns.
  quickTags: string[];
  // The "load AND SET all config state" half of what reload() does — stays
  // in App.tsx (it owns every config state slice); reload() calls it as a
  // named step so the read+parse-inbox, load+apply-config, then auto-tag
  // order from Task 11 is preserved exactly.
  applyConfig: (config: SidelineConfig) => void;
  matchesSearch: (body: string, tags: string[], extra?: string) => boolean;
  searchLower: string;
  showToast: (message: string, onUndo?: () => void) => void;
  dismissToast: () => void;
}

// Inbox view state + the read/parse/auto-tag/persist motion behind it:
// preamble, notes, error, selection, and the two refs the auto-tagger uses
// to avoid re-scanning a note or re-adding a tag the user just removed
// (both reset only on app restart — see their own comments below). The
// Todos view's data/actions live in useTodosData/useTodosActions instead;
// this hook owns only the Inbox view's notes.
export function useInbox({
  pinnedTags,
  hiddenTags,
  projectTags,
  quickTags,
  applyConfig,
  matchesSearch,
  searchLower,
  showToast,
  dismissToast,
}: UseInboxParams) {
  const [preamble, setPreamble] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [archiveTags, setArchiveTags] = useState<string[]>([]);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const notesRef = useRef<Note[]>([]);
  // Always-current mirror of `preamble`, for the same reason notesRef
  // mirrors `notes`: `persist` is called from long-running async flows
  // (triage, batch triage, their undo closures), and every write has to
  // carry the preamble as it is NOW, not as it was when the calling closure
  // was created. See persist's own comment below.
  const preambleRef = useRef("");
  // Notes already scanned for auto-tagging this app run, keyed by `note.raw`
  // (which encodes tags+body+header, so a note that returns to a
  // previously-seen tag set — e.g. the user removes a tag the auto-tagger
  // just added — naturally re-matches an already-processed key and is left
  // alone). Reset only on app restart (known limitation, see CLAUDE.md).
  const autoTaggedRef = useRef<Set<string>>(new Set());
  // Tags the user manually removed this app run, keyed
  // `${note.timestamp}::${tag}` (timestamp survives the raw churn a tag
  // edit causes) — the auto-tagger skips these so a removed tag never
  // comes back just because the body still mentions it.
  const removedTagsRef = useRef<Set<string>>(new Set());

  const loadArchiveTags = async (): Promise<string[]> => {
    try {
      const text = await readArchive();
      const { notes: archiveNotes } = parseInbox(text);
      const s = new Set<string>();
      for (const n of archiveNotes) for (const t of n.tags) s.add(t);
      return [...s];
    } catch {
      return [];
    }
  };

  const reload = useCallback(async () => {
    let parsedPreamble = "";
    let parsedNotes: Note[] = [];
    let readOk = false;
    try {
      const text = await readInbox();
      const parsed = parseInbox(text);
      parsedPreamble = parsed.preamble;
      parsedNotes = parsed.notes;
      setError(null);
      readOk = true;
    } catch (e) {
      setError(String(e));
    }
    const [config, archive] = await Promise.all([
      loadConfig(),
      loadArchiveTags(),
    ]);
    applyConfig(config);
    setArchiveTags(archive);

    if (!readOk) return;

    // Auto-tagging: knownTags computed fresh from the values just loaded in
    // this pass (not the component's `notes`/`archiveTags`/`pinnedTags`
    // state, which can lag a render behind while this async reload runs).
    const known = new Set<string>();
    for (const n of parsedNotes) for (const t of n.tags) known.add(t);
    for (const t of archive) known.add(t);
    for (const t of config.pinnedTags) known.add(t);
    // Project tags are first-class tags: they may never appear on a live
    // inbox note (project-tagged notes get triaged out fast), but speaking
    // a project name is exactly what should trigger routing.
    for (const t of config.projectTags) known.add(t);
    for (const t of quickTags) known.add(t);
    // Deleted tags never resurface via the auto-tagger either.
    for (const t of config.hiddenTags) known.delete(t);

    const {
      changed,
      nextNotes: taggedNotes,
      processedKeys,
    } = autoTag(parsedNotes, known, {
      alreadyProcessed: autoTaggedRef.current,
      removedTags: removedTagsRef.current,
    });
    // Ref bookkeeping stays here (in the caller): autoTag itself is pure and
    // never mutates alreadyProcessed — it only reports what it newly saw.
    for (const key of processedKeys) autoTaggedRef.current.add(key);

    if (changed) {
      await writeInbox(serializeInbox(parsedPreamble, taggedNotes));
    }
    setPreamble(parsedPreamble);
    setNotes(taggedNotes);
  }, []);

  useEffect(() => {
    reload();
    const un = listen("inbox-changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  const filteredNotes = useMemo(
    () =>
      searchLower ? notes.filter((n) => matchesSearch(n.body, n.tags)) : notes,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, searchLower],
  );

  useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, filteredNotes.length - 1)));
  }, [filteredNotes]);

  // Always-current mirror of `notes`, for the async triageWithClaude flow:
  // the note's index/existence can change while a claude run is in flight,
  // so completion handling must read live state rather than a closed-over
  // value.
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    preambleRef.current = preamble;
  }, [preamble]);

  useEffect(() => {
    cardRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // The one write path for inbox.md: set state, serialize, write. STABLE by
  // construction (`useCallback([])` + `preambleRef`, no captured state) —
  // that is load-bearing, not tidiness. It is called from `useCallback`s
  // whose dep arrays don't (and shouldn't) list it, and from async flows
  // that started renders ago; an unmemoized `persist` closing over
  // `preamble` would let any of those write a preamble from the render that
  // froze them, silently reverting whatever the top of inbox.md says now.
  // `next` is always passed in (computed by the caller from `notesRef` at
  // ITS completion time), so setNotes needs no functional form — nothing
  // about the notes is captured here.
  const persist = useCallback(async (next: Note[]) => {
    setNotes(next);
    await writeInbox(serializeInbox(preambleRef.current, next));
  }, []);

  // Every tag is an independent checkbox toggle — quick tags included (a
  // note CAN be bug + todo + idea at once; the old radio-swap rule fought
  // the auto-tagger, which legitimately matches several). Removals are
  // remembered so the auto-tagger never re-adds a tag the user took off.
  const toggleTag = (idx: number, tag: string) => {
    const next = notes.map((n, i) => {
      if (i !== idx) return n;
      if (n.tags.includes(tag)) {
        removedTagsRef.current.add(`${n.timestamp}::${tag}`);
        return { ...n, tags: n.tags.filter((t) => t !== tag) };
      }
      removedTagsRef.current.delete(`${n.timestamp}::${tag}`);
      return { ...n, tags: [...n.tags, tag] };
    });
    persist(next);
  };

  // Known tags = union of tags on current inbox notes, tags parsed from
  // archive.md, and pinned tags. Archive is append-only, so project tags
  // persist after the inbox empties.
  const knownTags = useMemo(() => {
    const s = new Set<string>();
    for (const n of notes) for (const t of n.tags) s.add(t);
    for (const t of archiveTags) s.add(t);
    for (const t of pinnedTags) s.add(t);
    for (const t of projectTags) s.add(t);
    for (const t of hiddenTags) s.delete(t);
    return s;
  }, [notes, archiveTags, pinnedTags, projectTags, hiddenTags]);

  const remove = async (idx: number) => {
    const note = notes[idx];
    const prevNotes = notes;
    const prevArchive = await appendToArchive(note.raw);
    persist(prevNotes.filter((_, i) => i !== idx));
    showToast("Archived", () => {
      writeArchive(prevArchive);
      persist(prevNotes);
      dismissToast();
    });
  };

  return {
    preamble,
    notes,
    error,
    selected,
    setSelected,
    archiveTags,
    cardRefs,
    notesRef,
    autoTaggedRef,
    removedTagsRef,
    filteredNotes,
    persist,
    toggleTag,
    remove,
    knownTags,
  };
}
