import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  type Reminder,
  dismissReminder,
  listReminders,
  snoozeReminder,
} from "../lib/commands";

// Undismissed reminders (backend-sorted, soonest due first — see
// list_reminders in src-tauri/src/reminders.rs), split into fired (shown by
// the banner) and upcoming (the header's compact hint) for callers. Loads
// on mount and re-loads on every backend `reminders-changed` — emitted on
// every mutation (add/remove/dismiss/snooze, and the background tick firing
// one) — so the banner/hint never go stale, including after useInbox.ts
// registers or drops a reminder outside any action this hook itself took.
export function useReminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);

  const reload = useCallback(() => {
    listReminders()
      .then(setReminders)
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const un = listen("reminders-changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  const dismiss = (id: string) => {
    // Optimistic: drops it from both lists immediately rather than waiting
    // on the round-trip, so the banner/hint never show a stale entry the
    // user just dismissed.
    setReminders((rs) => rs.filter((r) => r.id !== id));
    dismissReminder(id).catch(() => reload());
  };

  const snooze = (id: string, minutes: number) => {
    setReminders((rs) => rs.filter((r) => r.id !== id));
    snoozeReminder(id, minutes)
      .then(reload)
      .catch(() => reload());
  };

  return {
    fired: reminders.filter((r) => r.fired),
    upcoming: reminders.filter((r) => !r.fired),
    dismiss,
    snooze,
  };
}
