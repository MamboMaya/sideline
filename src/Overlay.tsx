import { RecBars } from "./components/RecBars";
import { useRecorderStatus } from "./hooks/useRecorder";

// Root of the recording-pill overlay window (mounted instead of App — see
// main.tsx's `?window=overlay` branch). Deliberately tiny: no notes/config
// loading, no IPC beyond the two recorder events (granted by
// capabilities/overlay.json — without that grant listen() fails silently),
// no keyboard handling — the native window is focusable:false, so it can
// never become key or receive keystrokes. Rust shows/hides/positions the window
// itself on every recording-state transition (see audio.rs's emit_state);
// this component only has to render the right thing for the current state.
export default function Overlay() {
  const { recState, recMode, audioLevel, recElapsed } = useRecorderStatus();

  if (recState === "idle") return null;

  // Dictation mode never touches the inbox — words go to the clipboard (and
  // auto-paste into whatever app is frontmost) instead, so the pill needs a
  // visible tell apart from the normal REC look, not just a tooltip the
  // user won't see mid-dictation. Ask mode (⌥⌘A — see AskView.tsx) speaks a
  // question instead, so it gets its own tell too.
  const dictating = recMode === "dictate";
  const asking = recMode === "ask";

  return (
    <div
      className={
        dictating
          ? "overlay-pill overlay-pill-dictate"
          : asking
            ? "overlay-pill overlay-pill-ask"
            : "overlay-pill"
      }
    >
      {/* Names the mode at a glance — "Capture" (orange) vs "Dictate" (blue)
          vs "Ask" (green, via .overlay-pill-ask) — same layout for all
          three so every pill reads the same way. For dictation the badge
          also answers "where are these words going?", which only matters
          while they're still in flight — the terminal clipboard notice
          below answers it outright, so the badge steps aside there;
          capture/ask have no such terminal state, so their badge just
          stays up throughout. */}
      {recState !== "copied" && (
        <span className="rec-mode-badge">
          {dictating ? "Dictate" : asking ? "Ask" : "Capture"}
        </span>
      )}
      {recState === "recording" && (
        <>
          <span className="rec-dot" />
          <span className="rec-elapsed">
            {Math.floor(recElapsed / 60)}:
            {String(recElapsed % 60).padStart(2, "0")}
          </span>
          <RecBars audioLevel={audioLevel} />
        </>
      )}
      {recState === "transcribing" && (
        <span className="rec-status">Transcribing…</span>
      )}
      {recState === "downloading-model" && (
        <span className="rec-status">Downloading model…</span>
      )}
      {recState === "copied" && (
        <span className="rec-status">Copied — ⌘V to paste</span>
      )}
    </div>
  );
}
