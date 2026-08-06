import { describe, expect, it } from "vitest";
import overlayCap from "../src-tauri/capabilities/overlay.json";
import conf from "../src-tauri/tauri.conf.json";

// Config invariants for the recording-pill overlay window. Both were real
// bugs: a focusable overlay steals keyboard focus on every show() (tao's
// macOS show is makeKeyAndOrderFront — it made the popover close via
// hide-on-focus-loss), and a webview label without a capability grant
// fails listen() silently, so the pill rendered nothing while "shown".

const windows: Record<string, unknown>[] = conf.app.windows;
const overlay = windows.find((w) => w.label === "overlay");

describe("overlay window config", () => {
  it("exists and is a non-focusable hidden always-on-top HUD", () => {
    expect(overlay).toBeDefined();
    expect(overlay?.focusable).toBe(false);
    expect(overlay?.focus).toBe(false);
    expect(overlay?.visible).toBe(false);
    expect(overlay?.alwaysOnTop).toBe(true);
    expect(overlay?.transparent).toBe(true);
  });

  it("identifies itself via the ?window=overlay query main.tsx branches on", () => {
    expect(overlay?.url).toContain("window=overlay");
  });

  it("has a capability granting event listening (recording-state/audio-level)", () => {
    expect(overlayCap.windows).toContain("overlay");
    expect(overlayCap.permissions).toContain("core:event:default");
  });
});
