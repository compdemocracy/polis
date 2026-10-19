//! Empty topic selection response shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/topicAgenda/selections";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmptyResponse {
    pub status: String,
    pub message: String,
    pub data: Option<()>,
}
impl Default for EmptyResponse {
    fn default() -> Self {
        Self {
            status: "success".into(),
            message: "No selections found".into(),
            data: None,
        }
    }
}
