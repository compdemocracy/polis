//! Aggregate metadata wire types, shared with HTTP clients.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const PATH: &str = "/api/v3/metadata";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Selection {
    Unselected(Vec<i32>),
    Participant(Option<i32>),
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kvp: Option<BTreeMap<i32, BTreeMap<i32, Selection>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<BTreeMap<i32, Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<BTreeMap<i32, Option<String>>>,
}
