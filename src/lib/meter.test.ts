// Tests for src/lib/meter.ts — the dB-scaled level meter behind RecBars.
import { describe, expect, test } from "vitest";
import { meterLevel } from "./meter";

describe("meterLevel", () => {
  test("silence and junk input stay flat", () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(-0.5)).toBe(0);
    expect(meterLevel(Number.NaN)).toBe(0);
    // Below the floor (a mic with its gain at zero) — still flat.
    expect(meterLevel(0.0005)).toBe(0);
  });

  test("normal speech fills most of the meter", () => {
    // RMS 0.03 ≈ -30 dB, RMS 0.1 = -20 dB.
    expect(meterLevel(0.03)).toBeGreaterThan(0.6);
    expect(meterLevel(0.1)).toBeGreaterThan(0.85);
  });

  test("loud input clamps at full", () => {
    expect(meterLevel(0.5)).toBe(1);
    expect(meterLevel(1)).toBe(1);
  });

  test("rises monotonically with level", () => {
    expect(meterLevel(0.003)).toBeLessThan(meterLevel(0.01));
    expect(meterLevel(0.01)).toBeLessThan(meterLevel(0.03));
  });
});
