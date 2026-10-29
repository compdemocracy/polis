//! The participant page reads only text and comment identity from the list.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/comments/participant";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
/// Property order follows the projection of the Node plain list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    pub txt: Option<String>,
    pub tid: i32,
}
pub type Response = Vec<Comment>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_has_only_text_and_identity_in_node_order() {
        for body in [
            r#"[{"txt":"a \"quote\"\n雪","tid":3}]"#,
            r#"[{"txt":null,"tid":0}]"#,
            "[]",
        ] {
            let rows: Response = serde_json::from_str(body).unwrap();
            assert_eq!(serde_json::to_string(&rows).unwrap(), body);
        }
        assert!(serde_json::from_str::<Response>(r#"[{"txt":"x","tid":0,"mod":1}]"#).is_err());
    }
}
