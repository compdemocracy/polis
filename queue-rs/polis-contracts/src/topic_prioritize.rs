//! Public topic-prioritization availability response types.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/participation/topicPrioritize";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Empty {
    pub status: String,
    pub conversation_id: String,
    pub has_report: bool,
    pub has_delphi_data: bool,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Report {
    pub status: String,
    pub conversation_id: String,
    pub report_id: String,
    pub has_report: bool,
    pub has_delphi_data: bool,
    pub report_created: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Response {
    Empty(Empty),
    Report(Report),
}
