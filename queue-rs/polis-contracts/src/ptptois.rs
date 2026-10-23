//! Social participants, preserving top-level omission and nested null values.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/ptptois";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub moderation: Option<i32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct XInfo {
    pub x_profile_image_url: String,
    pub x_name: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    #[serde(rename = "mod", skip_serializing_if = "Option::is_none")]
    pub moderation: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_profile_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(rename = "xInfo", skip_serializing_if = "Option::is_none")]
    pub x_info: Option<XInfo>,
    pub conversation_id: String,
}
pub type Response = Vec<Participant>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_node_social_rows_keep_field_order_and_nested_nulls() {
        let bodies: Vec<String> =
            serde_json::from_str(include_str!("fixtures/ptptois.json")).unwrap();
        assert!(bodies.iter().any(|s| s.contains("xInfo")));
        assert!(bodies.iter().any(|s| s.contains("xid")));
        assert!(bodies.iter().any(|s| s.contains("null")));
        for body in bodies {
            let response: Response = serde_json::from_str(&body).unwrap();
            assert_eq!(serde_json::to_string(&response).unwrap(), body);
        }
    }
}
