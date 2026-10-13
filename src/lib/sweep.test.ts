import { describe, expect, test } from "vitest";
import { parseTodos } from "../inbox";
import {
  doneKey,
  doneLineDate,
  looksDone,
  planSweep,
  verifyPrompt,
} from "./sweep";

const file = (...blocks: string[]) => `${blocks.join("\n\n")}\n`;

describe("doneLineDate / looksDone", () => {
  test("reads a Done line in the body, bolded or under a reply", () => {
    const [a, b, c] = parseTodos(
      file(
        "### ⬜ \n\n**Fix it**\n\nDone 2026-10-12: PR #22.",
        "### ✅ 2026-09-23 09:14 #me\n\nIdea.\n\n## Claude\n\n**Done 2026-09-23** on main.",
        "### ⬜ 2026-10-01 09:00 #me\n\nNot Done 2026-10-12 yet.",
      ),
    );
    expect(doneLineDate(a)).toBe("2026-10-12");
    expect(looksDone(a)).toBe(true);
    expect(doneLineDate(b)).toBe("2026-09-23");
    expect(looksDone(b)).toBe(false);
    expect(doneLineDate(c)).toBeNull();
  });
});

describe("planSweep", () => {
  const content = file(
    "### ⬜ 2026-10-01 09:00 #me\n\nStill open.",
    "### ✅ 2026-08-01 09:00 #me\n\nOld capture, no done date.",
    "### ✅ 2026-09-01 09:00 #me\n\nShipped.\n\nDone 2026-10-01: PR #3.",
    "### 🧊 2026-07-01 09:00 #me\n\nParked.",
  );

  test("first run: a Done line dates the entry, otherwise today", () => {
    const { dates, moves } = planSweep([["me", content]], {}, "2026-10-13");
    const { "__first-sweep__": init, ...rest } = dates;
    expect(init).toBe("2026-10-13");
    expect(Object.values(rest).sort()).toEqual(["2026-10-01", "2026-10-13"]);
    expect(moves).toHaveLength(1);
    expect(moves[0].count).toBe(1);
    expect(moves[0].done).toContain("Shipped.");
    expect(moves[0].live).toContain("Old capture");
    expect(moves[0].live).toContain("Parked.");
    expect(moves[0].live).toContain("Still open.");
    expect(moves[0].expected).toBe(content);
  });

  test("a remembered date moves the entry once the grace period passes", () => {
    const first = planSweep([["me", content]], {}, "2026-10-13");
    const week = planSweep([["me", content]], first.dates, "2026-10-20");
    expect(week.moves[0].count).toBe(2);
    expect(parseTodos(week.moves[0].live).map((e) => e.status)).toEqual([
      "pending",
      "iced",
    ]);
  });

  test("six days is not enough", () => {
    const first = planSweep([["me", content]], {}, "2026-10-13");
    const later = planSweep([["me", content]], first.dates, "2026-10-19");
    expect(later.moves[0].count).toBe(1);
  });

  test("after the first run, a Done line no longer back-dates a new ✅", () => {
    const later = file(
      "### ✅ 2026-09-01 09:00 #me\n\nShipped.\n\nDone 2026-09-02: part 1.",
    );
    const { moves } = planSweep(
      [["me", later]],
      { "__first-sweep__": "2026-10-01" },
      "2026-10-13",
    );
    expect(moves).toEqual([]);
  });

  test("entries that differ only in header text get different keys", () => {
    const [a, b] = parseTodos("### ✅ #gap Fix A\n\n### ✅ #gap Fix B\n");
    expect(doneKey("x", a)).not.toBe(doneKey("x", b));
  });

  test("dates for entries no longer on disk are dropped", () => {
    const stale = { "gone::2026-01-01 00:00::deadbeef": "2026-01-01" };
    const { dates } = planSweep([["me", content]], stale, "2026-10-13");
    expect(dates).not.toHaveProperty("gone::2026-01-01 00:00::deadbeef");
  });

  test("keys separate projects and bodies", () => {
    const [e] = parseTodos("### ✅ 2026-10-01 09:00\n\na\n");
    const [f] = parseTodos("### ✅ 2026-10-01 09:00\n\nb\n");
    expect(doneKey("x", e)).not.toBe(doneKey("y", e));
    expect(doneKey("x", e)).not.toBe(doneKey("x", f));
  });

  test("no done entries, no moves", () => {
    const { moves } = planSweep(
      [["me", "### ⬜ 2026-10-01 09:00\n\nopen\n"]],
      {},
      "2026-10-13",
    );
    expect(moves).toEqual([]);
  });
});

describe("verifyPrompt", () => {
  test("lists each flagged entry by title or first line", () => {
    const entries = parseTodos(
      file(
        "### ⬜ \n\n**Fix it**\n\nDone 2026-10-12.",
        "### ⬜ 2026-10-01 09:00\n\nFirst line\nDone 2026-10-02.",
      ),
    );
    const out = verifyPrompt("demo", entries);
    expect(out).toContain("~/notes/todos/demo.md");
    expect(out).toContain("1. Fix it\n");
    expect(out).toContain("2. First line (captured 2026-10-01 09:00)");
  });
});
