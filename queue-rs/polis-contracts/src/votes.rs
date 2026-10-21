//! Vote boundaries shared by the CLI and read service. Storage and wire have
//! separately named conventions even while their current numbers coincide.
use serde::{Deserialize, Serialize};
#[rustfmt::skip]
use serde_json::{json, Value};
pub const WIRE_AGREE: i8 = -1;
pub const WIRE_DISAGREE: i8 = 1;
pub const WIRE_PASS: i8 = 0;
pub const SOURCE_AGREE_EXPORT: &str = "+1";
pub const SOURCE_AGREE_WIRE: &str = "-1";
pub const EXPORT_AGREE_CELL: &str = "1";
pub const WIRE_AGREE_CELL: &str = "-1";
pub const SOURCE_REQUIRED: &str = "An explicit --source-agree=+1|-1 is required.";
pub const WIRE_HELP: &str =
    "Read latest votes for a participant; wire signs: agree -1, disagree +1, pass 0";
pub const EXPORT_DECLARATION: &str =
    "# vote-convention: agree=+1;disagree=-1;pass=0;format=polis-export/1";
pub const WIRE_DECLARATION: &str =
    "# vote-convention: agree=-1;disagree=+1;pass=0;format=polis-export/1";
pub fn declaration(source: &str) -> Option<&'static str> {
    match source {
        SOURCE_AGREE_EXPORT => Some(EXPORT_DECLARATION),
        SOURCE_AGREE_WIRE => Some(WIRE_DECLARATION),
        _ => None,
    }
}
pub fn wire_values() -> Value {
    json!({"agree":WIRE_AGREE,"disagree":WIRE_DISAGREE,"pass":WIRE_PASS})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_values_and_declared_export_are_distinct() {
        assert_eq!(wire_values(), json!({"agree":-1,"disagree":1,"pass":0}));
        let fixture =
            include_str!("../../../server/__tests__/fixtures/vote-declaration/import-declared.csv");
        assert_eq!(fixture.lines().next(), Some(EXPORT_DECLARATION));
        let other = include_str!(
            "../../../server/__tests__/fixtures/vote-declaration/import-mismatch-sign.csv"
        );
        assert_eq!(other.lines().next(), Some(WIRE_DECLARATION));
        assert_eq!(declaration("+1"), Some(EXPORT_DECLARATION));
        assert_eq!(declaration("-1"), Some(WIRE_DECLARATION));
        for invalid in ["", "1", "0", "agree"] {
            assert_eq!(declaration(invalid), None);
        }
    }
}

/// A participant's intention; only this boundary translates it to wire values.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VoteChoice {
    Agree,
    Disagree,
    Pass,
}
impl VoteChoice {
    pub fn wire(self) -> i8 {
        match self {
            Self::Agree => WIRE_AGREE,
            Self::Disagree => WIRE_DISAGREE,
            Self::Pass => WIRE_PASS,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Agree => "agree",
            Self::Disagree => "disagree",
            Self::Pass => "pass",
        }
    }
}

/// Matches the server's CONSTANT_CONVENTION_SOURCE. A new storage convention
/// must change both services together; the wire/export declarations stay fixed.
#[derive(Clone, Copy, Debug)]
pub struct StorageConvention {
    pub agree: i32,
}
impl StorageConvention {
    pub const CURRENT: Self = Self { agree: -1 };
    pub fn decode(self, raw: Option<i32>) -> Option<VoteChoice> {
        match raw? {
            n if n == self.agree => Some(VoteChoice::Agree),
            n if n == -self.agree => Some(VoteChoice::Disagree),
            0 => Some(VoteChoice::Pass),
            _ => None,
        }
    }
    /// Read routes use Node's onInvalid=keep policy: null stays null and an
    /// invalid legacy integer is returned unchanged, never interpreted as pass.
    pub fn wire_preserving_invalid(self, raw: Option<i16>) -> Option<i16> {
        raw.map(|n| {
            self.decode(Some(i32::from(n)))
                .map(|v| i16::from(v.wire()))
                .unwrap_or(n)
        })
    }
    pub fn encode(self, vote: VoteChoice) -> i32 {
        match vote {
            VoteChoice::Agree => self.agree,
            VoteChoice::Disagree => -self.agree,
            VoteChoice::Pass => 0,
        }
    }
}
#[cfg(test)]
mod storage_tests {
    use super::*;
    #[test]
    fn storage_is_explicit_and_invalid_is_not_pass() {
        for agree in [-1, 1] {
            let convention = StorageConvention { agree };
            for vote in [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass] {
                assert_eq!(convention.decode(Some(convention.encode(vote))), Some(vote));
                assert_eq!(
                    convention.wire_preserving_invalid(Some(convention.encode(vote) as i16)),
                    Some(i16::from(vote.wire()))
                );
            }
            for raw in [None, Some(2), Some(-2)] {
                assert_eq!(convention.decode(raw), None);
            }
        }
        assert_eq!(StorageConvention::CURRENT.encode(VoteChoice::Agree), -1);
    }
}
