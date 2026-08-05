import type { Note } from "../inbox";

// Inverse-operation helpers for undo closures. Undo must NOT restore whole
// pre-action snapshots: notes captured (or actions taken) between the action
// and the undo would be silently erased by the stale snapshot — a voice
// note's only copy lives in inbox.md. Every undo instead applies the
// minimal inverse against the CURRENT state (notesRef.current at undo
// time).

// Note identity that survives a watcher reload (which re-parses into fresh
// objects) and auto-tagger churn: the capture minute plus the body text.
const sameNote = (a: Note, b: Note) =>
  a.timestamp === b.timestamp && a.body === b.body;

// Re-insert one removed note at its old index (clamped if the list shrank).
export function insertNoteAt(current: Note[], note: Note, idx: number): Note[] {
  const out = [...current];
  out.splice(Math.min(idx, out.length), 0, note);
  return out;
}

// Union for multi-note undo (batch triage): every snapshot note missing
// from `current` is re-inserted near its snapshot position; notes that
// arrived after the snapshot are untouched. Returns `current` unchanged
// (same reference) when nothing is missing. Twins (byte-identical notes)
// are handled as a multiset — each current match is consumed once.
export function mergeMissingNotes(current: Note[], snapshot: Note[]): Note[] {
  const used = new Array<boolean>(current.length).fill(false);
  const missing: { note: Note; idx: number }[] = [];
  snapshot.forEach((s, i) => {
    const j = current.findIndex((c, k) => !used[k] && sameNote(c, s));
    if (j === -1) missing.push({ note: s, idx: i });
    else used[j] = true;
  });
  if (missing.length === 0) return current;
  const out = [...current];
  for (const { note, idx } of missing) {
    out.splice(Math.min(idx, out.length), 0, note);
  }
  return out;
}

// Edit-undo: put the pre-edit body back on the note that currently carries
// the edited body. Null when that note no longer exists in that state
// (archived, re-edited) — the undo is then skipped rather than guessed.
export function restoreBody(
  current: Note[],
  timestamp: string,
  editedBody: string,
  prevBody: string,
): Note[] | null {
  const idx = current.findIndex(
    (n) => n.timestamp === timestamp && n.body === editedBody,
  );
  if (idx === -1) return null;
  return current.map((n, i) => (i === idx ? { ...n, body: prevBody } : n));
}

// Archive-undo: remove the block appendToArchive added, tolerating entries
// appended after it (archive.md is append-only). Matches the LAST
// occurrence — the one we appended. Null when the block is gone (archive
// purged since); the caller skips the archive write. The removal also
// swallows the blank-line glue the append inserted.
export function stripArchiveBlock(
  archive: string,
  block: string,
): string | null {
  const idx = archive.lastIndexOf(block);
  if (idx === -1) return null;
  let start = idx;
  let end = idx + block.length;
  if (archive.startsWith("\n", end)) end += 1;
  if (start >= 2 && archive.slice(start - 2, start) === "\n\n") {
    start -= 2;
  } else if (start === 0 && archive.startsWith("\n", end)) {
    end += 1;
  }
  const out = archive.slice(0, start) + archive.slice(end);
  // appendToArchive trims the pre-append content before re-joining, so the
  // removal leaves the prior text without its final newline — restore it.
  return out && !out.endsWith("\n") ? `${out}\n` : out;
}
