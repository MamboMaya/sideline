import { formatHotkey } from "../lib/format";
import type { HotkeysConfig } from "../lib/config";

interface ShortcutsModalProps {
  // Raw hotkeys override from .sideline.json — formatHotkey (lib/format.ts)
  // renders each combo the way the OS will actually fire it, same as the
  // Rust-side `normalize_combo` alias table.
  hotkeysOverride: HotkeysConfig | undefined;
  onClose: () => void;
}

// The `?` shortcuts panel. Click-anywhere-to-close, per the original
// behavior (App.tsx's global keydown handler absorbs the FIRST Esc for this
// layer separately).
export function ShortcutsModal({
  hotkeysOverride,
  onClose,
}: ShortcutsModalProps) {
  return (
    <div className="shortcuts" onClick={onClose}>
      {/* Row 1: Everywhere spans the full width, items flowing down
          two columns. Row 2: Inbox left, Todos right. `o` and `c` are
          context-sensitive (act on the view / selected row) but listed
          once here since the MEANING is uniform. */}
      <div>
        <div className="shortcuts-title">Everywhere</div>
        <div className="shortcuts-grid">
          <div className="shortcut">
            <kbd>{formatHotkey(hotkeysOverride?.toggle, "⌥⌘Space")}</kbd> toggle
            popover
          </div>
          <div className="shortcut">
            <kbd>Esc</kbd> close
          </div>
          <div className="shortcut">
            <kbd>⌘1/2</kbd> switch view
          </div>
          <div className="shortcut">
            <kbd>s</kbd> toggle view
          </div>
          <div className="shortcut">
            <kbd>↑ ↓</kbd> navigate
          </div>
          <div className="shortcut">
            <kbd>/</kbd> search
          </div>
          <div className="shortcut">
            <kbd>u / ⌘Z</kbd> undo
          </div>
          <div className="shortcut">
            <kbd>⌘ + − 0</kbd> zoom / reset
          </div>
          <div className="shortcut">
            <kbd>e</kbd> edit note
          </div>
          <div className="shortcut">
            <kbd>x</kbd> archive
          </div>
          <div className="shortcut">
            <kbd>o</kbd> open in editor
          </div>
          <div className="shortcut">
            <kbd>c</kbd> copy selected
          </div>
          <div className="shortcut">
            <kbd>r / {formatHotkey(hotkeysOverride?.record, "⌥⌘R")}</kbd> record
            voice note
          </div>
        </div>
      </div>
      <div className="shortcuts-row">
        <div className="shortcuts-col">
          <div className="shortcuts-title">Inbox</div>
          <div className="shortcut">
            <kbd>1-3</kbd> quick tags
          </div>
          <div className="shortcut">
            <kbd>4-9</kbd> pinned tags
          </div>
          <div className="shortcut">
            <kbd>a</kbd> add tag
          </div>
          <div className="shortcut">
            <kbd>t</kbd> triage
          </div>
          <div className="shortcut">
            <kbd>T</kbd> triage all
          </div>
        </div>
        <div className="shortcuts-col">
          <div className="shortcuts-title">Todos</div>
          <div className="shortcut">
            <kbd>Enter</kbd> expand
          </div>
          <div className="shortcut">
            <kbd>← →</kbd> fold group
          </div>
          <div className="shortcut">
            <kbd>d</kbd> done
          </div>
          <div className="shortcut">
            <kbd>i</kbd> icebox / thaw
          </div>
          <div className="shortcut">
            <kbd>a</kbd> add tag
          </div>
          <div className="shortcut">
            <kbd>⧉</kbd> copy whole tag
          </div>
        </div>
      </div>
    </div>
  );
}
