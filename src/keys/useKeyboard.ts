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
//   0. Settings gate — FIRST, before even the ⌘ layer: while the Settings
//      pane is open, none of the app's own keymap actions may fire (it has
//      real controls — dropdowns, toggles, chip buttons — that aren't all
//      INPUT/TEXTAREA, so the in-field guard in step 2 alone wouldn't catch
//      a stray `t`/`d`/arrow landing on, say, a focused <select>). TWO
//      things still get through this layer: Escape closes Settings, unless
//      focus is inside an INPUT/TEXTAREA (where the field's own onKeyDown
//      blurs first — a second Escape then lands here with a non-field
//      target); and ⌘, (see commandKeymap) closes it regardless of focus,
//      mirroring the ⌘ layer's firesInFields:true for the SAME key's
//      closed→open direction below. Every other key is left completely
//      alone (no preventDefault), so native input/select/button behavior
//      inside the pane is unaffected. While `ctx.hotkeyCapturing` is true
//      (a hotkey field is mid-capture), this layer does nothing at all —
//      not even Escape/⌘, — since the field itself owns Escape-cancels and
//      Delete-clears for that keystroke.
//   1. ⌘ layer — BEFORE the in-field guard, so ⌘1/⌘2, ⌘=/⌘−/⌘0 and ⌘Z work
//      with the search input focused (⌘Z excepted: it yields to the field's
//      native text undo). A ⌘ combo with no binding falls through to 2/3,
//      where the modifier guard drops it — ⌘C/⌘V keep their defaults.
//   2. Guards — nothing else is a shortcut while an INPUT/TEXTAREA has
//      focus (the search input and the edit textarea bind their own keys),
//      and nothing else is a shortcut with a modifier held. Shift is NOT a
//      modifier here: `?` and `T` are shifted keys.
//   3. Global keys first, then the active view's map.
// ⌘= / ⌘+ / ⌘− / ⌘0 — the commandKeymap entries dispatchKey lets through
// its Settings gate (see the settingsOpen branch below).
const ZOOM_KEYS = new Set(["=", "+", "-", "0"]);

export function dispatchKey(e: DispatchableKeyEvent, ctx: KeyContext): void {
  const target = e.target as HTMLElement | null;
  const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

  if (ctx.settingsOpen) {
    // A hotkey capture field owns every key while it's recording — see
    // KeyContext.hotkeyCapturing's comment. Neither ⌘, nor Esc may act
    // below while this is true.
    if (ctx.hotkeyCapturing) return;
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === ",") {
      e.preventDefault();
      ctx.toggleSettings();
      return;
    }
    if (e.key === "Escape" && !inField) {
      e.preventDefault();
      ctx.closeSettings();
      return;
    }
    // Zoom is the one ⌘ binding that still fires inside Settings — the
    // pane's own Zoom section is at the very bottom, and a too-large zoom
    // is exactly when you most need the shortcut to reach it. Everything
    // else in commandKeymap (view switch, undo) stays gated.
    if (e.metaKey && !e.ctrlKey && !e.altKey && ZOOM_KEYS.has(e.key)) {
      e.preventDefault();
      commandKeymap[e.key]?.run(ctx, e);
    }
    return;
  }

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
