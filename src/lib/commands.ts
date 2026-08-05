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

export function readInbox(): Promise<string> {
  return invoke<string>("read_inbox");
}

export function writeInbox(content: string): Promise<void> {
  return invoke<void>("write_inbox", { content });
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
