import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { type Note, parseInbox, serializeInbox } from "../inbox";
import { autoTag } from "../lib/autotag";
import {
  type ClassifyPick,
  Limiter,
  applyClassifierPicksToFreshNotes,
  buildClassifyRequest,
  buildClaudePrompt,
  parseClaudeReply,
  parseLocalResponse,
  runClassifyBatch,
  selectForClassification,
  withinClassifyWindow,
} from "../lib/classify";
import { autoListPlan, listKey, parseLists } from "../lib/listFormat";
import { detectListViaClaude } from "../lib/listRun";
import { appendToArchive, undoArchiveAppend } from "../lib/archive";
import { parseReminder, reminderId } from "../lib/reminders";
import {
  INBOX_CONFLICT,
  readInbox,
  writeInbox,
  readArchive,
  addReminder,
  removeReminder,
  classifyLocal,
  sendToClaude,
  readLists,
  setListEntry,
} from "../lib/commands";
import { insertNoteAt } from "../lib/undo";
import { loadConfig, type SidelineConfig } from "../lib/config";

// Module-level (not per-hook-instance, though there's only ever one
// useInbox call site) so that two overlapping runClassifier calls — e.g.
// two `inbox-changed` events firing in quick succession, each starting its
// own reload()/runClassifier() — still share one cap of 2 concurrent
// classify calls total, rather than 2 each.
const classifierLimiter = new Limiter(2);
// Same shape for the spoken-list formatter (runListFormatter below).
const listLimiter = new Limiter(2);

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
  // Version token from the last read_inbox/write_inbox round-trip — the
  // compare-and-swap baseline every write carries. A write refused as
  // stale (INBOX_CONFLICT) means something appended to inbox.md that this
  // state hasn't absorbed yet; clobbering it would erase that entry.
  const versionRef = useRef("");
  // Mirror so `persist` (stable useCallback([])) can toast without
  // capturing a render-scoped showToast.
  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  });
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
  // Notes already scanned for a reminder this app run, keyed by `note.raw`
  // — same once-per-note-per-run shape as autoTaggedRef above, and for the
  // same reason: a note that keeps its raw unchanged across reloads (the
  // common case) must not be re-registered every time inbox.md is re-read.
  const remindersScannedRef = useRef<Set<string>>(new Set());
  // Whether the last scan of a given reminder id (see reminderId) actually
  // registered a reminder — so a later scan that finds the SAME note edited
  // to no longer parse as a reminder knows to call removeReminder instead
  // of silently doing nothing. Only meaningful for ids this run has scanned
  // at least once; an id never seen this run is assumed not registered,
  // which is fine — the note it belonged to hasn't changed, so there is
  // nothing to remove.
  const remindersRegisteredRef = useRef<Map<string, boolean>>(new Map());
  // note.raw → the reminder id registered for it this run, so deleting a
  // note (see remove) can cancel its reminder with the exact id the scan
  // used (timestamp, or timestamp+icon on a same-minute collision).
  const reminderIdByRawRef = useRef<Map<string, string>>(new Map());
  // Notes already scanned for classification this app run, keyed by
  // note.timestamp (NOT raw, unlike autoTaggedRef) — a note's raw changes on
  // every tag edit and on the classifier's own write, and re-scanning either
  // would break the "classified at most once per session" contract; the
  // timestamp is stable across both. Reset only on app restart.
  const classifiedRef = useRef<Set<string>>(new Set());
  // Notes already scanned by the spoken-list formatter this app run, keyed by
  // listKey (timestamp + body hash). Every scanned note is marked, eligible
  // or not, BEFORE any await — the formatter's own sidecar write fires
  // `inbox-changed`, which re-runs reload() and must find nothing new to do.
  const listCheckedRef = useRef<Set<string>>(new Set());
  // True once the local-classifier-unreachable toast has fired this app
  // run — see runClassifier below: one toast per app run, not one per note.
  const classifierToastedRef = useRef(false);

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

  // Persists one note's classifier pick: freshly reads inbox.md (never the
  // component's own notes state, which can be stale relative to disk by the
  // time a classify network call resolves), matches the pick against that
  // fresh read by timestamp+body (see applyClassifierPicksToFreshNotes), and
  // writes back only if that produced a change. Resolves normally (never
  // rejects) on every outcome including an INBOX_CONFLICT — a conflict here
  // means something else wrote to inbox.md between this read and this
  // write, so the write is silently dropped (no toast: this is a background
  // pass, not a user action to redo) rather than risk clobbering that other
  // change; other errors are logged, not thrown, so a run of concurrent
  // per-note write-backs can never produce an unhandled rejection.
  const writeBackClassifierPick = async (
    note: Note,
    pick: ClassifyPick,
    config: SidelineConfig,
  ): Promise<void> => {
    try {
      const [text, version] = await readInbox();
      const { preamble: freshPreamble, notes: freshNotes } = parseInbox(text);
      const { changed, nextNotes } = applyClassifierPicksToFreshNotes(
        freshNotes,
        [{ timestamp: note.timestamp, body: note.body, pick }],
        {
          removedTags: removedTagsRef.current,
          projectTags: config.projectTags,
          hiddenTags: new Set(config.hiddenTags),
        },
      );
      if (!changed) return;
      versionRef.current = await writeInbox(
        serializeInbox(freshPreamble, nextNotes),
        version,
      );
      setPreamble(freshPreamble);
      setNotes(nextNotes);
    } catch (e) {
      if (String(e).includes(INBOX_CONFLICT)) return;
      console.error("classifier write-back failed:", e);
    }
  };

  // Classifier pass: kicked off (not awaited) by reload() below, after
  // notes/preamble already went into state, so a slow or unreachable
  // classifier never delays the notes list from showing. Every eligible
  // note is marked processed regardless of outcome (see
  // selectForClassification) so a persistently unreachable local classifier
  // is tried once per note per app run, not retried every reload. Each
  // note's result is written back as soon as it's ready
  // (writeBackClassifierPick above), not batched into one write after the
  // whole pass — see runClassifyBatch. Concurrency is capped by the
  // module-level classifierLimiter, shared across every runClassifier call
  // this session, not just this one.
  const runClassifier = async (
    currentNotes: Note[],
    config: SidelineConfig,
  ) => {
    const provider = config.classifier.provider;
    if (provider === "off") return;
    // No-Claude-mode disables the claude provider the same way it disables
    // every other send_to_claude call — silent fallback to "off" behavior.
    if (provider === "claude" && !config.claude) return;

    const { eligible, processedKeys } = selectForClassification(currentNotes, {
      alreadyProcessed: classifiedRef.current,
      projectTags: config.projectTags,
      now: new Date(),
    });
    for (const key of processedKeys) classifiedRef.current.add(key);
    if (eligible.length === 0) return;

    let localUnreachable = false;
    await runClassifyBatch(
      eligible,
      {
        classify: async (note) => {
          try {
            if (provider === "local") {
              const payload = buildClassifyRequest(note, config.projectTags);
              const resp = await classifyLocal(config.classifier.url, payload);
              return parseLocalResponse(resp, config.projectTags);
            }
            const prompt = buildClaudePrompt(note, config.projectTags);
            const reply = await sendToClaude(prompt, config.models.triage);
            return parseClaudeReply(reply, config.projectTags);
          } catch (e) {
            // claude errors are silent per-note; a local error also stays
            // silent per-note, but flags the one-time toast below.
            if (provider === "local") localUnreachable = true;
            throw e;
          }
        },
        writeBack: (note, pick) => writeBackClassifierPick(note, pick, config),
      },
      classifierLimiter,
    );

    if (localUnreachable && !classifierToastedRef.current) {
      classifierToastedRef.current = true;
      showToastRef.current("Classifier unreachable — using keyword tags only");
    }
  };

  // Auto-formats new long voice notes that are spoken lists (display layer
  // only — see src/lib/listFormat.ts; the note on disk is never modified).
  // Fire-and-forget from reload(), like runClassifier: never delays the
  // list. Only the sidecar entry is written: validated starts + show, or
  // `starts: null` for "not a list" / failed validation. Explicit
  // enumerations ("first, second…", "one, two, three…") are formatted
  // instantly by rules — any length, no Claude, not counted against the
  // limiter; only longer notes the rules didn't catch go to Claude (and
  // only with `claude` on). A thrown Claude error writes nothing, so the
  // note is tried again next launch. Silent on errors.
  const runListFormatter = async (
    currentNotes: Note[],
    config: SidelineConfig,
  ) => {
    if (!config.autoList) return;
    const now = new Date();
    const pending: {
      key: string;
      body: string;
      plan: Exclude<ReturnType<typeof autoListPlan>, "skip">;
    }[] = [];
    for (const n of currentNotes) {
      const key = listKey(n.timestamp, n.body);
      if (listCheckedRef.current.has(key)) continue;
      listCheckedRef.current.add(key);
      if (!withinClassifyWindow(n.timestamp, now)) continue;
      const plan = autoListPlan(n.body);
      if (plan === "skip") continue;
      if (plan === "claude" && !config.claude) continue;
      pending.push({ key, body: n.body, plan });
    }
    if (pending.length === 0) return;
    // Fresh read (not hook state, which may be stale): a note formatted by
    // `l`, or by an earlier launch, already has an entry and is skipped.
    let existing: ReturnType<typeof parseLists>;
    try {
      existing = parseLists(await readLists());
    } catch (e) {
      console.error("list sidecar read failed:", e);
      return;
    }
    await Promise.all(
      pending
        .filter((p) => !(p.key in existing))
        .map(async (p) => {
          // if_absent on every write: an `l` press that finished first wins.
          if (p.plan !== "claude") {
            await setListEntry(
              p.key,
              { starts: p.plan.starts, show: true },
              true,
            ).catch((e) => console.error("list sidecar write failed:", e));
            return;
          }
          await listLimiter.run(async () => {
            try {
              const starts = await detectListViaClaude(
                p.body,
                config.models.triage,
              );
              await setListEntry(
                p.key,
                { starts, show: starts !== null },
                true,
              );
            } catch (e) {
              console.error("list formatting failed:", e);
            }
          });
        }),
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const reload = useCallback(async () => {
    let parsedPreamble = "";
    let parsedNotes: Note[] = [];
    let readOk = false;
    try {
      const [text, version] = await readInbox();
      versionRef.current = version;
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

    // Reminders: scan each not-yet-scanned note for a detected reminder
    // (same once-per-note-per-run shape as auto-tagging, keyed by raw) and
    // register hits with the backend — covers in-app voice, typed notes,
    // and external Raycast captures alike, since they all land in
    // inbox.md and this scans whatever read_inbox just returned.
    // Fire-and-forget: a failed add_reminder/removeReminder call just means
    // that note's reminder is missed (or not removed) for now — no toast,
    // since a failed add would otherwise fire on every offline reload.
    //
    // A note's reminder id is its timestamp alone, unless another note in
    // THIS batch shares that timestamp (two notes captured in the same
    // minute) — then both fall back to timestamp+icon so they don't
    // collide. See reminderId.
    const timestampCounts = new Map<string, number>();
    for (const n of taggedNotes) {
      timestampCounts.set(
        n.timestamp,
        (timestampCounts.get(n.timestamp) ?? 0) + 1,
      );
    }
    for (const n of taggedNotes) {
      if (remindersScannedRef.current.has(n.raw)) continue;
      remindersScannedRef.current.add(n.raw);
      const id =
        (timestampCounts.get(n.timestamp) ?? 0) > 1
          ? reminderId(n.timestamp, n.icon)
          : reminderId(n.timestamp);
      const capturedAt = new Date(n.timestamp.replace(" ", "T"));
      const detected = Number.isNaN(capturedAt.getTime())
        ? null
        : parseReminder(n.body, capturedAt);
      // An old note seen for the first time whose due time is already more
      // than 12h in the past — treat it as undetected rather than firing
      // it immediately looking wrong.
      const stale =
        detected !== null &&
        Date.now() - detected.due.getTime() > 12 * 60 * 60 * 1000;
      if (detected && !stale) {
        addReminder(
          id,
          detected.text,
          detected.due.getTime(),
          n.timestamp,
        ).catch(() => {});
        remindersRegisteredRef.current.set(id, true);
        reminderIdByRawRef.current.set(n.raw, id);
      } else if (remindersRegisteredRef.current.get(id)) {
        // The note previously parsed as a reminder (this run) and was
        // edited to no longer — drop the not-yet-fired reminder. Triage
        // never cancels (the note lives on); delete does — see remove.
        removeReminder(id, false).catch(() => {});
        remindersRegisteredRef.current.set(id, false);
      }
    }

    if (changed) {
      try {
        versionRef.current = await writeInbox(
          serializeInbox(parsedPreamble, taggedNotes),
          versionRef.current,
        );
      } catch (e) {
        // A conflict here means another append landed between our read and
        // this auto-tag write — skip it; the watcher event for that append
        // re-runs reload and the tagger gets another pass.
        if (!String(e).includes(INBOX_CONFLICT)) throw e;
        return;
      }
    }
    setPreamble(parsedPreamble);
    setNotes(taggedNotes);
    // Fire-and-forget: see runClassifier's own comment for why this must
    // not be awaited here.
    runClassifier(taggedNotes, config);
    runListFormatter(taggedNotes, config);
  }, []);

  useEffect(() => {
    reload();
    const un = listen("inbox-changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const filteredNotes = useMemo(
    () =>
      searchLower ? notes.filter((n) => matchesSearch(n.body, n.tags)) : notes,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const persist = useCallback(async (next: Note[]) => {
    setNotes(next);
    try {
      versionRef.current = await writeInbox(
        serializeInbox(preambleRef.current, next),
        versionRef.current,
      );
    } catch (e) {
      if (String(e).includes(INBOX_CONFLICT)) {
        // inbox.md gained content this state hasn't seen (voice capture,
        // Raycast) — the write was refused so that entry survives. Reload
        // to absorb it and tell the user their action needs a redo; that
        // beats silently erasing a captured note.
        showToastRef.current("Inbox changed on disk — redo your last action.");
        await reload();
        return;
      }
      throw e;
    }
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
    await appendToArchive(note.raw);
    // Remove from the CURRENT list, not a render-scoped snapshot: the
    // awaited archive round-trip above is a window for appends to land.
    persist(notesRef.current.filter((n) => n !== note));
    // A deleted note takes its reminder with it — pending or already
    // fired (clears a banner/pill it left up), so no alert ever fires for
    // a note that's gone.
    const reminderIdForNote = reminderIdByRawRef.current.get(note.raw);
    if (reminderIdForNote) {
      removeReminder(reminderIdForNote, true).catch(() => {});
      remindersRegisteredRef.current.set(reminderIdForNote, false);
    }
    showToast("Archived", () => {
      // Inverse ops against live state, not snapshot restores: a snapshot
      // would erase anything captured or changed since the archive.
      undoArchiveAppend(note.raw).catch(() => {
        showToastRef.current("Undo: archive.md could not be rewritten");
      });
      persist(insertNoteAt(notesRef.current, note, idx));
      // Re-register the reminder only if it's still ahead: one whose due
      // time passed meanwhile would fire the instant it came back.
      const capturedAt = new Date(note.timestamp.replace(" ", "T"));
      const detected = Number.isNaN(capturedAt.getTime())
        ? null
        : parseReminder(note.body, capturedAt);
      if (
        reminderIdForNote &&
        detected &&
        detected.due.getTime() > Date.now()
      ) {
        addReminder(
          reminderIdForNote,
          detected.text,
          detected.due.getTime(),
          note.timestamp,
        ).catch(() => {});
        remindersRegisteredRef.current.set(reminderIdForNote, true);
      }
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
