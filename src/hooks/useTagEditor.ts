import { useState } from "react";
import { sanitizeTag } from "../lib/format";

// The tag editor (`a` in both views: input + suggestion dropdown) is a
// SINGLE logical instance — only one row can be selected/edited at a time —
// so this hook is called ONCE, in App.tsx, and its `open()` is what the `a`
// key binding calls. The row actually being edited is not known here: which
// tags are on it, and how to toggle one, come down from whichever
// `<TagEditor>` call site currently has `isActive` true (the inbox card or
// Todos row JSX render it with that row's own `tags`/`onToggleTag`). That's
// why `suggestMatches`/`suggestCreate` below are exposed as functions of a
// `tags` argument rather than memos closed over a derived "current tags"
// value (the deleted `tagEditTags` memo used to read `view`/`selected`/
// `todosSelected` to figure that out — this hook doesn't need to).
export interface UseTagEditorParams {
  knownTags: Set<string>;
  pinnedTags: string[];
}

export function useTagEditor({ knownTags, pinnedTags }: UseTagEditorParams) {
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagInputValue, setTagInputValue] = useState("");
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [suggestUp, setSuggestUp] = useState(false);

  const open = () => setTagInputOpen(true);

  const close = () => {
    setTagInputValue("");
    setSuggestIndex(-1);
    setTagInputOpen(false);
  };

  const sanitizedTagInput = sanitizeTag(tagInputValue);

  // Autocomplete matches for the row currently being edited (its `tags`
  // passed in by the caller) — pinned tags sort first, then A-Z, capped at
  // 6. Returns [] whenever the editor isn't open, so a caller can call this
  // unconditionally without its own tagInputOpen check.
  const suggestMatches = (tags: string[]): string[] => {
    if (!tagInputOpen) return [];
    const sanitizedInput = sanitizeTag(tagInputValue);
    return [...knownTags]
      .filter((t) => !tags.includes(t))
      .filter(
        (t) =>
          sanitizedInput === "" || t.toLowerCase().includes(sanitizedInput),
      )
      .sort((a, b) => {
        const ap = pinnedTags.includes(a);
        const bp = pinnedTags.includes(b);
        if (ap !== bp) return ap ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, 6);
  };

  // "Create" row: the typed tag is brand-new (not in autocomplete, not on
  // the row being edited) — offered with a 📌 so a new tag can be pinned as
  // it's created.
  const suggestCreate = (tags: string[]): boolean =>
    tagInputOpen &&
    sanitizedTagInput !== "" &&
    !knownTags.has(sanitizedTagInput) &&
    !tags.includes(sanitizedTagInput);

  return {
    tagInputOpen,
    // Raw setter, alongside open()/close(): App.tsx's window-level Escape
    // handler (absorbing one Esc when the editor is open but not itself
    // focused — see docs/ui.md) only clears the open flag, not the typed
    // value/suggestIndex, matching what it did pre-extraction.
    setTagInputOpen,
    tagInputValue,
    setTagInputValue,
    suggestIndex,
    setSuggestIndex,
    suggestUp,
    setSuggestUp,
    sanitizedTagInput,
    open,
    close,
    suggestMatches,
    suggestCreate,
  };
}

export type TagEditorHook = ReturnType<typeof useTagEditor>;
