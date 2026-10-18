//! Metadata answer wire types, shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/metadata/answers";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub pmqid: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Answer {
    pub pmaid: i32,
    pub pmqid: Option<i32>,
    pub value: Option<String>,
    pub alive: Option<bool>,
    pub created: Option<String>,
    pub is_exclusive: bool,
    pub conversation_id: String,
}
pub type Response = Vec<Answer>;
