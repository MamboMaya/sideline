// Pure auto-tag decision logic, extracted from App.tsx's reload(): scans
// notes for known tags mentioned in their body and adds the matches. All
// bookkeeping (which raws have been seen, which removals to respect) lives
// in the caller — this function only computes what should change given the
// values it's handed, so it can't itself decide when to update the tracking
// sets.
import type { Note } from "../inbox";
import { escapeRegex } from "./format";

export interface AutoTagOptions {
  // Note.raw values already scanned for auto-tagging this app run. Keying by
  // raw (which encodes tags+body+header) means a note that returns to a
  // previously-seen tag set — e.g. the user removes a tag the auto-tagger
  // just added — naturally re-matches an already-processed key and is left
  // alone. Reset only on app restart (known limitation, see CLAUDE.md).
  alreadyProcessed: ReadonlySet<string>;
  // `${note.timestamp}::${tag}` keys the tags the user manually removed this
  // app run — skipped here so a removed tag never comes back just because
  // the body still mentions it.
  removedTags: ReadonlySet<string>;
}

export interface AutoTagResult {
  // True iff at least one note gained a tag.
  changed: boolean;
  // Same length/order as the input `notes` — untouched notes are returned by
  // the exact same object reference.
  nextNotes: Note[];
  // note.raw values that were newly scanned this call (i.e. not already in
  // `alreadyProcessed`), whether or not a tag ended up added — the caller
  // folds these into its own tracking set. Each key appears at most once,
  // even if several input notes share the same raw (see `seen` below).
  processedKeys: string[];
}

// Scans every not-yet-processed note's body for mentions of any known tag it
// doesn't already carry, and adds the matches. Voice transcripts split
// compound tags ("to do", "side line", "side-line"), so the match allows one
// space/hyphen between the tag's letters instead of demanding the exact
// token; `\b` boundaries keep it from matching inside a larger word (e.g.
// "debugging" doesn't match tag "bug").
export function autoTag(
  notes: Note[],
  knownTags: ReadonlySet<string>,
  { alreadyProcessed, removedTags }: AutoTagOptions,
): AutoTagResult {
  let changed = false;
  const processedKeys: string[] = [];
  // A local copy, mutated as we go — mirrors the old inline code, which
  // added to `autoTaggedRef` synchronously mid-`.map()`. That mid-loop
  // mutation is what makes a SECOND note in this same batch sharing the
  // first one's raw (e.g. a rapid duplicate capture landing twice in one
  // parse) get skipped too, instead of being scanned/retagged a second
  // time. Copying (rather than mutating `alreadyProcessed` itself) keeps
  // this function pure — the caller decides if/when to persist `seen`'s
  // additions via `processedKeys`.
  const seen = new Set(alreadyProcessed);
  const nextNotes = notes.map((n) => {
    if (seen.has(n.raw)) return n;
    // Mark processed now (on the raw as first seen), whether or not a tag
    // ends up added — see the `alreadyProcessed` doc above for why this is
    // loop-safe and respects manual tag removal.
    seen.add(n.raw);
    processedKeys.push(n.raw);
    const added: string[] = [];
    for (const tag of knownTags) {
      if (n.tags.includes(tag)) continue;
      // Never re-add a tag the user removed from this note this run.
      if (removedTags.has(`${n.timestamp}::${tag}`)) continue;
      const chars = tag.replace(/-/g, "").split("");
      if (chars.length === 0) continue;
      const re = new RegExp(
        "\\b" + chars.map(escapeRegex).join("[\\s-]?") + "\\b",
        "i",
      );
      if (re.test(n.body)) added.push(tag);
    }
    if (added.length === 0) return n;
    changed = true;
    return { ...n, tags: [...n.tags, ...added] };
  });
  return { changed, nextNotes, processedKeys };
}
