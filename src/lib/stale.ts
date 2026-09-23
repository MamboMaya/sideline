// Day math for the stale-inbox-note badges (InboxCard's age badge, Header's
// "N stale" count) — pure so it's covered by tests without touching
// Tauri IPC or wall-clock timing. Inbox timestamps look like
// "2026-09-23 09:14" (local time, see docs/data-model.md); the
// `.replace(" ", "T")` parse is the same local-time convention App.tsx's
// 30-day archive sweep already uses.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Whole days between `timestamp` and `now`. Negative or unparseable
// timestamps read as 0 — a badge should never show a negative or NaN age.
export function ageDays(timestamp: string, now: Date): number {
  const then = new Date(timestamp.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return 0;
  const days = Math.floor((now.getTime() - then) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

// Whether a note is old enough to flag. `staleDays <= 0` means the feature
// is off (0 is the config's "off" sentinel — see DEFAULT_STALE_DAYS).
// Strictly-greater-than: a note captured exactly `staleDays` days ago
// hasn't crossed the threshold yet.
export function isStale(
  timestamp: string,
  staleDays: number,
  now: Date,
): boolean {
  if (staleDays <= 0) return false;
  return ageDays(timestamp, now) > staleDays;
}
