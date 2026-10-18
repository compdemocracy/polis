//! Metadata choice wire types, shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/metadata/choices";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Choice {
    pub pid: Option<i32>,
    pub pmqid: Option<i32>,
    pub pmaid: Option<i32>,
    pub alive: Option<bool>,
    pub created: Option<String>,
    pub conversation_id: String,
}
pub type Response = Vec<Choice>;
