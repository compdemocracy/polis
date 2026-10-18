//! Public context names returned in database collation order.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/contexts";
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub name: Option<String>,
}
pub type Response = Vec<Context>;
