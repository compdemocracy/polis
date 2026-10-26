use polis_contracts::{auth_envelope, schema, wire, xid_account};
use serde_json::Value;
use std::{fs, path::Path};
#[test]
fn every_account_class_matches_nodes_recorded_http_bytes() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/xid-account.json")).unwrap();
    assert_eq!(fixture["contract"], xid_account::CONTRACT_VERSION);
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), xid_account::ENTRIES.len());
    for (case, entry) in cases.iter().zip(xid_account::ENTRIES) {
        assert_eq!(case["account_class"], entry.account_class);
        for mode in ["bare", "existing"] {
            assert_eq!(case[mode]["status"], entry.status);
            let body = case[mode]["body"].as_str().unwrap();
            if entry.status == 403 {
                let refusal: xid_account::Refusal = serde_json::from_str(body).unwrap();
                assert_eq!(serde_json::to_string(&refusal).unwrap(), body);
                let value: Value = serde_json::from_str(body).unwrap();
                assert!(value.get("auth").is_none());
                assert!(value.get("account_class").is_none());
            } else {
                // Preserve the full raw success, including field ordering.
                let value: wire::Json = serde_json::from_str(body).unwrap();
                assert_eq!(serde_json::to_string(&value).unwrap(), body);
                let value: Value = serde_json::from_str(body).unwrap();
                if mode == "bare" {
                    let auth: auth_envelope::Auth =
                        serde_json::from_value(value["auth"].clone()).unwrap();
                    assert!(!auth.token.is_empty());
                    assert_eq!(value["user"]["uid"], case["uid"]);
                    assert_eq!(value["ptpt"]["pid"], case["pid"]);
                }
            }
        }
    }
}
#[test]
fn refusal_schema_is_pinned_and_extra_fields_are_rejected() {
    let rendered = schema::render(&xid_account::document().to_json());
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../schemas/xid-account-refusal-v1.json");
    if std::env::var("POLIS_CONTRACTS_WRITE_SCHEMAS").as_deref() == Ok("1") {
        fs::write(&path, &rendered).unwrap();
    }
    assert_eq!(fs::read_to_string(path).unwrap(), rendered);
    for body in [
        r#"{"error":"polis_err_xid_owner_account","message":"polis_err_xid_owner_account","status":401}"#,
        r#"{"error":"polis_err_xid_owner_account","message":"different","status":403}"#,
        r#"{"error":"polis_err_xid_owner_account","message":"polis_err_xid_owner_account","status":403,"auth":{}}"#,
    ] {
        assert!(serde_json::from_str::<xid_account::Refusal>(body).is_err());
    }
}
