import { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import {
  type Note,
  parseTodos,
  serializeTodos,
  slugFor,
  toGroupFile,
  toTriagedFile,
  todoEntry,
} from "../inbox";
import {
  needsTitle,
  TITLE_PROMPT,
  sanitizeTitle,
  localTitle,
  groupByFirstTag,
} from "../lib/format";
import { buildBatchPrompt, parseBatchReply } from "../lib/batch";
import { insertNoteAt, mergeMissingNotes } from "../lib/undo";
import {
  deleteTriaged,
  readTodos,
  sendToClaude,
  triageNote,
  writeTodos,
} from "../lib/commands";
import type { Models, Prompts } from "../lib/config";

export interface UseTriageParams {
  // Live mirror of the inbox notes (from useInbox). Both flows read it
  // instead of a captured `notes` value: a triage run outlives several
  // renders, so every "is this note still here / where is it now" question
  // has to be asked against current state, not the state at press time.
  notesRef: MutableRefObject<Note[]>;
  // useInbox's inbox.md write path. Must be the STABLE identity useInbox
  // hands out — see its comment there; both callbacks below outlive the
  // render that created them.
  persist: (next: Note[]) => Promise<void>;
  prompts: Prompts;
  models: Models;
  // Project tags a note can be routed on: a note carrying one skips Claude
  // entirely and becomes a todo entry instead.
  projectTags: string[];
  // `.sideline.json`'s `claude` key (default true). `false` = no-Claude
  // mode: every non-project triage flow skips `send_to_claude` — titles
  // fall back to `localTitle`, notes file plain with a normal success toast
  // instead of an appendix + CLI-failure toast.
  claude: boolean;
  // From useTodosData — refetches todos/ after a routing write so the Todos
  // view shows the new entry.
  loadTodos: () => Promise<void>;
  showToast: (message: string, onUndo?: () => void) => void;
  dismissToast: () => void;
}

// Appends `notes` to a project's todo file: parse what's already there,
// push one entry per note (with its generated header, if it got one), write
// the whole file back. The single-note and batch routing paths differ in
// how they READ the previous content (one read_todos per note vs one for
// the whole batch) and in what they do when the write fails — but this
// step is identical, so it lives here once. Module-level on purpose: it
// captures nothing, so no closure can hold a stale copy of it.
async function appendProjectTodos(
  project: string,
  prevContent: string,
  notes: Note[],
  titles: Map<string, string>,
) {
  const entries = parseTodos(prevContent);
  for (const n of notes) entries.push(todoEntry(n, titles.get(n.raw)));
  await writeTodos(project, serializeTodos(entries));
}

// Files one note to notes/: with the Claude reply as a `## Claude`
// appendix when there is one, plain when there isn't (CLI failure, batch
// parse miss, or the routing-failed fallback). Returns the filename the
// backend actually used — it never clobbers, so it may have appended a
// `-1`/`-2` suffix. Also module-level, also captures nothing.
function fileNote(
  note: Note,
  reply: string | undefined,
  title: string | undefined,
) {
  return triageNote(
    slugFor(note),
    toTriagedFile(
      note,
      reply !== undefined ? { title: "Claude", body: reply } : undefined,
      title,
    ),
  );
}

// The two triage flows — `t`/✓ on one card, and Shift+T/"✨ All (N)" on the
// whole inbox — plus the in-flight state the UI reads (`sending` per card,
// `batchRunning` for the batch button) and the header-generating Haiku call
// both share. Everything here is async and long-running by nature: a run
// starts in one render and finishes many renders later, so nothing may be
// read from a captured snapshot that could have moved on — hence notesRef
// and the stable `persist` above.
export function useTriage({
  notesRef,
  persist,
  prompts,
  models,
  projectTags,
  claude,
  loadTodos,
  showToast,
  dismissToast,
}: UseTriageParams) {
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);

  // One extra Haiku call per triage action (single or batch), only when at
  // least one note being triaged is longer than ~2 rows: numbered bodies in,
  // `<n>: <headline>` lines out. Failure-tolerant — an empty map just means
  // no headers, never a stuck note. Kept separate from the triage/batch
  // prompts so user overrides of those never break header parsing.
  // Keyed on `raw` — for inbox Notes that's the exact block text; callers
  // titling something else (e.g. a TriagedNote at re-route time, which has
  // no `raw`) just pass a `{raw, body}` shape using whatever unique key fits
  // (its filename works fine as `raw` there).
  const generateTitles = useCallback(
    async (
      notesToTitle: { raw: string; body: string }[],
    ): Promise<Map<string, string>> => {
      const long = notesToTitle.filter((n) => needsTitle(n.body));
      const titles = new Map<string, string>();
      if (long.length === 0) return titles;
      if (!claude) {
        // No-Claude mode: derive each title locally (first non-empty line,
        // sanitized) instead of a Haiku call — same needsTitle gate, no CLI
        // round-trip. All three triage flows share this choke point, so
        // they inherit local titles automatically.
        for (const note of long) {
          const title = localTitle(note.body);
          if (title) titles.set(note.raw, title);
        }
        return titles;
      }
      const body = long.map((n, i) => `${i + 1}.\n${n.body}`).join("\n\n");
      try {
        const reply = await sendToClaude(
          `${TITLE_PROMPT}\n\n${body}`,
          models.triage,
        );
        for (const line of reply.split("\n")) {
          const m = line.match(/^\s*(\d+)\s*[:.)-]\s*(.+)$/);
          if (!m) continue;
          const note = long[Number(m[1]) - 1];
          const title = sanitizeTitle(m[2]);
          if (note && title) titles.set(note.raw, title);
        }
      } catch {
        // No titles this round — the notes still file/route fine without.
      }
      return titles;
    },
    [models, claude],
  );

  // Single-note completion after a successful filing: drop the note from
  // the completion-time snapshot, then offer the undo that deletes the file
  // it just created and puts that same snapshot back. Both single-note
  // filing branches (Claude replied / CLI failed) end exactly this way and
  // differ only in the toast text. Not memoized, and deliberately not in
  // any dep array: it captures only the stable `persist`, `showToast`/
  // `dismissToast` (which close over refs and setState, never state
  // values), and module-level functions — so a frozen copy of it inside the
  // callbacks below can never serve stale data.
  const completeFiling = (
    current: Note[],
    currentIdx: number,
    filename: string,
    message: string,
  ) => {
    const note = current[currentIdx];
    persist(current.filter((_, i) => i !== currentIdx));
    showToast(message, () => {
      deleteTriaged(filename).catch((e) =>
        showToast(`Undo failed: ${String(e)}`),
      );
      // Re-insert the filed note into the LIVE list, not the completion
      // snapshot: a snapshot restore would erase any note captured (or
      // change made) between filing and undo.
      persist(insertNoteAt(notesRef.current, note, currentIdx));
      dismissToast();
    });
  };

  // The triage path (`t` / ✓): project-tagged notes are filed instantly with
  // no Claude call at all (section B) — the in-repo Claude session plans
  // with real code context anyway, so paying for a CLI round-trip here is
  // pure waste. The routed todo entry is appended to Sideline's own
  // ~/notes/todos/<project>.md (never the project repo, and — per the
  // merged-Todos-view dedupe — never ALSO a notes/ file; the todo entry is
  // the only record) so the app can see and toggle it later. Everything
  // else still runs through the `claude` CLI with the triage prompt, filed
  // to notes/ with the reply appended under `## Claude`. Async and per-card
  // — other cards stay fully usable while this runs, so completion must
  // re-locate the note by `raw` rather than trust `idx`. A note must never
  // be stuck: CLI failure falls back to plain (appendix-less) filing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const triageWithClaude = useCallback(
    async (idx: number) => {
      const note = notesRef.current[idx];
      if (!note || sending.has(note.raw)) return;
      // A note needs at least one tag to leave the inbox (archiving is the
      // exception) — no Claude tokens on cards that haven't been classified.
      if (note.tags.length === 0) {
        showToast("Tag it first — untagged notes can't be triaged");
        return;
      }
      setSending((s) => new Set(s).add(note.raw));
      try {
        const project = note.tags.find((t) => projectTags.includes(t));
        if (project) {
          // No `triage_note` call — the todo entry is the only record for a
          // routed note now. A write_todos failure here is a filesystem
          // problem, not a "note needs somewhere to go" problem, so the note
          // is left in the inbox (nothing removed, nothing to undo) rather
          // than manufacturing a plain notes/ file that would just be a
          // second copy once routing is retried.
          // Long notes cost one Haiku header call before routing (the one
          // exception to $0 routing); short notes still route instantly.
          const titles = await generateTitles([note]);
          let prevTodoContent: string;
          try {
            const pairs = await readTodos();
            const existing = pairs.find(([p]) => p === project);
            prevTodoContent = existing ? existing[1] : "";
            await appendProjectTodos(project, prevTodoContent, [note], titles);
            loadTodos();
          } catch (e) {
            showToast(`Todo routing to ${project} failed: ${String(e)}`);
            return;
          }

          // Re-find by raw against *current* state — same rationale as the
          // Claude path below: the note could have moved while these awaits
          // were in flight.
          const current = notesRef.current;
          const currentIdx = current.findIndex((n) => n.raw === note.raw);
          if (currentIdx === -1) {
            showToast("Note gone — todo already routed");
            return;
          }
          const routed = current[currentIdx];
          persist(current.filter((_, i) => i !== currentIdx));
          showToast(`Todo → ${project}`, () => {
            writeTodos(project, prevTodoContent)
              .then(() => loadTodos())
              .catch((e) => showToast(`Undo failed: ${String(e)}`));
            // Re-insert into the LIVE list — a completion-snapshot restore
            // would erase notes captured between routing and undo.
            persist(insertNoteAt(notesRef.current, routed, currentIdx));
            dismissToast();
          });
          return;
        }

        // Header call runs concurrently with the triage call, so long notes
        // don't pay double latency.
        const titlesPromise = generateTitles([note]);
        let reply: string | undefined;
        let cliError: string | undefined;
        if (claude) {
          const prompt = `${prompts.triage}\n\n${note.body}`;
          try {
            reply = await sendToClaude(prompt, models.triage);
          } catch (e) {
            cliError = String(e).split("\n")[0] || "claude failed";
          }
        }
        const noteTitle = (await titlesPromise).get(note.raw);

        // The note may have been triaged/deleted by the user while claude
        // was running — re-find it by raw against *current* state.
        const current = notesRef.current;
        const currentIdx = current.findIndex((n) => n.raw === note.raw);
        if (currentIdx === -1) {
          showToast("Note gone — Claude reply discarded");
          return;
        }

        if (cliError !== undefined) {
          // CLI failure fallback: file the note plain, no appendix — a note
          // must never be stuck just because the CLI failed.
          const filename = await fileNote(note, undefined, noteTitle);
          completeFiling(
            current,
            currentIdx,
            filename,
            `Triaged (Claude failed: ${cliError}) → notes/${filename}`,
          );
          return;
        }

        // Note is guaranteed non-project here — project-tagged notes already
        // returned via the section B branch above — so no repo routing to
        // do; just file it. In no-Claude mode `reply` stays undefined,
        // which files plain (no appendix) under this same normal-success
        // toast — no error wording, because nothing failed.
        const filename = await fileNote(note, reply, noteTitle);
        completeFiling(
          current,
          currentIdx,
          filename,
          `Triaged → notes/${filename}`,
        );
      } finally {
        // Runs on every exit path (success, gone, failure) so a card never
        // gets stuck showing the sending badge.
        setSending((s) => {
          const next = new Set(s);
          next.delete(note.raw);
          return next;
        });
      }
    },
    // `persist` is listed because it's genuinely read here — and it's the
    // stable identity from useInbox, so listing it costs nothing (it never
    // churns this callback) while making the dependency visible instead of
    // silently captured.
    [
      prompts,
      models,
      projectTags,
      claude,
      sending,
      loadTodos,
      generateTitles,
      persist,
    ],
  );

  // Batch triage (`Shift+T` / "✨ All (N)"): one shared `claude` CLI call for
  // every non-project note instead of one call each — the CLI harness
  // overhead (~15-20k tokens) is paid once instead of per note. Project-
  // tagged notes still skip Claude entirely (same as the single-note path)
  // and are filed instantly, grouped so each project's todo file is read
  // and written once for the whole batch rather than once per note.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  const triageBatch = useCallback(async () => {
    if (batchRunning) return;
    // Exclude notes a single-note triage is already working on — the batch
    // filing would race the in-flight completion into a double file. Also
    // exclude untagged notes: nothing leaves the inbox without a tag
    // (archiving is the exception), so they just stay put.
    const idle = notesRef.current.filter((n) => !sending.has(n.raw));
    const startNotes = idle.filter((n) => n.tags.length > 0);
    const untaggedCount = idle.length - startNotes.length;
    if (startNotes.length === 0) {
      if (untaggedCount > 0) showToast("All notes untagged — tag them first");
      return;
    }

    setBatchRunning(true);
    setSending((s) => {
      const next = new Set(s);
      for (const n of startNotes) next.add(n.raw);
      return next;
    });

    try {
      const routed = startNotes.filter((n) =>
        n.tags.some((t) => projectTags.includes(t)),
      );
      const rest = startNotes.filter(
        (n) => !n.tags.some((t) => projectTags.includes(t)),
      );

      // ONE header call for every long note in the batch (routed or not),
      // kicked off first so it overlaps the routing writes and the batch
      // triage call below.
      const titlesPromise = generateTitles(startNotes);

      const filedRaws = new Set<string>();
      const createdFilenames: string[] = [];
      const touchedProjects = new Map<string, string>();
      const projectCounts = new Map<string, number>();
      let restFiledCount = 0;
      let skippedCount = 0;
      let claudeFailed = false;

      // Section B, applied per routed note: no Claude call, and — per the
      // merged-Todos-view dedupe — no notes/ file either; grouped so each
      // project's todo file is read/written once for the whole batch.
      // Notes that vanished mid-run (re-find by raw fails, e.g. the user
      // edited their tags while the batch was running) are skipped rather
      // than routed, so we never route a note that's about to look
      // different in the live inbox.
      const byProject = new Map<string, Note[]>();
      for (const note of routed) {
        const stillPresent = notesRef.current.some((n) => n.raw === note.raw);
        if (!stillPresent) {
          skippedCount++;
          continue;
        }
        const project = note.tags.find((t) => projectTags.includes(t))!;
        const group = byProject.get(project) ?? [];
        group.push(note);
        byProject.set(project, group);
      }

      // One `read_todos` call for the whole batch instead of one per
      // project — then group appends: parse once, append all of a
      // project's new entries, write once, even if several routed notes in
      // this batch share a project.
      if (byProject.size > 0) {
        const routedTitles = await titlesPromise;
        let allTodos: [string, string][] = [];
        try {
          allTodos = await readTodos();
        } catch {
          allTodos = [];
        }
        const todosByProject = new Map(allTodos);

        for (const [project, group] of byProject) {
          try {
            const prev = todosByProject.get(project) ?? "";
            touchedProjects.set(project, prev);
            await appendProjectTodos(project, prev, group, routedTitles);
            projectCounts.set(project, group.length);
            for (const n of group) filedRaws.add(n.raw);
          } catch {
            // Routing failed for this project's whole group — a note must
            // never be stuck, so fall back to plain filing (the one case
            // where a routed note DOES get a notes/ file — createdFilenames/
            // delete_triaged undo covers it same as the non-project
            // remainder below). No header even if one was generated: same
            // appendix-less shape this fallback has always written.
            for (const n of group) {
              const filename = await fileNote(n, undefined, undefined);
              createdFilenames.push(filename);
              filedRaws.add(n.raw);
            }
            restFiledCount += group.length;
          }
        }
        loadTodos();
      }

      // The non-project remainder: ONE Claude call for all of them, grouped
      // by first tag — a 2+ note unit gets one merged reply and one
      // combined roundup file instead of one reply/file per note. In
      // no-Claude mode this call is skipped entirely — `reply` stays
      // undefined, so every unit below (solo or group) falls through to its
      // existing "no section" branch: per-note plain filing with local
      // titles, no roundup files, and `claudeFailed` never flips (so the
      // batch toast carries no "Claude failed" wording for something that
      // was never attempted).
      if (rest.length > 0) {
        const units = groupByFirstTag(rest);
        let reply: string | undefined;
        if (claude) {
          const prompt = buildBatchPrompt(prompts.batch, units);
          try {
            reply = await sendToClaude(prompt, models.batch);
          } catch {
            claudeFailed = true;
          }
        }

        const sectionMap =
          reply !== undefined
            ? parseBatchReply(reply)
            : new Map<number, string>();
        const titles = await titlesPromise;

        for (let i = 0; i < units.length; i++) {
          const unit = units[i];
          // Vanished mid-run (re-find by raw fails, e.g. the user edited
          // tags/deleted the note while the batch was running): skip just
          // that note, not the whole unit.
          const present = unit.notes.filter((n) =>
            notesRef.current.some((cur) => cur.raw === n.raw),
          );
          skippedCount += unit.notes.length - present.length;
          if (present.length === 0) continue;

          // Whole-call failure: never look for a section. Otherwise a
          // per-unit parse miss (missing/blank section) also falls back to
          // plain filing.
          const section = claudeFailed ? undefined : sectionMap.get(i + 1);

          if (present.length === 1) {
            // Solo unit (or a group reduced to one survivor — spec: treat
            // as solo, using the group's reply if the call produced one).
            const note = present[0];
            const filename = await fileNote(
              note,
              section,
              titles.get(note.raw),
            );
            createdFilenames.push(filename);
            filedRaws.add(note.raw);
            restFiledCount++;
            continue;
          }

          if (section) {
            // Group unit, reply present: ONE combined roundup file for the
            // whole group.
            const today = new Date().toISOString().slice(0, 10);
            const filename = await triageNote(
              `${today}-${unit.tag}-roundup.md`,
              toGroupFile(unit.tag!, present, section),
            );
            createdFilenames.push(filename);
            for (const n of present) filedRaws.add(n.raw);
            restFiledCount += present.length;
          } else {
            // Group unit, reply missing (parse miss) or whole-call failure:
            // a combined file without a merged reply has no value — fall
            // back to per-note plain filing so nothing gets stuck.
            for (const n of present) {
              const filename = await fileNote(n, undefined, titles.get(n.raw));
              createdFilenames.push(filename);
              filedRaws.add(n.raw);
              restFiledCount++;
            }
          }
        }
      }

      // Completion-time snapshot — notes may have been tag-edited (their
      // `raw` changed) while the batch ran; only remove the ones actually
      // filed, keyed by the raw captured at filing time.
      const finalCurrent = notesRef.current;
      const remaining = finalCurrent.filter((n) => !filedRaws.has(n.raw));
      persist(remaining);

      const totalFiled =
        restFiledCount + [...projectCounts.values()].reduce((s, c) => s + c, 0);
      let message = `Triaged ${totalFiled} → notes (${restFiledCount})`;
      for (const [project, count] of projectCounts) {
        message += ` · ${project} (${count})`;
      }
      if (claudeFailed) message += " · Claude failed";
      if (skippedCount > 0) message += ` · ${skippedCount} skipped`;
      if (untaggedCount > 0) message += ` · ${untaggedCount} untagged left`;

      showToast(message, () => {
        for (const filename of createdFilenames) {
          deleteTriaged(filename).catch((e) =>
            showToast(`Undo failed: ${String(e)}`),
          );
        }
        for (const [project, prevContent] of touchedProjects) {
          writeTodos(project, prevContent).catch((e) =>
            showToast(`Undo failed: ${String(e)}`),
          );
        }
        if (touchedProjects.size > 0) loadTodos();
        // Merge the filed notes back into the LIVE list (identity:
        // timestamp+body) instead of restoring the completion snapshot —
        // notes captured after the batch finished must survive the undo.
        persist(mergeMissingNotes(notesRef.current, finalCurrent));
        dismissToast();
      });
    } finally {
      setSending((s) => {
        const next = new Set(s);
        for (const n of startNotes) next.delete(n.raw);
        return next;
      });
      setBatchRunning(false);
    }
    // Same as above: `persist` is listed because it's read here and its
    // identity is stable, so it never churns this callback.
  }, [
    prompts,
    models,
    projectTags,
    claude,
    batchRunning,
    sending,
    loadTodos,
    generateTitles,
    persist,
  ]);

  return {
    sending,
    batchRunning,
    generateTitles,
    triageWithClaude,
    triageBatch,
  };
}
