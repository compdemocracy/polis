//! Legacy-browser redirect for the settings page.
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "/settings";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub host: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub location: String,
}
impl Request {
    pub fn response(self) -> Response {
        Response {
            location: format!("https://{}/#{}", self.host, self.path),
        }
    }
}
