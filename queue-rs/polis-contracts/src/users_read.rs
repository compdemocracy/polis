//! User profile reads and owner-scoped XID selection.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/users";
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Request {
    pub xid: Option<String>,
    #[serde(rename = "owner_uid")]
    pub owner: Option<i32>,
}
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub uid: i32,
    pub email: Option<String>,
    pub hname: Option<String>,
    pub has_xid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_info: Option<XInfo>,
    pub finished_tutorial: bool,
    #[serde(rename = "site_ids")]
    pub site_ids: [Option<String>; 1],
    pub created: f64,
}
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct XInfo {
    pub uid: i32,
    pub xid: String,
    pub x_profile_image_url: Option<String>,
    pub x_name: Option<String>,
    pub x_email: Option<String>,
    pub modified: String,
    pub zid: Option<i32>,
    pub pid: Option<i32>,
}
