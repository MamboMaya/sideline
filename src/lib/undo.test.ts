import { describe, expect, test } from "vitest";
import type { Note } from "../inbox";
import {
  insertNoteAt,
  mergeMissingNotes,
  restoreBody,
  stripArchiveBlock,
} from "./undo";

const note = (timestamp: string, body: string, tags: string[] = []): Note => ({
  raw: `### 🎙️ ${timestamp}\n${body}`,
  icon: "🎙️",
  timestamp,
  tags,
  body,
});

describe("insertNoteAt", () => {
  test("re-inserts at the original index", () => {
    const cur = [note("2026-08-05 10:00", "a"), note("2026-08-05 10:02", "c")];
    const b = note("2026-08-05 10:01", "b");
    expect(insertNoteAt(cur, b, 1).map((n) => n.body)).toEqual(["a", "b", "c"]);
  });

  test("clamps an index past the end (list shrank since)", () => {
    const cur = [note("2026-08-05 10:00", "a")];
    const b = note("2026-08-05 10:01", "b");
    expect(insertNoteAt(cur, b, 5).map((n) => n.body)).toEqual(["a", "b"]);
  });

  test("does not mutate the input array", () => {
    const cur = [note("2026-08-05 10:00", "a")];
    insertNoteAt(cur, note("2026-08-05 10:01", "b"), 0);
    expect(cur.map((n) => n.body)).toEqual(["a"]);
  });
});

describe("mergeMissingNotes", () => {
  test("re-inserts snapshot notes absent from current, keeps current additions", () => {
    // Batch filed "b"; meanwhile a new capture "d" arrived. Undo must
    // restore "b" without touching "d".
    const snapshot = [
      note("2026-08-05 10:00", "a"),
      note("2026-08-05 10:01", "b"),
      note("2026-08-05 10:02", "c"),
    ];
    const current = [
      note("2026-08-05 10:00", "a"),
      note("2026-08-05 10:02", "c"),
      note("2026-08-05 10:05", "d"),
    ];
    expect(mergeMissingNotes(current, snapshot).map((n) => n.body)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("identity is timestamp+body, so a reload's re-parsed objects still match", () => {
    const snapshot = [note("2026-08-05 10:00", "a", ["todo"])];
    const current = [note("2026-08-05 10:00", "a", ["todo", "bug"])];
    // Same note (tags churned by the auto-tagger) — nothing to re-insert.
    expect(mergeMissingNotes(current, snapshot)).toBe(current);
  });

  test("empty current restores the whole snapshot", () => {
    const snapshot = [note("2026-08-05 10:00", "a")];
    expect(mergeMissingNotes([], snapshot).map((n) => n.body)).toEqual(["a"]);
  });
});

describe("restoreBody", () => {
  test("restores the pre-edit body by timestamp+edited-body identity", () => {
    const cur = [note("2026-08-05 10:00", "edited text")];
    const out = restoreBody(cur, "2026-08-05 10:00", "edited text", "original");
    expect(out?.map((n) => n.body)).toEqual(["original"]);
  });

  test("returns null when the edited note is gone (archived since)", () => {
    expect(restoreBody([], "2026-08-05 10:00", "edited", "orig")).toBeNull();
  });

  test("returns null when the note was edited again since", () => {
    const cur = [note("2026-08-05 10:00", "edited twice")];
    expect(
      restoreBody(cur, "2026-08-05 10:00", "edited once", "orig"),
    ).toBeNull();
  });
});

describe("stripArchiveBlock", () => {
  test("removes a block appended to a non-empty archive", () => {
    // Shape appendToArchive produces: trimmed + "\n\n" + block + "\n".
    const archive = "### old entry\nbody\n\n### 🎙️ 2026-08-05 10:00\nnew\n";
    const out = stripArchiveBlock(archive, "### 🎙️ 2026-08-05 10:00\nnew");
    expect(out).toBe("### old entry\nbody\n");
  });

  test("removes the only block of a previously-empty archive", () => {
    const out = stripArchiveBlock(
      "### 🎙️ 2026-08-05 10:00\nnew\n",
      "### 🎙️ 2026-08-05 10:00\nnew",
    );
    expect(out).toBe("");
  });

  test("strips the LAST occurrence when the block text repeats", () => {
    const archive =
      "### 🎙️ 2026-08-05 10:00\ndup\n\n### other\nx\n\n### 🎙️ 2026-08-05 10:00\ndup\n";
    const out = stripArchiveBlock(archive, "### 🎙️ 2026-08-05 10:00\ndup");
    expect(out).toBe("### 🎙️ 2026-08-05 10:00\ndup\n\n### other\nx\n");
  });

  test("returns null when the block is not present (archive purged since)", () => {
    expect(stripArchiveBlock("### other\nx\n", "### gone\ny")).toBeNull();
  });

  test("survives entries appended after the block", () => {
    const archive =
      "### 🎙️ 2026-08-05 10:00\nmine\n\n### 🎙️ 2026-08-05 10:01\nlater\n";
    const out = stripArchiveBlock(archive, "### 🎙️ 2026-08-05 10:00\nmine");
    expect(out).toBe("### 🎙️ 2026-08-05 10:01\nlater\n");
  });
});
