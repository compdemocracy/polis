//! Owner-only PID participation summary wire types.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const PATH: &str = "/api/v3/participation";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub strict: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Counts {
    pub votes: u64,
    pub comments: u64,
}
pub type Response = BTreeMap<i32, Counts>;
