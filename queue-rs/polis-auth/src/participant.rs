//! Read-only resolution of Node-issued, conversation-scoped participant tokens.
//! Serving routes hand off unsupported credentials and missing membership.
//! The opt-in foundation also returns typed XID account refusals.
use crate::observability::{Counters, Event, PROCESS};
use crate::{Pid, Uid, Zid};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Anonymous,
    Xid,
    StandardUser,
}
/// No Debug implementation: claims must not become diagnostic output.
#[derive(Clone)]
pub struct Verified {
    uid: Uid,
    pid: Pid,
    pub kind: Kind,
}
impl Verified {
    /// The UID from a verified token; callers still resolve exact membership.
    pub fn uid(&self) -> Uid {
        self.uid
    }
}
/// Verified claims scoped to a request, before admission. No Debug implementation:
/// identity values must not become diagnostic output. This is not membership
/// evidence and cannot be passed to `resolve`.
#[derive(Clone)]
pub struct RequestIdentity {
    uid: Option<Uid>,
    pid: Option<Pid>,
    xid: Option<String>,
    pub kind: Kind,
}
impl RequestIdentity {
    pub fn uid(&self) -> Option<Uid> {
        self.uid
    }
    pub fn pid(&self) -> Option<Pid> {
        self.pid
    }
    pub fn xid(&self) -> Option<&str> {
        self.xid.as_deref()
    }
}

// Match JavaScript String.trim used by ensureParticipant, including the byte
// order mark and excluding the next-line character (which Rust trim removes).
pub(crate) fn request_xid_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

// Missing XID fields are allowed; explicit null is not an absent field. This
// keeps every XID-bearing shape out of the existing serving verifier.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    uid: i32,
    pid: i32,
    conversation_id: String,
    sub: String,
    iss: String,
    aud: String,
    exp: u64,
    iat: u64,
    nbf: Option<u64>,
    anonymous_participant: Option<bool>,
    standard_user_participant: Option<bool>,
    oidc_sub: Option<String>,
    #[serde(default, deserialize_with = "present")]
    xid_participant: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    xid: Option<String>,
}
pub struct Verifier {
    key: DecodingKey,
    validation: Validation,
}
impl Verifier {
    pub fn new(public_pem: &[u8], issuer: &str, audience: &str) -> Option<Self> {
        if public_pem.len() > 65536 || issuer.is_empty() || audience.is_empty() {
            return None;
        }
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&[audience]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        // Caller supplies the clock, including the existing conformance clock.
        // Signature, algorithm, issuer and audience still use the JWT library.
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.leeway = 0;
        Some(Self {
            key: DecodingKey::from_rsa_pem(public_pem).ok()?,
            validation,
        })
    }
    /// Existing serving entry point: XID tokens still hand back to Node.
    pub fn verify(&self, authorization: &str, conversation: &str, now: u64) -> Option<Verified> {
        self.verify_observed(authorization, conversation, now, &PROCESS)
    }

    pub fn verify_observed(
        &self,
        authorization: &str,
        conversation: &str,
        now: u64,
        counters: &Counters,
    ) -> Option<Verified> {
        let result = self.verify_unobserved(authorization, conversation, now);
        if result.is_none() {
            let reason = match crate::observability::credential_hints(authorization) {
                Some(payload) => {
                    crate::observability::credential_handoff(&payload, Some(conversation))
                        .unwrap_or(Event::HandoffParticipantVerification)
                }
                None => Event::HandoffCredentialShape,
            };
            counters.record(reason);
        }
        result
    }

    /// Optional lookup after authentication; failure here is not a hand-back.
    pub fn verify_unobserved(
        &self,
        authorization: &str,
        conversation: &str,
        now: u64,
    ) -> Option<Verified> {
        let (c, kind) = self.verify_claims(authorization, now)?;
        if kind == Kind::Xid || c.conversation_id != conversation {
            return None;
        }
        Some(Verified {
            uid: Uid(c.uid),
            pid: Pid(c.pid as u32),
            kind,
        })
    }

    /// Opt-in identity scoping and XID account check; not used by serving routes. The request's
    /// nonblank XID takes precedence for an XID token and becomes the identity of
    /// an anonymous token presented in another conversation. Crossing conversation
    /// IDs drops an XID token's UID and PID even for conversations of the same owner.
    /// The caller must resolve that XID under the requested conversation's owner
    /// and apply admission gates before using it. Only XID tokens query here; no writes.
    /// Different conversation IDs conservatively require resolution, including
    /// aliases; this function does not resolve IDs to database conversation IDs.
    pub fn verify_for_request(
        &self,
        authorization: &str,
        conversation: &str,
        request_xid: Option<&str>,
        now: u64,
        check: &mut crate::xid_account::Check<'_, impl crate::xid_account::Lookup>,
    ) -> Result<Option<RequestIdentity>, crate::xid_account::Refusal> {
        let Some((c, kind)) = self.verify_claims(authorization, now) else {
            return Ok(None);
        };
        if kind == Kind::Xid {
            // Check the original signed UID even when request scoping drops it.
            check.require_participant(Uid(c.uid))?;
        }
        let same_conversation = c.conversation_id == conversation;
        let request_xid =
            request_xid.filter(|xid| !xid.trim_matches(request_xid_whitespace).is_empty());
        let mut identity = RequestIdentity {
            uid: Some(Uid(c.uid)),
            pid: same_conversation.then_some(Pid(c.pid as u32)),
            xid: None,
            kind,
        };
        match kind {
            Kind::Xid => {
                let Some(xid) = request_xid.or(c.xid.as_deref()) else {
                    return Ok(None);
                };
                if !same_conversation || Some(xid) != c.xid.as_deref() {
                    identity.uid = None;
                    identity.pid = None;
                }
                identity.xid = Some(xid.to_owned());
            }
            Kind::Anonymous if !same_conversation => {
                identity.uid = None;
                identity.xid = request_xid.map(str::to_owned);
            }
            Kind::Anonymous | Kind::StandardUser => {}
        }
        Ok(Some(identity))
    }

    fn verify_claims(&self, authorization: &str, now: u64) -> Option<(Claims, Kind)> {
        let token = authorization.strip_prefix("Bearer ")?;
        if token.is_empty() || token.len() > 16384 {
            return None;
        }
        if decode_header(token).ok()?.alg != Algorithm::RS256 {
            return None;
        }
        let c = decode::<Claims>(token, &self.key, &self.validation)
            .ok()?
            .claims;
        if c.exp <= now
            || c.nbf.is_some_and(|n| n > now)
            || c.iat > now
            || c.uid <= 0
            || c.pid < 0
            || c.iss.is_empty()
            || c.aud.is_empty()
        {
            return None;
        }
        let kind = match (
            c.anonymous_participant,
            c.standard_user_participant,
            c.oidc_sub.as_deref(),
            c.xid_participant,
            c.xid.as_deref(),
        ) {
            (Some(true), None, None, None, None) if c.sub == format!("anon:{}", c.uid) => {
                Kind::Anonymous
            }
            (None, Some(true), Some(sub), None, None)
                if !sub.is_empty() && sub.len() <= 255 && c.sub == format!("user:{sub}") =>
            {
                Kind::StandardUser
            }
            (None, None, None, Some(true), Some(xid))
                if !xid.is_empty() && c.sub == format!("xid:{xid}") =>
            {
                Kind::Xid
            }
            _ => return None,
        };
        Some((c, kind))
    }
}
/// Existing membership only. Caller uses the route's bounded, read-only primary
/// pool. No insert, token mint, XID lookup, alias repair or treevite gate occurs.
pub fn resolve(
    c: &mut impl postgres::GenericClient,
    zid: Zid,
    identity: &Verified,
) -> Result<Option<Pid>, postgres::Error> {
    resolve_observed(c, zid, identity, &PROCESS)
}

pub fn resolve_observed(
    c: &mut impl postgres::GenericClient,
    zid: Zid,
    identity: &Verified,
    counters: &Counters,
) -> Result<Option<Pid>, postgres::Error> {
    let result = resolve_inner(c, zid, identity);
    if matches!(result, Ok(None)) {
        counters.record(Event::HandoffParticipantMembership);
    }
    result
}

fn resolve_inner(
    c: &mut impl postgres::GenericClient,
    zid: Zid,
    identity: &Verified,
) -> Result<Option<Pid>, postgres::Error> {
    let rows = c.query("select p.pid from participants p join conversations c on c.zid=p.zid where p.zid=$1 and p.uid=$2 and c.treevite_enabled is not true", &[&zid.0, &identity.uid.0])?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let pid: i32 = rows[0].try_get(0)?;
    Ok((pid >= 0 && pid as u32 == identity.pid.0).then_some(Pid(pid as u32)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::{Value, json};

    #[test]
    fn verification_counts_one_handoff_per_failed_attempt_and_no_refusal() {
        let (verifier, key) = keys();
        let counters = Counters::new();
        let valid = sign(&claims(), &key);
        assert!(
            verifier
                .verify_observed(&valid, "2fixture", 150, &counters)
                .is_some()
        );
        for raw in ["Bearer broken", "Basic secret", "", &valid] {
            assert!(
                verifier
                    .verify_observed(raw, "other", 150, &counters)
                    .is_none()
            );
        }
        for (label, count) in counters.snapshot() {
            assert_eq!(
                count,
                match label {
                    "handoff_credential_shape" => 3,
                    "handoff_conversation_scope" => 1,
                    _ => 0,
                }
            );
        }
    }
    fn keys() -> (Verifier, EncodingKey) {
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let public = rsa.public_key_to_pem().unwrap();
        let private = rsa.private_key_to_pem().unwrap();
        (
            Verifier::new(&public, "issuer", "audience").unwrap(),
            EncodingKey::from_rsa_pem(&private).unwrap(),
        )
    }
    fn claims() -> Value {
        json!({"uid":3,"pid":0,"conversation_id":"2fixture","sub":"anon:3","iss":"issuer","aud":"audience","exp":200,"iat":100,"anonymous_participant":true})
    }
    fn sign(v: &Value, key: &EncodingKey) -> String {
        format!(
            "Bearer {}",
            encode(&Header::new(Algorithm::RS256), v, key).unwrap()
        )
    }
    #[test]
    fn node_shapes_verify_without_trusting_unverified_identity() {
        let (v, k) = keys();
        let a = v.verify(&sign(&claims(), &k), "2fixture", 150).unwrap();
        assert_eq!(a.pid, Pid(0));
        assert_eq!(a.uid(), Uid(3));
        assert_eq!(a.kind, Kind::Anonymous);
        let mut standard = claims();
        standard
            .as_object_mut()
            .unwrap()
            .remove("anonymous_participant");
        standard["standard_user_participant"] = json!(true);
        standard["oidc_sub"] = json!("issuer|fixture");
        standard["sub"] = json!("user:issuer|fixture");
        assert_eq!(
            v.verify(&sign(&standard, &k), "2fixture", 150)
                .unwrap()
                .kind,
            Kind::StandardUser
        );
        assert!(v.verify(&sign(&claims(), &k), "2another", 150).is_none());
        assert!(v.verify(&sign(&claims(), &k), "2fixture", 200).is_none());
        let (_, other) = keys();
        assert!(
            v.verify(&sign(&claims(), &other), "2fixture", 150)
                .is_none()
        );
        let hs = encode(
            &Header::new(Algorithm::HS256),
            &claims(),
            &EncodingKey::from_secret(b"fixture-only"),
        )
        .unwrap();
        assert!(v.verify(&format!("Bearer {hs}"), "2fixture", 150).is_none());
    }
    #[test]
    fn xid_mixed_missing_and_invalid_claims_hand_back_to_node() {
        let (v, k) = keys();
        for (field, value) in [
            ("xid", json!("fixture-xid")),
            ("xid_participant", json!(true)),
            ("uid", json!(0)),
            ("pid", json!(-1)),
            ("pid", json!(0.5)),
            ("iss", json!("other")),
            ("aud", json!("other")),
            ("sub", json!("anon:4")),
            ("nbf", json!(151)),
            ("iat", json!(151)),
            ("anonymous_participant", json!(false)),
            ("standard_user_participant", json!(true)),
            ("oidc_sub", json!("inconsistent")),
        ] {
            let mut c = claims();
            c[field] = value;
            assert!(
                v.verify(&sign(&c, &k), "2fixture", 150).is_none(),
                "{field}"
            );
        }
        for field in [
            "exp",
            "iat",
            "uid",
            "pid",
            "iss",
            "aud",
            "sub",
            "conversation_id",
            "anonymous_participant",
        ] {
            let mut c = claims();
            c.as_object_mut().unwrap().remove(field);
            assert!(
                v.verify(&sign(&c, &k), "2fixture", 150).is_none(),
                "{field}"
            );
        }
        let valid = sign(&claims(), &k);
        for scheme in ["bearer", "BEARER", "bEaReR"] {
            let raw = valid.replacen("Bearer", scheme, 1);
            assert!(v.verify(&raw, "2fixture", 150).is_none(), "{scheme}");
        }
        for raw in ["", "Bearer bad", "Basic abc"] {
            assert!(v.verify(raw, "2fixture", 150).is_none());
        }
    }
    fn xid_claims() -> Value {
        let mut c = claims();
        c.as_object_mut().unwrap().remove("anonymous_participant");
        c["xid_participant"] = json!(true);
        c["xid"] = json!("fixture-xid");
        c["sub"] = json!("xid:fixture-xid");
        c
    }

    #[test]
    fn only_verified_xid_claims_query_account_privileges() {
        let (verifier, key) = keys();
        let (_, wrong_key) = keys();
        let mut unexpected =
            |_| -> Result<Option<crate::xid_account::Account>, crate::Unavailable> {
                panic!("non-XID or invalid credentials must not query account privileges")
            };
        let mut check = crate::xid_account::Check {
            db: &mut unexpected,
            admin_uids: &[],
        };
        assert!(
            verifier
                .verify_for_request(&sign(&claims(), &key), "2fixture", None, 150, &mut check)
                .unwrap()
                .is_some()
        );
        assert!(
            verifier
                .verify_for_request(
                    &sign(&xid_claims(), &wrong_key),
                    "2fixture",
                    None,
                    150,
                    &mut check
                )
                .unwrap()
                .is_none()
        );
        assert!(
            verifier
                .verify_for_request(
                    &sign(&xid_claims(), &key),
                    "2fixture",
                    None,
                    200,
                    &mut check
                )
                .unwrap()
                .is_none()
        );
        let mut unavailable = |_| Err(crate::Unavailable);
        let mut check = crate::xid_account::Check {
            db: &mut unavailable,
            admin_uids: &[],
        };
        assert!(matches!(
            verifier.verify_for_request(
                &sign(&xid_claims(), &key),
                "2fixture",
                None,
                150,
                &mut check
            ),
            Err(crate::xid_account::Refusal::CheckFailed)
        ));
    }

    #[test]
    fn xid_request_precedence_and_conversation_scope_table() {
        #[derive(Deserialize)]
        struct Case {
            name: String,
            conversation: String,
            request_xid: Option<String>,
            uid: Option<i32>,
            pid: Option<u32>,
            xid: String,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/xid-request-identity.json"))
                .unwrap();
        let (v, k) = keys();
        let token = sign(&xid_claims(), &k);
        for case in cases {
            let identity = v
                .verify_for_request(
                    &token,
                    &case.conversation,
                    case.request_xid.as_deref(),
                    150,
                    &mut crate::xid_account::Check {
                        db: &mut |_| Ok(None),
                        admin_uids: &[],
                    },
                )
                .unwrap()
                .unwrap();
            assert_eq!(identity.kind, Kind::Xid, "{}", case.name);
            assert_eq!(identity.uid(), case.uid.map(Uid), "{}", case.name);
            assert_eq!(identity.pid(), case.pid.map(Pid), "{}", case.name);
            assert_eq!(identity.xid(), Some(case.xid.as_str()), "{}", case.name);
            // Adding the kind does not admit any new serving request class.
            assert!(v.verify(&token, &case.conversation, 150).is_none());
        }
    }

    #[test]
    fn xid_claims_must_be_complete_consistent_and_exclusive() {
        let (v, k) = keys();
        for (field, value) in [
            ("xid", json!("")),
            ("xid", json!(null)),
            ("xid", json!(7)),
            ("xid", json!("other")),
            ("xid_participant", json!(false)),
            ("xid_participant", json!(null)),
            ("xid_participant", json!("true")),
            ("sub", json!("xid:other")),
            ("sub", json!("anon:3")),
            ("anonymous_participant", json!(true)),
            ("anonymous_participant", json!(false)),
            ("standard_user_participant", json!(true)),
            ("oidc_sub", json!("issuer|fixture")),
            ("uid", json!(0)),
            ("pid", json!(-1)),
            ("exp", json!(150)),
            ("nbf", json!(151)),
            ("iat", json!(151)),
            ("iss", json!("other")),
            ("aud", json!("other")),
            ("unknown", json!(true)),
        ] {
            let mut c = xid_claims();
            c[field] = value;
            assert!(
                v.verify_for_request(
                    &sign(&c, &k),
                    "2fixture",
                    None,
                    150,
                    &mut crate::xid_account::Check {
                        db: &mut |_| Ok(None),
                        admin_uids: &[]
                    }
                )
                .unwrap()
                .is_none(),
                "{field}"
            );
        }
        for field in [
            "xid",
            "xid_participant",
            "sub",
            "uid",
            "pid",
            "conversation_id",
            "exp",
            "iat",
            "iss",
            "aud",
        ] {
            let mut c = xid_claims();
            c.as_object_mut().unwrap().remove(field);
            assert!(
                v.verify_for_request(
                    &sign(&c, &k),
                    "2fixture",
                    None,
                    150,
                    &mut crate::xid_account::Check {
                        db: &mut |_| Ok(None),
                        admin_uids: &[]
                    }
                )
                .unwrap()
                .is_none(),
                "{field}"
            );
        }
        // These fields used to be unknown, even when null. Keep the old entry
        // point closed to them on anonymous and standard-user token shapes.
        for field in ["xid", "xid_participant"] {
            let mut c = claims();
            c[field] = json!(null);
            assert!(v.verify(&sign(&c, &k), "2fixture", 150).is_none());
        }
    }

    #[test]
    fn xid_request_identity_requires_a_valid_signature_algorithm_and_clock() {
        let (v, k) = keys();
        let (_, other) = keys();
        let c = xid_claims();
        assert!(
            v.verify_for_request(
                &sign(&c, &other),
                "2fixture",
                None,
                150,
                &mut crate::xid_account::Check {
                    db: &mut |_| Ok(None),
                    admin_uids: &[]
                }
            )
            .unwrap()
            .is_none()
        );
        let hs = encode(
            &Header::new(Algorithm::HS256),
            &c,
            &EncodingKey::from_secret(b"test-only"),
        )
        .unwrap();
        assert!(
            v.verify_for_request(
                &format!("Bearer {hs}"),
                "2fixture",
                None,
                150,
                &mut crate::xid_account::Check {
                    db: &mut |_| Ok(None),
                    admin_uids: &[]
                }
            )
            .unwrap()
            .is_none()
        );
        let signed = sign(&c, &k);
        assert!(
            v.verify_for_request(
                &signed,
                "2fixture",
                None,
                199,
                &mut crate::xid_account::Check {
                    db: &mut |_| Ok(None),
                    admin_uids: &[]
                }
            )
            .unwrap()
            .is_some()
        );
        assert!(
            v.verify_for_request(
                &signed,
                "2fixture",
                None,
                200,
                &mut crate::xid_account::Check {
                    db: &mut |_| Ok(None),
                    admin_uids: &[]
                }
            )
            .unwrap()
            .is_none()
        );
        for raw in [
            "".to_owned(),
            "Bearer bad".to_owned(),
            signed.replacen("Bearer", "bearer", 1),
        ] {
            assert!(
                v.verify_for_request(
                    &raw,
                    "2fixture",
                    None,
                    150,
                    &mut crate::xid_account::Check {
                        db: &mut |_| Ok(None),
                        admin_uids: &[]
                    }
                )
                .unwrap()
                .is_none()
            );
        }
    }

    #[test]
    fn anonymous_token_in_another_conversation_uses_request_xid() {
        let (v, k) = keys();
        let token = sign(&claims(), &k);
        let identity = v
            .verify_for_request(
                &token,
                "2another",
                Some("request-xid"),
                150,
                &mut crate::xid_account::Check {
                    db: &mut |_| Ok(None),
                    admin_uids: &[],
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(identity.kind, Kind::Anonymous);
        assert_eq!(identity.uid(), None);
        assert_eq!(identity.pid(), None);
        assert_eq!(identity.xid(), Some("request-xid"));
    }

    #[test]
    fn request_xid_does_not_replace_other_token_kinds_in_their_conversation() {
        let (v, k) = keys();
        let mut standard = claims();
        standard
            .as_object_mut()
            .unwrap()
            .remove("anonymous_participant");
        standard["standard_user_participant"] = json!(true);
        standard["oidc_sub"] = json!("issuer|fixture");
        standard["sub"] = json!("user:issuer|fixture");
        for (c, kind, cross_uid) in [
            (claims(), Kind::Anonymous, None),
            (standard, Kind::StandardUser, Some(Uid(3))),
        ] {
            let token = sign(&c, &k);
            for request_xid in [None, Some(""), Some("other-xid")] {
                let identity = v
                    .verify_for_request(
                        &token,
                        "2fixture",
                        request_xid,
                        150,
                        &mut crate::xid_account::Check {
                            db: &mut |_| Ok(None),
                            admin_uids: &[],
                        },
                    )
                    .unwrap()
                    .unwrap();
                assert_eq!(identity.kind, kind);
                assert_eq!(identity.uid(), Some(Uid(3)));
                assert_eq!(identity.pid(), Some(Pid(0)));
                assert_eq!(identity.xid(), None);
            }
            let identity = v
                .verify_for_request(
                    &token,
                    "2another",
                    None,
                    150,
                    &mut crate::xid_account::Check {
                        db: &mut |_| Ok(None),
                        admin_uids: &[],
                    },
                )
                .unwrap()
                .unwrap();
            assert_eq!(identity.uid(), cross_uid);
            assert_eq!(identity.pid(), None);
            assert_eq!(identity.xid(), None);
            assert!(v.verify(&token, "2another", 150).is_none());
        }
    }

    #[test]
    #[cfg(feature = "db-tests")]
    fn membership_is_existing_exact_and_read_only() {
        let url = std::env::var("POLIS_AUTH_TEST_DATABASE_URL").unwrap();
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let schema = format!("participant_read_{}", std::process::id());
        c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema}; CREATE TABLE conversations(zid integer, treevite_enabled boolean); CREATE TABLE participants(zid integer,uid integer,pid integer); INSERT INTO conversations VALUES (1,false),(2,true),(3,false); INSERT INTO participants VALUES (1,3,0),(2,3,0),(3,3,1); SET default_transaction_read_only=on;")).unwrap();
        let (v, k) = keys();
        let a = v.verify(&sign(&claims(), &k), "2fixture", 150).unwrap();
        let counters = Counters::new();
        assert_eq!(
            resolve_observed(&mut c, Zid(1), &a, &counters).unwrap(),
            Some(Pid(0))
        );
        for zid in [2, 3, 4] {
            assert_eq!(
                resolve_observed(&mut c, Zid(zid), &a, &counters).unwrap(),
                None
            );
        }
        for (label, count) in counters.snapshot() {
            assert_eq!(
                count,
                if label == Event::HandoffParticipantMembership.label() {
                    3
                } else {
                    0
                }
            );
        }
        assert!(
            c.execute("INSERT INTO participants VALUES (1,4,1)", &[])
                .is_err()
        );
        c.batch_execute("SET default_transaction_read_only=off")
            .unwrap();
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    }
}
