//! Staged Delphi report-validation responses shared by the API and clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/delphi";
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

/// Missing properties remain omitted; a stored null remains JSON null.
pub type Text = Option<Option<String>>;
#[derive(Debug, Clone, Serialize)]
pub struct Topic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_name: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_key: Text,
}
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_date: Text,
    pub topics_by_layer: crate::wire::JsMap<String, crate::wire::JsMap<String, Topic>>,
    pub item_count: usize,
    pub job_uuid: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct TopicsResponse {
    pub status: Success,
    pub message: &'static str,
    pub report_id: String,
    pub runs: crate::wire::JsMap<String, Run>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Success {
    Success,
}
