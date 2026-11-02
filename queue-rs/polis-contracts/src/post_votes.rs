//! POST /api/v3/votes as served by Node. This is a contract, not a writer.
//!
//! Auth and conversation resolution precede field parsing. A malformed vote can
//! create a participant without returning its token. Vote history + latest state
//! commit in one statement; star and next-comment work happen afterward. An HTTP
//! error is therefore not evidence that nothing was saved. Never replay it merely
//! because a proxy got an error. See the recording profile for durable witnesses.
//!
//! Source pin: 050dd04e7e6d9154e259a8addaa1e2229a768489. Middleware order:
//! server/app.ts:1272–1288. `parse_fields` covers only the fields registered after
//! membership; CID/XID validation, cookies and JWT identity resolution are outside
//! it (server/src/utils/parameter.ts:336; server/app.ts:1279–1280).
//! The decoder models Node JSON and production finalhandler bodies, including
//! the 50 MiB parser limit (server/app.ts:342) and HTTPS policy
//! (server/src/utils/domain.ts:59). Gateway-generated responses and development
//! finalhandler stack traces are outside this contract. It is not write admission.
use crate::votes::{StorageConvention, VoteChoice, WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS};
use crate::wire::JsNumber;
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};

pub const PATH: &str = "/api/v3/votes";
pub const CONTRACT: &str = "post-votes/1";

/// Raw body fields deliberately retain invalid types for characterization.
/// Null and absence both mean missing to Node's parameter middleware. Unknown
/// fields (including weight and caller-supplied pid) are not route inputs.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Request {
    pub conversation_id: Option<Value>,
    pub xid: Option<Value>,
    pub tid: Option<Value>,
    pub vote: Option<Value>,
    pub starred: Option<Value>,
    pub high_priority: Option<Value>,
    pub lang: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFields {
    /// Node accepts integer prefixes and does not bound tid to PostgreSQL int4.
    /// An overflowing decimal string can parse to infinity and fail at the DB.
    pub tid: f64,
    pub vote: VoteChoice,
    pub starred: Option<bool>,
    pub high_priority: bool,
    pub lang: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidField(pub &'static str);
fn ecma_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
/// Node's getInt: numeric integers or parseInt(text, 10), not strict decimal.
pub fn integer(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0),
        Value::String(s) => {
            let s = s.trim_start_matches(ecma_space);
            let sign = usize::from(s.starts_with(['+', '-']));
            let digits = s
                .as_bytes()
                .iter()
                .skip(sign)
                .take_while(|b| b.is_ascii_digit())
                .count();
            if digits == 0 {
                None
            } else {
                s[..sign + digits].parse().ok()
            }
        }
        _ => None,
    }
}
pub fn boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(v) => Some(*v),
        Value::Number(n) => n.as_f64().map(|n| n != 0.0),
        Value::String(s) => match s.to_lowercase().as_str() {
            "t" | "true" | "on" | "1" => Some(true),
            "f" | "false" | "off" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
/// Node checks UTF-16 length before trimming ASCII spaces; empty is accepted.
pub fn string(value: &Value, max: usize) -> Option<String> {
    value
        .as_str()
        .filter(|s| s.encode_utf16().count() <= max)
        .map(|s| s.trim_matches(' ').to_owned())
}
impl Request {
    /// Only route-local fields, after auth/membership. Not an auth simulator.
    pub fn parse_fields(&self) -> Result<ParsedFields, InvalidField> {
        let tid = self
            .tid
            .as_ref()
            .and_then(integer)
            .ok_or(InvalidField("tid"))?;
        let raw = self
            .vote
            .as_ref()
            .and_then(integer)
            .ok_or(InvalidField("vote"))?;
        let vote = if raw == f64::from(WIRE_AGREE) {
            VoteChoice::Agree
        } else if raw == f64::from(WIRE_DISAGREE) {
            VoteChoice::Disagree
        } else if raw == f64::from(WIRE_PASS) {
            VoteChoice::Pass
        } else {
            return Err(InvalidField("vote"));
        };
        let optional_bool = |v: &Option<Value>, name| match v.as_ref().filter(|v| !v.is_null()) {
            None => Ok(None),
            Some(v) => boolean(v).map(Some).ok_or(InvalidField(name)),
        };
        let starred = optional_bool(&self.starred, "starred")?;
        let high_priority = optional_bool(&self.high_priority, "high_priority")?.unwrap_or(false);
        let lang = match self.lang.as_ref().filter(|v| !v.is_null()) {
            None => None,
            Some(v) => Some(string(v, 10).ok_or(InvalidField("lang"))?),
        };
        Ok(ParsedFields {
            tid,
            vote,
            starred,
            high_priority,
            lang,
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    pub token: String,
    pub token_type: String,
    pub expires_in: u64,
}
impl Auth {
    /// server/src/auth/ensure-participant.ts:667–671.
    fn validate(&self) -> Result<(), String> {
        if self.token_type != "Bearer"
            || self.expires_in != u64::from(crate::auth_envelope::EXPIRATION_SECONDS)
        {
            return Err("invalid issued auth metadata".into());
        }
        Ok(())
    }
}
/// Retain exact bytes/order of nextComment, whose translation rows and optional
/// fields come from Node. Ordinary selection adds counts/randomN at
/// server/src/nextComment.ts:100–110, :170; topical selection constructs only
/// zid/tid/txt at :353–357. Both add translations at :420, :464–508 (300 ms timer at :501).
#[derive(Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct NextComment(pub Box<RawValue>);
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum NextCommentFields {
    Ordinary(OrdinaryNextComment),
    Topical(TopicalNextComment),
}
#[derive(Debug, Deserialize)]
pub struct OrdinaryNextComment {
    pub tid: i32,
    pub txt: String,
    pub remaining: u64,
    pub total: u64,
    #[serde(rename = "randomN")]
    pub random_n: JsNumber,
    pub translations: Vec<Value>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopicalNextComment {
    pub zid: i32,
    pub tid: i32,
    pub txt: String,
    pub translations: Vec<Value>,
}
impl NextComment {
    pub fn fields(&self) -> serde_json::Result<NextCommentFields> {
        serde_json::from_str(self.0.get())
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Success {
    #[serde(rename = "nextComment", skip_serializing_if = "Option::is_none")]
    pub next_comment: Option<NextComment>,
    #[serde(rename = "currentPid")]
    pub current_pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
}
/// Intentional Rust contract, separate from the unchanged Node decoder above.
/// See POST_VOTES_DURABLE.md for the latest-choice retry rule and unknown commit.
pub const DURABLE_CONTRACT: &str = "post-votes-durable/1";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedVote {
    pub tid: i32,
    /// Wire convention, produced by VoteChoice::wire, never a storage integer.
    pub vote: i8,
    pub created: i64,
    pub replayed: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FollowOnState {
    Absent,
    Complete,
    Degraded,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationState {
    BestEffort,
    Degraded,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FollowOn {
    pub star: FollowOnState,
    pub next_comment: FollowOnState,
    pub notifications: NotificationState,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DurableSuccess {
    #[serde(rename = "nextComment", skip_serializing_if = "Option::is_none")]
    pub next_comment: Option<NextComment>,
    #[serde(rename = "currentPid")]
    pub current_pid: i32,
    pub vote: AcceptedVote,
    #[serde(rename = "followOn")]
    pub follow_on: FollowOn,
}
impl DurableSuccess {
    pub fn decode(body: &[u8]) -> Result<Self, String> {
        let value: Self = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        reject_null_optionals(body, &["nextComment"])?;
        if ![WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS].contains(&value.vote.vote) {
            return Err("invalid wire vote".into());
        }
        if value.next_comment.is_some() != (value.follow_on.next_comment == FollowOnState::Complete)
        {
            return Err("nextComment and followOn disagree".into());
        }
        if let Some(next) = &value.next_comment {
            next.fields().map_err(|e| e.to_string())?;
        }
        Ok(value)
    }
}

/// The source initializes a fresh result with no shouldMod, so modOptions is
/// unreachable here. Auth injection also occurs on handler failJson responses.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub error: String,
    pub message: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthFailure {
    pub error: String,
    pub details: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccountFailure {
    pub error: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}
#[derive(Debug)]
pub enum Response {
    Success(Success),
    Failure(Failure),
    AuthFailure(AuthFailure),
    AccountFailure(AccountFailure),
    /// Express production finalhandler; middleware errors are not failJson.
    Text {
        status: u16,
        body: Vec<u8>,
    },
}
impl Response {
    pub fn decode(status: u16, body: &[u8]) -> Result<Self, String> {
        if status == 200 {
            let result: Success = serde_json::from_slice(body).map_err(|e| e.to_string())?;
            reject_null_optionals(body, &["nextComment", "auth"])?;
            if let Some(next) = &result.next_comment {
                next.fields().map_err(|e| e.to_string())?;
            }
            if let Some(auth) = &result.auth {
                auth.validate()?;
            }
            return Ok(Self::Success(result));
        }
        if body == b"Bad Request\n" && status == 400
            || body == b"Internal Server Error\n" && status == 500
            || body == b"Payload Too Large\n" && status == 413
            || body == b"Unsupported Media Type\n" && status == 415
            || body == b"Please use HTTPS when submitting data." && status == 400
        {
            return Ok(Self::Text {
                status,
                body: body.to_vec(),
            });
        }
        if status == 401 {
            if let Ok(value) = serde_json::from_slice::<AuthFailure>(body) {
                if value.error == "Invalid authentication token"
                    || value.error == "Invalid token format"
                        && value.details == "Token does not match any supported JWT type"
                {
                    return Ok(Self::AuthFailure(value));
                }
            }
        }
        if let Ok(value) = serde_json::from_slice::<AccountFailure>(body) {
            reject_null_optionals(body, &["details", "retry_after"])?;
            if ACCOUNT_ERRORS.iter().any(|(s, code, message)| {
                *s == status && *code == value.error && *message == value.message
            }) && (status == 429 && value.retry_after == Some(1)
                || status != 429 && value.retry_after.is_none())
                && (value.details.is_none()
                    || matches!(
                        value.error.as_str(),
                        "user_creation_failed" | "authentication_error"
                    ))
            {
                return Ok(Self::AccountFailure(value));
            }
        }
        let result: Failure = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        reject_null_optionals(body, &["auth"])?;
        if result.status != status
            || result.message != result.error
            || !ERRORS
                .iter()
                .any(|(s, c, _)| *s == status && *c == result.error)
        {
            return Err("unrecognized POST votes error".into());
        }
        if let Some(auth) = &result.auth {
            // Membership and parameter errors precede attachAuthToken:
            // server/app.ts:1277–1287; auth/ensure-participant.ts:683–698;
            // utils/parameter.ts:137. Only handler errors can carry it.
            if !matches!(
                result.error.as_str(),
                "polis_err_conversation_is_closed"
                    | "polis_err_vote_duplicate"
                    | "polis_err_vote"
                    | "polis_err_finishing_response"
            ) {
                return Err("auth is unavailable before the token injector".into());
            }
            auth.validate()?;
        }
        Ok(Self::Failure(result))
    }
    pub fn bytes(&self) -> serde_json::Result<Vec<u8>> {
        match self {
            Self::Success(v) => serde_json::to_vec(v),
            Self::Failure(v) => serde_json::to_vec(v),
            Self::AuthFailure(v) => serde_json::to_vec(v),
            Self::AccountFailure(v) => serde_json::to_vec(v),
            Self::Text { body, .. } => Ok(body.clone()),
        }
    }
}
fn reject_null_optionals(body: &[u8], fields: &[&str]) -> Result<(), String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    if fields
        .iter()
        .any(|field| value.get(field).is_some_and(Value::is_null))
    {
        return Err("Node omits absent optional response fields".into());
    }
    Ok(())
}
/// Third column identifies the producer and explicit SQL-fault coverage.
/// Accepted failJson producers: server/src/utils/parameter.ts:137,
/// auth/ensure-participant.ts:683–698, routes/votes.ts:283–302 and
/// server-helpers.ts:236. Unreachable catches are listed separately.
pub const ERRORS: &[(u16, &str, &str)] = &[
    (400, "polis_err_misc", "parameter assigner exception"),
    (
        401,
        "polis_err_treevite_auth_required",
        "membership refusal",
    ),
    (403, "polis_err_xid_required", "new identity refusal"),
    (403, "polis_err_xid_not_allowed", "allow-list refusal"),
    (403, "polis_err_conversation_is_closed", "handler refusal"),
    (
        406,
        "polis_err_vote_duplicate",
        "SQLSTATE 23505; no history unique key on published schema",
    ),
    (
        500,
        "polis_err_vote",
        "insert, star or next-comment failure; may have committed",
    ),
    (
        500,
        "polis_err_finishing_response",
        "finishOne serialization failure after mutation",
    ),
];
/// Excluded from decoding: fresh result has no zid (routes/votes.ts:253), so
/// addConversationId resolves immediately (server-helpers.ts:197); its rejection
/// catch at :232 cannot run. The other two labels are legacy handler catches
/// (routes/votes.ts:291–302), never thrown by doVotesPost at this pin.
pub const UNREACHABLE_ERRORS: &[(u16, &str, &str)] = &[
    (
        500,
        "polis_err_finishing_responseA",
        "unreachable addConversationId rejection",
    ),
    (
        403,
        "polis_err_post_votes_social_needed",
        "unreachable legacy handler catch",
    ),
    (
        500,
        "polis_err_vote_anonymous_user_creation",
        "unreachable legacy handler catch",
    ),
];
/// server/src/auth/jwt-middleware.ts:104–160. Only the two 500 branches may
/// include details, and only in DEV_MODE. decode accepts both configuration
/// modes; it does not assert which mode produced a particular response.
pub const ACCOUNT_ERRORS: &[(u16, &str, &str)] = &[
    (
        429,
        "too_many_requests",
        "Authentication system is experiencing high load. Please try again in a moment.",
    ),
    (
        400,
        "invalid_user_data",
        "User account is missing required information (email).",
    ),
    (
        429,
        "authentication_conflict",
        "Authentication system encountered a temporary conflict. Please try again.",
    ),
    (
        500,
        "user_creation_failed",
        "Failed to create or map user account",
    ),
    (
        500,
        "authentication_error",
        "An unexpected authentication error occurred",
    ),
];
/// The INSERT rule replaces vote and modified, even for a repeated vote or equal
/// timestamp. It does not select MAX(created) and does not replace latest weight.
/// History always appends. high_priority exists only on history at this pin.
pub fn stored_vote(choice: VoteChoice) -> i32 {
    StorageConvention::CURRENT.encode(choice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn node_integer_and_boolean_coercions() {
        for (value, expected) in [
            (json!("  +12tail"), Some(12.0)),
            (json!("0x10"), Some(0.0)),
            (json!("1.9"), Some(1.0)),
            (json!("1e3"), Some(1.0)),
            (json!("\u{feff}3"), Some(3.0)),
            (json!(1.5), None),
            (json!(true), None),
            (json!(""), None),
        ] {
            assert_eq!(integer(&value), expected);
        }
        for (value, expected) in [
            (json!(2), Some(true)),
            (json!("OFF"), Some(false)),
            (json!(" true "), None),
            (json!([]), None),
        ] {
            assert_eq!(boolean(&value), expected);
        }
    }
    #[test]
    fn string_length_precedes_ascii_space_trimming() {
        assert_eq!(string(&json!("  x  "), 5), Some("x".into()));
        assert_eq!(string(&json!("  x  "), 4), None);
        assert_eq!(string(&json!(""), 10), Some("".into()));
        assert_eq!(string(&json!("😀"), 1), None);
        assert_eq!(string(&json!("\t"), 1), Some("\t".into()));
    }
    #[test]
    fn optional_null_defaults_and_vote_meaning() {
        let r: Request = serde_json::from_value(
            json!({"tid":"0tail","vote":WIRE_AGREE,"starred":null,"high_priority":null}),
        )
        .unwrap();
        let v = r.parse_fields().unwrap();
        assert_eq!(v.vote, VoteChoice::Agree);
        assert_eq!(v.starred, None);
        assert!(!v.high_priority);
        assert_eq!(
            stored_vote(v.vote),
            StorageConvention::CURRENT.encode(VoteChoice::Agree)
        );
    }
    #[test]
    fn middleware_field_order_is_preserved() {
        let r: Request =
            serde_json::from_value(json!({"tid":false,"vote":99,"starred":"bad"})).unwrap();
        assert_eq!(r.parse_fields(), Err(InvalidField("tid")));
    }
    #[test]
    fn topical_and_translated_selection_preserve_bytes() {
        for body in [
            r#"{"nextComment":{"zid":1,"tid":7,"txt":"Generated topical","translations":[]},"currentPid":2}"#,
            r#"{"nextComment":{"zid":1,"tid":7,"txt":"Generated topical","translations":[{"zid":1,"tid":7,"txt":"Texte","lang":"fr"}]},"currentPid":2}"#,
        ] {
            let decoded = Response::decode(200, body.as_bytes()).unwrap();
            assert_eq!(decoded.bytes().unwrap(), body.as_bytes());
            let Response::Success(success) = decoded else {
                panic!("success")
            };
            assert!(matches!(
                success.next_comment.unwrap().fields().unwrap(),
                NextCommentFields::Topical(_)
            ));
        }
        for body in [
            r#"{"nextComment":{"tid":7,"txt":"Incomplete ordinary"},"currentPid":2}"#,
            r#"{"nextComment":null,"currentPid":2}"#,
            r#"{"nextComment":{"zid":1,"tid":7,"txt":"Partial counts","remaining":3,"translations":[]},"currentPid":2}"#,
        ] {
            assert!(Response::decode(200, body.as_bytes()).is_err());
        }
    }
    #[test]
    fn ordinary_translations_require_an_array_and_preserve_bytes() {
        for body in [
            r#"{"nextComment":{"tid":7,"txt":"Generated ordinary","remaining":3,"total":4,"randomN":0.5,"translations":[]},"currentPid":2}"#,
            r#"{"nextComment":{"tid":7,"txt":"Generated ordinary","remaining":3,"total":4,"randomN":0.5,"translations":[{"zid":1,"tid":7,"txt":"Texte","lang":"fr"}]},"currentPid":2}"#,
        ] {
            let decoded = Response::decode(200, body.as_bytes()).unwrap();
            assert_eq!(decoded.bytes().unwrap(), body.as_bytes());
            let Response::Success(success) = decoded else {
                panic!("success")
            };
            assert!(matches!(
                success.next_comment.unwrap().fields().unwrap(),
                NextCommentFields::Ordinary(_)
            ));
        }
        for body in [
            r#"{"nextComment":{"tid":7,"txt":"Missing translations","remaining":3,"total":4,"randomN":0.5},"currentPid":2}"#,
            r#"{"nextComment":{"tid":7,"txt":"Null translations","remaining":3,"total":4,"randomN":0.5,"translations":null},"currentPid":2}"#,
        ] {
            assert!(Response::decode(200, body.as_bytes()).is_err());
        }
    }
    #[test]
    fn middleware_position_controls_auth_delivery() {
        let auth = json!({"token":"generated-token","token_type":"Bearer","expires_in":31_536_000});
        for &(status, code, _) in ERRORS {
            let mut body = json!({"error":code,"message":code,"status":status});
            assert!(
                Response::decode(status, &serde_json::to_vec(&body).unwrap()).is_ok(),
                "{code}"
            );
            body["auth"] = auth.clone();
            let handler = matches!(
                code,
                "polis_err_conversation_is_closed"
                    | "polis_err_vote_duplicate"
                    | "polis_err_vote"
                    | "polis_err_finishing_response"
            );
            assert_eq!(
                Response::decode(status, &serde_json::to_vec(&body).unwrap()).is_ok(),
                handler,
                "{code}"
            );
        }
        for &(status, code, _) in UNREACHABLE_ERRORS {
            let body = json!({"error":code,"message":code,"status":status});
            assert!(Response::decode(status, &serde_json::to_vec(&body).unwrap()).is_err());
        }
        for (field, value) in [("token_type", json!("bearer")), ("expires_in", json!(1))] {
            let mut body = json!({"currentPid":2,"auth":auth});
            body["auth"][field] = value;
            assert!(Response::decode(200, &serde_json::to_vec(&body).unwrap()).is_err());
        }
    }
    #[test]
    fn account_envelopes_follow_their_producers() {
        for &(status, error, message) in ACCOUNT_ERRORS {
            let mut body = json!({"error":error,"message":message});
            if status == 429 {
                body["retry_after"] = json!(1);
            }
            assert!(Response::decode(status, &serde_json::to_vec(&body).unwrap()).is_ok());
            body["details"] = json!("generated account failure");
            assert_eq!(
                Response::decode(status, &serde_json::to_vec(&body).unwrap()).is_ok(),
                status == 500
            );
            body.as_object_mut().unwrap().remove("details");
            body["retry_after"] = json!(2);
            assert!(Response::decode(status, &serde_json::to_vec(&body).unwrap()).is_err());
        }
    }
    #[test]
    fn pre_handler_transport_and_auth_envelopes() {
        for (status, body) in [
            (400, "Bad Request\n"),
            (500, "Internal Server Error\n"),
            (413, "Payload Too Large\n"),
            (415, "Unsupported Media Type\n"),
            (400, "Please use HTTPS when submitting data."),
            (
                401,
                r#"{"error":"Invalid authentication token","details":"jwt expired"}"#,
            ),
            (
                401,
                r#"{"error":"Invalid token format","details":"Token does not match any supported JWT type"}"#,
            ),
        ] {
            let response = Response::decode(status, body.as_bytes()).unwrap();
            assert_eq!(response.bytes().unwrap(), body.as_bytes());
            assert!(Response::decode(404, body.as_bytes()).is_err());
        }
        // Optional hybrid auth never emits the required-auth missing-token body.
        assert!(Response::decode(401, br#"{"error":"No authentication token found"}"#).is_err());
    }
    #[test]
    fn recorded_response_bytes_round_trip() {
        round_trip(
            include_str!("../../../server/characterization/votes/contract-cases.json"),
            72,
        );
    }
    #[test]
    fn additional_recorded_response_bytes_round_trip() {
        round_trip(
            include_str!("../../../server/characterization/votes/additional-cases.json"),
            68,
        );
    }
    fn round_trip(fixture: &str, count: usize) {
        let rows: Value = serde_json::from_str(fixture).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), count);
        for row in rows.as_array().unwrap() {
            let body = row["body"].as_str().unwrap();
            let response =
                Response::decode(row["status"].as_u64().unwrap() as u16, body.as_bytes())
                    .unwrap_or_else(|e| panic!("{}: {e}", row["case"]));
            assert_eq!(
                response.bytes().unwrap(),
                body.as_bytes(),
                "{}",
                row["case"]
            );
        }
    }
}

#[cfg(test)]
mod durable_tests {
    use super::*;
    #[test]
    fn recorded_durable_receipts_and_invalid_envelopes() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../server/characterization/votes/durable-cases.json"
        ))
        .unwrap();
        for case in cases.as_object().unwrap().values() {
            for key in ["first", "retry"] {
                let value = &case[key];
                let body = DurableSuccess::decode(&serde_json::to_vec(value).unwrap()).unwrap();
                assert_eq!(serde_json::to_value(body).unwrap(), *value);
                assert!(
                    Response::decode(200, &serde_json::to_vec(value).unwrap()).is_err(),
                    "Node decoder must not silently accept the deliberate difference"
                );
                for (field, bad) in [
                    ("nextComment", Value::Null),
                    ("auth", serde_json::json!({})),
                    ("vote", serde_json::json!({})),
                ] {
                    let mut invalid = value.clone();
                    invalid[field] = bad;
                    assert!(
                        DurableSuccess::decode(&serde_json::to_vec(&invalid).unwrap()).is_err()
                    );
                }
                let mut invalid = value.clone();
                invalid["followOn"]["nextComment"] = serde_json::json!("complete");
                assert!(DurableSuccess::decode(&serde_json::to_vec(&invalid).unwrap()).is_err());
            }
        }
    }
}
