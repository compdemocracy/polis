//! The moderation page's row and pagination envelope, excluding report data.
//!
//! Query values use Node's decimal integer-prefix parser: leading JavaScript
//! whitespace and a sign are allowed, and parsing stops at the first nondigit.
//! Thus 1.5, 01, +1 and 1abc all mean 1. Empty values, text without a leading
//! integer, duplicate keys and array/object values return 400 Bad Request\n.
//! Numbers are rounded as JavaScript Numbers before pagination is applied.
//! Nonpositive limits use 50; positive limits clamp to 500. An omitted or
//! negative offset means zero. Offsets beyond a signed 32-bit integer are kept;
//! offsets outside PostgreSQL's signed 64-bit range return polis_err_get_comments.
//! Both limit and mod must be present: the typed route never reads Node's
//! unbounded legacy array or its list of every moderation state. Omitting either
//! hands back to Node before any database read. Parsed mod values other than
//! 0, 1 and -1 also hand back to Node without writes.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/comments/moderation";
pub const DENIED: &str = "polis_err_comments_moderation_forbidden";
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub r#mod: i32,
    pub limit: i32,
    pub offset: f64,
}
/// Declaration order is the Node moderation row's projected property order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    pub txt: Option<String>,
    pub tid: i32,
    pub is_meta: Option<bool>,
    pub velocity: Option<f64>,
    pub r#mod: Option<i32>,
    pub active: Option<bool>,
    pub conversation_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Pagination {
    pub limit: i32,
    pub offset: i64,
    pub total: i64,
    pub has_more: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub comments: Vec<Comment>,
    pub pagination: Pagination,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_and_envelope_keep_node_property_order() {
        let body = r#"{"comments":[{"txt":"a \"quote\"\n雪","tid":3,"is_meta":null,"velocity":0.1,"mod":-1,"active":false,"conversation_id":"fixture"}],"pagination":{"limit":50,"offset":0,"total":1,"hasMore":false}}"#;
        let response: Response = serde_json::from_str(body).unwrap();
        assert_eq!(serde_json::to_string(&response).unwrap(), body);
        for extra in ["pid", "agree_count", "includeInReport"] {
            let unknown = body.replace("\"tid\":3", &format!("\"tid\":3,\"{extra}\":0"));
            assert!(serde_json::from_str::<Response>(&unknown).is_err());
        }
    }
}
