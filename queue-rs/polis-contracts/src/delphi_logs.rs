//! Legacy Delphi job logs, preserving the Node response fields and order.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/delphi/logs";
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    /// `None` when the parameter is absent or empty.
    pub job_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Error,
}
/// A refusal after authentication, in the shape of `/delphi/logs`'s.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    pub status: Status,
    pub message: String,
}
/// The refusal of a request without a bearer token, as `hybridAuth` writes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Unauthenticated {
    pub error: String,
}
impl Refusal {
    fn new(message: &str) -> Self {
        Self {
            status: Status::Error,
            message: message.into(),
        }
    }
    /// 400: no `job_id`.
    pub fn missing() -> Self {
        Self::new("job_id is required")
    }
    /// 404: no such job in this deployment.
    pub fn not_found() -> Self {
        Self::new("Job not found")
    }
    /// 403: the caller is not a moderator of the job's conversation.
    pub fn denied() -> Self {
        Self::new(DENIED)
    }
}
impl Unauthenticated {
    /// 401: no `Authorization: Bearer` header.
    pub fn no_token() -> Self {
        Self {
            error: "No authentication token found".into(),
        }
    }
}
/// The 403 code, named for this route as `/delphi/logs` names its own.
pub const DENIED: &str = "polis_err_delphi_logs_auth";

/// One authorized log line. Invalid or absent timestamps are omitted by Node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    pub message: String,
}
