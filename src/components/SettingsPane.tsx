import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  type DictionaryConfig,
  type DictionaryRow,
  type HotkeysConfig,
  type Models,
  type Prompts,
  dictionaryFromRows,
  dictionaryRows,
} from "../lib/config";
import { applyHotkeys, listAudioDevices } from "../lib/commands";
import {
  comboFromKeyEvent,
  formatHotkey,
  heldHotkeyModifiers,
  macHotkeyCombo,
  sanitizeTag,
} from "../lib/format";

export interface SettingsPaneProps {
  // Hotkeys
  hotkeysOverride: HotkeysConfig | undefined;
  // Voice
  audioOverride: unknown;
  setAudioDevice: (device: string) => void;
  overlayOverride: unknown;
  setOverlayHidden: (hidden: boolean) => void;
  dictionaryOverride: DictionaryConfig | undefined;
  setDictionary: (dict: DictionaryConfig | undefined) => void;
  // Claude
  claude: boolean;
  setClaudeEnabled: (enabled: boolean) => void;
  models: Models;
  modelsOverride: Partial<Models> | undefined;
  setModelOverride: (key: keyof Models, value: string) => void;
  prompts: Prompts;
  promptsOverride: Partial<Prompts> | undefined;
  setPromptOverride: (key: keyof Prompts, value: string) => void;
  // Tags
  pinnedTags: string[];
  hiddenTags: string[];
  togglePin: (tag: string) => void;
  hideTag: (tag: string) => void;
  unhideTag: (tag: string) => void;
  projectTags: string[];
  addProject: (tag: string) => void;
  removeProject: (tag: string) => void;
  // Zoom
  zoom: number;
  adjustZoom: (delta: number) => void;
  // Plumbing
  updateConfig: (patch: {
    hotkeys?: HotkeysConfig | undefined;
  }) => Promise<void>;
  showToast: (message: string) => void;
  onClose: () => void;
  // Mirrors up to App.tsx's KeyContext.hotkeyCapturing (src/keys/types.ts) —
  // called by each HotkeyCaptureField on capture start/end so the global
  // keyboard listener's Settings gate can suppress Esc/⌘, for the duration.
  onHotkeyCapturingChange: (capturing: boolean) => void;
}

type HotkeyFieldKey = "toggle" | "record" | "dictate";

const HOTKEY_FIELDS = [
  {
    key: "toggle" as const,
    label: "Toggle popover",
    placeholder: "option+cmd+space",
    fallback: "⌥⌘Space",
  },
  {
    key: "record" as const,
    label: "Record voice note",
    placeholder: "option+cmd+r",
    fallback: "⌥⌘R",
  },
  {
    key: "dictate" as const,
    label: "Dictate to clipboard",
    placeholder: "alt+cmd+v",
    fallback: "⌥⌘V",
  },
];

// Escape blurs the field rather than typing/doing nothing — dispatchKey's
// settingsOpen gate then sees a non-field target on the NEXT Escape and
// closes the pane (see useKeyboard.ts's step-0 comment).
const blurOnEscape = (e: KeyboardEvent<HTMLElement>) => {
  if (e.key === "Escape") e.currentTarget.blur();
};

// Reads `.sideline.json`'s opaque `audio.device` string back out for the
// device <select>'s current value — audioOverride is intentionally typed
// `unknown` (see useConfig's declaration), so this is the one place that
// narrows it, display-only.
function audioDeviceFrom(audioOverride: unknown): string {
  if (
    audioOverride &&
    typeof audioOverride === "object" &&
    "device" in audioOverride
  ) {
    const d = (audioOverride as Record<string, unknown>).device;
    return typeof d === "string" ? d : "";
  }
  return "";
}

// Reads `.sideline.json`'s opaque `overlay.hidden` bool back out for the
// pill toggle's current value — same narrowing shape as audioDeviceFrom
// above (overlayOverride is intentionally typed `unknown` too).
function overlayHiddenFrom(overlayOverride: unknown): boolean {
  return (
    !!overlayOverride &&
    typeof overlayOverride === "object" &&
    (overlayOverride as Record<string, unknown>).hidden === true
  );
}

// A row of chips with a trailing text-input "add" affordance — pinned tags,
// hidden tags, and project tags all share this shape, just with a different
// remove action and (for pinned/project) a cap the caller enforces itself
// (togglePin already toasts "max 6"; project/hidden tags are uncapped).
function ChipList({
  tags,
  onRemove,
  onAdd,
  addPlaceholder,
  chipClassName,
}: {
  tags: string[];
  onRemove: (tag: string) => void;
  onAdd: (tag: string) => void;
  addPlaceholder: string;
  chipClassName?: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const sanitized = sanitizeTag(draft);
    if (sanitized) onAdd(sanitized);
    setDraft("");
  };
  return (
    <div className="settings-chip-row">
      {tags.map((t) => (
        <button
          type="button"
          key={t}
          className={chipClassName ?? "tag"}
          title="Remove"
          onClick={() => onRemove(t)}
        >
          #{t} ✕
        </button>
      ))}
      <input
        className="tag-input"
        value={draft}
        placeholder={addPlaceholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else {
            blurOnEscape(e);
          }
        }}
      />
    </div>
  );
}

// The Voice section's transcription dictionary: one row per term — a term
// input, a comma-separated mis-hearings input, and a remove ✕ — plus a
// blank draft row at the bottom that turns into a real row on Enter/Add.
// Existing rows commit on blur (edits to either field); remove and add
// commit immediately. Rows mirror the override at mount only, same as the
// prompt/model drafts: the pane remounts fresh each time it opens.
const EMPTY_ROW: DictionaryRow = { term: "", mishears: "" };

function DictionaryEditor({
  dictionary,
  onChange,
}: {
  dictionary: DictionaryConfig | undefined;
  onChange: (dict: DictionaryConfig | undefined) => void;
}) {
  const [rows, setRows] = useState<DictionaryRow[]>(() =>
    dictionaryRows(dictionary),
  );
  const [draft, setDraft] = useState<DictionaryRow>(EMPTY_ROW);

  const commit = (next: DictionaryRow[]) => {
    setRows(next);
    onChange(dictionaryFromRows(next));
  };
  const edit = (i: number, patch: Partial<DictionaryRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => commit(rows.filter((_, j) => j !== i));
  const addDraft = () => {
    if (!draft.term.trim()) return;
    commit([...rows, draft]);
    setDraft(EMPTY_ROW);
  };
  const onEnter = (e: KeyboardEvent<HTMLElement>, action: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      action();
    } else {
      blurOnEscape(e);
    }
  };

  return (
    <div className="settings-dict">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional edits with no stable id; the term itself is editable
        <div className="settings-dict-row" key={i}>
          <input
            className="settings-input term"
            value={row.term}
            placeholder="Term"
            aria-label="Dictionary term"
            onChange={(e) => edit(i, { term: e.target.value })}
            onBlur={() => commit(rows)}
            onKeyDown={(e) => onEnter(e, () => e.currentTarget.blur())}
          />
          <input
            className="settings-input mishears"
            value={row.mishears}
            placeholder="mis-heard as… (comma-separated)"
            aria-label="Mis-hearings"
            onChange={(e) => edit(i, { mishears: e.target.value })}
            onBlur={() => commit(rows)}
            onKeyDown={(e) => onEnter(e, () => e.currentTarget.blur())}
          />
          <button
            type="button"
            className="ghost danger"
            title="Remove"
            onClick={() => remove(i)}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="settings-dict-row">
        <input
          className="settings-input term"
          value={draft.term}
          placeholder="Tauri"
          aria-label="New dictionary term"
          onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))}
          onKeyDown={(e) => onEnter(e, addDraft)}
        />
        <input
          className="settings-input mishears"
          value={draft.mishears}
          placeholder="towery, tory"
          aria-label="New term's mis-hearings"
          onChange={(e) =>
            setDraft((d) => ({ ...d, mishears: e.target.value }))
          }
          onKeyDown={(e) => onEnter(e, addDraft)}
        />
        <button
          type="button"
          className="ghost"
          title="Add term"
          onClick={addDraft}
          disabled={!draft.term.trim()}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// How long the "add a modifier" hint stays up after a bare-key press before
// reverting to the "press shortcut…" idle-capture text — long enough to
// read, short enough that a second attempt right after doesn't feel stuck.
const HOTKEY_HINT_MS = 1200;

// A macOS-style press-to-record hotkey field: a button (not a text input —
// there's no typing path anymore) that shows the current combo at rest and,
// once focused, captures the very next valid keystroke instead of letting
// keys do anything else. Entry is focus-triggered (click OR Tab both focus
// it) rather than requiring a separate "start" action — see the FEATURE
// spec's point 6: Enter/Space landing on an already-focused-and-capturing
// button are themselves capturable keys, not button-activation keys, so
// that's fine for keyboard-only users too.
function HotkeyCaptureField({
  id,
  value,
  placeholder,
  error,
  onCommit,
  onCapturingChange,
}: {
  id: string;
  // Current display value in Mac vocabulary (e.g. "option+cmd+r"), "" if
  // unset — same shape SettingsPane's `draft` state always held.
  value: string;
  placeholder: string;
  error: string | undefined;
  // Called with the finished combo string, or "" to clear back to default
  // (Delete/Backspace) — same two shapes commitHotkeys already handled from
  // the old text input's blur.
  onCommit: (combo: string) => void;
  onCapturingChange: (capturing: boolean) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [heldMods, setHeldMods] = useState<string[]>([]);
  const [hint, setHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const enterCapture = () => {
    setCapturing(true);
    setHeldMods([]);
    setHint(false);
    onCapturingChange(true);
  };

  const exitCapture = () => {
    setCapturing(false);
    setHeldMods([]);
    setHint(false);
    clearTimeout(hintTimer.current);
    onCapturingChange(false);
  };

  const showHint = () => {
    setHint(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(false), HOTKEY_HINT_MS);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    // Isolation: nothing typed while capturing may reach the app's global
    // keymap (src/keys/useKeyboard.ts) — every key, not just the ones this
    // field acts on.
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      exitCapture();
      e.currentTarget.blur();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      onCommit("");
      exitCapture();
      e.currentTarget.blur();
      return;
    }

    const result = comboFromKeyEvent({
      code: e.nativeEvent.code,
      metaKey: e.metaKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
    });
    if (result.modifierOnly) {
      setHeldMods(heldHotkeyModifiers(e));
      setHint(false);
      return;
    }
    if (result.combo === null) {
      showHint();
      return;
    }
    onCommit(result.combo);
    exitCapture();
    e.currentTarget.blur();
  };

  // Keeps the held-modifiers preview accurate as modifiers are released
  // (not just pressed) — same isolation as keydown, nothing leaks.
  const handleKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    setHeldMods(heldHotkeyModifiers(e));
  };

  const handleBlur = () => {
    if (capturing) exitCapture();
  };

  const displayText = capturing
    ? hint
      ? "add a modifier (⌘⌥⌃⇧)"
      : heldMods.length
        ? heldMods.join("+")
        : "press shortcut…"
    : value || placeholder;
  const isPlaceholder = !capturing && !value;

  return (
    <button
      type="button"
      id={id}
      className={[
        "settings-input",
        "settings-hotkey-btn",
        error && "error",
        capturing && "capturing",
        isPlaceholder && "placeholder",
      ]
        .filter(Boolean)
        .join(" ")}
      // onFocus alone is NOT enough to start a capture: in macOS WebKit
      // (Tauri's WKWebView), clicking a <button> does not focus it — only
      // Tab does — so a click must explicitly focus the button to get the
      // same focus→capture→blur lifecycle keyboard users get. focus() is
      // a no-op when already focused, and enterCapture is safe to re-run.
      onClick={(e) => {
        e.currentTarget.focus();
        enterCapture();
      }}
      onFocus={enterCapture}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      {displayText}
    </button>
  );
}

// The in-popover Settings pane — a swapped-in view over the `.cards` region
// (gear button in the header opens it; Esc, or the gear again, closes it —
// see App.tsx). One consolidated surface over every `.sideline.json` key;
// every control here writes through useConfig's `updateConfig` (or one of
// its per-field wrappers), same read-modify-write path as pinned-tag toggles
// use everywhere else in the app — there is no Save button. Hotkeys are the
// one section with a second write: `applyHotkeys` (Rust IPC) syncs the OS-
// level registration live, alongside the config-file write every other
// section already does alone.
export function SettingsPane({
  hotkeysOverride,
  audioOverride,
  setAudioDevice,
  overlayOverride,
  setOverlayHidden,
  dictionaryOverride,
  setDictionary,
  claude,
  setClaudeEnabled,
  models,
  modelsOverride,
  setModelOverride,
  prompts,
  promptsOverride,
  setPromptOverride,
  pinnedTags,
  hiddenTags,
  togglePin,
  hideTag,
  unhideTag,
  projectTags,
  addProject,
  removeProject,
  zoom,
  adjustZoom,
  updateConfig,
  showToast,
  onClose,
  onHotkeyCapturingChange,
}: SettingsPaneProps) {
  // Hotkeys: local draft text mirrors the override at mount (the pane
  // remounts fresh each time it opens, since App.tsx only renders it while
  // showSettings is true — no need to re-sync from props after that).
  // Displayed in Mac vocabulary (option/cmd/control/shift) regardless of
  // which alias the override was written with — see macHotkeyCombo.
  const [draft, setDraft] = useState({
    toggle: macHotkeyCombo(hotkeysOverride?.toggle),
    record: macHotkeyCombo(hotkeysOverride?.record),
    dictate: macHotkeyCombo(hotkeysOverride?.dictate),
  });
  const [hotkeyError, setHotkeyError] = useState<
    Partial<Record<HotkeyFieldKey, string>>
  >({});

  // Claude: local drafts so typing doesn't write the file on every
  // keystroke — same commit-on-blur/Enter shape as the hotkey fields above,
  // just without the live-apply half.
  const [modelDraft, setModelDraft] = useState<Models>({
    triage: modelsOverride?.triage ?? "",
    batch: modelsOverride?.batch ?? "",
  });
  const [promptDraft, setPromptDraft] = useState<Prompts>({
    triage: promptsOverride?.triage ?? "",
    batch: promptsOverride?.batch ?? "",
  });

  // Writes `.sideline.json`'s `hotkeys` key AND syncs the live OS
  // registration in one commit — called on Enter/blur of any ONE of the
  // three fields, always with all three current values (apply_hotkeys takes
  // the full trio; see docs/backend.md). A per-key failure marks that
  // field's border and toasts the reason; the previous shortcut for that
  // key stays registered Rust-side either way (apply_one never leaves a
  // hotkey dead), even though the (possibly-bad) typed value is still
  // written to the file — same tolerance load_hotkeys already has for a
  // hand-edited bad combo at next startup. Redisplays all three fields in
  // Mac vocabulary afterward, same as on load — whatever alias the user
  // typed, the field settles back to the option/cmd/control/shift spelling.
  const commitHotkeys = async (next: typeof draft) => {
    const override: HotkeysConfig = {};
    if (next.toggle.trim()) override.toggle = next.toggle.trim();
    if (next.record.trim()) override.record = next.record.trim();
    if (next.dictate.trim()) override.dictate = next.dictate.trim();
    await updateConfig({
      hotkeys: Object.keys(override).length ? override : undefined,
    });
    const res = await applyHotkeys({
      toggle: override.toggle,
      record: override.record,
      dictate: override.dictate,
    });
    const errs: typeof hotkeyError = {};
    for (const { key, label } of HOTKEY_FIELDS) {
      const result = res[key];
      if (!result.ok) {
        errs[key] = result.error ?? "Couldn't register";
        showToast(
          `${label} hotkey: ${errs[key]} — keeping the previous shortcut`,
        );
      }
    }
    setHotkeyError(errs);
    setDraft({
      toggle: macHotkeyCombo(override.toggle),
      record: macHotkeyCombo(override.record),
      dictate: macHotkeyCombo(override.dictate),
    });
  };

  // One HotkeyCaptureField's onCommit: a finished capture (or Delete/
  // Backspace's clear-to-"") for a SINGLE key, folded into the other two
  // fields' current draft values and committed through commitHotkeys —
  // same all-three-at-once shape apply_hotkeys always required, just
  // triggered by a capture completing instead of a blur.
  const commitField = (key: HotkeyFieldKey, combo: string) => {
    const next = { ...draft, [key]: combo };
    setDraft(next);
    commitHotkeys(next);
  };

  // Voice: device list is enumerated once on mount via the
  // already-registered-but-previously-unused list_audio_devices command.
  const [devices, setDevices] = useState<string[]>([]);
  useEffect(() => {
    listAudioDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);
  const currentDevice = audioDeviceFrom(audioOverride);
  const overlayHidden = overlayHiddenFrom(overlayOverride);

  return (
    <div className="settings">
      <div className="settings-header">
        <span className="settings-title">Settings</span>
        <button
          type="button"
          className="ghost"
          title="Close (Esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {/* ── 1. Hotkeys ─────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section-title">Hotkeys</div>
        {HOTKEY_FIELDS.map(({ key, label, placeholder, fallback }) => (
          <div className="settings-row settings-row-column" key={key}>
            <label className="settings-label" htmlFor={`hotkey-${key}`}>
              {label}
            </label>
            <div className="settings-field">
              <HotkeyCaptureField
                id={`hotkey-${key}`}
                value={draft[key]}
                placeholder={placeholder}
                error={hotkeyError[key]}
                onCommit={(combo) => commitField(key, combo)}
                onCapturingChange={onHotkeyCapturingChange}
              />
              <span className="settings-hint">
                currently {formatHotkey(hotkeysOverride?.[key], fallback)}
              </span>
              {hotkeyError[key] && (
                <span className="settings-error">{hotkeyError[key]}</span>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* ── 2. Voice ───────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section-title">Voice</div>
        <div className="settings-row">
          <label className="settings-label" htmlFor="audio-device">
            Input device
          </label>
          <div className="settings-field">
            <select
              id="audio-device"
              className="settings-input"
              value={currentDevice}
              onChange={(e) => setAudioDevice(e.target.value)}
            >
              <option value="">System default</option>
              {devices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              {currentDevice && !devices.includes(currentDevice) && (
                <option value={currentDevice}>
                  {currentDevice} (not connected)
                </option>
              )}
            </select>
            <span className="settings-hint">
              Takes effect on the next recording.
            </span>
          </div>
        </div>
        <div className="settings-subrow">
          <div className="settings-sublabel">Dictionary</div>
          <DictionaryEditor
            dictionary={dictionaryOverride}
            onChange={setDictionary}
          />
          <span className="settings-hint">
            Terms nudge the transcriber toward the right spelling; mis-hearings
            are replaced after transcription (whole words, any case). Applies to
            the next recording.
          </span>
        </div>
        <div className="settings-row">
          <label className="settings-label" htmlFor="overlay-toggle">
            Show recording pill
          </label>
          <button
            id="overlay-toggle"
            type="button"
            className={overlayHidden ? "ghost" : "ghost active"}
            onClick={() => setOverlayHidden(!overlayHidden)}
          >
            {overlayHidden ? "Off" : "On"}
          </button>
        </div>
        <div className="settings-hint">
          Off hides the on-screen pill (e.g. while screen sharing); the tray
          still shows 🔴 REC.
        </div>
      </section>

      {/* ── 3. Claude ──────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section-title">Claude</div>
        <div className="settings-row">
          <label className="settings-label" htmlFor="claude-toggle">
            Use Claude for triage
          </label>
          <button
            id="claude-toggle"
            type="button"
            className={claude ? "ghost active" : "ghost"}
            onClick={() => setClaudeEnabled(!claude)}
          >
            {claude ? "On" : "Off"}
          </button>
        </div>
        {(["triage", "batch"] as const).map((key) => (
          <div className="settings-row" key={`model-${key}`}>
            <label className="settings-label" htmlFor={`model-${key}`}>
              {key === "triage" ? "Triage model" : "Batch model"}
            </label>
            <input
              id={`model-${key}`}
              className="settings-input"
              value={modelDraft[key]}
              placeholder={models[key]}
              onChange={(e) =>
                setModelDraft((d) => ({ ...d, [key]: e.target.value }))
              }
              onBlur={() => setModelOverride(key, modelDraft[key])}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else blurOnEscape(e);
              }}
            />
          </div>
        ))}
        {(["triage", "batch"] as const).map((key) => (
          <div
            className="settings-row settings-row-column"
            key={`prompt-${key}`}
          >
            <label className="settings-label" htmlFor={`prompt-${key}`}>
              {key === "triage" ? "Triage prompt" : "Batch prompt"}
            </label>
            <textarea
              id={`prompt-${key}`}
              className="settings-textarea"
              value={promptDraft[key]}
              placeholder={prompts[key]}
              onChange={(e) =>
                setPromptDraft((d) => ({ ...d, [key]: e.target.value }))
              }
              onBlur={() => setPromptOverride(key, promptDraft[key])}
              onKeyDown={blurOnEscape}
            />
          </div>
        ))}
        <div className="settings-hint">
          Blank restores the built-in default. Prompt/model changes only save
          when you click away from the field.
        </div>
      </section>

      {/* ── 4. Tags ────────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section-title">Tags</div>
        <div className="settings-subrow">
          <div className="settings-sublabel">Pinned (max 6)</div>
          <ChipList
            tags={pinnedTags}
            onRemove={togglePin}
            onAdd={togglePin}
            addPlaceholder="add pinned tag…"
          />
        </div>
        <div className="settings-subrow">
          <div className="settings-sublabel">Hidden from suggestions</div>
          <ChipList
            tags={hiddenTags}
            onRemove={unhideTag}
            onAdd={hideTag}
            addPlaceholder="hide tag…"
          />
        </div>
        <div className="settings-subrow">
          <div className="settings-sublabel">Project routing</div>
          <ChipList
            tags={projectTags}
            onRemove={removeProject}
            onAdd={addProject}
            addPlaceholder="add project tag…"
            chipClassName="tag project"
          />
        </div>
      </section>

      {/* ── 5. Zoom ────────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section-title">Zoom</div>
        <div className="settings-row">
          <label className="settings-label" htmlFor="zoom-value">
            UI scale (⌘+ / ⌘− / ⌘0)
          </label>
          <div className="settings-field settings-zoom">
            <button
              type="button"
              className="ghost"
              onClick={() => adjustZoom(-0.1)}
            >
              −
            </button>
            <span id="zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className="ghost"
              onClick={() => adjustZoom(0.1)}
            >
              +
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => adjustZoom(0)}
            >
              Reset
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
