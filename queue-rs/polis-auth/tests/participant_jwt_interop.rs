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
                let scoped = participant
                    .verify_for_request(
                        &format!("Bearer {token}"),
                        CONVERSATION,
                        None,
                        NOW,
                        &mut polis_auth::xid_account::Check {
                            db: &mut |_| Ok(None),
                            admin_uids: &[],
                        },
                    )
                    .unwrap();
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

fn mint_cases() -> Vec<Value> {
    let mut cases = Vec::new();
    for kind in ["anonymous", "xid", "standard_user"] {
        for conversation in [CONVERSATION, "2jwt-other"] {
            cases.push(json!({"kind":kind, "conversation":conversation,
                "identifier":if kind == "xid" {"test-external-id"} else {"test|subject"},
                "uid":3,"pid":0,"exp_now":NOW,"iat_now":NOW}));
        }
    }
    for kind in ["xid", "standard_user"] {
        for identifier in [" \t", "test\"\\\n🦀\u{2028}"] {
            cases.push(json!({"kind":kind,"conversation":CONVERSATION,
                "identifier":identifier,"uid":3,"pid":0,"exp_now":NOW,"iat_now":NOW+1}));
        }
    }
    cases
}
fn process_keys(private: Option<&[u8]>, public: &[u8]) -> polis_auth::keys::Keys {
    polis_auth::keys::Keys::from_environment(|name| match name {
        "JWT_PRIVATE_KEY" => private.map(|p| String::from_utf8(p.to_vec()).unwrap().into()),
        "JWT_PUBLIC_KEY" => Some(String::from_utf8(public.to_vec()).unwrap().into()),
        _ => None,
    })
    .unwrap()
}
fn mint_case(
    keys: &polis_auth::keys::Keys,
    case: &Value,
) -> Result<String, polis_auth::participant_mint::Error> {
    use polis_auth::{
        Pid, Uid,
        participant_mint::{Identity, mint},
        xid_account::Check,
    };
    let uid = Uid(case["uid"].as_i64().unwrap() as i32);
    let identifier = case["identifier"].as_str().unwrap();
    let mut db = |_| Ok(None);
    let identity = match case["kind"].as_str().unwrap() {
        "anonymous" => Identity::anonymous(uid),
        "xid" => Identity::xid(
            uid,
            identifier,
            &mut Check {
                db: &mut db,
                admin_uids: &[],
            },
        )?,
        "standard_user" => Identity::standard_user(uid, identifier)?,
        _ => panic!("unknown fixture kind"),
    };
    let mut clock = [
        case["exp_now"].as_u64().unwrap(),
        case["iat_now"].as_u64().unwrap(),
    ]
    .into_iter();
    mint(
        keys,
        identity,
        case["conversation"].as_str().unwrap(),
        Pid(case["pid"].as_u64().unwrap() as u32),
        ISSUER,
        AUDIENCE,
        || clock.next().unwrap(),
    )
}
#[test]
fn participant_minter_node_recordings_and_fresh_signatures() {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let private = rsa.private_key_to_pem().unwrap();
    let keys = process_keys(Some(&private), &public);
    let cases = mint_cases();
    let recording: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../server/__tests__/fixtures/participant-jwt/participant-mint.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(recording.get("private_key").is_none());
    let recorded = recording["cases"].as_array().unwrap();
    assert_eq!(recorded.len(), cases.len());
    let recorded_public = recording["public_key"].as_str().unwrap().as_bytes();
    for (case, recorded) in cases.iter().zip(recorded) {
        for (name, value) in case.as_object().unwrap() {
            assert_eq!(&recorded[name], value);
        }
        // Node's low-level helper accepts a blank XID, but its identity path
        // never issues one. Preserve that Node case and require Rust to refuse.
        if case["kind"] == "xid" && case["identifier"] == " \t" {
            assert_eq!(
                mint_case(&keys, case),
                Err(polis_auth::participant_mint::Error::MissingIdentifier)
            );
            assert_eq!(recorded["rust_refused"], true);
            assert!(recorded.get("rust_token").is_none());
            assert!(
                verify_jwt(
                    recorded["node_token"].as_str().unwrap(),
                    recorded_public,
                    NOW
                )
                .is_some()
            );
            continue;
        }
        let fresh = mint_case(&keys, case).unwrap();
        let node = recorded["node_token"].as_str().unwrap();
        let rust = recorded["rust_token"].as_str().unwrap();
        // Live recording checks full byte equality with one disposable pair.
        // Replay also exercises today's signer against Node's exact JSON bytes.
        assert!(node == rust, "recorded signers differ");
        assert!(
            fresh.rsplit_once('.').unwrap().0 == node.rsplit_once('.').unwrap().0,
            "header or claim bytes differ"
        );
        let expected = verify_jwt(node, recorded_public, NOW).unwrap();
        assert_eq!(
            verify_jwt(rust, recorded_public, NOW),
            Some(expected.clone())
        );
        assert_eq!(verify_jwt(&fresh, &public, NOW), Some(expected));
    }
    // Recording never bypasses replay assertions. A stale contract must be
    // investigated before deliberately regenerating its public recordings.
    if let Ok(path) = std::env::var("POLIS_MINT_RECORD_INPUT") {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let generated: Vec<_> = cases
            .iter()
            .map(|case| {
                let mut c = case.clone();
                match mint_case(&keys, case) {
                    Ok(token) => c["rust_token"] = json!(token),
                    Err(polis_auth::participant_mint::Error::MissingIdentifier) => {
                        c["rust_refused"] = json!(true);
                    }
                    Err(_) => panic!("unexpected recording refusal"),
                }
                c
            })
            .collect();
        serde_json::to_writer_pretty(
            options.open(path).unwrap(),
            &json!({
                "public_key":String::from_utf8(public).unwrap(),
                "private_key":String::from_utf8(private).unwrap(),"cases":generated
            }),
        )
        .unwrap();
    }
}
#[test]
fn participant_minter_errors_are_fixed_and_key_custody_is_preserved() {
    use polis_auth::{
        Pid, Uid,
        participant_mint::{Error, Identity, mint},
        xid_account::Check,
    };
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let keys = process_keys(None, &public);
    assert_eq!(
        mint(
            &keys,
            Identity::anonymous(Uid(3)),
            CONVERSATION,
            Pid(0),
            ISSUER,
            AUDIENCE,
            || NOW
        ),
        Err(Error::MissingPrivateKey)
    );
    assert!(matches!(
        Identity::standard_user(Uid(3), ""),
        Err(Error::MissingIdentifier)
    ));
    let mut db = |_| panic!("blank identifier must not query");
    assert!(matches!(
        Identity::xid(
            Uid(3),
            "",
            &mut Check {
                db: &mut db,
                admin_uids: &[]
            }
        ),
        Err(Error::MissingIdentifier)
    ));
    let keys = process_keys(Some(&rsa.private_key_to_pem().unwrap()), &public);
    assert_eq!(
        mint(
            &keys,
            Identity::anonymous(Uid(3)),
            CONVERSATION,
            Pid(0),
            ISSUER,
            AUDIENCE,
            || u64::MAX
        ),
        Err(Error::InvalidClock)
    );
}
#[test]
fn established_anonymous_session_does_not_attach_a_late_external_id() {
    use polis_auth::{Pid, Uid, Zid, admission::Identity, participant_mint, xid_account::Check};
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let keys = process_keys(Some(&rsa.private_key_to_pem().unwrap()), &public);
    let token = participant_mint::mint(
        &keys,
        participant_mint::Identity::anonymous(Uid(3)),
        CONVERSATION,
        Pid(0),
        ISSUER,
        AUDIENCE,
        || NOW,
    )
    .unwrap();
    let verifier = keys.verifier(ISSUER, AUDIENCE).unwrap();
    let mut db = |_| panic!("established anonymous identity must not resolve a request XID");
    let identity = verifier
        .verify_for_request(
            &format!("Bearer {token}"),
            CONVERSATION,
            Some("late-external-id"),
            NOW,
            &mut Check {
                db: &mut db,
                admin_uids: &[],
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(identity.uid(), Some(Uid(3)));
    assert_eq!(identity.pid(), Some(Pid(0)));
    assert_eq!(identity.xid(), None);
    assert!(matches!(
        Identity::from_verified(&identity, Zid(7)),
        Identity::AnonymousParticipant {
            uid: Uid(3),
            conversation: Zid(7)
        }
    ));
}
#[test]
fn external_id_minting_rejects_every_privileged_account_and_lookup_failure() {
    use polis_auth::{
        Uid, Unavailable,
        participant_mint::{Error, Identity},
        xid_account::{Account, Check},
    };
    for (account, admins) in [
        (Account::default(), vec![Uid(3)]),
        (
            Account {
                owns_conversation: true,
                ..Account::default()
            },
            vec![],
        ),
        (
            Account {
                is_owner: true,
                ..Account::default()
            },
            vec![],
        ),
        (
            Account {
                site_moderator: true,
                ..Account::default()
            },
            vec![],
        ),
        (
            Account {
                oidc_mapped: true,
                ..Account::default()
            },
            vec![],
        ),
    ] {
        let mut db = |_| Ok(Some(account));
        assert!(matches!(
            Identity::xid(
                Uid(3),
                "test-external-id",
                &mut Check {
                    db: &mut db,
                    admin_uids: &admins
                }
            ),
            Err(Error::PrivilegedAccount(_))
        ));
    }
    let mut db = |_| Err(Unavailable);
    assert!(matches!(
        Identity::xid(
            Uid(3),
            "test-external-id",
            &mut Check {
                db: &mut db,
                admin_uids: &[]
            }
        ),
        Err(Error::AccountCheckFailed)
    ));
}

#[test]
fn participant_minter_refuses_invalid_claims_before_sampling_the_clock() {
    use polis_auth::{
        Pid, Uid,
        participant_mint::{Error, Identity, mint},
    };
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let keys = process_keys(Some(&rsa.private_key_to_pem().unwrap()), &public);
    for (conversation, issuer, audience, uid) in [
        ("", ISSUER, AUDIENCE, 3),
        (CONVERSATION, "", AUDIENCE, 3),
        (CONVERSATION, ISSUER, "", 3),
        (CONVERSATION, ISSUER, AUDIENCE, 0),
        (CONVERSATION, ISSUER, AUDIENCE, -1),
        (CONVERSATION, ISSUER, AUDIENCE, i32::MIN),
    ] {
        assert_eq!(
            mint(
                &keys,
                Identity::anonymous(Uid(uid)),
                conversation,
                Pid(0),
                issuer,
                audience,
                || panic!("invalid claims must not sample the clock")
            ),
            Err(Error::InvalidClaims)
        );
    }
    assert_eq!(
        Error::InvalidClaims.to_string(),
        "participant claims are invalid"
    );
}

#[test]
fn participant_minter_refuses_all_request_whitespace_without_an_account_query() {
    use polis_auth::{
        Uid,
        participant_mint::{Error, Identity},
        xid_account::Check,
    };
    // ECMAScript whitespace includes BOM and excludes NEXT LINE.
    for xid in [
        "",
        " ",
        "\t",
        " \t",
        "\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}",
    ] {
        let mut db = |_| panic!("blank XID must not query");
        assert!(matches!(
            Identity::xid(
                Uid(3),
                xid,
                &mut Check {
                    db: &mut db,
                    admin_uids: &[]
                }
            ),
            Err(Error::MissingIdentifier)
        ));
    }
    for xid in [" x ", "\u{85}"] {
        let mut db = |_| Ok(None);
        assert!(
            Identity::xid(
                Uid(3),
                xid,
                &mut Check {
                    db: &mut db,
                    admin_uids: &[]
                }
            )
            .is_ok()
        );
    }
}

#[test]
fn participant_minter_account_errors_distinguish_privilege_from_unavailability() {
    use polis_auth::{participant_mint::Error, xid_account::Class};
    assert_eq!(
        Error::PrivilegedAccount(Class::Admin).to_string(),
        "external identity is not a participant account"
    );
    assert_eq!(
        Error::AccountCheckFailed.to_string(),
        "participant account check failed"
    );
    assert_eq!(
        format!("{:?}", Error::AccountCheckFailed),
        "AccountCheckFailed"
    );
    assert_eq!(
        format!("{:?}", Error::PrivilegedAccount(Class::Admin)),
        "PrivilegedAccount(Admin)"
    );
}
