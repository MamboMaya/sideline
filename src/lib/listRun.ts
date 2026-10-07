// The Claude round-trip behind spoken-list formatting, plus the instant
// rules path in front of it, shared by the inbox auto-formatter (useInbox.ts)
// and the `l` key (useLists.ts). Kept out of listFormat.ts so that module
// stays pure and testable without Tauri.
import { sendToClaude } from "./commands";
import {
  buildListPrompt,
  listText,
  rulesDetect,
  startsFromReply,
} from "./listFormat";

// Both functions take the note's STORED body and work on `listText(body)` —
// the text cards, copy and `displayBody` use — so the returned offsets index
// the same string everywhere (a body with trailing spaces or an image link
// would otherwise shift them).

// Asks Claude where each item starts. Resolves to the offsets, or null for
// "not a list" — which includes any reply that fails validation. Rejects
// only when the Claude call itself fails; callers must NOT record that as
// "checked, not a list" (the note should be retried later).
export async function detectListViaClaude(
  body: string,
  model: string,
): Promise<number[] | null> {
  const text = listText(body);
  const reply = await sendToClaude(buildListPrompt(text), model);
  return startsFromReply(text, reply);
}

// Rules first (explicit "first, second…" / "one, two, three…" enumerations:
// instant, free, no Claude call), Claude only when the rules find nothing.
export async function detectListStarts(
  body: string,
  model: string,
): Promise<number[] | null> {
  return rulesDetect(body) ?? detectListViaClaude(body, model);
}
