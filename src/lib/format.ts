// Small string-shaping helpers used by the popover UI — tag/title
// normalization, hotkey display formatting, and batch-triage grouping. No
// Tauri/DOM dependencies, kept out of App.tsx so they're independently
// testable.
import type { Note } from "../inbox";
import type { BatchUnit } from "./batch";

// Mirrors the alias table in src-tauri/src/hotkeys.rs's `normalize_combo` so
// the shortcuts modal previews a configured combo the way the OS will
// actually fire it. Display-only — malformed/missing input just falls back.
export const HOTKEY_MOD_SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
  meta: "⌘",
  opt: "⌥",
  option: "⌥",
  alt: "⌥",
  ctrl: "⌃",
  control: "⌃",
  shift: "⇧",
};

export const formatHotkey = (
  combo: string | undefined,
  fallback: string,
): string => {
  const tokens = (combo ?? "")
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return fallback;
  let mods = "";
  let key = "";
  for (const tok of tokens) {
    const symbol = HOTKEY_MOD_SYMBOLS[tok.toLowerCase()];
    if (symbol) mods += symbol;
    else key = tok;
  }
  if (!key) return fallback;
  return `${mods}${key[0].toUpperCase()}${key.slice(1)}`;
};

// The three built-in quick tags: chips 1-3 on an Inbox card, keys `1`-`3`,
// and the tags the tag editor refuses to offer a pin/delete button for.
// One definition, since every one of those sites has to agree on both the
// membership and the ORDER (the keys index straight into it).
export const QUICK_TAGS = ["bug", "todo", "idea"];

export const sanitizeTag = (raw: string) => {
  let s = raw.trim();
  if (s.startsWith("#")) s = s.slice(1);
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^\w-]/g, "");
  // 24-char cap: long voice-transcript junk gets truncated at creation so
  // the chip row never blows out the 380px popover.
  return s.toLowerCase().slice(0, 24);
};

export const escapeRegex = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A note "longer than ~2 rows" gets a Haiku-generated header at triage —
// short notes ARE their own header. Voice rambles are usually one long
// wrapping line, so char length matters as much as line count (~60 chars
// per rendered row at the popover's width).
export const needsTitle = (body: string) =>
  body.split("\n").filter((l) => l.trim()).length > 2 || body.length > 120;

export const TITLE_PROMPT =
  "For each numbered note below, write a headline of at most 8 words " +
  "capturing what the note is about. Reply with one line per note, " +
  "formatted exactly `<number>: <headline>` — no other text.";

// Strips markdown/quote noise a model might wrap a headline in, and caps
// length so a runaway reply can't blow out the card header.
export const sanitizeTitle = (raw: string) =>
  raw
    .trim()
    .replace(/^[#*"'`\s]+|[*"'`\s]+$/g, "")
    .slice(0, 80);

// Display label for a tag: project tags (routed via `projectTags`) render
// with an `@` prefix instead of `#`, everywhere a tag is shown as text —
// purely cosmetic, the stored/serialized tag string is always `sideline`,
// never `@sideline` or `#sideline`.
export const tagLabel = (tag: string, projectTags: string[]): string =>
  (projectTags.includes(tag) ? "@" : "#") + tag;

// Shared class builder for tag chips — the single source of truth for the
// two-family chip vocabulary: project tags (blue) vs everything else (grey
// outline off, filled amber on) — quick and custom tags share one look by
// design. Every display site (Inbox, Todos project rows, Todos tag-section
// rows, the tag editor's own chips/suggestions) renders a given tag
// identically. See `.tag`/`.tag.project` in styles.css for the actual look.
export const tagChipClass = (
  tag: string,
  active: boolean,
  projectTags: string[],
): string =>
  ["tag", projectTags.includes(tag) && "project", active && "on"]
    .filter(Boolean)
    .join(" ");

// Groups notes for batch triage: consecutive-by-tag units where every note
// sharing a first tag merges into one unit (untagged notes are always
// solo). See `BatchUnit` (./batch) for the merge-vs-solo contract.
export const groupByFirstTag = (notes: Note[]): BatchUnit[] => {
  const units: BatchUnit[] = [];
  const unitIndexByTag = new Map<string, number>();
  for (const note of notes) {
    const tag = note.tags[0] ?? null;
    if (tag === null) {
      units.push({ tag: null, notes: [note] });
      continue;
    }
    const existing = unitIndexByTag.get(tag);
    if (existing !== undefined) {
      units[existing].notes.push(note);
    } else {
      unitIndexByTag.set(tag, units.length);
      units.push({ tag, notes: [note] });
    }
  }
  return units;
};
