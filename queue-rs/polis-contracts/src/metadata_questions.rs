//! Metadata question wire types, shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/metadata/questions";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Question {
    pub pmqid: i32,
    pub key: Option<String>,
    pub alive: Option<bool>,
    pub created: Option<String>,
    pub required: bool,
    pub conversation_id: String,
}
pub type Response = Vec<Question>;
