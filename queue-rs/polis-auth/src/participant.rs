//! Read-only resolution of Node-issued, conversation-scoped participant tokens.
//! Unsupported credentials and missing membership always return a Node handoff.
use crate::{Pid, Uid, Zid};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Anonymous,
    StandardUser,
}
/// No Debug implementation: claims must not become diagnostic output.
#[derive(Clone)]
pub struct Verified {
    uid: Uid,
    pid: Pid,
    pub kind: Kind,
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
    pub fn verify(&self, authorization: &str, conversation: &str, now: u64) -> Option<Verified> {
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
            || c.conversation_id != conversation
            || c.iss.is_empty()
            || c.aud.is_empty()
        {
            return None;
        }
        let kind = match (
            c.anonymous_participant,
            c.standard_user_participant,
            c.oidc_sub,
        ) {
            (Some(true), None, None) if c.sub == format!("anon:{}", c.uid) => Kind::Anonymous,
            (None, Some(true), Some(sub))
                if !sub.is_empty() && sub.len() <= 255 && c.sub == format!("user:{sub}") =>
            {
                Kind::StandardUser
            }
            _ => return None,
        };
        Some(Verified {
            uid: Uid(c.uid),
            pid: Pid(c.pid as u32),
            kind,
        })
    }
}
/// Existing membership only. Caller uses the route's bounded, read-only primary
/// pool. No insert, token mint, XID lookup, alias repair or treevite gate occurs.
pub fn resolve(
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
    #[test]
    #[cfg(feature = "db-tests")]
    fn membership_is_existing_exact_and_read_only() {
        let url = std::env::var("POLIS_AUTH_TEST_DATABASE_URL").unwrap();
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let schema = format!("participant_read_{}", std::process::id());
        c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema}; CREATE TABLE conversations(zid integer, treevite_enabled boolean); CREATE TABLE participants(zid integer,uid integer,pid integer); INSERT INTO conversations VALUES (1,false),(2,true),(3,false); INSERT INTO participants VALUES (1,3,0),(2,3,0),(3,3,1); SET default_transaction_read_only=on;")).unwrap();
        let (v, k) = keys();
        let a = v.verify(&sign(&claims(), &k), "2fixture", 150).unwrap();
        assert_eq!(resolve(&mut c, Zid(1), &a).unwrap(), Some(Pid(0)));
        for zid in [2, 3, 4] {
            assert_eq!(resolve(&mut c, Zid(zid), &a).unwrap(), None);
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
