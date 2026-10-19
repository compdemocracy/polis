//! Empty report listing request and response subset.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/reports";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: Option<String>,
}
pub type EmptyResponse = [(); 0];
