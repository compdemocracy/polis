//! `GET /api/v3/votes/famous`: the featured participants of a conversation,
//! as the legacy participation client draws them on its picture.
//!
//! Node: registration and parameters `server/app.ts` (`hybridAuthOptional`,
//! `need("conversation_id")`, `want("math_tick", getInt, …)` with minus
//! one as its default (`LATEST_TICK` below),
//! `want("ptptoiLimit", getIntInRange(0, 99))`); the handler is
//! `handle_GET_votes_famous` (`server/src/routes/votes.ts`), which answers
//! with `doFamousQuery` (`server/src/server-helpers.ts`): the rows of
//! `getSocialParticipants` (`server/src/participant.ts`) through
//! `pullXInfoIntoSubObjects`, keyed by participant number.
//!
//! The reply is one JSON object. Its keys are participant numbers, which a
//! JavaScript object lists in ascending order. Each value keeps the key order
//! Node builds: the row's columns, then `xInfo`, `isSelf`, the choices and
//! `bid`.

use serde::{
    de::{self, MapAccess, Visitor},
    ser::SerializeMap,
    Deserialize, Deserializer, Serialize, Serializer,
};

pub const PATH: &str = "/api/v3/votes/famous";

/// `ptptoiLimit` when the request does not carry one.
pub const DEFAULT_LIMIT: i32 = 30;
/// `getIntInRange(0, 99)`.
pub const MAX_LIMIT: i32 = 99;
/// The priority `getSocialParticipants` gives the requester's own row; it is
/// the row `doFamousQuery` marks `isSelf`.
pub const SELF_PRIORITY: i32 = 1000;
/// `failJson(res, 500, ...)` in the handler.
pub const ROUTE_ERROR: &str = "polis_err_famous_proj_get";

/// `math_tick` when the request does not carry one: the latest math.
pub const LATEST_TICK: i64 = -1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub conversation_id: String,
    pub math_tick: i64,
    pub limit: i32,
}

/// One letter for each comment number from 0 to the greatest one read with
/// this participant: (a)gree, (d)isagree, (p)ass, (u)nseen.
pub const AGREE: char = 'a';
pub const DISAGREE: char = 'd';
pub const PASS: char = 'p';
pub const UNSEEN: char = 'u';

/// The letter of a choice. No stored choice, and a stored value that is no
/// choice, leave the letter that was there.
pub fn letter(choice: crate::votes::VoteChoice) -> char {
    match choice {
        crate::votes::VoteChoice::Agree => AGREE,
        crate::votes::VoteChoice::Disagree => DISAGREE,
        crate::votes::VoteChoice::Pass => PASS,
    }
}

/// What `pullXInfoIntoSubObjects` keeps of an external id: the picture and
/// the name. The id itself and the address are deleted from the row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct XInfo {
    pub x_profile_image_url: Option<String>,
    pub x_name: Option<String>,
}

/// A row whose picture, id and address are all empty or absent keeps its four
/// columns as they were read, nulls included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flat {
    pub x_profile_image_url: Option<String>,
    pub xid: Option<String>,
    pub x_name: Option<String>,
    pub x_email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    pub priority: i32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub x_profile_image_url: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub xid: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub x_name: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub x_email: Option<Option<String>>,
    pub pid: i32,
    #[serde(rename = "xInfo", default, skip_serializing_if = "Option::is_none")]
    pub x_info: Option<XInfo>,
    /// Only ever `true`: the key is absent on every other row.
    #[serde(rename = "isSelf", default, skip_serializing_if = "Option::is_none")]
    pub is_self: Option<bool>,
    #[serde(rename = "votes", default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<String>,
    /// The base cluster the math placed the participant in. Absent for the
    /// requester's own row when the math has not placed them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bid: Option<i32>,
}

/// A key that is present, whatever its value: `null` is `Some(None)`.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

impl Participant {
    /// A row of `getSocialParticipants` after `pullXInfoIntoSubObjects` and
    /// the `isSelf` mark, before the choices and the cluster are joined.
    pub fn from_row(priority: i32, pid: i32, social: Flat) -> Self {
        let truthy = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
        let nested =
            truthy(&social.x_profile_image_url) || truthy(&social.xid) || truthy(&social.x_email);
        let is_self = (priority == SELF_PRIORITY).then_some(true);
        if nested {
            Self {
                priority,
                x_profile_image_url: None,
                xid: None,
                x_name: None,
                x_email: None,
                pid,
                x_info: Some(XInfo {
                    x_profile_image_url: social.x_profile_image_url,
                    x_name: social.x_name,
                }),
                is_self,
                choices: None,
                bid: None,
            }
        } else {
            Self {
                priority,
                x_profile_image_url: Some(social.x_profile_image_url),
                xid: Some(social.xid),
                x_name: Some(social.x_name),
                x_email: Some(social.x_email),
                pid,
                x_info: None,
                is_self,
                choices: None,
                bid: None,
            }
        }
    }
}

/// The reply: participants in ascending order of their number, which is the
/// order of the keys of the JavaScript object Node serializes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Response(pub Vec<Participant>);

impl Serialize for Response {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for participant in &self.0 {
            map.serialize_entry(&participant.pid.to_string(), participant)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Response {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;
        impl<'de> Visitor<'de> for Entries {
            type Value = Response;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object of participants keyed by their number")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Response, A::Error> {
                let mut out: Vec<Participant> = Vec::new();
                while let Some((key, participant)) = map.next_entry::<String, Participant>()? {
                    if key != participant.pid.to_string() {
                        return Err(de::Error::custom("a key that is not its row's pid"));
                    }
                    if participant.pid < 0 || out.last().is_some_and(|p| p.pid >= participant.pid) {
                        return Err(de::Error::custom("keys out of ascending order"));
                    }
                    out.push(participant);
                }
                Ok(Response(out))
            }
        }
        deserializer.deserialize_map(Entries)
    }
}

/// `failJson` (`server/src/utils/fail.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub error: String,
    pub message: String,
    pub status: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Recorded {
        id: String,
        method: String,
        status: u16,
        body: Option<String>,
    }

    fn recorded() -> Vec<Recorded> {
        serde_json::from_str(include_str!("fixtures/votes-famous.json")).unwrap()
    }

    /// Every reply the unchanged Node server gave with status 200 reads as
    /// this contract and is written back byte for byte.
    #[test]
    fn recorded_node_replies_round_trip_byte_for_byte() {
        let mut replies = 0;
        let mut seen = std::collections::BTreeSet::new();
        for r in recorded() {
            let Some(body) = r.body.filter(|_| r.status == 200 && r.method == "GET") else {
                continue;
            };
            let response: Response =
                serde_json::from_str(&body).unwrap_or_else(|e| panic!("{}: {e}", r.id));
            assert_eq!(serde_json::to_string(&response).unwrap(), body, "{}", r.id);
            replies += 1;
            for p in &response.0 {
                // A row is nested or flat, never both and never neither.
                assert_ne!(p.x_info.is_some(), p.xid.is_some(), "{}", r.id);
                assert_eq!(p.xid.is_some(), p.x_profile_image_url.is_some());
                assert_eq!(p.xid.is_some(), p.x_name.is_some());
                assert_eq!(p.xid.is_some(), p.x_email.is_some());
                assert_eq!(p.is_self, (p.priority == SELF_PRIORITY).then_some(true));
                if let Some(choices) = &p.choices {
                    assert!(!choices.is_empty());
                    assert!(choices
                        .chars()
                        .all(|c| [AGREE, DISAGREE, PASS, UNSEEN].contains(&c)));
                }
                // A participant the math has not placed stays only as the
                // requester's own row.
                assert!(p.bid.is_some() || p.is_self == Some(true), "{}", r.id);
                for (shape, found) in [
                    ("nested", p.x_info.is_some()),
                    ("flat nulls", p.xid == Some(None)),
                    ("flat strings", p.xid.as_ref().is_some_and(Option::is_some)),
                    ("self", p.is_self.is_some()),
                    ("unplaced self", p.bid.is_none()),
                    (
                        "nested without a name",
                        p.x_info.as_ref().is_some_and(|x| x.x_name.is_none()),
                    ),
                    (
                        "nested with an empty picture",
                        p.x_info
                            .as_ref()
                            .is_some_and(|x| x.x_profile_image_url.as_deref() == Some("")),
                    ),
                    ("moderator's pin", p.priority == 999),
                    ("featured author", p.priority == 900),
                    ("external id", p.priority == 100),
                ] {
                    if found {
                        seen.insert(shape);
                    }
                }
            }
        }
        assert!(replies >= 100, "{replies} replies");
        assert_eq!(seen.len(), 10, "{seen:?}");
    }

    #[test]
    fn recorded_failures_are_the_route_error() {
        let failures: Vec<_> = recorded().into_iter().filter(|r| r.status == 500).collect();
        assert!(!failures.is_empty());
        for r in failures {
            let failure: Failure = serde_json::from_str(r.body.as_deref().unwrap()).unwrap();
            assert_eq!(
                failure,
                Failure {
                    error: ROUTE_ERROR.into(),
                    message: ROUTE_ERROR.into(),
                    status: 500
                }
            );
        }
    }

    #[test]
    fn rows_nest_when_a_picture_an_id_or_an_address_is_present() {
        let some = |s: &str| Some(s.to_string());
        let flat =
            |url: Option<&str>, xid: Option<&str>, name: Option<&str>, email: Option<&str>| Flat {
                x_profile_image_url: url.map(str::to_string),
                xid: xid.map(str::to_string),
                x_name: name.map(str::to_string),
                x_email: email.map(str::to_string),
            };
        // Nested by the picture, by the id, by the address alone.
        for social in [
            flat(
                Some("https://example.invalid/p.png"),
                Some(""),
                Some("N"),
                None,
            ),
            flat(Some(""), Some("id"), Some("N"), None),
            flat(Some(""), Some(""), Some("N"), Some("n@example.invalid")),
        ] {
            let p = Participant::from_row(100, 7, social.clone());
            assert_eq!(
                p.x_info,
                Some(XInfo {
                    x_profile_image_url: social.x_profile_image_url,
                    x_name: some("N")
                })
            );
            let text = serde_json::to_string(&p).unwrap();
            assert!(!text.contains("xid") && !text.contains("x_email"), "{text}");
        }
        // Flat: the four columns stay, in the row's order, the name included.
        let p = Participant::from_row(SELF_PRIORITY, 3, flat(Some(""), Some(""), Some("N"), None));
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"priority":1000,"x_profile_image_url":"","xid":"","x_name":"N","x_email":null,"pid":3,"isSelf":true}"#
        );
        let p = Participant::from_row(900, 0, flat(None, None, None, None));
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"priority":900,"x_profile_image_url":null,"xid":null,"x_name":null,"x_email":null,"pid":0}"#
        );
    }

    #[test]
    fn a_reply_is_keyed_by_ascending_participant_number() {
        let body = r#"{"2":{"priority":100,"pid":2,"xInfo":{"x_profile_image_url":"u","x_name":null},"votes":"a","bid":11},"10":{"priority":1000,"x_profile_image_url":null,"xid":null,"x_name":null,"x_email":null,"pid":10,"isSelf":true,"votes":"apd"}}"#;
        let response: Response = serde_json::from_str(body).unwrap();
        assert_eq!(serde_json::to_string(&response).unwrap(), body);
        for wrong in [
            r#"{"3":{"priority":100,"pid":2,"xInfo":{"x_profile_image_url":"u","x_name":null}}}"#,
            r#"{"10":{"priority":100,"pid":10,"xInfo":{"x_profile_image_url":"u","x_name":null}},"2":{"priority":100,"pid":2,"xInfo":{"x_profile_image_url":"u","x_name":null}}}"#,
            r#"{"2":{"priority":100,"pid":2,"unknown":1}}"#,
        ] {
            assert!(serde_json::from_str::<Response>(wrong).is_err(), "{wrong}");
        }
        assert_eq!(serde_json::to_string(&Response::default()).unwrap(), "{}");
    }
}
