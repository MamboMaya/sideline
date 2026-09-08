// `.sideline.json` config: type declarations, defaults, parsing, and IO —
// extracted from App.tsx. Parsing is pure (parseConfig) so its behaviors
// are covered by tests without touching Tauri IPC; loadConfig/writeConfig
// are thin IO wrappers over the Task 10 facade (./commands). The on-disk
// format is documented in docs/data-model.md and shared with capture/
// tooling: unknown keys and key order are contract, not style —
// serializeConfig's key order below must stay exactly as-is.
import { sanitizeTag } from "./format";
import {
  readConfig as readConfigFile,
  writeConfig as writeConfigIpc,
} from "./commands";

export interface Prompts {
  triage: string;
  batch: string;
}

export const DEFAULT_PROMPTS: Prompts = {
  triage:
    "You are triaging a quick-capture note from an inbox. Decide what it " +
    "needs and produce exactly that: a question gets a direct answer; an " +
    "idea gets a brief expansion with concrete next steps; a task gets a " +
    "small plan (goal, numbered steps, open questions only if real). " +
    "Trivial notes get one useful sentence. Concise markdown, no preamble, " +
    "no heading. The note:",
  batch:
    "You are triaging quick-capture notes organized into numbered items. " +
    "Some items hold several related notes sharing a tag — treat those as " +
    "one body of thought: merge overlaps and produce one coherent response " +
    "for the whole item. For any item, produce exactly what it needs: a " +
    "question gets a direct answer; an idea gets a brief expansion with " +
    "concrete next steps; a task gets a small plan (goal, numbered steps, " +
    "open questions only if real). Trivial items get one useful sentence. " +
    "Concise markdown, no preamble. Reply with one section per item IN " +
    "ORDER, each beginning on its own line with exactly `=== ITEM <number> " +
    "===` followed by that item's reply. The items:",
};

export interface Models {
  triage: string;
  batch: string;
}

// Haiku everywhere: triage just files/routes notes — the real thinking
// happens later in a repo Claude session with full context. Overridable
// per-action via .sideline.json's `models`.
export const DEFAULT_MODELS: Models = { triage: "haiku", batch: "haiku" };

// `.sideline.json`'s `projects` field: either the original `{tag: path}` map
// (paths are no longer used for anything — a repo just names itself in the
// map to opt in) or a plain array of tags. Either shape round-trips
// verbatim via `projectsOverride`; internally only the tag list matters.
export type ProjectsConfig = Record<string, string> | string[];

// Merges a raw `prompts`/`models` override object against the built-in
// defaults — extracted out of parseConfig so the Settings pane's write path
// (useConfig's updateConfig) can compute the same merged value locally
// without re-parsing the whole file. A blank/missing field falls back to its
// default, same tolerance as parseConfig itself.
export function mergePrompts(raw: Partial<Prompts> | undefined): Prompts {
  return {
    triage:
      typeof raw?.triage === "string" && raw.triage.trim()
        ? raw.triage
        : DEFAULT_PROMPTS.triage,
    batch:
      typeof raw?.batch === "string" && raw.batch.trim()
        ? raw.batch
        : DEFAULT_PROMPTS.batch,
  };
}

export function mergeModels(raw: Partial<Models> | undefined): Models {
  return {
    triage:
      typeof raw?.triage === "string" && raw.triage.trim()
        ? raw.triage
        : DEFAULT_MODELS.triage,
    batch:
      typeof raw?.batch === "string" && raw.batch.trim()
        ? raw.batch
        : DEFAULT_MODELS.batch,
  };
}

// Derives the routing tag list from a raw `projects` value, in either shape
// — same derivation parseConfig does inline, extracted so updateConfig can
// recompute `projectTags` after an add/remove without re-parsing the file.
export function projectTagsFrom(
  projects: ProjectsConfig | undefined,
): string[] {
  if (Array.isArray(projects)) {
    return projects
      .map((t) => (typeof t === "string" ? sanitizeTag(t) : ""))
      .filter(Boolean);
  }
  if (projects && typeof projects === "object") {
    return Object.keys(projects);
  }
  return [];
}

// Adds a project tag to `projects`, preserving whichever shape (array or
// legacy `{tag: path}` map) is already on disk; a brand-new `projects` key
// (currently absent) defaults to the array shape — the map shape only
// exists for backward compatibility with hand-edited files, never written
// fresh. A tag already present is left untouched (no duplicate entries).
export function projectsAdd(
  current: ProjectsConfig | undefined,
  tag: string,
): ProjectsConfig {
  if (Array.isArray(current)) {
    return current.includes(tag) ? current : [...current, tag];
  }
  if (current && typeof current === "object") {
    return tag in current ? current : { ...current, [tag]: "" };
  }
  return [tag];
}

// Removes a project tag from `projects`, in whichever shape it's in;
// returns undefined (key omitted entirely) once the last entry is removed,
// matching serializeConfig's "omit when empty" convention for every other
// override.
export function projectsRemove(
  current: ProjectsConfig | undefined,
  tag: string,
): ProjectsConfig | undefined {
  if (Array.isArray(current)) {
    const next = current.filter((t) => t !== tag);
    return next.length ? next : undefined;
  }
  if (current && typeof current === "object") {
    const next = Object.fromEntries(
      Object.entries(current).filter(([t]) => t !== tag),
    );
    return Object.keys(next).length ? next : undefined;
  }
  return current;
}

// `.sideline.json`'s `hotkeys` field — human-friendly combo strings (e.g.
// `"alt+cmd+space"`) for the three global shortcuts. Parsing/registration is
// entirely Rust-side (src-tauri/src/lib.rs, read at startup, restart
// required); this type only backs the shortcuts modal's display and the
// opaque `hotkeysOverride` passthrough so pin/zoom writes don't erase it.
export interface HotkeysConfig {
  toggle?: string;
  record?: string;
  // Dictation mode: records like `record`, but the transcript goes to the
  // clipboard + an auto-paste attempt instead of inbox.md — see
  // docs/backend.md. Default ⌥⌘V (src-tauri/src/hotkeys.rs's
  // `default_dictate_shortcut`).
  dictate?: string;
}

// `.sideline.json`'s `dictionary` field — the transcription vocabulary:
// correctly-spelled term → the mis-hearings whisper produces for it (may be
// empty; a bare term still biases whisper's initial prompt). Read Rust-side
// by whisper.rs on every transcription and by capture/voice-note.sh; the
// frontend only edits it (Settings' Voice section) via the two text helpers
// below.
export type DictionaryConfig = Record<string, string[]>;

// One Settings-pane dictionary row: the term plus its mis-hearings as the
// comma-separated text the row's second input holds.
export interface DictionaryRow {
  term: string;
  mishears: string;
}

// Splits a row's comma-separated mis-hearings input: trimmed, blanks
// dropped, duplicates collapsed (first occurrence wins).
export function splitMishears(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const m = raw.trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

// On-disk dictionary → editor rows, in file order.
export function dictionaryRows(
  dict: DictionaryConfig | undefined,
): DictionaryRow[] {
  if (!dict) return [];
  return Object.entries(dict).map(([term, mishears]) => ({
    term,
    mishears: mishears.join(", "),
  }));
}

// Editor rows → on-disk dictionary. Blank terms are skipped, duplicate
// terms merge their mis-hearings; undefined when nothing is left so the
// key is omitted entirely (serializeConfig's convention).
export function dictionaryFromRows(
  rows: DictionaryRow[],
): DictionaryConfig | undefined {
  const out: DictionaryConfig = {};
  for (const row of rows) {
    const term = row.term.trim();
    if (!term) continue;
    const prev = out[term] ?? [];
    out[term] = [
      ...prev,
      ...splitMishears(row.mishears).filter((m) => !prev.includes(m)),
    ];
  }
  return Object.keys(out).length ? out : undefined;
}

// Everything loadConfig produces from `.sideline.json` — one field per
// App.tsx config state slice, including the 7 opaque per-key overrides
// (promptsOverride, modelsOverride, projectsOverride, claudeOverride,
// audioOverride, hotkeysOverride, dictionaryOverride) kept around purely so
// a pin/zoom/hide write doesn't clobber hand-edited config it didn't touch.
export interface SidelineConfig {
  pinnedTags: string[];
  hiddenTags: string[];
  prompts: Prompts;
  promptsOverride: Partial<Prompts> | undefined;
  models: Models;
  modelsOverride: Partial<Models> | undefined;
  projectTags: string[];
  projectsOverride: ProjectsConfig | undefined;
  // Resolved no-Claude-mode switch: `.sideline.json`'s `claude` key, merged
  // against the default of `true` (absent/invalid = Claude enabled). `false`
  // means every non-project triage flow skips `send_to_claude` entirely and
  // falls back to local, CLI-free filing — see useTriage.
  claude: boolean;
  // Raw `claude` value as it appeared in the file (undefined when the key is
  // absent) — kept only so a pin/zoom/hide write doesn't clobber a
  // hand-edited `false` back to the default `true`, same as the 5 opaque
  // overrides below.
  claudeOverride: boolean | undefined;
  zoom: number;
  audioOverride: unknown;
  hotkeysOverride: HotkeysConfig | undefined;
  dictionaryOverride: DictionaryConfig | undefined;
}

const EMPTY_CONFIG: SidelineConfig = {
  pinnedTags: [],
  hiddenTags: [],
  prompts: DEFAULT_PROMPTS,
  promptsOverride: undefined,
  models: DEFAULT_MODELS,
  modelsOverride: undefined,
  projectTags: [],
  projectsOverride: undefined,
  claude: true,
  claudeOverride: undefined,
  zoom: 1,
  audioOverride: undefined,
  hotkeysOverride: undefined,
  dictionaryOverride: undefined,
};

// Validates a raw `dictionary` value into DictionaryConfig: an object whose
// values are string arrays. Non-string mis-hearings are dropped; a value
// that isn't an array becomes an empty list (the term still counts); blank
// terms are skipped; a non-object `dictionary` is treated as absent.
function dictionaryFrom(raw: unknown): DictionaryConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: DictionaryConfig = {};
  for (const [term, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!term.trim()) continue;
    out[term] = Array.isArray(v)
      ? v.filter((m): m is string => typeof m === "string" && !!m.trim())
      : [];
  }
  return Object.keys(out).length ? out : undefined;
}

// Parses `.sideline.json`'s raw text into a SidelineConfig. Pure — no IO.
// Failure-tolerant: a missing/unparseable config (empty string or malformed
// JSON) just means no pins, default prompts/models, and no project routing.
export function parseConfig(raw: string): SidelineConfig {
  try {
    if (!raw.trim()) {
      return EMPTY_CONFIG;
    }
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.pinnedTags) ? parsed.pinnedTags : [];
    const sanitized = arr
      .map((t: unknown) => (typeof t === "string" ? sanitizeTag(t) : ""))
      .filter(Boolean);
    const hiddenArr = Array.isArray(parsed?.hiddenTags)
      ? parsed.hiddenTags
      : [];
    const hidden = hiddenArr
      .map((t: unknown) => (typeof t === "string" ? sanitizeTag(t) : ""))
      .filter(Boolean);
    const rawPrompts =
      parsed?.prompts && typeof parsed.prompts === "object"
        ? (parsed.prompts as Partial<Prompts>)
        : undefined;
    const mergedPrompts = mergePrompts(rawPrompts);
    const rawModels =
      parsed?.models && typeof parsed.models === "object"
        ? (parsed.models as Partial<Models>)
        : undefined;
    const mergedModels = mergeModels(rawModels);
    let projectTags: string[] = [];
    let projectsOverride: ProjectsConfig | undefined;
    if (Array.isArray(parsed?.projects)) {
      projectsOverride = parsed.projects;
      projectTags = projectTagsFrom(projectsOverride);
    } else if (parsed?.projects && typeof parsed.projects === "object") {
      const rawProjects = Object.fromEntries(
        Object.entries(parsed.projects as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      projectsOverride = rawProjects;
      projectTags = projectTagsFrom(projectsOverride);
    }
    const claudeOverride =
      typeof parsed?.claude === "boolean" ? parsed.claude : undefined;
    const zoom =
      typeof parsed?.zoom === "number" && Number.isFinite(parsed.zoom)
        ? Math.min(1.5, Math.max(0.7, parsed.zoom))
        : 1;
    const audioOverride =
      parsed?.audio && typeof parsed.audio === "object"
        ? parsed.audio
        : undefined;
    const hotkeysOverride =
      parsed?.hotkeys && typeof parsed.hotkeys === "object"
        ? (parsed.hotkeys as HotkeysConfig)
        : undefined;
    const dictionaryOverride = dictionaryFrom(parsed?.dictionary);
    return {
      pinnedTags: sanitized.slice(0, 6),
      hiddenTags: hidden,
      prompts: mergedPrompts,
      promptsOverride: rawPrompts,
      models: mergedModels,
      modelsOverride: rawModels,
      projectTags,
      projectsOverride,
      claude: claudeOverride ?? true,
      claudeOverride,
      audioOverride,
      hotkeysOverride,
      dictionaryOverride,
      zoom,
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

// Reads `.sideline.json` via the Task 10 IPC facade and parses it. A
// missing file reads as "" Rust-side (see docs/backend.md), which
// parseConfig already treats as EMPTY_CONFIG; the try/catch here only
// guards the read call itself (e.g. an IPC-level failure), matching the
// original single function's failure-tolerance.
export async function loadConfig(): Promise<SidelineConfig> {
  try {
    const raw = await readConfigFile();
    return parseConfig(raw);
  } catch {
    return EMPTY_CONFIG;
  }
}

// The 7 opaque per-key overrides from `.sideline.json` — round-tripped
// verbatim (whatever the user hand-edited, including unknown keys within
// each) so a pin/zoom/hide write never clobbers a value it didn't touch.
export interface ConfigOverrides {
  prompts: Partial<Prompts> | undefined;
  models: Partial<Models> | undefined;
  projects: ProjectsConfig | undefined;
  // Raw `claude` boolean as read from the file — `undefined` means the key
  // is absent (so it stays omitted on write, not forced to `true`).
  claude: boolean | undefined;
  audio: unknown;
  hotkeys: HotkeysConfig | undefined;
  dictionary: DictionaryConfig | undefined;
}

export interface ConfigWrite {
  pinnedTags: string[];
  hiddenTags: string[];
  zoom: number;
  overrides: ConfigOverrides;
}

// Byte-identical to the original writeConfigFile's JSON.stringify(..., null,
// 2) shape and key order — pinnedTags, hiddenTags?, prompts?, models?,
// projects?, claude?, zoom?, audio?, hotkeys?, dictionary? (omitted when
// falsy/empty/default) — .sideline.json is read by capture/ tooling too, so this order
// is contract (see docs/data-model.md). Object spread preserves insertion
// order for these string keys, so the order below is exactly the emitted
// order.
export function serializeConfig(cfg: ConfigWrite): string {
  return JSON.stringify(
    {
      pinnedTags: cfg.pinnedTags,
      ...(cfg.hiddenTags.length ? { hiddenTags: cfg.hiddenTags } : {}),
      ...(cfg.overrides.prompts ? { prompts: cfg.overrides.prompts } : {}),
      ...(cfg.overrides.models ? { models: cfg.overrides.models } : {}),
      ...(cfg.overrides.projects ? { projects: cfg.overrides.projects } : {}),
      // Boolean override — unlike the object overrides above, `false` is a
      // meaningful value, so this checks `!== undefined` rather than
      // truthiness (a truthy check would silently drop `"claude": false`).
      ...(cfg.overrides.claude !== undefined
        ? { claude: cfg.overrides.claude }
        : {}),
      ...(cfg.zoom !== 1 ? { zoom: cfg.zoom } : {}),
      ...(cfg.overrides.audio ? { audio: cfg.overrides.audio } : {}),
      ...(cfg.overrides.hotkeys ? { hotkeys: cfg.overrides.hotkeys } : {}),
      ...(cfg.overrides.dictionary
        ? { dictionary: cfg.overrides.dictionary }
        : {}),
    },
    null,
    2,
  );
}

export function writeConfig(cfg: ConfigWrite): Promise<void> {
  return writeConfigIpc(serializeConfig(cfg));
}
