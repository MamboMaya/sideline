import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  commandKeymap,
  globalKeymap,
  searchKeyDown,
  viewKeymap,
} from "./keymaps";
import type { DispatchableKeyEvent, KeyContext } from "./types";

// Finds the handler for ONE keystroke and runs it. The layering here is the
// whole contract — it is what decides, for a given keypress, which of the
// four tables in keymaps.ts (if any) gets to act:
//
//   1. ⌘ layer — BEFORE the in-field guard, so ⌘1/⌘2, ⌘=/⌘−/⌘0 and ⌘Z work
//      with the search input focused (⌘Z excepted: it yields to the field's
//      native text undo). A ⌘ combo with no binding falls through to 2/3,
//      where the modifier guard drops it — ⌘C/⌘V keep their defaults.
//   2. Guards — nothing else is a shortcut while an INPUT/TEXTAREA has
//      focus (the search input and the edit textarea bind their own keys),
//      and nothing else is a shortcut with a modifier held. Shift is NOT a
//      modifier here: `?` and `T` are shifted keys.
//   3. Global keys first, then the active view's map.
export function dispatchKey(e: DispatchableKeyEvent, ctx: KeyContext): void {
  const target = e.target as HTMLElement | null;
  const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

  if (e.metaKey && !e.ctrlKey && !e.altKey) {
    const binding = commandKeymap[e.key.toLowerCase()];
    if (binding && (binding.firesInFields || !inField)) {
      e.preventDefault();
      binding.run(ctx, e);
      return;
    }
  }
  if (inField) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const handler = globalKeymap[e.key] ?? viewKeymap(ctx.view)[e.key];
  handler?.(ctx, e);
}

// The app's ONE window-level keydown listener.
//
// `ctx` is rebuilt by App.tsx on every render, but the listener is
// registered exactly once and reads the latest context through a ref at
// dispatch time. That replaced a 26-entry dependency array on the old
// inline effect (two of whose entries — `toast` and `copyProjectTodos` —
// the handler never even referenced): no re-registration churn, and no
// handler can act on a value that went stale since the last re-register.
//
// Returns the header search input's own keydown handler, which runs off the
// same context (see `searchKeyDown` in keymaps.ts).
export function useKeyboard(ctx: KeyContext): {
  onSearchKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
} {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => dispatchKey(e, ctxRef.current);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Bound in the JSX on the header search input; `searchKeyDown` (keymaps.ts)
  // is the layer itself, this just feeds it the current context.
  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) =>
    searchKeyDown(ctxRef.current, e);

  return { onSearchKeyDown };
}
