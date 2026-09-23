// Pure reminder detection, extracted so it's independently testable (see
// reminders.test.ts). Registration (calling addReminder for a hit) and the
// once-per-note-per-run bookkeeping live in the caller (useInbox.ts), same
// split as autotag.ts's autoTag/reload().
//
// Two ways a note becomes a reminder:
//   1. The body mentions "remind me"/"reminder" AND a time expression
//      (relative or absolute) appears anywhere in it.
//   2. The body STARTS with a relative time expression ("in 15 minutes I've
//      got to go") — no trigger phrase needed.
// Anything else returns null.

export interface ParsedReminder {
  // The body with the trigger phrase and time phrase stripped and tidied.
  // Falls back to the trimmed body (first line, capped at 120 chars) if
  // stripping leaves nothing.
  text: string;
  due: Date;
}

const ONES = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["twenty", "thirty", "forty", "fifty"];

const NUMBER_WORDS: Record<string, number> = { zero: 0, sixty: 60 };
ONES.forEach((w, i) => {
  NUMBER_WORDS[w] = i + 1;
});
TEENS.forEach((w, i) => {
  NUMBER_WORDS[w] = i + 10;
});
TENS.forEach((w, i) => {
  NUMBER_WORDS[w] = (i + 2) * 10;
});

// "twenty-one" / "twenty one" .. "fifty-nine" — the only compounds one-to-
// sixty needs (a single tens word, or a single tens+ones word, covers it).
const COMPOUND_NUMBER_RE = `(?:${TENS.join("|")})[\\s-](?:${ONES.join("|")})`;
const NUMBER_WORD_ALTERNATION = [...ONES, ...TEENS, ...TENS, "sixty"].join("|");
const NUMBER_WORD_RE = `(?:${COMPOUND_NUMBER_RE}|${NUMBER_WORD_ALTERNATION})`;

// Converts a matched number token (digits, a single number word, or a
// tens+ones compound) into its integer value. Only ever called on strings
// RELATIVE_NUMBER_RE already matched, so every branch is guaranteed valid.
function wordToNumber(phrase: string): number {
  const normalized = phrase
    .toLowerCase()
    .replace(/[\s-]+/g, " ")
    .trim();
  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
  const parts = normalized.split(" ");
  if (parts.length === 1) return NUMBER_WORDS[parts[0]] ?? 0;
  const [tens, ones] = parts;
  return (NUMBER_WORDS[tens] ?? 0) + (NUMBER_WORDS[ones] ?? 0);
}

const RELATIVE_NUMBER_RE = new RegExp(
  `\\bin\\s+(\\d{1,3}|${NUMBER_WORD_RE})\\s+(hours?|hrs?|minutes?|mins?)\\b`,
  "i",
);

interface RelativeMatch {
  kind: "relative";
  index: number;
  length: number;
  minutes: number;
}

interface AbsoluteMatch {
  kind: "absolute";
  index: number;
  length: number;
  compute: (capturedAt: Date) => Date;
}

type TimeMatch = RelativeMatch | AbsoluteMatch;

// Finds the first relative duration expression ("in 15 minutes", "in an
// hour", "in half an hour", "in a minute", "in a couple minutes", "in
// forty-five mins", ...) anywhere in `text`. The special fixed phrases are
// checked first since they don't fit the generic "N unit" shape.
function findRelativeMinutes(text: string): RelativeMatch | null {
  const half = text.match(/\bin\s+half\s+an?\s+hour\b/i);
  if (half)
    return {
      kind: "relative",
      index: half.index ?? 0,
      length: half[0].length,
      minutes: 30,
    };

  const hour = text.match(/\bin\s+an?\s+hour\b/i);
  if (hour)
    return {
      kind: "relative",
      index: hour.index ?? 0,
      length: hour[0].length,
      minutes: 60,
    };

  const couple = text.match(/\bin\s+a\s+couple\s+(?:of\s+)?minutes?\b/i);
  if (couple)
    return {
      kind: "relative",
      index: couple.index ?? 0,
      length: couple[0].length,
      minutes: 2,
    };

  const minute = text.match(/\bin\s+an?\s+minute\b/i);
  if (minute)
    return {
      kind: "relative",
      index: minute.index ?? 0,
      length: minute[0].length,
      minutes: 1,
    };

  const m = text.match(RELATIVE_NUMBER_RE);
  if (!m) return null;
  const n = wordToNumber(m[1]);
  const isHours = /^h/i.test(m[2]);
  return {
    kind: "relative",
    index: m.index ?? 0,
    length: m[0].length,
    minutes: isHours ? n * 60 : n,
  };
}

// Rolls `hour:minute` (24h) forward to the next occurrence after
// `capturedAt` — today if that time hasn't passed yet, tomorrow otherwise
// ("already ≤ capturedAt" rolls, matching the spec's tie-breaking).
function nextOccurrence(capturedAt: Date, hour: number, minute: number): Date {
  const d = new Date(capturedAt);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= capturedAt.getTime()) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// A bare hour with no am/pm ("at 3", "at 3:30") is ambiguous between AM and
// PM — pick whichever of the two 12h-apart candidates comes next after
// capturedAt (always within 12h of it, since that's how far apart they are).
function nearestAmbiguousOccurrence(
  capturedAt: Date,
  hour12: number,
  minute: number,
): Date {
  const amHour = hour12 % 12;
  const pmHour = amHour + 12;
  const amCandidate = nextOccurrence(capturedAt, amHour, minute);
  const pmCandidate = nextOccurrence(capturedAt, pmHour, minute);
  return amCandidate.getTime() <= pmCandidate.getTime()
    ? amCandidate
    : pmCandidate;
}

// Finds the first absolute time expression ("at 3pm", "at 3:30 pm", "at 3
// p.m.", "at 15:00", "at noon", "at midnight", or a bare "at 3") anywhere in
// `text`. No trailing `\b` on the main pattern: "p.m." ends on a `.`, and
// `\b` never matches between two non-word characters.
function findAbsoluteTime(text: string): AbsoluteMatch | null {
  const noon = text.match(/\bat\s+noon\b/i);
  if (noon)
    return {
      kind: "absolute",
      index: noon.index ?? 0,
      length: noon[0].length,
      compute: (c) => nextOccurrence(c, 12, 0),
    };

  const midnight = text.match(/\bat\s+midnight\b/i);
  if (midnight)
    return {
      kind: "absolute",
      index: midnight.index ?? 0,
      length: midnight[0].length,
      compute: (c) => nextOccurrence(c, 0, 0),
    };

  const m = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour > 23 || minute > 59) return null;
  const meridiem = m[3]?.toLowerCase().replace(/\./g, "");

  return {
    kind: "absolute",
    index: m.index ?? 0,
    length: m[0].length,
    compute: (capturedAt) => {
      if (meridiem === "am" || meridiem === "pm") {
        const h24 = (hour % 12) + (meridiem === "pm" ? 12 : 0);
        return nextOccurrence(capturedAt, h24, minute);
      }
      if (hour >= 13 || hour === 0) {
        return nextOccurrence(capturedAt, hour, minute);
      }
      return nearestAmbiguousOccurrence(capturedAt, hour, minute);
    },
  };
}

const TRIGGER_RE = /\b(remind me|reminder)\b[:,]?\s*(?:to\s+)?/i;

function stripSpans(
  text: string,
  spans: Array<{ index: number; length: number }>,
): string {
  // Removing highest-index spans first keeps every earlier span's index
  // valid for the next iteration — nothing before it has shifted yet.
  const sorted = [...spans].sort((a, b) => b.index - a.index);
  let result = text;
  for (const { index, length } of sorted) {
    result = result.slice(0, index) + result.slice(index + length);
  }
  return result;
}

function tidyText(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;\-–—]+/, "")
    .replace(/[\s,.:;\-–—]+$/, "")
    .trim();
  if (!cleaned) return "";
  return cleaned[0].toUpperCase() + cleaned.slice(1);
}

function fallbackText(body: string): string {
  const firstLine = (body.split("\n")[0] ?? "").trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine;
}

export function parseReminder(
  body: string,
  capturedAt: Date,
): ParsedReminder | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const triggerMatch = trimmed.match(TRIGGER_RE);
  const relative = findRelativeMinutes(trimmed);
  const absolute = relative ? null : findAbsoluteTime(trimmed);
  const timeExpr: TimeMatch | null = relative ?? absolute;

  const hasTriggerWithTime = triggerMatch !== null && timeExpr !== null;
  const startsWithRelative = relative !== null && relative.index === 0;
  if (!hasTriggerWithTime && !startsWithRelative) return null;

  // Non-null: timeExpr is set whenever either branch above is true
  // (startsWithRelative implies relative — and thus timeExpr — is set).
  const chosen = timeExpr!;
  const due =
    chosen.kind === "relative"
      ? new Date(capturedAt.getTime() + chosen.minutes * 60_000)
      : chosen.compute(capturedAt);

  const spans = [{ index: chosen.index, length: chosen.length }];
  if (triggerMatch?.index !== undefined) {
    spans.push({ index: triggerMatch.index, length: triggerMatch[0].length });
  }
  const stripped = tidyText(stripSpans(trimmed, spans));
  return { text: stripped || fallbackText(trimmed), due };
}

// Stable id for a note's detected reminder: the note's own timestamp, which
// is what makes re-scanning the SAME note (every inbox reload) — even after
// it's been EDITED — resolve to the same reminder, so an edit updates that
// reminder in place (see reminders.rs's upsert) instead of registering a
// second one. `icon` disambiguates the rare case of two notes sharing a
// timestamp (multiple notes captured in the same minute) — pass it only
// when the caller has found that collision; omit it otherwise so the
// common case's id is just the timestamp.
export function reminderId(noteTimestamp: string, icon?: string): string {
  return icon ? `${noteTimestamp}-${icon}` : noteTimestamp;
}
