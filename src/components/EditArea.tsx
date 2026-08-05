import type { MutableRefObject } from "react";

interface EditAreaProps {
  value: string;
  onChange: (value: string) => void;
  // Set by the Escape handler below just before it blurs the textarea, so
  // the blur handler knows to cancel instead of save — owned by useEditRow,
  // shared across every row kind since only one row is ever being edited at
  // once.
  editCancelRef: MutableRefObject<boolean>;
  onCancel: () => void;
  onSave: () => void;
}

// Shared textarea for all three row kinds (inbox note / todo entry /
// triaged file) editing in place — one instance, reused by whichever card's
// `isEditing` is currently true. Grows to fit its content (min/max clamped
// in CSS, `.edit-area`) so a long note is editable without scrolling inside
// a 3-row box. Escape cancels; Enter (⌘Enter works too — the check is just
// `key === "Enter"`, which fires regardless of held modifiers) saves via
// blur; Shift+Enter inserts a newline instead.
export function EditArea({
  value,
  onChange,
  editCancelRef,
  onCancel,
  onSave,
}: EditAreaProps) {
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 4}px`;
  };
  return (
    <textarea
      className="edit-area"
      autoFocus
      ref={(el) => {
        if (el) autosize(el);
      }}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        autosize(e.target);
      }}
      onFocus={(e) => {
        const len = e.target.value.length;
        e.target.setSelectionRange(len, len);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          editCancelRef.current = true;
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === "Enter" && !e.shiftKey) {
          // Enter saves (⌘Enter still works); Shift+Enter inserts the
          // newline.
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      onBlur={() => {
        if (editCancelRef.current) {
          editCancelRef.current = false;
          onCancel();
        } else {
          onSave();
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
