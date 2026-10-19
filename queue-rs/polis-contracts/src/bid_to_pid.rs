//! Bounded bucket-to-participant mapping wire types.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/bidToPid";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub math_tick: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    #[serde(rename = "bidToPid")]
    pub bid_to_pid: Vec<Vec<u32>>,
}
