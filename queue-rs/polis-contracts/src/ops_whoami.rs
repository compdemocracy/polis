//! Disabled operations identity endpoint. Enabled operations stay with Node.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/ops/whoami";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub error: String,
}
impl Request {
    pub fn response(self) -> Response {
        Response {
            error: "not_found".into(),
        }
    }
}
