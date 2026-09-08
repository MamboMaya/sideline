import { useEffect, useState } from "react";

// ⌘+/⌘- text zoom, persisted in .sideline.json as `zoom`. Applied as CSS
// zoom on <body> (WebKit supports it) so the whole UI scales, not just
// fonts. `persistZoom` and `showToast` are taken as params rather than
// importing pinnedTags/hiddenTags/overrides/toast state into the hook —
// App.tsx builds `persistZoom` from Task 11's `writeConfig`.
export function useZoom(
  persistZoom: (zoom: number) => void,
  showToast: (message: string, undo?: () => void) => void,
) {
  const [zoom, setZoom] = useState(1);

  const adjustZoom = (delta: number) => {
    const next =
      delta === 0
        ? 1
        : Math.round(Math.min(1.5, Math.max(0.7, zoom + delta)) * 10) / 10;
    if (next === zoom) return;
    setZoom(next);
    persistZoom(next);
    showToast(`Zoom ${Math.round(next * 100)}%`);
  };

  // CSS zoom on <body> scales the whole UI (WebKit supports it); 1 clears
  // the inline style entirely. `--zoom` on <html> goes with it: WebKit
  // scales viewport units by the zoom too, so `.app { height: 100vh }`
  // would render zoom× the window height and the bottom of the popover
  // (last inbox card, Settings' Zoom section) fell off the clipped body
  // at any zoom ≠ 1 — styles.css divides the height back down by it.
  useEffect(() => {
    (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom =
      zoom === 1 ? "" : String(zoom);
    if (zoom === 1) document.documentElement.style.removeProperty("--zoom");
    else document.documentElement.style.setProperty("--zoom", String(zoom));
  }, [zoom]);

  return { zoom, setZoom, adjustZoom };
}
