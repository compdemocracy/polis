//! Empty participant-owned invite list wire types.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/treevite/myInvites";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
pub type EmptyResponse = [(); 0];
