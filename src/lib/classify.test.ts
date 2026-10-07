// Tests for src/lib/classify.ts — request building, both providers'
// response parsing, eligibility, the tag-decision/apply logic, the
// concurrency limiter, and the classify+write-back batch loop. All real IO
// (the actual classify_local/sendToClaude/readInbox/writeInbox calls) lives
// in useInbox.ts, out of scope here — runClassifyBatch is exercised via
// fake IO callbacks instead.
import { describe, expect, test, vi } from "vitest";
import type { Note } from "../inbox";
import {
  CLASSIFY_WINDOW_HOURS,
  Limiter,
  applyClassifierPicksToFreshNotes,
  buildClassifyRequest,
  buildClaudePrompt,
  decideTags,
  eligibleForClassification,
  parseClaudeReply,
  parseLocalResponse,
  runClassifyBatch,
  selectForClassification,
  validateClassifierUrl,
} from "./classify";

const NOW = new Date("2026-01-02T12:00:00");

const note = (overrides: Partial<Note> = {}): Note => ({
  icon: "📝",
  timestamp: "2026-01-02 11:00",
  tags: [],
  body: "",
  raw: "### 📝 2026-01-02 11:00\nbody",
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
    const pick = parseLocalResponse(
      {
        answers: {
          type: { choice: "bug", confidence: 0.6, probabilities: {} },
          project: { choice: "tauri", confidence: 0.9, probabilities: {} },
        },
      },
      ["tauri"],
    );
    expect(pick).toEqual({ type: "bug", project: "tauri" });
  });

  test("drops a choice below the confidence threshold", () => {
    const pick = parseLocalResponse(
      { answers: { type: { choice: "bug", confidence: 0.59 } } },
      [],
    );
    expect(pick.type).toBeUndefined();
  });

  test("drops an explicit none choice regardless of confidence", () => {
    const pick = parseLocalResponse(
      { answers: { type: { choice: "none", confidence: 0.99 } } },
      [],
    );
    expect(pick.type).toBeUndefined();
  });

  test("is case-insensitive and returns the canonical (lowercased) tag", () => {
    const pick = parseLocalResponse(
      { answers: { type: { choice: "Bug", confidence: 0.9 } } },
      [],
    );
    expect(pick.type).toBe("bug");
  });

  test("drops a choice that isn't one of QUICK_TAGS (e.g. a hallucinated label)", () => {
    // This is the header-injection / infinite-loop guard: a choice like
    // "Bug!" or a value with spaces/newlines must never come back as a
    // pick, since decideTags would otherwise add it as a tag that never
    // satisfies eligibleForClassification's hasType check.
    const pick = parseLocalResponse(
      { answers: { type: { choice: "feature request", confidence: 0.9 } } },
      [],
    );
    expect(pick.type).toBeUndefined();
  });

  test("drops a project choice that isn't in the configured projectTags", () => {
    const pick = parseLocalResponse(
      { answers: { project: { choice: "raycast", confidence: 0.9 } } },
      ["tauri"],
    );
    expect(pick.project).toBeUndefined();
  });

  test("omits the project answer entirely when no projects are configured", () => {
    const pick = parseLocalResponse(
      { answers: { project: { choice: "tauri", confidence: 0.9 } } },
      [],
    );
    expect(pick.project).toBeUndefined();
  });

  test("tolerates a missing project answer", () => {
    const pick = parseLocalResponse(
      { answers: { type: { choice: "idea", confidence: 0.8 } } },
      ["tauri"],
    );
    expect(pick).toEqual({ type: "idea", project: undefined });
  });

  test("tolerates a malformed/unexpected response shape", () => {
    expect(parseLocalResponse(null, [])).toEqual({
      type: undefined,
      project: undefined,
    });
    expect(parseLocalResponse("not json", [])).toEqual({
      type: undefined,
      project: undefined,
    });
    expect(parseLocalResponse({}, [])).toEqual({
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
    expect(eligibleForClassification(note(), ["tauri"], NOW)).toBe(true);
  });

  test("a note missing only a project tag is eligible when projects are configured", () => {
    expect(
      eligibleForClassification(note({ tags: ["bug"] }), ["tauri"], NOW),
    ).toBe(true);
  });

  test("a note with a type tag is NOT eligible when no projects are configured", () => {
    // A note with a type tag already has nothing left to ask when there's
    // no project question at all — treating it as still-eligible would
    // resend it to the classifier on every launch forever.
    expect(eligibleForClassification(note({ tags: ["bug"] }), [], NOW)).toBe(
      false,
    );
  });

  test("a note missing only a type tag is still eligible", () => {
    expect(
      eligibleForClassification(note({ tags: ["tauri"] }), ["tauri"], NOW),
    ).toBe(true);
  });

  test("a note with both a type and a project tag is not eligible", () => {
    expect(
      eligibleForClassification(
        note({ tags: ["bug", "tauri"] }),
        ["tauri"],
        NOW,
      ),
    ).toBe(false);
  });

  test("a note captured within the classify window is eligible", () => {
    const recent = note({
      timestamp: "2026-01-02 11:00",
    });
    expect(eligibleForClassification(recent, [], NOW)).toBe(true);
  });

  test("a note captured just outside the classify window is not eligible", () => {
    const stale = note({ timestamp: "2026-01-01 11:59" }); // > 24h before NOW
    expect(eligibleForClassification(stale, [], NOW)).toBe(false);
  });

  test("a note exactly at the classify window boundary is still eligible", () => {
    const boundary = new Date(
      NOW.getTime() - CLASSIFY_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const iso = boundary.toISOString().slice(0, 16).replace("T", " ");
    expect(eligibleForClassification(note({ timestamp: iso }), [], NOW)).toBe(
      true,
    );
  });

  test("an unparseable timestamp is never eligible", () => {
    expect(
      eligibleForClassification(note({ timestamp: "garbage" }), [], NOW),
    ).toBe(false);
  });
});

describe("selectForClassification", () => {
  test("selects not-yet-processed, eligible notes and reports every scanned timestamp", () => {
    const eligible1 = note({ timestamp: "2026-01-02 10:00", body: "a" });
    const alreadyTagged = note({
      timestamp: "2026-01-02 10:01",
      tags: ["bug", "tauri"],
      body: "b",
    });
    const result = selectForClassification([eligible1, alreadyTagged], {
      alreadyProcessed: new Set(),
      projectTags: ["tauri"],
      now: NOW,
    });
    expect(result.eligible).toEqual([eligible1]);
    expect(result.processedKeys).toEqual([
      "2026-01-02 10:00",
      "2026-01-02 10:01",
    ]);
  });

  test("skips a timestamp already in alreadyProcessed entirely", () => {
    const n = note({ timestamp: "2026-01-02 10:00", body: "a" });
    const result = selectForClassification([n], {
      alreadyProcessed: new Set(["2026-01-02 10:00"]),
      projectTags: [],
      now: NOW,
    });
    expect(result.eligible).toEqual([]);
    expect(result.processedKeys).toEqual([]);
  });

  test("an edit (raw changes, timestamp doesn't) does not re-trigger classification", () => {
    const original = note({ timestamp: "2026-01-02 10:00", raw: "raw-1" });
    const edited = note({
      timestamp: "2026-01-02 10:00",
      raw: "raw-2",
      body: "edited",
    });
    const first = selectForClassification([original], {
      alreadyProcessed: new Set(),
      projectTags: [],
      now: NOW,
    });
    const seen = new Set(first.processedKeys);
    const second = selectForClassification([edited], {
      alreadyProcessed: seen,
      projectTags: [],
      now: NOW,
    });
    expect(second.eligible).toEqual([]);
  });
});

describe("decideTags", () => {
  const baseOptions = {
    removedTags: new Set<string>(),
    hiddenTags: new Set<string>(),
  };

  test("adds a type tag when the note has none", () => {
    const added = decideTags(
      note(),
      { type: "bug" },
      { ...baseOptions, projectTags: [] },
    );
    expect(added).toEqual(["bug"]);
  });

  test("does not add a type tag when the note already has one", () => {
    const added = decideTags(
      note({ tags: ["idea"] }),
      { type: "bug" },
      { ...baseOptions, projectTags: [] },
    );
    expect(added).toEqual([]);
  });

  test("adds both type and project when the note has neither", () => {
    const added = decideTags(
      note(),
      { type: "bug", project: "tauri" },
      { ...baseOptions, projectTags: ["tauri"] },
    );
    expect(added).toEqual(["bug", "tauri"]);
  });

  test("never re-adds the exact tag the user removed this run", () => {
    const added = decideTags(
      note({ timestamp: "2026-01-01 12:00" }),
      { type: "bug" },
      {
        removedTags: new Set(["2026-01-01 12:00::bug"]),
        hiddenTags: new Set(),
        projectTags: [],
      },
    );
    expect(added).toEqual([]);
  });

  test("blocks the whole type category once ANY type tag was removed from the note", () => {
    // The user removed "idea" (not "bug") from this note — a later pick of
    // "bug" must still be blocked, since removing one type tag means the
    // user decided this note isn't typed, not just that it isn't "idea".
    const added = decideTags(
      note({ timestamp: "2026-01-01 12:00" }),
      { type: "bug" },
      {
        removedTags: new Set(["2026-01-01 12:00::idea"]),
        hiddenTags: new Set(),
        projectTags: [],
      },
    );
    expect(added).toEqual([]);
  });

  test("blocks the whole project category once ANY project tag was removed from the note", () => {
    const added = decideTags(
      note({ timestamp: "2026-01-01 12:00" }),
      { project: "raycast" },
      {
        removedTags: new Set(["2026-01-01 12:00::tauri"]),
        hiddenTags: new Set(),
        projectTags: ["tauri", "raycast"],
      },
    );
    expect(added).toEqual([]);
  });

  test("removing a type tag blocks type picks but not a project pick", () => {
    // "idea" was removed (a type tag) — the whole type category is blocked
    // (see the category-blocking test above), but the project pick is
    // unaffected since project removals are tracked separately.
    const added = decideTags(
      note({ timestamp: "2026-01-01 12:00" }),
      { type: "bug", project: "tauri" },
      {
        removedTags: new Set(["2026-01-01 12:00::idea"]),
        hiddenTags: new Set(),
        projectTags: ["tauri"],
      },
    );
    expect(added).toEqual(["tauri"]);
  });

  test("removing a project tag blocks project picks but not a type pick", () => {
    const added = decideTags(
      note({ timestamp: "2026-01-01 12:00" }),
      { type: "bug", project: "tauri" },
      {
        removedTags: new Set(["2026-01-01 12:00::tauri"]),
        hiddenTags: new Set(),
        projectTags: ["tauri", "raycast"],
      },
    );
    expect(added).toEqual(["bug"]);
  });

  test("never adds a tag that's in hiddenTags", () => {
    const added = decideTags(
      note(),
      { type: "bug", project: "tauri" },
      {
        removedTags: new Set(),
        hiddenTags: new Set(["bug"]),
        projectTags: ["tauri"],
      },
    );
    expect(added).toEqual(["tauri"]);
  });

  test("never adds a tag the note already literally has", () => {
    const added = decideTags(
      note({ tags: [] }),
      { type: "bug" },
      { ...baseOptions, projectTags: [] },
    );
    expect(added).toEqual(["bug"]);
    // Sanity: the same pick against a note that already carries it adds
    // nothing (covered by the hasType check above too, but asserted
    // directly here per the "never add a tag the note already has" rule).
    const addedAgain = decideTags(
      note({ tags: ["bug"] }),
      { type: "bug" },
      { ...baseOptions, projectTags: [] },
    );
    expect(addedAgain).toEqual([]);
  });

  test("no pick for a question means no tag added for it", () => {
    const added = decideTags(
      note(),
      {},
      { ...baseOptions, projectTags: ["tauri"] },
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

describe("applyClassifierPicksToFreshNotes", () => {
  const options = {
    removedTags: new Set<string>(),
    hiddenTags: new Set<string>(),
    projectTags: [] as string[],
  };

  test("applies a pick to the matching fresh note by timestamp+body", () => {
    const fresh = note({ timestamp: "t1", body: "hello" });
    const result = applyClassifierPicksToFreshNotes(
      [fresh],
      [{ timestamp: "t1", body: "hello", pick: { type: "bug" } }],
      options,
    );
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["bug"]);
  });

  test("drops a pick whose note's body changed since it was classified (stale)", () => {
    const fresh = note({ timestamp: "t1", body: "edited since" });
    const result = applyClassifierPicksToFreshNotes(
      [fresh],
      [{ timestamp: "t1", body: "original", pick: { type: "bug" } }],
      options,
    );
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0]).toBe(fresh);
  });

  test("drops a pick whose note is gone from the fresh list (archived/deleted meanwhile)", () => {
    const other = note({ timestamp: "t2", body: "other" });
    const result = applyClassifierPicksToFreshNotes(
      [other],
      [{ timestamp: "t1", body: "hello", pick: { type: "bug" } }],
      options,
    );
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0]).toBe(other);
  });

  test("still applies a pick when only the note's tags changed (body unchanged)", () => {
    // A tag added by some other path (auto-tagger, user) between the
    // classify call and this fresh read — the pick is still valid content-
    // wise, and decideTags re-checks the note's CURRENT tags anyway.
    const fresh = note({ timestamp: "t1", body: "hello", tags: ["sideline"] });
    const result = applyClassifierPicksToFreshNotes(
      [fresh],
      [{ timestamp: "t1", body: "hello", pick: { type: "bug" } }],
      options,
    );
    expect(result.changed).toBe(true);
    expect(result.nextNotes[0].tags).toEqual(["sideline", "bug"]);
  });

  test("leaves a note with no matching pick untouched (same reference)", () => {
    const n = note({ timestamp: "t1", body: "hello" });
    const result = applyClassifierPicksToFreshNotes([n], [], options);
    expect(result.changed).toBe(false);
    expect(result.nextNotes[0]).toBe(n);
  });
});

describe("Limiter", () => {
  test("never runs more than `max` callbacks concurrently", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([1, 2, 3, 4, 5].map(() => limiter.run(task)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("shares its cap across multiple concurrent run() call sites", async () => {
    // Simulates two overlapping runClassifier calls (e.g. two inbox-changed
    // events) sharing ONE module-level limiter — the total in-flight count
    // across both batches must still respect the cap.
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    const batchA = [1, 2, 3].map(() => limiter.run(task));
    const batchB = [1, 2, 3].map(() => limiter.run(task));
    await Promise.all([...batchA, ...batchB]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("queued callbacks eventually all run", async () => {
    const limiter = new Limiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n);
        }),
      ),
    );
    expect(order.sort()).toEqual([1, 2, 3]);
  });
});

describe("runClassifyBatch", () => {
  test("calls classify then writeBack for every eligible note", async () => {
    const a = note({ timestamp: "t1" });
    const b = note({ timestamp: "t2" });
    const classify = vi.fn().mockResolvedValue({ type: "bug" });
    const writeBack = vi.fn().mockResolvedValue(undefined);
    await runClassifyBatch([a, b], { classify, writeBack }, new Limiter(2));
    expect(classify).toHaveBeenCalledTimes(2);
    expect(writeBack).toHaveBeenCalledTimes(2);
  });

  test("skips writeBack when classify produces an empty pick", async () => {
    const a = note({ timestamp: "t1" });
    const classify = vi.fn().mockResolvedValue({});
    const writeBack = vi.fn().mockResolvedValue(undefined);
    await runClassifyBatch([a], { classify, writeBack }, new Limiter(2));
    expect(writeBack).not.toHaveBeenCalled();
  });

  test("a classify rejection for one note doesn't affect the others", async () => {
    const a = note({ timestamp: "t1" });
    const b = note({ timestamp: "t2" });
    const classify = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("unreachable")))
      .mockImplementationOnce(() => Promise.resolve({ type: "bug" }));
    const writeBack = vi.fn().mockResolvedValue(undefined);
    await expect(
      runClassifyBatch([a, b], { classify, writeBack }, new Limiter(2)),
    ).resolves.toBeUndefined();
    expect(writeBack).toHaveBeenCalledTimes(1);
  });

  test("a writeBack rejection is swallowed (logged), not thrown, for other notes", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = note({ timestamp: "t1" });
    const b = note({ timestamp: "t2" });
    const classify = vi.fn().mockResolvedValue({ type: "bug" });
    const writeBack = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("conflict")))
      .mockImplementationOnce(() => Promise.resolve(undefined));
    await expect(
      runClassifyBatch([a, b], { classify, writeBack }, new Limiter(2)),
    ).resolves.toBeUndefined();
    expect(writeBack).toHaveBeenCalledTimes(2);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  test("writes back per note rather than waiting for the whole batch", async () => {
    // Regression guard for "write results back per note or in small chunks,
    // not after the whole batch": writeBack for a fast note must resolve
    // before a slower note's classify call has even finished.
    const fast = note({ timestamp: "fast" });
    const slow = note({ timestamp: "slow" });
    const order: string[] = [];
    const classify = vi.fn().mockImplementation(async (n: Note) => {
      if (n.timestamp === "slow") {
        await new Promise((r) => setTimeout(r, 20));
      }
      return { type: "bug" };
    });
    const writeBack = vi.fn().mockImplementation(async (n: Note) => {
      order.push(n.timestamp);
    });
    await runClassifyBatch(
      [fast, slow],
      { classify, writeBack },
      new Limiter(2),
    );
    expect(order[0]).toBe("fast");
    expect(order[1]).toBe("slow");
  });

  test("respects the limiter's concurrency cap across the batch", async () => {
    const notes = [1, 2, 3, 4].map((n) => note({ timestamp: `t${n}` }));
    let active = 0;
    let peak = 0;
    const classify = vi.fn().mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { type: "bug" };
    });
    const writeBack = vi.fn().mockResolvedValue(undefined);
    await runClassifyBatch(notes, { classify, writeBack }, new Limiter(2));
    expect(peak).toBeLessThanOrEqual(2);
  });
});
