//! `GET /api/v3/delphi/runs/:job_id?families=assignments`: one Delphi job's typed assignments
//! (`delphi-job-result/1`, [`crate::delphi_job_result`]) for a moderator of the job's
//! conversation. A Rust-only route: the Node server has no handler for this
//! path. The refusals keep the shapes of Node's `GET /api/v3/delphi/logs`,
//! which applies the same rule (`hybridAuth`, then `isModerator(zid, uid)`).
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "/api/v3/delphi/runs/";
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub job_id: String,
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
pub const DENIED: &str = "polis_err_delphi_result_auth";
