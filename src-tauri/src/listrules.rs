//! Dictation's spoken-list formatting: an explicitly enumerated dictation
//! ("First, … Second, … Third, …", "one … two … three …", "number one …"),
//! or an announced one ("Three things for tomorrow." + exactly three
//! sentences, or + one item per line), pastes as a numbered
//! list. Rust port of the instant rules path in src/lib/listFormat.ts
//! (`rulesStarts`) — same rules, so a list the popover would format is the
//! list dictation formats. Rules only, no Claude: a model call would hold
//! every paste up by seconds, and pasted text can't be switched back the
//! way a card can.

use std::sync::LazyLock;

use regex::Regex;

const CARDINALS: [&str; 10] = [
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
];
const ORDINALS: [&[&str]; 5] = [
    &["first", "firstly"],
    &["second", "secondly"],
    &["third", "thirdly"],
    &["fourth"],
    &["fifth"],
];

/// One marker's place in the text: where the marker word starts, and where
/// the item it introduces starts (after the marker and its `,`/`:`).
struct Marker {
    word_start: usize,
    item_start: usize,
}

/// Finds an in-order chain of markers 1, 2, 3 … where step n accepts any
/// alternative in `family[n]`. A marker counts only as a whole word at the
/// start of the text or a line, or right after `[.,;:!?]` + whitespace
/// (optionally + "and"/"then"/"and then": "…milk, and number two",
/// "…fine. Then number three") — so "I have
/// one idea and two questions" never matches. A step with more than
/// one candidate is ambiguous → None.
fn marker_chain(text: &str, family: &[Vec<String>], min: usize) -> Option<Vec<Marker>> {
    let mut chain: Vec<Marker> = Vec::new();
    let mut pos = 0;
    for alts in family {
        let re = Regex::new(&format!(
            r"(?i)(?:^|\n[ \t]*|[.,;:!?]\s+(?:and\s+)?(?:then\s+)?)({})(?:[\s,:]|$)",
            alts.join("|")
        ))
        .ok()?;
        let found: Vec<(usize, usize)> = re
            .captures_iter(text)
            .filter_map(|c| c.get(1).map(|m| (m.start(), m.end())))
            .filter(|&(start, _)| start >= pos)
            .collect();
        match found.as_slice() {
            [] => break,
            [(word_start, word_end)] => {
                let rest = &text[*word_end..];
                let skip = rest.len() - rest.trim_start_matches([' ', '\t', '\n', ',', ':']).len();
                let item_start = word_end + skip;
                if !text[item_start..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphanumeric)
                {
                    return None;
                }
                chain.push(Marker {
                    word_start: *word_start,
                    item_start,
                });
                pos = item_start;
            }
            _ => return None,
        }
    }
    (chain.len() >= min).then_some(chain)
}

/// Mixed families first (speech switches: "First, … Second, … Three, …";
/// held to the ≥3 bar since it admits bare cardinals), then exactly one of
/// ordinals (≥2), "number N" (≥2), bare cardinals (≥3).
fn find_markers(text: &str) -> Option<Vec<Marker>> {
    let ordinals: Vec<Vec<String>> = ORDINALS
        .iter()
        .map(|alts| alts.iter().map(|s| s.to_string()).collect())
        .collect();
    let numbers: Vec<Vec<String>> = CARDINALS
        .iter()
        .map(|c| vec![format!(r"number\s+{c}")])
        .collect();
    let cardinals: Vec<Vec<String>> = CARDINALS.iter().map(|c| vec![c.to_string()]).collect();
    let mixed: Vec<Vec<String>> = (0..CARDINALS.len())
        .map(|i| {
            let mut alts = ordinals.get(i).cloned().unwrap_or_default();
            alts.extend(numbers[i].iter().cloned());
            alts.extend(cardinals[i].iter().cloned());
            alts
        })
        .collect();
    if let Some(chain) = marker_chain(text, &mixed, 3) {
        return Some(chain);
    }
    let mut hits = [
        marker_chain(text, &ordinals, 2),
        marker_chain(text, &numbers, 2),
        marker_chain(text, &cardinals, 3),
    ]
    .into_iter()
    .flatten();
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

/// Trims a lead/item: line breaks folded to spaces, then trailing commas,
/// semicolons, and a dangling "and"/"and then" (or "then" after sentence
/// punctuation) dropped (the next item's glue) — sentence punctuation stays.
fn tidy(s: &str) -> String {
    let mut out = s.split_whitespace().collect::<Vec<_>>().join(" ");
    loop {
        let before = out.len();
        out = out.trim_end_matches([',', ';', ' ']).to_string();
        for glue in [" and then", " and"] {
            if out.to_lowercase().ends_with(glue) {
                out.truncate(out.len() - glue.len());
            }
        }
        // "…fine. Then" + next marker; "by then" keeps its "then".
        let lower = out.to_lowercase();
        if [". then", "! then", "? then"]
            .iter()
            .any(|g| lower.ends_with(g))
        {
            out.truncate(out.len() - " then".len());
        }
        if out.len() == before {
            return out;
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’'))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// The same "nothing lost, nothing reworded" proof as the frontend's
/// `validateList`: walking both word sequences in order, the output may only
/// lack marker words and glue ("number", "and", "then"), and may only add the
/// "1." numbering.
fn preserves_words(original: &str, lead: &str, items: &[String]) -> bool {
    let skippable = |w: &str| {
        CARDINALS.contains(&w)
            || ORDINALS.iter().any(|alts| alts.contains(&w))
            || matches!(w, "number" | "and" | "then" | "also" | "bullet" | "point")
    };
    let rendered: Vec<String> = words(lead)
        .into_iter()
        .chain(items.iter().flat_map(|it| words(it)))
        .collect();
    let original = words(original);
    let mut i = 0;
    for w in &rendered {
        while i < original.len() && original[i] != *w {
            if !skippable(&original[i]) {
                return false;
            }
            i += 1;
        }
        if i == original.len() {
            return false;
        }
        i += 1;
    }
    original[i..].iter().all(|w| skippable(w))
}

/// The spoken item keyword: "bullet" (or "bullet point") before each item.
/// Chosen because it never occurred in the user's 170 voice notes (scanned
/// 2026-10-07), so it can't split a note by accident.
static BULLET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bbullet(?:\s+point)?\b[\s,.:;]*").unwrap());

/// Lead + items from the "bullet" keyword — at least two of them. Text
/// before the first is the lead; the keyword itself is dropped.
fn bullet_list(text: &str) -> Option<(String, Vec<String>)> {
    let hits: Vec<_> = BULLET_RE.find_iter(text).collect();
    if hits.len() < 2 {
        return None;
    }
    let lead = tidy(&text[..hits[0].start()]);
    let items = hits
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let end = hits.get(i + 1).map_or(text.len(), |n| n.start());
            capitalize(&tidy(&text[m.end()..end]))
        })
        .collect();
    Some((lead, items))
}

/// Lead + items from explicit markers.
fn marker_list(text: &str) -> Option<(String, Vec<String>)> {
    let markers = find_markers(text)?;
    let lead = tidy(&text[..markers[0].word_start]);
    let items = markers
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let end = markers.get(i + 1).map_or(text.len(), |n| n.word_start);
            capitalize(&tidy(&text[m.item_start..end]))
        })
        .collect();
    Some((lead, items))
}

/// A first sentence that announces a list without numbering it: "a few
/// things for tomorrow", "some things I noticed", "three ideas", "here's
/// what I need". `n` captures a stated count.
static LEAD_IN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:(?:a\s+)?few|(?:a\s+)?couple(?:\s+of)?|some|several|a\s+bunch\s+of|a\s+handful\s+of|(?P<n>two|three|four|five|six|seven|eight|nine|ten|[2-9]|10))\s+(?:more\s+|other\s+|quick\s+|small\s+|big\s+|different\s+)?(?:things|items|ideas|tasks|to-?dos|notes|points|issues|bugs|changes|fixes|questions|reminders|errands|steps|thoughts)\b|\b(?:to-?do list|here'?s what|here'?s my list)\b",
    )
    .unwrap()
});

/// Byte index just past the first sentence end (`[.!?:]` + whitespace or
/// end of text) at or after `from`, if any.
fn sentence_end(s: &str, from: usize) -> Option<usize> {
    s[from..].char_indices().find_map(|(i, c)| {
        let at = from + i;
        let next = s[at + c.len_utf8()..].chars().next();
        (matches!(c, '.' | '!' | '?' | ':') && next.is_none_or(char::is_whitespace))
            .then_some(at + c.len_utf8())
    })
}

fn sentences(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(end) = sentence_end(s, from) {
        out.push(s[from..end].trim().to_string());
        from = end;
    }
    out.push(s[from..].trim().to_string());
    out.retain(|x| !x.is_empty());
    out
}

/// Lead + items for an UNNUMBERED list: the first sentence must be a
/// lead-in (`LEAD_IN_RE`), and the items come from one of two signals —
/// one item per line (typed or pasted text), or a stated count ("three
/// things …" followed by exactly three sentences). With a stated count,
/// only a split that yields exactly that many items qualifies; without
/// one, at least two lines.
fn lead_in_list(text: &str) -> Option<(String, Vec<String>)> {
    let (line0, rest_lines) = text.split_once('\n').unwrap_or((text, ""));
    let region = &line0[..sentence_end(line0, 0).unwrap_or(line0.len())];
    let caps = LEAD_IN_RE.captures(region)?;
    let lead_in_end = caps.get(0)?.end();
    let count = caps
        .name("n")
        .map(|n| match n.as_str().to_lowercase().as_str() {
            d if d.chars().all(|c| c.is_ascii_digit()) => d.parse::<usize>().unwrap_or(0),
            w => CARDINALS.iter().position(|c| *c == w).map_or(0, |i| i + 1),
        });
    // The lead clause runs to the first `,;:.!?` after the lead-in; anything
    // after it on the same line is the first item.
    let (lead, first_rest) = match line0[lead_in_end..].find([',', ';', ':', '.', '!', '?']) {
        Some(i) => line0.split_at(lead_in_end + i + 1),
        None => (line0, ""),
    };
    let chunks: Vec<String> = std::iter::once(first_rest)
        .chain(rest_lines.split('\n'))
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .collect();
    let items = match count {
        Some(n) if chunks.len() == n => chunks,
        Some(n) => {
            let sents = sentences(&chunks.join(" "));
            if sents.len() != n {
                return None;
            }
            sents
        }
        None if chunks.len() >= 2 => chunks,
        None => return None,
    };
    Some((
        tidy(lead),
        items.iter().map(|it| capitalize(&tidy(it))).collect(),
    ))
}

/// Item-start signals the union rule (`signal_list`) accepts, each as a
/// whole word. Explicit: the "bullet" keyword, or a counting word followed
/// by `,`/`:` at a clause start ("One, …", "first: …"). Glue: the user's
/// own connectors — a sentence opening with "Also", "And also", "And then
/// also", "Another thing", "One more thing", "On top of that", "Plus,", or
/// a mid-sentence "and also" / "and then also".
static MARKER_ITEM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^\s*|[.,;:!?]\s+(?:and\s+)?(?:then\s+)?)(?P<w>(?:number\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten)|first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth)\s*[,:]\s*",
    )
    .unwrap()
});
/// "… and number three, …": a "number N" label is explicit enough to start
/// an item after a bare "and", with no comma before it.
static AND_NUMBER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\sand\s+(?:then\s+)?(?P<w>number\s+(?:one|two|three|four|five|six|seven|eight|nine|ten))\s*[,:]\s*",
    )
    .unwrap()
});
static SENTENCE_GLUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^\s*|[.!?]\s+)(?P<w>(?:and\s+(?:then\s+)?)?also|another\s+thing|one\s+more\s+thing|on\s+top\s+of\s+that|plus,)(?:$|[^\p{L}\p{N}'’-])",
    )
    .unwrap()
});
static MID_GLUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[\s,](?P<w>and\s+(?:then\s+)?also)(?:$|[^\p{L}\p{N}'’-])").unwrap()
});
static LEADING_GLUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:and\s+then\s+also|and\s+also|also)(?:[\s,]+|$)").unwrap()
});

/// Lead + items for a list that mixes its signals — "A few things for
/// tomorrow. One, find a new cat and also find a new insurance provider.
/// Bullet, take out the garbage." Needs a lead-in first sentence; then any
/// signal (`MARKER_ITEM_RE`, "bullet", `SENTENCE_GLUE_RE`, `MID_GLUE_RE`)
/// starts an item, at least two items total. `require_explicit`
/// (dictation) also demands at least one explicit signal (a "bullet" or a
/// counting word), so connectors alone never split a paste.
fn signal_list(text: &str, require_explicit: bool) -> Option<(String, Vec<String>)> {
    let region = &text[..sentence_end(text, 0).unwrap_or(text.len())];
    let caps = LEAD_IN_RE.captures(region)?;
    let lead_in_end = caps.get(0)?.end();
    let count = caps
        .name("n")
        .map(|n| match n.as_str().to_lowercase().as_str() {
            d if d.chars().all(|c| c.is_ascii_digit()) => d.parse::<usize>().unwrap_or(0),
            w => CARDINALS.iter().position(|c| *c == w).map_or(0, |i| i + 1),
        });
    let clause_end = lead_in_end
        + text[lead_in_end..]
            .find([',', ';', ':', '.', '!', '?'])
            .map_or(text.len() - lead_in_end, |i| i + 1);
    let rest = &text[clause_end..];

    // (cut, item_start, explicit), offsets into `rest`.
    let mut cuts: Vec<(usize, usize, bool)> = Vec::new();
    for re in [&*MARKER_ITEM_RE, &*AND_NUMBER_RE] {
        for c in re.captures_iter(rest) {
            cuts.push((c.name("w")?.start(), c.get(0)?.end(), true));
        }
    }
    for m in BULLET_RE.find_iter(rest) {
        cuts.push((m.start(), m.end(), true));
    }
    for re in [&*SENTENCE_GLUE_RE, &*MID_GLUE_RE] {
        for c in re.captures_iter(rest) {
            let w = c.name("w")?;
            cuts.push((w.start(), w.start(), false));
        }
    }
    cuts.sort();

    let mut items: Vec<String> = Vec::new();
    let mut explicit = false;
    let (mut from, mut prev_end) = (0, 0);
    for (cut, start, is_explicit) in cuts {
        if cut < prev_end {
            continue; // inside a signal already taken ("bullet" + "also")
        }
        let item = &rest[from..cut];
        if !words(item).is_empty() {
            items.push(item.to_string());
        }
        explicit |= is_explicit;
        from = start;
        prev_end = start.max(cut + 1);
    }
    items.push(rest[from..].to_string());
    let items: Vec<String> = items
        .iter()
        .map(|it| capitalize(&tidy(&LEADING_GLUE_RE.replace(it.trim(), ""))))
        .filter(|it| !words(it).is_empty())
        .collect();
    // A stated count ("three things …") must match exactly.
    if items.len() < 2 || (require_explicit && !explicit) || count.is_some_and(|n| n != items.len())
    {
        return None;
    }
    Some((tidy(&text[..clause_end]), items))
}

/// The dictation transcript as a numbered list — lead line (if any), then
/// `1. item` lines — or None when it's neither an explicit enumeration nor
/// a lead-in list, or the split would lose a word.
pub(crate) fn number_list(text: &str) -> Option<String> {
    let (lead, items) = bullet_list(text)
        .or_else(|| marker_list(text))
        .or_else(|| lead_in_list(text))
        .or_else(|| signal_list(text, true))?;
    if items.len() < 2
        || items.iter().any(|it| words(it).is_empty())
        || !preserves_words(text, &lead, &items)
    {
        return None;
    }
    let mut out = String::new();
    if !lead.is_empty() {
        out.push_str(&lead);
        out.push('\n');
    }
    let numbered: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, it)| format!("{}. {it}", i + 1))
        .collect();
    out.push_str(&numbered.join("\n"));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinals_become_a_numbered_list_with_lead() {
        assert_eq!(
            number_list(
                "Okay, three things for tomorrow. First, renew the car registration. Second, book the flights. Third, call Mom back."
            )
            .as_deref(),
            Some(
                "Okay, three things for tomorrow.\n1. Renew the car registration.\n2. Book the flights.\n3. Call Mom back."
            )
        );
    }

    #[test]
    fn mixed_families_and_bare_cardinals() {
        assert_eq!(
            number_list(
                "Okay, three things for tomorrow. First, renew the car registration. Second, book the flights. Three, call Mom back."
            )
            .as_deref(),
            Some(
                "Okay, three things for tomorrow.\n1. Renew the car registration.\n2. Book the flights.\n3. Call Mom back."
            )
        );
        assert_eq!(
            number_list(
                "Three things for tomorrow, one from the car registration, two book flights, three, call mom back."
            )
            .as_deref(),
            Some(
                "Three things for tomorrow\n1. From the car registration\n2. Book flights\n3. Call mom back."
            )
        );
    }

    #[test]
    fn number_n_markers_and_glue() {
        assert_eq!(
            number_list("Number one, buy milk, and number two, call the dentist.").as_deref(),
            Some("1. Buy milk\n2. Call the dentist.")
        );
    }

    #[test]
    fn line_breaks_count_as_marker_boundaries() {
        assert_eq!(
            number_list("Plan for today\nfirst stretch\nsecond answer email").as_deref(),
            Some("Plan for today\n1. Stretch\n2. Answer email")
        );
    }

    #[test]
    fn ordinary_sentences_are_left_alone() {
        for text in [
            "I have one idea and two questions about three of the slides.",
            "First thing tomorrow, call mom.",
            "Do the laundry first. Then the dishes.",
            "One, two, three, four.",
            "Second, book the flights. Third, call mom.",
            "First, buy milk. Two eggs would be nice.",
        ] {
            assert_eq!(number_list(text), None, "{text}");
        }
    }

    #[test]
    fn lead_in_plus_one_item_per_line_makes_a_list() {
        assert_eq!(
            number_list(
                "A few things for tomorrow.\nRenew the car registration\nbook the flights, probably Thursday\ncall mom back"
            )
            .as_deref(),
            Some(
                "A few things for tomorrow.\n1. Renew the car registration\n2. Book the flights, probably Thursday\n3. Call mom back"
            )
        );
        // First item on the lead line, after the lead clause's comma.
        assert_eq!(
            number_list(
                "Some things I noticed in the sidebar, it doesn't scroll\nthe icons are blurry"
            )
            .as_deref(),
            Some("Some things I noticed in the sidebar\n1. It doesn't scroll\n2. The icons are blurry")
        );
    }

    #[test]
    fn stated_count_splits_sentences_when_it_matches() {
        assert_eq!(
            number_list(
                "Three things for tomorrow. Renew the car registration. Book the flights. Call mom back."
            )
            .as_deref(),
            Some(
                "Three things for tomorrow.\n1. Renew the car registration.\n2. Book the flights.\n3. Call mom back."
            )
        );
        // Count says three, text has two sentences: not a list.
        assert_eq!(
            number_list("Three things for tomorrow. Renew the registration. Book flights."),
            None
        );
    }

    #[test]
    fn lead_in_without_a_second_item_is_left_alone() {
        for text in [
            "A few thoughts on the design: it's too blue.",
            "Some things never change, and that's fine.",
            "I fixed a few bugs today and shipped the build.",
            "A couple of ideas came up in the meeting but nothing concrete.",
        ] {
            assert_eq!(number_list(text), None, "{text}");
        }
    }

    #[test]
    fn bullet_keyword_splits_items_and_is_dropped() {
        assert_eq!(
            number_list(
                "Things for tomorrow. Bullet, renew the car registration. Bullet book the flights, bullet point call mom back."
            )
            .as_deref(),
            Some(
                "Things for tomorrow.\n1. Renew the car registration.\n2. Book the flights\n3. Call mom back."
            )
        );
        // No lead.
        assert_eq!(
            number_list("Bullet. Buy milk. Bullet. Call the dentist.").as_deref(),
            Some("1. Buy milk.\n2. Call the dentist.")
        );
        // One "bullet" is not a list; "bulletin" is not the keyword.
        assert_eq!(number_list("Fix the bullet alignment on the slide."), None);
        assert_eq!(
            number_list("Read the bulletin. Then read the other bulletin."),
            None
        );
    }

    #[test]
    fn mixed_signals_after_a_lead_in() {
        // The user's real dictation: a counting word, glue, and a bullet.
        assert_eq!(
            number_list(
                "A few things for tomorrow. One, let's find a new cat and also find a new insurance provider. Bullet, take out the garbage."
            )
            .as_deref(),
            Some(
                "A few things for tomorrow.\n1. Let's find a new cat\n2. Find a new insurance provider.\n3. Take out the garbage."
            )
        );
        // Dictation needs one explicit signal: glue alone stays plain…
        assert_eq!(
            number_list(
                "A few things for tomorrow. Find a new cat and also find a new insurance provider."
            ),
            None
        );
        // …but the notes path (require_explicit = false) splits it.
        let (lead, items) = signal_list(
            "A few things for tomorrow. Find a new cat and also find a new insurance provider.",
            false,
        )
        .unwrap();
        assert_eq!(lead, "A few things for tomorrow.");
        assert_eq!(items, ["Find a new cat", "Find a new insurance provider."]);
        // The user's real note: "and number three," with no comma first,
        // and a stated count the split must match.
        assert_eq!(
            number_list(
                "Three things for today. Let's get the car registration done. Number two, let's call mom back and number three, let's walk the dog."
            )
            .as_deref(),
            Some(
                "Three things for today.\n1. Let's get the car registration done.\n2. Let's call mom back\n3. Let's walk the dog."
            )
        );
        assert_eq!(
            signal_list(
                "Three things for today. Get the car registered. Number two, call mom back.",
                false
            ),
            None
        );
        // "Also-ran" is not the glue word "also".
        assert_eq!(
            signal_list(
                "A few things for tomorrow. Buy milk. Also-ran horses win.",
                false
            ),
            None
        );
        // No lead-in: never.
        assert_eq!(
            signal_list("Find a cat. Also, bullet, take out the garbage.", false),
            None
        );
    }

    #[test]
    fn bare_then_before_a_marker() {
        // The user's real dictation: "Then number three," after a period.
        assert_eq!(
            number_list(
                "Okay, a few things. Number one, let's get rid of the demo view button that lives on projects. Number two, right next to that button there is a text that says two projects. We don't have to list the number of projects. That's fine. Then number three, I want the ability to search from not only each page, but a command K that will let me search through entire, like all the tables. Then number four, do we need a client's page? We have leads, we have projects, but we don't have clients. What do you think?"
            )
            .as_deref(),
            Some(
                "Okay, a few things.\n1. Let's get rid of the demo view button that lives on projects.\n2. Right next to that button there is a text that says two projects. We don't have to list the number of projects. That's fine.\n3. I want the ability to search from not only each page, but a command K that will let me search through entire, like all the tables.\n4. Do we need a client's page? We have leads, we have projects, but we don't have clients. What do you think?"
            )
        );
        // "by then" at an item's end is content, not glue.
        assert_eq!(
            number_list("First, finish the slides by then. Second, send them.").as_deref(),
            Some("1. Finish the slides by then.\n2. Send them.")
        );
    }

    #[test]
    fn ambiguous_second_marker_is_rejected() {
        assert_eq!(
            number_list("First, buy milk. Second, eggs. Second, bread."),
            None
        );
    }
}
