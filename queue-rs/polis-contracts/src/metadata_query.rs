//! Canonical JSON admission for the read-only metadata selection POST.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/query_participants_by_metadata";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub pmaids: Vec<i32>,
}
pub type Response = Vec<Option<i32>>;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_values_and_empty_selection_keep_their_order() {
        let request: Request =
            serde_json::from_str(r#"{"conversation_id":"fixture","pmaids":[2,-7,2,0]}"#).unwrap();
        assert_eq!(request.pmaids, vec![2, -7, 2, 0]);
        assert_eq!(serde_json::to_string(&Response::new()).unwrap(), "[]");
        assert_eq!(
            serde_json::to_string(&vec![Some(2), None, Some(0)]).unwrap(),
            "[2,null,0]"
        );
    }
    #[test]
    fn coercions_and_duplicate_fields_remain_node_work() {
        for body in [
            r#"{"conversation_id":"fixture","pmaids":"1,2"}"#,
            r#"{"conversation_id":"fixture","pmaids":[1.5]}"#,
            r#"{"conversation_id":"fixture","pmaids":[2147483648]}"#,
            r#"{"conversation_id":"fixture","pmaids":[],"pmaids":[1]}"#,
            r#"{"conversation_id":"fixture","pmaids":[],"extra":1}"#,
        ] {
            assert!(serde_json::from_str::<Request>(body).is_err());
        }
    }
}
