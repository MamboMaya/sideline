// Tests for src/lib/listFormat.ts — keys, eligibility, reply parsing, split
// location, bullet building, and above all the validator that guarantees no
// word of the user's note is lost or reworded.
import { describe, expect, test } from "vitest";
import {
  type ListEntry,
  buildList,
  buildListPrompt,
  copyBody,
  displayBody,
  findStarts,
  listKey,
  listText,
  needsListCheck,
  parseListReply,
  parseLists,
  renderList,
  rulesDetect,
  rulesStarts,
  autoListPlan,
  bulletStarts,
  signalStarts,
  hasLeadIn,
  leadInStarts,
  startsFromReply,
  toggleAction,
  validateList,
} from "./listFormat";

const GROCERY =
  "Pick up milk on the way home, and grab some eggs too. Call the dentist " +
  "about moving my appointment to Thursday. Email Sam the slides before the " +
  "meeting, and also check the budget numbers";
const GROCERY_PHRASES = [
  "Pick up milk",
  "call the dentist about",
  "email Sam the slides",
  "check the budget numbers",
];

const LOOSE =
  "I'd love a collapse all button and then also shortcut keys for play and " +
  "then I should be able to multi-select videos";
const LOOSE_PHRASES = [
  "I'd love a collapse",
  "shortcut keys for play",
  "I should be able to",
];

describe("listKey", () => {
  test("is timestamp + 8 hex digits of the body hash", () => {
    expect(listKey("2026-01-02 11:00", "hello")).toMatch(
      /^2026-01-02 11:00\|[0-9a-f]{8}$/,
    );
  });
  test("is stable for the same input", () => {
    expect(listKey("t", "abc")).toBe(listKey("t", "abc"));
  });
  test("changes when the body is edited", () => {
    expect(listKey("t", "abc")).not.toBe(listKey("t", "abd"));
  });
  test("matches the FNV-1a reference value", () => {
    // FNV-1a 32-bit of "a" is 0xe40c292c.
    expect(listKey("t", "a")).toBe("t|e40c292c");
    expect(listKey("t", "")).toBe("t|811c9dc5");
  });
  test("handles non-ASCII bodies", () => {
    expect(listKey("t", "café ☕")).toMatch(/^t\|[0-9a-f]{8}$/);
  });
});

describe("needsListCheck", () => {
  test("false for a short note", () => {
    expect(needsListCheck("buy milk")).toBe(false);
  });
  test("true for a long single-line note", () => {
    expect(needsListCheck(GROCERY)).toBe(true);
  });
  test("true for a 3-line note", () => {
    expect(needsListCheck("a\nb\nc")).toBe(true);
  });
  test("false when the note has a screenshot", () => {
    expect(
      needsListCheck(`${GROCERY}\n\n![screenshot](inbox-assets/shot-1.png)`),
    ).toBe(false);
  });
});

describe("buildListPrompt", () => {
  test("includes the instructions and the note body", () => {
    const p = buildListPrompt("my note text");
    expect(p).toContain("NONE");
    expect(p).toContain("EXACTLY");
    expect(p.endsWith("my note text")).toBe(true);
  });
});

describe("parseListReply", () => {
  test("NONE is null (any case, trimmed, trailing period)", () => {
    expect(parseListReply("NONE")).toBeNull();
    expect(parseListReply("  none \n")).toBeNull();
    expect(parseListReply("None.")).toBeNull();
  });
  test("one line is null", () => {
    expect(parseListReply("Pick up milk")).toBeNull();
  });
  test("empty is null", () => {
    expect(parseListReply("")).toBeNull();
  });
  test("returns one phrase per line", () => {
    expect(parseListReply("Pick up milk\nCall the dentist")).toEqual([
      "Pick up milk",
      "Call the dentist",
    ]);
  });
  test("strips bullets, numbering and quotes defensively", () => {
    expect(
      parseListReply(
        '- "Pick up milk"\n2. Call the dentist\n* Email Sam\n3) x',
      ),
    ).toEqual(["Pick up milk", "Call the dentist", "Email Sam", "x"]);
  });
  test("skips blank lines", () => {
    expect(parseListReply("a b\n\n\nc d\n")).toEqual(["a b", "c d"]);
  });
  test("keeps a leading number that is part of the words", () => {
    expect(parseListReply("3 apples please\n2 pears")).toEqual([
      "3 apples please",
      "2 pears",
    ]);
  });
});

describe("findStarts", () => {
  test("finds the four grocery items", () => {
    const starts = findStarts(GROCERY, GROCERY_PHRASES);
    expect(starts).toHaveLength(4);
    expect(starts?.[0]).toBe(0);
    expect(GROCERY.slice(starts?.[1] ?? 0)).toMatch(/^Call the dentist/);
    expect(GROCERY.slice(starts?.[2] ?? 0)).toMatch(/^Email Sam/);
    expect(GROCERY.slice(starts?.[3] ?? 0)).toMatch(/^check the budget/);
  });
  test("ignores punctuation and case differences", () => {
    const body = "Hello, there. Foo bar, baz qux";
    expect(findStarts(body, ["HELLO there", "foo BAR baz"])).toEqual([0, 14]);
  });
  test("folds curly apostrophes", () => {
    expect(
      findStarts("don’t stop now then go home", ["don't stop", "go home"]),
    ).toEqual([0, 20]);
  });
  test("returns null when a phrase is missing", () => {
    expect(findStarts(GROCERY, ["Pick up milk", "walk the dog"])).toBeNull();
  });
  test("returns null for an empty phrase", () => {
    expect(findStarts(GROCERY, ["Pick up milk", "  ,, "])).toBeNull();
  });
  test("returns null for fewer than 2 phrases", () => {
    expect(findStarts(GROCERY, ["Pick up milk"])).toBeNull();
    expect(findStarts(GROCERY, [])).toBeNull();
  });
  test("each phrase must match strictly after the previous", () => {
    // Out-of-order phrases: the second is only before the first.
    expect(
      findStarts("alpha beta gamma delta", ["gamma delta", "alpha beta"]),
    ).toBeNull();
  });
  test("a phrase that matches more than once is ambiguous → null", () => {
    expect(
      findStarts("buy it now. buy it now. buy it now", ["buy it", "buy it"]),
    ).toBeNull();
    // Mentioned again later: the remaining range holds two matches.
    const body =
      "Check the budget numbers first. Email Sam the slides, then check the budget numbers again";
    expect(
      findStarts(body, ["Email Sam the slides", "check the budget numbers"]),
    ).not.toBeNull();
    expect(
      findStarts(body, ["check the budget numbers", "Email Sam"]),
    ).toBeNull();
  });
  test("the 'check the budget numbers' twice case is null", () => {
    const body =
      "Check the budget numbers. Call the dentist about moving things. Check the budget numbers";
    expect(
      findStarts(body, ["check the budget numbers", "call the dentist"]),
    ).toBeNull();
    expect(
      findStarts(body, ["call the dentist", "check the budget numbers"]),
    ).not.toBeNull();
  });
  test("phrases under 2 words null the whole result", () => {
    expect(findStarts(GROCERY, ["Pick up milk", "Email"])).toBeNull();
    expect(findStarts(GROCERY, ["Pick", "Call the dentist"])).toBeNull();
  });
  test("a match must start at a word boundary, not inside 2.5 or plus-one", () => {
    const body = "Get 2.5 pounds of flour and 5 pounds of sugar";
    const starts = findStarts(body, ["Get 2.5 pounds", "5 pounds of sugar"]);
    expect(starts).toEqual([0, body.lastIndexOf("5 pounds")]);
    expect(findStarts(body, ["Get 2", "5 pounds of flour"])).toBeNull();
    // "one now" only occurs inside "plus-one now" → no valid start.
    expect(
      findStarts("Bring a plus-one now. Call mom today", [
        "one now",
        "Call mom",
      ]),
    ).toBeNull();
  });
  test("a match after a newline is at a word boundary", () => {
    expect(
      findStarts("buy milk today\ncall mom today", ["buy milk", "call mom"]),
    ).toEqual([0, 15]);
  });
  test("works with unicode words", () => {
    expect(
      findStarts("café au lait; crème brûlée", ["café au", "crème brûlée"]),
    ).toEqual([0, 14]);
  });
});

describe("buildList", () => {
  test("builds four bullets from the grocery note", () => {
    const starts = findStarts(GROCERY, GROCERY_PHRASES) as number[];
    const built = buildList(GROCERY, starts);
    expect(built.lead).toBe("");
    expect(built.items).toEqual([
      "Pick up milk on the way home, and grab some eggs too.",
      "Call the dentist about moving my appointment to Thursday.",
      "Email Sam the slides before the meeting",
      "Check the budget numbers",
    ]);
    expect(validateList(GROCERY, built)).toBe(true);
  });
  test("strips leading and trailing connectors in loose speech", () => {
    const starts = findStarts(LOOSE, LOOSE_PHRASES) as number[];
    const built = buildList(LOOSE, starts);
    expect(built.items).toEqual([
      "I'd love a collapse all button",
      "Shortcut keys for play",
      "I should be able to multi-select videos",
    ]);
    expect(validateList(LOOSE, built)).toBe(true);
  });
  test("a start placed on the connector is stripped from the item", () => {
    const body = "fix the door and then paint the wall";
    const built = buildList(body, [0, body.indexOf("and then")]);
    expect(built.items).toEqual(["Fix the door", "Paint the wall"]);
    expect(validateList(body, built)).toBe(true);
  });
  test("strips stacked connectors and following commas", () => {
    const body = "one thing, and then also, two thing";
    const built = buildList(body, [0, body.indexOf("and then")]);
    expect(built.items).toEqual(["One thing", "Two thing"]);
  });
  test("keeps a lead sentence and trims its trailing connector", () => {
    const body = "Things for today, and also pick up milk, call the dentist";
    const starts = findStarts(body, ["pick up milk", "call the dentist"]);
    const built = buildList(body, starts as number[]);
    expect(built.lead).toBe("Things for today");
    expect(built.items).toEqual(["Pick up milk", "Call the dentist"]);
    expect(validateList(body, built)).toBe(true);
  });
  test("keeps lead punctuation like a colon", () => {
    const body = "Groceries: milk, eggs";
    const built = buildList(body, [body.indexOf("milk"), body.indexOf("eggs")]);
    expect(built.lead).toBe("Groceries:");
    expect(built.items).toEqual(["Milk", "Eggs"]);
  });
  test("does not strip a word that merely starts with a connector", () => {
    const body = "android phone, anderson file";
    const built = buildList(body, [0, body.indexOf("anderson")]);
    expect(built.items).toEqual(["Android phone", "Anderson file"]);
  });
  test("folds line breaks inside an item to a space", () => {
    const body = "first part\nof item one second item";
    const built = buildList(body, [0, body.indexOf("second")]);
    expect(built.items[0]).toBe("First part of item one");
  });
});

describe("validateList", () => {
  const built = (lead: string, items: string[]) => ({ lead, items });

  test("true when nothing is lost", () => {
    expect(
      validateList(
        "buy milk and eggs. call mom",
        built("", ["Buy milk and eggs.", "Call mom"]),
      ),
    ).toBe(true);
  });
  test("true when only connectors are dropped", () => {
    expect(
      validateList(
        "buy milk, and then call mom",
        built("", ["Buy milk", "Call mom"]),
      ),
    ).toBe(true);
  });
  test("false when an item is missing", () => {
    expect(
      validateList(
        "buy milk then walk the dog then call mom",
        built("", ["Buy milk", "Call mom"]),
      ),
    ).toBe(false);
  });
  test("false when the last item is missing", () => {
    expect(
      validateList(
        "buy milk then call mom",
        built("", ["Buy milk", "Buy milk"]),
      ),
    ).toBe(false);
    expect(
      validateList(
        "buy milk call mom walk dog",
        built("", ["Buy milk", "Call mom"]),
      ),
    ).toBe(false);
  });
  test("false when items are reordered", () => {
    expect(
      validateList("buy milk call mom", built("", ["Call mom", "Buy milk"])),
    ).toBe(false);
  });
  test("false when a word is reworded", () => {
    expect(
      validateList(
        "buy milk call mom",
        built("", ["Purchase milk", "Call mom"]),
      ),
    ).toBe(false);
  });
  test("false when a word is added", () => {
    expect(
      validateList(
        "buy milk call mom",
        built("", ["Buy some milk", "Call mom"]),
      ),
    ).toBe(false);
  });
  test("false when a non-connector word is dropped mid-body", () => {
    expect(
      validateList(
        "buy fresh milk call mom",
        built("", ["Buy milk", "Call mom"]),
      ),
    ).toBe(false);
  });
  test("false when a connector word is added that was never spoken", () => {
    expect(
      validateList(
        "buy milk call mom",
        built("", ["Buy milk", "And call mom"]),
      ),
    ).toBe(false);
  });
  test("false for an empty item or fewer than 2 items", () => {
    expect(
      validateList("buy milk call mom", built("", ["Buy milk call mom"])),
    ).toBe(false);
    expect(
      validateList("buy milk call mom", built("", ["Buy milk call mom", ""])),
    ).toBe(false);
  });
  test("lead counts as part of the text", () => {
    expect(
      validateList(
        "todo: buy milk call mom",
        built("Todo:", ["Buy milk", "Call mom"]),
      ),
    ).toBe(true);
    expect(
      validateList(
        "todo: buy milk call mom",
        built("", ["Buy milk", "Call mom"]),
      ),
    ).toBe(false);
  });
  test("is case-insensitive and ignores punctuation", () => {
    expect(
      validateList("Buy milk, CALL mom!", built("", ["buy MILK.", "call mom"])),
    ).toBe(true);
  });
  test("true for the grocery and loose examples", () => {
    for (const [body, phrases] of [
      [GROCERY, GROCERY_PHRASES],
      [LOOSE, LOOSE_PHRASES],
    ] as const) {
      const starts = findStarts(body, [...phrases]) as number[];
      expect(validateList(body, buildList(body, starts))).toBe(true);
    }
  });
  test("false when the grocery bullets lose the third item", () => {
    const starts = findStarts(GROCERY, GROCERY_PHRASES) as number[];
    const full = buildList(GROCERY, starts);
    const missing = { ...full, items: full.items.filter((_, i) => i !== 2) };
    expect(validateList(GROCERY, missing)).toBe(false);
  });
});

describe("renderList", () => {
  test("renders bullets with no lead", () => {
    expect(renderList({ lead: "", items: ["A b", "C d"] })).toBe(
      "- A b\n- C d",
    );
  });
  test("puts the lead on its own line first", () => {
    expect(renderList({ lead: "Today:", items: ["A b", "C d"] })).toBe(
      "Today:\n- A b\n- C d",
    );
  });
});

describe("startsFromReply", () => {
  test("returns starts for a good reply", () => {
    const starts = startsFromReply(GROCERY, GROCERY_PHRASES.join("\n"));
    expect(starts).toHaveLength(4);
  });
  test("null for NONE, unlocatable phrases", () => {
    expect(startsFromReply(GROCERY, "NONE")).toBeNull();
    expect(startsFromReply(GROCERY, "Pick up milk\nwalk the dog")).toBeNull();
  });
});

describe("displayBody", () => {
  const entry = (starts: number[] | null, show = true): ListEntry => ({
    starts,
    show,
  });
  const starts = findStarts(GROCERY, GROCERY_PHRASES) as number[];

  test("plain body with no entry", () => {
    expect(displayBody(GROCERY, undefined)).toBe(GROCERY);
  });
  test("plain body for a checked non-list", () => {
    expect(displayBody(GROCERY, entry(null))).toBe(GROCERY);
  });
  test("plain body when show is off", () => {
    expect(displayBody(GROCERY, entry(starts, false))).toBe(GROCERY);
  });
  test("bullets when starts are stored and show is on", () => {
    const out = displayBody(GROCERY, entry(starts));
    expect(out.split("\n")).toHaveLength(4);
    expect(out.split("\n").every((l) => l.startsWith("- "))).toBe(true);
  });
  test("falls back to the body for out-of-range offsets", () => {
    expect(displayBody(GROCERY, entry([0, 9999]))).toBe(GROCERY);
    expect(displayBody(GROCERY, entry([-1, 5]))).toBe(GROCERY);
  });
  test("falls back for non-ascending, fractional or too-few offsets", () => {
    expect(displayBody(GROCERY, entry([20, 10]))).toBe(GROCERY);
    expect(displayBody(GROCERY, entry([0, 1.5]))).toBe(GROCERY);
    expect(displayBody(GROCERY, entry([0]))).toBe(GROCERY);
  });
  test("falls back when offsets split the text so a word would be cut", () => {
    // Offsets landing mid-word still reuse the user's own characters, so the
    // words differ from the original and the validator rejects it.
    expect(displayBody(GROCERY, entry([0, 3]))).toBe(GROCERY);
  });
});

describe("parseLists", () => {
  test("parses valid entries", () => {
    expect(
      parseLists(
        '{"a":{"starts":[0,5],"show":true},"b":{"starts":null,"show":false}}',
      ),
    ).toEqual({
      a: { starts: [0, 5], show: true },
      b: { starts: null, show: false },
    });
  });
  test("returns {} for corrupt or non-object JSON", () => {
    expect(parseLists("nope")).toEqual({});
    expect(parseLists("[]")).toEqual({});
    expect(parseLists("null")).toEqual({});
  });
  test("drops malformed entries only", () => {
    expect(
      parseLists(
        '{"ok":{"starts":null,"show":true},"x":{"starts":[1.5],"show":true},"y":{"starts":[1]},"z":3}',
      ),
    ).toEqual({ ok: { starts: null, show: true } });
  });
});

describe("listText / copyBody", () => {
  const starts = findStarts(GROCERY, GROCERY_PHRASES) as number[];
  const on: ListEntry = { starts, show: true };
  const off: ListEntry = { starts, show: false };

  test("listText strips screenshot links and an embedded reply", () => {
    const raw = `${GROCERY}\n\n![screenshot](inbox-assets/a.png)\n\n## Claude\n\nSure.`;
    expect(listText(raw)).toBe(GROCERY);
  });
  test("copyBody returns the stored body when no list is shown", () => {
    expect(copyBody(GROCERY, undefined)).toBe(GROCERY);
    expect(copyBody(GROCERY, off)).toBe(GROCERY);
    expect(copyBody(GROCERY, { starts: null, show: false })).toBe(GROCERY);
  });
  test("copyBody returns the bullets when the list is shown", () => {
    expect(copyBody(GROCERY, on)).toBe(displayBody(GROCERY, on));
    expect(copyBody(GROCERY, on).startsWith("- Pick up milk")).toBe(true);
  });
  test("copyBody keeps screenshot links and the embedded reply", () => {
    const raw = `${GROCERY}\n\n![screenshot](inbox-assets/a.png)\n\n## Claude\n\nSure.`;
    const out = copyBody(raw, on);
    expect(out.startsWith("- Pick up milk")).toBe(true);
    expect(
      out.endsWith("![screenshot](inbox-assets/a.png)\n\n## Claude\n\nSure."),
    ).toBe(true);
  });
  test("copyBody falls back to the stored body for a stale entry", () => {
    expect(copyBody("something else entirely", on)).toBe(
      "something else entirely",
    );
  });
});

describe("connector stripping never eats content", () => {
  const build = (body: string, markers: string[]) =>
    buildList(
      body,
      markers.map((m) => body.indexOf(m)),
    );

  test("`plus` is content, not a connector", () => {
    const body =
      "Invite Sam to the party. Plus-one for Sam too. Plus sign on the button";
    const built = build(body, ["Invite", "Plus-one", "Plus sign"]);
    expect(built.items).toEqual([
      "Invite Sam to the party.",
      "Plus-one for Sam too.",
      "Plus sign on the button",
    ]);
    expect(validateList(body, built)).toBe(true);
  });
  test("a trailing `plus` stays", () => {
    const built = build("add the numbers up plus call mom today", [
      "add",
      "call",
    ]);
    expect(built.items[0]).toBe("Add the numbers up plus");
  });
  test("a leading connector needs a word boundary: And-or / also-ran stay", () => {
    const body = "And-or gates for the circuit. Also-ran notes for the report";
    const built = build(body, ["And-or", "Also-ran"]);
    expect(built.items).toEqual([
      "And-or gates for the circuit.",
      "Also-ran notes for the report",
    ]);
  });
  test("a leading connector followed by comma, space or end is stripped", () => {
    const body = "one thing here and, two thing here and also, three thing";
    const built = build(body, ["one", "and, two", "and also, three"]);
    expect(built.items).toEqual([
      "One thing here",
      "Two thing here",
      "Three thing",
    ]);
  });
  test("trailing run with `and` is stripped: 'icon and then'", () => {
    const body = "Make the icon bigger and then call mom today";
    const built = build(body, ["Make", "call"]);
    expect(built.items[0]).toBe("Make the icon bigger");
    expect(validateList(body, built)).toBe(true);
  });
  test("trailing run after a comma is stripped without `and`: 'slides, also'", () => {
    const body = "Email Sam the slides, also call mom today";
    const built = build(body, ["Email", "call"]);
    expect(built.items[0]).toBe("Email Sam the slides");
    expect(validateList(body, built)).toBe(true);
  });
  test("a bare trailing `then` with no comma or `and` is content", () => {
    const body = "Finish the slides by then call mom today";
    const built = build(body, ["Finish", "call"]);
    expect(built.items[0]).toBe("Finish the slides by then");
    expect(validateList(body, built)).toBe(true);
  });
  test("a bare trailing `also` with no comma is content", () => {
    const built = build("I want that also call mom today", ["I want", "call"]);
    expect(built.items[0]).toBe("I want that also");
  });
});

describe("ordinals", () => {
  const BODY =
    "Okay so three things for tomorrow. First, renew the car registration before Friday. Second, book the flights for the wedding, probably the Thursday morning one. Third, call mom back about the weekend.";
  const PHRASES = [
    "renew the car registration",
    "book the flights for the wedding",
    "call mom back about the weekend",
  ];

  test("Haiku skipping First/Second/Third still gives a clean lead and bullets", () => {
    const starts = findStarts(BODY, PHRASES) as number[];
    const built = buildList(BODY, starts);
    expect(built.lead).toBe("Okay so three things for tomorrow.");
    expect(built.items).toEqual([
      "Renew the car registration before Friday.",
      "Book the flights for the wedding, probably the Thursday morning one.",
      "Call mom back about the weekend.",
    ]);
    expect(validateList(BODY, built)).toBe(true);
    expect(renderList(built)).toBe(
      "Okay so three things for tomorrow.\n- Renew the car registration before Friday.\n- Book the flights for the wedding, probably the Thursday morning one.\n- Call mom back about the weekend.",
    );
  });
  test("ordinals included in the phrase are stripped from the front", () => {
    const starts = findStarts(BODY, [
      "First, renew the car",
      "Second, book the flights",
      "Third, call mom back",
    ]) as number[];
    const built = buildList(BODY, starts);
    expect(built.items[0]).toBe("Renew the car registration before Friday.");
    expect(built.items[1].startsWith("Book the flights")).toBe(true);
    expect(validateList(BODY, built)).toBe(true);
  });
  test("a trailing ordinal needs sentence punctuation before it", () => {
    const body = "Do the laundry first. Call mom about the weekend trip";
    const built = buildList(body, [0, body.indexOf("Call")]);
    expect(built.items[0]).toBe("Do the laundry first.");
    expect(validateList(body, built)).toBe(true);
  });
  test("a trailing ordinal followed by more text is kept", () => {
    const body = "Wash up. First thing tomorrow call mom today";
    const built = buildList(body, [0, body.indexOf("call")]);
    expect(built.items[0]).toBe("Wash up. First thing tomorrow");
  });
  test("a trailing ordinal with a colon is stripped, period kept", () => {
    const body = "Buy milk today. Next: call mom about the trip";
    const built = buildList(body, [0, body.indexOf("call")]);
    expect(built.items[0]).toBe("Buy milk today.");
  });
  test("a leading ordinal needs a comma or colon: 'First thing tomorrow, call mom' stays", () => {
    const body = "Wash up now. First thing tomorrow, call mom";
    const built = buildList(body, [0, body.indexOf("First")]);
    expect(built.items[1]).toBe("First thing tomorrow, call mom");
    expect(validateList(body, built)).toBe(true);
  });
  test("the validator skips ordinals but not other words", () => {
    expect(
      validateList("buy milk. second, call mom", {
        lead: "",
        items: ["Buy milk.", "Call mom"],
      }),
    ).toBe(true);
    expect(
      validateList("buy milk. sixth, call mom", {
        lead: "",
        items: ["Buy milk.", "Call mom"],
      }),
    ).toBe(false);
  });
  test("startsFromReply accepts the Haiku-style reply for the example", () => {
    expect(startsFromReply(BODY, PHRASES.join("\n"))).toHaveLength(3);
  });
});

describe("validateList — every bullet needs a word", () => {
  test("a punctuation-only item is rejected", () => {
    expect(
      validateList("buy milk. call mom", {
        lead: "",
        items: ["Buy milk call mom", "."],
      }),
    ).toBe(false);
    expect(
      validateList("buy milk", { lead: "", items: ["Buy milk", "-- ,"] }),
    ).toBe(false);
  });
  test("a built list whose last start sits on trailing punctuation fails", () => {
    const body = "buy milk today and then...";
    const built = buildList(body, [0, body.indexOf("...")]);
    expect(validateList(body, built)).toBe(false);
  });
});

describe("parseListReply — preamble", () => {
  test("drops a first line ending with a colon", () => {
    expect(
      parseListReply("Here are the items:\nPick up milk\nCall the dentist"),
    ).toEqual(["Pick up milk", "Call the dentist"]);
  });
  test("a preamble plus a single item is still too few", () => {
    expect(parseListReply("Here are the items:\nPick up milk")).toBeNull();
  });
  test("only the first line is checked for a colon", () => {
    expect(parseListReply("Pick up milk\nNote to self:")).toEqual([
      "Pick up milk",
      "Note to self:",
    ]);
  });
});

describe("auto path offsets (listText base)", () => {
  test("a body with trailing spaces on a line still renders as a list", () => {
    const raw =
      "Pick up milk on the way home.   \nCall the dentist about moving things.  \nEmail Sam the slides before the meeting";
    const text = listText(raw);
    expect(text).not.toBe(raw);
    const starts = startsFromReply(
      text,
      "Pick up milk\nCall the dentist about\nEmail Sam the slides",
    ) as number[];
    expect(starts).toHaveLength(3);
    const out = displayBody(text, { starts, show: true });
    expect(out.split("\n")).toEqual([
      "- Pick up milk on the way home.",
      "- Call the dentist about moving things.",
      "- Email Sam the slides before the meeting",
    ]);
  });
});

describe("toggleAction (the `l` key)", () => {
  test("flips an entry that has starts, whether shown or hidden", () => {
    expect(toggleAction({ starts: [0, 5], show: true })).toBe("flip");
    expect(toggleAction({ starts: [0, 5], show: false })).toBe("flip");
  });
  test("re-runs detection for a checked non-list (starts: null)", () => {
    expect(toggleAction({ starts: null, show: false })).toBe("detect");
  });
  test("detects when there is no entry", () => {
    expect(toggleAction(undefined)).toBe("detect");
  });
});

const USER_NOTE =
  "Three things for tomorrow, one from the car registration, two book flights, three, call mom back.";

describe("rulesStarts — explicit enumerations", () => {
  const render = (text: string) => {
    const starts = rulesStarts(text) as number[];
    const built = buildList(text, starts);
    return { starts, built, ok: validateList(text, built) };
  };

  test("the user's note: bare cardinals, whisper's 'from' kept", () => {
    const { starts, built, ok } = render(USER_NOTE);
    expect(starts).toHaveLength(3);
    expect(built.lead).toBe("Three things for tomorrow");
    expect(built.items).toEqual([
      "From the car registration",
      "Book flights",
      "Call mom back.",
    ]);
    expect(ok).toBe(true);
  });
  test("mixed families: speech switches from ordinals to cardinals", () => {
    const text =
      "Okay, three things for tomorrow. First, renew the car registration. Second, book the flights. Three, call Mom back.";
    const { built, ok } = render(text);
    expect(built.lead).toBe("Okay, three things for tomorrow.");
    expect(built.items).toEqual([
      "Renew the car registration.",
      "Book the flights.",
      "Call Mom back.",
    ]);
    expect(ok).toBe(true);
  });
  test("'and' between the comma and a marker", () => {
    const text = "Number one, buy milk, and number two, call the dentist.";
    const { built, ok } = render(text);
    expect(built.items).toEqual(["Buy milk", "Call the dentist."]);
    expect(ok).toBe(true);
  });
  test("mixed families still need 3 markers", () => {
    expect(rulesStarts("First, buy milk. Two eggs would be nice.")).toBeNull();
  });
  test("ordinals", () => {
    const text =
      "First, renew the car registration. Second, book the flights. Third, call mom back.";
    const { built, ok } = render(text);
    expect(built.lead).toBe("");
    expect(built.items).toEqual([
      "Renew the car registration.",
      "Book the flights.",
      "Call mom back.",
    ]);
    expect(ok).toBe(true);
  });
  test("two ordinals are enough; firstly/secondly work", () => {
    const { built } = render(
      "Firstly, buy milk today. Secondly, call mom back",
    );
    expect(built.items).toEqual(["Buy milk today.", "Call mom back"]);
  });
  test("'number one … number two …'", () => {
    const text =
      "Okay here we go. Number one, buy milk today. Number two, call the dentist. Number three, email Sam.";
    const { built, ok } = render(text);
    expect(built.lead).toBe("Okay here we go.");
    expect(built.items).toEqual([
      "Buy milk today.",
      "Call the dentist.",
      "Email Sam.",
    ]);
    expect(ok).toBe(true);
  });
  test("two 'number' markers are enough", () => {
    expect(
      rulesStarts("Number one, buy milk. Number two, call mom"),
    ).toHaveLength(2);
  });
  test("bare cardinals need 3 markers", () => {
    expect(
      rulesStarts("Plans: one, buy milk now. Two, call mom now"),
    ).toBeNull();
    expect(
      rulesStarts("Plans: one, buy milk now. Two, call mom now. Three, nap"),
    ).toHaveLength(3);
  });
  test("markers without a comma still count after sentence punctuation", () => {
    const { built, ok } = render(
      "First buy milk today. Second call mom today.",
    );
    expect(built.items).toEqual(["Buy milk today.", "Call mom today."]);
    expect(ok).toBe(true);
  });
  test("a marker at the start of a new line counts", () => {
    expect(
      rulesStarts("one buy milk\ntwo call mom\nthree nap now"),
    ).toHaveLength(3);
  });
  test("case-insensitive", () => {
    expect(rulesStarts("FIRST, buy milk. SECOND, call mom")).toHaveLength(2);
  });
  test("negative: 'I have one idea and two questions'", () => {
    expect(rulesStarts("I have one idea and two questions")).toBeNull();
    expect(
      rulesStarts("I have one idea and two questions and three problems"),
    ).toBeNull();
  });
  test("negative: counting in a row has no punctuation before the markers", () => {
    expect(rulesStarts("one two three four")).toBeNull();
    expect(rulesStarts("count with me one two three four five")).toBeNull();
  });
  test("negative: out of order", () => {
    expect(
      rulesStarts("Second, buy milk. First, call mom. Third, nap"),
    ).toBeNull();
    expect(
      rulesStarts("Two, buy milk. One, call mom. Three, nap now"),
    ).toBeNull();
  });
  test("negative: a chain must start at 1", () => {
    expect(rulesStarts("Second, buy milk. Third, call mom")).toBeNull();
  });
  test("negative: a single marker, or a gap after the first", () => {
    expect(rulesStarts("First, buy milk and call mom")).toBeNull();
    expect(rulesStarts("First, buy milk. Third, call mom")).toBeNull();
  });
  test("negative: ambiguous marker (two candidate 'second's) is null", () => {
    expect(
      rulesStarts("First, buy milk. Second, call mom. Second, nap. Third, go"),
    ).toBeNull();
  });
  test("negative: hyphenated or dotted markers aren't markers", () => {
    expect(rulesStarts("First-class seats. Second-hand books")).toBeNull();
    expect(rulesStarts("First. Second. Third.")).toBeNull();
  });
  test("negative: two families matching at once is null", () => {
    expect(
      rulesStarts(
        "First, buy milk. Second, call mom. Then: one, a. two, b. three, c",
      ),
    ).toBeNull();
  });
  test("a marker at the very end with nothing after is null", () => {
    expect(rulesStarts("First, buy milk. Second")).toBeNull();
  });
  test("a 'second' mid-sentence ('a second') isn't a marker", () => {
    expect(
      rulesStarts("Wait a second, buy milk. Then call mom later"),
    ).toBeNull();
  });
});

describe("rulesDetect / autoListPlan", () => {
  test("rulesDetect indexes listText and passes validation", () => {
    const raw = `${USER_NOTE.replace("tomorrow, one", "tomorrow,   \none")}`;
    const starts = rulesDetect(raw) as number[];
    expect(starts).toHaveLength(3);
    expect(displayBody(listText(raw), { starts, show: true })).toContain(
      "- Call mom back.",
    );
  });
  test("the short user note (98 chars) is rule-formatted despite the length gate", () => {
    expect(needsListCheck(USER_NOTE)).toBe(false);
    expect(autoListPlan(USER_NOTE)).toEqual({
      starts: rulesDetect(USER_NOTE),
    });
  });
  test("a long non-enumerated note goes to Claude", () => {
    expect(autoListPlan(GROCERY)).toBe("claude");
  });
  test("a short non-list note is skipped", () => {
    expect(autoListPlan("buy milk")).toBe("skip");
  });
  test("a note with a screenshot is always skipped", () => {
    expect(
      autoListPlan(`${USER_NOTE}\n\n![screenshot](inbox-assets/a.png)`),
    ).toBe("skip");
  });
});

describe("trailing enumeration markers", () => {
  test("a trailing cardinal after a comma is stripped, comma cleaned", () => {
    const body = "Three things for tomorrow, one buy milk now";
    const built = buildList(body, [body.indexOf("buy"), body.length - 3]);
    expect(built.lead).toBe("Three things for tomorrow");
  });
  test("'number <cardinal>' after punctuation is stripped", () => {
    const body = "Buy milk today, number two call mom today";
    const built = buildList(body, [0, body.indexOf("call")]);
    expect(built.items[0]).toBe("Buy milk today");
  });
  test("a period before an ordinal/cardinal marker is kept", () => {
    const body = "Buy milk today. Two call mom today";
    const built = buildList(body, [0, body.indexOf("call")]);
    expect(built.items[0]).toBe("Buy milk today.");
  });
  test("a cardinal not at the very end stays", () => {
    const body = "Buy milk, one gallon of it. Call mom";
    const built = buildList(body, [0, body.indexOf("Call")]);
    expect(built.items[0]).toBe("Buy milk, one gallon of it.");
  });
  test("a cardinal glued to a word (no punctuation) stays", () => {
    const body = "I want one call mom today";
    const built = buildList(body, [0, body.indexOf("call")]);
    expect(built.items[0]).toBe("I want one");
  });
  test("validator skips cardinals and 'number', not other words", () => {
    expect(
      validateList("buy milk. number two call mom", {
        lead: "",
        items: ["Buy milk.", "Call mom"],
      }),
    ).toBe(true);
    expect(
      validateList("buy milk. eleven call mom", {
        lead: "",
        items: ["Buy milk.", "Call mom"],
      }),
    ).toBe(false);
  });
});

describe("leadInStarts — unnumbered lists announced by a lead-in", () => {
  const render = (text: string) => {
    const starts = rulesStarts(text) as number[];
    const built = buildList(text, starts);
    return { starts, built, ok: validateList(text, built) };
  };

  test("lead-in + one item per line", () => {
    const text =
      "A few things for tomorrow.\nRenew the car registration\nbook the flights, probably Thursday\ncall mom back";
    const { starts, built, ok } = render(text);
    expect(starts).toEqual([
      text.indexOf("Renew"),
      text.indexOf("book"),
      text.indexOf("call"),
    ]);
    expect(built.lead).toBe("A few things for tomorrow.");
    expect(built.items).toEqual([
      "Renew the car registration",
      "Book the flights, probably Thursday",
      "Call mom back",
    ]);
    expect(ok).toBe(true);
    expect(renderList(built)).toBe(
      "A few things for tomorrow.\n- Renew the car registration\n- Book the flights, probably Thursday\n- Call mom back",
    );
  });
  test("first item on the lead line, after the lead clause's comma", () => {
    const text =
      "Some things I noticed in the sidebar, it doesn't scroll\nthe icons are blurry";
    const { built, ok } = render(text);
    expect(built.lead).toBe("Some things I noticed in the sidebar");
    expect(built.items).toEqual(["It doesn't scroll", "The icons are blurry"]);
    expect(ok).toBe(true);
  });
  test("leadInStarts returns the same offsets as rulesStarts when no markers", () => {
    const text = "A few things for tomorrow.\nbuy milk\ncall mom";
    expect(leadInStarts(text)).toEqual(rulesStarts(text));
  });
  test("blank lines and indentation are skipped; starts are first non-space chars", () => {
    const text = "A few things for tomorrow.\n\n   buy milk\n\ncall mom\n";
    expect(leadInStarts(text)).toEqual([
      text.indexOf("buy"),
      text.indexOf("call"),
    ]);
  });
  test("stated count splits sentences when it matches", () => {
    const text =
      "Three things for tomorrow. Renew the car registration. Book the flights. Call mom back.";
    const { built, ok } = render(text);
    expect(built.lead).toBe("Three things for tomorrow.");
    expect(built.items).toEqual([
      "Renew the car registration.",
      "Book the flights.",
      "Call mom back.",
    ]);
    expect(ok).toBe(true);
  });
  test("stated count that the lines match uses the lines", () => {
    const text = "Two things for tomorrow.\nbuy milk. and eggs\ncall mom back.";
    const { built } = render(text);
    expect(built.items).toEqual(["Buy milk. and eggs", "Call mom back."]);
  });
  test("stated count, mismatched sentences: not a list", () => {
    expect(
      rulesStarts(
        "Three things for tomorrow. Renew the registration. Book flights.",
      ),
    ).toBeNull();
    expect(
      rulesStarts("Two things for tomorrow.\nbuy milk\ncall mom\nwalk the dog"),
    ).toBeNull();
  });
  test("a stated count as a digit", () => {
    const { built } = render(
      "3 things for tomorrow. Renew it. Book it. Call mom.",
    );
    expect(built.items).toEqual(["Renew it.", "Book it.", "Call mom."]);
  });
  test("lead-in without a second item is left alone", () => {
    for (const text of [
      "A few thoughts on the design: it's too blue.",
      "Some things never change, and that's fine.",
      "I fixed a few bugs today and shipped the build.",
      "A couple of ideas came up in the meeting but nothing concrete.",
    ]) {
      expect(rulesStarts(text), text).toBeNull();
    }
  });
  test("no lead-in: line breaks alone don't make a list", () => {
    expect(rulesStarts("buy milk\ncall mom\nwalk the dog")).toBeNull();
  });
  test("a lead-in past the first sentence doesn't count", () => {
    expect(
      rulesStarts(
        "I was thinking. A few things for tomorrow.\nbuy milk\ncall mom",
      ),
    ).toBeNull();
  });
  test("explicit markers win over a lead-in", () => {
    const text =
      "A few things for tomorrow. First, buy milk. Second, call mom back.";
    const { built } = render(text);
    expect(built.items).toEqual(["Buy milk.", "Call mom back."]);
    expect(built.lead).toBe("A few things for tomorrow.");
  });
});

describe("hasLeadIn", () => {
  test("matches announcing first sentences", () => {
    for (const t of [
      "A few things for tomorrow.",
      "Some things I noticed in the sidebar",
      "Three ideas for the launch",
      "here's what I need",
      "My to-do list for today",
      "A couple of errands to run",
      "10 tasks left",
    ]) {
      expect(hasLeadIn(t), t).toBe(true);
    }
  });
  test("only the first sentence of the first line is checked", () => {
    expect(hasLeadIn("Hello there. A few things for tomorrow.")).toBe(false);
    expect(hasLeadIn("Hello there\nA few things for tomorrow.")).toBe(false);
  });
  test("ordinary text does not match", () => {
    expect(hasLeadIn("Buy milk on the way home")).toBe(false);
    expect(hasLeadIn("Some people are nice")).toBe(false);
  });
});

describe("autoListPlan — short lead-in notes", () => {
  test("a short lead-in note with no rule hit goes to Claude", () => {
    const body = "A few things for tomorrow: renew the car registration";
    expect(needsListCheck(body)).toBe(false);
    expect(rulesDetect(body)).toBeNull();
    expect(autoListPlan(body)).toBe("claude");
  });
  test("a short lead-in note the rules split is applied instantly", () => {
    const body = "A few things for tomorrow.\nbuy milk\ncall mom";
    expect(autoListPlan(body)).toEqual({ starts: rulesDetect(body) });
  });
  test("a lead-in with a screenshot is still skipped", () => {
    expect(
      autoListPlan(
        "A few things for tomorrow.\n\n![screenshot](inbox-assets/a.png)",
      ),
    ).toBe("skip");
  });
});

describe("bulletStarts — the spoken 'bullet' keyword", () => {
  const render = (text: string) => {
    const starts = rulesStarts(text) as number[];
    const built = buildList(text, starts);
    return { built, ok: validateList(text, built) };
  };

  test("lead + 'Bullet,' / 'Bullet' / 'bullet point' items, keyword dropped", () => {
    const text =
      "Things for tomorrow. Bullet, renew the car registration. Bullet book the flights, bullet point call mom back.";
    const { built, ok } = render(text);
    expect(built.lead).toBe("Things for tomorrow.");
    expect(built.items).toEqual([
      "Renew the car registration.",
      "Book the flights",
      "Call mom back.",
    ]);
    expect(ok).toBe(true);
  });
  test("no lead", () => {
    const { built, ok } = render("Bullet. Buy milk. Bullet. Call the dentist.");
    expect(built.lead).toBe("");
    expect(built.items).toEqual(["Buy milk.", "Call the dentist."]);
    expect(ok).toBe(true);
  });
  test("one 'bullet' is not a list", () => {
    expect(bulletStarts("Fix the bullet alignment on the slide.")).toBeNull();
    expect(rulesStarts("Fix the bullet alignment on the slide.")).toBeNull();
  });
  test("'bulletin' is not the keyword", () => {
    const text = "Read the bulletin. Then read the other bulletin.";
    expect(bulletStarts(text)).toBeNull();
    expect(rulesStarts(text)).toBeNull();
  });
  test("starts point just past each keyword", () => {
    const text = "Plan. bullet buy milk bullet point call mom";
    expect(bulletStarts(text)).toEqual([
      text.indexOf("buy"),
      text.indexOf("call"),
    ]);
  });
  test("bullet wins over numbering markers", () => {
    const text = "Bullet first, buy milk. Bullet second, call mom.";
    const { built } = render(text);
    expect(built.items).toEqual(["Buy milk.", "Call mom."]);
  });
  test("an empty bullet item fails validation (rulesDetect null)", () => {
    expect(rulesDetect("Bullet bullet call mom")).toBeNull();
  });
  test("the validator skips 'bullet' and 'point' but not other words", () => {
    expect(
      validateList("bullet point buy milk bullet call mom", {
        lead: "",
        items: ["Buy milk", "Call mom"],
      }),
    ).toBe(true);
  });
});

describe("signalStarts — glue after a lead-in (notes)", () => {
  const USER =
    "in the sidebar, a few things. I'd love a \"collapse all\" button or icon and then on laptop I noticed that if I open up multiple sidebar accordions, they're only so tall, so you have to scroll inside of each individual expanded menu. Instead, the whole sidebar should scroll, not an individual accordion menu component. And then also shortcut keys for play and pause. Also I should be able to multi-select videos and then click a prepare all.";

  test("the user's real note: 3 items, lead-in clause as the lead", () => {
    const starts = rulesStarts(USER) as number[];
    expect(starts).toHaveLength(3);
    const built = buildList(USER, starts);
    expect(built.lead).toBe("in the sidebar, a few things.");
    expect(built.items).toEqual([
      "I'd love a \"collapse all\" button or icon and then on laptop I noticed that if I open up multiple sidebar accordions, they're only so tall, so you have to scroll inside of each individual expanded menu. Instead, the whole sidebar should scroll, not an individual accordion menu component.",
      "Shortcut keys for play and pause.",
      "I should be able to multi-select videos and then click a prepare all.",
    ]);
    expect(validateList(USER, built)).toBe(true);
  });
  test("signalStarts alone gives the same offsets", () => {
    expect(signalStarts(USER)).toEqual(rulesStarts(USER));
  });
  test("a mid-sentence ', and then also' cuts an item", () => {
    const text = "A few things for tomorrow. Buy milk, and then also call mom";
    const starts = rulesStarts(text) as number[];
    const built = buildList(text, starts);
    expect(built.items).toEqual(["Buy milk", "Call mom"]);
    expect(validateList(text, built)).toBe(true);
  });
  test("'Another thing' / 'One more thing' / 'On top of that' / 'Plus,' cut and stay as spoken", () => {
    const text =
      "Some things I noticed. The icons are blurry. Another thing is the scroll. One more thing, the logo. On top of that the colors. Plus, the fonts.";
    const built = buildList(text, rulesStarts(text) as number[]);
    expect(built.items).toEqual([
      "The icons are blurry.",
      "Another thing is the scroll.",
      "One more thing, the logo.",
      "On top of that the colors.",
      "Plus, the fonts.",
    ]);
  });
  test("plain 'Plus' with no comma, bare 'and then', and plain sentence boundaries do not cut", () => {
    expect(
      signalStarts(
        "A few things. Buy milk and then call mom. Plus one for Sam. Then nap.",
      ),
    ).toBeNull();
  });
  test("no lead-in → null", () => {
    expect(
      signalStarts("Buy milk. Also call mom. And then also nap."),
    ).toBeNull();
  });
  test("lead-in but no glue → null", () => {
    expect(
      signalStarts("A few things for tomorrow. Buy milk. Call mom."),
    ).toBeNull();
  });
  test("'Some things never change. Also the sky is blue.' is one item → null", () => {
    expect(
      signalStarts("Some things never change. Also the sky is blue."),
    ).toBeNull();
    expect(
      rulesStarts("Some things never change. Also the sky is blue."),
    ).toBeNull();
  });
  test("'Also-ran' is not a glue word", () => {
    expect(
      signalStarts("A few things. Buy milk now. Also-ran lists are fine."),
    ).toBeNull();
  });
  test("explicit markers and the lead-in rule win over glue", () => {
    const text = "A few things for tomorrow.\nbuy milk\ncall mom. Also nap";
    const lead = leadInStarts(text);
    expect(rulesStarts(text)).toEqual(lead);
  });
  test("autoListPlan applies glue instantly (no Claude)", () => {
    expect(autoListPlan(USER)).toEqual({ starts: rulesDetect(USER) });
    expect(rulesDetect(USER)).not.toBeNull();
  });
});

describe("signalStarts — mixed signals after a lead-in", () => {
  const MIXED =
    "A few things for tomorrow. One, let's find a new cat and also find a new insurance provider. Bullet, take out the garbage.";

  test("the user's dictation: a counting word, glue and a bullet", () => {
    const starts = rulesStarts(MIXED) as number[];
    const built = buildList(MIXED, starts);
    expect(built.lead).toBe("A few things for tomorrow.");
    expect(built.items).toEqual([
      "Let's find a new cat",
      "Find a new insurance provider.",
      "Take out the garbage.",
    ]);
    expect(validateList(MIXED, built)).toBe(true);
    expect(signalStarts(MIXED, true)).toEqual(starts);
  });
  test('the user\'s note: bare "and number three," plus a stated count', () => {
    const text =
      "Three things for today. Let's get the car registration done. Number two, let's call mom back and number three, let's walk the dog.";
    const built = buildList(text, rulesStarts(text) as number[]);
    expect(built.lead).toBe("Three things for today.");
    expect(built.items).toEqual([
      "Let's get the car registration done.",
      "Let's call mom back",
      "Let's walk the dog.",
    ]);
    expect(validateList(text, built)).toBe(true);
    // A split that misses the stated count is rejected.
    expect(
      signalStarts(
        "Three things for today. Get the car registered. Number two, call mom back.",
        false,
      ),
    ).toBeNull();
  });
  test("glue alone: dictation (requireExplicit) says null, notes split", () => {
    const text =
      "A few things for tomorrow. Find a new cat and also find a new insurance provider.";
    expect(signalStarts(text, true)).toBeNull();
    const built = buildList(text, signalStarts(text, false) as number[]);
    expect(built.lead).toBe("A few things for tomorrow.");
    expect(built.items).toEqual([
      "Find a new cat",
      "Find a new insurance provider.",
    ]);
    expect(validateList(text, built)).toBe(true);
    // The notes path through rulesStarts is the non-explicit one.
    expect(rulesStarts(text)).toEqual(signalStarts(text, false));
  });
  test("no lead-in: never", () => {
    expect(
      signalStarts("Find a cat. Also, bullet, take out the garbage.", false),
    ).toBeNull();
    expect(
      signalStarts("Find a cat. Also, bullet, take out the garbage.", true),
    ).toBeNull();
  });
  test("counting word with a colon, and 'and number two'", () => {
    const text =
      "Some things I noticed. First: the icons are blurry, and number two, the sidebar won't scroll.";
    const built = buildList(text, signalStarts(text, true) as number[]);
    expect(built.lead).toBe("Some things I noticed.");
    expect(built.items).toEqual([
      "The icons are blurry",
      "The sidebar won't scroll.",
    ]);
    expect(validateList(text, built)).toBe(true);
  });
  test("a counting word without a comma or colon is not a signal", () => {
    expect(
      signalStarts("A few things for tomorrow. One cat. Two dogs.", false),
    ).toBeNull();
  });
  test("'also' is skippable in the validator", () => {
    expect(
      validateList("buy milk. also call mom", {
        lead: "",
        items: ["Buy milk.", "Call mom"],
      }),
    ).toBe(true);
  });
  test("a mid-sentence 'and also' (no 'then') now cuts", () => {
    const text = "A few things. Buy milk and also call mom";
    const built = buildList(text, signalStarts(text, false) as number[]);
    expect(built.items).toEqual(["Buy milk", "Call mom"]);
  });
});
