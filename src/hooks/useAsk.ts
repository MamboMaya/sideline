import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Models } from "../lib/config";
import { askClaude, appendInboxEntry } from "../lib/commands";

export interface UseAskParams {
  models: Models;
  showToast: (message: string, undo?: () => void) => void;
}

// Quick question (⌥⌘A / `q` — see AskPane.tsx): a single-shot, ephemeral
// question→answer pane swapped over `.cards`. Nothing touches disk until
// `save()` (⌘S); everything else here is plain component state, reset by
// `closeAsk`. There's no Rust-side state machine to mirror (unlike
// useRecorder) — `ask_claude` is one request/response call, so a monotonic
// request id is all that's needed to drop a stale response if the pane was
// closed, or a second question submitted, before the first call returned.
export function useAsk({ models, showToast }: UseAskParams) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  // Read by App.tsx's focus-gain reset effect: the ⌥⌘A hotkey shows the
  // window THEN emits `ask-open`, so the window's focus-gain and that event
  // can arrive in either order. Without this, a focus-gain arriving just
  // after `ask-open` would immediately close the pane the hotkey just
  // opened.
  const lastOpenedAtRef = useRef(0);

  const openAsk = () => {
    lastOpenedAtRef.current = Date.now();
    setOpen(true);
  };

  const closeAsk = () => {
    // Invalidates any in-flight submit() so a late response can't resurface
    // stale state the next time the pane opens — closeAsk aborts nothing
    // Rust-side, it just makes the frontend stop caring about the answer.
    requestIdRef.current++;
    setOpen(false);
    setQuestion("");
    setAnswer(null);
    setError(null);
    setLoading(false);
  };

  const submit = () => {
    const q = question.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    const id = ++requestIdRef.current;
    askClaude(q, models.ask)
      .then((res) => {
        if (id !== requestIdRef.current) return;
        setAnswer(res);
        setLoading(false);
      })
      .catch((err) => {
        if (id !== requestIdRef.current) return;
        setError(String(err));
        setLoading(false);
      });
  };

  // ⌘S: only meaningful once an answer has landed. Appends a ❓ entry —
  // `**question**` then a blank line then the answer — same shape a titled
  // note's leading `**title**` line uses (see docs/data-model.md).
  const save = () => {
    if (!answer) return;
    appendInboxEntry("❓", `**${question}**\n\n${answer}`)
      .then(() => showToast("Saved to inbox"))
      .catch((err) => showToast(String(err)));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — openAsk closes over refs/setState only
  useEffect(() => {
    const un = listen("ask-open", () => openAsk());
    return () => {
      un.then((f) => f());
    };
  }, []);

  return {
    open,
    question,
    setQuestion,
    answer,
    loading,
    error,
    openAsk,
    closeAsk,
    submit,
    save,
    lastOpenedAtRef,
  };
}
