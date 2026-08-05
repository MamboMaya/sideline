import { readArchive, writeArchive } from "./commands";

// Appends one block to archive.md (inbox entry format) and returns the
// pre-append content for undo closures. Shared by the Todos view's `x`
// handlers and the 30-day sweep — nothing is ever hard-deleted, and
// archiving is a plain file write so macOS never shows a permissions
// prompt (the old trash-crate path went through Finder automation and did).
export async function appendToArchive(block: string): Promise<string> {
  const prevArchive = await readArchive();
  const trimmed = prevArchive.trim();
  const next = (trimmed ? trimmed + "\n\n" + block : block) + "\n";
  await writeArchive(next);
  return prevArchive;
}
