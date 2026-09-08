// Tests for src/lib/config.ts — pure `.sideline.json` parsing/serialization
// extracted from App.tsx's loadConfig()/writeConfigFile(). loadConfig() and
// writeConfig() themselves are thin IO wrappers over the Task 10 facade and
// aren't covered here (no Tauri IPC available under vitest); parseConfig
// and serializeConfig carry all the actual logic and are pure.
import { describe, expect, test } from "vitest";
import {
  parseConfig,
  serializeConfig,
  DEFAULT_PROMPTS,
  DEFAULT_MODELS,
  mergeModels,
  mergePrompts,
  projectTagsFrom,
  projectsAdd,
  projectsRemove,
  dictionaryFromRows,
  dictionaryRows,
  splitMishears,
  addToDictionary,
  type SidelineConfig,
} from "./config";

const DEFAULTS: SidelineConfig = {
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
  overlayOverride: undefined,
  pushToTalk: false,
  pushToTalkOverride: undefined,
  dictionaryOverride: undefined,
};

// ---------------------------------------------------------------------------
// parseConfig — failure tolerance
// ---------------------------------------------------------------------------

describe("parseConfig — failure tolerance", () => {
  test("empty string produces all defaults", () => {
    expect(parseConfig("")).toEqual(DEFAULTS);
  });

  test("whitespace-only string produces all defaults", () => {
    expect(parseConfig("   \n  ")).toEqual(DEFAULTS);
  });

  test("malformed JSON produces all defaults", () => {
    expect(parseConfig("{not valid json")).toEqual(DEFAULTS);
  });

  test("valid JSON that isn't an object (e.g. a bare array) produces all defaults", () => {
    expect(parseConfig("[1,2,3]")).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — full valid config round-trip
// ---------------------------------------------------------------------------

describe("parseConfig — full valid config", () => {
  test("round-trips every known key", () => {
    const raw = JSON.stringify({
      pinnedTags: ["bug", "idea"],
      hiddenTags: ["junk"],
      prompts: { triage: "custom triage prompt" },
      models: { triage: "opus" },
      projects: { sideline: "/path/unused" },
      claude: false,
      zoom: 1.2,
      audio: { device: "AirPods" },
      hotkeys: { toggle: "alt+cmd+space", record: "alt+cmd+r" },
      overlay: { hidden: true },
      pushToTalk: true,
      dictionary: { Tauri: ["towery"], Whisper: [] },
    });
    const cfg = parseConfig(raw);
    expect(cfg.pinnedTags).toEqual(["bug", "idea"]);
    expect(cfg.hiddenTags).toEqual(["junk"]);
    expect(cfg.prompts).toEqual({
      triage: "custom triage prompt",
      batch: DEFAULT_PROMPTS.batch,
    });
    expect(cfg.promptsOverride).toEqual({ triage: "custom triage prompt" });
    expect(cfg.models).toEqual({ triage: "opus", batch: DEFAULT_MODELS.batch });
    expect(cfg.modelsOverride).toEqual({ triage: "opus" });
    expect(cfg.projectTags).toEqual(["sideline"]);
    expect(cfg.projectsOverride).toEqual({ sideline: "/path/unused" });
    expect(cfg.claude).toBe(false);
    expect(cfg.claudeOverride).toBe(false);
    expect(cfg.zoom).toBe(1.2);
    expect(cfg.audioOverride).toEqual({ device: "AirPods" });
    expect(cfg.hotkeysOverride).toEqual({
      toggle: "alt+cmd+space",
      record: "alt+cmd+r",
    });
    expect(cfg.overlayOverride).toEqual({ hidden: true });
    expect(cfg.pushToTalk).toBe(true);
    expect(cfg.pushToTalkOverride).toBe(true);
    expect(cfg.dictionaryOverride).toEqual({ Tauri: ["towery"], Whisper: [] });
  });
});

// ---------------------------------------------------------------------------
// parseConfig — pushToTalk
// ---------------------------------------------------------------------------

describe("parseConfig — pushToTalk", () => {
  test("absent key defaults to false, with no override recorded", () => {
    const cfg = parseConfig(JSON.stringify({}));
    expect(cfg.pushToTalk).toBe(false);
    expect(cfg.pushToTalkOverride).toBeUndefined();
  });

  test("pushToTalk: true is honored and recorded as an override", () => {
    const cfg = parseConfig(JSON.stringify({ pushToTalk: true }));
    expect(cfg.pushToTalk).toBe(true);
    expect(cfg.pushToTalkOverride).toBe(true);
  });

  test("pushToTalk: false is honored explicitly and still recorded as an override", () => {
    const cfg = parseConfig(JSON.stringify({ pushToTalk: false }));
    expect(cfg.pushToTalk).toBe(false);
    expect(cfg.pushToTalkOverride).toBe(false);
  });

  test("a non-boolean pushToTalk value is ignored (treated as absent, defaults to false)", () => {
    const cfg = parseConfig(JSON.stringify({ pushToTalk: "true" }));
    expect(cfg.pushToTalk).toBe(false);
    expect(cfg.pushToTalkOverride).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseConfig — dictionary
// ---------------------------------------------------------------------------

describe("parseConfig — dictionary", () => {
  test("drops non-string mis-hearings, blank terms; non-array value = no mis-hearings", () => {
    const cfg = parseConfig(
      JSON.stringify({
        dictionary: {
          Tauri: ["towery", 3, "", null, "tory"],
          "  ": ["x"],
          Raycast: "ray cast",
        },
      }),
    );
    expect(cfg.dictionaryOverride).toEqual({
      Tauri: ["towery", "tory"],
      Raycast: [],
    });
  });

  test("a non-object or empty dictionary is treated as absent", () => {
    expect(
      parseConfig(JSON.stringify({ dictionary: ["Tauri"] })).dictionaryOverride,
    ).toBeUndefined();
    expect(
      parseConfig(JSON.stringify({ dictionary: "Tauri" })).dictionaryOverride,
    ).toBeUndefined();
    expect(
      parseConfig(JSON.stringify({ dictionary: {} })).dictionaryOverride,
    ).toBeUndefined();
  });

  test("serializeConfig writes dictionary last and omits it when unset", () => {
    const base = {
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: {
        prompts: undefined,
        models: undefined,
        projects: undefined,
        claude: undefined,
        audio: undefined,
        hotkeys: { toggle: "alt+cmd+space" },
        overlay: undefined,
        pushToTalk: undefined,
        dictionary: undefined,
      },
    };
    expect(JSON.parse(serializeConfig(base))).toEqual({
      pinnedTags: [],
      hotkeys: { toggle: "alt+cmd+space" },
    });
    const withDict = serializeConfig({
      ...base,
      overrides: { ...base.overrides, dictionary: { Tauri: ["towery"] } },
    });
    expect(Object.keys(JSON.parse(withDict))).toEqual([
      "pinnedTags",
      "hotkeys",
      "dictionary",
    ]);
  });
});

// ---------------------------------------------------------------------------
// dictionaryRows / dictionaryFromRows / splitMishears — the Settings editor
// ---------------------------------------------------------------------------

describe("splitMishears", () => {
  test("splits on commas, trims, drops blanks and duplicates", () => {
    expect(splitMishears(" towery, tory ,, towery,")).toEqual([
      "towery",
      "tory",
    ]);
    expect(splitMishears("")).toEqual([]);
  });
});

describe("dictionaryFromRows", () => {
  test("builds the map, skipping blank terms and merging duplicate terms", () => {
    expect(
      dictionaryFromRows([
        { term: " Tauri ", mishears: "towery, tory" },
        { term: "", mishears: "orphan" },
        { term: "Raycast", mishears: "ray cast" },
        { term: "Tauri", mishears: "tory, taury" },
        { term: "Whisper", mishears: "" },
      ]),
    ).toEqual({
      Tauri: ["towery", "tory", "taury"],
      Raycast: ["ray cast"],
      Whisper: [],
    });
  });

  test("no usable rows yields undefined so the key is omitted", () => {
    expect(dictionaryFromRows([])).toBeUndefined();
    expect(dictionaryFromRows([{ term: "  ", mishears: "x" }])).toBeUndefined();
  });
});

describe("dictionaryRows", () => {
  test("round-trips through dictionaryFromRows", () => {
    const dict = { Tauri: ["towery", "tory"], Whisper: [] };
    const rows = dictionaryRows(dict);
    expect(rows).toEqual([
      { term: "Tauri", mishears: "towery, tory" },
      { term: "Whisper", mishears: "" },
    ]);
    expect(dictionaryFromRows(rows)).toEqual(dict);
  });

  test("undefined yields no rows", () => {
    expect(dictionaryRows(undefined)).toEqual([]);
  });
});

describe("addToDictionary", () => {
  test("new term with no prior dictionary", () => {
    expect(addToDictionary(undefined, "Tauri", "towery")).toEqual({
      Tauri: ["towery"],
    });
  });

  test("existing term gets a new mis-hearing appended", () => {
    const dict = { Tauri: ["towery"], Whisper: [] };
    expect(addToDictionary(dict, "Tauri", "tory")).toEqual({
      Tauri: ["towery", "tory"],
      Whisper: [],
    });
  });

  test("duplicate mis-hearing (any case) is not added again", () => {
    const dict = { Tauri: ["towery"] };
    expect(addToDictionary(dict, "Tauri", "TOWERY")).toEqual({
      Tauri: ["towery"],
    });
  });

  test("mishear equal to term (any case) adds the term with no new mis-hearing", () => {
    expect(addToDictionary(undefined, "Raycast", "raycast")).toEqual({
      Raycast: [],
    });
    const dict = { Raycast: ["ray cast"] };
    expect(addToDictionary(dict, "Raycast", "RAYCAST")).toEqual({
      Raycast: ["ray cast"],
    });
  });

  test("existing entries preserved in order", () => {
    const dict = { Raycast: ["ray cast"], Tauri: ["towery"] };
    expect(addToDictionary(dict, "Whisper", "wisper")).toEqual({
      Raycast: ["ray cast"],
      Tauri: ["towery"],
      Whisper: ["wisper"],
    });
    expect(Object.keys(addToDictionary(dict, "Whisper", "wisper"))).toEqual([
      "Raycast",
      "Tauri",
      "Whisper",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — pinnedTags
// ---------------------------------------------------------------------------

describe("parseConfig — pinnedTags", () => {
  test("sanitizes each tag the same way the tag editor does", () => {
    const cfg = parseConfig(
      JSON.stringify({ pinnedTags: ["  #Bug  ", "Kafka Loop"] }),
    );
    expect(cfg.pinnedTags).toEqual(["bug", "kafka-loop"]);
  });

  test("caps at 6, keeping the first 6 in order", () => {
    const tags = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const cfg = parseConfig(JSON.stringify({ pinnedTags: tags }));
    expect(cfg.pinnedTags).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("non-string entries are dropped, not just skipped-and-kept", () => {
    const cfg = parseConfig(
      JSON.stringify({ pinnedTags: ["ok", 5, null, "also-ok"] }),
    );
    expect(cfg.pinnedTags).toEqual(["ok", "also-ok"]);
  });

  test("a non-array pinnedTags value is ignored (treated as absent)", () => {
    const cfg = parseConfig(JSON.stringify({ pinnedTags: "bug" }));
    expect(cfg.pinnedTags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — zoom clamping
// ---------------------------------------------------------------------------

describe("parseConfig — zoom", () => {
  test("clamps above the 1.5 ceiling", () => {
    expect(parseConfig(JSON.stringify({ zoom: 5 })).zoom).toBe(1.5);
  });

  test("clamps below the 0.7 floor", () => {
    expect(parseConfig(JSON.stringify({ zoom: 0.1 })).zoom).toBe(0.7);
  });

  test("a value inside the range passes through unchanged", () => {
    expect(parseConfig(JSON.stringify({ zoom: 1.3 })).zoom).toBe(1.3);
  });

  test("a non-finite or non-numeric zoom falls back to the 1 default", () => {
    expect(parseConfig(JSON.stringify({ zoom: "1.5" })).zoom).toBe(1);
    expect(parseConfig(JSON.stringify({ zoom: null })).zoom).toBe(1);
    // JSON has no Infinity/NaN literal, so exercise this via a value that
    // parses to a non-finite number isn't directly expressible — a missing
    // key covers the "no numeric zoom present" branch of the same check.
    expect(parseConfig(JSON.stringify({})).zoom).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — claude (no-Claude mode)
// ---------------------------------------------------------------------------

describe("parseConfig — claude", () => {
  test("absent claude key defaults to true, with no override recorded", () => {
    const cfg = parseConfig(JSON.stringify({}));
    expect(cfg.claude).toBe(true);
    expect(cfg.claudeOverride).toBeUndefined();
  });

  test("claude: false is honored and recorded as an override", () => {
    const cfg = parseConfig(JSON.stringify({ claude: false }));
    expect(cfg.claude).toBe(false);
    expect(cfg.claudeOverride).toBe(false);
  });

  test("claude: true is honored explicitly and still recorded as an override", () => {
    const cfg = parseConfig(JSON.stringify({ claude: true }));
    expect(cfg.claude).toBe(true);
    expect(cfg.claudeOverride).toBe(true);
  });

  test("a non-boolean claude value is ignored (treated as absent, defaults to true)", () => {
    const cfg = parseConfig(JSON.stringify({ claude: "false" }));
    expect(cfg.claude).toBe(true);
    expect(cfg.claudeOverride).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseConfig — unknown keys preserved in the right override
// ---------------------------------------------------------------------------

describe("parseConfig — unknown keys preserved opaquely in overrides", () => {
  test("an unrecognized key inside prompts survives in promptsOverride", () => {
    const cfg = parseConfig(
      JSON.stringify({ prompts: { triage: "t", futureKey: "keep me" } }),
    );
    expect(cfg.promptsOverride).toEqual({ triage: "t", futureKey: "keep me" });
  });

  test("an unrecognized key inside models survives in modelsOverride", () => {
    const cfg = parseConfig(
      JSON.stringify({ models: { batch: "haiku", extra: 1 } }),
    );
    expect(cfg.modelsOverride).toEqual({ batch: "haiku", extra: 1 });
  });

  test("audio is passed through opaquely, whatever shape it has", () => {
    const cfg = parseConfig(
      JSON.stringify({ audio: { device: "AirPods", futureField: true } }),
    );
    expect(cfg.audioOverride).toEqual({ device: "AirPods", futureField: true });
  });

  test("hotkeys is passed through opaquely, whatever shape it has", () => {
    const cfg = parseConfig(
      JSON.stringify({ hotkeys: { toggle: "alt+cmd+space" } }),
    );
    expect(cfg.hotkeysOverride).toEqual({ toggle: "alt+cmd+space" });
  });
});

// ---------------------------------------------------------------------------
// parseConfig — projects -> projectTags derivation
// ---------------------------------------------------------------------------

describe("parseConfig — projects -> projectTags derivation", () => {
  test("array shape: tags are sanitized for projectTags, but the override keeps the raw array verbatim", () => {
    const cfg = parseConfig(
      JSON.stringify({ projects: ["Side Line", "kafka"] }),
    );
    expect(cfg.projectTags).toEqual(["side-line", "kafka"]);
    // Verbatim passthrough — NOT sanitized, unlike projectTags.
    expect(cfg.projectsOverride).toEqual(["Side Line", "kafka"]);
  });

  test("object (legacy tag->path) shape: projectTags are the map's raw keys — NOT sanitized (existing asymmetry vs the array shape)", () => {
    const cfg = parseConfig(
      JSON.stringify({
        projects: { "Side Line": "/some/path", kafka: "/other" },
      }),
    );
    expect(cfg.projectTags).toEqual(["Side Line", "kafka"]);
    expect(cfg.projectsOverride).toEqual({
      "Side Line": "/some/path",
      kafka: "/other",
    });
  });

  test("object shape: non-string values are filtered out of both projectTags and the override", () => {
    const cfg = parseConfig(
      JSON.stringify({
        projects: { kafka: "/path", broken: 5, alsoBroken: null },
      }),
    );
    expect(cfg.projectTags).toEqual(["kafka"]);
    expect(cfg.projectsOverride).toEqual({ kafka: "/path" });
  });

  test("neither array nor object: projects is ignored", () => {
    const cfg = parseConfig(JSON.stringify({ projects: "sideline" }));
    expect(cfg.projectTags).toEqual([]);
    expect(cfg.projectsOverride).toBeUndefined();
  });

  test("absent projects key produces no project tags and no override", () => {
    const cfg = parseConfig(JSON.stringify({}));
    expect(cfg.projectTags).toEqual([]);
    expect(cfg.projectsOverride).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeConfig
// ---------------------------------------------------------------------------

const noOverrides = {
  prompts: undefined,
  models: undefined,
  projects: undefined,
  claude: undefined,
  audio: undefined,
  hotkeys: undefined,
  overlay: undefined,
  pushToTalk: undefined,
  dictionary: undefined,
};

describe("serializeConfig", () => {
  test("only pinnedTags is emitted when everything else is empty/default", () => {
    const out = serializeConfig({
      pinnedTags: ["bug"],
      hiddenTags: [],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(out).toBe(JSON.stringify({ pinnedTags: ["bug"] }, null, 2));
    expect(JSON.parse(out)).toEqual({ pinnedTags: ["bug"] });
  });

  test("hiddenTags is omitted when empty, included when non-empty", () => {
    const withEmpty = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(JSON.parse(withEmpty)).not.toHaveProperty("hiddenTags");

    const withSome = serializeConfig({
      pinnedTags: [],
      hiddenTags: ["junk"],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(JSON.parse(withSome).hiddenTags).toEqual(["junk"]);
  });

  test("zoom is omitted at exactly 1, included otherwise", () => {
    const atDefault = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(JSON.parse(atDefault)).not.toHaveProperty("zoom");

    const zoomed = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1.2,
      overrides: noOverrides,
    });
    expect(JSON.parse(zoomed).zoom).toBe(1.2);
  });

  test("key order is pinnedTags, hiddenTags, prompts, models, projects, claude, zoom, audio, hotkeys, overlay, pushToTalk, dictionary when all are present", () => {
    const out = serializeConfig({
      pinnedTags: ["bug"],
      hiddenTags: ["junk"],
      zoom: 1.2,
      overrides: {
        prompts: { triage: "t" },
        models: { batch: "haiku" },
        projects: ["sideline"],
        claude: false,
        audio: { device: "AirPods" },
        hotkeys: { toggle: "alt+cmd+space" },
        overlay: { hidden: true },
        pushToTalk: true,
        dictionary: { Tauri: ["towery"] },
      },
    });
    expect(Object.keys(JSON.parse(out))).toEqual([
      "pinnedTags",
      "hiddenTags",
      "prompts",
      "models",
      "projects",
      "claude",
      "zoom",
      "audio",
      "hotkeys",
      "overlay",
      "pushToTalk",
      "dictionary",
    ]);
  });

  test("overlay and pushToTalk land between hotkeys and dictionary when all three are present", () => {
    const out = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: {
        ...noOverrides,
        hotkeys: { toggle: "alt+cmd+space" },
        overlay: { hidden: true },
        pushToTalk: true,
        dictionary: { Tauri: ["towery"] },
      },
    });
    expect(Object.keys(JSON.parse(out))).toEqual([
      "pinnedTags",
      "hotkeys",
      "overlay",
      "pushToTalk",
      "dictionary",
    ]);
  });

  test("pushToTalk is omitted when false or absent, included only when true", () => {
    const atDefault = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: { ...noOverrides, pushToTalk: false },
    });
    expect(JSON.parse(atDefault)).not.toHaveProperty("pushToTalk");

    const absent = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(JSON.parse(absent)).not.toHaveProperty("pushToTalk");

    const on = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: { ...noOverrides, pushToTalk: true },
    });
    expect(JSON.parse(on)).toHaveProperty("pushToTalk", true);
  });

  test("claude override is omitted when undefined (key absent, not forced to true)", () => {
    const out = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(JSON.parse(out)).not.toHaveProperty("claude");
  });

  test("claude: false round-trips as false, not omitted as falsy", () => {
    const out = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: { ...noOverrides, claude: false },
    });
    expect(JSON.parse(out)).toHaveProperty("claude", false);
  });

  test("claude: true round-trips as true", () => {
    const out = serializeConfig({
      pinnedTags: [],
      hiddenTags: [],
      zoom: 1,
      overrides: { ...noOverrides, claude: true },
    });
    expect(JSON.parse(out)).toHaveProperty("claude", true);
  });

  test("is pretty-printed with a 2-space indent, matching the original writeConfigFile output", () => {
    const out = serializeConfig({
      pinnedTags: ["bug"],
      hiddenTags: [],
      zoom: 1,
      overrides: noOverrides,
    });
    expect(out).toBe('{\n  "pinnedTags": [\n    "bug"\n  ]\n}');
  });
});

// ---------------------------------------------------------------------------
// parseConfig -> serializeConfig round-trip: overrides preserved
// ---------------------------------------------------------------------------

describe("parseConfig -> serializeConfig round-trip", () => {
  test("a parsed config's overrides (including unknown keys within them) survive being re-serialized", () => {
    const original = {
      pinnedTags: ["bug", "idea"],
      hiddenTags: ["junk"],
      prompts: { triage: "custom", futureKey: "keep me" },
      models: { batch: "opus" },
      projects: ["sideline", "otherproj"],
      claude: false,
      zoom: 0.8,
      audio: { device: "AirPods", futureField: 42 },
      hotkeys: { toggle: "alt+cmd+space" },
      pushToTalk: true,
    };
    const cfg = parseConfig(JSON.stringify(original));
    const rewritten = JSON.parse(
      serializeConfig({
        pinnedTags: cfg.pinnedTags,
        hiddenTags: cfg.hiddenTags,
        zoom: cfg.zoom,
        overrides: {
          prompts: cfg.promptsOverride,
          models: cfg.modelsOverride,
          projects: cfg.projectsOverride,
          claude: cfg.claudeOverride,
          audio: cfg.audioOverride,
          hotkeys: cfg.hotkeysOverride,
          overlay: cfg.overlayOverride,
          pushToTalk: cfg.pushToTalkOverride,
          dictionary: undefined,
        },
      }),
    );
    expect(rewritten.pinnedTags).toEqual(original.pinnedTags);
    expect(rewritten.hiddenTags).toEqual(original.hiddenTags);
    expect(rewritten.prompts).toEqual(original.prompts);
    expect(rewritten.models).toEqual(original.models);
    expect(rewritten.projects).toEqual(original.projects);
    expect(rewritten.claude).toBe(original.claude);
    expect(rewritten.zoom).toBe(original.zoom);
    expect(rewritten.audio).toEqual(original.audio);
    expect(rewritten.hotkeys).toEqual(original.hotkeys);
    expect(rewritten.pushToTalk).toBe(original.pushToTalk);
  });
});

// ---------------------------------------------------------------------------
// mergePrompts / mergeModels — the Settings pane's local recompute, factored
// out of parseConfig so both call sites share one merge rule.
// ---------------------------------------------------------------------------

describe("mergePrompts / mergeModels", () => {
  test("undefined override falls back to the defaults entirely", () => {
    expect(mergePrompts(undefined)).toEqual(DEFAULT_PROMPTS);
    expect(mergeModels(undefined)).toEqual(DEFAULT_MODELS);
  });

  test("a blank/whitespace field falls back to its default even when the key is present", () => {
    expect(mergeModels({ triage: "   " }).triage).toBe(DEFAULT_MODELS.triage);
    expect(mergePrompts({ batch: "" }).batch).toBe(DEFAULT_PROMPTS.batch);
  });

  test("a non-blank field overrides its default, the other field stays default", () => {
    const merged = mergeModels({ triage: "opus" });
    expect(merged).toEqual({ triage: "opus", batch: DEFAULT_MODELS.batch });
  });
});

// ---------------------------------------------------------------------------
// projectTagsFrom / projectsAdd / projectsRemove — Settings' Tags section
// project-routing add/remove, preserving whichever shape is on disk.
// ---------------------------------------------------------------------------

describe("projectTagsFrom", () => {
  test("undefined produces no tags", () => {
    expect(projectTagsFrom(undefined)).toEqual([]);
  });

  test("array shape is sanitized", () => {
    expect(projectTagsFrom(["Side Line", "kafka"])).toEqual([
      "side-line",
      "kafka",
    ]);
  });

  test("object shape keys are NOT sanitized (matches parseConfig's asymmetry)", () => {
    expect(projectTagsFrom({ "Side Line": "", kafka: "" })).toEqual([
      "Side Line",
      "kafka",
    ]);
  });
});

describe("projectsAdd", () => {
  test("undefined starts a brand-new array shape", () => {
    expect(projectsAdd(undefined, "sideline")).toEqual(["sideline"]);
  });

  test("array shape: appends, no duplicate on a tag already present", () => {
    expect(projectsAdd(["a"], "b")).toEqual(["a", "b"]);
    expect(projectsAdd(["a"], "a")).toEqual(["a"]);
  });

  test("object shape: adds with an empty (unused) path, preserves existing entries", () => {
    expect(projectsAdd({ a: "/path/a" }, "b")).toEqual({
      a: "/path/a",
      b: "",
    });
    // Already present: untouched, existing path not clobbered.
    expect(projectsAdd({ a: "/path/a" }, "a")).toEqual({ a: "/path/a" });
  });
});

describe("projectsRemove", () => {
  test("array shape: removes the tag, returns undefined once empty", () => {
    expect(projectsRemove(["a", "b"], "a")).toEqual(["b"]);
    expect(projectsRemove(["a"], "a")).toBeUndefined();
  });

  test("object shape: removes the entry, returns undefined once empty", () => {
    expect(projectsRemove({ a: "/x", b: "/y" }, "a")).toEqual({ b: "/y" });
    expect(projectsRemove({ a: "/x" }, "a")).toBeUndefined();
  });

  test("undefined input is returned as-is", () => {
    expect(projectsRemove(undefined, "a")).toBeUndefined();
  });
});
