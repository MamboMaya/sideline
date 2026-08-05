import type { ReactNode } from "react";
import type { Note } from "../inbox";
import { tagChipClass, tagLabel } from "../lib/format";
import type { TagEditorHook } from "../hooks/useTagEditor";
import { TagEditor } from "./TagEditor";

interface InboxCardProps {
  note: Note;
  isSelected: boolean;
  isSending: boolean;
  isEditing: boolean;
  editArea: ReactNode;
  cardRef: (el: HTMLDivElement | null) => void;
  onEdit: () => void;
  onTriage: () => void;
  onDelete: () => void;
  onToggleTag: (tag: string) => void;
  onOpenTagEditor: () => void;
  // The three always-shown quick-tag chips (bug/todo/idea) — a prop rather
  // than an import so the constant stays owned by App.tsx, matching every
  // other card component's "logic stays in App.tsx" prop shape.
  quickTags: string[];
  projectTags: string[];
  pinnedTags: string[];
  togglePin: (tag: string) => void;
  hideTag: (tag: string) => void;
  tagEditor: TagEditorHook;
}

// The Inbox-view card. Unlike TodoCard/TriagedCard's plain tag-chip list,
// this renders three tag rows in a fixed order — quick tags (always shown,
// toggled on/off), then pinned tags not already covered, then any other
// tags already on the note — reproduced exactly from the original JSX, not
// generalized. The card itself has no click-to-select handler in the
// original (selection here is keyboard-nav only), so there's no onSelect
// prop.
export function InboxCard({
  note,
  isSelected,
  isSending,
  isEditing,
  editArea,
  cardRef,
  onEdit,
  onTriage,
  onDelete,
  onToggleTag,
  onOpenTagEditor,
  quickTags,
  projectTags,
  pinnedTags,
  togglePin,
  hideTag,
  tagEditor,
}: InboxCardProps) {
  return (
    <div
      className={
        (isSelected ? "card selected" : "card") + (isSending ? " sending" : "")
      }
      ref={cardRef}
    >
      <div className="card-head">
        <span>{note.icon}</span>
        <span className="ts">{note.timestamp}</span>
        {isSending ? (
          <span className="sending-badge">✨ Triaging…</span>
        ) : (
          <>
            <button
              type="button"
              className="ghost edit-btn"
              title="Edit (e)"
              onClick={onEdit}
            >
              ✎
            </button>
            <button
              type="button"
              className="ghost"
              title="Triage with Claude → own file (t)"
              onClick={onTriage}
            >
              ✓
            </button>
            <button
              type="button"
              className="ghost danger"
              title="Archive (x)"
              onClick={onDelete}
            >
              ✕
            </button>
          </>
        )}
      </div>
      {isEditing ? editArea : <div className="body">{note.body}</div>}
      <div className="tags">
        {quickTags.map((t, i) => (
          <button
            type="button"
            key={t}
            className={tagChipClass(t, note.tags.includes(t), projectTags)}
            title={`key ${i + 1}`}
            onClick={() => onToggleTag(t)}
          >
            {tagLabel(t, projectTags)}
          </button>
        ))}
        {pinnedTags
          .map((t, i) => ({ t, keyNum: i + 4 }))
          .filter(({ t }) => !quickTags.includes(t))
          .map(({ t, keyNum }) => (
            <button
              type="button"
              key={t}
              className={tagChipClass(t, note.tags.includes(t), projectTags)}
              title={`key ${keyNum}`}
              onClick={() => onToggleTag(t)}
            >
              {tagLabel(t, projectTags)}
            </button>
          ))}
        {note.tags
          .filter((t) => !quickTags.includes(t) && !pinnedTags.includes(t))
          .map((t) => (
            <button
              type="button"
              key={t}
              className={tagChipClass(t, true, projectTags)}
              onClick={() => onToggleTag(t)}
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
