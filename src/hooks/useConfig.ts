import { useState } from "react";
import {
  type Prompts,
  DEFAULT_PROMPTS,
  type Models,
  DEFAULT_MODELS,
  type ProjectsConfig,
  type HotkeysConfig,
  type SidelineConfig,
  type ConfigOverrides,
  mergeModels,
  mergePrompts,
  projectTagsFrom,
  projectsAdd,
  projectsRemove,
  writeConfig,
} from "../lib/config";
import { sanitizeTag } from "../lib/format";
import { useZoom } from "./useZoom";

export interface UseConfigParams {
  showToast: (message: string, onUndo?: () => void) => void;
  dismissToast: () => void;
}

// Every `.sideline.json`-backed state slice and its persistence, extracted
// verbatim from App.tsx: the pinned/hidden tag lists, prompts/models,
// project routing tags, the five opaque overrides, zoom (useZoom is called
// from HERE so `persistZoom` and `applyConfig`'s setZoom reference sit on
// the same side of the declaration — the old App.tsx layout had applyConfig
// referencing a setZoom declared later, safe only because applyConfig is
// async-invoked), and the pin/hide/zoom write paths. `applyConfig` is the
// "load AND SET all config state" half of useInbox's reload(); it stays a
// plain closure so reload()'s deliberate dep omission keeps working — see
// useInbox's stable-identity comments.
export function useConfig({ showToast, dismissToast }: UseConfigParams) {
  const [pinnedTags, setPinnedTags] = useState<string[]>([]);
  // Tags deleted from autocomplete (mistyped junk): persisted as
  // `hiddenTags` in .sideline.json, excluded from suggestions and the
  // auto-tagger. Existing notes that carry one keep it — this only stops
  // the tag resurfacing.
  const [hiddenTags, setHiddenTags] = useState<string[]>([]);
  const [prompts, setPrompts] = useState<Prompts>(DEFAULT_PROMPTS);
  const [models, setModels] = useState<Models>(DEFAULT_MODELS);
  // Project tags a note can be routed on (see the Todos view). Paths from
  // the legacy `{tag: path}` config shape are no longer used for anything —
  // only the tag keys matter now that routing writes to Sideline's own
  // filesystem instead of the project repo.
  const [projectTags, setProjectTags] = useState<string[]>([]);
  // Raw `prompts`/`models`/`projects` objects as they appear in
  // .sideline.json (only the keys the user actually set), kept around purely
  // so persistPinnedTags doesn't clobber hand-edited config when it rewrites
  // the file.
  const [promptsOverride, setPromptsOverride] = useState<
    Partial<Prompts> | undefined
  >(undefined);
  const [modelsOverride, setModelsOverride] = useState<
    Partial<Models> | undefined
  >(undefined);
  const [projectsOverride, setProjectsOverride] = useState<
    ProjectsConfig | undefined
  >(undefined);
  // No-Claude-mode switch: `.sideline.json`'s `claude` key, merged against
  // the default of `true`. `false` routes every non-project triage flow
  // through useTriage's local, CLI-free fallback instead of `send_to_claude`.
  const [claude, setClaude] = useState(true);
  // Raw `claude` value as read from the file (undefined = key absent) — kept
  // only so a pin/zoom/hide write doesn't clobber a hand-edited `false`.
  const [claudeOverride, setClaudeOverride] = useState<boolean | undefined>(
    undefined,
  );
  // Opaque passthrough for the native recorder's `audio` config key (e.g.
  // `{ "device": "AirPods" }`, see docs/data-model.md) — no settings UI yet,
  // this just stops pin/zoom writes from erasing a hand-edited value.
  const [audioOverride, setAudioOverride] = useState<unknown>(undefined);
  // Raw `hotkeys` object from .sideline.json (Rust-side parsing owns the
  // actual shortcut behavior) — kept only so writes don't clobber a
  // hand-edited value, and so the shortcuts modal can preview the active
  // combo via formatHotkey.
  const [hotkeysOverride, setHotkeysOverride] = useState<
    HotkeysConfig | undefined
  >(undefined);

  // The 6 opaque `.sideline.json` overrides, read from current state —
  // passed straight through to writeConfig so a pin/zoom/hide write never
  // clobbers a hand-edited prompts/models/projects/claude/audio/hotkeys
  // value.
  const currentOverrides = (): ConfigOverrides => ({
    prompts: promptsOverride,
    models: modelsOverride,
    projects: projectsOverride,
    claude: claudeOverride,
    audio: audioOverride,
    hotkeys: hotkeysOverride,
  });

  const persistZoom = (next: number) => {
    writeConfig({
      pinnedTags,
      hiddenTags,
      zoom: next,
      overrides: currentOverrides(),
    });
  };
  const { zoom, setZoom, adjustZoom } = useZoom(persistZoom, showToast);

  // The Settings pane's one write path: a partial patch of any
  // `.sideline.json`-backed slice, applied to local state AND persisted in
  // one call — same read-modify-write shape as persistPinnedTags/hideTag
  // above, just parameterized over every slice instead of duplicated per
  // field. `"key" in patch` (not `patch.key !== undefined`) is what lets a
  // caller explicitly CLEAR an override to undefined (a blanked model/prompt
  // field, "Claude" toggled back to its default) — `patch.claude === false`
  // needs the same explicit-key distinction serializeConfig's own claude
  // handling needs, for the same reason.
  const updateConfig = async (patch: {
    pinnedTags?: string[];
    hiddenTags?: string[];
    zoom?: number;
    prompts?: Partial<Prompts> | undefined;
    models?: Partial<Models> | undefined;
    projects?: ProjectsConfig | undefined;
    claude?: boolean | undefined;
    audio?: unknown;
    hotkeys?: HotkeysConfig | undefined;
  }) => {
    const nextPinned = patch.pinnedTags ?? pinnedTags;
    const nextHidden = patch.hiddenTags ?? hiddenTags;
    const nextZoom = patch.zoom ?? zoom;
    const nextPromptsOverride =
      "prompts" in patch ? patch.prompts : promptsOverride;
    const nextModelsOverride =
      "models" in patch ? patch.models : modelsOverride;
    const nextProjectsOverride =
      "projects" in patch ? patch.projects : projectsOverride;
    const nextClaudeOverride =
      "claude" in patch ? patch.claude : claudeOverride;
    const nextAudioOverride = "audio" in patch ? patch.audio : audioOverride;
    const nextHotkeysOverride =
      "hotkeys" in patch ? patch.hotkeys : hotkeysOverride;

    setPinnedTags(nextPinned);
    setHiddenTags(nextHidden);
    setZoom(nextZoom);
    setPromptsOverride(nextPromptsOverride);
    setPrompts(mergePrompts(nextPromptsOverride));
    setModelsOverride(nextModelsOverride);
    setModels(mergeModels(nextModelsOverride));
    setProjectsOverride(nextProjectsOverride);
    setProjectTags(projectTagsFrom(nextProjectsOverride));
    setClaudeOverride(nextClaudeOverride);
    setClaude(nextClaudeOverride ?? true);
    setAudioOverride(nextAudioOverride);
    setHotkeysOverride(nextHotkeysOverride);

    await writeConfig({
      pinnedTags: nextPinned,
      hiddenTags: nextHidden,
      zoom: nextZoom,
      overrides: {
        prompts: nextPromptsOverride,
        models: nextModelsOverride,
        projects: nextProjectsOverride,
        claude: nextClaudeOverride,
        audio: nextAudioOverride,
        hotkeys: nextHotkeysOverride,
      },
    });
  };

  // Un-hides a tag (Settings' Tags section ✕ on a hiddenTags chip) — the
  // inverse of hideTag, no undo toast (hideTag already has one, and
  // un-hiding is itself already "the undo" of a mistaken hide).
  const unhideTag = (tag: string) => {
    const next = hiddenTags.filter((t) => t !== tag);
    if (next.length === hiddenTags.length) return;
    updateConfig({ hiddenTags: next });
  };

  // Settings' Claude section: model/prompt text inputs. A blank value
  // removes the key from the override entirely so the built-in default
  // applies (see config.ts's DEFAULT_PROMPTS/DEFAULT_MODELS) — this is the
  // ONE write path in the app that can put a key back to "unset".
  const setModelOverride = (key: keyof Models, value: string) => {
    const trimmed = value.trim();
    const next = { ...(modelsOverride ?? {}) };
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    updateConfig({ models: Object.keys(next).length ? next : undefined });
  };

  const setPromptOverride = (key: keyof Prompts, value: string) => {
    const trimmed = value.trim();
    const next = { ...(promptsOverride ?? {}) };
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    updateConfig({ prompts: Object.keys(next).length ? next : undefined });
  };

  // The Claude on/off toggle. `enabled` (the default) clears the override
  // entirely rather than writing an explicit `"claude": true` — same
  // omit-at-default convention zoom/hiddenTags already follow.
  const setClaudeEnabled = (enabled: boolean) => {
    updateConfig({ claude: enabled ? undefined : false });
  };

  // The Voice section's device picker. `device` undefined/empty = "System
  // default", which removes `audio.device` — an empty leftover `audio: {}`
  // is cleared to undefined entirely so it doesn't linger in the file for
  // no reason. Any OTHER key a hand-edit might have added under `audio` is
  // preserved (audioOverride is opaque on purpose — see its declaration).
  const setAudioDevice = (device: string) => {
    const base =
      audioOverride && typeof audioOverride === "object"
        ? (audioOverride as Record<string, unknown>)
        : {};
    let next: Record<string, unknown>;
    if (device) {
      next = { ...base, device };
    } else {
      const { device: _omit, ...rest } = base;
      next = rest;
    }
    updateConfig({ audio: Object.keys(next).length ? next : undefined });
  };

  // Settings' Tags section: add/remove a `projects` entry, preserving
  // whichever shape (array or legacy tag->path map) is already on disk —
  // see projectsAdd/projectsRemove in config.ts.
  const addProject = (tag: string) => {
    const sanitized = sanitizeTag(tag);
    if (!sanitized) return;
    updateConfig({ projects: projectsAdd(projectsOverride, sanitized) });
  };

  const removeProject = (tag: string) => {
    updateConfig({ projects: projectsRemove(projectsOverride, tag) });
  };

  // Applies a loaded SidelineConfig to the corresponding state slices — the
  // "load AND SET all config state" half of what useInbox's reload() does;
  // reload() calls it as a named step so the read+parse-inbox,
  // load+apply-config, then auto-tag order is preserved exactly.
  const applyConfig = (config: SidelineConfig) => {
    setPinnedTags(config.pinnedTags);
    setHiddenTags(config.hiddenTags);
    setPrompts(config.prompts);
    setPromptsOverride(config.promptsOverride);
    setModels(config.models);
    setModelsOverride(config.modelsOverride);
    setProjectTags(config.projectTags);
    setProjectsOverride(config.projectsOverride);
    setClaude(config.claude);
    setClaudeOverride(config.claudeOverride);
    setZoom(config.zoom);
    setAudioOverride(config.audioOverride);
    setHotkeysOverride(config.hotkeysOverride);
  };

  const persistPinnedTags = async (next: string[]) => {
    setPinnedTags(next);
    await writeConfig({
      pinnedTags: next,
      hiddenTags,
      zoom,
      overrides: currentOverrides(),
    });
  };

  // Deletes a tag from autocomplete (the suggest dropdown's ✕): adds it to
  // the persisted hiddenTags blocklist and unpins it if pinned. Notes
  // already carrying the tag keep it — this only stops it resurfacing in
  // suggestions and the auto-tagger. Undo restores both lists.
  const hideTag = (tag: string) => {
    const prevPinned = pinnedTags;
    const prevHidden = hiddenTags;
    const nextPinned = pinnedTags.filter((t) => t !== tag);
    const nextHidden = hiddenTags.includes(tag)
      ? hiddenTags
      : [...hiddenTags, tag];
    setPinnedTags(nextPinned);
    setHiddenTags(nextHidden);
    writeConfig({
      pinnedTags: nextPinned,
      hiddenTags: nextHidden,
      zoom,
      overrides: currentOverrides(),
    });
    showToast(`Deleted #${tag} from suggestions`, () => {
      setPinnedTags(prevPinned);
      setHiddenTags(prevHidden);
      writeConfig({
        pinnedTags: prevPinned,
        hiddenTags: prevHidden,
        zoom,
        overrides: currentOverrides(),
      });
      dismissToast();
    });
  };

  const togglePin = (tag: string) => {
    if (pinnedTags.includes(tag)) {
      persistPinnedTags(pinnedTags.filter((t) => t !== tag));
      return;
    }
    if (pinnedTags.length >= 6) {
      showToast("Max 6 pinned tags — unpin one first");
      return;
    }
    persistPinnedTags([...pinnedTags, tag]);
  };

  return {
    pinnedTags,
    hiddenTags,
    prompts,
    models,
    projectTags,
    claude,
    hotkeysOverride,
    applyConfig,
    togglePin,
    hideTag,
    adjustZoom,
    // Settings-pane-only surface: raw overrides (so the pane can tell "at
    // default" apart from "explicitly set", and preserve unknown sub-keys
    // when it writes one field), zoom's numeric value (adjustZoom only
    // exposes the +/-/reset actions), and the write helpers above.
    zoom,
    promptsOverride,
    modelsOverride,
    projectsOverride,
    claudeOverride,
    audioOverride,
    unhideTag,
    setModelOverride,
    setPromptOverride,
    setClaudeEnabled,
    setAudioDevice,
    addProject,
    removeProject,
    updateConfig,
  };
}
