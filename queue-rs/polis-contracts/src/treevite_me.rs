//! Participant context without a wave or owned invitations.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/treevite/me";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Participant {
    pub pid: i32,
    pub zid: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub participant: Participant,
    pub wave: Option<()>,
    pub invites: [(); 0],
}
