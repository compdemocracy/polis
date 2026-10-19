//! Empty legacy conversation list wire types.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/conversations";
pub const DENIED: &str = "polis_err_need_auth";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub limit: u32,
    pub include_all: bool,
    pub is_active: Option<bool>,
    pub is_draft: Option<bool>,
}
pub type EmptyResponse = [(); 0];
