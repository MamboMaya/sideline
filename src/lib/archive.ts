import { readArchive, writeArchive } from "./commands";
import { stripArchiveBlock } from "./undo";

// Appends one block to archive.md (inbox entry format) and returns the
// pre-append content for undo closures. Shared by the Todos view's `x`
// handlers and the 30-day sweep — nothing is ever hard-deleted, and
// archiving is a plain file write so macOS never shows a permissions
// prompt (the old trash-crate path went through Finder automation and did).
export async function appendToArchive(block: string): Promise<string> {
  const prevArchive = await readArchive();
  const trimmed = prevArchive.trim();
  const next = `${trimmed ? `${trimmed}\n\n${block}` : block}\n`;
  await writeArchive(next);
  return prevArchive;
}

// Inverse of appendToArchive for undo closures: removes the block from the
// CURRENT archive (tolerating entries appended after it) instead of
// restoring the pre-append snapshot, which would erase those later
// entries. No-op when the block is already gone (archive purged since).
export async function undoArchiveAppend(block: string): Promise<void> {
  const current = await readArchive();
  const stripped = stripArchiveBlock(current, block);
  if (stripped !== null) {
    await writeArchive(stripped);
  }
}
