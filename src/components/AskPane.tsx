import { useEffect, useRef } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface AskPaneProps {
  question: string;
  setQuestion: (q: string) => void;
  answer: string | null;
  loading: boolean;
  error: string | null;
  model: string;
  open: boolean;
  submit: () => void;
  closeAsk: () => void;
  showToast: (message: string) => void;
}

// Quick question (⌥⌘A / `q`) — a swapped-in view over the `.cards` region,
// same shape as SettingsPane. Single-shot: one input, one answer, no
// follow-ups. Ephemeral — nothing written to disk here, ⌘S (useAsk's
// `save`) is the only write path, wired in App.tsx's keyboard layer rather
// than this component so the Ask gate in dispatchKey owns it uniformly with
// Escape.
export function AskPane({
  question,
  setQuestion,
  answer,
  loading,
  error,
  model,
  open,
  submit,
  closeAsk,
  showToast,
}: AskPaneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-focuses whenever the pane (re)opens — mirrors the Settings pane's
  // hotkey fields, but here it's the whole pane's one input, not a per-field
  // concern.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const copyAnswer = () => {
    if (!answer) return;
    writeText(answer)
      .then(() => showToast("Copied answer"))
      .catch((err) => showToast(`Copy failed: ${String(err)}`));
  };

  return (
    <div className="ask-pane">
      <input
        ref={inputRef}
        className="ask-input"
        value={question}
        placeholder="Ask a quick question…"
        autoFocus
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            // Isolation, same as the Settings hotkey fields: the Ask gate in
            // dispatchKey already handles Escape for a non-field target, but
            // this IS the field, so it must stop the keystroke reaching that
            // gate itself and close directly.
            e.stopPropagation();
            closeAsk();
          }
        }}
      />
      <div className="ask-hint">
        <span>Enter ask · Esc close{answer ? " · ⌘S save to inbox" : ""}</span>
        {answer && !loading && (
          <button
            type="button"
            className="ghost ask-copy"
            title="Copy answer"
            onClick={copyAnswer}
          >
            Copy
          </button>
        )}
      </div>
      {loading && <div className="ask-loading">Asking {model}…</div>}
      {error && !loading && <div className="error">{error}</div>}
      {answer && !loading && <div className="ask-answer">{answer}</div>}
    </div>
  );
}
