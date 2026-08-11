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
  // docs/backend.md. Default ⇧⌘V (src-tauri/src/hotkeys.rs's
  // `default_dictate_shortcut`).
  dictate?: string;
}

// Everything loadConfig produces from `.sideline.json` — one field per
// App.tsx config state slice, including the 6 opaque per-key overrides
// (promptsOverride, modelsOverride, projectsOverride, claudeOverride,
// audioOverride, hotkeysOverride) kept around purely so a pin/zoom/hide
// write doesn't clobber hand-edited config it didn't touch.
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
};

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
    const mergedPrompts: Prompts = {
      triage:
        typeof rawPrompts?.triage === "string" && rawPrompts.triage.trim()
          ? rawPrompts.triage
          : DEFAULT_PROMPTS.triage,
      batch:
        typeof rawPrompts?.batch === "string" && rawPrompts.batch.trim()
          ? rawPrompts.batch
          : DEFAULT_PROMPTS.batch,
    };
    const rawModels =
      parsed?.models && typeof parsed.models === "object"
        ? (parsed.models as Partial<Models>)
        : undefined;
    const mergedModels: Models = {
      triage:
        typeof rawModels?.triage === "string" && rawModels.triage.trim()
          ? rawModels.triage
          : DEFAULT_MODELS.triage,
      batch:
        typeof rawModels?.batch === "string" && rawModels.batch.trim()
          ? rawModels.batch
          : DEFAULT_MODELS.batch,
    };
    let projectTags: string[] = [];
    let projectsOverride: ProjectsConfig | undefined;
    if (Array.isArray(parsed?.projects)) {
      projectTags = parsed.projects
        .map((t: unknown) => (typeof t === "string" ? sanitizeTag(t) : ""))
        .filter(Boolean);
      projectsOverride = parsed.projects;
    } else if (parsed?.projects && typeof parsed.projects === "object") {
      const rawProjects = Object.fromEntries(
        Object.entries(parsed.projects as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      projectTags = Object.keys(rawProjects);
      projectsOverride = rawProjects;
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

// The 6 opaque per-key overrides from `.sideline.json` — round-tripped
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
}

export interface ConfigWrite {
  pinnedTags: string[];
  hiddenTags: string[];
  zoom: number;
  overrides: ConfigOverrides;
}

// Byte-identical to the original writeConfigFile's JSON.stringify(..., null,
// 2) shape and key order — pinnedTags, hiddenTags?, prompts?, models?,
// projects?, claude?, zoom?, audio?, hotkeys? (omitted when falsy/empty/
// default) — .sideline.json is read by capture/ tooling too, so this order
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
    },
    null,
    2,
  );
}

export function writeConfig(cfg: ConfigWrite): Promise<void> {
  return writeConfigIpc(serializeConfig(cfg));
}
