mod support;

use polis_contracts::{auth_envelope, participant_token, participation_init, schema, wire};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

fn fixture(name: &str) -> String {
    support::read(&format!(
        "queue-rs/polis-contracts/tests/fixtures/identity/{name}.json"
    ))
    .trim_end()
    .to_owned()
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str, schema: schema::Schema) {
    let text = fixture(name);
    let value: T = serde_json::from_str(&text).unwrap();
    assert_eq!(wire::to_json(&value).unwrap(), text, "{name}: key order");
    let errors = support::violations(&schema.to_json(), &serde_json::from_str(&text).unwrap());
    assert!(errors.is_empty(), "{name}: {errors:?}");
}

#[test]
fn auth_value_preserves_node_key_order() {
    round_trip::<auth_envelope::Auth>("auth", auth_envelope::document());
    let auth: auth_envelope::Auth = serde_json::from_str(&fixture("auth")).unwrap();
    assert_eq!(auth.expires_in, auth_envelope::Expiration);
    assert!(serde_json::from_str::<auth_envelope::Auth>(
        &fixture("auth").replace("Bearer", "bearer")
    )
    .is_err());
}

#[test]
fn default_injection_rule_includes_errors_and_uses_javascript_truthiness() {
    for text in [
        "{}",
        r#"{"error":"example_failure"}"#,
        r#"{"auth":null,"error":"example_failure"}"#,
        r#"{"auth":false}"#,
        r#"{"auth":0}"#,
        r#"{"auth":-0}"#,
        r#"{"auth":""}"#,
    ] {
        let body = serde_json::from_str(text).unwrap();
        assert!(auth_envelope::should_attach(true, &body), "{text}");
        assert!(!auth_envelope::should_attach(false, &body), "{text}");
    }
    for text in [
        "null",
        "[]",
        "[{}]",
        "false",
        "true",
        "0",
        "1",
        "\"text\"",
        r#"{"auth":{}}"#,
        r#"{"auth":[]}"#,
        r#"{"auth":true}"#,
        r#"{"auth":1}"#,
        r#"{"auth":"existing"}"#,
    ] {
        assert!(
            !auth_envelope::should_attach(true, &serde_json::from_str(text).unwrap()),
            "{text}"
        );
    }
}

#[test]
fn token_header_has_algorithm_and_type_without_key_id() {
    round_trip::<participant_token::Header>("header", participant_token::header_document());
    assert!(serde_json::from_str::<participant_token::Header>(
        r#"{"alg":"RS256","typ":"JWT","kid":"extra"}"#
    )
    .is_err());
    assert!(
        serde_json::from_str::<participant_token::Header>(r#"{"alg":"HS256","typ":"JWT"}"#)
            .is_err()
    );
}

#[test]
fn each_minted_claim_set_round_trips_in_payload_order() {
    for name in ["token-anonymous", "token-xid", "token-standarduser"] {
        round_trip::<participant_token::Claims>(name, participant_token::document());
    }
    let anonymous: participant_token::Anonymous =
        serde_json::from_str(&fixture("token-anonymous")).unwrap();
    assert_eq!(anonymous.sub, format!("anon:{}", anonymous.uid));
    let xid: participant_token::Xid = serde_json::from_str(&fixture("token-xid")).unwrap();
    assert_eq!(xid.sub, format!("xid:{}", xid.xid));
    let user: participant_token::StandardUser =
        serde_json::from_str(&fixture("token-standarduser")).unwrap();
    assert_eq!(user.sub, format!("user:{}", user.oidc_sub));
}

#[test]
fn claim_kinds_reject_missing_false_mixed_and_unknown_fields() {
    for name in ["token-anonymous", "token-xid", "token-standarduser"] {
        let text = fixture(name);
        let object: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&text).unwrap();
        for key in object.keys() {
            let mut missing = object.clone();
            missing.remove(key);
            assert!(
                serde_json::from_value::<participant_token::Claims>(missing.into()).is_err(),
                "{name}: missing {key}"
            );
        }
        assert!(serde_json::from_str::<participant_token::Claims>(
            &text.replace(":true", ":false")
        )
        .is_err());
        let mut mixed = object;
        mixed.insert("extra".into(), serde_json::json!(true));
        assert!(serde_json::from_value::<participant_token::Claims>(mixed.clone().into()).is_err());
        mixed.remove("extra");
        mixed.insert(
            if name == "token-anonymous" {
                "xid_participant"
            } else {
                "anonymous_participant"
            }
            .into(),
            serde_json::json!(true),
        );
        assert!(serde_json::from_value::<participant_token::Claims>(mixed.into()).is_err());
    }
}

#[test]
fn participant_and_x_info_preserve_column_order_and_bigint_strings() {
    round_trip::<participation_init::Participant>(
        "participant",
        participation_init::participant_document(),
    );
    round_trip::<participation_init::XInfo>("x-info", participation_init::x_info_document());
    let ptpt = fixture("participant");
    assert!(!ptpt.contains("\"zid\""));
    assert!(ptpt.contains("\"9223372036854775807\""));
    let xinfo = fixture("x-info");
    assert!(xinfo.ends_with("\"zid\":null,\"pid\":null}"));
    assert!(!xinfo.contains("\"owner\"") && !xinfo.contains("\"created\""));
}

#[test]
fn conversation_preserves_columns_then_decorations_and_presence() {
    for name in [
        "conversation",
        "conversation-no-ownername",
        "conversation-metadata",
    ] {
        round_trip::<participation_init::Conversation>(
            name,
            participation_init::conversation_document(),
        );
    }
    let present_null: participation_init::Conversation =
        serde_json::from_str(&fixture("conversation")).unwrap();
    let absent: participation_init::Conversation =
        serde_json::from_str(&fixture("conversation-no-ownername")).unwrap();
    assert_eq!(present_null.ownername, Some(None));
    assert_eq!(absent.ownername, None);
}

#[test]
fn required_nullable_columns_are_not_optional_and_bigints_are_not_numbers() {
    let mut ptpt: serde_json::Value = serde_json::from_str(&fixture("participant")).unwrap();
    ptpt.as_object_mut().unwrap().remove("created");
    assert!(serde_json::from_value::<participation_init::Participant>(ptpt.clone()).is_err());
    ptpt["created"] = serde_json::json!(1700000000000_u64);
    assert!(serde_json::from_value::<participation_init::Participant>(ptpt).is_err());
    let mut conv: serde_json::Value = serde_json::from_str(&fixture("conversation")).unwrap();
    conv.as_object_mut().unwrap().remove("topic");
    assert!(serde_json::from_value::<participation_init::Conversation>(conv.clone()).is_err());
    conv["topic"] = serde_json::Value::Null;
    conv["hasMetadata"] = serde_json::json!(false);
    assert!(serde_json::from_value::<participation_init::Conversation>(conv).is_err());
}

#[test]
fn schemas_match_committed_copies() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../schemas");
    for (name, document) in [
        ("auth-envelope-v1.json", auth_envelope::document()),
        (
            "participant-token-header-v1.json",
            participant_token::header_document(),
        ),
        ("participant-token-v1.json", participant_token::document()),
        (
            "participation-init-participant-v1.json",
            participation_init::participant_document(),
        ),
        (
            "participation-init-x-info-v1.json",
            participation_init::x_info_document(),
        ),
        (
            "participation-init-conversation-v1.json",
            participation_init::conversation_document(),
        ),
    ] {
        let rendered = schema::render(&document.to_json());
        let path = directory.join(name);
        if std::env::var("POLIS_CONTRACTS_WRITE_SCHEMAS").as_deref() == Ok("1") {
            std::fs::write(&path, &rendered).unwrap();
        }
        assert_eq!(std::fs::read_to_string(path).unwrap(), rendered, "{name}");
    }
}

#[test]
fn auth_expiry_rejects_every_nonliteral_shape() {
    for expiry in [
        "0",
        "5",
        "31535999",
        "31536001",
        "-1",
        "31536000.5",
        "null",
        "\"31536000\"",
    ] {
        let text = fixture("auth").replace("31536000", expiry);
        assert!(
            serde_json::from_str::<auth_envelope::Auth>(&text).is_err(),
            "{expiry}"
        );
        assert!(
            !support::violations(
                &auth_envelope::document().to_json(),
                &serde_json::from_str(&text).unwrap()
            )
            .is_empty(),
            "{expiry}"
        );
    }
}

#[test]
fn bootstrap_conversation_rejects_documented_legacy_columns() {
    let mut missing: serde_json::Value = serde_json::from_str(&fixture("conversation")).unwrap();
    missing.as_object_mut().unwrap().remove("branding_type");
    let error = serde_json::from_value::<participation_init::Conversation>(missing).unwrap_err();
    assert!(error.to_string().contains("missing field `branding_type`"));
    for name in ["dataset_explanation", "is_curated", "need_suzinvite"] {
        let mut extra: serde_json::Value = serde_json::from_str(&fixture("conversation")).unwrap();
        extra[name] = serde_json::json!(false);
        let error = serde_json::from_value::<participation_init::Conversation>(extra).unwrap_err();
        assert!(error
            .to_string()
            .contains(&format!("unknown field `{name}`")));
    }
}

// Decode only the unpadded base64url segments in the checked-in public recordings.
// This helper is test data plumbing, not a token verifier.
fn recording_segment(segment: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    assert_ne!(segment.len() % 4, 1);
    let mut output = Vec::new();
    let (mut pending, mut bits) = (0_u32, 0_u32);
    for byte in segment.bytes() {
        let value = alphabet
            .iter()
            .position(|&c| c == byte)
            .expect("base64url character") as u32;
        pending = (pending << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((pending >> bits) as u8);
            pending &= (1 << bits) - 1;
        }
    }
    assert_eq!(pending, 0, "canonical base64url padding bits");
    output
}

#[test]
fn node_minted_recordings_round_trip_header_and_payload_bytes() {
    let recordings: serde_json::Value = serde_json::from_str(&support::read(
        "server/__tests__/fixtures/participant-jwt/recordings.json",
    ))
    .unwrap();
    let mut kinds = std::collections::BTreeSet::new();
    for case in recordings["cases"].as_array().unwrap() {
        if case["variant"] != "valid" {
            continue;
        }
        let kind = case["kind"].as_str().unwrap();
        assert!(kinds.insert(kind), "duplicate valid kind: {kind}");
        let parts: Vec<_> = case["node_token"].as_str().unwrap().split('.').collect();
        assert_eq!(parts.len(), 3);
        let header_bytes = recording_segment(parts[0]);
        let payload_bytes = recording_segment(parts[1]);
        let header: participant_token::Header = serde_json::from_slice(&header_bytes).unwrap();
        let claims: participant_token::Claims = serde_json::from_slice(&payload_bytes).unwrap();
        assert_eq!(
            wire::to_json(&header).unwrap().as_bytes(),
            header_bytes,
            "{kind} header"
        );
        assert_eq!(
            wire::to_json(&claims).unwrap().as_bytes(),
            payload_bytes,
            "{kind} payload"
        );
        assert_eq!(
            serde_json::to_value(&claims).unwrap(),
            case["claims"],
            "{kind} claims"
        );
    }
    assert_eq!(
        kinds,
        ["anonymous", "xid", "standard_user"].into_iter().collect()
    );
}
