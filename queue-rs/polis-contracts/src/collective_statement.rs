//! Staged collective statement validation responses shared by the API and clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/collectiveStatement";
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub report_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub status: Status,
    pub message: String,
}
impl Request {
    pub fn missing() -> Response {
        Response {
            status: Status::Error,
            message: "statement_id or report_id is required".into(),
        }
    }
    pub fn unknown() -> Response {
        Response {
            status: Status::Error,
            message: "Could not find conversation for report_id".into(),
        }
    }
}
