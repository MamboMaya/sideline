//! Rule-based filler-word cleanup for voice transcripts (Settings → Voice →
//! "Remove filler words (um, uh, repeats)", `.sideline.json`'s `cleanFillers`
//! key — see docs/data-model.md). Purely regex/word-level passes: no network
//! call, no LLM, so it adds no latency to the recording pipeline. Applied in
//! audio.rs's `finish_recording`, after the dictionary corrections and
//! before the Note/Dictate/Ask hand-off. `capture/voice-note.sh` (the
//! external Raycast capture path) is NOT touched — this only runs in-app.

use std::sync::LazyLock;

use regex::Regex;

/// Hesitation fillers removed outright, case-insensitive, whole-word only —
/// `\b`...`\b` means "umbrella", "uhaul", and "err" (not in this list at
/// all) are never touched — with an attached trailing comma or ellipsis
/// swallowed along with the word ("Um, I think" -> "I think", "so... um...
/// ok" -> "so... ok").
static HESITATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:um|umm|uh|uhh|uhm|erm|er|hmm|mm|ah)\b(?:\.\.\.|,)?").unwrap()
});

/// A hesitation token delimited by commas on both sides (", uh,") drops
/// both commas, like the discourse fillers below, so the clauses rejoin
/// ("I think, uh, this works" -> "I think this works") instead of leaving a
/// stray comma behind. Runs before `HESITATION_RE`.
static HESITATION_MID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i),\s*(?:um|umm|uh|uhh|uhm|erm|er|hmm|mm|ah)\s*,").unwrap());

/// Discourse fillers, comma-delimited mid-sentence: ", you know,", ", I
/// mean,", ", like,", ", sort of,", ", kind of,". Both commas are part of
/// the match and removed with it, so the surrounding clauses just rejoin
/// ("I think, you know, that's true" -> "I think that's true"). Never
/// matches a bare "like"/"you know" without a comma on both sides, so
/// "I like it" and "do you know him" are untouched.
static DISCOURSE_MID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i),\s*(?:you know|i mean|like|sort of|kind of)\s*,").unwrap());

/// Same fillers, sentence-initial ("You know, I think this works" -> "I
/// think this works"): the boundary (start of the line, or a `. `/`! `/`? `
/// sentence break) is captured back into the replacement; only the filler
/// and its trailing comma are dropped. `^\s*` tolerates a leading space —
/// cheap insurance, since this pass runs before `HESITATION_RE` in
/// `strip_fillers_line` and shouldn't rely on that order.
static DISCOURSE_START_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^\s*|[.!?]+\s+)(?:you know|i mean|like|sort of|kind of)\s*,\s*").unwrap()
});

/// Tidy-up passes for artifacts the removals above can leave behind: a
/// space stranded before a comma/period, doubled commas, a comma directly
/// before a period, and a leading comma at the start of the line.
static SPACE_BEFORE_PUNCT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+([,.])").unwrap());
static MULTI_COMMA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",(?:\s*,)+").unwrap());
static COMMA_DOT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",\s*\.").unwrap());
static LEADING_COMMA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^,\s*").unwrap());

/// Re-capitalizes the first letter of the line and of every sentence start
/// (after `.`/`!`/`?` + whitespace) that's gone lowercase — either because
/// it was never capitalized, or because it lost its original first word to
/// one of the removals above ("um, that's true" -> "That's true").
static SENTENCE_START_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[.!?]+\s+)([a-z])").unwrap());

/// Words that legitimately repeat back-to-back — never collapsed by
/// `collapse_stutters` below. "is is", "had had", "that that" are all real
/// English ("the thing that that book describes"); "I I", "the the", "to to
/// to" are not.
const STUTTER_ALLOWLIST: &[&str] = &["that", "had", "is"];

/// Strips filler words, hesitations, and stutters from one voice
/// transcript. Pure and rule-based — no network, no LLM — so it adds no
/// latency. Idempotent, and a no-op (unchanged output) on text with nothing
/// to strip. Multi-line input is processed line by line and rejoined with
/// `\n`, so line breaks are always preserved.
pub(crate) fn strip_fillers(text: &str) -> String {
    text.split('\n')
        .map(strip_fillers_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_fillers_line(line: &str) -> String {
    let s = DISCOURSE_START_RE.replace_all(line, "$1");
    let s = DISCOURSE_MID_RE.replace_all(&s, "");
    let s = HESITATION_MID_RE.replace_all(&s, "");
    let s = HESITATION_RE.replace_all(&s, "");
    let s = collapse_stutters(&s);
    let s = SPACE_BEFORE_PUNCT_RE.replace_all(&s, "$1");
    let s = MULTI_COMMA_RE.replace_all(&s, ",");
    let s = COMMA_DOT_RE.replace_all(&s, ".");
    let s = LEADING_COMMA_RE.replace_all(&s, "");
    let s = SENTENCE_START_RE.replace_all(&s, |caps: &regex::Captures| {
        format!("{}{}", &caps[1], caps[2].to_uppercase())
    });
    s.into_owned()
}

/// A word stripped of any leading/trailing punctuation and lowercased, for
/// stutter-equality comparisons only — the original token (punctuation and
/// all) is what actually gets kept in the output.
fn word_core(w: &str) -> String {
    w.trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

/// Collapses immediate case-insensitive repeats of the same word down to
/// one, keeping the LAST occurrence in the run (so any trailing punctuation
/// on it — "well, well, that's odd" — survives). Also collapses runs of
/// three or more ("to to to" -> "to"). Doubles up in `STUTTER_ALLOWLIST`
/// are left alone. Splitting on whitespace and rejoining with single spaces
/// is also what collapses any doubled/stranded spacing left by the earlier
/// filler-removal passes.
fn collapse_stutters(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut out: Vec<&str> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        let core = word_core(words[i]);
        if core.is_empty() || STUTTER_ALLOWLIST.contains(&core.as_str()) {
            out.push(words[i]);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < words.len() && word_core(words[j]) == core {
            j += 1;
        }
        out.push(words[j - 1]);
        i = j;
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- hesitation tokens ----

    #[test]
    fn removes_standalone_hesitation_tokens() {
        assert_eq!(
            strip_fillers("Um, I think this works."),
            "I think this works."
        );
        assert_eq!(
            strip_fillers("I think, uh, this works."),
            "I think this works."
        );
    }

    #[test]
    fn removes_every_listed_hesitation_token_case_insensitively() {
        for tok in [
            "um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "mm", "ah",
        ] {
            let upper = tok.to_uppercase();
            assert_eq!(
                strip_fillers(&format!("Okay {upper} let's go.")),
                "Okay let's go.",
                "token {tok} was not stripped"
            );
        }
    }

    #[test]
    fn swallows_trailing_comma_or_ellipsis_on_a_hesitation_token() {
        assert_eq!(
            strip_fillers("So... um... I think so."),
            "So... I think so."
        );
    }

    #[test]
    fn never_touches_real_words_containing_hesitation_tokens() {
        assert_eq!(
            strip_fillers("Grab an umbrella before the Uhaul trip."),
            "Grab an umbrella before the Uhaul trip."
        );
        assert_eq!(
            strip_fillers("Please err on the side of caution."),
            "Please err on the side of caution."
        );
    }

    // ---- discourse fillers ----

    #[test]
    fn removes_comma_delimited_discourse_fillers() {
        assert_eq!(
            strip_fillers("I think, you know, that's true."),
            "I think that's true."
        );
        assert_eq!(
            strip_fillers("It's, I mean, complicated."),
            "It's complicated."
        );
        assert_eq!(
            strip_fillers("It's, like, complicated."),
            "It's complicated."
        );
        assert_eq!(
            strip_fillers("We should, sort of, wrap this up."),
            "We should wrap this up."
        );
        assert_eq!(
            strip_fillers("We should, kind of, wrap this up."),
            "We should wrap this up."
        );
    }

    #[test]
    fn removes_sentence_initial_discourse_fillers() {
        assert_eq!(
            strip_fillers("You know, I think this works."),
            "I think this works."
        );
        assert_eq!(
            strip_fillers("Good point. Like, we should ship it."),
            "Good point. We should ship it."
        );
    }

    #[test]
    fn never_removes_bare_discourse_fillers_mid_sentence() {
        assert_eq!(strip_fillers("I like it a lot."), "I like it a lot.");
        assert_eq!(strip_fillers("Do you know him?"), "Do you know him?");
        assert_eq!(
            strip_fillers("I like it a lot, you know."),
            "I like it a lot, you know."
        );
    }

    // ---- stutters ----

    #[test]
    fn collapses_immediate_stutter_repeats() {
        assert_eq!(
            strip_fillers("I I think we should go."),
            "I think we should go."
        );
        assert_eq!(
            strip_fillers("It's the the best option."),
            "It's the best option."
        );
        assert_eq!(
            strip_fillers("We need to to to leave."),
            "We need to leave."
        );
    }

    #[test]
    fn keeps_allowlisted_legitimate_doubles() {
        assert_eq!(
            strip_fillers("That that is a good question."),
            "That that is a good question."
        );
        assert_eq!(
            strip_fillers("The dog had had enough."),
            "The dog had had enough."
        );
        assert_eq!(strip_fillers("It is is confusing."), "It is is confusing.");
    }

    #[test]
    fn stutter_collapse_is_case_insensitive() {
        assert_eq!(strip_fillers("the The dog barked."), "The dog barked.");
    }

    // ---- tidy-up ----

    #[test]
    fn cleans_up_leftover_punctuation_artifacts() {
        // Removing "um" leaves a stranded space before the comma.
        assert_eq!(
            strip_fillers("I think um , that's true."),
            "I think, that's true."
        );
    }

    #[test]
    fn drops_a_leading_comma() {
        // "You know," removed at the very start leaves nothing before the
        // comma of "you know, ," — the leading-comma tidy-up drops it.
        assert_eq!(strip_fillers(", that's true."), "That's true.");
    }

    #[test]
    fn recapitalizes_a_sentence_that_lost_its_first_word() {
        assert_eq!(strip_fillers("um, that's crazy."), "That's crazy.");
    }

    // ---- combined / real-world shaped ----

    #[test]
    fn combined_example_with_hesitation_and_discourse_fillers() {
        // Comma-wrapped fillers take both commas with them, so the
        // clauses rejoin with no stray comma left behind.
        assert_eq!(
            strip_fillers("So, um, I think, you know, we should, uh, ship it."),
            "So I think we should ship it."
        );
    }

    #[test]
    fn hesitation_removal_can_create_a_new_stutter_to_collapse() {
        assert_eq!(strip_fillers("I um I think so."), "I think so.");
    }

    // ---- idempotency / no-ops ----

    #[test]
    fn is_idempotent() {
        let inputs = [
            "So, um, I think, you know, we should, uh, ship it.",
            "I I think the the plan works.",
            "That that is a good question.",
            "Grab an umbrella before the Uhaul trip.",
        ];
        for input in inputs {
            let once = strip_fillers(input);
            let twice = strip_fillers(&once);
            assert_eq!(once, twice, "not idempotent for {input:?}");
        }
    }

    #[test]
    fn leaves_clean_text_unchanged() {
        let text = "Ship the release tonight and tell the team tomorrow.";
        assert_eq!(strip_fillers(text), text);
    }

    #[test]
    fn preserves_line_breaks() {
        let text = "First line is fine.\nUm, second line needs cleanup.\nThird line is fine.";
        assert_eq!(
            strip_fillers(text),
            "First line is fine.\nSecond line needs cleanup.\nThird line is fine."
        );
    }

    #[test]
    fn empty_string_is_unchanged() {
        assert_eq!(strip_fillers(""), "");
    }
}
