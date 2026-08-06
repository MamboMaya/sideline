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
  const { recState, audioLevel, recElapsed } = useRecorderStatus();

  if (recState === "idle") return null;

  return (
    <div className="overlay-pill">
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
    </div>
  );
}
