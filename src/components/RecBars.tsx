import { REC_BAR_MULT } from "../hooks/useRecorder";

// Live level-meter bars (7 bars, taller in the middle — see REC_BAR_MULT),
// shared by the popover's Header rec-indicator and the recording-pill
// overlay window so both render the exact same visualization off the same
// `audio-level` stream.
export function RecBars({ audioLevel }: { audioLevel: number }) {
  return (
    <span className="rec-bars">
      {REC_BAR_MULT.map((m, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: REC_BAR_MULT is a static constant; bars never reorder
          key={i}
          className="rec-bar"
          style={{
            height: `${3 + Math.min(1, audioLevel) * m * 13}px`,
          }}
        />
      ))}
    </span>
  );
}
