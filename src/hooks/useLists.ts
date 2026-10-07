import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { readLists, setListEntry } from "../lib/commands";
import {
  type ListEntry,
  listKey,
  listText,
  parseLists,
  rulesDetect,
  toggleAction,
} from "../lib/listFormat";
import { detectListViaClaude } from "../lib/listRun";

// The spoken-list sidecar's frontend state (`~/notes/.sideline-lists.json`,
// see src/lib/listFormat.ts): the entry map plus the write paths. Loads on
// mount and on every backend `inbox-changed` (any write in ~/notes emits it,
// including this hook's own sidecar writes and useInbox.ts's auto-formatter
// results), so card state never goes stale. Never touches a note file.
export function useLists(opts: {
  claude: boolean;
  triageModel: string;
  showToast: (message: string, onUndo?: () => void) => void;
}) {
  const [lists, setLists] = useState<Record<string, ListEntry>>({});
  // Latest map for handlers that run between renders (the `l` key can be
  // pressed twice before the first press's setState has re-rendered).
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const reload = useCallback(() => {
    readLists()
      .then((raw) => setLists(parseLists(raw)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const un = listen("inbox-changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  // Optimistic: the card flips immediately; a failed write re-syncs from disk.
  const setEntry = useCallback(
    (key: string, entry: ListEntry | null) => {
      setLists((prev) => {
        const next = { ...prev };
        if (entry) next[key] = entry;
        else delete next[key];
        listsRef.current = next;
        return next;
      });
      setListEntry(key, entry).catch((e) => {
        console.error("list sidecar write failed:", e);
        reload();
      });
    },
    [reload],
  );

  // The `l` key for the note whose stored body is `body`. Flips an existing
  // list ↔ original (with undo); otherwise — no entry yet, or a checked "not
  // a list" — detects on this one note (any note, any age or length): the
  // instant rules first (no Claude needed), then the same Claude pipeline as
  // the auto-formatter. `body` is the note's stored body (the key's input);
  // detection works on the text the card shows.
  const toggleList = useCallback(
    async (timestamp: string, body: string) => {
      const { claude, triageModel, showToast } = optsRef.current;
      const key = listKey(timestamp, body);
      const entry = listsRef.current[key];
      if (toggleAction(entry) === "flip" && entry?.starts) {
        const flipped = { starts: entry.starts, show: !entry.show };
        setEntry(key, flipped);
        showToast(flipped.show ? "Showing list" : "Showing original", () =>
          setEntry(key, entry),
        );
        return;
      }
      if (listText(body).trim() === "") return;
      // Explicit "first, second…" / "one, two, three…" lists: instant, free.
      const byRules = rulesDetect(body);
      if (byRules) {
        setEntry(key, { starts: byRules, show: true });
        showToast("Showing list");
        return;
      }
      if (!claude) {
        showToast("List formatting needs Claude (Settings → Claude)");
        return;
      }
      showToast("Formatting…");
      try {
        const starts = await detectListViaClaude(body, triageModel);
        setEntry(key, { starts, show: starts !== null });
        showToast(starts ? "Showing list" : "No list found in this note");
      } catch (e) {
        console.error("list formatting failed:", e);
        showToast("Couldn't format this note");
      }
    },
    [setEntry],
  );

  return { lists, setEntry, toggleList };
}
