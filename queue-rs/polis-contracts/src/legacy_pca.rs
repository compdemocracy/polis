//! Retired math-poll endpoint wire contract, shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/math/pca";
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
}
impl Request {
    pub fn response(&self) -> Response {
        Response { status: 304 }
    }
}
