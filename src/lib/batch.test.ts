// Tests for src/lib/batch.ts — building the multi-item batch-triage prompt
// and splitting the reply back into per-item text.
import { describe, expect, test } from "vitest";
import type { Note } from "../inbox";
import { BatchUnit, buildBatchPrompt, parseBatchReply } from "./batch";

const note = (body: string, tags: string[] = []): Note => ({
  icon: "📝",
  timestamp: "2026-01-02 03:04",
  tags,
  body,
  raw: `### 📝 2026-01-02 03:04\n${body}`,
});

// The construction exactly as it read inline in App.tsx's triageBatch
// before the move, kept here as the byte-for-byte reference: any drift in
// buildBatchPrompt changes the prompt the model actually sees.
const inlineBuild = (batchPrompt: string, units: BatchUnit[]): string => {
  const body = units
    .map((u, i) => {
      const marker =
        u.notes.length > 1
          ? `=== ITEM ${i + 1} (tag: ${u.tag}, ${u.notes.length} notes) ===`
          : `=== ITEM ${i + 1} ===`;
      return `${marker}\n${u.notes.map((n) => n.body).join("\n\n")}`;
    })
    .join("\n\n");
  return `${batchPrompt}\n\n${body}`;
};

describe("buildBatchPrompt", () => {
  // A solo unit and a 2-note group — the two marker shapes in one prompt.
  const units: BatchUnit[] = [
    { tag: "idea", notes: [note("First idea body.", ["idea"])] },
    {
      tag: "kafka",
      notes: [
        note("Kafka note one.", ["kafka"]),
        note("Kafka note two,\nwith a second line.", ["kafka"]),
      ],
    },
  ];

  test("2 units: byte-matches the old inline construction", () => {
    expect(buildBatchPrompt("Triage these.", units)).toBe(
      inlineBuild("Triage these.", units),
    );
  });

  test("2 units: exact bytes, solo marker then grouped marker", () => {
    expect(buildBatchPrompt("Triage these.", units)).toBe(
      "Triage these.\n" +
        "\n" +
        "=== ITEM 1 ===\n" +
        "First idea body.\n" +
        "\n" +
        "=== ITEM 2 (tag: kafka, 2 notes) ===\n" +
        "Kafka note one.\n" +
        "\n" +
        "Kafka note two,\nwith a second line.",
    );
  });

  test("item numbers are unit positions parseBatchReply reads back", () => {
    const prompt = buildBatchPrompt("Triage these.", units);
    const echoed = prompt
      .split("\n\n")
      .filter((p) => p.startsWith("=== ITEM"))
      .join("\n\n");
    expect([...parseBatchReply(echoed).keys()]).toEqual([1, 2]);
  });

  test("untagged solo unit (tag null) still gets the bare marker", () => {
    expect(buildBatchPrompt("P", [{ tag: null, notes: [note("Lone.")] }])).toBe(
      "P\n\n=== ITEM 1 ===\nLone.",
    );
  });
});

describe("parseBatchReply", () => {
  test("0 items: a reply with no '=== ITEM n ===' markers produces an empty map", () => {
    expect(parseBatchReply("Just a plain reply, no markers at all.")).toEqual(
      new Map(),
    );
    expect(parseBatchReply("")).toEqual(new Map());
  });

  test("1 item: a single marked section maps item number to trimmed text", () => {
    const reply = "=== ITEM 1 ===\nThe reply body for item one.\n";
    expect(parseBatchReply(reply)).toEqual(
      new Map([[1, "The reply body for item one."]]),
    );
  });

  test("n items: multiple sections map each number to its own trimmed text, order-independent", () => {
    const reply =
      "=== ITEM 1 ===\n" +
      "Reply for item one.\n" +
      "=== ITEM 2 ===\n" +
      "Reply for item two,\nspanning two lines.\n" +
      "=== ITEM 3 ===\n" +
      "Reply for item three.\n";
    expect(parseBatchReply(reply)).toEqual(
      new Map([
        [1, "Reply for item one."],
        [2, "Reply for item two,\nspanning two lines."],
        [3, "Reply for item three."],
      ]),
    );
  });

  test("accepts the grouped-unit marker shape '=== ITEM n (tag: ..., N notes) ==='", () => {
    const reply = "=== ITEM 2 (tag: kafka, 3 notes) ===\nMerged reply text.\n";
    expect(parseBatchReply(reply)).toEqual(
      new Map([[2, "Merged reply text."]]),
    );
  });

  test("malformed: a blank/whitespace-only section is simply absent from the map", () => {
    const reply = "=== ITEM 1 ===\n\n=== ITEM 2 ===\nOnly item two has text.\n";
    expect(parseBatchReply(reply)).toEqual(
      new Map([[2, "Only item two has text."]]),
    );
  });

  test("malformed: text before the first marker is discarded", () => {
    const reply =
      "Some preamble the model added.\n=== ITEM 1 ===\nItem one text.\n";
    expect(parseBatchReply(reply)).toEqual(new Map([[1, "Item one text."]]));
  });

  test("malformed: a marker not anchored at line start (mid-line) is not recognized", () => {
    const reply = "prefix === ITEM 1 ===\nshould not be captured\n";
    expect(parseBatchReply(reply)).toEqual(new Map());
  });
});
