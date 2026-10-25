//! Cross-language JWT tests using recorded test identities.
#![allow(clippy::unwrap_used)]
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use polis_auth::participant::{Kind, Verifier};
use serde_json::{Value, json};
use std::{fs, path::Path};

const NOW: u64 = 1_800_000_000;
const ISSUER: &str = "https://pol.is/";
const AUDIENCE: &str = "participants";
const CONVERSATION: &str = "2jwt-test";
const VARIANTS: [&str; 9] = [
    "valid",
    "expires_at_now",
    "audience_array",
    "wrong_audience",
    "wrong_issuer",
    "future_nbf",
    "wrong_algorithm",
    "unsigned_none",
    "hs256_public_key",
];

// Match createJwtValidation's RS256 / issuer / audience / zero tolerance
// options. Only the clock is injected: jsonwebtoken uses wall time otherwise.
// This checks JWT interoperability, not participant admission or membership.
fn verify_jwt(token: &str, public: &[u8], now: u64) -> Option<Value> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[AUDIENCE]);
    validation.leeway = 0;
    validation.validate_exp = false;
    let claims = decode::<Value>(
        token,
        &DecodingKey::from_rsa_pem(public).unwrap(),
        &validation,
    )
    .ok()?
    .claims;
    if claims.get("exp").and_then(Value::as_u64)? <= now
        || claims
            .get("nbf")
            .and_then(Value::as_u64)
            .is_some_and(|n| n > now)
    {
        return None;
    }
    Some(claims)
}

fn claims(kind: &str, variant: &str) -> Value {
    let mut c = json!({
        "aud": AUDIENCE, "iss": ISSUER, "pid": 0, "uid": 3,
        "exp": NOW + 31_536_000, "iat": NOW, "conversation_id": CONVERSATION
    });
    match kind {
        "anonymous" => {
            c["sub"] = json!("anon:3");
            c["anonymous_participant"] = json!(true);
        }
        "xid" => {
            c["sub"] = json!("xid:test-external-id");
            c["xid"] = json!("test-external-id");
            c["xid_participant"] = json!(true);
        }
        "standard_user" => {
            c["sub"] = json!("user:test|subject");
            c["oidc_sub"] = json!("test|subject");
            c["standard_user_participant"] = json!(true);
        }
        _ => panic!("unknown test kind"),
    }
    match variant {
        "valid" | "wrong_algorithm" | "unsigned_none" | "hs256_public_key" => {}
        "expires_at_now" => c["exp"] = json!(NOW),
        "audience_array" => c["aud"] = json!(["another-audience", AUDIENCE]),
        "wrong_audience" => c["aud"] = json!(["another-audience"]),
        "wrong_issuer" => c["iss"] = json!("https://other.invalid/"),
        "future_nbf" => c["nbf"] = json!(NOW + 1),
        _ => panic!("unknown test variant"),
    }
    c
}

#[test]
fn mint_cross_verification_fixtures() {
    // One fresh pair for all three kinds and both signers in a recording run.
    // The optional private-key exchange file is temporary and never committed.
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let private = rsa.private_key_to_pem().unwrap();
    let key = EncodingKey::from_rsa_pem(&private).unwrap();
    let mut cases = Vec::new();
    for kind in ["anonymous", "xid", "standard_user"] {
        for variant in VARIANTS {
            let c = claims(kind, variant);
            let algorithm = if variant == "wrong_algorithm" {
                Algorithm::RS384
            } else {
                Algorithm::RS256
            };
            let token = match variant {
                "unsigned_none" => {
                    let signed = encode(&Header::new(algorithm), &c, &key).unwrap();
                    format!(
                        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.{}.",
                        signed.split('.').nth(1).unwrap()
                    )
                }
                "hs256_public_key" => encode(
                    &Header::new(Algorithm::HS256),
                    &c,
                    &EncodingKey::from_secret(&public),
                )
                .unwrap(),
                _ => encode(&Header::new(algorithm), &c, &key).unwrap(),
            };
            let accepted = matches!(variant, "valid" | "audience_array");
            assert_eq!(verify_jwt(&token, &public, NOW).is_some(), accepted);
            cases.push(json!({
                "kind": kind, "variant": variant, "claims": c,
                "accepted": accepted, "rust_token": token
            }));
        }
    }
    if let Ok(path) = std::env::var("POLIS_JWT_RECORD_INPUT") {
        // create_new refuses to overwrite an existing file; restrictive mode
        // keeps the disposable signing key private during the exchange.
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).unwrap();
        serde_json::to_writer_pretty(
            file,
            &json!({
                "now": NOW, "public_key": String::from_utf8(public).unwrap(),
                "private_key": String::from_utf8(private).unwrap(), "cases": cases
            }),
        )
        .unwrap();
    }
}

#[test]
fn recorded_node_and_rust_tokens_cross_verify() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../server/__tests__/fixtures/participant-jwt/recordings.json");
    let recording: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert!(recording.get("private_key").is_none());
    assert_eq!(recording["now"], NOW);
    let public = recording["public_key"].as_str().unwrap().as_bytes();
    let participant = Verifier::new(public, ISSUER, AUDIENCE).unwrap();
    let cases = recording["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 27);
    for kind in ["anonymous", "xid", "standard_user"] {
        for variant in VARIANTS {
            let matches: Vec<_> = cases
                .iter()
                .filter(|c| c["kind"] == kind && c["variant"] == variant)
                .collect();
            assert_eq!(matches.len(), 1);
            let case = matches[0];
            assert_eq!(case["claims"], claims(kind, variant));
            let accepted = matches!(variant, "valid" | "audience_array");
            assert_eq!(case["accepted"], accepted);
            for signer in ["node", "rust"] {
                let token = case[format!("{signer}_token")].as_str().unwrap();
                let verified = verify_jwt(token, public, NOW);
                assert_eq!(verified.is_some(), accepted, "{signer}/{kind}/{variant}");
                if let Some(c) = verified {
                    assert_eq!(c, case["claims"]);
                }
                let scoped = participant.verify_for_request(
                    &format!("Bearer {token}"),
                    CONVERSATION,
                    None,
                    NOW,
                );
                assert_eq!(
                    scoped.is_some(),
                    variant == "valid",
                    "{signer}/{kind}/{variant}"
                );
                if let Some(identity) = scoped {
                    assert_eq!(identity.uid(), Some(polis_auth::Uid(3)));
                    assert_eq!(identity.pid(), Some(polis_auth::Pid(0)));
                    assert_eq!(
                        identity.kind,
                        match kind {
                            "anonymous" => Kind::Anonymous,
                            "xid" => Kind::Xid,
                            _ => Kind::StandardUser,
                        }
                    );
                    assert_eq!(
                        identity.xid(),
                        (kind == "xid").then_some("test-external-id")
                    );
                }
                // Keep the serving verifier's existing conservative boundary
                // visible. XID and array audiences are Node handoffs today.
                let identity = participant.verify(&format!("Bearer {token}"), CONVERSATION, NOW);
                assert_eq!(identity.is_some(), variant == "valid" && kind != "xid");
                if let Some(identity) = identity {
                    assert_eq!(identity.uid(), polis_auth::Uid(3));
                    assert_eq!(
                        identity.kind,
                        if kind == "anonymous" {
                            Kind::Anonymous
                        } else {
                            Kind::StandardUser
                        }
                    );
                }
            }
        }
    }
}
