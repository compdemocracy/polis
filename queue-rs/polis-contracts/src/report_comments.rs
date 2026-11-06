//! Fields consumed by the report statement list; no math result is required.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/comments/report";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub report_id: String,
    pub mod_gt: i32,
}
/// Declaration order is the projection of Node's report list, not a key sort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    pub txt: Option<String>,
    pub tid: i32,
    pub is_meta: Option<bool>,
    pub pid: Option<i32>,
    pub agree_count: u64,
    pub disagree_count: u64,
    pub pass_count: u64,
    pub count: u64,
}
pub type Response = Vec<Comment>;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_projection_roundtrips_only_consumed_fields() {
        let body = r#"[{"txt":"quoted \"text\" 雪","tid":1,"is_meta":false,"pid":2,"agree_count":3,"disagree_count":1,"pass_count":2,"count":6}]"#;
        let rows: Response = serde_json::from_str(body).unwrap();
        assert_eq!(serde_json::to_string(&rows).unwrap(), body);
        let extended = body.replace("\"pid\":2", "\"pid\":2,\"uid\":4");
        assert!(serde_json::from_str::<Response>(&extended).is_err());
    }
}
