//! A comment's text, held so that it cannot be printed.
//!
//! The text is a participant's own words. No log line, error message, panic
//! message or health field may carry it, in whole or in part. This type makes
//! that a property of the code rather than of care: it has no `Display`, its
//! `Debug` prints a byte count and nothing else, it does not dereference to
//! `str`, and no method returns the characters. What it offers is what the
//! handler needs and no more: the two checks Node makes on the text (empty,
//! and the NUL PostgreSQL cannot store), its lengths, and its value as a
//! query parameter. The parameter is the one place the characters leave this
//! module, and they leave it into the database driver's buffer, not into a
//! string.
//!
//! The field is private to this file, so the rest of the crate cannot reach
//! the characters by any other route. Keep it that way: a helper here that
//! returns `&str`, a slice or a `String` would undo the type.
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

    #[test]
    fn the_checks_node_makes_on_a_text() {
        assert!(CommentText::new(String::new()).is_empty());
        assert!(!CommentText::new("\t".into()).is_empty());
        assert!(CommentText::new("a\0b".into()).contains_nul());
        assert!(!CommentText::new("ab".into()).contains_nul());
    }
}
