//! POST stars/trashes: required hybrid auth, tid, conversation, value, UID
//! membership, then append. No active/visibility check or uniqueness guarantee.
//! Stars currently returns 500 after an ordinary committed append because its
//! handler reads `result.rows` from queryP's array; preserve that wire contract.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Kind {
    Star,
    Trash,
}
impl Kind {
    pub fn from_path(path: &str) -> Option<Self> {
        match path {
            "/api/v3/stars" => Some(Self::Star),
            "/api/v3/trashes" => Some(Self::Trash),
            _ => None,
        }
    }
    pub fn field(self) -> &'static str {
        match self {
            Self::Star => "starred",
            Self::Trash => "trashed",
        }
    }
}
/// Raw shapes preserve parser failures as well as valid requests. Integer
/// strings use Node parseInt; the dormant writer hands those shapes to Node.
#[derive(Debug, Deserialize, Serialize)]
pub struct Request {
    pub conversation_id: Option<Value>,
    pub tid: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starred: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed: Option<Value>,
}
#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub enum HandlerError {
    #[serde(rename = "polis_err_vote")]
    Vote,
    #[serde(rename = "polis_err_vote_duplicate")]
    Duplicate,
    #[serde(rename = "polis_err_trashes")]
    TrashCallback,
}
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Response {
    Failure {
        error: HandlerError,
        message: HandlerError,
        status: u16,
    },
    Auth {
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },
    Empty(Empty),
}
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
/// Parser/credential/membership HTML is retained verbatim in the recording;
/// its bytes are not reinterpreted as a JSON handler response.
#[derive(Debug, Deserialize, Serialize)]
pub struct Observation {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorded_json_envelopes_round_trip() {
        let cases: Vec<Observation> = serde_json::from_str(include_str!(
            "../../../server/characterization/marks/cases.json"
        ))
        .unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            if let Ok(v) = serde_json::from_str::<Value>(&case.body) {
                let decoded: Response = serde_json::from_value(v.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), v);
            } else {
                assert!(matches!(case.status, 400 | 401 | 415 | 500));
            }
        }
    }
    #[test]
    fn routes_and_raw_shapes() {
        assert_eq!(Kind::from_path("/api/v3/stars"), Some(Kind::Star));
        assert_eq!(Kind::from_path("/api/v3/trashes"), Some(Kind::Trash));
        assert_eq!(Kind::from_path("/api/v3/votes"), None);
        let r: Request =
            serde_json::from_str(r#"{"conversation_id":"fixture","tid":"3x","starred":true}"#)
                .unwrap();
        assert_eq!(r.tid, Some(Value::String("3x".into())));
        assert_eq!(r.starred, Some(Value::Bool(true)));
    }
}
