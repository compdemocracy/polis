//! Postgres report export subtypes. CSV text and streamed chunks are distinct.
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "/api/v3/reportExport/";
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Kind {
    #[serde(rename = "format.json")]
    Format,
    #[serde(rename = "summary.csv")]
    Summary,
    #[serde(rename = "comments.csv")]
    Comments,
    #[serde(rename = "votes.csv")]
    Votes,
    #[serde(rename = "participant-votes.csv")]
    ParticipantVotes,
    #[serde(rename = "participant-importance.csv")]
    ParticipantImportance,
    #[serde(rename = "comment-groups.csv")]
    CommentGroups,
}
impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "format.json" => Self::Format,
            "summary.csv" => Self::Summary,
            "comments.csv" => Self::Comments,
            "votes.csv" => Self::Votes,
            "participant-votes.csv" => Self::ParticipantVotes,
            "participant-importance.csv" => Self::ParticipantImportance,
            "comment-groups.csv" => Self::CommentGroups,
            _ => return None,
        })
    }
    pub const fn streams(self) -> bool {
        matches!(
            self,
            Self::Votes
                | Self::ParticipantVotes
                | Self::ParticipantImportance
                | Self::CommentGroups
        )
    }
    pub const fn needs_math(self) -> bool {
        matches!(
            self,
            Self::Summary
                | Self::ParticipantVotes
                | Self::ParticipantImportance
                | Self::CommentGroups
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub report_id: String,
    pub kind: Kind,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Json(String),
    Csv(String),
    Stream(Vec<String>),
}
pub const FORMAT: &str = crate::votes::EXPORT_FORMAT_JSON;
pub fn escape(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_external_subtypes_and_preserves_csv_escaping() {
        assert_eq!(Kind::parse("format.json"), Some(Kind::Format));
        assert!(Kind::parse("comment-clusters.csv").is_none());
        assert_eq!(escape("café \"word\"\nnext"), "\"café \"\"word\"\"\nnext\"");
        assert!(FORMAT.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(FORMAT).unwrap()["format"],
            "polis-export/1"
        );
    }
}
