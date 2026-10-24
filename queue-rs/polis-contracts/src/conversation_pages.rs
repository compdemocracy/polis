//! Per-conversation static pages with typed preload and stream output.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Page {
    Conversation,
    Explore,
    Share,
    Summary,
    OneTime,
}
impl Page {
    pub fn index(self) -> usize {
        match self {
            Self::Conversation => 0,
            Self::Explore => 1,
            Self::Share => 2,
            Self::Summary => 3,
            Self::OneTime => 4,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub page: Page,
    pub conversation_id: String,
    pub path: String,
    pub head_only: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub html: String,
}
