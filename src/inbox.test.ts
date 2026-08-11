// Tests for the ~/notes format parser/serializer (src/inbox.ts). Fixtures
// are built from the documented formats in docs/data-model.md so a mismatch
// here is also a doc-accuracy signal.
//
// Core invariant under test (CLAUDE.md): "round-trips must be lossless for
// untouched entries" — parseInbox -> serializeInbox and parseTodos ->
// serializeTodos must reproduce realistic input byte-for-byte.
import { describe, expect, test } from "vitest";
import {
  parseInbox,
  serializeInbox,
  tagString,
  archiveBlock,
  parseTriagedFile,
  setTriagedStatus,
  setTriagedTags,
  setTriagedBody,
  parseTodos,
  serializeTodos,
  splitTodoReply,
  todoRowDisplay,
  toTriagedFile,
  toGroupFile,
  slugFor,
  todoEntry,
  patchTodoTitle,
  type Note,
  type TodoEntry,
} from "./inbox";

// ---------------------------------------------------------------------------
// parseInbox / serializeInbox
// ---------------------------------------------------------------------------

describe("parseInbox", () => {
  test("parses each source icon header — voice with tags, link with none, screenshot with one", () => {
    const voice = parseInbox(
      "### 🎙️ 2026-07-29 14:32 #bug #kafka\nThe consumer group keeps rebalancing when...\n",
    ).notes[0];
    expect(voice).toMatchObject({
      icon: "🎙️",
      timestamp: "2026-07-29 14:32",
      tags: ["bug", "kafka"],
      body: "The consumer group keeps rebalancing when...",
    });

    const link = parseInbox(
      "### 🔗 2026-07-29 15:03\nhttps://example.com/some-article\n",
    ).notes[0];
    expect(link.icon).toBe("🔗");
    expect(link.tags).toEqual([]);
    expect(link.body).toBe("https://example.com/some-article");

    const shot = parseInbox(
      "### 📸 2026-07-29 15:10 #ui\n![screenshot](inbox-assets/shot-20260729-151000.png)\n",
    ).notes[0];
    expect(shot.icon).toBe("📸");
    expect(shot.tags).toEqual(["ui"]);
    expect(shot.body).toBe(
      "![screenshot](inbox-assets/shot-20260729-151000.png)",
    );
  });

  test("parses multi-tag headers in order", () => {
    const { notes } = parseInbox(
      "### 🎙️ 2026-07-29 14:32 #bug #kafka #urgent\nbody\n",
    );
    expect(notes[0].tags).toEqual(["bug", "kafka", "urgent"]);
  });

  test("parses a multi-line body, preserving internal blank lines", () => {
    const text =
      "### 🎙️ 2026-07-29 14:32 #kafka\n" +
      "First paragraph.\n" +
      "\n" +
      "Second paragraph.\n";
    const { notes } = parseInbox(text);
    expect(notes[0].body).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("parses entries with empty bodies, mid-file and at end-of-file", () => {
    const midFile = parseInbox(
      "### 🎙️ 2026-07-29 14:32\n### 🔗 2026-07-29 15:00\nhttp://x\n",
    ).notes;
    expect(midFile).toHaveLength(2);
    expect(midFile[0].body).toBe("");

    const eof = parseInbox("### 🎙️ 2026-07-29 14:32\n").notes;
    expect(eof).toHaveLength(1);
    expect(eof[0].body).toBe("");
  });

  test("collects preamble text before the first entry", () => {
    const text = "<!-- do not hand-edit -->\n\n### 🎙️ 2026-07-29 14:32\nbody\n";
    const { preamble, notes } = parseInbox(text);
    expect(preamble).toBe("<!-- do not hand-edit -->");
    expect(notes).toHaveLength(1);
  });

  test("does not throw on malformed headers — missing timestamp, or a bare '### '", () => {
    expect(() => parseInbox("### just some text\nbody\n")).not.toThrow();
    const noTimestamp = parseInbox("### just some text\nbody\n").notes[0];
    expect(noTimestamp).toMatchObject({ icon: "📝", timestamp: "", tags: [] });
    expect(noTimestamp.body).toBe("body");

    expect(() => parseInbox("### \nbody\n")).not.toThrow();
    const bare = parseInbox("### \nbody\n").notes[0];
    expect(bare.icon).toBe("📝");
    expect(bare.timestamp).toBe("");
  });

  test("raw preserves the exact original block text, including the trailing blank line from the final newline", () => {
    const text = "### 🎙️ 2026-07-29 14:32 #kafka\nline one\nline two\n";
    const { notes } = parseInbox(text);
    // text.split("\n") yields a trailing "" element (from the trailing \n),
    // which belongs to this entry's `current` lines same as any other body
    // line — so raw ends up with one more \n than the visible text.
    expect(notes[0].raw).toBe(
      "### 🎙️ 2026-07-29 14:32 #kafka\nline one\nline two\n",
    );
  });

  test("empty and whitespace-only files produce no notes and an empty preamble, without throwing", () => {
    expect(() => parseInbox("")).not.toThrow();
    expect(parseInbox("")).toEqual({ preamble: "", notes: [] });

    const { preamble, notes } = parseInbox("   \n\n  \n");
    expect(preamble).toBe("");
    expect(notes).toEqual([]);
  });

  test("tolerates missing or excess trailing newlines without throwing", () => {
    expect(
      parseInbox("### 🎙️ 2026-07-29 14:32\nbody, no trailing newline").notes[0]
        .body,
    ).toBe("body, no trailing newline");
    const { notes } = parseInbox("### 🎙️ 2026-07-29 14:32\nbody\n\n\n\n");
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("body");
  });
});

describe("serializeInbox", () => {
  test("formats tags inline with a leading #, and omits the trailing space when there are none", () => {
    const tagged: Note = {
      icon: "🎙️",
      timestamp: "2026-07-29 14:32",
      tags: ["bug", "kafka"],
      body: "text",
      raw: "",
    };
    expect(serializeInbox("", [tagged])).toBe(
      "### 🎙️ 2026-07-29 14:32 #bug #kafka\ntext\n",
    );

    const untagged: Note = {
      icon: "🔗",
      timestamp: "2026-07-29 15:03",
      tags: [],
      body: "url",
      raw: "",
    };
    expect(serializeInbox("", [untagged])).toBe(
      "### 🔗 2026-07-29 15:03\nurl\n",
    );
  });

  test("empty notes list with a preamble serializes to just the preamble plus newline", () => {
    expect(serializeInbox("hello", [])).toBe("hello\n");
  });
});

// ---------------------------------------------------------------------------
// tagString / archiveBlock
// ---------------------------------------------------------------------------

describe("tagString", () => {
  test("empty tags produce an empty string", () => {
    expect(tagString([])).toBe("");
  });

  test("one tag renders as a leading space then '#tag'", () => {
    expect(tagString(["kafka"])).toBe(" #kafka");
  });

  test("many tags render space-separated, each prefixed with '#'", () => {
    expect(tagString(["bug", "kafka", "urgent"])).toBe(" #bug #kafka #urgent");
  });
});

describe("archiveBlock", () => {
  // Fixtures below are copied verbatim from the hand-built strings at the
  // four archive call sites in App.tsx (30-day done sweep x2, Todos view
  // `x` on a todo row, Todos view `x` on a triaged note) so archiveBlock is
  // proven to reproduce each site's current on-disk output exactly.

  test("site 1 shape (30-day sweep, done todo entry, no reply) — with tags", () => {
    expect(
      archiveBlock("✅", "2026-06-01 10:00", ["sideline"], "Old done task."),
    ).toBe("### ✅ 2026-06-01 10:00 #sideline\nOld done task.");
  });

  test("site 1 shape — without tags", () => {
    expect(archiveBlock("✅", "2026-06-01 10:00", [], "Old done task.")).toBe(
      "### ✅ 2026-06-01 10:00\nOld done task.",
    );
  });

  test("site 2 shape (30-day sweep, done triaged note, with reply) — with tags", () => {
    expect(
      archiveBlock(
        "✅",
        "2026-06-01 10:00",
        ["kafka"],
        "Body text.",
        "Reply text.",
      ),
    ).toBe(
      "### ✅ 2026-06-01 10:00 #kafka\nBody text.\n\n## Claude\n\nReply text.",
    );
  });

  test("site 2 shape — without a reply (null), without tags", () => {
    expect(archiveBlock("✅", "2026-06-01 10:00", [], "Body text.", null)).toBe(
      "### ✅ 2026-06-01 10:00\nBody text.",
    );
  });

  test("site 3 shape (Todos view `x` on a todo row, no reply) — with tags", () => {
    expect(
      archiveBlock(
        "📥",
        "2026-07-29 09:00",
        ["sideline"],
        "Wire up the hotkey loader.",
      ),
    ).toBe("### 📥 2026-07-29 09:00 #sideline\nWire up the hotkey loader.");
  });

  test("site 3 shape — without tags", () => {
    expect(
      archiveBlock("📥", "2026-07-29 09:00", [], "Wire up the hotkey loader."),
    ).toBe("### 📥 2026-07-29 09:00\nWire up the hotkey loader.");
  });

  test("site 4 shape (Todos view `x` on a triaged note, with reply) — with tags", () => {
    expect(
      archiveBlock(
        "📥",
        "2026-07-29 14:32",
        ["bug", "kafka"],
        "The consumer group keeps rebalancing.",
        "Filed under kafka.rs.",
      ),
    ).toBe(
      "### 📥 2026-07-29 14:32 #bug #kafka\nThe consumer group keeps rebalancing.\n\n## Claude\n\nFiled under kafka.rs.",
    );
  });

  test("site 4 shape — undated fallback (timestamp resolved by the caller), without a reply", () => {
    expect(
      archiveBlock(
        "📥",
        "undated",
        [],
        "The consumer group keeps rebalancing.",
      ),
    ).toBe("### 📥 undated\nThe consumer group keeps rebalancing.");
  });
});

describe("parseInbox <-> serializeInbox round-trip (lossless for untouched entries)", () => {
  test("multi-entry fixture with preamble reproduces byte-for-byte", () => {
    const fixture =
      "<!-- captured notes, do not hand-edit -->\n" +
      "\n" +
      "### 🎙️ 2026-07-29 14:32 #bug #kafka\n" +
      "The consumer group keeps rebalancing when the broker restarts.\n" +
      "\n" +
      "Might be a session timeout misconfiguration — check consumer.properties.\n" +
      "\n" +
      "### 🔗 2026-07-29 15:03 #reading\n" +
      "https://example.com/some-article\n" +
      "\n" +
      "### 📸 2026-07-29 15:10 #ui #dashboard\n" +
      "![screenshot](inbox-assets/shot-20260729-151000.png)\n";

    const { preamble, notes } = parseInbox(fixture);
    expect(serializeInbox(preamble, notes)).toBe(fixture);
  });

  test("single-entry fixture with no preamble reproduces byte-for-byte", () => {
    const fixture = "### 🎙️ 2026-07-29 14:32\nJust one note.\n";
    const { preamble, notes } = parseInbox(fixture);
    expect(serializeInbox(preamble, notes)).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// parseTodos / serializeTodos
// ---------------------------------------------------------------------------

describe("parseTodos", () => {
  test("parses all three status markers — ⬜ pending, ✅ done, 🧊 iced", () => {
    expect(
      parseTodos(
        "### ⬜ 2026-07-29 09:00 #sideline\n\nWire up the hotkey loader.\n",
      )[0],
    ).toMatchObject({
      status: "pending",
      timestamp: "2026-07-29 09:00",
      tags: ["sideline"],
    });
    expect(
      parseTodos(
        "### ✅ 2026-07-28 16:45 #sideline\n\nFix popover positioning.\n",
      )[0].status,
    ).toBe("done");
    expect(
      parseTodos("### 🧊 2026-07-20 11:02 #sideline\n\nParked for later.\n")[0]
        .status,
    ).toBe("iced");
  });

  test("treats an unrecognized legacy icon (e.g. 📥) as pending", () => {
    const [entry] = parseTodos(
      "### 📥 2026-07-01 08:00 #sideline\n\nOld-format entry.\n",
    );
    expect(entry.status).toBe("pending");
  });

  test("extracts a leading **title** body line as the title; entries without one are left untouched", () => {
    const titled = parseTodos(
      "### 🧊 2026-07-20 11:02 #sideline\n\n" +
        "**Rework the tray icon states**\n\n" +
        "Long entry body explaining the plan across a couple of sentences.\n",
    )[0];
    expect(titled.title).toBe("Rework the tray icon states");
    expect(titled.body).toBe(
      "Long entry body explaining the plan across a couple of sentences.",
    );

    const plain = parseTodos(
      "### ⬜ 2026-07-29 09:00 #sideline\n\nPlain body, no title.\n",
    )[0];
    expect(plain.title).toBeUndefined();
    expect(plain.body).toBe("Plain body, no title.");
  });

  test("keeps an embedded '## Claude' reply section as part of the body (re-routed entries)", () => {
    const content =
      "### ⬜ 2026-07-30 10:15 #sideline\n\n" +
      "Re-triaged capture about the audio device picker.\n\n" +
      "## Claude\n\n" +
      "Filed under audio.rs; matches by substring against the input device name.\n";
    const [entry] = parseTodos(content);
    expect(entry.body).toBe(
      "Re-triaged capture about the audio device picker.\n\n" +
        "## Claude\n\n" +
        "Filed under audio.rs; matches by substring against the input device name.",
    );
  });

  test("does not throw on a header missing a timestamp", () => {
    expect(() => parseTodos("### ⬜ no-date-here\nbody\n")).not.toThrow();
    const [entry] = parseTodos("### ⬜ no-date-here\nbody\n");
    expect(entry.status).toBe("pending");
    expect(entry.timestamp).toBe("");
  });

  test("content before the first '### ' header is dropped, not treated as preamble (unlike parseInbox)", () => {
    const [entry] = parseTodos(
      "stray text\n\n### ⬜ 2026-07-29 09:00\n\nbody\n",
    );
    expect(entry.body).toBe("body");
  });

  test("empty content produces no entries, without throwing", () => {
    expect(() => parseTodos("")).not.toThrow();
    expect(parseTodos("")).toEqual([]);
  });
});

describe("serializeTodos", () => {
  test("returns an empty string for an empty entry list", () => {
    expect(serializeTodos([])).toBe("");
  });

  test("renders each status to its icon", () => {
    const entries: TodoEntry[] = [
      { status: "pending", timestamp: "2026-07-29 09:00", tags: [], body: "a" },
      { status: "done", timestamp: "2026-07-29 09:01", tags: [], body: "b" },
      { status: "iced", timestamp: "2026-07-29 09:02", tags: [], body: "c" },
    ];
    const out = serializeTodos(entries);
    expect(out).toContain("### ⬜ 2026-07-29 09:00\n\na");
    expect(out).toContain("### ✅ 2026-07-29 09:01\n\nb");
    expect(out).toContain("### 🧊 2026-07-29 09:02\n\nc");
  });

  test("renders a title as a leading **title** body line", () => {
    const entries: TodoEntry[] = [
      {
        status: "pending",
        timestamp: "2026-07-29 09:00",
        tags: [],
        title: "A title",
        body: "body",
      },
    ];
    expect(serializeTodos(entries)).toBe(
      "### ⬜ 2026-07-29 09:00\n\n**A title**\n\nbody\n",
    );
  });
});

describe("parseTodos <-> serializeTodos round-trip (lossless for untouched entries)", () => {
  test("multi-entry fixture — statuses, a title line, and an embedded Claude reply — reproduces byte-for-byte", () => {
    const fixture =
      "### ⬜ 2026-07-29 09:00 #sideline\n" +
      "\n" +
      "Wire up the new hotkey config loader.\n" +
      "\n" +
      "### ✅ 2026-07-28 16:45 #sideline #ui\n" +
      "\n" +
      "Fix popover positioning on the external monitor.\n" +
      "\n" +
      "### 🧊 2026-07-20 11:02 #sideline\n" +
      "\n" +
      "**Rework the tray icon states**\n" +
      "\n" +
      "Long entry example that starts with a generated title line — the body\n" +
      "explains the rest of the plan across a couple of sentences.\n" +
      "\n" +
      "### ⬜ 2026-07-30 10:15 #sideline\n" +
      "\n" +
      "Re-triaged capture about the audio device picker.\n" +
      "\n" +
      "## Claude\n" +
      "\n" +
      "Filed under audio.rs; the picker matches by substring against the input device name.\n";

    const entries = parseTodos(fixture);
    expect(serializeTodos(entries)).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// splitTodoReply / todoRowDisplay
// ---------------------------------------------------------------------------

describe("splitTodoReply", () => {
  test("no '## Claude' section: the whole input is the body, reply is null", () => {
    expect(splitTodoReply("Plain body, no title.")).toEqual({
      body: "Plain body, no title.",
      reply: null,
    });
  });

  test("splits an embedded '## Claude' section into body + reply, trimming the join", () => {
    const raw =
      "Re-triaged capture about the audio device picker.\n\n" +
      "## Claude\n\n" +
      "Filed under audio.rs; matches by substring against the input device name.";
    expect(splitTodoReply(raw)).toEqual({
      body: "Re-triaged capture about the audio device picker.",
      reply:
        "Filed under audio.rs; matches by substring against the input device name.",
    });
  });

  test("a body that is only a '## Claude' section produces an empty body", () => {
    const raw = "## Claude\n\nJust a reply, no body above it.";
    expect(splitTodoReply(raw)).toEqual({
      body: "",
      reply: "Just a reply, no body above it.",
    });
  });
});

describe("todoRowDisplay", () => {
  const base: TodoEntry = {
    status: "pending",
    timestamp: "2026-07-29 09:00",
    tags: [],
    body: "Short body.",
  };

  test("not expandable: short, untitled, reply-less entry", () => {
    expect(todoRowDisplay(base)).toEqual({
      body: "Short body.",
      reply: null,
      expandable: false,
    });
  });

  test("expandable when the entry has a title, even with a short body", () => {
    expect(todoRowDisplay({ ...base, title: "A title" }).expandable).toBe(true);
  });

  test("expandable when the body embeds a '## Claude' reply, which is split out", () => {
    const withReply = {
      ...base,
      body: "The note body.\n\n## Claude\n\nThe reply body.",
    };
    expect(todoRowDisplay(withReply)).toEqual({
      body: "The note body.",
      reply: "The reply body.",
      expandable: true,
    });
  });

  test("expandable when the body alone needs a title (long/multi-line), without a title or reply", () => {
    const long = {
      ...base,
      body: "line one\nline two\nline three",
    };
    expect(todoRowDisplay(long).expandable).toBe(true);
    expect(todoRowDisplay(long).reply).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseTriagedFile
// ---------------------------------------------------------------------------

describe("parseTriagedFile", () => {
  test("parses full frontmatter (captured, type, tags, status) with no title", () => {
    const content =
      "---\n" +
      "captured: 2026-07-29 14:32\n" +
      "type: 🎙️\n" +
      "tags: [bug, kafka]\n" +
      "status: triaged\n" +
      "---\n" +
      "\n" +
      "The consumer group keeps rebalancing when the broker restarts.\n";
    const note = parseTriagedFile(
      "2026-07-29-consumer-rebalancing.md",
      content,
    );
    expect(note).toMatchObject({
      filename: "2026-07-29-consumer-rebalancing.md",
      captured: "2026-07-29 14:32",
      tags: ["bug", "kafka"],
      status: "triaged",
      title: null,
      reply: null,
    });
    expect(note.body).toBe(
      "The consumer group keeps rebalancing when the broker restarts.",
    );
  });

  test("parses an optional title, an earliest–latest captured range, and extra unknown frontmatter (group files)", () => {
    const content =
      "---\n" +
      "captured: 2026-07-29 09:00 – 2026-07-29 09:40\n" +
      "type: 📥\n" +
      "tags: [kafka]\n" +
      "title: Kafka consumer rebalancing loop\n" +
      "status: triaged\n" +
      "notes: 3\n" +
      "---\n" +
      "\n" +
      "Merged body.\n";
    const note = parseTriagedFile("group.md", content);
    expect(note.title).toBe("Kafka consumer rebalancing loop");
    expect(note.captured).toBe("2026-07-29 09:00 – 2026-07-29 09:40");
    expect(note.tags).toEqual(["kafka"]);
  });

  test("parses status: done and an embedded '## Claude' reply", () => {
    const content =
      "---\n" +
      "captured: 2026-07-29 14:32\n" +
      "type: 🎙️\n" +
      "tags: [bug]\n" +
      "status: done\n" +
      "---\n" +
      "\n" +
      "Body text here.\n" +
      "\n" +
      "## Claude\n" +
      "\n" +
      "Reply text from Claude, potentially multi-line.\n";
    const note = parseTriagedFile("f.md", content);
    expect(note.status).toBe("done");
    expect(note.body).toBe("Body text here.");
    expect(note.reply).toBe("Reply text from Claude, potentially multi-line.");
  });

  test("parses status: iced, and defaults to 'triaged' when the status line is omitted", () => {
    const iced =
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\ntags: []\nstatus: iced\n---\n\nParked.\n";
    expect(parseTriagedFile("f.md", iced).status).toBe("iced");

    const noStatus =
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\ntags: []\n---\n\nbody\n";
    expect(parseTriagedFile("f.md", noStatus).status).toBe("triaged");
  });

  test("is tolerant of missing frontmatter, or an empty string — never throws", () => {
    expect(() =>
      parseTriagedFile("f.md", "Just some body text, no frontmatter at all."),
    ).not.toThrow();
    const note = parseTriagedFile(
      "f.md",
      "Just some body text, no frontmatter at all.",
    );
    expect(note).toMatchObject({
      captured: "",
      tags: [],
      status: "triaged",
      title: null,
      reply: null,
    });
    expect(note.body).toBe("Just some body text, no frontmatter at all.");

    expect(() => parseTriagedFile("f.md", "")).not.toThrow();
    expect(parseTriagedFile("f.md", "").body).toBe("");
  });
});

// ---------------------------------------------------------------------------
// setTriagedStatus / setTriagedTags — byte-preserving contract (inbox.ts,
// around line 163-166): rewrite ONLY the targeted frontmatter line, leaving
// the rest of the file byte-for-byte untouched.
// ---------------------------------------------------------------------------

describe("setTriagedStatus", () => {
  const content =
    "---\n" +
    "captured: 2026-07-29 14:32\n" +
    "type: 🎙️\n" +
    "tags: [bug, kafka]\n" +
    "status: triaged\n" +
    "---\n" +
    "\n" +
    "Body text here.\n" +
    "\n" +
    "## Claude\n" +
    "\n" +
    "Reply text.\n";

  test("flips only the status line, leaving frontmatter, body, and reply untouched", () => {
    const out = setTriagedStatus(content, "done");
    expect(out).toBe(content.replace("status: triaged", "status: done"));
  });

  test("round-trips: flipping done back to triaged restores the original file exactly", () => {
    const flipped = setTriagedStatus(content, "done");
    expect(setTriagedStatus(flipped, "triaged")).toBe(content);
  });

  test("appends a status line when the frontmatter has none, preserving the rest", () => {
    const noStatus =
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\ntags: []\n---\n\nbody\n";
    const out = setTriagedStatus(noStatus, "iced");
    expect(out).toBe(
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\ntags: []\nstatus: iced\n---\n\nbody\n",
    );
  });

  test("synthesizes minimal frontmatter when there is none at all, rather than losing the write", () => {
    const out = setTriagedStatus("plain body, no frontmatter", "done");
    expect(out).toBe("---\nstatus: done\n---\n\nplain body, no frontmatter");
  });
});

describe("setTriagedTags", () => {
  const content =
    "---\n" +
    "captured: 2026-07-29 14:32\n" +
    "type: 🎙️\n" +
    "tags: [bug, kafka]\n" +
    "status: triaged\n" +
    "---\n" +
    "\n" +
    "Body text here.\n";

  test("replaces only the tags line, leaving everything else untouched, and serializes [] for an empty list", () => {
    const out = setTriagedTags(content, ["bug", "urgent"]);
    expect(out).toBe(
      content.replace("tags: [bug, kafka]", "tags: [bug, urgent]"),
    );
    expect(setTriagedTags(content, [])).toContain("tags: []");
  });

  test("appends a tags line when the frontmatter has none, preserving the rest", () => {
    const noTags =
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\nstatus: triaged\n---\n\nbody\n";
    const out = setTriagedTags(noTags, ["kafka"]);
    expect(out).toBe(
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\nstatus: triaged\ntags: [kafka]\n---\n\nbody\n",
    );
  });

  test("synthesizes minimal frontmatter when there is none at all", () => {
    const out = setTriagedTags("plain body", ["kafka"]);
    expect(out).toBe("---\ntags: [kafka]\n---\n\nplain body");
  });
});

// ---------------------------------------------------------------------------
// setTriagedBody — byte-for-byte port of saveEdit's former inline splice.
// Unlike setTriagedStatus/setTriagedTags, the no-frontmatter fallback does
// NOT synthesize one; degenerate cases below pin that (and other) current
// behavior rather than "fixing" it.
// ---------------------------------------------------------------------------

describe("setTriagedBody", () => {
  const content =
    "---\n" +
    "captured: 2026-07-29 14:32\n" +
    "type: 🎙️\n" +
    "tags: [bug, kafka]\n" +
    "status: triaged\n" +
    "---\n" +
    "\n" +
    "Body text here.\n" +
    "\n" +
    "## Claude\n" +
    "\n" +
    "Reply text.\n";

  test("replaces only the body, leaving frontmatter and reply byte-identical", () => {
    const out = setTriagedBody(content, "New body text.");
    expect(out).toBe(
      "---\n" +
        "captured: 2026-07-29 14:32\n" +
        "type: 🎙️\n" +
        "tags: [bug, kafka]\n" +
        "status: triaged\n" +
        "---\n" +
        "\n" +
        "New body text.\n" +
        "\n" +
        "## Claude\n" +
        "\n" +
        "Reply text.\n",
    );
  });

  test("round-trips: replacing the body back to the original restores the original file exactly", () => {
    const edited = setTriagedBody(content, "New body text.");
    expect(setTriagedBody(edited, "Body text here.")).toBe(content);
  });

  test("no reply section: appends a trailing blank line that wasn't in the original (pinned)", () => {
    const noReply =
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\ntags: []\nstatus: triaged\n---\n\nold body\n";
    const out = setTriagedBody(noReply, "new body");
    expect(out).toBe(
      "---\ncaptured: 2026-07-01 08:00\ntype: 🔗\ntags: []\nstatus: triaged\n---\n\nnew body\n\n",
    );
  });

  test("no frontmatter at all: dropped rather than synthesized, new body gets a stray leading blank line (pinned)", () => {
    const out = setTriagedBody("plain body, no frontmatter", "new body");
    expect(out).toBe("\nnew body\n\n");
  });

  test("frontmatter missing its trailing newline after the closing delimiter is treated as no frontmatter (pinned)", () => {
    // Regex requires "---\n" (with the trailing newline) to close the
    // frontmatter block; without it the match fails entirely.
    const noTrailingNewline = "---\ncaptured: 2026-07-01 08:00\n---";
    const out = setTriagedBody(noTrailingNewline, "new body");
    expect(out).toBe("\nnew body\n\n");
  });
});

// ---------------------------------------------------------------------------
// toTriagedFile / toGroupFile
// ---------------------------------------------------------------------------

describe("toTriagedFile", () => {
  const note: Note = {
    icon: "🎙️",
    timestamp: "2026-07-29 14:32",
    tags: ["bug", "kafka"],
    body: "The consumer group keeps rebalancing when the broker restarts.",
    raw: "",
  };

  test("builds frontmatter + body with status: triaged and no title by default", () => {
    expect(toTriagedFile(note)).toBe(
      "---\n" +
        "captured: 2026-07-29 14:32\n" +
        "type: 🎙️\n" +
        "tags: [bug, kafka]\n" +
        "status: triaged\n" +
        "---\n" +
        "\n" +
        "The consumer group keeps rebalancing when the broker restarts.\n",
    );
  });

  test("inserts an optional title line before status, and serializes empty tags as []", () => {
    const out = toTriagedFile(note, undefined, "Kafka consumer rebalancing");
    expect(out).toBe(
      "---\n" +
        "captured: 2026-07-29 14:32\n" +
        "type: 🎙️\n" +
        "tags: [bug, kafka]\n" +
        "title: Kafka consumer rebalancing\n" +
        "status: triaged\n" +
        "---\n" +
        "\n" +
        "The consumer group keeps rebalancing when the broker restarts.\n",
    );
    expect(toTriagedFile({ ...note, tags: [] })).toContain("tags: []\n");
  });

  test("appends a '## <title>' reply section when an appendix is given", () => {
    const out = toTriagedFile(note, { title: "Claude", body: "Reply text." });
    expect(out).toBe(
      "---\n" +
        "captured: 2026-07-29 14:32\n" +
        "type: 🎙️\n" +
        "tags: [bug, kafka]\n" +
        "status: triaged\n" +
        "---\n" +
        "\n" +
        "The consumer group keeps rebalancing when the broker restarts.\n" +
        "\n" +
        "## Claude\n" +
        "\n" +
        "Reply text.\n",
    );
  });
});

describe("toGroupFile", () => {
  test("merges notes with an earliest–latest captured range and a notes count", () => {
    const notes: Note[] = [
      {
        icon: "🎙️",
        timestamp: "2026-07-29 09:00",
        tags: ["kafka"],
        body: "First capture.",
        raw: "",
      },
      {
        icon: "🔗",
        timestamp: "2026-07-29 09:40",
        tags: ["kafka"],
        body: "Second capture.",
        raw: "",
      },
    ];
    const out = toGroupFile("kafka", notes, "Merged reply text.");
    expect(out).toBe(
      "---\n" +
        "captured: 2026-07-29 09:00 – 2026-07-29 09:40\n" +
        "type: 📥\n" +
        "tags: [kafka]\n" +
        "status: triaged\n" +
        "notes: 2\n" +
        "---\n" +
        "\n" +
        "### 2026-07-29 09:00\n" +
        "\n" +
        "First capture.\n" +
        "\n" +
        "### 2026-07-29 09:40\n" +
        "\n" +
        "Second capture.\n" +
        "\n" +
        "## Claude\n" +
        "\n" +
        "Merged reply text.\n",
    );
  });
});

// ---------------------------------------------------------------------------
// slugFor
// ---------------------------------------------------------------------------

describe("slugFor", () => {
  test("builds a date-prefixed slug from up to the first 6 words, lowercased, punctuation stripped", () => {
    const note: Note = {
      icon: "🎙️",
      timestamp: "2026-07-29 14:32",
      tags: [],
      body: "The consumer group keeps rebalancing when the broker restarts.",
      raw: "",
    };
    expect(slugFor(note)).toBe(
      "2026-07-29-the-consumer-group-keeps-rebalancing-when.md",
    );
  });

  test("falls back to 'note' for an empty or punctuation-only body", () => {
    const note: Note = {
      icon: "🔗",
      timestamp: "2026-07-29 14:32",
      tags: [],
      body: "!!! ??? ---",
      raw: "",
    };
    expect(slugFor(note)).toBe("2026-07-29-note.md");
  });

  test("falls back to 'undated' when the timestamp is empty", () => {
    const note: Note = {
      icon: "🔗",
      timestamp: "",
      tags: [],
      body: "hello world",
      raw: "",
    };
    expect(slugFor(note)).toBe("undated-hello-world.md");
  });
});

// ---------------------------------------------------------------------------
// todoEntry
// ---------------------------------------------------------------------------

describe("todoEntry", () => {
  const note: Note = {
    icon: "🎙️",
    timestamp: "2026-07-29 14:32",
    tags: ["sideline"],
    body: "Wire up the new hotkey config loader.",
    raw: "",
  };

  test("builds a pending entry carrying the note's timestamp, tags, and body, with no title by default", () => {
    const entry = todoEntry(note);
    expect(entry).toEqual({
      status: "pending",
      timestamp: "2026-07-29 14:32",
      tags: ["sideline"],
      body: "Wire up the new hotkey config loader.",
    });
    expect(entry.title).toBeUndefined();
  });

  test("includes an optional generated title", () => {
    const entry = todoEntry(note, "Wire up hotkey loader");
    expect(entry.title).toBe("Wire up hotkey loader");
  });
});

// ---------------------------------------------------------------------------
// patchTodoTitle — background title backfill for single-note PROJECT
// triage (useTriage.ts): routing files the entry with no title, this
// patches one in once the Haiku call resolves, moments later.
// ---------------------------------------------------------------------------

describe("patchTodoTitle", () => {
  const note: Note = {
    icon: "🎙️",
    timestamp: "2026-07-29 14:32",
    tags: ["sideline"],
    body: "Wire up the new hotkey config loader.",
    raw: "",
  };

  test("patches the title into the matching entry, leaving every other entry byte-identical", () => {
    const content =
      "### ⬜ 2026-07-28 09:00 #sideline\n\n" +
      "An earlier, unrelated entry.\n\n" +
      "### ⬜ 2026-07-29 14:32 #sideline\n\n" +
      "Wire up the new hotkey config loader.\n\n" +
      "### ✅ 2026-07-30 10:00 #sideline\n\n" +
      "A later, unrelated entry.\n";

    const out = patchTodoTitle(content, note, "Wire up hotkey loader");
    expect(out).not.toBeNull();
    const entries = parseTodos(out!);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      timestamp: "2026-07-28 09:00",
      body: "An earlier, unrelated entry.",
    });
    expect(entries[0].title).toBeUndefined();
    expect(entries[1]).toMatchObject({
      timestamp: "2026-07-29 14:32",
      title: "Wire up hotkey loader",
      body: "Wire up the new hotkey config loader.",
    });
    expect(entries[2]).toMatchObject({
      status: "done",
      timestamp: "2026-07-30 10:00",
      body: "A later, unrelated entry.",
    });
    expect(entries[2].title).toBeUndefined();
  });

  test("no-ops (returns null) when no entry matches timestamp+body — e.g. undone, edited, or completed+purged", () => {
    const content =
      "### ⬜ 2026-07-28 09:00 #sideline\n\nSome other entry entirely.\n";
    expect(patchTodoTitle(content, note, "A title")).toBeNull();

    // Same timestamp, different body (e.g. edited since routing).
    const editedBody =
      "### ⬜ 2026-07-29 14:32 #sideline\n\nA different body now.\n";
    expect(patchTodoTitle(editedBody, note, "A title")).toBeNull();

    // Empty file (e.g. undo restored empty prevTodoContent).
    expect(patchTodoTitle("", note, "A title")).toBeNull();
  });

  test("no-ops (returns null) when the matching entry already has a title", () => {
    const content =
      "### ⬜ 2026-07-29 14:32 #sideline\n\n" +
      "**Already titled**\n\n" +
      "Wire up the new hotkey config loader.\n";
    expect(patchTodoTitle(content, note, "A new title")).toBeNull();
  });

  test("two entries share a timestamp but differ in body: patches only the one matching the note's body", () => {
    const content =
      "### ⬜ 2026-07-29 14:32 #sideline\n\n" +
      "A different note captured the same minute.\n\n" +
      "### ⬜ 2026-07-29 14:32 #sideline\n\n" +
      "Wire up the new hotkey config loader.\n";

    const out = patchTodoTitle(content, note, "Wire up hotkey loader");
    const entries = parseTodos(out!);
    expect(entries[0].title).toBeUndefined();
    expect(entries[0].body).toBe("A different note captured the same minute.");
    expect(entries[1].title).toBe("Wire up hotkey loader");
    expect(entries[1].body).toBe("Wire up the new hotkey config loader.");
  });

  test("preserves a status flip or tag edit that landed on the entry before the backfill arrived", () => {
    // Entry was marked done and re-tagged between routing and the backfill
    // resolving — the patch must not reset either back to the note's
    // original pending status / original tags.
    const content =
      "### ✅ 2026-07-29 14:32 #sideline #urgent\n\n" +
      "Wire up the new hotkey config loader.\n";
    const out = patchTodoTitle(content, note, "Wire up hotkey loader");
    const [entry] = parseTodos(out!);
    expect(entry.status).toBe("done");
    expect(entry.tags).toEqual(["sideline", "urgent"]);
    expect(entry.title).toBe("Wire up hotkey loader");
  });
});
