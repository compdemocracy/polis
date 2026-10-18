//! Staged Delphi report-validation responses shared by the API and clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/delphi/reports";
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
    pub request_report_id: Option<String>,
}
impl Request {
    pub fn missing() -> Response {
        Response {
            status: Status::Error,
            message: "report_id (requestReportId) is required".into(),
            request_report_id: None,
        }
    }
    pub fn unknown(report_id: String) -> Response {
        Response {
            status: Status::Error,
            message: "Could not find a valid identifier for the report_id to query DynamoDB."
                .into(),
            request_report_id: Some(report_id),
        }
    }
}
