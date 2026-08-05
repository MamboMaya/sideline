import type { ReactNode } from "react";
import type { TriagedNote } from "../inbox";
import { tagChipClass, tagLabel } from "../lib/format";
import type { TagEditorHook } from "../hooks/useTagEditor";
import { TagEditor } from "./TagEditor";

interface TriagedCardProps {
  // "normal" = a tag-section row; "iced" = a pooled Icebox row. Besides the
  // documented button-set/class variance, two REAL behavioral differences
  // exist between the two blocks in the original JSX (flagged in the Task 14
  // report, preserved here exactly rather than averaged):
  //   1. the iced variant never renders the `## Claude` reply, even when
  //      expanded and note.reply is present;
  //   2. the iced variant's card-click only toggles expansion when
  //      note.title is set (the normal variant always toggles) — kept out of
  //      this component entirely: `onSelect` is pre-built per call site in
  //      App.tsx, so this difference lives where the rest of the app's
  //      decision logic lives, not as a new branch here.
  variant: "normal" | "iced";
  note: TriagedNote;
  isSelected: boolean;
  isExpanded: boolean;
  isEditing: boolean;
  editArea: ReactNode;
  cardRef: (el: HTMLDivElement | null) => void;
  onSelect: () => void;
  onEdit: () => void;
  onToggleDone: () => void;
  onToggleIced: () => void;
  onDelete: () => void;
  // Only the normal variant has an "Open in VS Code" button.
  onOpenInEditor?: () => void;
  onToggleTag: (tag: string) => void;
  onOpenTagEditor: () => void;
  projectTags: string[];
  pinnedTags: string[];
  togglePin: (tag: string) => void;
  hideTag: (tag: string) => void;
  tagEditor: TagEditorHook;
}

// Unifies the tag-section (normal) and icebox (iced) triaged cards. Tags
// markup is byte-identical between the two in the original JSX; card-head
// buttons, the reply block, the body class, and the root card class each
// differ per variant — branched explicitly below rather than merged into one
// generic expression, so each branch stays a direct, auditable copy of its
// source block.
export function TriagedCard({
  variant,
  note,
  isSelected,
  isExpanded,
  isEditing,
  editArea,
  cardRef,
  onSelect,
  onEdit,
  onToggleDone,
  onToggleIced,
  onDelete,
  onOpenInEditor,
  onToggleTag,
  onOpenTagEditor,
  projectTags,
  pinnedTags,
  togglePin,
  hideTag,
  tagEditor,
}: TriagedCardProps) {
  const isDone = note.status === "done";

  const rootClassName =
    variant === "normal"
      ? isSelected
        ? "card selected"
        : isDone
          ? "card done"
          : "card"
      : isSelected
        ? "card selected"
        : "card iced";

  // The title-case ternary is identical between variants — only the
  // untitled case differs (normal respects the clamped/expanded state,
  // iced always renders plain "body"). Factored, not averaged: each
  // variant's exact original output is still reproduced below.
  const bodyClassName = note.title
    ? isExpanded
      ? "body sub"
      : "body sub clamp1"
    : variant === "normal"
      ? isExpanded
        ? "body"
        : "body clamped"
      : "body";

  return (
    <div className={rootClassName} ref={cardRef} onClick={onSelect}>
      <div className="card-head">
        <span className="ts">{note.captured}</span>
        <button
          className="ghost edit-btn"
          title="Edit (e)"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          ✎
        </button>
        {variant === "normal" ? (
          // Done can never be iced — no 🧊 on done cards.
          !isDone && (
            <button
              className="ghost ice"
              title="Icebox — park for later (i)"
              onClick={(e) => {
                e.stopPropagation();
                onToggleIced();
              }}
            >
              🧊
            </button>
          )
        ) : (
          <button
            className="ghost"
            title="Thaw — back to pending (i)"
            onClick={(e) => {
              e.stopPropagation();
              onToggleIced();
            }}
          >
            ↺
          </button>
        )}
        {variant === "normal" ? (
          <button
            className="ghost"
            title={isDone ? "Un-done (d)" : "Mark done (d)"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleDone();
            }}
          >
            {isDone ? "↺" : "✓"}
          </button>
        ) : (
          <button
            className="ghost"
            title="Mark done (d)"
            onClick={(e) => {
              e.stopPropagation();
              onToggleDone();
            }}
          >
            ✓
          </button>
        )}
        <button
          className="ghost danger"
          title="Archive (x)"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
        {variant === "normal" && (
          <button
            className="ghost"
            title="Open in VS Code"
            onClick={(e) => {
              e.stopPropagation();
              onOpenInEditor?.();
            }}
          >
            {"</>"}
          </button>
        )}
      </div>
      {note.title && <div className="card-title">{note.title}</div>}
      {isEditing ? editArea : <div className={bodyClassName}>{note.body}</div>}
      {variant === "normal" && isExpanded && note.reply && (
        <div className="reply">
          <div className="reply-label">Claude</div>
          <pre className="reply-body">{note.reply}</pre>
        </div>
      )}
      <div className="tags" onClick={(e) => e.stopPropagation()}>
        {note.tags.map((t) => (
          <button
            key={t}
            className={tagChipClass(t, true, projectTags)}
            title="Remove tag"
            onClick={(e) => {
              e.stopPropagation();
              onToggleTag(t);
            }}
          >
            {tagLabel(t, projectTags)}
          </button>
        ))}
        <TagEditor
          tags={note.tags}
          onToggleTag={onToggleTag}
          isActive={isSelected}
          onOpen={onOpenTagEditor}
          editor={tagEditor}
          projectTags={projectTags}
          pinnedTags={pinnedTags}
          togglePin={togglePin}
          hideTag={hideTag}
        />
      </div>
    </div>
  );
}
