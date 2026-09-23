// Tests for src/lib/reminders.ts's parseReminder — detection, text
// stripping, and due-time computation, exercised against the phrasings
// (including Whisper-style punctuation) the feature is meant to catch.
import { describe, expect, test } from "vitest";
import { parseReminder, reminderId } from "./reminders";

const captured = (h: number, m: number) => new Date(2026, 0, 15, h, m, 0, 0);

describe("parseReminder — relative durations, trigger phrase", () => {
  test("remind me to <task> in N minutes", () => {
    const r = parseReminder(
      "remind me to call my mom in 15 minutes",
      captured(9, 0),
    );
    expect(r?.text).toBe("Call my mom");
    expect(r?.due).toEqual(captured(9, 15));
  });

  test("Whisper-style capitalization and trailing period", () => {
    const r = parseReminder(
      "Remind me to call my mom in 15 minutes.",
      captured(9, 0),
    );
    expect(r?.text).toBe("Call my mom");
    expect(r?.due).toEqual(captured(9, 15));
  });

  test("case-insensitive REMINDER trigger with a colon", () => {
    const r = parseReminder(
      "Reminder: pick up the dry cleaning in 20 mins",
      captured(9, 0),
    );
    expect(r?.text).toBe("Pick up the dry cleaning");
    expect(r?.due).toEqual(captured(9, 20));
  });

  test("digits with hours unit", () => {
    const r = parseReminder(
      "remind me to leave for the airport in 2 hours",
      captured(9, 0),
    );
    expect(r?.text).toBe("Leave for the airport");
    expect(r?.due).toEqual(captured(11, 0));
  });

  test("number word: fifteen", () => {
    const r = parseReminder(
      "remind me to check the oven in fifteen minutes",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 15));
  });

  test("compound number word with hyphen: forty-five", () => {
    const r = parseReminder(
      "remind me to check the oven in forty-five minutes",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 45));
  });

  test("compound number word with a space: forty five", () => {
    const r = parseReminder(
      "remind me to check the oven in forty five minutes",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 45));
  });

  test("in an hour", () => {
    const r = parseReminder(
      "remind me in an hour to check the mail",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(10, 0));
  });

  test("in half an hour", () => {
    const r = parseReminder(
      "remind me to stretch in half an hour",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 30));
  });

  test("in a minute", () => {
    const r = parseReminder(
      "remind me to flip the pancake in a minute",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 1));
  });

  test("in a couple of minutes", () => {
    const r = parseReminder(
      "remind me to check on the kids in a couple of minutes",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 2));
  });

  test("in a couple minutes (no 'of')", () => {
    const r = parseReminder(
      "remind me to check on the kids in a couple minutes",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(9, 2));
  });
});

describe("parseReminder — body starts with a relative time, no trigger phrase", () => {
  test("in 15 minutes I've got to go", () => {
    const r = parseReminder("in 15 minutes I've got to go", captured(9, 0));
    expect(r?.text).toBe("I've got to go");
    expect(r?.due).toEqual(captured(9, 15));
  });

  test("In 20 minutes, alert me then", () => {
    const r = parseReminder("In 20 minutes, alert me then", captured(9, 0));
    expect(r?.due).toEqual(captured(9, 20));
    expect(r?.text).toBe("Alert me then");
  });

  test("a relative time expression NOT at the start is not a trigger by itself", () => {
    const r = parseReminder("I've got to go in 15 minutes", captured(9, 0));
    expect(r).toBeNull();
  });
});

describe("parseReminder — absolute times", () => {
  test("at 3pm, later today", () => {
    const r = parseReminder(
      "remind me to call the dentist at 3pm",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(15, 0));
    expect(r?.text).toBe("Call the dentist");
  });

  test("at 3:30 pm", () => {
    const r = parseReminder(
      "remind me to call the dentist at 3:30 pm",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(15, 30));
  });

  test("at 3 p.m. (spaced, dotted)", () => {
    const r = parseReminder(
      "remind me to call the dentist at 3 p.m.",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(15, 0));
  });

  test("at 15:00 (24h)", () => {
    const r = parseReminder(
      "remind me to call the dentist at 15:00",
      captured(9, 0),
    );
    expect(r?.due).toEqual(captured(15, 0));
  });

  test("at noon", () => {
    const r = parseReminder("remind me to eat at noon", captured(9, 0));
    expect(r?.due).toEqual(captured(12, 0));
  });

  test("a time already passed today rolls to tomorrow", () => {
    const r = parseReminder(
      "remind me to call the dentist at 3pm",
      captured(16, 0),
    );
    expect(r?.due).toEqual(new Date(2026, 0, 16, 15, 0, 0, 0));
  });

  test("a time exactly equal to capturedAt rolls to tomorrow", () => {
    const r = parseReminder(
      "remind me to call the dentist at 3pm",
      captured(15, 0),
    );
    expect(r?.due).toEqual(new Date(2026, 0, 16, 15, 0, 0, 0));
  });

  test("bare 'at 3' with no am/pm picks the sooner ambiguous occurrence (AM)", () => {
    // captured at 2am — 3am is 1h away, 3pm is 13h away.
    const r = parseReminder("remind me to check status at 3", captured(2, 0));
    expect(r?.due).toEqual(captured(3, 0));
  });

  test("bare 'at 3' with no am/pm picks the sooner ambiguous occurrence (PM)", () => {
    // captured at 4am — 3am has passed, 3pm is next (11h away).
    const r = parseReminder("remind me to check status at 3", captured(4, 0));
    expect(r?.due).toEqual(captured(15, 0));
  });
});

describe("parseReminder — no match", () => {
  test("no trigger phrase and no leading relative time", () => {
    expect(
      parseReminder("just a regular note about lunch", captured(9, 0)),
    ).toBeNull();
  });

  test("trigger phrase with no time expression anywhere", () => {
    expect(
      parseReminder("remind me to call my mom", captured(9, 0)),
    ).toBeNull();
  });

  test("empty body", () => {
    expect(parseReminder("", captured(9, 0))).toBeNull();
  });

  test("whitespace-only body", () => {
    expect(parseReminder("   \n  ", captured(9, 0))).toBeNull();
  });
});

describe("parseReminder — text fallback", () => {
  test("stripping the trigger and time phrase to nothing falls back to the trimmed body", () => {
    const r = parseReminder("remind me in 15 minutes", captured(9, 0));
    expect(r?.text).toBe("remind me in 15 minutes");
  });

  test("fallback caps at 120 chars of the first line", () => {
    // Trailing dots are stripped as leading/trailing punctuation by
    // tidyText, so stripping still leaves nothing — this exercises the
    // 120-char cap on the ORIGINAL (unstripped) body used as the fallback.
    const long = `remind me in 15 minutes${".".repeat(200)}`;
    const r = parseReminder(long, captured(9, 0));
    expect(r?.text.length).toBe(120);
    expect(r?.text).toBe(long.slice(0, 120));
  });
});

describe("reminderId", () => {
  test("is the timestamp alone with no icon given", () => {
    expect(reminderId("2026-01-15 09:00")).toBe("2026-01-15 09:00");
  });

  test("is stable across an edited body — same timestamp, same id", () => {
    // An edit to the note's body must resolve to the SAME reminder (so the
    // backend upserts it in place) rather than registering a new one — the
    // id must not depend on the body at all.
    const id1 = reminderId("2026-01-15 09:00");
    const id2 = reminderId("2026-01-15 09:00");
    expect(id1).toBe(id2);
  });

  test("differs when the timestamp changes", () => {
    const id1 = reminderId("2026-01-15 09:00");
    const id2 = reminderId("2026-01-15 09:05");
    expect(id1).not.toBe(id2);
  });

  test("appends the icon only when given, disambiguating same-timestamp notes", () => {
    const withoutIcon = reminderId("2026-01-15 09:00");
    const withIcon = reminderId("2026-01-15 09:00", "🎙️");
    expect(withIcon).not.toBe(withoutIcon);
    expect(reminderId("2026-01-15 09:00", "🎙️")).toBe(
      reminderId("2026-01-15 09:00", "🎙️"),
    );
  });
});
