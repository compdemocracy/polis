//! Empty recent-conversation response subset shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/conversations/recent_activity";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(rename = "sinceUnixTimestamp")]
    pub since_unix_timestamp: Option<i64>,
}
/// Populated rows are outside this staged wire contract and remain Node work.
pub type EmptyResponse = [(); 0];
