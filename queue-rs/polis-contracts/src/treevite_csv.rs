//! Request and refusal contract for tree-invitation CSV authority checks.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/treevite/invites/csv";
pub const DENIED: &str = "polis_err_treevite_not_conversation_owner";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
