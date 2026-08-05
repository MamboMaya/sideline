// Tests for src/lib/format.ts — string-shaping helpers extracted from
// App.tsx (tag/title normalization, hotkey display, batch-triage grouping).
import { describe, expect, test } from "vitest";
import {
  formatHotkey,
  sanitizeTag,
  escapeRegex,
  needsTitle,
  sanitizeTitle,
  groupByFirstTag,
  tagLabel,
  tagChipClass,
} from "./format";
import type { Note } from "../inbox";

// ---------------------------------------------------------------------------
// formatHotkey
// ---------------------------------------------------------------------------

describe("formatHotkey", () => {
  test("renders the app's documented defaults — alt+cmd+space and alt+cmd+r", () => {
    expect(formatHotkey("alt+cmd+space", "fallback")).toBe("⌥⌘Space");
    expect(formatHotkey("alt+cmd+r", "fallback")).toBe("⌥⌘R");
  });

  test("falls back to the provided string when combo is undefined or empty", () => {
    expect(formatHotkey(undefined, "⌥⌘Space")).toBe("⌥⌘Space");
    expect(formatHotkey("", "⌥⌘R")).toBe("⌥⌘R");
    expect(formatHotkey("   ", "⌥⌘R")).toBe("⌥⌘R");
  });

  test("falls back when every token is a recognized modifier and no key remains", () => {
    expect(formatHotkey("cmd+alt", "fallback")).toBe("fallback");
  });

  test("recognizes every modifier alias, mapping to its symbol", () => {
    expect(formatHotkey("cmd+v", "fb")).toBe("⌘V");
    expect(formatHotkey("command+v", "fb")).toBe("⌘V");
    expect(formatHotkey("super+v", "fb")).toBe("⌘V");
    expect(formatHotkey("meta+v", "fb")).toBe("⌘V");
    expect(formatHotkey("opt+v", "fb")).toBe("⌥V");
    expect(formatHotkey("option+v", "fb")).toBe("⌥V");
    expect(formatHotkey("alt+v", "fb")).toBe("⌥V");
    expect(formatHotkey("ctrl+v", "fb")).toBe("⌃V");
    expect(formatHotkey("control+v", "fb")).toBe("⌃V");
    expect(formatHotkey("shift+v", "fb")).toBe("⇧V");
  });

  test("is case-insensitive on modifier tokens and capitalizes just the key's first letter", () => {
    expect(formatHotkey("CMD+ALT+space", "fb")).toBe("⌘⌥Space");
    expect(formatHotkey("Cmd+Option+r", "fb")).toBe("⌘⌥R");
  });

  test("a single non-modifier key with no modifiers renders with no symbol prefix", () => {
    expect(formatHotkey("r", "fb")).toBe("R");
  });

  test("stacks multiple modifier symbols in token order", () => {
    expect(formatHotkey("ctrl+shift+alt+cmd+q", "fb")).toBe("⌃⇧⌥⌘Q");
  });
});

// ---------------------------------------------------------------------------
// sanitizeTag
// ---------------------------------------------------------------------------

describe("sanitizeTag", () => {
  test("trims, strips a leading #, and lowercases", () => {
    expect(sanitizeTag("  #Bug  ")).toBe("bug");
  });

  test("collapses internal whitespace runs to a single hyphen", () => {
    expect(sanitizeTag("foo   bar baz")).toBe("foo-bar-baz");
  });

  test("strips characters outside [\\w-]", () => {
    expect(sanitizeTag("weird!@#chars$%^tag")).toBe("weirdcharstag");
  });

  test("caps length at 24 characters after lowercasing", () => {
    const long = "a".repeat(30);
    const out = sanitizeTag(long);
    expect(out).toHaveLength(24);
    expect(out).toBe("a".repeat(24));
  });

  test("empty or whitespace-only input sanitizes to an empty string", () => {
    expect(sanitizeTag("")).toBe("");
    expect(sanitizeTag("   ")).toBe("");
    expect(sanitizeTag("#")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------

describe("escapeRegex", () => {
  test("escapes every regex metacharacter", () => {
    expect(escapeRegex(".*+?^${}()|[]\\")).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });

  test("leaves plain word characters untouched", () => {
    expect(escapeRegex("kafka-consumer")).toBe("kafka-consumer");
  });

  test("the escaped output is usable as a literal-matching RegExp source", () => {
    const re = new RegExp(escapeRegex("a.b*c"));
    expect(re.test("a.b*c")).toBe(true);
    expect(re.test("axbyc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// needsTitle
// ---------------------------------------------------------------------------

describe("needsTitle", () => {
  test("false for a short, one-line body", () => {
    expect(needsTitle("Quick reminder to check the logs.")).toBe(false);
  });

  test("true when there are more than 2 non-blank lines", () => {
    const body = "line one\nline two\nline three";
    expect(needsTitle(body)).toBe(true);
  });

  test("blank lines don't count toward the 2-line threshold", () => {
    const body = "line one\n\nline two\n\n";
    expect(needsTitle(body)).toBe(false);
  });

  test("true when body length exceeds 120 characters, even on one line", () => {
    expect(needsTitle("x".repeat(121))).toBe(true);
    expect(needsTitle("x".repeat(120))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeTitle
// ---------------------------------------------------------------------------

describe("sanitizeTitle", () => {
  test("trims surrounding whitespace", () => {
    expect(sanitizeTitle("  A title  ")).toBe("A title");
  });

  test("strips leading markdown/quote noise (#, *, quotes, backticks)", () => {
    expect(sanitizeTitle('# "*`Kafka rebalancing loop')).toBe(
      "Kafka rebalancing loop",
    );
  });

  test("strips trailing markdown/quote noise, but not trailing punctuation like '?'", () => {
    expect(sanitizeTitle('Kafka rebalancing loop*"` ')).toBe(
      "Kafka rebalancing loop",
    );
    expect(sanitizeTitle("Is this a question?")).toBe("Is this a question?");
  });

  test("caps length at 80 characters", () => {
    const out = sanitizeTitle("x".repeat(100));
    expect(out).toHaveLength(80);
  });
});

// ---------------------------------------------------------------------------
// tagLabel
// ---------------------------------------------------------------------------

describe("tagLabel", () => {
  test("prefixes a project tag with @", () => {
    expect(tagLabel("sideline", ["sideline", "other-repo"])).toBe("@sideline");
  });

  test("prefixes a non-project tag with #", () => {
    expect(tagLabel("bug", ["sideline"])).toBe("#bug");
  });

  test("an empty projectTags list means every tag is #-prefixed", () => {
    expect(tagLabel("sideline", [])).toBe("#sideline");
  });
});

// ---------------------------------------------------------------------------
// tagChipClass
// ---------------------------------------------------------------------------

describe("tagChipClass", () => {
  test("inactive non-project tag is just the base class", () => {
    expect(tagChipClass("bug", false, [])).toBe("tag");
  });

  test("active non-project tag adds the 'on' fill", () => {
    expect(tagChipClass("bug", true, [])).toBe("tag on");
  });

  test("inactive project tag adds 'project' but not 'on'", () => {
    expect(tagChipClass("sideline", false, ["sideline"])).toBe("tag project");
  });

  test("active project tag carries both 'project' and 'on'", () => {
    expect(tagChipClass("sideline", true, ["sideline"])).toBe("tag project on");
  });
});

// ---------------------------------------------------------------------------
// groupByFirstTag
// ---------------------------------------------------------------------------

const note = (tags: string[], body: string): Note => ({
  icon: "🎙️",
  timestamp: "2026-07-29 14:32",
  tags,
  body,
  raw: "",
});

describe("groupByFirstTag", () => {
  test("empty input produces no units", () => {
    expect(groupByFirstTag([])).toEqual([]);
  });

  test("untagged notes are always solo, even when there are several", () => {
    const notes = [note([], "a"), note([], "b")];
    const units = groupByFirstTag(notes);
    expect(units).toEqual([
      { tag: null, notes: [notes[0]] },
      { tag: null, notes: [notes[1]] },
    ]);
  });

  test("notes sharing a first tag merge into one unit, in first-seen order", () => {
    const a = note(["kafka"], "a");
    const b = note(["other"], "b");
    const c = note(["kafka", "urgent"], "c");
    const units = groupByFirstTag([a, b, c]);
    expect(units).toEqual([
      { tag: "kafka", notes: [a, c] },
      { tag: "other", notes: [b] },
    ]);
  });

  test("only the first tag determines grouping — a second shared tag doesn't merge", () => {
    const a = note(["x", "shared"], "a");
    const b = note(["y", "shared"], "b");
    const units = groupByFirstTag([a, b]);
    expect(units).toEqual([
      { tag: "x", notes: [a] },
      { tag: "y", notes: [b] },
    ]);
  });
});
