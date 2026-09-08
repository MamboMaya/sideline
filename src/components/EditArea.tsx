import { useRef, useState } from "react";
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
  // Add-to-dictionary bar (see below): called with the typed term and the
  // trimmed mis-heard selection when the user clicks Add / hits Enter in
  // the bar's own input. Persistence (the addToDictionary helper +
  // useConfig's setDictionary) and the toast live in App.tsx, which already
  // owns the dictionary config state — this component only owns the
  // selection UI and fixing up the draft text.
  onAddToDictionary: (term: string, mishear: string) => void;
}

// A selection inside the textarea eligible for the add-to-dictionary bar:
// the raw range (so Add can replace exactly what was selected) plus the
// trimmed text (the mishear value and the bar's prefill).
interface DictSelection {
  start: number;
  end: number;
  text: string;
}

const MAX_MISHEAR_LEN = 40;

// Shared textarea for all three row kinds (inbox note / todo entry /
// triaged file) editing in place — one instance, reused by whichever card's
// `isEditing` is currently true. Grows to fit its content (min/max clamped
// in CSS, `.edit-area`) so a long note is editable without scrolling inside
// a 3-row box. Escape cancels; Enter (⌘Enter works too — the check is just
// `key === "Enter"`, which fires regardless of held modifiers) saves via
// blur; Shift+Enter inserts a newline instead.
//
// Add-to-dictionary bar: selecting text inside the textarea (mouse or
// keyboard) shows a compact bar right under it, offering to add the
// selection to the transcription dictionary under a corrected spelling —
// only when the selection is non-empty, single-line, and short (≤40 chars
// trimmed; see docs/ui.md). The bar's input does NOT autoFocus — the
// textarea stays focused while selecting, so nothing ends the edit; the
// user Tabs or clicks into the field. Save/cancel-on-blur lives on the
// WRAPPING div, not the textarea, and ignores focus moving anywhere inside
// the wrap (textarea <-> bar input/button) — see its onBlur below. The bar
// disappears when the selection collapses, on Esc in its own input (focus
// returns to the textarea, the note edit continues), or once Add runs.
export function EditArea({
  value,
  onChange,
  editCancelRef,
  onCancel,
  onSave,
  onAddToDictionary,
}: EditAreaProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // A cursor position to restore once the textarea's DOM value reflects a
  // pending onChange (Add splices `term` into the draft, which only lands
  // after the next render) — applied from the ref callback below, which
  // (unlike a plain effect) runs post-commit on every render since the
  // inline arrow function gives it a new identity each time.
  const pendingCursorRef = useRef<number | null>(null);
  // True for the one blur event submitAdd/closeBar's own bar-removal
  // triggers: unmounting the bar's (focused) input/button can fire a blur
  // with `relatedTarget` null in some engines, which the wrap's onBlur
  // would otherwise read as "focus left the wrap" and wrongly save/cancel.
  // Set synchronously before the state update that removes the bar,
  // consumed (and cleared) by the very next wrap onBlur.
  const barClosingRef = useRef(false);
  const [selection, setSelection] = useState<DictSelection | null>(null);
  const [termInput, setTermInput] = useState("");

  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 4}px`;
  };

  const checkSelection = (el: HTMLTextAreaElement) => {
    const { selectionStart, selectionEnd } = el;
    if (
      selectionStart === null ||
      selectionEnd === null ||
      selectionStart === selectionEnd
    ) {
      setSelection(null);
      return;
    }
    const trimmed = el.value.slice(selectionStart, selectionEnd).trim();
    if (
      !trimmed ||
      trimmed.includes("\n") ||
      trimmed.length > MAX_MISHEAR_LEN
    ) {
      setSelection(null);
      return;
    }
    setSelection({ start: selectionStart, end: selectionEnd, text: trimmed });
    setTermInput(trimmed);
  };

  // Arms barClosingRef for the blur the bar's unmount may fire, then
  // disarms it once the synchronous focus shuffle has settled. The timeout
  // matters in WebKit: clicking a <button> there does NOT move focus, so the
  // textarea never blurs when Add is clicked, no blur ever consumes the
  // flag, and without the reset the user's next Enter-to-save blur would be
  // swallowed. Unmount/refocus blurs fire during React's commit — before a
  // 0 ms timeout — so the reset can't race ahead of the blur it guards.
  const armBarClosing = () => {
    barClosingRef.current = true;
    setTimeout(() => {
      barClosingRef.current = false;
    }, 0);
  };

  const closeBar = () => {
    armBarClosing();
    const prev = selection;
    setSelection(null);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      if (prev) el.setSelectionRange(prev.end, prev.end);
    }
  };

  const submitAdd = () => {
    if (!selection) return;
    const term = termInput.trim();
    if (!term) return;
    armBarClosing();
    const { start, end, text: mishear } = selection;
    onAddToDictionary(term, mishear);
    pendingCursorRef.current = start + term.length;
    setSelection(null);
    onChange(value.slice(0, start) + term + value.slice(end));
  };

  return (
    <div
      className="edit-area-wrap"
      ref={wrapRef}
      onBlur={(e) => {
        if (barClosingRef.current) {
          barClosingRef.current = false;
          return;
        }
        const related = e.relatedTarget as Node | null;
        if (related && wrapRef.current?.contains(related)) return;
        if (editCancelRef.current) {
          editCancelRef.current = false;
          onCancel();
        } else {
          onSave();
        }
      }}
    >
      <textarea
        className="edit-area"
        autoFocus
        ref={(el) => {
          textareaRef.current = el;
          if (el) {
            autosize(el);
            if (pendingCursorRef.current !== null) {
              const pos = pendingCursorRef.current;
              pendingCursorRef.current = null;
              el.focus();
              el.setSelectionRange(pos, pos);
            }
          }
        }}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          autosize(e.target);
          setSelection(null);
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
        onSelect={(e) => checkSelection(e.target as HTMLTextAreaElement)}
        onKeyUp={(e) => checkSelection(e.target as HTMLTextAreaElement)}
        onMouseUp={(e) => checkSelection(e.target as HTMLTextAreaElement)}
        onClick={(e) => e.stopPropagation()}
      />
      {selection && (
        <div className="dict-add-bar" onClick={(e) => e.stopPropagation()}>
          <span className="dict-add-bar-label">
            Add “{selection.text}” to dictionary as
          </span>
          <input
            className="settings-input dict-add-bar-input"
            value={termInput}
            onChange={(e) => setTermInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                submitAdd();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeBar();
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="ghost dict-add-bar-btn"
            onClick={submitAdd}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
