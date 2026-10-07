// Spoken-list display layer. A long voice note that is really a list of
// separate items can be SHOWN as bullets, but the note's text on disk is
// never touched: the only thing stored is a sidecar of split offsets
// (`~/notes/.sideline-lists.json`, see docs/data-model.md). The model only
// says WHERE each item starts (its first few words, copied verbatim);
// Sideline builds the bullets from the user's own words, and `validateList`
// proves no word was lost or reworded (only connector words like "and then"
// may drop). Any failure means the note simply shows as plain text.
//
// Pure logic only — the Claude call, the sidecar IO and the once-per-session
// bookkeeping live in useInbox.ts / useLists.ts.
import { splitBodyImages, splitTodoReply } from "../inbox";
import { needsTitle } from "./format";

// One note's sidecar record. `starts` are char offsets into the note's raw
// body where each list item begins; `starts: null` means "checked, not a
// list" so the note is never sent again. `show` is the per-note view toggle.
export interface ListEntry {
  starts: number[] | null;
  show: boolean;
}

// Words that join spoken list items.
export const CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  "and",
  "then",
  "also",
]);

// Spoken sequencing words ("First, … Second, …") the model often leaves out
// of an item's start phrase, so they would otherwise trail the previous item.
export const ORDINAL_WORDS: ReadonlySet<string> = new Set([
  "first",
  "firstly",
  "second",
  "secondly",
  "third",
  "thirdly",
  "fourth",
  "fifth",
  "next",
  "lastly",
  "finally",
]);

// Spoken counting markers ("one, …, two, …", "number one"). Only ever
// dropped as enumeration labels (see TRAILING_MARKER / rulesStarts).
const CARDINALS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

// The only words the validator lets a bullet drop relative to the original
// text: connectors, ordinals and enumeration markers (cardinals, "number").
const SKIPPABLE_WORDS: ReadonlySet<string> = new Set([
  ...CONNECTOR_WORDS,
  ...ORDINAL_WORDS,
  ...CARDINALS,
  "number",
  "bullet",
  "point",
]);

const WORD = /[\p{L}\p{N}'’]+/gu;

interface Token {
  word: string;
  offset: number;
}

// Lowercased words with their char offsets. The curly apostrophe is folded
// to a straight one so "don’t" and "don't" compare equal. Punctuation is not
// a token, so whisper's commas never matter.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    tokens.push({
      word: m[0].toLowerCase().replace(/’/g, "'"),
      offset: m.index,
    });
  }
  return tokens;
}

// FNV-1a over the body's UTF-8 bytes, 8 hex digits. Not cryptographic — it
// only has to make "this timestamp, edited body" stop matching a stale entry.
function fnv1a32hex(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Sidecar key. Uses the note's raw body: an inbox `timestamp`, a triaged
// note's `captured` and a todo's `timestamp` are the same string, and triage
// copies the body verbatim, so the key survives triage. An edited body gets
// a new key (the old entry just stops matching).
export const listKey = (timestamp: string, body: string): string =>
  `${timestamp}|${fnv1a32hex(body)}`;

// Same "long enough to bother" rule as headers, and never for notes with
// screenshots (their display goes through splitBodyImages instead).
export const needsListCheck = (body: string): boolean =>
  needsTitle(body) && splitBodyImages(body).images.length === 0;

export const LIST_PROMPT =
  "Below is a voice note. Decide whether it is a list of separate items " +
  "(tasks, ideas, points or steps). If it is not, reply exactly `NONE`. " +
  "If it is, reply with one line per item, in the order spoken, where each " +
  "line is the first 3 to 6 words of that item copied EXACTLY from the note " +
  "(verbatim, no paraphrasing, no numbering or bullets), including the " +
  "first item. There must be at least 2 items. No other text.";

export const buildListPrompt = (body: string): string =>
  `${LIST_PROMPT}\n\nNote:\n${body}`;

// Parses the model's reply into item start phrases. `NONE`, or fewer than 2
// usable lines, is null. Leading bullets / numbering / quotes are stripped
// defensively even though the prompt forbids them, and a first line ending
// in ":" ("Here are the items:") is model preamble, not an item.
export function parseListReply(reply: string): string[] | null {
  const trimmed = reply.trim();
  if (/^none\.?$/i.test(trimmed)) return null;
  const lines = trimmed
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "")
        .replace(/^["'“‘`]+|["'”’`]+$/g, "")
        .trim(),
    )
    .filter((l) => l !== "");
  if (lines.length > 0 && lines[0].endsWith(":")) lines.shift();
  return lines.length >= 2 ? lines : null;
}

// Finds where each phrase starts in the body, in order. Phrases match as
// word sequences (case and punctuation insensitive), each strictly after
// the previous match, and only at a word boundary: the character before the
// first word must be the start of the text or whitespace, so "5 pounds"
// never matches inside "2.5 pounds" nor "one" inside "plus-one". Returns
// char offsets, or null when anything is doubtful: a phrase under 2 words
// (too weak to anchor on), a phrase that isn't found, a phrase that matches
// more than once in the remaining text (ambiguous — we can't tell which
// the model meant), or fewer than 2 phrases.
export function findStarts(body: string, phrases: string[]): number[] | null {
  const tokens = tokenize(body);
  const starts: number[] = [];
  let from = 0;
  for (const phrase of phrases) {
    const words = tokenize(phrase).map((t) => t.word);
    if (words.length < 2) return null;
    const matches: number[] = [];
    for (let i = from; i + words.length <= tokens.length; i++) {
      if (!words.every((w, k) => tokens[i + k].word === w)) continue;
      const before = tokens[i].offset === 0 ? "" : body[tokens[i].offset - 1];
      if (before === "" || /\s/.test(before)) matches.push(i);
    }
    if (matches.length !== 1) return null;
    starts.push(tokens[matches[0]].offset);
    from = matches[0] + words.length;
  }
  return starts.length >= 2 ? starts : null;
}

export interface BuiltList {
  lead: string;
  items: string[];
}

const ORDINAL_ALT = [...ORDINAL_WORDS]
  .sort((x, y) => y.length - x.length)
  .join("|");

// A leading connector run ("and then also") only counts when the connector
// is a whole word: followed by whitespace, a comma, or the end — so "And-or"
// stays intact.
const LEADING_CONNECTOR =
  /^(?:and then also|and then|and also|and|also|then)(?=[\s,]|$)[\s,]*/i;
// A leading ordinal only counts with a comma/colon right after it
// ("First, renew…"); "First thing tomorrow, …" is content.
const LEADING_ORDINAL = new RegExp(`^(?:${ORDINAL_ALT})\\s*[,:]\\s*`, "i");
const CARDINAL_ALT = [...CARDINALS]
  .sort((x, y) => y.length - x.length)
  .join("|");
// A trailing enumeration marker is the NEXT item's label ("…before Friday.
// Second", "…for tomorrow, one", "…flights, number three"): an ordinal,
// cardinal one–ten or "number <cardinal>", only when it follows punctuation +
// whitespace (optionally + "and"/"and then", mirroring rulesStarts) or is the
// whole text, and nothing but `,`/`:` follows. The
// punctuation stays here (a period survives; a comma is removed by the comma
// cleanup).
const TRAILING_MARKER = new RegExp(
  `(^|[.,;:!?]\\s+)(?:and\\s+(?:then\\s+)?)?(?:number\\s+(?:${CARDINAL_ALT})|${ORDINAL_ALT}|${CARDINAL_ALT})\\s*[,:]?\\s*$`,
  "i",
);
// "… back and number three," — a "number N" label after a bare "and"
// (AND_NUMBER_RE in signalStarts), stripped with its "and".
const TRAILING_AND_NUMBER = new RegExp(
  `\\s+and\\s+(?:then\\s+)?number\\s+(?:${CARDINAL_ALT})\\s*[,:]?\\s*$`,
  "i",
);
// The spoken "bullet" / "bullet point" keyword left at the end of the
// previous slice (bulletStarts points each item just past its keyword), with
// any punctuation that came with it.
const TRAILING_BULLET = /\bbullet(?:\s+point)?\b[\s,.:;]*$/i;
// A trailing run of connector words, anchored at a word start.
const TRAILING_CONNECTOR_RUN =
  /(?:^|[\s,;])((?:(?:and|then|also)(?:[\s,;]+|$))+)$/i;

function stripLeadingGlue(text: string): string {
  let s = text;
  for (;;) {
    const next = s.replace(LEADING_ORDINAL, "").replace(LEADING_CONNECTOR, "");
    if (next === s) return s;
    s = next;
  }
}

// Drops trailing glue: commas/spaces, an enumeration marker after punctuation,
// and a connector run (`…the slides, and also` → `…the slides`). A connector
// run is only glue if it contains "and" or follows a comma, so "finish the
// slides by then" keeps its "then". Sentence punctuation stays.
function stripTrailingGlue(text: string): string {
  let s = text;
  for (;;) {
    let next = s
      .replace(/[\s,;]+$/, "")
      .replace(TRAILING_MARKER, "$1")
      .replace(TRAILING_AND_NUMBER, "")
      .replace(TRAILING_BULLET, "");
    const m = TRAILING_CONNECTOR_RUN.exec(next);
    if (m) {
      const run = m[1];
      const before = next.slice(0, next.length - run.length);
      const body = before.replace(/[\s,;]+$/, "");
      if (/\band\b/i.test(run) || /,\s*$/.test(before)) next = body;
    }
    if (next === s) return s;
    s = next;
  }
}

const capitalize = (s: string) =>
  s === "" ? s : s[0].toUpperCase() + s.slice(1);

// Builds the displayed pieces from the user's own words: the text before the
// first start is the lead, the slices between starts are the items. Spoken
// glue ("and then", "First,", trailing ", and") is trimmed off each item. Line breaks
// inside an item fold to a space so a bullet stays one line.
export function buildList(body: string, starts: number[]): BuiltList {
  const lead = stripTrailingGlue(body.slice(0, starts[0]).trim());
  const items = starts.map((start, i) => {
    const slice = body
      .slice(start, i + 1 < starts.length ? starts[i + 1] : undefined)
      .trim()
      .replace(/\s*\n\s*/g, " ");
    const trimmed = stripTrailingGlue(stripLeadingGlue(slice));
    return capitalize(trimmed);
  });
  return { lead, items };
}

// The "nothing lost, nothing reworded" proof: every word of the rendered
// lead + items must be the next word of the original, and an original word
// may be skipped only if it is a connector or ordinal. Any leftover other
// original word (a lost item) also fails, as does an item with no word in it.
export function validateList(body: string, built: BuiltList): boolean {
  if (
    built.items.length < 2 ||
    built.items.some((it) => tokenize(it).length === 0)
  ) {
    return false;
  }
  const original = tokenize(body).map((t) => t.word);
  const rendered = tokenize([built.lead, ...built.items].join("\n")).map(
    (t) => t.word,
  );
  let i = 0;
  for (const word of rendered) {
    while (i < original.length && original[i] !== word) {
      if (!SKIPPABLE_WORDS.has(original[i])) return false;
      i++;
    }
    if (i >= original.length) return false;
    i++;
  }
  return original.slice(i).every((w) => SKIPPABLE_WORDS.has(w));
}

export const renderList = (built: BuiltList): string =>
  (built.lead ? `${built.lead}\n` : "") +
  built.items.map((it) => `- ${it}`).join("\n");

// Rules-based fast path for EXPLICIT enumerations — no Claude call. Finds
// an in-order marker chain starting at 1, consecutive, from ONE family:
// ordinals (first, second, …; ≥2 markers), "number one", "number two", …
// (≥2), or bare cardinals one, two, … (≥3 — stricter, "one"/"two" are common
// words). A marker counts only as a whole word at the start of the text, of
// a line, or right after `[.,;:!?]` + whitespace (optionally + "and" /
// "and then": "…milk, and number two"), so "I have one idea and two
// questions" never matches. Anything ambiguous (a marker word that could
// be this chain's in more than one place, or two families both matching) is
// null: the caller falls back to Claude, or plain text. Each start points at
// the first word AFTER the marker and its optional `,`/`:`; the marker is
// left as the tail of the previous item / the lead, where buildList strips it.
const ORDINAL_FAMILY = [
  ["first", "firstly"],
  ["second", "secondly"],
  ["third", "thirdly"],
  ["fourth"],
  ["fifth"],
];
const NUMBER_FAMILY = CARDINALS.map((c) => [`number\\s+${c}`]);
const CARDINAL_FAMILY = CARDINALS.map((c) => [c]);
// Speech mixes families ("First, … Second, … Three, …"), so a chain may
// also switch families at any step — any marker meaning n counts at step n.
// Held to the bare-cardinal bar (≥3 markers) since it admits bare cardinals.
const MIXED_FAMILY = CARDINALS.map((c, i) => [
  ...(ORDINAL_FAMILY[i] ?? []),
  `number\\s+${c}`,
  c,
]);

function markerChain(
  text: string,
  family: string[][],
  min: number,
): number[] | null {
  const ends: number[] = [];
  let pos = 0;
  for (const alts of family) {
    const re = new RegExp(
      `(?:^|\\s*\\n\\s*|[.,;:!?]\\s+(?:and\\s+(?:then\\s+)?)?)(${alts.join("|")})(?=[\\s,:]|$)`,
      "gi",
    );
    const found = [...text.matchAll(re)]
      .map((m) => m.index + m[0].length)
      .filter((end) => end > pos);
    if (found.length === 0) break;
    if (found.length > 1) return null;
    ends.push(found[0]);
    pos = found[0];
  }
  if (ends.length < min) return null;
  const starts: number[] = [];
  for (const end of ends) {
    const start =
      end + (/^\s*[,:]?\s*/.exec(text.slice(end)) as RegExpExecArray)[0].length;
    if (!/^[\p{L}\p{N}]/u.test(text.slice(start))) return null;
    starts.push(start);
  }
  return starts;
}

// A first sentence that announces a list without numbering it: "a few
// things for tomorrow", "some things I noticed", "three ideas", "here's what
// I need". The `n` group captures a stated count. Mirrors LEAD_IN_RE in
// src-tauri/src/listrules.rs.
const LEAD_IN_RE =
  /\b(?:(?:a\s+)?few|(?:a\s+)?couple(?:\s+of)?|some|several|a\s+bunch\s+of|a\s+handful\s+of|(?<n>two|three|four|five|six|seven|eight|nine|ten|[2-9]|10))\s+(?:more\s+|other\s+|quick\s+|small\s+|big\s+|different\s+)?(?:things|items|ideas|tasks|to-?dos|notes|points|issues|bugs|changes|fixes|questions|reminders|errands|steps|thoughts)\b|\b(?:to-?do list|here'?s what|here'?s my list)\b/i;

// Index just past the first sentence end (`[.!?:]` + whitespace or end of
// text) at or after `from`, or -1.
function sentenceEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (!".!?:".includes(s[i])) continue;
    const next = s[i + 1];
    if (next === undefined || /\s/.test(next)) return i + 1;
  }
  return -1;
}

// The first sentence of the first line — where a lead-in must sit.
function leadInRegion(line0: string): string {
  const end = sentenceEnd(line0, 0);
  return line0.slice(0, end === -1 ? line0.length : end);
}

// Whether the note's first sentence announces a list ("a few things for
// tomorrow…") — the autoListPlan hook for short notes the rules can't split.
export function hasLeadIn(text: string): boolean {
  return LEAD_IN_RE.test(leadInRegion(text.split("\n", 1)[0]));
}

// Start offset (first non-whitespace char) of `seg`, which begins at `base`
// in the text; null when the segment is blank.
function chunkStart(seg: string, base: number): number | null {
  return seg.trim() === ""
    ? null
    : base + (seg.length - seg.trimStart().length);
}

// Item starts for an UNNUMBERED list announced by a lead-in. Port of
// `lead_in_list` in src-tauri/src/listrules.rs: the first sentence must match
// LEAD_IN_RE; the lead clause runs to the first `,;:.!?` after the lead-in
// (anything after it on that line is the first item). Items come from the
// line breaks in the text (each non-blank line is an item) or a
// stated count ("three things…" followed by exactly three sentences). With a
// stated count only a split yielding exactly that many items qualifies;
// without one, at least two lines. Offsets index `text`, so
// buildList/validateList/displayBody work unchanged (lead = text before the
// first start).
export function leadInStarts(text: string): number[] | null {
  const nl = text.indexOf("\n");
  const line0 = nl === -1 ? text : text.slice(0, nl);
  const m = LEAD_IN_RE.exec(leadInRegion(line0));
  if (!m) return null;
  const leadInEnd = m.index + m[0].length;
  const n = m.groups?.n?.toLowerCase();
  const count =
    n === undefined
      ? undefined
      : /^\d+$/.test(n)
        ? Number.parseInt(n, 10)
        : CARDINALS.indexOf(n as (typeof CARDINALS)[number]) + 1;
  const punct = line0.slice(leadInEnd).search(/[,;:.!?]/);
  const firstRestAt = punct === -1 ? line0.length : leadInEnd + punct + 1;

  const chunks: number[] = [];
  const first = chunkStart(line0.slice(firstRestAt), firstRestAt);
  if (first !== null) chunks.push(first);
  if (nl !== -1) {
    let base = nl + 1;
    for (const line of text.slice(base).split("\n")) {
      const at = chunkStart(line, base);
      if (at !== null) chunks.push(at);
      base += line.length + 1;
    }
  }

  if (count === undefined) return chunks.length >= 2 ? chunks : null;
  if (chunks.length === count) return chunks;
  if (chunks.length === 0) return null;
  // Stated count that the lines don't match: split everything after
  // the lead clause into sentences instead.
  const sents: number[] = [];
  let from = chunks[0];
  for (;;) {
    const end = sentenceEnd(text, from);
    if (end === -1) break;
    const at = chunkStart(text.slice(from, end), from);
    if (at !== null) sents.push(at);
    from = end;
  }
  const last = chunkStart(text.slice(from), from);
  if (last !== null) sents.push(last);
  return sents.length === count ? sents : null;
}

// The spoken item keyword: "bullet" (or "bullet point") before each item.
// It never occurred in 170 scanned voice notes, so it can't split a note by
// accident; "bulletin" is not the keyword. At least two of them make a list:
// the text before the first is the lead, each item starts just past its
// keyword (which buildList then strips from the end of the previous slice).
// Mirrors BULLET_RE / bullet_list in src-tauri/src/listrules.rs.
const BULLET_RE = /\bbullet(?:\s+point)?\b[\s,.:;]*/gi;

export function bulletStarts(text: string): number[] | null {
  const hits = [...text.matchAll(BULLET_RE)];
  if (hits.length < 2) return null;
  return hits.map((m) => m.index + m[0].length);
}

// The union rule: after a lead-in, ANY mix of item signals starts an item —
// the "bullet" keyword, a counting word + `,`/`:` at a clause start ("One,
// …", "first: …"), and the speaker's own glue (a sentence opening with
// "Also" / "And also" / "And then also" / "Another thing" / "One more thing"
// / "On top of that" / "Plus,", or a mid-sentence "and also" / "and then
// also"). Port of `signal_list` in src-tauri/src/listrules.rs: "A few things
// for tomorrow. One, let's find a new cat and also find a new insurance
// provider. Bullet, take out the garbage." has three items. The lead clause
// is leadInStarts' (to the first `,;:.!?` after the lead-in); at least two
// items. `requireExplicit` (dictation, where pasted text can't be switched
// back) also demands one explicit signal (a bullet or counting word) so glue
// alone never splits a paste; notes pass false. Bare "and then" and plain
// sentence boundaries never cut. Cuts for glue start AT the glue phrase
// (buildList strips also / and also / and then also itself; "Another thing"
// and the rest stay as spoken); explicit signals start the item just past
// the marker, which buildList strips from the tail of the previous slice.
// Deviation from the Rust regexes: glue words end at a real word boundary
// (`also-ran` is not "also").
const NUM_WORDS = CARDINALS.join("|");
const MARKER_ITEM_RE = new RegExp(
  `(?:^\\s*|[.,;:!?]\\s+(?:and\\s+(?:then\\s+)?)?)(?<w>(?:number\\s+)?(?:${NUM_WORDS})|first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth)\\s*[,:]\\s*`,
  "gi",
);
// "… and number three, …": a "number N" label is explicit enough to start
// an item after a bare "and", with no comma before it.
const AND_NUMBER_RE = new RegExp(
  `\\sand\\s+(?:then\\s+)?(?<w>number\\s+(?:${NUM_WORDS}))\\s*[,:]\\s*`,
  "gi",
);
const WB = "(?![\\p{L}\\p{N}'’-])";
const SENTENCE_GLUE_RE = new RegExp(
  `(?:^\\s*|[.!?]\\s+)(?<w>(?:and\\s+(?:then\\s+)?)?also${WB}|another\\s+thing${WB}|one\\s+more\\s+thing${WB}|on\\s+top\\s+of\\s+that${WB}|plus,)`,
  "giu",
);
const MID_GLUE_RE = new RegExp(
  `[\\s,](?<w>and\\s+(?:then\\s+)?also${WB})`,
  "giu",
);

export function signalStarts(
  text: string,
  requireExplicit = false,
): number[] | null {
  const end = sentenceEnd(text, 0);
  const lead = LEAD_IN_RE.exec(text.slice(0, end === -1 ? text.length : end));
  if (!lead) return null;
  const leadInEnd = lead.index + lead[0].length;
  const n = lead.groups?.n?.toLowerCase();
  const count =
    n === undefined
      ? undefined
      : /^\d+$/.test(n)
        ? Number.parseInt(n, 10)
        : CARDINALS.indexOf(n as (typeof CARDINALS)[number]) + 1;
  const punct = text.slice(leadInEnd).search(/[,;:.!?]/);
  const clauseEnd = punct === -1 ? text.length : leadInEnd + punct + 1;
  const rest = text.slice(clauseEnd);

  // [cut, itemStart, explicit], offsets into `rest`.
  const cuts: [number, number, boolean][] = [];
  const wordAt = (m: RegExpMatchArray) =>
    (m.index ?? 0) + m[0].indexOf(m.groups?.w ?? "");
  for (const re of [MARKER_ITEM_RE, AND_NUMBER_RE]) {
    for (const m of rest.matchAll(re)) {
      cuts.push([wordAt(m), m.index + m[0].length, true]);
    }
  }
  for (const m of rest.matchAll(BULLET_RE)) {
    cuts.push([m.index, m.index + m[0].length, true]);
  }
  for (const re of [SENTENCE_GLUE_RE, MID_GLUE_RE]) {
    for (const m of rest.matchAll(re)) {
      const at = m.index + m[0].length - (m.groups?.w.length ?? 0);
      cuts.push([at, at, false]);
    }
  }
  cuts.sort((x, y) => x[0] - y[0] || x[1] - y[1] || +x[2] - +y[2]);

  const hasWords = (t: string) => tokenize(t).length > 0;
  const froms: number[] = [];
  let explicit = false;
  let from = 0;
  let prevEnd = 0;
  for (const [cut, start, isExplicit] of cuts) {
    if (cut < prevEnd) continue; // inside a signal already taken
    if (hasWords(rest.slice(from, cut))) froms.push(from);
    explicit ||= isExplicit;
    from = start;
    prevEnd = Math.max(start, cut + 1);
  }
  if (hasWords(rest.slice(from))) froms.push(from);
  const starts = froms
    .map((f) => chunkStart(rest.slice(f), clauseEnd + f))
    .filter((i): i is number => i !== null);
  // A stated count ("three things …") must match exactly.
  if (starts.length < 2 || (requireExplicit && !explicit)) return null;
  if (count !== undefined && count !== starts.length) return null;
  return starts;
}

export function rulesStarts(text: string): number[] | null {
  // The spoken "bullet" keyword is the most explicit signal: it wins.
  const bullets = bulletStarts(text);
  if (bullets) return bullets;
  // A 3+ chain that switches families beats any shorter single-family one
  // (which would stop at the switch); a single-family 3+ chain is found by
  // this too, with the same starts.
  const mixed = markerChain(text, MIXED_FAMILY, 3);
  if (mixed) return mixed;
  const hits = [
    markerChain(text, ORDINAL_FAMILY, 2),
    markerChain(text, NUMBER_FAMILY, 2),
    markerChain(text, CARDINAL_FAMILY, 3),
  ].filter((h): h is number[] => h !== null);
  // Explicit markers win; a lead-in announced list is the fallback.
  return hits.length === 1
    ? hits[0]
    : (leadInStarts(text) ?? signalStarts(text, false));
}

// rulesStarts on the shown text of a stored body, kept only if the result
// passes the same no-word-lost proof as any other split. Offsets index
// `listText(body)`, like everything else.
export function rulesDetect(body: string): number[] | null {
  const text = listText(body);
  const starts = rulesStarts(text);
  if (!starts) return null;
  return validateList(text, buildList(text, starts)) ? starts : null;
}

// What the automatic pass does with a new note: skip it (it has
// screenshots, or is short and not an explicit enumeration), apply the
// instant rules result, or hand it to Claude (long enough per needsListCheck
// and the rules found nothing). Short notes can still be rule-formatted:
// "Three things for tomorrow, one …, two …, three …" is under the length gate.
export type AutoListPlan = { starts: number[] } | "claude" | "skip";

export function autoListPlan(body: string): AutoListPlan {
  if (splitBodyImages(body).images.length > 0) return "skip";
  const starts = rulesDetect(body);
  if (starts) return { starts };
  // A short note that announces a list ("a few things for tomorrow…") still
  // gets the Claude background check when the rules couldn't split it.
  return needsListCheck(body) || hasLeadIn(listText(body)) ? "claude" : "skip";
}

// The whole reply → offsets pipeline shared by the auto-formatter and the
// `l` key: parse, locate, build, validate. null = not a list (or anything
// failed the proof), so the caller records "checked, not a list".
export function startsFromReply(body: string, reply: string): number[] | null {
  const phrases = parseListReply(reply);
  if (!phrases) return null;
  const starts = findStarts(body, phrases);
  if (!starts) return null;
  return validateList(body, buildList(body, starts)) ? starts : null;
}

// What the `l` key does for a note's current entry: flip a stored list,
// otherwise detect — including for a checked "not a list" (`starts: null`),
// since pressing `l` is an explicit request to look again. Detection tries
// the rules first (instant, no Claude), then Claude if it's on.
export type ToggleAction = "flip" | "detect";

export function toggleAction(entry: ListEntry | undefined): ToggleAction {
  return entry?.starts ? "flip" : "detect";
}

// What a card shows / copy copies. Plain body unless the note has stored
// starts and `show` is on; stored offsets are re-validated against the body
// every time, so a stale or hand-edited sidecar can only ever fall back to
// the plain text.
export function displayBody(
  body: string,
  entry: ListEntry | undefined,
): string {
  if (!entry?.starts || !entry.show) return body;
  const { starts } = entry;
  const ok = starts.every(
    (s, i) =>
      Number.isInteger(s) &&
      s >= 0 &&
      s < body.length &&
      (i === 0 || s > starts[i - 1]),
  );
  if (!ok || starts.length < 2) return body;
  const built = buildList(body, starts);
  return validateList(body, built) ? renderList(built) : body;
}

// The text a card shows as a note's body: the stored body minus an embedded
// `## Claude` reply (todos) and screenshot links. Stored list offsets are
// relative to THIS text, so detection (`l` key) and display agree on it.
export const listText = (rawBody: string): string =>
  splitBodyImages(splitTodoReply(rawBody).body).text;

// What copy puts on the clipboard: the stored body untouched, unless the
// note's list is currently shown — then the bullets replace the note text,
// with any screenshot links and embedded reply put back after them.
export function copyBody(
  rawBody: string,
  entry: ListEntry | undefined,
): string {
  const text = listText(rawBody);
  const shown = displayBody(text, entry);
  if (shown === text) return rawBody;
  const { body, reply } = splitTodoReply(rawBody);
  const out = splitBodyImages(body).images.reduce(
    (acc, ref) => `${acc}\n\n![screenshot](${ref})`,
    shown,
  );
  return reply === null ? out : `${out}\n\n## Claude\n\n${reply}`;
}

// Strict parse of the sidecar JSON the backend returns. Anything malformed
// (whole file or single entry) is ignored rather than trusted.
export function parseLists(raw: string): Record<string, ListEntry> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: Record<string, ListEntry> = {};
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return out;
  }
  for (const [key, v] of Object.entries(data)) {
    if (typeof v !== "object" || v === null) continue;
    const { starts, show } = v as { starts?: unknown; show?: unknown };
    if (typeof show !== "boolean") continue;
    if (starts === null) {
      out[key] = { starts: null, show };
    } else if (
      Array.isArray(starts) &&
      starts.every((n) => Number.isInteger(n) && n >= 0)
    ) {
      out[key] = { starts: starts as number[], show };
    }
  }
  return out;
}
