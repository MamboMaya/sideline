//! Dictation's spoken-list formatting: an explicitly enumerated dictation
//! ("First, … Second, … Third, …", "one … two … three …", "number one …"),
//! or an announced one ("A few things for tomorrow." + pause-separated
//! chunks, or a stated count matched by sentences), pastes as a numbered
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
/// (optionally + "and"/"and then": "…milk, and number two") — so "I have
/// one idea and two questions" never matches. A step with more than
/// one candidate is ambiguous → None.
fn marker_chain(text: &str, family: &[Vec<String>], min: usize) -> Option<Vec<Marker>> {
    let mut chain: Vec<Marker> = Vec::new();
    let mut pos = 0;
    for alts in family {
        let re = Regex::new(&format!(
            r"(?i)(?:^|\n[ \t]*|[.,;:!?]\s+(?:and\s+(?:then\s+)?)?)({})(?:[\s,:]|$)",
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
/// semicolons, and a dangling "and"/"and then" dropped (the next item's
/// glue) — sentence punctuation stays.
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
            || matches!(w, "number" | "and" | "then")
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
/// the pause line breaks whisper.rs put in (each pause-separated chunk is
/// an item), or a stated count ("three things …" followed by exactly three
/// sentences). With a stated count, only a split that yields exactly that
/// many items qualifies; without one, at least two pause chunks.
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

/// The dictation transcript as a numbered list — lead line (if any), then
/// `1. item` lines — or None when it's neither an explicit enumeration nor
/// a lead-in list, or the split would lose a word.
pub(crate) fn number_list(text: &str) -> Option<String> {
    let (lead, items) = marker_list(text).or_else(|| lead_in_list(text))?;
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
    fn pause_line_breaks_count_as_marker_boundaries() {
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
    fn lead_in_plus_pauses_makes_a_list() {
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
    fn ambiguous_second_marker_is_rejected() {
        assert_eq!(
            number_list("First, buy milk. Second, eggs. Second, bread."),
            None
        );
    }
}
