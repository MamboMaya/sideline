// Typed facade over the Tauri IPC. One wrapper per command registered in
// src-tauri/src/lib.rs's `generate_handler!` that the frontend actually
// calls — snake_case arg keys preserved in the invoke payload (that's the
// wire shape Tauri's arg-matching expects), camelCase TS params. No
// behavior added: each wrapper is exactly `invoke<T>("name", args)`.
import { invoke } from "@tauri-apps/api/core";

// Wire shape of `read_triaged`/`read_todos`: a `Vec<(String, String)>` from
// Rust becomes a `[string, string][]` tuple array — this alias just names
// the two positions for readers on the TS side.
export type NamedFile = [name: string, content: string];

// A write refused because inbox.md no longer matches the version the
// frontend last read (something appended meanwhile). Callers reload and
// surface a toast instead of clobbering the unseen change.
export const INBOX_CONFLICT = "inbox-conflict";

// Returns [content, version]; the version token goes back into writeInbox
// as the compare-and-swap baseline.
export function readInbox(): Promise<[string, string]> {
  return invoke<[string, string]>("read_inbox");
}

// Resolves to the NEW version token on success; rejects with a message
// containing INBOX_CONFLICT when the baseline is stale.
export function writeInbox(
  content: string,
  baseVersion: string,
): Promise<string> {
  return invoke<string>("write_inbox", { content, base_version: baseVersion });
}

export function readArchive(): Promise<string> {
  return invoke<string>("read_archive");
}

export function writeArchive(content: string): Promise<void> {
  return invoke<void>("write_archive", { content });
}

export function readConfig(): Promise<string> {
  return invoke<string>("read_config");
}

export function writeConfig(content: string): Promise<void> {
  return invoke<void>("write_config", { content });
}

export function readTriaged(): Promise<NamedFile[]> {
  return invoke<NamedFile[]>("read_triaged");
}

// Overwrites an existing triaged note in place (the Library view's
// done-status flip and inline edits) — errors if the file doesn't exist.
export function writeTriaged(filename: string, content: string): Promise<void> {
  return invoke<void>("write_triaged", { filename, content });
}

// Files a new triaged note; the backend never clobbers, so the returned
// filename may differ from the one passed in (a `-1`, `-2` suffix on
// collision).
export function triageNote(filename: string, content: string): Promise<string> {
  return invoke<string>("triage_note", { filename, content });
}

export function deleteTriaged(filename: string): Promise<void> {
  return invoke<void>("delete_triaged", { filename });
}

export function readTodos(): Promise<NamedFile[]> {
  return invoke<NamedFile[]>("read_todos");
}

export function writeTodos(project: string, content: string): Promise<void> {
  return invoke<void>("write_todos", { project, content });
}

export function sendToClaude(prompt: string, model?: string): Promise<string> {
  return invoke<string>("send_to_claude", { prompt, model });
}

// Quick question (⌥⌘A / `q` — see useAsk.ts): a single-shot, web-search-
// enabled `claude` CLI call. Separate from sendToClaude because the Rust
// side runs it with different flags (WebSearch/WebFetch tools) — see
// docs/backend.md.
// Wire shape of `ask_claude`'s `AskReply`: the answer plus the CLI session
// it was produced in (null if the CLI didn't report one), which
// `openAskSession` below resumes in Terminal.
export interface AskReply {
  answer: string;
  session_id: string | null;
}

export function askClaude(question: string, model?: string): Promise<AskReply> {
  return invoke<AskReply>("ask_claude", { question, model });
}

// Resumes an Ask thread's CLI session interactively in a terminal (writes
// and `open`s a .command launcher in ~/notes — see docs/backend.md).
// `terminal` names an app from listTerminals() below; undefined/null lets
// Rust auto-pick the first installed terminal from its own preference list
// (iTerm2 first, Terminal always last and always available).
export function openAskSession(
  sessionId: string,
  terminal?: string,
): Promise<void> {
  return invoke<void>("open_ask_session", {
    session_id: sessionId,
    terminal: terminal ?? null,
  });
}

// App names (macOS `open -a` names) of installed known terminals, in
// preference order — Settings' Claude section "Continue in" dropdown
// (SettingsPane.tsx) is its one caller. `"Terminal"` is always last and
// always present.
export function listTerminals(): Promise<string[]> {
  return invoke<string[]>("list_terminals");
}

// Appends one `### <icon> <timestamp>` entry straight to inbox.md — an
// O_APPEND write like the native recorder's append_inbox_text (see
// docs/backend.md), so it can't race a frontend write_inbox the way a
// read-modify-write would. The Ask pane's ⌘S save (see useAsk.ts) is the
// only frontend caller today.
export function appendInboxEntry(icon: string, body: string): Promise<void> {
  return invoke<void>("append_inbox_entry", { icon, body });
}

export function toggleRecording(): Promise<string> {
  return invoke<string>("toggle_recording");
}

export function openTriaged(filename: string): Promise<void> {
  return invoke<void>("open_triaged", { filename });
}

export function openTodos(project: string): Promise<void> {
  return invoke<void>("open_todos", { project });
}

export function openInboxInVscode(): Promise<void> {
  return invoke<void>("open_inbox_in_vscode");
}

// Registered but not called elsewhere in the app today — the Settings
// pane's Voice section device picker is its one caller.
export function listAudioDevices(): Promise<string[]> {
  return invoke<string[]>("list_audio_devices");
}

// One result per hotkey — see src-tauri/src/hotkeys.rs's
// HotkeyApplyResult/ApplyHotkeysResponse. `ok: false` means the PREVIOUS
// shortcut is still live and `error` explains why the new one wasn't
// (invalid combo or an OS-level registration conflict); the Settings pane
// marks that field and toasts the message.
export interface HotkeyApplyResult {
  ok: boolean;
  error: string | null;
}
export interface ApplyHotkeysResponse {
  toggle: HotkeyApplyResult;
  record: HotkeyApplyResult;
  dictate: HotkeyApplyResult;
  ask: HotkeyApplyResult;
}

// Live-applies the four global hotkeys (undefined/blank = default for that
// key) — see docs/backend.md. `.sideline.json` itself is written separately
// via writeConfig; this only syncs the OS-level registration to match.
export function applyHotkeys(combos: {
  toggle?: string;
  record?: string;
  dictate?: string;
  ask?: string;
}): Promise<ApplyHotkeysResponse> {
  return invoke<ApplyHotkeysResponse>("apply_hotkeys", combos);
}

// Rejection message of pasteClipboardImage when the clipboard holds no
// image — callers decide whether that's worth a toast.
export const NO_IMAGE = "no-image";

// Saves the clipboard's image into ~/notes/inbox-assets/ and resolves to its
// notes-relative ref (`inbox-assets/shot-....png`).
export function pasteClipboardImage(): Promise<string> {
  return invoke<string>("paste_clipboard_image");
}

// Raw bytes of one inbox-assets/ file (the backend refuses any other ref).
export function readAsset(rel: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_asset", { rel });
}

// Opens one inbox-assets/ file in its default app (Preview).
export function openAsset(rel: string): Promise<void> {
  return invoke<void>("open_asset", { rel });
}

// Wire shape of src-tauri/src/reminders.rs's `Reminder` — one entry in
// ~/notes/.sideline-reminders.json (field names as Rust/serde emit them,
// same convention as AskReply's `session_id` above). `fired` flips true on
// the background tick once `due_ms` has passed, `dismissed` once the
// banner's Dismiss is clicked.
export interface Reminder {
  id: string;
  text: string;
  due_ms: number;
  note_timestamp: string;
  fired: boolean;
  dismissed: boolean;
}

// Registers a reminder detected in a note (see src/lib/reminders.ts). `id`
// must be stable across re-scans of the same note (backend upserts by it —
// see docs/backend.md), so a rescan of an unchanged note is a no-op and a
// rescan of an EDITED note updates that same reminder in place.
export function addReminder(
  id: string,
  text: string,
  dueMs: number,
  noteTimestamp: string,
): Promise<void> {
  return invoke<void>("add_reminder", {
    id,
    text,
    due_ms: dueMs,
    note_timestamp: noteTimestamp,
  });
}

// Drops a reminder. useInbox.ts calls this when a note that previously
// produced a reminder is edited and no longer parses as one
// (`includeFired` false — one that already fired stays for the banner), or
// when the note is deleted (`includeFired` true — nothing survives). Never
// called for triage: the note lives on, so its reminder stands.
export function removeReminder(
  id: string,
  includeFired: boolean,
): Promise<void> {
  return invoke<void>("remove_reminder", { id, include_fired: includeFired });
}

// Undismissed reminders, soonest due first — the banner's (fired) and
// header hint's (upcoming) one source of truth.
export function listReminders(): Promise<Reminder[]> {
  return invoke<Reminder[]>("list_reminders");
}

export function dismissReminder(id: string): Promise<void> {
  return invoke<void>("dismiss_reminder", { id });
}

// The banner's "+10 min" button: re-fires `minutes` from now.
export function snoozeReminder(id: string, minutes: number): Promise<void> {
  return invoke<void>("snooze_reminder", { id, minutes });
}

// Posts `payload` to the local classifier's `POST /decide` (see
// src/lib/classify.ts) — Rust does the actual HTTP call and rejects any
// non-loopback `url` (see docs/backend.md).
export function classifyLocal(url: string, payload: unknown): Promise<unknown> {
  return invoke<unknown>("classify_local", { url, payload });
}

// Settings pane's classifier "Test" button: `GET <url>/healthz`, rejects on
// any non-2xx response or non-loopback `url`.
export function classifierHealth(url: string): Promise<void> {
  return invoke<void>("classifier_health", { url });
}
