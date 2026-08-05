// Tests for src/lib/autotag.ts — the pure auto-tag decision logic extracted
// from App.tsx's reload(). Bookkeeping (alreadyProcessed / removedTags) is
// passed in by the caller; these tests exercise the matching/decision logic
// directly, against fixtures derived from the real `\b...\b` word-boundary
// regex.
import { describe, expect, test } from "vitest";
import { autoTag } from "./autotag";
import type { Note } from "../inbox";

const note = (overrides: Partial<Note> = {}): Note => ({
  icon: "📝",
  timestamp: "2026-01-01 12:00",
  tags: [],
  body: "",
  raw: "### 📝 2026-01-01 12:00\nbody",
  ...overrides,
});

describe("autoTag", () => {
  test("adds a single known tag mentioned in the body", () => {
    const n = note({ body: "Need to fix this bug in prod" });
    const result = autoTag([n], new Set(["bug"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["bug"]);
    expect(result.processedKeys).toEqual([n.raw]);
  });

  test("adds every known tag mentioned in the body, in knownTags iteration order", () => {
    const n = note({ body: "This bug also needs a todo follow-up" });
    const result = autoTag([n], new Set(["bug", "todo", "idea"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["bug", "todo"]);
  });

  test("a note already in alreadyProcessed is left untouched and not re-processed", () => {
    const n = note({ body: "mentions bug" });
    const result = autoTag([n], new Set(["bug"]), {
      alreadyProcessed: new Set([n.raw]),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0]).toBe(n);
    expect(result.processedKeys).toEqual([]);
  });

  test("a tag the user removed this run is not re-added even though the body still mentions it", () => {
    const n = note({
      timestamp: "2026-01-01 12:00",
      body: "still about the bug",
    });
    const result = autoTag([n], new Set(["bug"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(["2026-01-01 12:00::bug"]),
    });
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0].tags).toEqual([]);
    // Still marked processed even though nothing was added — matches the
    // in-place implementation, which marks-processed unconditionally.
    expect(result.processedKeys).toEqual([n.raw]);
  });

  test("word-boundary regex does not match a tag occurring inside a larger word", () => {
    const n = note({ body: "We were debugging the deploy all afternoon" });
    const result = autoTag([n], new Set(["bug"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0].tags).toEqual([]);
  });

  test("allows one space/hyphen between a compound tag's letters (voice-transcript split)", () => {
    const n = note({ body: "notes about the side line project" });
    const result = autoTag([n], new Set(["sideline"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["sideline"]);
  });

  test("a tag the note already carries is never added again", () => {
    const n = note({ tags: ["bug"], body: "still about the bug" });
    const result = autoTag([n], new Set(["bug"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0].tags).toEqual(["bug"]);
  });

  test("two notes sharing the same raw in one batch (e.g. a rapid duplicate capture): only the first is processed/tagged, the second is left untouched, and processedKeys contains the key once", () => {
    const raw = "### 🎙️ 2026-01-01 12:00\nmentions bug";
    const n1 = note({ raw, body: "mentions bug" });
    const n2 = note({ raw, body: "mentions bug" });
    const result = autoTag([n1, n2], new Set(["bug"]), {
      alreadyProcessed: new Set(),
      removedTags: new Set(),
    });
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["bug"]);
    expect(result.nextNotes[1]).toBe(n2);
    expect(result.nextNotes[1].tags).toEqual([]);
    expect(result.processedKeys).toEqual([raw]);
  });
});
