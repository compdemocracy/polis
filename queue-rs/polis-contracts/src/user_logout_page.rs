//! Legacy-browser redirect for the user-logout page.
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "/user/logout";
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
