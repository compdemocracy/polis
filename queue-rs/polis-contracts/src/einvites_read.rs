//! Existing email-invite lookup; possession of the code is the legacy authority.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/einvites";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub einvite: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub einvite: String,
    pub email: Option<String>,
    pub created: Option<String>,
}
