// Pure classifier decision logic: builds the local provider's /decide
// request and the claude provider's prompt, parses both providers' replies
// into a common `ClassifyPick`, and decides which tags (if any) a note
// should gain. All IO (the actual classify_local/sendToClaude calls, and the
// concurrency-limited loop over pending notes) lives in useInbox.ts — same
// pure-function/caller-owns-bookkeeping split as autotag.ts, and this module
// deliberately mirrors its shape (see AutoTagOptions/AutoTagResult there).
import type { Note } from "../inbox";
import { QUICK_TAGS } from "./format";

// A decided tag per question, or undefined if the classifier had nothing
// confident enough to say — see parseLocalResponse/parseClaudeReply below,
// which are the only two producers of this type.
export interface ClassifyPick {
  type?: string;
  project?: string;
}

// Local-provider answers below this confidence are treated the same as
// "none" (see docs/backend.md's request/response shape). The claude
// provider has no confidence score, so this threshold doesn't apply there —
// any valid, non-"none" value is accepted.
export const CONFIDENCE_THRESHOLD = 0.6;

// A note is only ever sent to the classifier within this many hours of its
// own timestamp — see eligibleForClassification below. Keeps a long-idle
// inbox from re-sending old notes on every launch once they've aged past
// the point classification is useful.
export const CLASSIFY_WINDOW_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Builds the local provider's `POST /decide` request body: `state` is the
// note's body text (the only context the classifier gets) and `questions`
// has one `{type: "choice", instructions, criteria}` entry per tag it
// should pick — `project` is omitted entirely when there are no routing
// projects configured, so a fresh install with no projects never asks a
// question that can't be answered.
interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: string[];
}

export function buildClassifyRequest(
  note: Note,
  projectTags: readonly string[],
): unknown {
  const questions: Record<string, ChoiceQuestion> = {
    type: {
      type: "choice",
      instructions: "Classify this note as one of the given labels.",
      criteria: [...QUICK_TAGS, "none"],
    },
  };
  if (projectTags.length > 0) {
    questions.project = {
      type: "choice",
      instructions:
        "Which project (if any) does this note belong to? Choose one of the given labels.",
      criteria: [...projectTags, "none"],
    };
  }
  return {
    state: note.body,
    questions,
  };
}

// One question's answer, at/above CONFIDENCE_THRESHOLD, matching (case-
// insensitively) one of `allowed`'s choices — anything else (missing,
// malformed, low-confidence, "none", or a value that isn't one of the
// choices actually offered) comes back undefined so the caller just skips
// that tag. Returning `allowed`'s own casing (not the classifier's) means a
// reply like "Bug" resolves to the canonical "bug", never gets written to
// the note as a tag that isn't in QUICK_TAGS/projectTags, and so never
// leaves the note stuck looking eligible forever (see
// eligibleForClassification). It also means the added tag can never contain
// spaces/newlines/etc. — it's always exactly one of `allowed`'s entries.
function pickAnswer(
  answer: unknown,
  allowed: readonly string[],
): string | undefined {
  if (!isRecord(answer)) return undefined;
  const choice = answer.choice;
  const confidence = answer.confidence;
  if (typeof choice !== "string") return undefined;
  const trimmed = choice.trim().toLowerCase();
  if (!trimmed || trimmed === "none") return undefined;
  if (typeof confidence !== "number" || confidence < CONFIDENCE_THRESHOLD) {
    return undefined;
  }
  return allowed.find((a) => a.toLowerCase() === trimmed);
}

// Parses the local provider's /decide response (`{"answers": {"type":
// {"choice", "confidence", "probabilities"}, "project": {...}}}`) into a
// ClassifyPick. The project answer is only looked at when `projectTags` is
// non-empty — same reasoning as buildClassifyRequest not asking the
// question at all in that case. Tolerant of any malformed/unexpected shape
// (treated as no pick).
export function parseLocalResponse(
  json: unknown,
  projectTags: readonly string[],
): ClassifyPick {
  const answers = isRecord(json) && isRecord(json.answers) ? json.answers : {};
  const pick: ClassifyPick = { type: pickAnswer(answers.type, QUICK_TAGS) };
  if (projectTags.length > 0) {
    pick.project = pickAnswer(answers.project, projectTags);
  }
  return pick;
}

// The claude provider's fixed prompt: asks for exactly two lines so the
// reply is cheap to parse defensively (parseClaudeReply below never trusts
// the model followed the format exactly).
export function buildClaudePrompt(
  note: Note,
  projectTags: readonly string[],
): string {
  const projectChoices = projectTags.length ? projectTags.join("|") : "none";
  return (
    "Classify this note. Reply with exactly two lines and nothing else:\n" +
    `type: <${QUICK_TAGS.join("|")}|none>\n` +
    `project: <${projectChoices}|none>\n\n` +
    `Note:\n${note.body}`
  );
}

// Parses a claude reply defensively: scans every line for a `type:`/
// `project:` prefix (in case the model added stray lines despite the
// prompt), lowercases the value, and keeps it only if it's one of the
// choices actually offered (QUICK_TAGS for type, the current projectTags
// for project) — any unknown value, including a hallucinated tag, is
// treated as "none".
export function parseClaudeReply(
  reply: string,
  projectTags: readonly string[],
): ClassifyPick {
  let type: string | undefined;
  let project: string | undefined;
  for (const line of reply.split("\n")) {
    const m = line.match(/^\s*(type|project)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const value = m[2].trim().toLowerCase();
    if (!value || value === "none") continue;
    if (
      m[1].toLowerCase() === "type" &&
      (QUICK_TAGS as string[]).includes(value)
    ) {
      type = value;
    } else if (
      m[1].toLowerCase() === "project" &&
      projectTags.includes(value)
    ) {
      project = value;
    }
  }
  return { type, project };
}

// Settings pane's classifier URL field validates on save with this — same
// loopback-only http/https rule as src-tauri/src/classifier.rs's
// validate_url (that Rust check is the real security boundary, since it's
// what actually gates the network call; this is a UI courtesy so a bad URL
// gets a toast immediately instead of only failing at the next classify
// call). Returns an error message, or null when `url` is fine.
export function validateClassifierUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid classifier URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "classifier URL must be http or https";
  }
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return "classifier URL must point at 127.0.0.1, localhost, or ::1";
  }
  return null;
}

// Inbox timestamps look like "2026-09-23 09:14" (local time, see
// docs/data-model.md) — same `.replace(" ", "T")` local-time parse as
// stale.ts's ageDays. Unparseable reads as "not within the window" (never
// eligible), the safe default.
export function withinClassifyWindow(timestamp: string, now: Date): boolean {
  const then = new Date(timestamp.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return false;
  return now.getTime() - then <= CLASSIFY_WINDOW_HOURS * MS_PER_HOUR;
}

// A note is worth classifying iff: it was captured within the last
// CLASSIFY_WINDOW_HOURS, AND it's missing a type tag, or missing a project
// tag while projects are configured. A note with a type tag already, in a
// config with no projects configured, is NOT eligible — there's no second
// question to ask it, so treating a merely-absent project tag as "missing"
// in that case (as an earlier version of this function did) left every
// already-typed note looking eligible forever, wastefully re-sent on every
// launch.
export function eligibleForClassification(
  note: Note,
  projectTags: readonly string[],
  now: Date,
): boolean {
  if (!withinClassifyWindow(note.timestamp, now)) return false;
  const hasType = note.tags.some((t) => (QUICK_TAGS as string[]).includes(t));
  if (!hasType) return true;
  if (projectTags.length === 0) return false;
  const hasProject = note.tags.some((t) => projectTags.includes(t));
  return !hasProject;
}

export interface SelectForClassificationOptions {
  // note.timestamp values already scanned for classification this app run.
  // Keyed by timestamp (not raw, unlike autotag.ts's alreadyProcessed): a
  // note's raw changes on every tag edit and on the classifier's own write,
  // and re-scanning either would defeat the "classified at most once per
  // session" contract this is meant to enforce — timestamp is stable across
  // both.
  alreadyProcessed: ReadonlySet<string>;
  projectTags: readonly string[];
  now: Date;
}

export interface SelectForClassificationResult {
  // Not-yet-processed notes that are missing a type and/or project tag —
  // the ones worth spending a classify call on.
  eligible: Note[];
  // Every note.timestamp newly scanned this call (eligible or not) — the
  // caller folds these into its own tracking set, same contract as
  // autotag.ts's `processedKeys`.
  processedKeys: string[];
}

// Scans every not-yet-processed note and splits out the ones eligible for
// classification, marking ALL of them (eligible or not) as processed —
// mirrors autoTag's `seen`/`processedKeys` loop, so a note is never asked
// twice in one app run regardless of whether the first ask changed it (and,
// per eligibleForClassification, regardless of whether it later ages out of
// the classify window or gets edited).
export function selectForClassification(
  notes: Note[],
  { alreadyProcessed, projectTags, now }: SelectForClassificationOptions,
): SelectForClassificationResult {
  const seen = new Set(alreadyProcessed);
  const eligible: Note[] = [];
  const processedKeys: string[] = [];
  for (const n of notes) {
    if (seen.has(n.timestamp)) continue;
    seen.add(n.timestamp);
    processedKeys.push(n.timestamp);
    if (eligibleForClassification(n, projectTags, now)) eligible.push(n);
  }
  return { eligible, processedKeys };
}

export interface DecideTagsOptions {
  // `${note.timestamp}::${tag}` keys the tags the user manually removed this
  // app run — same contract as autotag.ts's `removedTags`. Checked at the
  // CATEGORY level (see categoryRemoved below): once the user has removed
  // any type tag from a note, no type tag is ever added back to it this
  // session, even a different one than was removed — same for project tags.
  removedTags: ReadonlySet<string>;
  projectTags: readonly string[];
  // Tags the user has deleted outright (`.sideline.json`'s hiddenTags) — a
  // classifier pick naming one of these is dropped, same as any other
  // deleted-tag site in the app.
  hiddenTags: ReadonlySet<string>;
}

// True iff the user removed any of `candidates` from `note` this app run —
// used to block the whole type/project category, not just the one exact
// tag a pick names.
function categoryRemoved(
  note: Note,
  removedTags: ReadonlySet<string>,
  candidates: readonly string[],
): boolean {
  return candidates.some((t) => removedTags.has(`${note.timestamp}::${t}`));
}

// Decides which of a pick's tags (0, 1, or 2) should actually be added to
// `note`: a tag is only added when the note doesn't already carry a tag of
// that kind, the pick named one, that tag isn't hidden, the note doesn't
// already literally have it, and the user hasn't removed a tag of that
// category from this note already this run.
export function decideTags(
  note: Note,
  pick: ClassifyPick,
  { removedTags, projectTags, hiddenTags }: DecideTagsOptions,
): string[] {
  const added: string[] = [];
  const hasType = note.tags.some((t) => (QUICK_TAGS as string[]).includes(t));
  if (
    !hasType &&
    pick.type &&
    !note.tags.includes(pick.type) &&
    !hiddenTags.has(pick.type) &&
    !categoryRemoved(note, removedTags, QUICK_TAGS)
  ) {
    added.push(pick.type);
  }
  const hasProject = note.tags.some((t) => projectTags.includes(t));
  if (
    !hasProject &&
    pick.project &&
    !note.tags.includes(pick.project) &&
    !hiddenTags.has(pick.project) &&
    !categoryRemoved(note, removedTags, projectTags)
  ) {
    added.push(pick.project);
  }
  return added;
}

export interface ApplyClassifierPicksResult {
  // True iff at least one note gained a tag.
  changed: boolean;
  // Same length/order as the input `notes` — untouched notes are returned by
  // the exact same object reference, same convention as autoTag's
  // `nextNotes`.
  nextNotes: Note[];
}

// One classify call's result, plus enough of the note it was computed
// against to re-identify it later — see applyClassifierPicksToFreshNotes.
export interface ClassifierPickSource {
  timestamp: string;
  body: string;
  pick: ClassifyPick;
}

// Matches each pick against a freshly re-read note list (e.g. from a fresh
// readInbox() done right before writing back) and applies it — the fix for
// the race where a classify call's result gets applied against a stale
// notes snapshot: `notes` passed in here should always come from a read
// done AFTER the classify call resolved, not from a ref that may predate
// it. A pick is matched by `timestamp` (stable across tag edits) and only
// applied if that note's `body` is unchanged from what was actually sent to
// the classifier — if the body changed (edited while the call was in
// flight) or the note is gone entirely (archived/triaged/deleted), the pick
// is dropped as stale rather than risk misclassifying or resurrecting a
// removed note. A note whose tags changed (but not body) in the meantime
// still gets its pick applied — decideTags re-checks the note's CURRENT
// tags, so a tag added by some other path in the meantime is respected.
export function applyClassifierPicksToFreshNotes(
  notes: Note[],
  sources: readonly ClassifierPickSource[],
  options: DecideTagsOptions,
): ApplyClassifierPicksResult {
  const byTimestamp = new Map<string, ClassifierPickSource>();
  for (const s of sources) byTimestamp.set(s.timestamp, s);
  let changed = false;
  const nextNotes = notes.map((n) => {
    const source = byTimestamp.get(n.timestamp);
    if (!source || source.body !== n.body) return n;
    const added = decideTags(n, source.pick, options);
    if (added.length === 0) return n;
    changed = true;
    return { ...n, tags: [...n.tags, ...added] };
  });
  return { changed, nextNotes };
}

// A tiny counting semaphore: at most `max` callbacks passed to `run` are
// ever executing at once, across every call site sharing one Limiter
// instance. useInbox.ts keeps ONE module-level Limiter(2) for the
// classifier, so that two `runClassifier` calls started by overlapping
// reloads (e.g. two `inbox-changed` events firing in quick succession)
// still add up to at most 2 concurrent classify calls total, not 2 each.
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export interface ClassifyBatchIO {
  // Runs one note through the configured provider and returns its pick —
  // rejecting (network error, bad response, etc.) is treated as "no pick
  // for this note", not a batch failure. Any provider-unreachable toast is
  // the caller's responsibility (e.g. a flag set inside this callback).
  classify: (note: Note) => Promise<ClassifyPick>;
  // Persists one note's pick — expected to do its own fresh read/match/
  // write and to resolve normally (not reject) on a benign, safely-ignored
  // outcome such as an inbox write conflict; a rejection here is logged by
  // runClassifyBatch, not thrown further, so one note's write-back failure
  // can never surface as an unhandled promise rejection.
  writeBack: (note: Note, pick: ClassifyPick) => Promise<void>;
}

// Drives `eligible` through classify+writeBack, at most `limiter`'s cap
// concurrently, writing each note's result back as soon as it's ready
// rather than batching every note's result into one write at the end —
// this is the loop useInbox.ts's runClassifier wraps with the real Tauri
// IO; kept here, decoupled from any IO, so the concurrency cap and the
// per-note (not per-batch) write-back timing are unit-testable without
// mocking Tauri.
export async function runClassifyBatch(
  eligible: readonly Note[],
  io: ClassifyBatchIO,
  limiter: Limiter,
): Promise<void> {
  await Promise.all(
    eligible.map((note) =>
      limiter.run(async () => {
        let pick: ClassifyPick;
        try {
          pick = await io.classify(note);
        } catch {
          return;
        }
        if (!pick.type && !pick.project) return;
        try {
          await io.writeBack(note, pick);
        } catch (e) {
          console.error("classifier write-back failed:", e);
        }
      }),
    ),
  );
}
