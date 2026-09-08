import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  archiveBlock,
  parseTriagedFile,
  type TodoEntry,
  parseTodos,
  serializeTodos,
  todoRowDisplay,
} from "./inbox";
import { QUICK_TAGS, tagLabel } from "./lib/format";
import { addToDictionary } from "./lib/config";
import { appendToArchive } from "./lib/archive";
import {
  readTriaged,
  deleteTriaged,
  readTodos,
  writeTodos,
  openTriaged,
} from "./lib/commands";
import { useToast } from "./hooks/useToast";
import { useRecorder } from "./hooks/useRecorder";
import { useConfig } from "./hooks/useConfig";
import { useSearch } from "./hooks/useSearch";
import { useInbox } from "./hooks/useInbox";
import { useTagEditor } from "./hooks/useTagEditor";
import { useTodosData } from "./hooks/useTodosData";
import { useTriage } from "./hooks/useTriage";
import { useTodosActions } from "./hooks/useTodosActions";
import { useEditRow } from "./hooks/useEditRow";
import { useKeyboard } from "./keys/useKeyboard";
import { Toast } from "./components/Toast";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { SettingsPane } from "./components/SettingsPane";
import { Header } from "./components/Header";
import { SectionHeader } from "./components/SectionHeader";
import { TodoCard } from "./components/TodoCard";
import { TriagedCard } from "./components/TriagedCard";
import { InboxCard } from "./components/InboxCard";
import { EditArea } from "./components/EditArea";

export default function App() {
  const { toast, showToast, dismissToast, runUndo } = useToast();
  const { recState, audioLevel, recElapsed, toggleRecording } =
    useRecorder(showToast);
  // Two views (`s` key / header tabs toggle inbox <-> Todos). The Todos view
  // is refetched fresh on every switch into it — the fs watcher only covers
  // ~/notes NonRecursive, so notes/ and todos/ edits never emit
  // inbox-changed.
  const [view, setView] = useState<"inbox" | "todos">("inbox");
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Settings pane (gear button in the header) — a swapped-in view over the
  // `.cards` region, not a new window; see docs/ui.md's Settings section.
  const [showSettings, setShowSettings] = useState(false);
  // True while a Settings-pane hotkey field is mid-capture — see
  // KeyContext.hotkeyCapturing's comment (src/keys/types.ts).
  const [hotkeyCapturing, setHotkeyCapturing] = useState(false);
  const {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    searchLower,
    matchesSearch,
  } = useSearch();
  const cardsContainerRef = useRef<HTMLDivElement | null>(null);

  // Every .sideline.json-backed slice (pinned/hidden tags, prompts/models,
  // project tags, overrides, zoom) plus applyConfig and the pin/hide/zoom
  // write paths — extracted verbatim to useConfig. Called before useInbox,
  // which takes applyConfig as a param. useZoom now runs inside it; its
  // only effect (body zoom style) is order-independent of every other
  // hook's effects, so the earlier registration position is inert.
  const {
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
    zoom,
    promptsOverride,
    modelsOverride,
    audioOverride,
    overlayOverride,
    pushToTalk,
    dictionaryOverride,
    unhideTag,
    setModelOverride,
    setPromptOverride,
    setClaudeEnabled,
    setAudioDevice,
    setOverlayHidden,
    setPushToTalk,
    setDictionary,
    addProject,
    removeProject,
    updateConfig,
  } = useConfig({ showToast, dismissToast });

  // Inbox view state (preamble/notes/error/selection) plus the
  // reload/auto-tag/persist motion behind it — see useInbox's file comment.
  // Called here (right after applyConfig, which it takes as a param) so its
  // mount+listener effect registers in exactly the position reload()'s used
  // to occupy — before useTodosData below.
  const {
    notes,
    error,
    selected,
    setSelected,
    cardRefs,
    notesRef,
    filteredNotes,
    persist,
    toggleTag,
    remove,
    knownTags,
  } = useInbox({
    pinnedTags,
    hiddenTags,
    projectTags,
    quickTags: QUICK_TAGS,
    applyConfig,
    matchesSearch,
    searchLower,
    showToast,
    dismissToast,
  });

  // Everything the Todos view reads: the two on-disk sources, the
  // sectioned/merged lists derived from them, and the selection that walks
  // that merged list. Called from here (rather than at the top with the
  // other hooks) so its load/selection effects register in exactly the
  // position the effects it absorbed used to occupy — before the 30-day
  // sweep below.
  const {
    collapsed,
    setCollapsed,
    triaged,
    setTriaged,
    triagedContent,
    setTriagedContent,
    triagedExpanded,
    setTriagedExpanded,
    todoExpanded,
    setTodoExpanded,
    showDone,
    setShowDone,
    todos,
    setTodos,
    todosSelected,
    setTodosSelected,
    todosCardRefs,
    pendingSelectKeyRef,
    loadTriaged,
    loadTodos,
    todosPending,
    tagSections,
    projectSections,
    icedRows,
    icedTriaged,
    mergedFlat,
    mergedIndexByKey,
    sectionKeyOf,
  } = useTodosData({ view, searchLower, matchesSearch });

  // Once per launch: done rows (both kinds) captured more than 30 days ago
  // move to archive.md — same append-only archive as `x`, nothing is
  // hard-deleted. Uses capture time as the proxy for "done long enough"
  // (done-time isn't recorded anywhere).
  const sweptRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  useEffect(() => {
    if (sweptRef.current) return;
    sweptRef.current = true;
    (async () => {
      try {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const isOld = (ts: string) => {
          const t = new Date(ts.replace(" ", "T")).getTime();
          return !Number.isNaN(t) && t < cutoff;
        };
        let archived = 0;
        const pairs = await readTodos();
        for (const [project, content] of pairs) {
          const entries = parseTodos(content);
          const stale = (e: TodoEntry) =>
            e.status === "done" && isOld(e.timestamp);
          const old = entries.filter(stale);
          if (old.length === 0) continue;
          for (const e of old) {
            await appendToArchive(
              archiveBlock("✅", e.timestamp, e.tags, e.body),
            );
          }
          await writeTodos(
            project,
            serializeTodos(entries.filter((e) => !stale(e))),
          );
          archived += old.length;
        }
        const tpairs = await readTriaged();
        for (const [filename, content] of tpairs) {
          const note = parseTriagedFile(filename, content);
          if (note.status !== "done" || !isOld(note.captured)) continue;
          await appendToArchive(
            archiveBlock("✅", note.captured, note.tags, note.body, note.reply),
          );
          await deleteTriaged(filename);
          archived++;
        }
        if (archived > 0) {
          showToast(
            `Archived ${archived} done item${archived === 1 ? "" : "s"} (30+ days old)`,
          );
          loadTriaged();
          loadTodos();
        }
      } catch {
        // Best-effort housekeeping — never block launch on it.
      }
    })();
  }, []);

  // Reopening the popover is a fresh glance: jump back to the top with a
  // clean slate (selection, search, modal). Tab switches within one open
  // session keep their place. Focus-gain ≡ reopen, since the popover hides
  // on every focus loss.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable-identity pattern — omitted deps are refs, setState, and stable/toast closures that never serve stale data
  useEffect(() => {
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      // Reopening keeps the last-used tab (user's call, reversing the
      // earlier fresh-glance default) but still resets scroll, selection,
      // and transient UI to the top.
      cardsContainerRef.current?.scrollTo({ top: 0 });
      setSelected(0);
      setTodosSelected(0);
      setSearchOpen(false);
      setSearchQuery("");
      setShowShortcuts(false);
      setShowSettings(false);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Tag editor (`a` in both views: input + suggestion dropdown). A single
  // shared instance — render call sites (inbox card JSX, Todos row JSX)
  // pass their own row's tags/onToggleTag down explicitly; see
  // useTagEditor's file comment for why it doesn't derive "the selected
  // row's tags" itself the way the old tagEditTags memo did.
  const tagEditor = useTagEditor({ knownTags, pinnedTags });

  // The two triage flows (`t`/✓ on one card, Shift+T on the whole inbox,
  // keyboard-only — see useTriage's arm/confirm comment) plus the
  // `sending`/`batchRunning`/`batchArmed` state the cards and the keyboard
  // layer read while a run is in flight or waiting on a confirm. Called
  // from here — after useTodosData, before useTodosActions — because it
  // takes `loadTodos` from the former and hands `generateTitles` to the
  // latter (re-routing a triaged note generates a header on its way out).
  const {
    sending,
    batchRunning,
    batchArmed,
    cancelBatchArm,
    generateTitles,
    triageWithClaude,
    triageBatch,
  } = useTriage({
    notesRef,
    persist,
    prompts,
    models,
    projectTags,
    claude,
    loadTodos,
    showToast,
    dismissToast,
  });

  // Every mutating action the Todos view can perform on a row — status
  // flips, tag edits, re-route, archive, copy — over the data slices
  // useTodosData owns. `generateTitles` stays here (the inbox triage flow
  // owns it) and is passed down for the re-route path.
  const {
    toggleTriagedDone,
    toggleTriagedIced,
    toggleTodoEntry,
    toggleTodoIced,
    toggleTodoExpanded,
    updateTodoTags,
    toggleTriagedTag,
    deleteTodoEntry,
    deleteTriagedNote,
    copyRow,
    copyProjectTodos,
  } = useTodosActions({
    todos,
    setTodos,
    setTodoExpanded,
    triagedContent,
    setTriaged,
    setTriagedContent,
    pendingSelectKeyRef,
    loadTodos,
    showToast,
    dismissToast,
    projectTags,
    generateTitles,
  });

  // Edit-in-place (`e`): which row is being edited, keyed per kind — inbox
  // note = its raw block, todo = project::entryIndex, triaged = filename —
  // plus the shared textarea's draft value and the 3-way save router. See
  // useEditRow's file comment; `open` is what the two `e` keybinds and the
  // five ghost ✎ buttons below call.
  const {
    editing,
    editValue,
    setEditValue,
    editCancelRef,
    open: openEdit,
    cancel: cancelEdit,
    saveEdit,
  } = useEditRow({
    notesRef,
    persist,
    todos,
    setTodos,
    loadTodos,
    triagedContent,
    setTriaged,
    setTriagedContent,
    showToast,
    dismissToast,
  });

  // Add-to-dictionary bar (EditArea's inline "Add “x” to dictionary as"
  // bar, shown on a short single-line selection while editing a note):
  // builds the new dictionary via the pure addToDictionary helper and
  // persists it through useConfig's existing setDictionary — EditArea
  // itself only owns the selection UI and the draft-text fixup.
  const onAddToDictionary = (term: string, mishear: string) => {
    const prevMishears = dictionaryOverride?.[term] ?? [];
    const recorded =
      mishear.toLowerCase() !== term.toLowerCase() &&
      !prevMishears.some((m) => m.toLowerCase() === mishear.toLowerCase());
    setDictionary(addToDictionary(dictionaryOverride, term, mishear));
    showToast(
      `Added “${term}” to the dictionary` +
        (recorded ? ` (mis-heard as “${mishear}”)` : ""),
    );
  };

  // Shared textarea instance for all three row kinds — whichever card's
  // `isEditing` is currently true renders this same element.
  const editArea = (
    <EditArea
      value={editValue}
      onChange={setEditValue}
      editCancelRef={editCancelRef}
      onCancel={cancelEdit}
      onSave={saveEdit}
      onAddToDictionary={onAddToDictionary}
    />
  );

  // Every keystroke the window sees, in one place: the tables in src/keys/
  // say what each key does, `dispatchKey` owns the layering between them,
  // and this context object is the ONLY thing they can touch. Rebuilt each
  // render and read through a ref, so there's no dependency array and no
  // stale-closure surface — see useKeyboard's comment.
  const { onSearchKeyDown } = useKeyboard({
    view,
    setView,
    showShortcuts,
    setShowShortcuts,
    settingsOpen: showSettings,
    closeSettings: () => setShowSettings(false),
    toggleSettings: () => setShowSettings((v) => !v),
    hotkeyCapturing,
    setSearchOpen,
    setSearchQuery,
    hideWindow: () => {
      getCurrentWindow().hide();
    },
    adjustZoom,
    runUndo,
    toggleRecording,
    showToast,
    tagInputOpen: tagEditor.tagInputOpen,
    openTagEditor: tagEditor.open,
    // Raw flag clear, NOT tagEditor.close() — Escape's tag-input layer
    // leaves the typed value and suggestion index alone.
    dismissTagInput: () => tagEditor.setTagInputOpen(false),
    openEdit,
    notes,
    filteredNotes,
    selected,
    setSelected,
    pinnedTags,
    toggleTag,
    sending,
    batchRunning,
    batchArmed,
    cancelBatchArm,
    triageWithClaude,
    triageBatch,
    remove,
    mergedFlat,
    todosSelected,
    setTodosSelected,
    setCollapsed,
    pendingSelectKeyRef,
    sectionKeyOf,
    setTriagedExpanded,
    toggleTodoExpanded,
    toggleTriagedDone,
    toggleTriagedIced,
    toggleTodoEntry,
    toggleTodoIced,
    deleteTriagedNote,
    deleteTodoEntry,
    copyRow,
  });

  return (
    <div className="app">
      <Header
        view={view}
        onChangeView={setView}
        notesCount={notes.length}
        todosPending={todosPending}
        recState={recState}
        audioLevel={audioLevel}
        recElapsed={recElapsed}
        showDone={showDone}
        onToggleShowDone={() => setShowDone((s) => !s)}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchInputRef={searchInputRef}
        onSearchKeyDown={onSearchKeyDown}
        onOpenSearch={() => setSearchOpen(true)}
        showShortcuts={showShortcuts}
        onToggleShortcuts={() => setShowShortcuts((v) => !v)}
        showSettings={showSettings}
        onToggleSettings={() => setShowSettings((v) => !v)}
      />
      {showShortcuts && (
        <ShortcutsModal
          hotkeysOverride={hotkeysOverride}
          onClose={() => setShowShortcuts(false)}
        />
      )}
      {showSettings ? (
        <SettingsPane
          hotkeysOverride={hotkeysOverride}
          audioOverride={audioOverride}
          setAudioDevice={setAudioDevice}
          overlayOverride={overlayOverride}
          setOverlayHidden={setOverlayHidden}
          pushToTalk={pushToTalk}
          setPushToTalk={setPushToTalk}
          dictionaryOverride={dictionaryOverride}
          setDictionary={setDictionary}
          claude={claude}
          setClaudeEnabled={setClaudeEnabled}
          models={models}
          modelsOverride={modelsOverride}
          setModelOverride={setModelOverride}
          prompts={prompts}
          promptsOverride={promptsOverride}
          setPromptOverride={setPromptOverride}
          pinnedTags={pinnedTags}
          hiddenTags={hiddenTags}
          togglePin={togglePin}
          hideTag={hideTag}
          unhideTag={unhideTag}
          projectTags={projectTags}
          addProject={addProject}
          removeProject={removeProject}
          zoom={zoom}
          adjustZoom={adjustZoom}
          updateConfig={updateConfig}
          showToast={showToast}
          onClose={() => setShowSettings(false)}
          onHotkeyCapturingChange={setHotkeyCapturing}
        />
      ) : (
        <>
          {view === "inbox" && error && <div className="error">{error}</div>}
          <div className="cards" ref={cardsContainerRef}>
            {view === "inbox" && filteredNotes.length === 0 && !error && (
              <div className="empty">
                {notes.length === 0
                  ? "Inbox zero. Go build something."
                  : "No matches."}
              </div>
            )}
            {view === "todos" && mergedFlat.length === 0 && (
              <div className="empty">
                {todos.length === 0 && triaged.length === 0
                  ? "Nothing here yet."
                  : "No matches."}
              </div>
            )}
            {view === "inbox" &&
              [...filteredNotes].reverse().map((note, revIdx) => {
                // Reference equality, NOT raw-content matching: two captures in
                // the same minute with identical text are byte-identical, and a
                // content match would give both cards the first twin's index —
                // duplicate React keys corrupt the list (a deleted card's ghost
                // can stick to the top) and × on the second twin deletes the
                // first.
                const idx = notes.indexOf(note);
                const isSelected = revIdx === selected;
                const isSending = sending.has(note.raw);
                const isEditingThis =
                  editing?.kind === "inbox" && editing.key === note.raw;
                return (
                  <InboxCard
                    key={idx}
                    note={note}
                    isSelected={isSelected}
                    isSending={isSending}
                    isEditing={isEditingThis}
                    editArea={editArea}
                    cardRef={(el) => {
                      cardRefs.current[revIdx] = el;
                    }}
                    onSelect={() => setSelected(revIdx)}
                    onEdit={() => {
                      setSelected(revIdx);
                      openEdit({ kind: "inbox", key: note.raw }, note.body);
                    }}
                    onTriage={() => triageWithClaude(idx)}
                    onDelete={() => remove(idx)}
                    onToggleTag={(t) => toggleTag(idx, t)}
                    onOpenTagEditor={() => {
                      setSelected(revIdx);
                      tagEditor.open();
                    }}
                    quickTags={QUICK_TAGS}
                    projectTags={projectTags}
                    pinnedTags={pinnedTags}
                    togglePin={togglePin}
                    hideTag={hideTag}
                    tagEditor={tagEditor}
                  />
                );
              })}
            {view === "todos" && (
              <>
                {/* Project sections first (A-Z), then tag sections (A-Z, untagged
                last) — mirrors `mergedFlat`'s section order so the rendered
                list and the keyboard-nav list always agree. */}
                {projectSections.map(({ project, rows }) => {
                  const sectionKey = `project::${project}`;
                  const isCollapsed = collapsed.has(sectionKey);
                  const headerIdx = mergedIndexByKey.get(
                    `header::${sectionKey}`,
                  );
                  const headerSelected =
                    headerIdx !== undefined && headerIdx === todosSelected;
                  return (
                    <div className="section" key={sectionKey}>
                      <SectionHeader
                        label={
                          <>
                            <span className="project-name">
                              {tagLabel(project, projectTags)}
                            </span>{" "}
                            (
                            {
                              rows.filter((r) => r.entry.status === "pending")
                                .length
                            }
                            )
                          </>
                        }
                        collapsed={isCollapsed}
                        selected={headerSelected}
                        onToggle={() => {
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(sectionKey)) next.delete(sectionKey);
                            else next.add(sectionKey);
                            return next;
                          });
                          if (!isCollapsed)
                            pendingSelectKeyRef.current = `header::${sectionKey}`;
                        }}
                        headerRef={(el) => {
                          if (headerIdx !== undefined)
                            todosCardRefs.current[headerIdx] = el;
                        }}
                        onCopy={() => copyProjectTodos(project)}
                      />
                      {!isCollapsed &&
                        rows.map((row) => {
                          const idx =
                            mergedIndexByKey.get(
                              `todo::${row.project}::${row.entryIndex}`,
                            ) ?? -1;
                          const isSelected = idx === todosSelected;
                          const isExpanded = todoExpanded.has(
                            `${row.project}::${row.entryIndex}`,
                          );
                          const isEditingThis =
                            editing?.kind === "todo" &&
                            editing.project === row.project &&
                            editing.entryIndex === row.entryIndex;
                          return (
                            <TodoCard
                              key={`${row.project}::${row.entryIndex}`}
                              variant="normal"
                              entry={row.entry}
                              isSelected={isSelected}
                              isExpanded={isExpanded}
                              isEditing={isEditingThis}
                              editArea={editArea}
                              cardRef={(el) => {
                                todosCardRefs.current[idx] = el;
                              }}
                              onSelect={() => {
                                setTodosSelected(idx);
                                // Expandable cards toggle on click, mirroring
                                // triaged cards; status stays click-the-glyph only.
                                if (todoRowDisplay(row.entry).expandable) {
                                  toggleTodoExpanded(
                                    row.project,
                                    row.entryIndex,
                                  );
                                }
                              }}
                              onEdit={() => {
                                setTodosSelected(idx);
                                openEdit(
                                  {
                                    kind: "todo",
                                    project: row.project,
                                    entryIndex: row.entryIndex,
                                  },
                                  row.entry.body,
                                );
                              }}
                              onToggleDone={() =>
                                toggleTodoEntry(row.project, row.entryIndex)
                              }
                              onToggleIced={() =>
                                toggleTodoIced(row.project, row.entryIndex)
                              }
                              onDelete={() =>
                                deleteTodoEntry(row.project, row.entryIndex)
                              }
                              onToggleTag={(t) =>
                                updateTodoTags(row.project, row.entryIndex, t)
                              }
                              onOpenTagEditor={() => {
                                setTodosSelected(idx);
                                tagEditor.open();
                              }}
                              projectTags={projectTags}
                              pinnedTags={pinnedTags}
                              togglePin={togglePin}
                              hideTag={hideTag}
                              tagEditor={tagEditor}
                            />
                          );
                        })}
                    </div>
                  );
                })}
                {tagSections.map((section) => {
                  const sectionKey = `tag::${section.tag ?? "untagged"}`;
                  const isCollapsed = collapsed.has(sectionKey);
                  const headerIdx = mergedIndexByKey.get(
                    `header::${sectionKey}`,
                  );
                  const headerSelected =
                    headerIdx !== undefined && headerIdx === todosSelected;
                  return (
                    <div className="section" key={sectionKey}>
                      <SectionHeader
                        label={
                          <>
                            {section.tag
                              ? tagLabel(section.tag, projectTags)
                              : "#untagged"}{" "}
                            ({section.notes.length})
                          </>
                        }
                        collapsed={isCollapsed}
                        selected={headerSelected}
                        onToggle={() => {
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(sectionKey)) next.delete(sectionKey);
                            else next.add(sectionKey);
                            return next;
                          });
                          if (!isCollapsed)
                            pendingSelectKeyRef.current = `header::${sectionKey}`;
                        }}
                        headerRef={(el) => {
                          if (headerIdx !== undefined)
                            todosCardRefs.current[headerIdx] = el;
                        }}
                      />
                      {!isCollapsed &&
                        section.notes.map((note) => {
                          const idx =
                            mergedIndexByKey.get(`triaged::${note.filename}`) ??
                            -1;
                          const isSelected = idx === todosSelected;
                          const isExpanded = triagedExpanded.has(note.filename);
                          const isEditingThis =
                            editing?.kind === "triaged" &&
                            editing.filename === note.filename;
                          return (
                            <TriagedCard
                              key={note.filename}
                              variant="normal"
                              note={note}
                              isSelected={isSelected}
                              isExpanded={isExpanded}
                              isEditing={isEditingThis}
                              editArea={editArea}
                              cardRef={(el) => {
                                todosCardRefs.current[idx] = el;
                              }}
                              onSelect={() => {
                                setTodosSelected(idx);
                                setTriagedExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(note.filename))
                                    next.delete(note.filename);
                                  else next.add(note.filename);
                                  return next;
                                });
                              }}
                              onEdit={() => {
                                setTodosSelected(idx);
                                openEdit(
                                  { kind: "triaged", filename: note.filename },
                                  note.body,
                                );
                              }}
                              onToggleDone={() => toggleTriagedDone(note)}
                              onToggleIced={() => toggleTriagedIced(note)}
                              onDelete={() => deleteTriagedNote(note)}
                              onOpenInEditor={() => openTriaged(note.filename)}
                              onToggleTag={(t) => toggleTriagedTag(note, t)}
                              onOpenTagEditor={() => {
                                setTodosSelected(idx);
                                tagEditor.open();
                              }}
                              projectTags={projectTags}
                              pinnedTags={pinnedTags}
                              togglePin={togglePin}
                              hideTag={hideTag}
                              tagEditor={tagEditor}
                            />
                          );
                        })}
                    </div>
                  );
                })}
                {icedRows.length + icedTriaged.length > 0 &&
                  (() => {
                    const isCollapsed = collapsed.has("icebox");
                    const headerIdx = mergedIndexByKey.get("header::icebox");
                    const headerSelected =
                      headerIdx !== undefined && headerIdx === todosSelected;
                    return (
                      <div className="section" key="icebox">
                        <SectionHeader
                          label={
                            <>
                              🧊 icebox ({icedRows.length + icedTriaged.length})
                            </>
                          }
                          collapsed={isCollapsed}
                          selected={headerSelected}
                          onToggle={() => {
                            setCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has("icebox")) next.delete("icebox");
                              else next.add("icebox");
                              return next;
                            });
                            if (!isCollapsed)
                              pendingSelectKeyRef.current = "header::icebox";
                          }}
                          headerRef={(el) => {
                            if (headerIdx !== undefined)
                              todosCardRefs.current[headerIdx] = el;
                          }}
                        />
                        {!isCollapsed &&
                          icedRows.map((row) => {
                            const idx =
                              mergedIndexByKey.get(
                                `todo::${row.project}::${row.entryIndex}`,
                              ) ?? -1;
                            const isSelected = idx === todosSelected;
                            const isExpanded = todoExpanded.has(
                              `${row.project}::${row.entryIndex}`,
                            );
                            const isEditingThis =
                              editing?.kind === "todo" &&
                              editing.project === row.project &&
                              editing.entryIndex === row.entryIndex;
                            return (
                              <TodoCard
                                key={`iced::${row.project}::${row.entryIndex}`}
                                variant="iced"
                                entry={row.entry}
                                isSelected={isSelected}
                                isExpanded={isExpanded}
                                isEditing={isEditingThis}
                                editArea={editArea}
                                cardRef={(el) => {
                                  todosCardRefs.current[idx] = el;
                                }}
                                onSelect={() => {
                                  setTodosSelected(idx);
                                  if (todoRowDisplay(row.entry).expandable) {
                                    toggleTodoExpanded(
                                      row.project,
                                      row.entryIndex,
                                    );
                                  }
                                }}
                                onEdit={() => {
                                  setTodosSelected(idx);
                                  openEdit(
                                    {
                                      kind: "todo",
                                      project: row.project,
                                      entryIndex: row.entryIndex,
                                    },
                                    row.entry.body,
                                  );
                                }}
                                onToggleDone={() =>
                                  toggleTodoEntry(row.project, row.entryIndex)
                                }
                                onToggleIced={() =>
                                  toggleTodoIced(row.project, row.entryIndex)
                                }
                                onDelete={() =>
                                  deleteTodoEntry(row.project, row.entryIndex)
                                }
                                onToggleTag={(t) =>
                                  updateTodoTags(row.project, row.entryIndex, t)
                                }
                                onOpenTagEditor={() => {
                                  setTodosSelected(idx);
                                  tagEditor.open();
                                }}
                                projectTags={projectTags}
                                pinnedTags={pinnedTags}
                                togglePin={togglePin}
                                hideTag={hideTag}
                                tagEditor={tagEditor}
                              />
                            );
                          })}
                        {!isCollapsed &&
                          icedTriaged.map((note) => {
                            const idx =
                              mergedIndexByKey.get(
                                `triaged::${note.filename}`,
                              ) ?? -1;
                            const isSelected = idx === todosSelected;
                            const isEditingThis =
                              editing?.kind === "triaged" &&
                              editing.filename === note.filename;
                            return (
                              <TriagedCard
                                key={`iced::${note.filename}`}
                                variant="iced"
                                note={note}
                                isSelected={isSelected}
                                isExpanded={triagedExpanded.has(note.filename)}
                                isEditing={isEditingThis}
                                editArea={editArea}
                                cardRef={(el) => {
                                  todosCardRefs.current[idx] = el;
                                }}
                                onSelect={() => {
                                  setTodosSelected(idx);
                                  if (note.title) {
                                    setTriagedExpanded((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(note.filename))
                                        next.delete(note.filename);
                                      else next.add(note.filename);
                                      return next;
                                    });
                                  }
                                }}
                                onEdit={() => {
                                  setTodosSelected(idx);
                                  openEdit(
                                    {
                                      kind: "triaged",
                                      filename: note.filename,
                                    },
                                    note.body,
                                  );
                                }}
                                onToggleDone={() => toggleTriagedDone(note)}
                                onToggleIced={() => toggleTriagedIced(note)}
                                onDelete={() => deleteTriagedNote(note)}
                                onToggleTag={(t) => toggleTriagedTag(note, t)}
                                onOpenTagEditor={() => {
                                  setTodosSelected(idx);
                                  tagEditor.open();
                                }}
                                projectTags={projectTags}
                                pinnedTags={pinnedTags}
                                togglePin={togglePin}
                                hideTag={hideTag}
                                tagEditor={tagEditor}
                              />
                            );
                          })}
                      </div>
                    );
                  })()}
              </>
            )}
          </div>
        </>
      )}
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
