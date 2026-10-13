import type { ReactNode } from "react";

interface SectionHeaderProps {
  // Full label content for the row, INCLUDING the trailing `(N)` count —
  // passed as a node (not a plain string) so call sites can reproduce their
  // exact original markup: the project variant wraps just the project name
  // in a `.project-name` span (see docs/ui.md's Tags section — it reads
  // blue like `.tag.project`), the tag/icebox variants render plain text.
  // Never averaged into one shape here.
  label: ReactNode;
  collapsed: boolean;
  selected: boolean;
  onToggle: () => void;
  // Registers this header's slot in `todosCardRefs` (indexed by its
  // position in the merged flat nav list) — a callback ref built by the
  // caller, which knows the header's index.
  headerRef: (el: HTMLDivElement | null) => void;
  // Only the project-section variant has one (bundles pending entries to
  // the clipboard). Omitted entirely (not just hidden) for the tag/icebox
  // variants, matching the original JSX.
  onCopy?: () => void;
  // Project sections only, and only while some ⬜ entry's text says it's
  // done: opens a repo Claude session (or copies its prompt) to verify them.
  verifyCount?: number;
  onVerify?: () => void;
}

// Unifies the three near-identical Todos-view section headers (project, tag,
// icebox). Only the outer `<div class="section-header">` row — the `<div
// class="section">` wrapper and the row list below it stay in App.tsx since
// their contents differ by section kind (TodoCard rows vs TriagedCard rows,
// sometimes both for the icebox).
export function SectionHeader({
  label,
  collapsed,
  selected,
  onToggle,
  headerRef,
  onCopy,
  verifyCount = 0,
  onVerify,
}: SectionHeaderProps) {
  return (
    <div
      className={selected ? "section-header selected" : "section-header"}
      ref={headerRef}
      onClick={onToggle}
      title={collapsed ? "Expand (→)" : "Collapse (←)"}
    >
      <span className="chevron">{collapsed ? "▸" : "▾"}</span>
      {label}
      {onVerify && verifyCount > 0 && (
        <button
          type="button"
          className="ghost copy-btn"
          title="Open Claude in this project's repo to verify the entries marked “Looks done” (copies the prompt if no repo folder is set)"
          onClick={(e) => {
            e.stopPropagation();
            onVerify();
          }}
        >
          ↗ Verify {verifyCount}
        </button>
      )}
      {onCopy && (
        <button
          type="button"
          className="ghost copy-btn"
          title="Copy pending todos (c)"
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
        >
          ⧉ Copy
        </button>
      )}
    </div>
  );
}
