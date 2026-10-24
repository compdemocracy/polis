//! GET vote contracts at 4f50b6f28f30160a9d8a0ca3f3024ef3c03b6ec2.
//! Registration/auth/parameters: server/app.ts:868-892. Latest rows:
//! server/src/routes/votes.ts:132-172,204-211. History: :175-202.
//! Both call storageRowToWire (:168,:197), preserving null/invalid integers;
//! wire signs belong to votes.rs, independently of storage and CSV exports.
//! finishArray removes zid and appends conversation_id (server-helpers.ts:174-192,241-272).
//! Neither handler sorts or paginates. /me additionally appends weight:null:
//! the selected table has weight_x_32767, so undefined / 32767 is NaN.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/api/v3/votes";
pub const ME_PATH: &str = "/api/v3/votes/me";
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub conversation_id: String,
    pub pid: Option<i32>,
    pub tid: Option<i32>,
    pub mine: bool,
}
/// Includes null and legacy invalid integers, which Node preserves verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WireVote(pub Option<i16>);
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LatestVote {
    pub pid: i32,
    pub tid: i32,
    pub vote: WireVote,
    pub weight_x_32767: Option<i16>,
    /// pg's default int8 parser returns decimal text, including unsafe integers.
    pub modified: Option<String>,
    pub conversation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryVote {
    pub pid: i32,
    pub tid: i32,
    pub vote: WireVote,
    pub weight_x_32767: Option<i16>,
    pub created: Option<String>,
    pub high_priority: bool,
    pub weight: (),
    pub conversation_id: String,
}
pub type LatestResponse = Vec<LatestVote>;
pub type HistoryResponse = Vec<HistoryVote>;
/// failJson: utils/fail.ts:12-24. Route error names are listed below.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub error: String,
    pub message: String,
    pub status: u16,
}
/// hybrid-jwt.ts:86-88,223-226,237-240 (details absent for missing auth).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthFailure {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}
/// jwt-middleware.ts:106-164; existing-user resolution can also create users in
/// Node. Rust never takes those branches. Debug details are dev-mode only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserFailure {
    pub error: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}
/// All response families of the Node listener, not a claim of Rust admission.
/// The listener can reject framing/parser/HTTPS policy before either handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Latest(LatestResponse),
    History(HistoryResponse),
    Failure(Failure),
    Auth(AuthFailure),
    User(UserFailure),
    /// 302 HTTPS redirect; 400/413/415 production finalhandler HTML;
    /// 500 unhandled errors. Preserve bytes (dev mode may include a stack).
    Listener {
        status: u16,
        body: Vec<u8>,
    },
    /// HEAD and conditional GET/HEAD (304) have no body.
    Empty {
        status: u16,
    },
}
pub const ROUTE_ERRORS: &[&str] = &[
    "polis_err_getting_pid",
    "polis_err_get_votes_by_me",
    "polis_err_votes_get",
    "polis_err_mypid_resolve_error",
    "polis_err_this_middleware_should_be_after_auth_and_zid",
    "polis_err_finishing_response2A",
    "polis_err_finishing_response2",
    "polis_err_misc",
];
impl Response {
    pub fn decode(
        mine: bool,
        head: bool,
        status: u16,
        content_type: &str,
        body: &[u8],
    ) -> Result<Self, String> {
        if (head || status == 304) && body.is_empty() {
            return Ok(Self::Empty { status });
        }
        let parse = |e: serde_json::Error| e.to_string();
        if status == 200 {
            return if mine {
                serde_json::from_slice(body)
                    .map(Self::History)
                    .map_err(parse)
            } else {
                serde_json::from_slice(body)
                    .map(Self::Latest)
                    .map_err(parse)
            };
        }
        if !content_type.starts_with("application/json")
            && [302, 400, 413, 415, 500].contains(&status)
        {
            return Ok(Self::Listener {
                status,
                body: body.to_vec(),
            });
        }
        if status == 401 {
            return serde_json::from_slice(body).map(Self::Auth).map_err(parse);
        }
        match serde_json::from_slice::<Failure>(body) {
            Ok(f)
                if [400, 500].contains(&status)
                    && f.status == status
                    && f.error == f.message
                    && ROUTE_ERRORS.contains(&f.error.as_str()) =>
            {
                return Ok(Self::Failure(f))
            }
            _ => (),
        }
        if [400, 429, 500].contains(&status) {
            let f: UserFailure = serde_json::from_slice(body).map_err(parse)?;
            if matches!(
                (status, f.error.as_str()),
                (400, "invalid_user_data")
                    | (429, "too_many_requests" | "authentication_conflict")
                    | (500, "user_creation_failed" | "authentication_error")
            ) {
                return Ok(Self::User(f));
            }
        }
        Err("uncovered response".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_node_recordings_decode_and_successes_roundtrip() {
        #[derive(Deserialize)]
        struct Case {
            id: String,
            mine: bool,
            head: bool,
            status: u16,
            content_type: String,
            body: String,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("fixtures/votes-read.json")).unwrap();
        for c in cases {
            let response =
                Response::decode(c.mine, c.head, c.status, &c.content_type, c.body.as_bytes())
                    .unwrap_or_else(|e| panic!("{}: {e}", c.id));
            let encoded = match response {
                Response::Latest(rows) => Some(serde_json::to_string(&rows).unwrap()),
                Response::History(rows) => Some(serde_json::to_string(&rows).unwrap()),
                _ => None,
            };
            if let Some(encoded) = encoded {
                assert_eq!(encoded, c.body, "{}", c.id);
            }
        }
    }
    #[test]
    fn latest_codec_preserves_null_and_bigint_text() {
        for raw in [
            None,
            Some(i16::from(crate::votes::WIRE_AGREE)),
            Some(i16::from(crate::votes::WIRE_DISAGREE)),
            Some(i16::from(crate::votes::WIRE_PASS)),
            Some(7),
        ] {
            let row = LatestVote {
                pid: 0,
                tid: 2,
                vote: WireVote(raw),
                weight_x_32767: None,
                modified: Some("9223372036854775807".into()),
                conversation_id: "fixture".into(),
            };
            let body = serde_json::to_vec(&vec![row.clone()]).unwrap();
            assert_eq!(
                Response::decode(false, false, 200, "application/json", &body).unwrap(),
                Response::Latest(vec![row])
            );
        }
    }
    #[test]
    fn history_codec_keeps_null_weight_and_all_events() {
        let row = HistoryVote {
            pid: 0,
            tid: 2,
            vote: WireVote(None),
            weight_x_32767: Some(12),
            created: None,
            high_priority: false,
            weight: (),
            conversation_id: "fixture".into(),
        };
        let body = serde_json::to_vec(&vec![row.clone(), row.clone()]).unwrap();
        assert!(String::from_utf8(body.clone())
            .unwrap()
            .contains("\"weight\":null"));
        assert_eq!(
            Response::decode(true, false, 200, "application/json", &body).unwrap(),
            Response::History(vec![row.clone(), row])
        );
        assert!(Response::decode(false, false, 200, "application/json", &body).is_err());
    }
    #[test]
    fn error_and_listener_families_remain_distinct() {
        for error in ROUTE_ERRORS {
            let status = if *error == "polis_err_misc" { 400 } else { 500 };
            let row = Failure {
                error: (*error).into(),
                message: (*error).into(),
                status,
            };
            assert_eq!(
                Response::decode(
                    false,
                    false,
                    status,
                    "application/json",
                    &serde_json::to_vec(&row).unwrap()
                )
                .unwrap(),
                Response::Failure(row)
            );
        }
        for details in [None, Some("jwt expired".into())] {
            let row = AuthFailure {
                error: "Invalid authentication token".into(),
                details,
            };
            assert_eq!(
                Response::decode(
                    true,
                    false,
                    401,
                    "application/json",
                    &serde_json::to_vec(&row).unwrap()
                )
                .unwrap(),
                Response::Auth(row)
            );
        }
        for (status, error) in [
            (400, "invalid_user_data"),
            (429, "too_many_requests"),
            (429, "authentication_conflict"),
            (500, "user_creation_failed"),
            (500, "authentication_error"),
        ] {
            let row = UserFailure {
                error: error.into(),
                message: "fixture".into(),
                retry_after: if status == 429 { Some(1) } else { None },
                details: None,
            };
            assert_eq!(
                Response::decode(
                    true,
                    false,
                    status,
                    "application/json",
                    &serde_json::to_vec(&row).unwrap()
                )
                .unwrap(),
                Response::User(row)
            );
        }
        for status in [302, 400, 413, 415, 500] {
            assert!(matches!(
                Response::decode(false, false, status, "text/html", b"<html>fixture</html>"),
                Ok(Response::Listener { .. })
            ));
        }
        assert_eq!(
            Response::decode(false, false, 304, "", b"").unwrap(),
            Response::Empty { status: 304 }
        );
        assert!(Response::decode(false, false, 200, "application/json", b"{}").is_err());
        assert!(Response::decode(false, false, 502, "text/plain", b"handoff").is_err());
    }
}
