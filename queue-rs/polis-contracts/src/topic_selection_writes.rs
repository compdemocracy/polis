//! POST, PUT and DELETE topic selections as served by the Node routes.
//! Authentication and participant resolution precede these handler responses.
//! POST can attach newly issued credentials to errors as well as successes.
//! PUT updates first, then inserts when absent; it is not an atomic upsert.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PATH: &str = "/api/v3/topicAgenda/selections";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Post,
    Put,
    Delete,
}

/// Retain invalid input shapes for characterization; this is not admission.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Request {
    pub conversation_id: Option<Value>,
    pub selections: Option<Value>,
}
impl Request {
    pub fn missing_selections(&self) -> bool {
        match self.selections.as_ref() {
            None | Some(Value::Null) | Some(Value::Bool(false)) => true,
            Some(Value::String(s)) => s.is_empty(),
            Some(Value::Number(n)) => n.as_f64() == Some(0.0),
            _ => false,
        }
    }
    /// Node reads `.length` without checking the type. Strings count UTF-16
    /// code units; an object may itself supply a length property. Undefined
    /// becomes a SQL null, which the published count column rejects.
    pub fn length(&self) -> Option<Value> {
        match self.selections.as_ref()? {
            Value::Array(a) => Some(Value::from(a.len())),
            Value::String(s) => Some(Value::from(s.encode_utf16().count())),
            Value::Object(o) => o.get("length").cloned(),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum SuccessMessage {
    #[serde(rename = "Topic agenda selections saved successfully")]
    Saved,
    #[serde(rename = "Topic agenda selections created successfully")]
    Created,
    #[serde(rename = "Topic agenda selections updated successfully")]
    Updated,
    #[serde(rename = "Topic agenda selections deleted successfully")]
    Deleted,
    #[serde(rename = "No selections to delete")]
    Absent,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ErrorMessage {
    #[serde(rename = "selections are required")]
    SelectionsRequired,
    #[serde(rename = "Authentication required")]
    AuthenticationRequired,
    #[serde(rename = "Failed to save topic agenda selections")]
    Save,
    #[serde(rename = "Failed to update topic agenda selections")]
    Update,
    #[serde(rename = "Failed to delete topic agenda selections")]
    Delete,
}
/// A zero SQL count falls back to the input's `.length` in Node. An object
/// with a textual zero length therefore returns that text, not a number.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum SelectionCount {
    Integer(i32),
    Text(String),
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Data {
    pub conversation_id: String,
    pub participant_id: String,
    pub selections_count: SelectionCount,
    pub job_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Auth {
    pub token: String,
    pub token_type: String,
    pub expires_in: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Response {
    Success {
        message: SuccessMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Data>,
        #[serde(skip_serializing_if = "Option::is_none")]
        auth: Option<Auth>,
    },
    Error {
        message: ErrorMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        auth: Option<Auth>,
    },
}
impl Response {
    pub fn success(message: SuccessMessage, data: Option<Data>) -> Self {
        Self::Success {
            message,
            data,
            auth: None,
        }
    }
    pub fn failure(method: Method) -> Self {
        Self::Error {
            message: match method {
                Method::Post => ErrorMessage::Save,
                Method::Put => ErrorMessage::Update,
                Method::Delete => ErrorMessage::Delete,
            },
            auth: None,
        }
    }
}
/// Authentication and membership middleware use different JSON envelopes.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AuthenticationError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MembershipError {
    pub error: String,
    pub message: String,
    pub status: u16,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Decoded {
    Handler(Response),
    Membership(MembershipError),
    Authentication(AuthenticationError),
    Parser { status: u16, body: String },
}
/// Parser responses are literal production finalhandler text. This does not
/// synthesize them in Rust; unsupported requests belong to Node before writes.
pub fn decode(status: u16, body: &str) -> Result<Decoded, serde_json::Error> {
    if matches!(
        (status, body),
        (400, "Bad Request\n") | (413, "Payload Too Large\n") | (415, "Unsupported Media Type\n")
    ) {
        return Ok(Decoded::Parser {
            status,
            body: body.into(),
        });
    }
    if let Ok(v) = serde_json::from_str::<Response>(body) {
        return Ok(Decoded::Handler(v));
    }
    if let Ok(v) = serde_json::from_str::<MembershipError>(body) {
        return Ok(Decoded::Membership(v));
    }
    serde_json::from_str(body).map(Decoded::Authentication)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_recorded_envelope_decodes_and_handler_bytes_round_trip() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../server/characterization/selections/cases.json"
        ))
        .unwrap();
        assert_eq!(cases.as_array().unwrap().len(), 164);
        for case in cases.as_array().unwrap() {
            let body = case["body"].as_str().unwrap();
            let response = decode(case["status"].as_u64().unwrap() as u16, body).unwrap();
            if let Decoded::Handler(response) = response {
                assert_eq!(
                    serde_json::to_string(&response).unwrap(),
                    body,
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn truthiness_precedes_membership_and_is_not_array_validation() {
        for selections in [Value::Null, json!(false), json!(0), json!("")] {
            assert!(Request {
                selections: Some(selections),
                ..Default::default()
            }
            .missing_selections());
        }
        assert!(Request::default().missing_selections());
        for selections in [json!([]), json!({}), json!(true), json!("x"), json!(-1)] {
            assert!(!Request {
                selections: Some(selections),
                ..Default::default()
            }
            .missing_selections());
        }
    }
    #[test]
    fn node_length_and_undefined_are_distinct() {
        for (selections, length) in [
            (json!([]), Some(json!(0))),
            (json!([null, false]), Some(json!(2))),
            (json!("🗳"), Some(json!(2))),
            (json!({}), None),
            (json!(true), None),
            (json!({"length":3}), Some(json!(3))),
        ] {
            assert_eq!(
                Request {
                    selections: Some(selections),
                    ..Default::default()
                }
                .length(),
                length
            );
        }
    }
    #[test]
    fn ordered_success_bytes_and_null_attribution() {
        let response = Response::success(
            SuccessMessage::Saved,
            Some(Data {
                conversation_id: "1".into(),
                participant_id: "0".into(),
                selections_count: SelectionCount::Integer(0),
                job_id: None,
            }),
        );
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"status":"success","message":"Topic agenda selections saved successfully","data":{"conversation_id":"1","participant_id":"0","selections_count":0,"job_id":null}}"#
        );
        assert_eq!(
            serde_json::to_string(&Response::success(SuccessMessage::Absent, None)).unwrap(),
            r#"{"status":"success","message":"No selections to delete"}"#
        );
    }
    #[test]
    fn error_bodies_can_carry_auth_without_a_success_status() {
        let raw = r#"{"status":"error","message":"selections are required","auth":{"token":"generated","token_type":"Bearer","expires_in":31536000}}"#;
        let response: Response = serde_json::from_str(raw).unwrap();
        assert_eq!(serde_json::to_string(&response).unwrap(), raw);
        assert_eq!(
            serde_json::to_string(&Response::failure(Method::Put)).unwrap(),
            r#"{"status":"error","message":"Failed to update topic agenda selections"}"#
        );
    }
}
