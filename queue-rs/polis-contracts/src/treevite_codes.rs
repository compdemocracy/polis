//! New explicit owner actions; neither operation has a legacy Node contract.
use serde::{Deserialize, Serialize};
pub const REVOKE_PATH: &str = "/api/v3/treevite/revokeLoginCode";
pub const REISSUE_PATH: &str = "/api/v3/treevite/reissueLoginCode";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub pid: i32,
}
impl Request {
    pub fn valid(&self) -> bool {
        self.pid >= 0
            && !self.conversation_id.is_empty()
            && self.conversation_id.len() <= 100
            && self
                .conversation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric())
    }
}
#[derive(Serialize)]
pub struct Revoked {
    pub revoked: bool,
}
// Deliberately no Debug: the returned raw code must never enter diagnostics.
#[derive(Serialize)]
pub struct Reissued {
    pub login_code: String,
    pub expires_in: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Forbidden,
    NotFound,
    InvalidRequest,
    Unavailable,
    OutcomeUnknown,
    SessionRevoked,
}
impl Error {
    pub fn status(self) -> u16 {
        match self {
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::InvalidRequest => 400,
            Self::Unavailable | Self::OutcomeUnknown => 503,
            Self::SessionRevoked => 401,
        }
    }
    pub fn code(self) -> &'static str {
        match self {
            Self::Forbidden => "polis_err_treevite_not_conversation_owner",
            Self::NotFound => "polis_err_treevite_login_code_not_found",
            Self::InvalidRequest => "polis_err_treevite_invalid_request",
            Self::Unavailable => "polis_err_treevite_code_unavailable",
            Self::OutcomeUnknown => "polis_err_treevite_code_outcome_unknown",
            Self::SessionRevoked => "polis_err_treevite_session_revoked",
        }
    }
}
