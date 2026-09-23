import type { Reminder } from "../lib/commands";
import { formatReminderTime } from "../lib/format";

interface ReminderBannerProps {
  fired: Reminder[];
  onDismiss: (id: string) => void;
  onSnooze: (id: string, minutes: number) => void;
}

// One strip per fired-and-undismissed reminder, at the top of the popover
// — visible across every view (App.tsx renders it above the tabs), unlike
// Toast which is scoped to the current action. No system notification: the
// popover itself IS the alert, per CLAUDE.md's "no new macOS permission
// surfaces" (no notification/sound APIs, no new Tauri plugin).
export function ReminderBanner({
  fired,
  onDismiss,
  onSnooze,
}: ReminderBannerProps) {
  if (fired.length === 0) return null;
  return (
    <div className="reminder-banner">
      {fired.map((r) => (
        <div className="reminder-row" key={r.id}>
          <span className="reminder-text">
            ⏰ {r.text} · {formatReminderTime(r.due_ms)}
          </span>
          <button
            type="button"
            className="reminder-snooze"
            title="Snooze 10 minutes"
            onClick={() => onSnooze(r.id, 10)}
          >
            +10 min
          </button>
          <button
            type="button"
            className="reminder-dismiss ghost"
            title="Dismiss"
            onClick={() => onDismiss(r.id)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
