// Level-meter scaling for components/RecBars.tsx. The `audio-level` event
// carries raw RMS (0..1), and on a linear scale normal speech (RMS ≈
// 0.03–0.1) barely moves the bars — so a dead mic (e.g. an interface whose
// input gain reset to zero) looked about the same as a live one. Mapping
// through decibels instead spreads the speech range across most of the bar
// height: room noise flickers near the bottom, speech swings through the
// middle, and true silence stays flat.
const FLOOR_DB = -55;
const CEIL_DB = -15;

// RMS (0..1) → meter fill (0..1), linear in dB between FLOOR_DB and
// CEIL_DB, clamped at both ends.
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
}
