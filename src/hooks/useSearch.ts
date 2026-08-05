import { useRef, useState } from "react";

// `/` search: a compact header input, filtering the active view's list
// case-insensitively against body + tags + (Todos only) project name.
export function useSearch() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Search filter (client-side only, both views). Matches case-
  // insensitively against body + tags + (Todos only) project name.
  const searchLower = searchQuery.trim().toLowerCase();
  const matchesSearch = (body: string, tags: string[], extra?: string) => {
    if (!searchLower) return true;
    if (body.toLowerCase().includes(searchLower)) return true;
    if (tags.some((t) => t.toLowerCase().includes(searchLower))) return true;
    if (extra && extra.toLowerCase().includes(searchLower)) return true;
    return false;
  };

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    searchLower,
    matchesSearch,
  };
}
