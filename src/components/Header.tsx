import type { KeyboardEvent } from "react";
import type { useRecorder } from "../hooks/useRecorder";
import type { useSearch } from "../hooks/useSearch";
import { RecBars } from "./RecBars";

interface HeaderProps {
  view: "inbox" | "todos";
  onChangeView: (view: "inbox" | "todos") => void;
  notesCount: number;
  todosPending: number;
  // Recorder state, threaded straight from useRecorder — drives the rec
  // indicator (dot + elapsed + level bars while recording, status text while
  // transcribing/downloading the model).
  recState: ReturnType<typeof useRecorder>["recState"];
  audioLevel: number;
  recElapsed: number;
  batchRunning: boolean;
  onTriageBatch: () => void;
  showDone: boolean;
  onToggleShowDone: () => void;
  searchOpen: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchInputRef: ReturnType<typeof useSearch>["searchInputRef"];
  // Owns list navigation/Escape/Enter behavior for the search box — stays
  // defined in App.tsx (Task 19 will replace it with keymap reuse), passed
  // down as-is.
  onSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onOpenSearch: () => void;
  showShortcuts: boolean;
  onToggleShortcuts: () => void;
  showSettings: boolean;
  onToggleSettings: () => void;
}

// Tabs, rec indicator, batch/show-done actions, search box, shortcuts
// toggle. Every handler is owned by App.tsx and threaded down as a prop.
export function Header({
  view,
  onChangeView,
  notesCount,
  todosPending,
  recState,
  audioLevel,
  recElapsed,
  batchRunning,
  onTriageBatch,
  showDone,
  onToggleShowDone,
  searchOpen,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
  onSearchKeyDown,
  onOpenSearch,
  showShortcuts,
  onToggleShortcuts,
  showSettings,
  onToggleSettings,
}: HeaderProps) {
  return (
    <header>
      <div className="tabs">
        <button
          type="button"
          className={view === "inbox" ? "tab active" : "tab"}
          title="⌘1 · s toggles"
          onClick={() => onChangeView("inbox")}
        >
          Inbox ({notesCount})
        </button>
        <button
          type="button"
          className={view === "todos" ? "tab active" : "tab"}
          title="⌘2 · s toggles"
          onClick={() => onChangeView("todos")}
        >
          Todos ({todosPending})
        </button>
      </div>
      <div className="header-spacer" />
      {recState !== "idle" && (
        <div className="rec-indicator" title="Voice note recording (r)">
          {recState === "recording" && (
            <>
              <span className="rec-dot" />
              <span className="rec-elapsed">
                {Math.floor(recElapsed / 60)}:
                {String(recElapsed % 60).padStart(2, "0")}
              </span>
              <RecBars audioLevel={audioLevel} />
            </>
          )}
          {recState === "transcribing" && (
            <span className="rec-status">transcribing…</span>
          )}
          {recState === "downloading-model" && (
            <span className="rec-status">downloading model…</span>
          )}
        </div>
      )}
      {view === "inbox" && (
        <button
          type="button"
          className="ghost"
          title="Triage all notes — one Claude call (T)"
          disabled={notesCount === 0 || batchRunning}
          onClick={onTriageBatch}
        >
          ✨ All ({notesCount})
        </button>
      )}
      {view === "todos" && (
        <button
          type="button"
          className={showDone ? "ghost active" : "ghost"}
          title="Toggle visibility of done items"
          onClick={onToggleShowDone}
        >
          Show done
        </button>
      )}
      {searchOpen ? (
        <input
          ref={searchInputRef}
          className="search-input"
          autoFocus
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search…"
          title="Search (/)"
        />
      ) : (
        <button
          type="button"
          className="ghost"
          title="Search (/)"
          onClick={onOpenSearch}
        >
          🔍
        </button>
      )}
      <button
        type="button"
        className={showShortcuts ? "ghost active" : "ghost"}
        title="Keyboard shortcuts (?)"
        onClick={onToggleShortcuts}
      >
        ?
      </button>
      <button
        type="button"
        className={showSettings ? "ghost gear active" : "ghost gear"}
        title="Settings (⌘,)"
        onClick={onToggleSettings}
      >
        ⚙
      </button>
    </header>
  );
}
