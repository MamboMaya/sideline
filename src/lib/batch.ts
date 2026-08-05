// Batch-triage support: grouping inbox notes into merge units, building the
// `=== ITEM n ===` prompt from those units, and splitting the resulting
// multi-item Claude reply back into per-item text. Builder and parser live
// side by side because they share one contract — the item numbers.
import type { Note } from "../inbox";

// A batch-triage unit: `rest` notes grouped by first tag (untagged notes are
// always solo). Units with 2+ notes get one merged Claude reply and one
// combined file; solo units behave exactly like the single-note triage path.
export interface BatchUnit {
  tag: string | null;
  notes: Note[];
}

// Builds the batch-triage prompt: the configured batch prompt, then one
// `=== ITEM n ===` section per unit. The item number is the unit's 1-based
// position — the same key `parseBatchReply` reads back out, so the two must
// stay in step. A 2+ note unit gets the longer marker (tag + note count) to
// tell the model those notes are meant to merge into one reply; a solo unit
// gets the bare marker. Notes within a unit are separated by a blank line.
export function buildBatchPrompt(
  batchPrompt: string,
  units: BatchUnit[],
): string {
  const body = units
    .map((u, i) => {
      const marker =
        u.notes.length > 1
          ? `=== ITEM ${i + 1} (tag: ${u.tag}, ${u.notes.length} notes) ===`
          : `=== ITEM ${i + 1} ===`;
      return `${marker}\n${u.notes.map((n) => n.body).join("\n\n")}`;
    })
    .join("\n\n");
  return `${batchPrompt}\n\n${body}`;
}

// Splits a batch-triage reply on `=== ITEM <n> ===` (optionally
// `=== ITEM <n> (tag: ..., N notes) ===` for grouped units) markers into a
// map of item number -> reply text. Missing/blank sections (parse miss) are
// simply absent from the map so callers can fall back to plain filing.
export function parseBatchReply(reply: string): Map<number, string> {
  const parts = reply.split(/^=== ITEM (\d+)(?: \(.*\))? ===\s*$/m);
  const map = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) {
    const num = Number(parts[i]);
    const text = (parts[i + 1] ?? "").trim();
    if (text) map.set(num, text);
  }
  return map;
}
