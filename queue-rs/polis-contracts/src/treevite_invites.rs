//! Paginated tree-invitation wire types shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/treevite/invites";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub wave_id: Option<i32>,
    pub status: Option<i32>,
    pub limit: i32,
    pub offset: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Invite {
    pub id: String,
    pub zid: i32,
    pub wave_id: String,
    pub invite_code: String,
    pub status: i16,
    pub invite_used_by_pid: Option<i32>,
    pub invite_used_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub wave: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pagination {
    pub limit: i32,
    pub offset: i32,
    pub total: i32,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub invites: Vec<Invite>,
    pub pagination: Pagination,
}
