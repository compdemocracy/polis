//! Public crawler policy. The HTTP body is text, not a JSON envelope.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/robots.txt";
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub body: String,
}
impl Request {
    pub fn response(self) -> Response {
        Response {
            body: "User-agent: *\nDisallow: /api/".into(),
        }
    }
}
