//! Authenticated moderator participant XID CSV projection.
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "/api/v3/xid/";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub uuid: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Row {
    pub participant: i32,
    pub xid: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub rows: Vec<Row>,
}
impl Response {
    pub fn csv(&self) -> String {
        let mut out = String::from("participant,xid\n");
        for row in &self.rows {
            out.push_str(&format!(
                "{},\"{}\"\n",
                row.participant,
                row.xid.replace('"', "\"\"")
            ));
        }
        out
    }
}
