import { useEffect, useRef } from "react";
import { archiveBlock, parseTriagedFile } from "../inbox";
import { appendToArchive } from "../lib/archive";
import {
  deleteTriaged,
  readDoneDates,
  readTodos,
  readTriaged,
  sweepTodos,
  writeDoneDates,
} from "../lib/commands";
import { localDay, planSweep } from "../lib/sweep";

export interface UseHousekeepingParams {
  showToast: (message: string) => void;
  loadTodos: () => void;
  loadTriaged: () => void;
}

// Daily housekeeping, run at launch and again whenever the day rolls over
// (checked hourly — the app lives in the menu bar for days):
// - todos: ✅ entries done for a week move to todos/done/<project>.md
//   (src/lib/sweep.ts).
// - triaged notes: done notes captured 30+ days ago move to archive.md —
//   same append-only archive as `x`, nothing is hard-deleted.
export function useHousekeeping({
  showToast,
  loadTodos,
  loadTriaged,
}: UseHousekeepingParams) {
  const lastDayRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  useEffect(() => {
    const run = async () => {
      const today = localDay(new Date());
      if (lastDayRef.current === today) return;
      lastDayRef.current = today;

      let movedTodos = 0;
      try {
        const plan = planSweep(
          await readTodos(),
          JSON.parse(await readDoneDates()),
          today,
        );
        await writeDoneDates(JSON.stringify(plan.dates));
        for (const m of plan.moves) {
          if (await sweepTodos(m.project, m.expected, m.live, m.done)) {
            movedTodos += m.count;
          }
        }
      } catch (e) {
        // A corrupt dates file or a failed move skips today's sweep — said
        // out loud, since it would otherwise fail the same way every day.
        showToast(`Todo sweep skipped: ${String(e)}`);
      }

      let archived = 0;
      try {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const [filename, content] of await readTriaged()) {
          const note = parseTriagedFile(filename, content);
          const t = new Date(note.captured.replace(" ", "T")).getTime();
          if (note.status !== "done" || Number.isNaN(t) || t >= cutoff)
            continue;
          await appendToArchive(
            archiveBlock("✅", note.captured, note.tags, note.body, note.reply),
          );
          await deleteTriaged(filename);
          archived++;
        }
      } catch {
        // Best-effort, as above.
      }

      const parts: string[] = [];
      if (movedTodos > 0)
        parts.push(
          `Moved ${movedTodos} done todo${movedTodos === 1 ? "" : "s"} to todos/done/`,
        );
      if (archived > 0)
        parts.push(
          `archived ${archived} done note${archived === 1 ? "" : "s"} (30+ days old)`,
        );
      if (parts.length > 0) {
        const msg = parts.join("; ");
        showToast(msg[0].toUpperCase() + msg.slice(1));
        loadTodos();
        loadTriaged();
      }
    };
    run();
    const id = setInterval(run, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
}
