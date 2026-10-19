//! Empty developer conversation listing wire types.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/all_conversations";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub owner_email: Option<String>,
    pub limit: u32,
    pub offset: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pagination {
    pub limit: u32,
    pub offset: u32,
    pub total: u32,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub conversations: [(); 0],
    pub pagination: Pagination,
}
impl Request {
    pub fn empty(&self) -> Response {
        Response {
            conversations: [],
            pagination: Pagination {
                limit: self.limit,
                offset: self.offset,
                total: 0,
                has_more: false,
            },
        }
    }
}
