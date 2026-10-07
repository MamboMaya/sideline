import { describe, expect, it } from "vitest";
import { ageDays, isStale } from "./stale";

describe("ageDays", () => {
  it("returns 0 for a note captured just now", () => {
    const now = new Date("2026-09-23T09:14:00");
    expect(ageDays("2026-09-23 09:14", now)).toBe(0);
  });

  it("returns whole days for an older note", () => {
    const now = new Date("2026-09-23T09:14:00");
    expect(ageDays("2026-09-19 09:14", now)).toBe(4);
  });

  it("floors a partial day rather than rounding", () => {
    const now = new Date("2026-09-23T09:14:00");
    // 3 days and 23 hours ago — not yet a full 4th day.
    expect(ageDays("2026-09-19 10:14", now)).toBe(3);
  });

  it("returns 0 for a future timestamp", () => {
    const now = new Date("2026-09-23T09:14:00");
    expect(ageDays("2026-09-24 09:14", now)).toBe(0);
  });

  it("returns 0 for an unparseable timestamp", () => {
    const now = new Date("2026-09-23T09:14:00");
    expect(ageDays("not a date", now)).toBe(0);
  });
});

describe("isStale", () => {
  const now = new Date("2026-09-23T09:14:00");

  it("is false for a note younger than the threshold", () => {
    expect(isStale("2026-09-22 09:14", 3, now)).toBe(false);
  });

  it("is true for a note exactly at the threshold", () => {
    expect(isStale("2026-09-20 09:14", 3, now)).toBe(true);
  });

  it("is true for a note older than the threshold", () => {
    expect(isStale("2026-09-19 09:14", 3, now)).toBe(true);
  });

  it("is false when staleDays is 0 (feature off), no matter how old", () => {
    expect(isStale("2020-01-01 00:00", 0, now)).toBe(false);
  });

  it("is false when staleDays is negative", () => {
    expect(isStale("2020-01-01 00:00", -1, now)).toBe(false);
  });
});
