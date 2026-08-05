// Parser + serializer for ~/notes/inbox.md
// An entry starts with a line beginning "### " and runs until the next one.
// Header format: ### <icon> <YYYY-MM-DD HH:MM> #tag1 #tag2
import { needsTitle } from "./lib/format";

export interface Note {
  icon: string;
  timestamp: string;
  tags: string[];
  body: string; // lines after the header, trimmed
  raw: string; // original block, for exact round-tripping
}

export function parseInbox(text: string): { preamble: string; notes: Note[] } {
  const lines = text.split("\n");
  const notes: Note[] = [];
  const preambleLines: string[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (!current) return;
    const raw = current.join("\n");
    const header = current[0];
    const m = header.match(
      /^###\s+(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(.*)$/,
    );
    const icon = m ? m[1] : "📝";
    const timestamp = m ? m[2] : "";
    const tags = m ? [...m[3].matchAll(/#([\w-]+)/g)].map((t) => t[1]) : [];
    const body = current.slice(1).join("\n").trim();
    notes.push({ icon, timestamp, tags, body, raw });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("### ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  flush();
  return { preamble: preambleLines.join("\n").trim(), notes };
}

// Renders a tag list as the inline suffix used by every on-disk block
// header (`### <icon> <ts> #tag1 #tag2`): a leading space then `#tag` per
// tag, or "" when there are none (no trailing space before the body).
export function tagString(tags: string[]): string {
  return tags.length ? " " + tags.map((t) => `#${t}`).join(" ") : "";
}

export function serializeInbox(preamble: string, notes: Note[]): string {
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  for (const n of notes) {
    parts.push(`### ${n.icon} ${n.timestamp}${tagString(n.tags)}\n${n.body}`);
  }
  return parts.join("\n\n") + "\n";
}

// Renders one archive.md block (inbox-entry shape): `### <icon> <ts><tags>`
// header, the body, and — for a triaged note carrying a Claude reply — a
// trailing `\n\n## Claude\n\n<reply>` section. Shared by every "delete to
// archive" flow (Inbox `x`, Todos view `x` on either row kind, the 30-day
// done sweep) so the block shape can't drift between call sites.
export function archiveBlock(
  icon: string,
  timestamp: string,
  tags: string[],
  body: string,
  reply?: string | null,
): string {
  const replyPart = reply ? `\n\n## Claude\n\n${reply}` : "";
  return `### ${icon} ${timestamp}${tagString(tags)}\n${body}${replyPart}`;
}

export function slugFor(note: Note): string {
  const words = note.body
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .toLowerCase();
  const date = note.timestamp.slice(0, 10) || "undated";
  return `${date}-${words || "note"}.md`;
}

export function toTriagedFile(
  note: Note,
  appendix?: { title: string; body: string },
  noteTitle?: string,
): string {
  const front = [
    "---",
    `captured: ${note.timestamp}`,
    `type: ${note.icon}`,
    `tags: [${note.tags.join(", ")}]`,
    ...(noteTitle ? [`title: ${noteTitle}`] : []),
    "status: triaged",
    "---",
    "",
    note.body,
    "",
  ];
  if (appendix) {
    front.push(`## ${appendix.title}`, "", appendix.body, "");
  }
  return front.join("\n");
}

// Combined file for a tag-grouped batch-triage unit (2+ notes sharing a
// first tag, merged into one Claude reply). `notes` is expected in
// chronological order (oldest first, as read from inbox.md) so the first/
// last entries double as the earliest/latest captured timestamps.
export function toGroupFile(tag: string, notes: Note[], reply: string): string {
  const front = [
    "---",
    `captured: ${notes[0].timestamp} – ${notes[notes.length - 1].timestamp}`,
    "type: 📥",
    `tags: [${tag}]`,
    "status: triaged",
    `notes: ${notes.length}`,
    "---",
    "",
  ];
  for (const n of notes) {
    front.push(`### ${n.timestamp}`, "", n.body, "");
  }
  front.push("## Claude", "", reply, "");
  return front.join("\n");
}

// Parser for a single ~/notes/notes/*.md triaged file, for the sections
// view. Failure-tolerant — never throws: missing/odd frontmatter just means
// empty tags and the whole content treated as body.
export interface TriagedNote {
  filename: string;
  captured: string; // frontmatter `captured`, verbatim
  tags: string[]; // frontmatter `tags: [a, b]`
  status: string; // frontmatter `status:`, default "triaged"
  title: string | null; // frontmatter `title:`, null if absent
  body: string; // after frontmatter, before `## Claude`
  reply: string | null; // after `## Claude`, null if absent
}

export function parseTriagedFile(
  filename: string,
  content: string,
): TriagedNote {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let captured = "";
  let tags: string[] = [];
  let status = "triaged";
  let title: string | null = null;
  let rest = content;
  if (fm) {
    rest = fm[2];
    const capturedMatch = fm[1].match(/^captured:\s*(.*)$/m);
    if (capturedMatch) captured = capturedMatch[1].trim();
    const tagsMatch = fm[1].match(/^tags:\s*\[(.*)\]\s*$/m);
    if (tagsMatch) {
      tags = tagsMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    const statusMatch = fm[1].match(/^status:\s*(.*)$/m);
    if (statusMatch && statusMatch[1].trim()) status = statusMatch[1].trim();
    const titleMatch = fm[1].match(/^title:\s*(.*)$/m);
    if (titleMatch && titleMatch[1].trim()) title = titleMatch[1].trim();
  }
  const claudeIdx = rest.indexOf("\n## Claude");
  let body = rest;
  let reply: string | null = null;
  if (claudeIdx !== -1) {
    body = rest.slice(0, claudeIdx);
    reply =
      rest
        .slice(claudeIdx + "\n## Claude".length)
        .replace(/^\n+/, "")
        .trim() || null;
  }
  return { filename, captured, tags, status, title, body: body.trim(), reply };
}

// Rewrites just the frontmatter `status:` line of a triaged file (adding one
// if missing), leaving everything else — body, `## Claude` reply, other
// frontmatter fields — byte-for-byte untouched. Used by the Todos view's
// done action (`d`) on a triaged note to flip `status: triaged` <->
// `status: done` in place.
export function setTriagedStatus(content: string, status: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) {
    // No frontmatter at all — synthesize a minimal one rather than losing
    // the write.
    return `---\nstatus: ${status}\n---\n\n${content}`;
  }
  const [, fmBody, rest] = fm;
  const nextFmBody = /^status:\s*.*$/m.test(fmBody)
    ? fmBody.replace(/^status:\s*.*$/m, `status: ${status}`)
    : `${fmBody}\nstatus: ${status}`;
  return `---\n${nextFmBody}\n---\n${rest}`;
}

// Rewrites just the frontmatter `tags: [...]` line of a triaged file (adding
// one if missing), same byte-preserving contract as `setTriagedStatus`. Used
// by the Todos view's tag editing.
export function setTriagedTags(content: string, tags: string[]): string {
  const line = `tags: [${tags.join(", ")}]`;
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) {
    return `---\n${line}\n---\n\n${content}`;
  }
  const [, fmBody, rest] = fm;
  const nextFmBody = /^tags:\s*\[.*\]\s*$/m.test(fmBody)
    ? fmBody.replace(/^tags:\s*\[.*\]\s*$/m, line)
    : `${fmBody}\n${line}`;
  return `---\n${nextFmBody}\n---\n${rest}`;
}

// Rewrites a triaged file's body — the segment between the frontmatter (if
// any) and the `## Claude` reply (if any) — leaving both untouched. Used by
// the edit-in-place save (`e`) on a triaged note. Ported byte-for-byte from
// the splice saveEdit used to hand-roll inline; NOT the same fallback
// contract as setTriagedStatus/setTriagedTags: those synthesize a minimal
// frontmatter block when none is found, but this one treats the whole
// content as the body region instead, which — combined with the leading
// `\n` always prepended before the new body — produces a stray leading
// blank line for a frontmatter-less file. Similarly, a file with no
// `## Claude` reply gets a trailing blank line appended that wasn't there
// before (the `replySeg` fallback is `"\n"`, not `""`). Both are pinned as
// current behavior, not fixed here.
export function setTriagedBody(content: string, body: string): string {
  const m = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  const fm = m ? m[1] : "";
  const rest = m ? m[2] : content;
  const ci = rest.indexOf("\n## Claude");
  const replySeg = ci !== -1 ? rest.slice(ci) : "\n";
  return `${fm}\n${body}\n${replySeg}`;
}

// Todo entries in ~/notes/todos/<project>.md — same block-per-`### `-header
// shape as inbox.md, but the header's icon doubles as a status marker
// (⬜ pending / ✅ done / 🧊 iced) instead of a capture-source icon. Iced =
// deliberately parked: sessions working the queue skip it (they may ask
// about it, but shouldn't tackle it). Entries are never deleted; toggling
// status just rewrites the marker in place.
export type TodoStatus = "pending" | "done" | "iced";

export interface TodoEntry {
  status: TodoStatus;
  timestamp: string;
  tags: string[];
  // Optional Haiku-generated header line, stored on disk as a leading
  // `**title**` body line so any plain-markdown consumer (repo Claude
  // sessions, the ⧉ Copy bundle) sees it too.
  title?: string;
  body: string;
}

export const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "⬜",
  done: "✅",
  iced: "🧊",
};

// Tolerates the legacy `### 📥` header from the old sideline-todos.md
// format (pre-dates the status marker) — anything that isn't ✅ or 🧊 is
// treated as pending.
export function parseTodos(content: string): TodoEntry[] {
  const lines = content.split("\n");
  const entries: TodoEntry[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (!current) return;
    const header = current[0];
    const m = header.match(
      /^###\s+(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(.*)$/,
    );
    const icon = m ? m[1] : "⬜";
    const status: TodoStatus =
      icon === "✅" ? "done" : icon === "🧊" ? "iced" : "pending";
    const timestamp = m ? m[2] : "";
    const tags = m ? [...m[3].matchAll(/#([\w-]+)/g)].map((t) => t[1]) : [];
    let body = current.slice(1).join("\n").trim();
    // A leading `**…**` line is the entry's generated header, not body.
    let title: string | undefined;
    const titleMatch = body.match(/^\*\*(.+)\*\*\n+([\s\S]*)$/);
    if (titleMatch) {
      title = titleMatch[1].trim();
      body = titleMatch[2].trim();
    }
    entries.push({
      status,
      timestamp,
      tags,
      ...(title ? { title } : {}),
      body,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("### ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return entries;
}

// A re-routed note embeds its triage reply inline in the todo entry's body
// as a trailing `## Claude` section (see rerouteTriagedNote: body =
// `${note.body}\n\n## Claude\n\n${note.reply}`). Display-only parse: split
// it back out so a todo card shows just the note body, with the reply
// rendered separately (mirroring a triaged card's `## Claude` block) only
// once expanded. Disk format/serialization never see this split.
export function splitTodoReply(raw: string): {
  body: string;
  reply: string | null;
} {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => l === "## Claude");
  if (idx === -1) return { body: raw, reply: null };
  return {
    body: lines.slice(0, idx).join("\n").replace(/\n+$/, ""),
    reply: lines
      .slice(idx + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

// A todo row can expand/collapse when it has something worth hiding behind
// the collapse: a Haiku header, a parsed-out Claude reply, or a body long
// enough to need clamping (same heuristic as the header trigger). Anything
// else — a short, untitled, reply-less entry — has nothing more to show.
export function todoRowDisplay(entry: TodoEntry) {
  const { body, reply } = splitTodoReply(entry.body);
  return {
    body,
    reply,
    expandable: !!entry.title || !!reply || needsTitle(body),
  };
}

export function serializeTodos(entries: TodoEntry[]): string {
  if (entries.length === 0) return "";
  const parts = entries.map((e) => {
    const icon = STATUS_ICON[e.status];
    const body = e.title ? `**${e.title}**\n\n${e.body}` : e.body;
    return `### ${icon} ${e.timestamp}${tagString(e.tags)}\n\n${body}`;
  });
  return parts.join("\n\n") + "\n";
}

// A pending todo entry freshly routed from an inbox note.
export function todoEntry(note: Note, title?: string): TodoEntry {
  return {
    status: "pending",
    timestamp: note.timestamp,
    tags: note.tags,
    ...(title ? { title } : {}),
    body: note.body,
  };
}
