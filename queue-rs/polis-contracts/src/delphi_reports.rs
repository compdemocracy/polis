//! Staged Delphi report-validation responses shared by the API and clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/delphi/reports";
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub report_id: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub topic_key: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Error,
    Success,
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

use crate::wire::{JsMap, Json};
#[derive(Debug, Clone, Serialize)]
pub struct Section {
    pub section: String,
    pub model: String,
    pub timestamp: Json,
    pub report_data: Json,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<Json>,
    pub metadata: Json,
}
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub job_id: String,
    pub latest_timestamp: String,
    pub model: Json,
    #[serde(rename = "sectionCount")]
    pub section_count: usize,
    #[serde(rename = "isCurrent")]
    pub is_current: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct ReportsResponse {
    pub status: Status,
    pub message: &'static str,
    pub request_report_id: String,
    pub queried_gsi_report_id: String,
    pub reports: JsMap<String, Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_runs: Option<Vec<Run>>,
}
#[derive(Debug, Clone, Serialize)]
pub struct TopicResponse {
    pub status: Status,
    pub message: &'static str,
    pub request_report_id: String,
    pub queried_gsi_report_id: String,
    pub section: String,
    pub topic_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Json>,
}
