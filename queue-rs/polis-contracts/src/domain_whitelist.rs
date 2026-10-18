//! Site whitelist for the authenticated user's site.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/domainWhitelist";
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub domain_whitelist: String,
}
