import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toggleRecording as toggleRecordingCommand } from "../lib/commands";

// Per-bar height multipliers for the header's live level meter (7 bars,
// taller in the middle) — see the `rec-bars` JSX in App.tsx.
export const REC_BAR_MULT = [0.5, 0.7, 0.9, 1, 0.9, 0.7, 0.5];

// Native recorder state (audio.rs's `RecState`, mirrored via the
// `recording-state` event) + live level and elapsed time. `showToast` is
// taken as a param since the capture-error listener and the toggleRecording
// failure path both surface errors through it.
export function useRecorder(
  showToast: (message: string, undo?: () => void) => void,
) {
  // Native recorder state (audio.rs's `RecState`, mirrored via the
  // `recording-state` event) + live level (0..1, `audio-level` event, ~20
  // Hz while recording). Drives the header indicator; works even while the
  // popover window is hidden since Tauri events aren't visibility-gated.
  const [recState, setRecState] = useState<
    "idle" | "recording" | "transcribing" | "downloading-model"
  >("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [recElapsed, setRecElapsed] = useState(0);

  // Recorder events: three independent subscriptions since state/level/error
  // arrive on separate event names from audio.rs / whisper.rs.
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
      unState.then((f) => f());
      unLevel.then((f) => f());
      unError.then((f) => f());
      unHotkey.then((f) => f());
      unWatcher.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed m:ss while recording — the tray title computes its own copy in
  // Rust; this is the header indicator's, ticking independently off a
  // local start timestamp so it doesn't depend on event cadence.
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
