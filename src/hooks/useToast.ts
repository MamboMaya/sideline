import { useEffect, useRef, useState } from "react";

// Bottom-of-window banner + retained undo, used by nearly every mutating
// action in the app. `showToast(message, undo?)` shows a 5s auto-dismiss
// banner; if `undo` is given, it's also retained for 120s past the toast's
// disappearance so `u` / ⌘Z (see `runUndo`) still works after the banner is
// gone.
export function useToast() {
  const [toast, setToast] = useState<{
    message: string;
    undo?: () => void;
  } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Most recent undoable action, kept alive past the toast's 5s so ⌘Z/u
  // still work for a couple of minutes after the banner is gone. Replaced
  // by the next undoable action; cleared when executed.
  const lastUndoRef = useRef<{ fn: () => void; expires: number } | null>(null);

  const dismissToast = () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  };

  const showToast = (message: string, undo?: () => void) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    let wrapped: (() => void) | undefined;
    if (undo) {
      // Self-clearing so an executed undo can't fire twice via ⌘Z later.
      wrapped = () => {
        lastUndoRef.current = null;
        undo();
      };
      lastUndoRef.current = { fn: wrapped, expires: Date.now() + 120_000 };
    }
    setToast({ message, undo: wrapped });
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 5000);
  };

  // `u` / ⌘Z: the visible toast's undo if present, else the retained last
  // action (up to 2 minutes after its toast disappeared).
  const runUndo = () => {
    const last = lastUndoRef.current;
    if (last && Date.now() < last.expires) last.fn();
    else lastUndoRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  return { toast, showToast, dismissToast, runUndo };
}
