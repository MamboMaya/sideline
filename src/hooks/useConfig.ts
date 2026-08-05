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
  writeConfig,
} from "../lib/config";
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

  // The 5 opaque `.sideline.json` overrides, read from current state —
  // passed straight through to writeConfig so a pin/zoom/hide write never
  // clobbers a hand-edited prompts/models/projects/audio/hotkeys value.
  const currentOverrides = (): ConfigOverrides => ({
    prompts: promptsOverride,
    models: modelsOverride,
    projects: projectsOverride,
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
    hotkeysOverride,
    applyConfig,
    togglePin,
    hideTag,
    adjustZoom,
  };
}
