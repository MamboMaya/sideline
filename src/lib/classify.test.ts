// Tests for src/lib/classify.ts — request building, both providers'
// response parsing, eligibility, and the tag-decision/apply logic. All IO
// (the actual classify_local/sendToClaude calls) lives in useInbox.ts, out
// of scope here.
import { describe, expect, test } from "vitest";
import type { Note } from "../inbox";
import {
  applyClassifierPicks,
  buildClassifyRequest,
  buildClaudePrompt,
  decideTags,
  eligibleForClassification,
  parseClaudeReply,
  parseLocalResponse,
  selectForClassification,
  validateClassifierUrl,
} from "./classify";

const note = (overrides: Partial<Note> = {}): Note => ({
  icon: "📝",
  timestamp: "2026-01-01 12:00",
  tags: [],
  body: "",
  raw: "### 📝 2026-01-01 12:00\nbody",
  ...overrides,
});

describe("buildClassifyRequest", () => {
  test("includes a type question with QUICK_TAGS + none", () => {
    const req = buildClassifyRequest(note({ body: "fix the thing" }), []);
    expect(req).toEqual({
      state: "fix the thing",
      questions: {
        type: {
          type: "choice",
          instructions: "Classify this note as one of the given labels.",
          criteria: ["bug", "todo", "idea", "none"],
        },
      },
    });
  });

  test("includes a project question when projectTags is non-empty", () => {
    const req = buildClassifyRequest(note({ body: "x" }), ["tauri"]) as {
      questions: Record<string, { criteria: string[] }>;
    };
    expect(req.questions.type.criteria).toEqual([
      "bug",
      "todo",
      "idea",
      "none",
    ]);
    expect(req.questions.project.criteria).toEqual(["tauri", "none"]);
  });

  test("omits the project question when there are no projects", () => {
    const req = buildClassifyRequest(note(), []) as {
      questions: Record<string, unknown>;
    };
    expect(req.questions.project).toBeUndefined();
  });
});

describe("parseLocalResponse", () => {
  test("picks a choice at/above the confidence threshold", () => {
    const pick = parseLocalResponse({
      answers: {
        type: { choice: "bug", confidence: 0.6, probabilities: {} },
        project: { choice: "tauri", confidence: 0.9, probabilities: {} },
      },
    });
    expect(pick).toEqual({ type: "bug", project: "tauri" });
  });

  test("drops a choice below the confidence threshold", () => {
    const pick = parseLocalResponse({
      answers: {
        type: { choice: "bug", confidence: 0.59, probabilities: {} },
      },
    });
    expect(pick.type).toBeUndefined();
  });

  test("drops an explicit none choice regardless of confidence", () => {
    const pick = parseLocalResponse({
      answers: { type: { choice: "none", confidence: 0.99 } },
    });
    expect(pick.type).toBeUndefined();
  });

  test("tolerates a missing project answer", () => {
    const pick = parseLocalResponse({
      answers: { type: { choice: "idea", confidence: 0.8 } },
    });
    expect(pick).toEqual({ type: "idea", project: undefined });
  });

  test("tolerates a malformed/unexpected response shape", () => {
    expect(parseLocalResponse(null)).toEqual({
      type: undefined,
      project: undefined,
    });
    expect(parseLocalResponse("not json")).toEqual({
      type: undefined,
      project: undefined,
    });
    expect(parseLocalResponse({})).toEqual({
      type: undefined,
      project: undefined,
    });
  });
});

describe("buildClaudePrompt", () => {
  test("asks for exactly two lines and lists the QUICK_TAGS/project choices", () => {
    const prompt = buildClaudePrompt(note({ body: "ship it" }), ["tauri"]);
    expect(prompt).toContain("type: <bug|todo|idea|none>");
    expect(prompt).toContain("project: <tauri|none>");
    expect(prompt).toContain("ship it");
  });

  test("falls back to <none> for project choices when there are no projects", () => {
    const prompt = buildClaudePrompt(note(), []);
    expect(prompt).toContain("project: <none|none>");
  });
});

describe("parseClaudeReply", () => {
  test("parses a well-formed two-line reply", () => {
    const pick = parseClaudeReply("type: bug\nproject: tauri", ["tauri"]);
    expect(pick).toEqual({ type: "bug", project: "tauri" });
  });

  test("is case-insensitive on both key and value", () => {
    const pick = parseClaudeReply("Type: BUG\nProject: TAURI", ["tauri"]);
    expect(pick).toEqual({ type: "bug", project: "tauri" });
  });

  test("drops none values", () => {
    const pick = parseClaudeReply("type: none\nproject: none", ["tauri"]);
    expect(pick).toEqual({ type: undefined, project: undefined });
  });

  test("drops a value that isn't one of the offered choices (defensive against hallucination)", () => {
    const pick = parseClaudeReply("type: feature\nproject: raycast", ["tauri"]);
    expect(pick).toEqual({ type: undefined, project: undefined });
  });

  test("tolerates stray extra lines around the two expected ones", () => {
    const pick = parseClaudeReply(
      "Sure, here goes:\ntype: todo\nproject: tauri\nThanks!",
      ["tauri"],
    );
    expect(pick).toEqual({ type: "todo", project: "tauri" });
  });
});

describe("eligibleForClassification", () => {
  test("a note with neither a type nor a project tag is eligible", () => {
    expect(eligibleForClassification(note(), ["tauri"])).toBe(true);
  });

  test("a note missing only a project tag is still eligible", () => {
    expect(eligibleForClassification(note({ tags: ["bug"] }), ["tauri"])).toBe(
      true,
    );
  });

  test("a note missing only a type tag is still eligible", () => {
    expect(
      eligibleForClassification(note({ tags: ["tauri"] }), ["tauri"]),
    ).toBe(true);
  });

  test("a note with both a type and a project tag is not eligible", () => {
    expect(
      eligibleForClassification(note({ tags: ["bug", "tauri"] }), ["tauri"]),
    ).toBe(false);
  });
});

describe("selectForClassification", () => {
  test("selects not-yet-processed, eligible notes and reports every scanned raw", () => {
    const eligible1 = note({ raw: "a", body: "a" });
    const alreadyTagged = note({ raw: "b", tags: ["bug", "tauri"], body: "b" });
    const result = selectForClassification([eligible1, alreadyTagged], {
      alreadyProcessed: new Set(),
      projectTags: ["tauri"],
    });
    expect(result.eligible).toEqual([eligible1]);
    expect(result.processedKeys).toEqual(["a", "b"]);
  });

  test("skips a raw already in alreadyProcessed entirely", () => {
    const n = note({ raw: "a", body: "a" });
    const result = selectForClassification([n], {
      alreadyProcessed: new Set(["a"]),
      projectTags: [],
    });
    expect(result.eligible).toEqual([]);
    expect(result.processedKeys).toEqual([]);
  });
});

describe("decideTags", () => {
  test("adds a type tag when the note has none", () => {
    const added = decideTags(
      note(),
      { type: "bug" },
      {
        removedTags: new Set(),
        projectTags: [],
      },
    );
    expect(added).toEqual(["bug"]);
  });

  test("does not add a type tag when the note already has one", () => {
    const added = decideTags(
      note({ tags: ["idea"] }),
      { type: "bug" },
      {
        removedTags: new Set(),
        projectTags: [],
      },
    );
    expect(added).toEqual([]);
  });

  test("adds both type and project when the note has neither", () => {
    const added = decideTags(
      note(),
      { type: "bug", project: "tauri" },
      { removedTags: new Set(), projectTags: ["tauri"] },
    );
    expect(added).toEqual(["bug", "tauri"]);
  });

  test("never re-adds a tag the user removed this run", () => {
    const added = decideTags(
      note({ timestamp: "2026-01-01 12:00" }),
      { type: "bug" },
      {
        removedTags: new Set(["2026-01-01 12:00::bug"]),
        projectTags: [],
      },
    );
    expect(added).toEqual([]);
  });

  test("no pick for a question means no tag added for it", () => {
    const added = decideTags(
      note(),
      {},
      {
        removedTags: new Set(),
        projectTags: ["tauri"],
      },
    );
    expect(added).toEqual([]);
  });
});

describe("validateClassifierUrl", () => {
  test("accepts loopback http/https URLs", () => {
    expect(validateClassifierUrl("http://127.0.0.1:4410")).toBeNull();
    expect(validateClassifierUrl("https://127.0.0.1:4410")).toBeNull();
    expect(validateClassifierUrl("http://localhost:4410")).toBeNull();
    expect(validateClassifierUrl("http://[::1]:4410")).toBeNull();
  });

  test("rejects a non-loopback host", () => {
    expect(validateClassifierUrl("http://example.com:4410")).toMatch(
      /loopback|127\.0\.0\.1/,
    );
  });

  test("rejects a non-http(s) scheme", () => {
    expect(validateClassifierUrl("ftp://127.0.0.1:4410")).toMatch(
      /http or https/,
    );
  });

  test("rejects a malformed URL", () => {
    expect(validateClassifierUrl("not a url")).toMatch(/invalid/);
  });
});

describe("applyClassifierPicks", () => {
  test("applies a pick's added tags to the matching note by raw", () => {
    const n = note({ raw: "a" });
    const result = applyClassifierPicks(
      [n],
      new Map([["a", { type: "bug" }]]),
      { removedTags: new Set(), projectTags: [] },
    );
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["bug"]);
  });

  test("leaves a note with no pick untouched (same reference)", () => {
    const n = note({ raw: "a" });
    const result = applyClassifierPicks([n], new Map(), {
      removedTags: new Set(),
      projectTags: [],
    });
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0]).toBe(n);
  });

  test("leaves a note untouched when its pick decides to add nothing", () => {
    const n = note({ raw: "a", tags: ["bug"] });
    const result = applyClassifierPicks(
      [n],
      new Map([["a", { type: "idea" }]]),
      { removedTags: new Set(), projectTags: [] },
    );
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0]).toBe(n);
  });
});
