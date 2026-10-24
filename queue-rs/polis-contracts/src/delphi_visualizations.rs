//! Staged Delphi report-validation responses shared by the API and clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/delphi/visualizations";
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
}
impl Request {
    pub fn missing() -> Response {
        Response {
            status: Status::Error,
            message: "report_id is required".into(),
            report_id: None,
        }
    }
    pub fn unknown(report_id: String) -> Response {
        Response {
            status: Status::Error,
            message: "Could not find conversation for report_id".into(),
            report_id: Some(report_id),
        }
    }
}

/// PostgreSQL mode has no static visualization artifacts. These are the
/// existing jobs-list fields, in the order Node writes them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub job_id: String,
    pub status: String,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub results: crate::wire::Json,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub work_live: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct JobsResponse {
    pub status: Success,
    pub report_id: String,
    pub visualizations: Vec<crate::wire::Json>,
    pub jobs: Vec<Job>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Success {
    Success,
}
