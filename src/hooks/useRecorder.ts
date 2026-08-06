import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toggleRecording as toggleRecordingCommand } from "../lib/commands";

// Per-bar height multipliers for the live level meter (7 bars, taller in
// the middle) — rendered by components/RecBars.tsx.
export const REC_BAR_MULT = [0.5, 0.7, 0.9, 1, 0.9, 0.7, 0.5];

export type RecState =
  | "idle"
  | "recording"
  | "transcribing"
  | "downloading-model";

// Native recorder state (audio.rs's `RecState`, mirrored via the
// `recording-state` event) + live level (0..1, `audio-level` event, ~20 Hz
// while recording) + elapsed m:ss while recording. No toast/toggle wiring —
// just the read side, so it's shared as-is by the popover's useRecorder
// (below) and the recording-pill overlay window (src/Overlay.tsx), which
// has no toast UI and never calls toggleRecording itself. Works even while
// the popover window is hidden since Tauri events aren't visibility-gated.
export function useRecorderStatus() {
  const [recState, setRecState] = useState<RecState>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [recElapsed, setRecElapsed] = useState(0);

  useEffect(() => {
    const unState = listen<string>("recording-state", (e) => {
      const s = e.payload;
      if (
        s === "idle" ||
        s === "recording" ||
        s === "transcribing" ||
        s === "downloading-model"
      ) {
        setRecState(s);
        if (s !== "recording") setAudioLevel(0);
      }
    });
    const unLevel = listen<number>("audio-level", (e) =>
      setAudioLevel(e.payload),
    );
    return () => {
      unState.then((f) => f());
      unLevel.then((f) => f());
    };
  }, []);

  // Elapsed m:ss while recording — the tray title computes its own copy in
  // Rust; this is the frontend's, ticking independently off a local start
  // timestamp so it doesn't depend on event cadence.
  useEffect(() => {
    if (recState !== "recording") {
      setRecElapsed(0);
      return;
    }
    const start = Date.now();
    setRecElapsed(0);
    const id = setInterval(
      () => setRecElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [recState]);

  return { recState, audioLevel, recElapsed };
}

// Adds toast-surfaced error/fallback events and the toggle action on top of
// useRecorderStatus, for the popover UI (Header.tsx). `showToast` is taken
// as a param since the capture-error listener and the toggleRecording
// failure path both surface errors through it.
export function useRecorder(
  showToast: (message: string, undo?: () => void) => void,
) {
  const { recState, audioLevel, recElapsed } = useRecorderStatus();

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  useEffect(() => {
    const unError = listen<string>("capture-error", (e) =>
      showToast(e.payload),
    );
    // Backend conditions that used to die in stderr — a hotkey silently
    // rebound/disabled, the fs watcher dying (external edits stop
    // appearing) — surface as toasts through the same channel.
    const unHotkey = listen<string>("hotkey-fallback", (e) =>
      showToast(e.payload),
    );
    const unWatcher = listen<string>("watcher-dead", () =>
      showToast(
        "File watching stopped — restart Sideline to see external edits",
      ),
    );
    return () => {
      unError.then((f) => f());
      unHotkey.then((f) => f());
      unWatcher.then((f) => f());
    };
  }, []);

  // `r` toggles voice-note recording, in either view — mirrors the ⌥⌘R
  // global hotkey. State/level feedback arrives via the
  // recording-state/audio-level events, not this call's return value.
  const toggleRecording = () => {
    toggleRecordingCommand().catch((err) =>
      showToast(`Recording failed: ${String(err)}`),
    );
  };

  return { recState, audioLevel, recElapsed, toggleRecording };
}
