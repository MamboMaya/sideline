import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Models } from "../lib/config";
import { askClaude, appendInboxEntry, openAskSession } from "../lib/commands";

// One question/answer exchange in the Ask view (AskView.tsx). Session-only
// — nothing here is ever written to disk except via `saveThread` (⌘S), and
// the whole list lives only as long as the app process does (see
// docs/ui.md's Quick question section). Newest-first in `threads` below.
export interface AskThread {
  id: number;
  question: string;
  answer: string | null;
  error: string | null;
  pending: boolean;
  createdAt: number;
  // The CLI session the answer came from — what "Continue in Terminal"
  // (`o`) resumes. Null until answered, or if the CLI didn't report one.
  sessionId: string | null;
}

export interface UseAskParams {
  models: Models;
  showToast: (message: string, undo?: () => void) => void;
  // Called right before a question is (re)submitted, so both the `ask-open`
  // hotkey event and a spoken `ask-transcript` land the caller (App.tsx) on
  // the Ask view — it closes Settings and calls `setView("ask")`.
  onOpen: () => void;
  // `.sideline.json`'s `terminal` override (Settings → Claude → "Continue
  // in") — the app name `continueThread` opens the session in. Undefined =
  // auto (Rust's open_ask_session picks the first installed, iTerm2 first).
  terminal: string | undefined;
}

// Quick question (⌥⌘A speaks it, `q` opens the view — see docs/ui.md).
// Threads are resolved by id, not index or a request counter: `removeThread`
// can drop a thread while its `askClaude` call is still in flight, and a
// stale response for a removed id is silently ignored by the `.map` below
// (no matching id, no-op).
export function useAsk({ models, showToast, onOpen, terminal }: UseAskParams) {
  const [threads, setThreads] = useState<AskThread[]>([]);
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState(0);
  const nextIdRef = useRef(0);

  const submit = (text?: string) => {
    const q = (text ?? question).trim();
    if (!q) return;
    const id = ++nextIdRef.current;
    setThreads((prev) => [
      {
        id,
        question: q,
        answer: null,
        error: null,
        pending: true,
        createdAt: Date.now(),
        sessionId: null,
      },
      ...prev,
    ]);
    setSelected(0);
    setQuestion("");
    askClaude(q, models.ask)
      .then((res) => {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  answer: res.answer,
                  sessionId: res.session_id,
                  pending: false,
                }
              : t,
          ),
        );
      })
      .catch((err) => {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, error: String(err), pending: false } : t,
          ),
        );
      });
  };

  // ⌘S (ask-only, see keymaps.ts's commandKeymap): appends a ❓ entry —
  // `**question**` then a blank line then the answer, same shape a titled
  // note's leading `**title**` line uses (docs/data-model.md). No-op on a
  // thread that's still pending or errored — there's no answer to save.
  const saveThread = (id: number) => {
    const thread = threads.find((t) => t.id === id);
    if (!thread?.answer) return;
    appendInboxEntry("❓", `**${thread.question}**\n\n${thread.answer}`)
      .then(() => showToast("Saved to inbox"))
      .catch((err) => showToast(String(err)));
  };

  const copyThread = (id: number) => {
    const thread = threads.find((t) => t.id === id);
    if (!thread?.answer) return;
    writeText(thread.answer)
      .then(() => showToast("Copied answer"))
      .catch((err) => showToast(`Copy failed: ${String(err)}`));
  };

  // `o` / "Continue in Terminal": the one-shot answer becomes the first
  // turn of a full interactive session — see open_ask_session in
  // docs/backend.md. Silently a no-op until the thread has a session id.
  // `terminal` is the configured app name (see UseAskParams); "iTerm" shows
  // as "iTerm2" in the toast, matching SettingsPane's dropdown label — every
  // other name displays as-is, undefined (auto) reads as "your terminal".
  const continueThread = (id: number) => {
    const thread = threads.find((t) => t.id === id);
    if (!thread?.sessionId) return;
    const displayName =
      terminal === "iTerm" ? "iTerm2" : (terminal ?? "your terminal");
    openAskSession(thread.sessionId, terminal)
      .then(() => showToast(`Continuing in ${displayName}`))
      .catch((err) => showToast(`Couldn't open Terminal: ${String(err)}`));
  };

  const removeThread = (id: number) => {
    setThreads((prev) => prev.filter((t) => t.id !== id));
  };

  // Kept in refs so the listener effect below never has to re-register —
  // `submit`/`onOpen` close over `question`/`models`/etc., which change on
  // every render, but the LISTENERS themselves must only ever attach once
  // (see the equivalent pattern this replaces, and useRecorder.ts's
  // capture-error listener).
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const unOpen = listen("ask-open", () => onOpenRef.current());
    // Rust's ask-mode recorder emits the finished transcript as a string
    // payload once transcription completes; empty/no-speech cases arrive as
    // `capture-error` instead (already toasted by useRecorder), never here.
    const unTranscript = listen<string>("ask-transcript", (e) => {
      onOpenRef.current();
      submitRef.current(e.payload);
    });
    return () => {
      unOpen.then((f) => f());
      unTranscript.then((f) => f());
    };
  }, []);

  return {
    threads,
    question,
    setQuestion,
    selected,
    setSelected,
    submit,
    saveThread,
    copyThread,
    continueThread,
    removeThread,
  };
}
