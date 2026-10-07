// Tests for src/lib/listRun.ts — the shared Claude round-trip. sendToClaude
// is mocked; no real call is made.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./commands", () => ({ sendToClaude: vi.fn() }));

import { sendToClaude } from "./commands";
import { displayBody, listText } from "./listFormat";
import { detectListStarts, detectListViaClaude } from "./listRun";

const RAW =
  "Pick up milk on the way home.   \nCall the dentist about moving things.  \nEmail Sam the slides before the meeting";

describe("detectListViaClaude", () => {
  beforeEach(() => {
    vi.mocked(sendToClaude).mockReset();
  });

  test("detects on listText(body): offsets render via displayBody on the shown text", async () => {
    vi.mocked(sendToClaude).mockResolvedValue(
      "Pick up milk\nCall the dentist about\nEmail Sam the slides",
    );
    const starts = await detectListViaClaude(RAW, "haiku");
    expect(starts).toHaveLength(3);
    const prompt = vi.mocked(sendToClaude).mock.calls[0][0];
    expect(prompt.endsWith(listText(RAW))).toBe(true);
    expect(prompt).not.toContain("home.   ");
    expect(
      displayBody(listText(RAW), { starts, show: true }).split("\n"),
    ).toEqual([
      "- Pick up milk on the way home.",
      "- Call the dentist about moving things.",
      "- Email Sam the slides before the meeting",
    ]);
  });

  test("NONE resolves to null", async () => {
    vi.mocked(sendToClaude).mockResolvedValue("NONE");
    expect(await detectListViaClaude(RAW, "haiku")).toBeNull();
  });

  test("a failed Claude call rejects (not recorded as not-a-list)", async () => {
    vi.mocked(sendToClaude).mockImplementation(() =>
      Promise.reject(new Error("boom")),
    );
    await expect(detectListViaClaude(RAW, "haiku")).rejects.toThrow("boom");
  });
});

describe("detectListStarts (rules first, Claude as fallback)", () => {
  beforeEach(() => {
    vi.mocked(sendToClaude).mockReset();
  });

  test("an explicit enumeration is formatted by rules — Claude is NOT called", async () => {
    const note =
      "Three things for tomorrow, one from the car registration, two book flights, three, call mom back.";
    const starts = await detectListStarts(note, "haiku");
    expect(starts).toHaveLength(3);
    expect(sendToClaude).not.toHaveBeenCalled();
  });

  test("ordinals with trailing spaces: rules hit on listText, no Claude call", async () => {
    const note = "First, buy milk today.   \nSecond, call mom back.  ";
    const starts = await detectListStarts(note, "haiku");
    expect(starts).toHaveLength(2);
    expect(sendToClaude).not.toHaveBeenCalled();
  });

  test("a lead-in note with pause line breaks is formatted by rules — no Claude call", async () => {
    const note =
      "A few things for tomorrow.\nRenew the car registration\nbook the flights\ncall mom back";
    expect(await detectListStarts(note, "haiku")).toHaveLength(3);
    expect(sendToClaude).not.toHaveBeenCalled();
  });

  test("falls back to Claude when the rules find nothing", async () => {
    vi.mocked(sendToClaude).mockResolvedValue(
      "Pick up milk\nCall the dentist about\nEmail Sam the slides",
    );
    const starts = await detectListStarts(RAW, "haiku");
    expect(starts).toHaveLength(3);
    expect(sendToClaude).toHaveBeenCalledTimes(1);
  });

  test("a failed Claude fallback rejects", async () => {
    vi.mocked(sendToClaude).mockImplementation(() =>
      Promise.reject(new Error("boom")),
    );
    await expect(detectListStarts(RAW, "haiku")).rejects.toThrow("boom");
  });
});
