//! Input and redirect target for the public about alias.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/about";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub host: String,
    pub https: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub location: String,
}
impl Request {
    pub fn response(self) -> Response {
        let scheme = if self.https { "https" } else { "http" };
        Response {
            location: format!("{scheme}://{}/home", self.host),
        }
    }
}
