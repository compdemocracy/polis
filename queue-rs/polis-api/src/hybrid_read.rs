//! Narrow legacy hybrid-auth admission. No user creation or participant writes.
//! Failure means hand the complete request to Node, never anonymous downgrade.
use crate::{db, owner};
use anyhow::{Context, Result};
use polis_auth::observability::{Counters, Event, PROCESS, credential_handoff, credential_hints};
use serde_json::Value;
use std::sync::Arc;

pub struct Oidc {
    verifier: owner::Verifier,
    namespace: String,
}
impl Oidc {
    pub fn from_env() -> Result<Option<Arc<Self>>> {
        let Some(path) = std::env::var("POLIS_API_READ_JWKS_FILE")
            .ok()
            .filter(|p| !p.is_empty())
        else {
            return Ok(None);
        };
        let bytes = std::fs::read(path).context("read legacy-route JWKS")?;
        anyhow::ensure!(bytes.len() <= 65536, "JWKS exceeds 64 KiB");
        Ok(Some(Arc::new(Self {
            verifier: owner::Verifier::new(
                serde_json::from_slice(&bytes)?,
                &std::env::var("AUTH_ISSUER")?,
                &std::env::var("AUTH_AUDIENCE")?,
            )?,
            namespace: std::env::var("AUTH_NAMESPACE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "null".into()),
        })))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Identity {
    Anonymous,
    User(polis_auth::Uid),
}
impl Identity {
    pub fn uid(self) -> Option<polis_auth::Uid> {
        match self {
            Self::Anonymous => None,
            Self::User(uid) => Some(uid),
        }
    }
}
pub async fn optional(
    raw: Option<&str>,
    participant: Option<&polis_auth::participant::Verifier>,
    oidc: Option<&Oidc>,
    pool: &Arc<db::Pool>,
) -> bool {
    resolve(raw, participant, oidc, pool).await.is_some()
}

pub async fn resolve(
    raw: Option<&str>,
    participant: Option<&polis_auth::participant::Verifier>,
    oidc: Option<&Oidc>,
    pool: &Arc<db::Pool>,
) -> Option<Identity> {
    resolve_scoped(raw, participant, oidc, pool, None).await
}

pub async fn resolve_scoped(
    raw: Option<&str>,
    participant: Option<&polis_auth::participant::Verifier>,
    oidc: Option<&Oidc>,
    pool: &Arc<db::Pool>,
    conversation: Option<&str>,
) -> Option<Identity> {
    resolve_scoped_observed(raw, participant, oidc, pool, conversation, &PROCESS).await
}

async fn resolve_scoped_observed(
    raw: Option<&str>,
    participant: Option<&polis_auth::participant::Verifier>,
    oidc: Option<&Oidc>,
    pool: &Arc<db::Pool>,
    conversation: Option<&str>,
    counters: &'static Counters,
) -> Option<Identity> {
    let Some(raw) = raw else {
        return Some(Identity::Anonymous);
    };
    // Unlike Node's optional-auth path, non-Bearer headers are conservatively
    // handed back. They must never gain signed-in authority in this process.
    let Some(payload) = credential_hints(raw) else {
        return counters.handoff(Event::HandoffCredentialShape);
    };
    if let Some(reason) = credential_handoff(&payload, conversation) {
        return counters.handoff(reason);
    }
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    if payload.get("anonymous_participant").is_some()
        || payload.get("standard_user_participant").is_some()
    {
        let Some(cid) = payload.get("conversation_id").and_then(Value::as_str) else {
            return counters.handoff(Event::HandoffCredentialShape);
        };
        let Some(participant) = participant else {
            return counters.handoff(Event::HandoffVerifierUnavailable);
        };
        let identity = participant.verify_observed(raw, cid, now, counters)?;
        let cid = cid.to_owned();
        return pool
            .with(move |c| {
                let Some(zid) = db::zid_for_conversation_id(c, &cid)? else {
                    return Ok(counters.handoff(Event::HandoffConversationMissing));
                };
                Ok(polis_auth::participant::resolve_observed(
                    c,
                    polis_auth::Zid(zid),
                    &identity,
                    counters,
                )?
                .map(|_| Identity::User(identity.uid())))
            })
            .await
            .unwrap_or_else(|_| counters.handoff(Event::HandoffDatabase));
    }
    let Some(oidc) = oidc else {
        return counters.handoff(Event::HandoffVerifierUnavailable);
    };
    let Ok(sub) = oidc.verifier.subject_at(Some(raw), now) else {
        return counters.handoff(Event::HandoffOidcVerification);
    };
    // Node requires email before looking up even an existing mapping. Refuse
    // non-string/empty shapes here; let Node own its error and creation paths.
    if payload
        .get("email")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return counters.handoff(Event::HandoffOidcProfile);
    }
    let email = payload
        .get("email")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        .or_else(|| payload.get(format!("{}email", oidc.namespace)));
    if !email.and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return counters.handoff(Event::HandoffOidcProfile);
    }
    pool.with(move |c| {
        let rows=c.query("select m.uid from oidc_user_mappings m join users u on u.uid=m.uid where m.oidc_sub=$1", &[&sub])?;
        if rows.len()!=1 { return Ok(counters.handoff(Event::HandoffOidcMapping)); }
        let uid=rows[0].try_get::<_,i32>(0)?;
        Ok(if uid > 0 { Some(Identity::User(polis_auth::Uid(uid))) } else { counters.handoff(Event::HandoffOidcMapping) })
    }).await.unwrap_or_else(|_| counters.handoff(Event::HandoffDatabase))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use openssl::rsa::Rsa;
    use serde_json::json;
    #[tokio::test]
    async fn hybrid_admits_only_verified_existing_identities() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("hybrid_read_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
             CREATE TABLE users(uid integer); CREATE TABLE oidc_user_mappings(uid integer,oidc_sub text);
             CREATE TABLE zinvites(zid integer,zinvite text); CREATE TABLE participants(zid integer,uid integer,pid integer);
             CREATE TABLE conversations(zid integer,treevite_enabled boolean);
             INSERT INTO users VALUES(3); INSERT INTO oidc_user_mappings VALUES(3,'existing');
             INSERT INTO zinvites VALUES(1,'fixture'); INSERT INTO conversations VALUES(1,false);
             INSERT INTO participants VALUES(1,3,0);")).unwrap();
        }).await.unwrap();
        let mut config: postgres::Config = url.parse().unwrap();
        config.options(&format!("-c search_path={schema}"));
        let pool = db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config)),
            crate::contexts::pool_limits(),
        );
        let rsa = Rsa::generate(2048).unwrap();
        let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
        let jwks=serde_json::from_value(json!({"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"fixture","n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),"e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())}]})).unwrap();
        let oidc = Oidc {
            verifier: owner::Verifier::new(jwks, "issuer", "audience").unwrap(),
            namespace: "namespace/".into(),
        };
        let participant = polis_auth::participant::Verifier::new(
            &rsa.public_key_to_pem().unwrap(),
            "participants",
            "participants",
        )
        .unwrap();
        let now = (crate::clock::now_ms() / 1000.0) as u64;
        let claims = json!({"sub":"existing","iss":"issuer","aud":"audience","exp":now+300,"email":"fixture@example.invalid"});
        let sign = |v: &Value| {
            let mut h = Header::new(Algorithm::RS256);
            h.kid = Some("fixture".into());
            format!("Bearer {}", encode(&h, v, &key).unwrap())
        };
        assert!(optional(None, None, None, &pool).await);
        assert_eq!(
            resolve(None, None, None, &pool).await,
            Some(Identity::Anonymous)
        );
        let mut forged_uid = claims.clone();
        forged_uid["uid"] = json!(999);
        assert_eq!(
            resolve(Some(&sign(&forged_uid)), None, Some(&oidc), &pool)
                .await
                .and_then(Identity::uid),
            Some(polis_auth::Uid(3))
        );
        assert!(optional(Some(&sign(&claims)), None, Some(&oidc), &pool).await);
        for (field, value) in [
            ("sub", json!("missing")),
            ("exp", json!(now)),
            ("nbf", json!("0")),
            ("iss", json!("other")),
            ("aud", json!("other")),
            ("email", json!(null)),
            ("email", json!(1)),
            ("xid", json!("x")),
            ("anonymous_participant", json!(true)),
        ] {
            let mut c = claims.clone();
            c[field] = value;
            assert!(
                !optional(Some(&sign(&c)), Some(&participant), Some(&oidc), &pool).await,
                "{field}"
            );
        }
        let mut namespaced = claims.clone();
        namespaced.as_object_mut().unwrap().remove("email");
        namespaced["namespace/email"] = json!("fixture@example.invalid");
        assert!(optional(Some(&sign(&namespaced)), None, Some(&oidc), &pool).await);
        namespaced["email"] = json!(1);
        assert!(!optional(Some(&sign(&namespaced)), None, Some(&oidc), &pool).await);
        let anon = json!({"uid":3,"pid":0,"sub":"anon:3","conversation_id":"fixture","iss":"participants","aud":"participants","exp":now+300,"iat":now,"anonymous_participant":true});
        assert!(optional(Some(&sign(&anon)), Some(&participant), Some(&oidc), &pool).await);
        assert_eq!(
            resolve(Some(&sign(&anon)), Some(&participant), Some(&oidc), &pool)
                .await
                .and_then(Identity::uid),
            Some(polis_auth::Uid(3))
        );
        assert!(
            resolve_scoped(
                Some(&sign(&anon)),
                Some(&participant),
                Some(&oidc),
                &pool,
                Some("fixture")
            )
            .await
            .is_some()
        );
        assert!(
            resolve_scoped(
                Some(&sign(&anon)),
                Some(&participant),
                Some(&oidc),
                &pool,
                Some("other")
            )
            .await
            .is_none()
        );
        let mut standard = anon.clone();
        standard
            .as_object_mut()
            .unwrap()
            .remove("anonymous_participant");
        standard["standard_user_participant"] = json!(true);
        standard["oidc_sub"] = json!("existing");
        standard["sub"] = json!("user:existing");
        assert!(
            optional(
                Some(&sign(&standard)),
                Some(&participant),
                Some(&oidc),
                &pool
            )
            .await
        );
        for (field, value) in [
            ("uid", json!(999)),
            ("pid", json!(99)),
            ("conversation_id", json!("other")),
            ("nbf", json!(null)),
            ("exp", json!(now)),
            ("xid", json!("x")),
        ] {
            let mut c = anon.clone();
            c[field] = value;
            assert!(
                !optional(Some(&sign(&c)), Some(&participant), Some(&oidc), &pool).await,
                "{field}"
            );
        }
        for raw in [
            "Bearer broken".to_owned(),
            sign(&anon).replacen("Bearer", "bearer", 1),
            sign(&claims).replacen("Bearer", "BEARER", 1),
        ] {
            assert!(!optional(Some(&raw), Some(&participant), Some(&oidc), &pool).await);
        }
        // Each failure gets exactly one hand-back reason, isolated from other tests.
        let mut cases = vec![
            (
                "Bearer broken".to_owned(),
                Some("fixture"),
                true,
                true,
                Event::HandoffCredentialShape,
            ),
            (
                sign(&anon),
                Some("other"),
                true,
                true,
                Event::HandoffConversationScope,
            ),
            (
                sign(&anon),
                Some("fixture"),
                false,
                true,
                Event::HandoffVerifierUnavailable,
            ),
        ];
        for (base, field, value, reason) in [
            (&claims, "xid", json!("x"), Event::HandoffUnsupportedKind),
            (&claims, "exp", json!(now), Event::HandoffOidcVerification),
            (&claims, "email", json!(null), Event::HandoffOidcProfile),
            (&claims, "sub", json!("missing"), Event::HandoffOidcMapping),
            (
                &anon,
                "conversation_id",
                json!("missing"),
                Event::HandoffConversationMissing,
            ),
            (
                &anon,
                "exp",
                json!(now),
                Event::HandoffParticipantVerification,
            ),
            (&anon, "pid", json!(99), Event::HandoffParticipantMembership),
        ] {
            let mut payload = base.clone();
            payload[field] = value;
            cases.push((sign(&payload), None, true, true, reason));
        }
        let mut xid = anon.clone();
        xid.as_object_mut().unwrap().remove("anonymous_participant");
        xid["xid_participant"] = json!(true);
        xid["xid"] = json!("fixture-xid");
        xid["sub"] = json!("xid:fixture-xid");
        for cid in ["fixture", "other"] {
            cases.push((
                sign(&xid),
                Some(cid),
                true,
                true,
                Event::HandoffUnsupportedKind,
            ));
        }
        for (raw, scope, has_participant, has_oidc, reason) in cases {
            let counters = Box::leak(Box::new(Counters::new()));
            assert!(
                resolve_scoped_observed(
                    Some(&raw),
                    has_participant.then_some(&participant),
                    has_oidc.then_some(&oidc),
                    &pool,
                    scope,
                    counters
                )
                .await
                .is_none()
            );
            for (label, count) in counters.snapshot() {
                assert_eq!(
                    count,
                    u64::from(label == reason.label()),
                    "{label}: {reason:?}"
                );
            }
            // The participant-only routes use the same reason table for the
            // same credential and scope; verification still decides admission.
            if matches!(
                reason,
                Event::HandoffUnsupportedKind
                    | Event::HandoffConversationScope
                    | Event::HandoffCredentialShape
                    | Event::HandoffParticipantVerification
            ) {
                let direct = Counters::new();
                assert!(
                    participant
                        .verify_observed(&raw, scope.unwrap_or("fixture"), now, &direct)
                        .is_none()
                );
                assert_eq!(
                    direct.snapshot().collect::<Vec<_>>(),
                    counters.snapshot().collect::<Vec<_>>()
                );
            }
        }
        // votes' optional second lookup must not count an admitted OIDC request
        // as a participant verification hand-back.
        let counters = Box::leak(Box::new(Counters::new()));
        let raw = sign(&claims);
        assert_eq!(
            resolve_scoped_observed(
                Some(&raw),
                Some(&participant),
                Some(&oidc),
                &pool,
                Some("fixture"),
                counters
            )
            .await,
            Some(Identity::User(polis_auth::Uid(3)))
        );
        assert!(
            participant
                .verify_unobserved(&raw, "fixture", now)
                .is_none()
        );
        assert!(counters.snapshot().all(|(_, n)| n == 0));
        let mut broken_config: postgres::Config = url.parse().unwrap();
        broken_config.options("-c search_path=missing_identity_tables");
        let broken_pool = db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(broken_config)),
            crate::contexts::pool_limits(),
        );
        let counters = Box::leak(Box::new(Counters::new()));
        assert!(
            resolve_scoped_observed(
                Some(&raw),
                Some(&participant),
                Some(&oidc),
                &broken_pool,
                None,
                counters
            )
            .await
            .is_none()
        );
        for (label, count) in counters.snapshot() {
            assert_eq!(count, u64::from(label == Event::HandoffDatabase.label()));
        }
        drop(broken_pool);
        // No creation or table mutation: only the original mapping/member remains.
        assert_eq!(
            pool.with(|c| Ok(c
                .query_one("select count(*) from users", &[])?
                .get::<_, i64>(0)))
                .await
                .unwrap(),
            1
        );
        tokio::task::spawn_blocking(move || {
            drop(pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
}
