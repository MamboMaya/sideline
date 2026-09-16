import { useEffect } from "react";
import type { RefObject } from "react";
import type { AskThread } from "../hooks/useAsk";
import type { RecMode, RecState } from "../hooks/useRecorder";

export interface AskViewProps {
  threads: AskThread[];
  question: string;
  setQuestion: (q: string) => void;
  selected: number;
  setSelected: (i: number) => void;
  submit: (text?: string) => void;
  saveThread: (id: number) => void;
  copyThread: (id: number) => void;
  removeThread: (id: number) => void;
  model: string;
  view: "inbox" | "todos" | "ask";
  recState: RecState;
  recMode: RecMode;
  inputRef: RefObject<HTMLInputElement | null>;
}

// Quick question — a THIRD VIEW (⌘3 / `q`, alongside Inbox/Todos), not a
// swapped-in pane: rendered inside the same `.cards` scroll container App.tsx
// uses for the other two, so scrolling/zoom behave identically. Threads
// persist for the session (useAsk.ts owns the list — nothing here resets
// them), newest first.
export function AskView({
  threads,
  question,
  setQuestion,
  selected,
  setSelected,
  submit,
  saveThread,
  copyThread,
  removeThread,
  model,
  view,
  recState,
  recMode,
  inputRef,
}: AskViewProps) {
  // Autofocuses whenever the Ask view is entered. Re-focusing on the
  // `ask-open` event itself (⌥⌘A pressed while already on this view) is
  // App.tsx's job — `focusAskInput` in the keyboard context — since this
  // effect only fires on a `view` transition, not a same-view re-trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref object
  useEffect(() => {
    if (view === "ask") inputRef.current?.focus();
  }, [view]);

  // The recorder's ask mode (see docs/backend.md — audio::RecMode gained
  // `Ask` alongside `Note`/`Dictate`) is the ⌥⌘A hotkey's speak-the-question
  // path: while it's live, the hint line swaps for a status line instead of
  // stacking both.
  const listening = recMode === "ask" && recState !== "idle";

  return (
    <div className="ask-view">
      <input
        ref={inputRef}
        className="ask-input"
        value={question}
        placeholder="Ask a quick question… (⌥⌘A to speak)"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            // Isolation, same as the header search input: this IS the
            // field, so the first Escape just blurs it — a second Escape,
            // landing on a non-field target, hides the popover via the
            // normal global chain (see useKeyboard.ts's dispatchKey).
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <div className="ask-hint">
        {listening ? (
          <span>
            {recState === "recording"
              ? "🎙️ Listening… (⌥⌘A to stop)"
              : "Transcribing…"}
          </span>
        ) : (
          <span>Enter ask · ↑↓ select · ⌘S save selected · Esc hide</span>
        )}
      </div>
      {threads.map((thread, i) => (
        <div
          key={thread.id}
          className={
            i === selected ? "card ask-thread selected" : "card ask-thread"
          }
          onClick={() => setSelected(i)}
        >
          <div className="ask-thread-q">{thread.question}</div>
          {thread.pending ? (
            <div className="ask-loading">Asking {model}…</div>
          ) : thread.error ? (
            <div className="error">{thread.error}</div>
          ) : (
            <div className="ask-answer">{thread.answer}</div>
          )}
          <div className="ask-thread-actions">
            <button
              type="button"
              className="ghost"
              onClick={(e) => {
                e.stopPropagation();
                copyThread(thread.id);
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!thread.answer}
              onClick={(e) => {
                e.stopPropagation();
                saveThread(thread.id);
              }}
            >
              Save to inbox
            </button>
            <button
              type="button"
              className="ghost"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                removeThread(thread.id);
              }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
