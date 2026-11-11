//! A comment's text, held so that it cannot be printed.
//!
//! The text is a participant's own words. No log line, error message, panic
//! message or health field may carry it, in whole or in part. This type makes
//! that a property of the code rather than of care: it has no `Display`, its
//! `Debug` prints a byte count and nothing else, it does not dereference to
//! `str`, and no method returns the characters. What it offers is what the
//! handler needs and no more: the two checks Node makes on the text (empty,
//! and the NUL PostgreSQL cannot store), its lengths, its comparison with a
//! stored text (a class and lengths, for the mode that reads back what Node
//! stored), and its value as a query parameter. The parameter is the one place the characters leave this
//! module, and they leave it into the database driver's buffer, not into a
//! string.
//!
//! The field is private to this file, so the rest of the crate cannot reach
//! the characters by any other route. Keep it that way: a helper here that
//! returns `&str`, a slice or a `String` would undo the type.
#![deny(clippy::string_slice, clippy::indexing_slicing)]
use postgres::types::{IsNull, ToSql, Type, private::BytesMut, to_sql_checked};

#[derive(Clone)]
pub(crate) struct CommentText(String);

impl CommentText {
    /// `trimmed` is the text as Node's `txt` parser leaves it: at most 997
    /// UTF-16 units before its leading and trailing ASCII spaces are removed.
    pub(crate) fn new(trimmed: String) -> Self {
        Self(trimmed)
    }

    /// Node answers 400 `polis_err_param_missing_txt` for this.
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// PostgreSQL cannot store this character in a text column.
    pub(crate) fn contains_nul(&self) -> bool {
        self.0.contains('\0')
    }

    // Read by tests today, and by the observe mode's length comparison.
    #[allow(dead_code)]
    pub(crate) fn bytes(&self) -> usize {
        self.0.len()
    }

    /// Whether a stored text is this text. The comparison happens here, and
    /// only its answer leaves.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn same_as(&self, stored: &str) -> bool {
        self.0 == stored
    }

    /// This text against a stored one. The comparison happens here; what
    /// leaves is a class and, when the two differ, their lengths.
    pub(crate) fn compare(&self, stored: &str) -> Compared {
        let parsed = self.0.as_str();
        if parsed == stored {
            return Compared::Same;
        }
        // Whole-string comparisons through iterators only: nothing here cuts
        // either text at a byte offset.
        let without = |text: &'_ str, left_out: fn(char) -> bool| {
            text.chars()
                .filter(move |c| !left_out(*c))
                .collect::<Vec<char>>()
        };
        let lower = |text: &str| {
            text.chars()
                .flat_map(char::to_lowercase)
                .collect::<Vec<_>>()
        };
        let class = if without(parsed, char::is_whitespace) == without(stored, char::is_whitespace)
        {
            TextDifference::Space
        } else if without(parsed, |c| c.is_whitespace() || c.is_control())
            == without(stored, |c| c.is_whitespace() || c.is_control())
        {
            TextDifference::Control
        } else if lower(parsed) == lower(stored) {
            TextDifference::Case
        } else if parsed.starts_with(stored) || stored.starts_with(parsed) {
            TextDifference::Truncated
        } else {
            TextDifference::Other
        };
        let length = |text: &str| Length {
            units: text.encode_utf16().count(),
            bytes: text.len(),
        };
        Compared::Different {
            class,
            parsed: length(parsed),
            stored: length(stored),
        }
    }
}

/// How a stored text differs from the text parsed from the request: a word
/// from this closed set, never a character of either text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextDifference {
    /// The two are equal once every whitespace character is left out.
    Space,
    /// Equal once whitespace and control characters are left out.
    Control,
    /// Equal once both are put in lower case.
    Case,
    /// One is the beginning of the other.
    Truncated,
    Other,
}

impl TextDifference {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Space => "space",
            Self::Control => "control",
            Self::Case => "case",
            Self::Truncated => "truncated",
            Self::Other => "other",
        }
    }
}

/// A length in the two units Node and PostgreSQL count a text in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Length {
    /// UTF-16 units, as Node's 997-unit rule counts.
    pub(crate) units: usize,
    pub(crate) bytes: usize,
}

/// The answer of `CommentText::compare`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Compared {
    Same,
    Different {
        class: TextDifference,
        parsed: Length,
        stored: Length,
    },
}

impl std::fmt::Debug for CommentText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CommentText({} bytes)", self.0.len())
    }
}

/// The database parameter. `ToSql` requires `Debug`, and the one above is
/// what a driver or a caller would print for it.
impl ToSql for CommentText {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        <&str as ToSql>::to_sql(&self.0.as_str(), ty, out)
    }

    fn accepts(ty: &Type) -> bool {
        <&str as ToSql>::accepts(ty)
    }

    to_sql_checked!();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_prints_a_byte_count_and_never_the_characters() {
        let marker = "zq7-marker-text";
        let text = CommentText::new(marker.into());
        let printed = format!("{text:?} {:?} {:#?}", Some(&text), vec![text.clone()]);
        assert!(!printed.contains("zq7"), "{printed}");
        assert!(printed.contains("CommentText(15 bytes)"), "{printed}");
        assert_eq!(text.bytes(), 15);
    }

    /// A stored text is compared where the characters are; what comes out is
    /// same, or a class from a closed set with the two lengths.
    #[test]
    fn a_stored_text_is_compared_in_place_and_named_by_class_and_lengths() {
        let parsed = "Généré 😀 text";
        let text = CommentText::new(parsed.into());
        assert_eq!(text.compare(parsed), Compared::Same);
        let length = |s: &str| Length {
            units: s.encode_utf16().count(),
            bytes: s.len(),
        };
        assert_eq!(
            length(parsed),
            Length {
                units: 14,
                bytes: 19
            }
        );
        for (stored, class) in [
            ("Généré  😀 text", TextDifference::Space),
            ("Généré😀text", TextDifference::Space),
            ("Généré 😀 text\n", TextDifference::Space),
            ("\u{a0}Généré 😀 text", TextDifference::Space),
            ("Généré 😀 te\u{7}xt", TextDifference::Control),
            ("Généré 😀\u{1b} text\t", TextDifference::Control),
            ("généré 😀 TEXT", TextDifference::Case),
            ("GÉNÉRÉ 😀 text", TextDifference::Case),
            ("Généré 😀", TextDifference::Truncated),
            ("Généré 😀 text and more", TextDifference::Truncated),
            ("Genere 😀 text", TextDifference::Other),
            ("Another text altogether", TextDifference::Other),
            ("", TextDifference::Truncated),
        ] {
            assert_eq!(
                text.compare(stored),
                Compared::Different {
                    class,
                    parsed: length(parsed),
                    stored: length(stored),
                },
                "{stored:?}"
            );
        }
        for (class, word) in [
            (TextDifference::Space, "space"),
            (TextDifference::Control, "control"),
            (TextDifference::Case, "case"),
            (TextDifference::Truncated, "truncated"),
            (TextDifference::Other, "other"),
        ] {
            assert_eq!(class.as_str(), word);
        }
        // The answer formats as a class and four numbers.
        let marker = CommentText::new("zq7-marker-text".into());
        let printed = format!("{:?}", marker.compare("zq7-marker-text-stored"));
        assert!(!printed.contains("zq7"), "{printed}");
        assert!(printed.contains("Truncated"), "{printed}");
    }

    #[test]
    fn the_checks_node_makes_on_a_text() {
        assert!(CommentText::new(String::new()).is_empty());
        assert!(!CommentText::new("\t".into()).is_empty());
        assert!(CommentText::new("a\0b".into()).contains_nul());
        assert!(!CommentText::new("ab".into()).contains_nul());
    }
}
