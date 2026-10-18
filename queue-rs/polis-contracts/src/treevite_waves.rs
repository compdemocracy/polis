//! Tree-invitation wave wire types shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/treevite/waves";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub wave: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Wave {
    pub id: String,
    pub zid: i32,
    pub wave: i32,
    pub parent_wave: Option<i32>,
    pub invites_per_user: i32,
    pub owner_invites: i32,
    pub size: Option<i32>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
pub type Response = Vec<Wave>;
