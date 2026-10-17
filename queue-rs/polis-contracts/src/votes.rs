//! Wire/import declarations only; storage conversion belongs to the server.
//! Single Rust contract boundary for the CLI. Never infer storage signs here.
use serde::{Deserialize, Serialize};
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
