//! Database probe response shared by HTTP clients and the API.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/api/v3/testDatabase";

/// No query parameters or body fields are defined for this probe.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub status: Status,
}
impl Request {
    pub const fn response(self) -> Response {
        Response { status: Status::Ok }
    }
}
