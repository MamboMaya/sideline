import { useEffect, useLayoutEffect, useRef } from "react";
import { QUICK_TAGS, tagLabel } from "../lib/format";
import type { TagEditorHook } from "../hooks/useTagEditor";

interface TagEditorProps {
  // The row currently rendering this instance — its tags, and how to
  // toggle one. Passed down explicitly by the call site (inbox card /
  // Todos row JSX) instead of the editor deriving them itself: see
  // useTagEditor's file comment.
  tags: string[];
  onToggleTag: (tag: string) => void;
  // Whether THIS row is the selected one — only the active instance ever
  // shows the input/dropdown; every other row renders just the "+" button.
  isActive: boolean;
  // Selects this row AND opens the editor (composed by the caller, e.g.
  // `() => { setSelected(revIdx); tagEditor.open(); }`).
  onOpen: () => void;
  // The single shared useTagEditor() instance from App.tsx.
  editor: TagEditorHook;
  projectTags: string[];
  pinnedTags: string[];
  togglePin: (tag: string) => void;
  hideTag: (tag: string) => void;
}

// Tag input + suggestion dropdown, opened with `a` in both views (Inbox and
// Todos). Rendered once per row; only the row whose `isActive` is true and
// whose shared `editor.tagInputOpen` is true actually shows the input —
// every other instance renders the dashed "+" affordance.
export function TagEditor({
  tags,
  onToggleTag,
  isActive,
  onOpen,
  editor,
  projectTags,
  pinnedTags,
  togglePin,
  hideTag,
}: TagEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputVisible = isActive && editor.tagInputOpen;

  // Real suggestion computation only happens for the active row — every
  // other mounted instance would otherwise redo the same knownTags scan for
  // a row nobody's editing.
  const matches = isActive ? editor.suggestMatches(tags) : [];
  const canCreate = isActive ? editor.suggestCreate(tags) : false;

  // Clamp the highlighted row if the match list shrinks out from under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  useEffect(() => {
    if (!inputVisible) return;
    editor.setSuggestIndex((i) =>
      i >= matches.length ? matches.length - 1 : i,
    );
  }, [inputVisible, matches.length]);

  // INVERSION: the dropdown is absolutely positioned inside the scrolling
  // `.cards` container, so on a bottom-most card it would render past the
  // container edge and get clipped — flip it above the card when the space
  // below can't fit the match list. The old mechanism read `cardRefs`/
  // `todosCardRefs` keyed by `view`/`selected`/`todosSelected` to find "the"
  // selected card from App-level state. This measures its OWN rendered
  // position instead: `inputRef` is the `<input>` this same component just
  // rendered, `.closest(".card")` walks up to its containing card (there's
  // exactly one — the row this instance belongs to, which is only ever
  // measured when it's actually the active+open one). Zero reads of view/
  // selection/card ref maps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  useLayoutEffect(() => {
    if (!inputVisible) return;
    const card = inputRef.current?.closest(".card");
    if (!card) return;
    const containerBottom =
      card.closest(".cards")?.getBoundingClientRect().bottom ??
      window.innerHeight;
    const spaceBelow = containerBottom - card.getBoundingClientRect().bottom;
    const estimatedHeight = (matches.length + (canCreate ? 1 : 0)) * 26 + 14;
    editor.setSuggestUp(spaceBelow < estimatedHeight);
  }, [inputVisible, matches.length, canCreate]);

  return (
    <>
      {inputVisible ? (
        <input
          ref={inputRef}
          className="tag-input"
          autoFocus
          value={editor.tagInputValue}
          onChange={(e) => {
            editor.setTagInputValue(e.target.value);
            editor.setSuggestIndex(-1);
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Tab") {
              e.preventDefault();
              if (matches.length) {
                editor.setSuggestIndex((i) => (i + 1) % matches.length);
              }
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              if (matches.length) {
                editor.setSuggestIndex(
                  (i) => (i - 1 + matches.length) % matches.length,
                );
              }
              return;
            }
            if (e.key === "Enter") {
              if (e.metaKey) {
                // ⌘Enter pins: the highlighted suggestion, or — new-tag
                // flow — creates the typed tag on the row AND pins it.
                if (editor.suggestIndex >= 0 && matches[editor.suggestIndex]) {
                  togglePin(matches[editor.suggestIndex]);
                } else if (canCreate) {
                  onToggleTag(editor.sanitizedTagInput);
                  togglePin(editor.sanitizedTagInput);
                  editor.close();
                }
                return;
              }
              if (editor.suggestIndex >= 0 && matches[editor.suggestIndex]) {
                onToggleTag(matches[editor.suggestIndex]);
              } else if (
                editor.sanitizedTagInput &&
                !tags.includes(editor.sanitizedTagInput)
              ) {
                onToggleTag(editor.sanitizedTagInput);
              }
              editor.close();
              return;
            }
            if (e.key === "Escape") editor.close();
          }}
          onBlur={editor.close}
        />
      ) : (
        <button
          type="button"
          className="tag-add"
          title="Add tag (a)"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          +
        </button>
      )}
      {inputVisible && (matches.length > 0 || canCreate) && (
        <div className={editor.suggestUp ? "suggest up" : "suggest"}>
          {canCreate && (
            <div
              className="suggest-row"
              onMouseDown={(e) => {
                // mousedown would blur the input and unmount this row
                // before its click could fire; act here instead.
                e.preventDefault();
                onToggleTag(editor.sanitizedTagInput);
                editor.close();
              }}
            >
              <span className="suggest-tag">
                #{editor.sanitizedTagInput}
                <span className="suggest-new">new</span>
              </span>
              <button
                type="button"
                className="suggest-pin"
                title="Add + pin (⌘↵)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleTag(editor.sanitizedTagInput);
                  togglePin(editor.sanitizedTagInput);
                  editor.close();
                }}
                onClick={(e) => e.stopPropagation()}
              >
                📌
              </button>
            </div>
          )}
          {matches.map((t, i) => (
            <div
              key={t}
              className={
                i === editor.suggestIndex ? "suggest-row active" : "suggest-row"
              }
              onMouseDown={(e) => {
                e.preventDefault();
                onToggleTag(t);
                editor.close();
              }}
            >
              <span
                className={
                  projectTags.includes(t)
                    ? "suggest-tag project"
                    : "suggest-tag"
                }
              >
                {tagLabel(t, projectTags)}
              </span>
              {!QUICK_TAGS.includes(t) && (
                <span className="suggest-actions">
                  <button
                    type="button"
                    className={
                      pinnedTags.includes(t)
                        ? "suggest-pin pinned"
                        : "suggest-pin"
                    }
                    title={pinnedTags.includes(t) ? "Unpin" : "Pin"}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      togglePin(t);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    📌
                  </button>
                  <button
                    type="button"
                    className="suggest-pin suggest-x"
                    title="Delete from suggestions"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      hideTag(t);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
