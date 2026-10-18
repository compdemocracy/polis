//! Request and refusal contract for conversation statistics authority checks.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/conversationStats";
pub const DENIED: &str = "polis_err_conversationStats_need_report_id_or_moderation_permission";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub until: Option<i64>,
}
