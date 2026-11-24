//! The checks on a reply: its shape, its coverage of the hierarchy, the
//! language and encoding of its names, their length, and repeats.

use crate::hierarchy::Hierarchy;
use std::collections::{BTreeMap, BTreeSet};

/// The most characters a cleaned name may have.
pub const MAX_NAME_CHARS: usize = 50;

/// The share of names that may be in the wrong script or language before the
/// whole reply falls back: more than one in five fails.
pub fn over_limit(bad: usize, total: usize) -> bool {
    bad * 5 > total
}

/// The prefixes the pipeline's `clean_topic_name` strips, in its order.
const PREFIXES: [&str; 17] = [
    "Here is the list of topic labels:",
    "Here is the list of topic labels",
    "Here are the topic labels:",
    "Here are the topic labels",
    "Here is the topic label:",
    "Here is the topic label",
    "The topic label is:",
    "The topic label is",
    "Topic label:",
    "Here is a concise topic label:",
    "Here's a concise topic label:",
    "Concise topic label:",
    "Topic name:",
    "Topic name",
    "Topic:",
    "Label:",
    "Label",
];

/// The pipeline's `clean_topic_name`, without its 50-character cut (a longer
/// name is refused instead): an id prefix such as `0_3: `, the stock
/// prefixes, everything after the first line, surrounding quotes, a list
/// marker and asterisks are removed. `None` when nothing is left.
pub fn clean(raw: &str) -> Option<String> {
    let mut raw = raw.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = strip_id_prefix(&raw) {
        raw = rest.to_string();
    }
    for p in PREFIXES {
        if raw.starts_with(p) {
            raw = raw.replacen(p, "", 1);
        }
    }
    let first = raw.trim().split('\n').next().unwrap_or("").trim();
    let mut t = first.trim_matches(|c| c == '"' || c == '\'').to_string();
    if t.starts_with("1. ") || t.starts_with("- ") {
        // The original slices three characters off either marker.
        t = t.chars().skip(3).collect::<String>().trim().to_string();
    }
    let t = t.replace('*', "");
    if t.is_empty() { None } else { Some(t) }
}

/// `^\d+_\d+:\s*`: what is left after it, if it matches.
fn strip_id_prefix(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    if !digits(&mut i) || b.get(i) != Some(&b'_') {
        return None;
    }
    i += 1;
    if !digits(&mut i) || b.get(i) != Some(&b':') {
        return None;
    }
    i += 1;
    Some(s[i..].trim_start())
}

/// What a reply's text gave, before any name is judged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// The text is not `{"topics": [{"id": .., "name": ..}, ..]}`.
    BadJson(String),
    /// Some id is missing, unknown or repeated.
    BadCover {
        missing: usize,
        unknown: usize,
        repeated: usize,
    },
    /// Every id exactly once: the raw names by id.
    Covered(BTreeMap<String, String>),
}

/// Parses the reply text and checks that it names every topic exactly once.
pub fn parse_and_cover(h: &Hierarchy, text: &str) -> Parsed {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Parsed::BadJson("the reply text is not JSON".into()),
    };
    let Some(items) = v.get("topics").and_then(|t| t.as_array()) else {
        return Parsed::BadJson("the reply has no topics list".into());
    };
    let want: BTreeSet<&str> = h.topics().iter().map(|t| t.id.as_str()).collect();
    let mut names = BTreeMap::new();
    let (mut unknown, mut repeated) = (0, 0);
    for item in items {
        let (Some(id), Some(name)) = (
            item.get("id").and_then(|x| x.as_str()),
            item.get("name").and_then(|x| x.as_str()),
        ) else {
            return Parsed::BadJson("a topic in the reply has no string id or name".into());
        };
        if !want.contains(id) {
            unknown += 1;
        } else if names.contains_key(id) {
            repeated += 1;
        } else {
            names.insert(id.to_string(), name.to_string());
        }
    }
    let missing = want.len() - names.len();
    if missing + unknown + repeated > 0 {
        return Parsed::BadCover {
            missing,
            unknown,
            repeated,
        };
    }
    Parsed::Covered(names)
}

/// The writing systems the language check tells apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Script {
    Han,
    Kana,
    Hangul,
    Arabic,
    Cyrillic,
    Devanagari,
    Hebrew,
    Thai,
    Greek,
    Latin,
}

const SCRIPTS: [Script; 10] = [
    Script::Han,
    Script::Kana,
    Script::Hangul,
    Script::Arabic,
    Script::Cyrillic,
    Script::Devanagari,
    Script::Hebrew,
    Script::Thai,
    Script::Greek,
    Script::Latin,
];

impl Script {
    pub fn word(self) -> &'static str {
        match self {
            Self::Han => "han",
            Self::Kana => "kana",
            Self::Hangul => "hangul",
            Self::Arabic => "arabic",
            Self::Cyrillic => "cyrillic",
            Self::Devanagari => "devanagari",
            Self::Hebrew => "hebrew",
            Self::Thai => "thai",
            Self::Greek => "greek",
            Self::Latin => "latin",
        }
    }

    fn index(self) -> usize {
        SCRIPTS.iter().position(|s| *s == self).unwrap_or(0)
    }
}

/// The script of a letter; `None` for anything that is not a letter of one
/// of the ten.
pub fn script_of(c: char) -> Option<Script> {
    if !c.is_alphabetic() {
        return None;
    }
    let u = c as u32;
    let s = match u {
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF => Script::Han,
        0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F => Script::Kana,
        0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF => Script::Hangul,
        0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => {
            Script::Arabic
        }
        0x0400..=0x052F | 0x1C80..=0x1C8F | 0x2DE0..=0x2DFF | 0xA640..=0xA69F => Script::Cyrillic,
        0x0900..=0x097F | 0xA8E0..=0xA8FF => Script::Devanagari,
        0x0590..=0x05FF | 0xFB1D..=0xFB4F => Script::Hebrew,
        0x0E00..=0x0E7F => Script::Thai,
        0x0370..=0x03FF | 0x1F00..=0x1FFF => Script::Greek,
        0x0041..=0x005A
        | 0x0061..=0x007A
        | 0x00C0..=0x024F
        | 0x1E00..=0x1EFF
        | 0x2C60..=0x2C7F
        | 0xA720..=0xA7FF
        | 0xFF21..=0xFF3A
        | 0xFF41..=0xFF5A => Script::Latin,
        _ => return None,
    };
    Some(s)
}

/// The script most of a text's letters are in (ties to the earlier script in
/// the list); `None` when it has none.
pub fn text_script(text: &str) -> Option<Script> {
    let mut counts = [0usize; 10];
    for c in text.chars() {
        if let Some(s) = script_of(c) {
            counts[s.index()] += 1;
        }
    }
    argmax(&counts).map(|i| SCRIPTS[i])
}

fn argmax(counts: &[usize]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, &n) in counts.iter().enumerate() {
        if n > 0 && best.is_none_or(|b| n > counts[b]) {
            best = Some(i);
        }
    }
    best
}

/// The conversation's majority script over the sample comments that are sent:
/// each comment counts once, by its own majority script.
pub fn majority_script<'a>(samples: impl Iterator<Item = &'a str>) -> Option<Script> {
    let mut counts = [0usize; 10];
    for s in samples {
        if let Some(sc) = text_script(s) {
            counts[sc.index()] += 1;
        }
    }
    argmax(&counts).map(|i| SCRIPTS[i])
}

/// The Latin-script languages the rough function-word rule knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    English,
    German,
    Spanish,
    Portuguese,
    French,
}

const LANGUAGES: [Language; 5] = [
    Language::English,
    Language::German,
    Language::Spanish,
    Language::Portuguese,
    Language::French,
];

impl Language {
    pub fn word(self) -> &'static str {
        match self {
            Self::English => "english",
            Self::German => "german",
            Self::Spanish => "spanish",
            Self::Portuguese => "portuguese",
            Self::French => "french",
        }
    }

    /// Frequent words that tell a comment's language, roughly.
    fn comment_words(self) -> &'static [&'static str] {
        match self {
            Self::English => &[
                "the", "and", "is", "of", "to", "that", "for", "with", "are", "this", "it", "not",
                "should", "be", "we", "have",
            ],
            Self::German => &[
                "und", "der", "die", "das", "ist", "nicht", "mit", "für", "ich", "zu", "den",
                "von", "auf", "sich", "es", "ein", "eine", "auch", "sollte", "werden", "wir",
            ],
            Self::Spanish => &[
                "el", "los", "las", "que", "y", "de", "del", "en", "por", "para", "una", "es",
                "con", "no", "se", "más", "como",
            ],
            Self::Portuguese => &[
                "os", "as", "que", "e", "de", "do", "da", "dos", "das", "em", "para", "uma", "com",
                "não", "é", "mais", "por", "se", "na", "no",
            ],
            Self::French => &[
                "le", "les", "des", "et", "est", "que", "de", "du", "en", "pour", "une", "pas",
                "avec", "il", "nous", "sur", "au", "ce", "qui",
            ],
        }
    }

    /// Letters and words that mark a short name as written in this language.
    fn name_marks(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::English => ("", &[]),
            Self::German => (
                "äöüßÄÖÜ",
                &[
                    "und", "der", "die", "das", "für", "mit", "im", "von", "auf", "zum", "zur",
                    "statt", "mehr", "gegen", "ohne", "als", "oder", "bei", "nach", "vom", "am",
                    "ein", "eine", "nicht", "zu", "den", "dem", "des",
                ],
            ),
            Self::Spanish => (
                "ñáéíóú¿¡ÑÁÉÍÓÚ",
                &[
                    "y", "el", "la", "los", "las", "de", "del", "en", "para", "por", "con", "sin",
                    "una", "un", "contra", "o",
                ],
            ),
            Self::Portuguese => (
                "ãõçáéíóúâêôÃÕÇÁÉÍÓÚÂÊÔ",
                &[
                    "e", "o", "os", "as", "da", "do", "das", "dos", "de", "em", "para", "por",
                    "com", "sem", "uma", "um", "na", "no", "nas", "nos", "contra", "ou",
                ],
            ),
            Self::French => (
                "àâçéèêëîïôùûüœÀÂÇÉÈÊËÎÏÔÙÛÜŒ",
                &[
                    "et", "le", "la", "les", "des", "du", "de", "en", "pour", "par", "avec",
                    "sans", "une", "un", "au", "aux", "sur", "contre", "ou",
                ],
            ),
        }
    }
}

/// English words that mark a short name as English, less any the target
/// language shares.
fn english_name_words(target: Language) -> Vec<&'static str> {
    const WORDS: [&str; 19] = [
        "and", "the", "of", "for", "with", "to", "on", "at", "by", "from", "vs", "versus", "about",
        "over", "against", "without", "through", "into", "or",
    ];
    let shared: &[&str] = match target {
        Language::French => &["on"],
        _ => &[],
    };
    WORDS.into_iter().filter(|w| !shared.contains(w)).collect()
}

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
}

/// A comment's language by the rough rule: the language with the most of its
/// frequent words, when it has at least two and no other has as many.
pub fn comment_language(text: &str) -> Option<Language> {
    let mut counts = [0usize; 5];
    for w in words(text) {
        for (i, l) in LANGUAGES.iter().enumerate() {
            if l.comment_words().contains(&w.as_str()) {
                counts[i] += 1;
            }
        }
    }
    let best = argmax(&counts)?;
    let n = counts[best];
    if n < 2 || counts.iter().enumerate().any(|(i, &m)| i != best && m == n) {
        return None;
    }
    Some(LANGUAGES[best])
}

/// The language most of the comments are in, by the rough rule; `None` when
/// no comment is decided or two languages tie.
pub fn majority_language<'a>(samples: impl Iterator<Item = &'a str>) -> Option<Language> {
    let mut counts = [0usize; 5];
    for s in samples {
        if let Some(l) = comment_language(s) {
            counts[LANGUAGES.iter().position(|x| *x == l).unwrap_or(0)] += 1;
        }
    }
    let best = argmax(&counts)?;
    if counts
        .iter()
        .enumerate()
        .any(|(i, &m)| i != best && m == counts[best])
    {
        return None;
    }
    Some(LANGUAGES[best])
}

/// True when a name looks English and not in the target language.
pub fn looks_english_not(name: &str, target: Language) -> bool {
    let (letters, marks) = target.name_marks();
    let ws: Vec<String> = words(name).collect();
    let target_marked =
        name.chars().any(|c| letters.contains(c)) || ws.iter().any(|w| marks.contains(&w.as_str()));
    let english = english_name_words(target);
    let english_marked = ws.iter().any(|w| english.contains(&w.as_str()));
    english_marked && !target_marked
}

/// True when a name holds what only a mis-encoded reply held in the
/// measurement: a C1 control character, or two Cyrillic letters in a row when
/// no comment sent holds a Cyrillic letter.
pub fn looks_misencoded(name: &str, comments_have_cyrillic: bool) -> bool {
    if name.chars().any(|c| ('\u{80}'..='\u{9f}').contains(&c)) {
        return true;
    }
    if comments_have_cyrillic {
        return false;
    }
    let mut run = 0;
    for c in name.chars() {
        if script_of(c) == Some(Script::Cyrillic) {
            run += 1;
            if run >= 2 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// The language check over a whole reply. `Err` carries the reason.
pub fn check_language(h: &Hierarchy, names: &BTreeMap<String, String>) -> Result<(), String> {
    let comments_have_cyrillic = h
        .sent_samples()
        .any(|s| s.chars().any(|c| script_of(c) == Some(Script::Cyrillic)));
    let misencoded = names
        .values()
        .filter(|n| looks_misencoded(n, comments_have_cyrillic))
        .count();
    if misencoded > 0 {
        return Err(format!("{misencoded} names hold mis-encoded characters"));
    }
    let total = names.len();
    match majority_script(h.sent_samples()) {
        None => Ok(()),
        Some(Script::Latin) => {
            let Some(target) = majority_language(h.sent_samples()) else {
                return Ok(());
            };
            if target == Language::English {
                return Ok(());
            }
            let bad = names
                .values()
                .filter(|n| looks_english_not(n, target))
                .count();
            if over_limit(bad, total) {
                Err(format!(
                    "{bad} of {total} names look English; most comments are {}",
                    target.word()
                ))
            } else {
                Ok(())
            }
        }
        Some(script) => {
            let accepts = |s: Script| s == script || (script == Script::Kana && s == Script::Han);
            let bad = names
                .values()
                .filter(|n| !n.chars().any(|c| script_of(c).is_some_and(accepts)))
                .count();
            if over_limit(bad, total) {
                Err(format!(
                    "{bad} of {total} names have no letter in the comments' script ({})",
                    script.word()
                ))
            } else {
                Ok(())
            }
        }
    }
}

/// Every name 1 to [`MAX_NAME_CHARS`] characters.
pub fn check_length(names: &BTreeMap<String, String>) -> Result<(), String> {
    let bad = names
        .values()
        .filter(|n| {
            let k = n.chars().count();
            k == 0 || k > MAX_NAME_CHARS
        })
        .count();
    if bad > 0 {
        Err(format!(
            "{bad} names are empty or longer than {MAX_NAME_CHARS} characters"
        ))
    } else {
        Ok(())
    }
}

/// No two topics of one layer share a name (compared without case and with
/// runs of spaces made one).
pub fn check_repeats(h: &Hierarchy, names: &BTreeMap<String, String>) -> Result<(), String> {
    let mut seen: BTreeSet<(u32, String)> = BTreeSet::new();
    let mut repeats = 0;
    for t in h.topics() {
        let Some(n) = names.get(&t.id) else { continue };
        let key = n
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if !seen.insert((t.layer, key)) {
            repeats += 1;
        }
    }
    if repeats > 0 {
        Err(format!(
            "{repeats} names repeat another name of the same layer"
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_what_the_pipeline_strips() {
        assert_eq!(
            clean("  0_3: Topic: \"Parks and trails\"\nmore").as_deref(),
            Some("Parks and trails")
        );
        assert_eq!(clean("**Bike lanes**").as_deref(), Some("Bike lanes"));
        assert_eq!(
            clean("1. Downtown parking").as_deref(),
            Some("Downtown parking")
        );
        assert_eq!(
            clean("- Downtown parking").as_deref(),
            Some("owntown parking")
        );
        assert_eq!(clean("Label: Housing").as_deref(), Some("Housing"));
        assert_eq!(clean("   "), None);
        assert_eq!(clean("\"\""), None);
        assert_eq!(clean("12_x: kept").as_deref(), Some("12_x: kept"));
    }

    #[test]
    fn scripts_and_majorities() {
        assert_eq!(text_script("我覺得UberX在計費上"), Some(Script::Han));
        assert_eq!(text_script("Öffentlicher Verkehr"), Some(Script::Latin));
        assert_eq!(text_script("سڑکیں"), Some(Script::Arabic));
        assert_eq!(text_script("123 !?"), None);
        let comments = ["我覺得很好", "計費應該提高", "Uber is fine"];
        assert_eq!(majority_script(comments.into_iter()), Some(Script::Han));
    }

    #[test]
    fn the_rough_language_rule() {
        assert_eq!(
            comment_language("Ich finde, die Bahn sollte günstiger werden und mehr fahren"),
            Some(Language::German)
        );
        assert_eq!(
            comment_language("El transporte público debe ser gratis para los estudiantes"),
            Some(Language::Spanish)
        );
        assert_eq!(
            comment_language("O transporte público não é bom para os idosos"),
            Some(Language::Portuguese)
        );
        assert_eq!(
            comment_language("Le vélo est bon pour la ville et pour nous"),
            Some(Language::French)
        );
        assert_eq!(
            comment_language("We should have more parks and trails"),
            Some(Language::English)
        );
        assert!(looks_english_not(
            "Flight restrictions and aviation policy",
            Language::German
        ));
        assert!(!looks_english_not(
            "Flugverkehr eindämmen und besteuern",
            Language::German
        ));
        assert!(!looks_english_not(
            "Commuter allowance reform",
            Language::German
        ));
        assert!(looks_english_not(
            "Public transport for students",
            Language::Spanish
        ));
        assert!(!looks_english_not(
            "Transporte público para estudiantes",
            Language::Spanish
        ));
        assert!(!looks_english_not(
            "Transporte público para estudantes",
            Language::Portuguese
        ));
        assert!(!looks_english_not(
            "Vélos et pistes cyclables",
            Language::French
        ));
    }

    #[test]
    fn misencoding_marks() {
        // "بی" written as UTF-8 and read as Windows-1251.
        assert!(looks_misencoded("ШЁЫњ", false));
        assert!(!looks_misencoded("ШЁЫњ", true));
        assert!(!looks_misencoded("Ш±", false));
        assert!(looks_misencoded("bad\u{85}name", true));
        assert!(!looks_misencoded("Parks and trails", false));
    }
}
