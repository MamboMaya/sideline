import type { ReactNode } from "react";
import { type TodoEntry, todoRowDisplay } from "../inbox";
import { tagChipClass, tagLabel } from "../lib/format";
import type { TagEditorHook } from "../hooks/useTagEditor";
import { TagEditor } from "./TagEditor";

interface TodoCardProps {
  // "normal" = a project-section row (can be pending or done); "iced" = a
  // pooled Icebox row. The two differ in button set (🧊/✓ vs ↺/✓) and the
  // card's iced styling — see the variant-diff table in the Task 14 report.
  variant: "normal" | "iced";
  entry: TodoEntry;
  isSelected: boolean;
  isExpanded: boolean;
  isEditing: boolean;
  editArea: ReactNode;
  cardRef: (el: HTMLDivElement | null) => void;
  // Card-level click: built by the caller (already decides whether to also
  // toggle expansion), so no expandability logic lives here beyond what
  // rendering the body already needs.
  onSelect: () => void;
  onEdit: () => void;
  onToggleDone: () => void;
  onToggleIced: () => void;
  onDelete: () => void;
  onToggleTag: (tag: string) => void;
  onOpenTagEditor: () => void;
  projectTags: string[];
  pinnedTags: string[];
  togglePin: (tag: string) => void;
  hideTag: (tag: string) => void;
  tagEditor: TagEditorHook;
}

// Unifies the normal (project-section) and iced todo cards. Body/reply/tags
// markup is byte-identical between the two in the original JSX; only the
// card-head button set and the root `card`/`card iced` class differ.
export function TodoCard({
  variant,
  entry,
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
  onToggleTag,
  onOpenTagEditor,
  projectTags,
  pinnedTags,
  togglePin,
  hideTag,
  tagEditor,
}: TodoCardProps) {
  const isDone = entry.status === "done";
  const isIced = entry.status === "iced";
  const {
    body: displayBody,
    reply: replyText,
    expandable,
  } = todoRowDisplay(entry);

  const rootClassName =
    variant === "iced"
      ? isSelected
        ? "card selected"
        : "card iced"
      : isSelected
        ? "card selected"
        : isDone
          ? "card done"
          : isIced
            ? "card iced"
            : "card";

  return (
    <div className={rootClassName} ref={cardRef} onClick={onSelect}>
      <div className="card-head">
        {variant === "normal" && (
          <button
            type="button"
            className="todo-glyph"
            title={isDone ? "Un-done (d)" : "Mark done (d)"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleDone();
            }}
          >
            {isDone ? "✅" : isIced ? "🧊" : "⬜"}
          </button>
        )}
        <span className="ts">{entry.timestamp}</span>
        <button
          type="button"
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
              type="button"
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
            type="button"
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
        <button
          type="button"
          className="ghost"
          title={
            variant === "iced"
              ? "Mark done (d)"
              : isDone
                ? "Un-done (d)"
                : "Mark done (d)"
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggleDone();
          }}
        >
          {variant === "iced" ? "✓" : isDone ? "↺" : "✓"}
        </button>
        <button
          type="button"
          className="ghost danger"
          title="Archive (x)"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
      </div>
      {entry.title && <div className="card-title">{entry.title}</div>}
      {isEditing ? (
        editArea
      ) : (
        <div
          className={
            entry.title
              ? isExpanded
                ? "body sub"
                : "body sub clamp1"
              : expandable
                ? isExpanded
                  ? "body"
                  : "body clamped"
                : "body"
          }
        >
          {displayBody}
        </div>
      )}
      {isExpanded && replyText && (
        <div className="reply">
          <div className="reply-label">Claude</div>
          <pre className="reply-body">{replyText}</pre>
        </div>
      )}
      <div className="tags" onClick={(e) => e.stopPropagation()}>
        {entry.tags.map((t) => (
          <button
            type="button"
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
          tags={entry.tags}
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
