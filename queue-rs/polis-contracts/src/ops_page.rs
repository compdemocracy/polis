//! Disabled operations page endpoint. Enabled operations stay with Node.
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "/api/v3/ops/page/";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub page: String,
}
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
