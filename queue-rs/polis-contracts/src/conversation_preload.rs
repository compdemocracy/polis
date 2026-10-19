//! Public conversation presentation fields shared with HTTP clients.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/conversations/preload";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub topic: Option<String>,
    pub description: Option<String>,
    pub created: Option<String>,
    pub link_url: Option<String>,
    pub parent_url: Option<String>,
    pub vis_type: i32,
    pub write_type: i32,
    pub importance_enabled: bool,
    pub help_type: i32,
    pub bgcolor: Option<String>,
    pub help_color: Option<String>,
    pub help_bgcolor: Option<String>,
    pub style_btn: Option<String>,
    pub auth_needed_to_vote: bool,
    pub auth_needed_to_write: bool,
    pub auth_opt_allow_3rdparty: Option<bool>,
    pub conversation_id: String,
}
