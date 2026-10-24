//! POST /api/v3/comments as served by Node. Contract only; no writer/admission.
//!
//! Source pin: 19873803fa2b84ddca841a50cfb57009650554de.
//! server/app.ts:799-815: reserved participation pools, optional hybrid auth,
//! CID/XID parsing, membership creation, txt/vote/is_seed parsing, token injection,
//! handler. OIDC provisioning and participant creation can commit before invalid
//! text is refused; parser failures precede token injection. Body fields only:
//! no moveToBody, so query strings and caller pid/uid/tid/lang are not inputs.
//!
//! routes/comments.ts:371-633: empty trimmed text is 400; uid/pid resolution
//! (which can hit user.ts's cache) precedes duplicate text checking, which precedes
//! the active-conversation check. Owner/site moderator statements start approved;
//! other statements start active with mod=0, even in strict moderation. is_seed
//! is honored only for moderators. Language detection precedes insertion:
//! comment.ts:563-595 validates provider language/confidence, with bounded failure
//! fallback to null/null, also used when translation is disabled.
//!
//! DURABLE BOUNDARIES: comments INSERT commits before an explicit author vote
//! (routes/comments.ts:491-518). There is NO implicit/default vote, for either
//! seeds or participant statements. votesPost converts wire through the shared
//! convention module (routes/votes.ts:75-99); history and latest projection commit
//! together (000006_update_votes_rule.sql:6-26), separately from the comment.
//! A failed author vote can return 500 with the comment already durable. Retrying
//! that text returns 409; never proxy-retry after mutation may have begun.
//!
//! The tid BEFORE trigger allocates MAX(tid)+1 from zero under transaction lock
//! (873791984,zid), held to COMMIT/ROLLBACK, shared by all writers
//! (000042_tid_auto_transaction_lock.sql:49-66). No private allocator is valid.
//! Participant admission separately updates participant_count in the pid trigger
//! (000000_initial.sql:891-911). This handler does not update comment_count,
//! vote_count or conversations.modified at this pin; do not infer bookkeeping
//! from the older vote handler. The response contains no nextComment.
//!
//! Notification count/recipient reads are awaited and failures swallowed;
//! email promises are detached (routes/comments.ts:521-540,781-824). Non-strict
//! task upsert and participant last_interaction/nsli updates are best effort on
//! the notification pool (comments.ts:295-299,547; server-helpers.ts:442-449),
//! not durability conditions for 200. Slow work must never own participation
//! connections. This contract changes no pool, lock, route or serving behavior.
//!
//! Decoder includes production finalhandler bodies, not gateway responses or
//! development stack traces; identity resolution is not simulated by parse_fields.
use crate::post_votes::{boolean, integer, string, InvalidField};
use crate::votes::{StorageConvention, VoteChoice};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PATH: &str = "/api/v3/comments";
pub const CONTRACT: &str = "post-comments/1";

/// Unknown fields are ignored. Null/absent optional values remain missing.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Request {
    pub conversation_id: Option<Value>,
    pub xid: Option<Value>,
    pub txt: Option<Value>,
    pub vote: Option<Value>,
    pub is_seed: Option<Value>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFields {
    /// UTF-16 length checked before trimming ASCII spaces. Empty is parsed;
    /// handler later returns polis_err_param_missing_txt (parameter.ts:195-214).
    pub txt: String,
    pub vote: Option<VoteChoice>,
    pub is_seed: Option<bool>,
}
impl Request {
    /// Route-local parsing after membership, in registration order. CID and
    /// XID parsing/auth have already happened. Reuses exact Node parsing helpers.
    pub fn parse_fields(&self) -> Result<ParsedFields, InvalidField> {
        let txt = self
            .txt
            .as_ref()
            .and_then(|v| string(v, 997))
            .ok_or(InvalidField("txt"))?;
        let vote = match self.vote.as_ref().filter(|v| !v.is_null()) {
            None => None,
            Some(v) => {
                let raw = integer(v).ok_or(InvalidField("vote"))?;
                Some(
                    [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass]
                        .into_iter()
                        .find(|choice| raw == f64::from(choice.wire()))
                        .ok_or(InvalidField("vote"))?,
                )
            }
        };
        let is_seed = match self.is_seed.as_ref().filter(|v| !v.is_null()) {
            None => None,
            Some(v) => Some(boolean(v).ok_or(InvalidField("is_seed"))?),
        };
        Ok(ParsedFields { txt, vote, is_seed })
    }
}
/// Only an explicitly supplied author choice produces a vote, even for seeds.
pub fn author_vote(choice: Option<VoteChoice>) -> Option<i32> {
    choice.map(|v| StorageConvention::CURRENT.encode(v))
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
        if self.token_type != "Bearer" || self.expires_in != 31_536_000 {
            return Err("invalid issued auth metadata".into());
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Success {
    pub tid: i32,
    #[serde(rename = "currentPid")]
    pub current_pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
}
/// Auth injection also occurs on handler failJson responses.
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
            reject_null_optionals(body, &["auth"])?;
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
                .chain(HANDLER_ERRORS)
                .any(|(s, c, _)| *s == status && *c == result.error)
        {
            return Err("unrecognized POST comments error".into());
        }
        if let Some(auth) = &result.auth {
            // server/app.ts:811-814: only handler failures can carry auth.
            if !HANDLER_ERRORS
                .iter()
                .any(|(_, code, _)| *code == result.error)
            {
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
/// Middleware failJson errors. Parameter parse errors use the production text
/// finalhandler; a valid empty string reaches the handler's JSON refusal.
pub const ERRORS: &[(u16, &str, &str)] = &[
    (400, "polis_err_misc", "utils/parameter.ts:149"),
    (
        401,
        "polis_err_treevite_auth_required",
        "auth/ensure-participant.ts:698",
    ),
    (
        403,
        "polis_err_xid_required",
        "auth/ensure-participant.ts:683",
    ),
    (
        403,
        "polis_err_xid_not_allowed",
        "auth/ensure-participant.ts:690",
    ),
];
/// Source-traced handler variants; SQL faults are explicitly labeled in the
/// recordings. A duplicate allocator key is generic 500, never a text conflict
/// (routes/comments.ts:109-127). The missing-uid guard is defensive: successful
/// createIfMissing middleware supplies uid before invoking this handler.
pub const HANDLER_ERRORS: &[(u16, &str, &str)] = &[
    (400, "polis_err_param_missing_txt", "routes/comments.ts:379"),
    (400, "polis_err_missing_uid", "routes/comments.ts:386"),
    (
        409,
        "polis_err_post_comment_duplicate",
        "routes/comments.ts:455,571",
    ),
    (
        403,
        "polis_err_conversation_is_closed",
        "routes/comments.ts:466",
    ),
    (
        500,
        "polis_err_post_comment_participant_race_condition",
        "routes/comments.ts:590,607",
    ),
    (
        500,
        "polis_err_post_comment_constraint_violation",
        "routes/comments.ts:619",
    ),
    (500, "polis_err_post_comment", "routes/comments.ts:630"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn parse(value: Value) -> Result<ParsedFields, InvalidField> {
        serde_json::from_value::<Request>(value)
            .unwrap()
            .parse_fields()
    }
    #[test]
    fn recorded_response_bytes_round_trip() {
        let rows: Value = serde_json::from_str(include_str!(
            "../../../server/characterization/post-comments/contract-cases.json"
        ))
        .unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 157);
        for row in rows.as_array().unwrap() {
            assert_eq!(row["recording_oracle_pass"], true);
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

    #[test]
    fn text_utf16_length_precedes_ascii_trimming() {
        for text in ["", "   ", "\t", "Generated"] {
            assert_eq!(
                parse(json!({"txt":text})).unwrap().txt,
                text.trim_matches(' ')
            );
        }
        assert!(parse(json!({"txt":"x".repeat(997)})).is_ok());
        assert!(parse(json!({"txt":"x".repeat(998)})).is_err());
        assert!(parse(json!({"txt":"😀".repeat(499)})).is_err());
        assert!(parse(json!({"txt":"😀".repeat(498)+"x"})).is_ok());
        for value in [Value::Null, json!(false), json!(17), json!([]), json!({})] {
            assert_eq!(parse(json!({"txt":value})), Err(InvalidField("txt")));
        }
    }
    #[test]
    fn author_vote_has_no_default_and_uses_convention() {
        assert_eq!(author_vote(None), None);
        for choice in [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass] {
            let p = parse(json!({"txt":"Generated", "vote":format!(" {}tail", choice.wire()), "is_seed":"ON"})).unwrap();
            assert_eq!(p.vote, Some(choice));
            assert_eq!(p.is_seed, Some(true));
            assert_eq!(
                author_vote(p.vote),
                Some(StorageConvention::CURRENT.encode(choice))
            );
        }
        assert_eq!(
            parse(json!({"txt":"Generated","vote":null,"is_seed":null}))
                .unwrap()
                .vote,
            None
        );
        assert_eq!(
            parse(json!({"txt":"Generated","vote":2,"is_seed":"bad"})),
            Err(InvalidField("vote"))
        );
        assert_eq!(
            parse(json!({"txt":"Generated","is_seed":" true "})),
            Err(InvalidField("is_seed"))
        );
        assert_eq!(
            parse(json!({"txt":"Generated","is_seed":2}))
                .unwrap()
                .is_seed,
            Some(true)
        );
    }
    #[test]
    fn strict_success_and_error_variants() {
        let body = br#"{"tid":0,"currentPid":0}"#;
        assert_eq!(Response::decode(200, body).unwrap().bytes().unwrap(), body);
        for body in [
            br#"{"tid":0,"currentPid":0,"nextComment":null}"#.as_slice(),
            br#"{"tid":0,"currentPid":0,"auth":null}"#,
            br#"{"currentPid":0}"#,
        ] {
            assert!(Response::decode(200, body).is_err());
        }
        for (status, code, _) in ERRORS.iter().chain(HANDLER_ERRORS) {
            let body = format!(r#"{{"error":"{code}","message":"{code}","status":{status}}}"#);
            assert_eq!(
                Response::decode(*status, body.as_bytes())
                    .unwrap()
                    .bytes()
                    .unwrap(),
                body.as_bytes()
            );
            assert!(Response::decode(404, body.as_bytes()).is_err());
        }
        assert!(Response::decode(
            500,
            br#"{"error":"polis_err_vote","message":"polis_err_vote","status":500}"#
        )
        .is_err());
    }

    #[test]
    fn strict_account_auth_and_production_text_variants() {
        for (status, error, message) in ACCOUNT_ERRORS {
            let mut body = json!({"error":error,"message":message});
            if *status == 429 {
                body["retry_after"] = json!(1);
            }
            assert!(Response::decode(*status, &serde_json::to_vec(&body).unwrap()).is_ok());
            body["unexpected"] = json!(true);
            assert!(Response::decode(*status, &serde_json::to_vec(&body).unwrap()).is_err());
            body.as_object_mut().unwrap().remove("unexpected");
            body["retry_after"] = Value::Null;
            assert!(Response::decode(*status, &serde_json::to_vec(&body).unwrap()).is_err());
        }
        let body = br#"{"error":"Invalid token format","details":"Token does not match any supported JWT type"}"#;
        assert!(Response::decode(401, body).is_ok());
        assert!(Response::decode(403, body).is_err());
        assert!(Response::decode(
            401,
            br#"{"error":"Invalid token format","details":"unexpected"}"#
        )
        .is_err());
        for (status, body) in [
            (400, "Bad Request\n"),
            (500, "Internal Server Error\n"),
            (413, "Payload Too Large\n"),
            (415, "Unsupported Media Type\n"),
            (400, "Please use HTTPS when submitting data."),
        ] {
            assert_eq!(
                Response::decode(status, body.as_bytes())
                    .unwrap()
                    .bytes()
                    .unwrap(),
                body.as_bytes()
            );
            assert!(Response::decode(404, body.as_bytes()).is_err());
        }
    }
}
