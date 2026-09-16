import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tagFromFolder } from "../lib/config";
import { sanitizeTag } from "../lib/format";

interface AddProjectModalProps {
  // The folder the native picker returned (tray "Add project…" or
  // Settings' "Choose folder…"). Only ever stored as a string — see
  // src-tauri/src/commands/projects.rs.
  path: string;
  projectTags: string[];
  pinnedTags: string[];
  // `.sideline.json`'s `terminal` key (undefined = auto) for the "Set up
  // repo in Terminal" hand-off — same as Ask's "Continue in Terminal".
  terminalOverride: string | undefined;
  onAdd: (tag: string, path: string, pin: boolean) => void;
  onClose: () => void;
  showToast: (message: string) => void;
}

// Two-step panel: confirm the tag (prefilled from the folder name) and
// whether to pin it, then a done state that sets the repo up — the
// CLAUDE.local.md pointer appended by a script run in the user's terminal
// (`setup_project_repo`), shown in full so what runs is visible, with a
// copy-instead fallback. Sideline never writes into the repo itself.
// Rendered like ShortcutsModal (a strip under the header) so it works on
// top of any view.
export function AddProjectModal({
  path,
  projectTags,
  pinnedTags,
  terminalOverride,
  onAdd,
  onClose,
  showToast,
}: AddProjectModalProps) {
  const [tag, setTag] = useState(() => tagFromFolder(path));
  const pinFull = pinnedTags.length >= 6;
  const [pin, setPin] = useState(!pinFull);
  const [added, setAdded] = useState<string | null>(null);
  // The setup script for the done state, fetched from Rust (the single
  // source of the snippet text) once a tag is added.
  const [script, setScript] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Ref, not a dependency: the fetch must run once per added tag, not
  // again whenever the parent re-renders with a fresh showToast closure.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    if (!added) return;
    invoke<string>("project_setup_script", { path, tag: added })
      .then(setScript)
      .catch((e) => showToastRef.current(`Setup script: ${String(e)}`));
  }, [added, path]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const clean = sanitizeTag(tag);
  const duplicate = clean !== "" && projectTags.includes(clean);
  const canAdd = clean !== "" && !duplicate;

  const add = () => {
    if (!canAdd) return;
    onAdd(clean, path, pin && !pinnedTags.includes(clean));
    setAdded(clean);
  };

  const copy = () => {
    if (!script) return;
    writeText(script).then(() => setCopied(true));
  };

  const setUpRepo = () => {
    if (!added) return;
    invoke("setup_project_repo", {
      path,
      tag: added,
      terminal: terminalOverride ?? null,
    }).catch((e) => showToast(`Couldn't open terminal: ${String(e)}`));
  };

  return (
    <div
      className="add-project"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="shortcuts-title">
        {added ? `Added #${added}` : "Add project"}
      </div>
      {/* LRM marks bracket the path: .add-project-path renders RTL to
          keep the folder NAME visible when the path overflows, and without
          strong LTR characters at both ends the bidi algorithm would drag
          the leading/trailing "/" to the wrong end. */}
      <div className="add-project-path" title={path}>
        {`\u200E${path}\u200E`}
      </div>
      {added === null ? (
        <>
          <div className="add-project-row">
            <label htmlFor="add-project-tag">Tag</label>
            <input
              id="add-project-tag"
              ref={inputRef}
              className="settings-input"
              value={tag}
              spellCheck={false}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <span className="add-project-preview">
              {clean ? `#${clean}` : ""}
            </span>
          </div>
          <div className="add-project-row">
            <label>
              <input
                type="checkbox"
                checked={pin}
                disabled={pinFull}
                onChange={(e) => setPin(e.target.checked)}
              />{" "}
              Pin tag
              {pinFull && (
                <span className="add-project-hint"> (6 pinned already)</span>
              )}
            </label>
          </div>
          {duplicate && (
            <div className="add-project-hint">
              #{clean} is already a project.
            </div>
          )}
          <div className="add-project-actions">
            <button
              type="button"
              className="add-project-primary"
              disabled={!canAdd}
              onClick={add}
            >
              Add
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="add-project-hint">
            Notes tagged #{added} route to ~/notes/todos/{added}.md. Point the
            repo's CLAUDE.local.md at it — this runs in your terminal:
          </div>
          <pre className="add-project-snippet">{script}</pre>
          <div className="add-project-actions">
            <button
              type="button"
              className="add-project-primary"
              disabled={!script}
              onClick={setUpRepo}
            >
              Set up repo in Terminal
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!script}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy command"}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
