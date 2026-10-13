import { type TodoEntry, parseTodos, serializeTodos } from "../inbox";

// Done-todo sweep: a ✅ entry moves from todos/<project>.md to
// todos/done/<project>.md once it has been done for SWEEP_GRACE_DAYS. The
// files carry no done date, so it comes from the entry's own "Done
// YYYY-MM-DD" line when an agent wrote one, else from the first day
// Sideline saw it done — remembered in ~/notes/.sideline-done.json. Pure
// planning only; the move itself is Rust's compare-and-swap `sweep_todos`.

export const SWEEP_GRACE_DAYS = 7;

// Sidecar key recording the day the first sweep ran.
const INIT_KEY = "__first-sweep__";

// "Done 2026-10-12: PR #22" — the line repo sessions write when they finish
// an entry, sometimes bolded, sometimes under a `## Claude` reply.
const DONE_LINE = /(?:^|\n)(?:\*\*)?Done (\d{4}-\d{2}-\d{2})\b/;

export function doneLineDate(entry: TodoEntry): string | null {
  const m = `${entry.title ?? ""}\n${entry.body}`.match(DONE_LINE);
  return m ? m[1] : null;
}

// A ⬜ entry whose text says it was finished: shown as "looks done" and
// bundled by the section's ⧉ Verify button for a repo session to confirm.
export function looksDone(entry: TodoEntry): boolean {
  return entry.status === "pending" && doneLineDate(entry) !== null;
}

// 32-bit FNV-1a, hex — keys only need to tell entries apart, not resist
// tampering.
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function doneKey(project: string, entry: TodoEntry): string {
  const ident = [
    entry.tags.join(" "),
    entry.headerText ?? "",
    entry.title ?? "",
    entry.body,
  ].join("\n");
  return `${project}::${entry.timestamp}::${hash(ident)}`;
}

export function localDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function validDay(day: string | null): string | null {
  return day && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? day : null;
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.round(ms / 86_400_000);
}

export interface SweepMove {
  project: string;
  expected: string;
  live: string;
  done: string;
  count: number;
}

// Plans one sweep over every todos file. An entry's "Done YYYY-MM-DD" line
// only dates it on the very first run (no INIT_KEY yet), to clear the
// backlog; after that a newly seen ✅ always gets today, so flipping an
// entry that says "Done 2026-09-01: part 1" still gives it the full week.
// `dates` comes back holding exactly
// the done entries still on disk (moved ones included, so a refused move
// keeps its date) — entries that vanished drop out, so the sidecar never
// grows past the files it describes.
export function planSweep(
  files: [string, string][],
  dates: Record<string, string>,
  today: string,
  graceDays = SWEEP_GRACE_DAYS,
): { dates: Record<string, string>; moves: SweepMove[] } {
  const next: Record<string, string> = {};
  const moves: SweepMove[] = [];
  const firstRun = !(INIT_KEY in dates);
  next[INIT_KEY] = dates[INIT_KEY] ?? today;
  for (const [project, content] of files) {
    const kept: TodoEntry[] = [];
    const moved: TodoEntry[] = [];
    for (const entry of parseTodos(content)) {
      if (entry.status !== "done") {
        kept.push(entry);
        continue;
      }
      const key = doneKey(project, entry);
      const date =
        dates[key] ??
        (firstRun ? validDay(doneLineDate(entry)) : null) ??
        today;
      next[key] = date;
      if (daysBetween(date, today) >= graceDays) moved.push(entry);
      else kept.push(entry);
    }
    if (moved.length > 0) {
      moves.push({
        project,
        expected: content,
        live: serializeTodos(kept),
        done: serializeTodos(moved),
        count: moved.length,
      });
    }
  }
  return { dates: next, moves };
}

// The ⧉ Verify bundle: one prompt asking a repo session to settle every
// "looks done" entry in a single pass.
export function verifyPrompt(project: string, entries: TodoEntry[]): string {
  const items = entries.map((e, i) => {
    const firstLine = e.title ?? e.body.split("\n")[0];
    const when = e.timestamp ? ` (captured ${e.timestamp})` : "";
    return `${i + 1}. ${firstLine}${when}`;
  });
  return (
    `These ${entries.length} entries in ~/notes/todos/${project}.md are marked ⬜ but their text says they're done. ` +
    "For each one, check this repo (git log, merged PRs, the code). " +
    "If it's truly finished, flip its ⬜ to ✅ in that file. " +
    "If not, leave ⬜ and add one line saying what's still open. Do them all in one pass.\n\n" +
    `${items.join("\n")}\n`
  );
}
