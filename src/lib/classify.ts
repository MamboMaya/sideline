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

// One question's answer, at/above CONFIDENCE_THRESHOLD, non-"none" choice —
// anything else (missing, malformed, low-confidence, or explicitly "none")
// comes back undefined so the caller just skips that tag.
function pickAnswer(answer: unknown): string | undefined {
  if (!isRecord(answer)) return undefined;
  const choice = answer.choice;
  const confidence = answer.confidence;
  if (typeof choice !== "string") return undefined;
  const trimmed = choice.trim();
  if (!trimmed || trimmed === "none") return undefined;
  if (typeof confidence !== "number" || confidence < CONFIDENCE_THRESHOLD) {
    return undefined;
  }
  return trimmed;
}

// Parses the local provider's /decide response (`{"answers": {"type":
// {"choice", "confidence", "probabilities"}, "project": {...}}}`) into a
// ClassifyPick. Tolerant of a missing `project` answer (no projects
// configured) and of any malformed/unexpected shape (treated as no pick).
export function parseLocalResponse(json: unknown): ClassifyPick {
  const answers = isRecord(json) && isRecord(json.answers) ? json.answers : {};
  return {
    type: pickAnswer(answers.type),
    project: pickAnswer(answers.project),
  };
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

// A note is worth classifying iff it's missing a type tag OR missing a
// project tag — a note that already has both is left alone even if it
// hasn't been scanned yet.
export function eligibleForClassification(
  note: Note,
  projectTags: readonly string[],
): boolean {
  const hasType = note.tags.some((t) => (QUICK_TAGS as string[]).includes(t));
  const hasProject = note.tags.some((t) => projectTags.includes(t));
  return !hasType || !hasProject;
}

export interface SelectForClassificationOptions {
  // Note.raw values already scanned for classification this app run — same
  // raw-keyed, reset-on-restart bookkeeping as autotag.ts's
  // `alreadyProcessed`.
  alreadyProcessed: ReadonlySet<string>;
  projectTags: readonly string[];
}

export interface SelectForClassificationResult {
  // Not-yet-processed notes that are missing a type and/or project tag —
  // the ones worth spending a classify call on.
  eligible: Note[];
  // Every note.raw newly scanned this call (eligible or not) — the caller
  // folds these into its own tracking set, same contract as autotag.ts's
  // `processedKeys`.
  processedKeys: string[];
}

// Scans every not-yet-processed note and splits out the ones eligible for
// classification, marking ALL of them (eligible or not) as processed —
// mirrors autoTag's `seen`/`processedKeys` loop exactly, so a note is never
// asked twice in one app run regardless of whether the first ask changed it.
export function selectForClassification(
  notes: Note[],
  { alreadyProcessed, projectTags }: SelectForClassificationOptions,
): SelectForClassificationResult {
  const seen = new Set(alreadyProcessed);
  const eligible: Note[] = [];
  const processedKeys: string[] = [];
  for (const n of notes) {
    if (seen.has(n.raw)) continue;
    seen.add(n.raw);
    processedKeys.push(n.raw);
    if (eligibleForClassification(n, projectTags)) eligible.push(n);
  }
  return { eligible, processedKeys };
}

export interface DecideTagsOptions {
  // `${note.timestamp}::${tag}` keys the tags the user manually removed this
  // app run — same contract as autotag.ts's `removedTags`: never re-added.
  removedTags: ReadonlySet<string>;
  projectTags: readonly string[];
}

// Decides which of a pick's tags (0, 1, or 2) should actually be added to
// `note`: a tag is only added when the note doesn't already carry a tag of
// that kind, the pick named one, and the user hasn't removed that exact
// tag from this note already this run.
export function decideTags(
  note: Note,
  pick: ClassifyPick,
  { removedTags, projectTags }: DecideTagsOptions,
): string[] {
  const added: string[] = [];
  const hasType = note.tags.some((t) => (QUICK_TAGS as string[]).includes(t));
  if (
    !hasType &&
    pick.type &&
    !removedTags.has(`${note.timestamp}::${pick.type}`)
  ) {
    added.push(pick.type);
  }
  const hasProject = note.tags.some((t) => projectTags.includes(t));
  if (
    !hasProject &&
    pick.project &&
    !removedTags.has(`${note.timestamp}::${pick.project}`)
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

// Applies every collected pick (keyed by note.raw) in one pass, so the
// caller can batch all classifier tag additions into a single write —
// notes with no pick, or whose pick decides to add nothing, are untouched.
export function applyClassifierPicks(
  notes: Note[],
  picks: ReadonlyMap<string, ClassifyPick>,
  options: DecideTagsOptions,
): ApplyClassifierPicksResult {
  let changed = false;
  const nextNotes = notes.map((n) => {
    const pick = picks.get(n.raw);
    if (!pick) return n;
    const added = decideTags(n, pick, options);
    if (added.length === 0) return n;
    changed = true;
    return { ...n, tags: [...n.tags, ...added] };
  });
  return { changed, nextNotes };
}
