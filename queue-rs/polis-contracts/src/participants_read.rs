//! The existing participant-row projection, including its internal integer ID.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/participants";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    pub pid: Option<i32>,
    pub uid: Option<i32>,
    pub zid: Option<i32>,
    pub vote_count: Option<i32>,
    pub last_interaction: Option<String>,
    pub subscribed: Option<i32>,
    pub last_notified: Option<String>,
    pub nsli: Option<i16>,
    #[serde(rename = "mod")]
    pub moderation: Option<i32>,
    pub created: Option<String>,
}
pub type Response = Option<Participant>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_node_rows_preserve_order_types_and_null_membership() {
        let bodies: Vec<String> =
            serde_json::from_str(include_str!("fixtures/participants-read.json")).unwrap();
        assert!(!bodies.is_empty());
        assert!(bodies.iter().any(|s| s == "null"));
        assert!(bodies.iter().any(|s| s.contains("9223372036854775807")));
        for body in bodies {
            let row: Response = serde_json::from_str(&body).unwrap();
            assert_eq!(serde_json::to_string(&row).unwrap(), body);
        }
    }
}
