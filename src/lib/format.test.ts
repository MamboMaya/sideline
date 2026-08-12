// Tests for src/lib/format.ts — string-shaping helpers extracted from
// App.tsx (tag/title normalization, hotkey display, batch-triage grouping).
import { describe, expect, test } from "vitest";
import {
  formatHotkey,
  macHotkeyCombo,
  sanitizeTag,
  escapeRegex,
  needsTitle,
  sanitizeTitle,
  localTitle,
  groupByFirstTag,
  tagLabel,
  tagChipClass,
  comboFromKeyEvent,
  heldHotkeyModifiers,
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
// macHotkeyCombo
// ---------------------------------------------------------------------------

describe("macHotkeyCombo", () => {
  test("rewrites alt/super/meta/ctrl to the Mac words, lowercased", () => {
    expect(macHotkeyCombo("alt+cmd+space")).toBe("option+cmd+space");
    expect(macHotkeyCombo("super+ALT+R")).toBe("cmd+option+r");
    expect(macHotkeyCombo("meta+ctrl+V")).toBe("cmd+control+v");
  });

  test("leaves already-Mac-worded tokens (cmd, option, control, shift) as-is, lowercased", () => {
    expect(macHotkeyCombo("shift+cmd+v")).toBe("shift+cmd+v");
    expect(macHotkeyCombo("Control+Option+Q")).toBe("control+option+q");
  });

  test("passes an unrecognized token (the actual key) through lowercased", () => {
    expect(macHotkeyCombo("alt+cmd+space")).toContain("space");
    expect(macHotkeyCombo("cmd+F5")).toBe("cmd+f5");
  });

  test("undefined or empty input produces an empty string, not a fallback", () => {
    expect(macHotkeyCombo(undefined)).toBe("");
    expect(macHotkeyCombo("")).toBe("");
    expect(macHotkeyCombo("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// comboFromKeyEvent / heldHotkeyModifiers
// ---------------------------------------------------------------------------

const keyEvent = (
  overrides: Partial<Parameters<typeof comboFromKeyEvent>[0]>,
) => ({
  code: "",
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...overrides,
});

describe("comboFromKeyEvent", () => {
  test("a letter key (by physical code) with cmd produces cmd+<lowercase letter>", () => {
    expect(
      comboFromKeyEvent(keyEvent({ code: "KeyV", metaKey: true })),
    ).toEqual({ combo: "cmd+v", modifierOnly: false });
  });

  test("a digit key with a modifier produces the bare digit", () => {
    expect(
      comboFromKeyEvent(keyEvent({ code: "Digit3", ctrlKey: true })),
    ).toEqual({ combo: "control+3", modifierOnly: false });
  });

  test("Space with modifiers produces the 'space' token", () => {
    expect(
      comboFromKeyEvent(
        keyEvent({ code: "Space", altKey: true, metaKey: true }),
      ),
    ).toEqual({ combo: "option+cmd+space", modifierOnly: false });
  });

  test("an F-key code passes through exactly as e.code spells it", () => {
    expect(comboFromKeyEvent(keyEvent({ code: "F5", metaKey: true }))).toEqual({
      combo: "cmd+F5",
      modifierOnly: false,
    });
  });

  test("Comma passes through exactly as e.code spells it", () => {
    expect(
      comboFromKeyEvent(
        keyEvent({ code: "Comma", shiftKey: true, metaKey: true }),
      ),
    ).toEqual({ combo: "shift+cmd+Comma", modifierOnly: false });
  });

  test("modifiers are emitted in a stable macOS order regardless of the flag-setting order", () => {
    expect(
      comboFromKeyEvent(
        keyEvent({
          code: "KeyQ",
          shiftKey: true,
          metaKey: true,
          ctrlKey: true,
          altKey: true,
        }),
      ),
    ).toEqual({ combo: "control+option+shift+cmd+q", modifierOnly: false });
  });

  test("a modifier key going down by itself is modifierOnly, with a null combo", () => {
    for (const code of [
      "ControlLeft",
      "ControlRight",
      "AltLeft",
      "AltRight",
      "ShiftLeft",
      "ShiftRight",
      "MetaLeft",
      "MetaRight",
    ]) {
      expect(
        comboFromKeyEvent(
          keyEvent({ code, ctrlKey: code.startsWith("Control") }),
        ),
      ).toEqual({ combo: null, modifierOnly: true });
    }
  });

  test("a bare non-modifier key with no modifiers held is invalid, not modifierOnly", () => {
    expect(comboFromKeyEvent(keyEvent({ code: "KeyA" }))).toEqual({
      combo: null,
      modifierOnly: false,
    });
  });
});

describe("heldHotkeyModifiers", () => {
  test("returns an empty array when nothing is held", () => {
    expect(heldHotkeyModifiers(keyEvent({}))).toEqual([]);
  });

  test("orders held modifiers as control, option, shift, cmd", () => {
    expect(
      heldHotkeyModifiers(
        keyEvent({
          metaKey: true,
          shiftKey: true,
          ctrlKey: true,
          altKey: true,
        }),
      ),
    ).toEqual(["control", "option", "shift", "cmd"]);
  });

  test("only includes the modifiers actually held", () => {
    expect(heldHotkeyModifiers(keyEvent({ metaKey: true }))).toEqual(["cmd"]);
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal "${}" is the regex-metacharacter fixture under test
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
// localTitle
// ---------------------------------------------------------------------------

describe("localTitle", () => {
  test("uses the first non-empty line as the title", () => {
    const body = "Kafka rebalancing loop\nsome more detail\nand more";
    expect(localTitle(body)).toBe("Kafka rebalancing loop");
  });

  test("skips leading blank lines to find the first non-empty one", () => {
    const body = "\n\n  \nActual first line\nsecond line";
    expect(localTitle(body)).toBe("Actual first line");
  });

  test("runs the chosen line through sanitizeTitle (markdown/quote noise stripped, 80-char cap)", () => {
    expect(localTitle('# "Kafka rebalancing loop`\nmore')).toBe(
      "Kafka rebalancing loop",
    );
    const long = "x".repeat(100);
    expect(localTitle(long)).toHaveLength(80);
  });

  test("an all-blank body produces an empty string", () => {
    expect(localTitle("\n  \n\t\n")).toBe("");
  });

  test("a single-line body just sanitizes that line", () => {
    expect(localTitle("Quick reminder to check the logs.")).toBe(
      "Quick reminder to check the logs.",
    );
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
