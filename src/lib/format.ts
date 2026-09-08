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

// macOS's own modifier display order (System Settings renders ⌃⌥⇧⌘).
const MOD_SYMBOL_ORDER = ["⌃", "⌥", "⇧", "⌘"];

// Splits a combo into the key caps the Settings pane draws — modifiers as
// symbols in macOS order, then the key with its first letter capitalized
// ("option+cmd+space" → ["⌥", "⌘", "Space"]). Unknown tokens are treated as
// the key; a blank/modifier-only combo yields []. Display-only, like
// formatHotkey.
export const hotkeyKeyCaps = (combo: string | undefined): string[] => {
  const mods: string[] = [];
  let key = "";
  for (const raw of (combo ?? "").split("+")) {
    const tok = raw.trim();
    if (!tok) continue;
    const symbol = HOTKEY_MOD_SYMBOLS[tok.toLowerCase()];
    if (symbol) {
      if (!mods.includes(symbol)) mods.push(symbol);
    } else {
      key = tok;
    }
  }
  if (!key) return [];
  mods.sort(
    (a, b) => MOD_SYMBOL_ORDER.indexOf(a) - MOD_SYMBOL_ORDER.indexOf(b),
  );
  return [...mods, `${key[0].toUpperCase()}${key.slice(1)}`];
};

// Same alias table as HOTKEY_MOD_SYMBOLS, but spelled out as the words macOS
// itself uses (System Settings > Keyboard Shortcuts renders combos this
// way) instead of the ⌥⌘ symbols — used for the Settings pane's hotkey text
// INPUTS, where a symbol can't be typed back in. Unlike formatHotkey, this
// never falls back to a default: it's a pure per-token rewrite, so a blank
// override still displays blank (the field's placeholder covers that case).
const HOTKEY_MOD_WORDS: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  super: "cmd",
  meta: "cmd",
  opt: "option",
  option: "option",
  alt: "option",
  ctrl: "control",
  control: "control",
  shift: "shift",
};

export const macHotkeyCombo = (combo: string | undefined): string =>
  (combo ?? "")
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tok) => HOTKEY_MOD_WORDS[tok.toLowerCase()] ?? tok.toLowerCase())
    .join("+");

// ---------------------------------------------------------------------------
// Press-to-record hotkey capture (Settings pane's HotkeyCaptureField)
// ---------------------------------------------------------------------------

// The four physical modifier keys, by their KeyboardEvent.code — a keydown
// on one of these is a "modifier went down" event, never a combo by itself.
const HOTKEY_MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

// The slice of a native KeyboardEvent comboFromKeyEvent needs — deliberately
// narrow (not the whole KeyboardEvent) so it stays trivially testable with
// plain object literals.
export interface HotkeyKeyEvent {
  code: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

// Reads the four modifier flags off any KeyboardEvent-shaped object into the
// Mac-vocabulary word list, in macOS's own display order (⌃⌥⇧⌘ — control,
// option, shift, cmd) regardless of the order the keys were actually
// pressed in. Shared by comboFromKeyEvent (below, for the token order in a
// committed combo) and the Settings pane's live "which modifiers are
// currently held" capture preview.
export const heldHotkeyModifiers = (e: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string[] =>
  [
    e.ctrlKey && "control",
    e.altKey && "option",
    e.shiftKey && "shift",
    e.metaKey && "cmd",
  ].filter((x): x is string => Boolean(x));

// KeyboardEvent.code → the token normalize_combo (src-tauri/src/hotkeys.rs)
// expects for that key: a bare lowercase letter/digit or "space" for the
// keys it special-cases into KeyX/DigitX/Space itself, everything else
// passed through EXACTLY as `code` spells it (F5, Comma, …) — Rust's
// fallback branch stores the token verbatim, uppercase and all.
const hotkeyKeyToken = (code: string): string => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === "Space") return "space";
  return code;
};

// A capture keydown's outcome. `combo` is non-null only when the keystroke
// is ready to commit (a non-modifier key held with at least one modifier);
// `modifierOnly` distinguishes "just a modifier went down" (live-preview
// update, never commits) from a bare non-modifier key pressed alone (needs
// a modifier — combo stays null, but modifierOnly is false so the caller
// can show the "add a modifier" hint instead of silently doing nothing).
export interface ComboCaptureResult {
  combo: string | null;
  modifierOnly: boolean;
}

// Builds a hotkey combo string from a keydown event the way the Settings
// pane's press-to-record fields do — off the event's PHYSICAL key
// (`e.code`), never `e.key` (on macOS, option+V yields `e.key === "√"`,
// useless for a shortcut). Pure and DOM-free so it's unit-testable without
// dispatching real keyboard events.
export const comboFromKeyEvent = (e: HotkeyKeyEvent): ComboCaptureResult => {
  if (HOTKEY_MODIFIER_CODES.has(e.code)) {
    return { combo: null, modifierOnly: true };
  }
  const mods = heldHotkeyModifiers(e);
  if (mods.length === 0) return { combo: null, modifierOnly: false };
  return {
    combo: [...mods, hotkeyKeyToken(e.code)].join("+"),
    modifierOnly: false,
  };
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

// No-Claude-mode title fallback (`.sideline.json`'s `"claude": false`):
// useTriage's generateTitles calls this instead of the Haiku header call —
// same needsTitle gate, same sanitizeTitle cleanup, just the note's own
// first non-empty line standing in for a generated headline.
export const localTitle = (body: string): string =>
  sanitizeTitle(body.split("\n").find((l) => l.trim()) ?? "");

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
