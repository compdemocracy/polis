//! Verify the participant tokens returned by Node's recorded identity requests.
#![allow(clippy::unwrap_used)]
use polis_auth::participant::{Kind, Verifier};
use serde_json::Value;
use std::{fs, path::Path};

#[test]
fn recorded_identity_tokens_verify_with_their_committed_participants() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../server/__tests__/fixtures/identity/recordings.json");
    let fixture: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let verifier = Verifier::new(
        fixture["public_key"].as_str().unwrap().as_bytes(),
        "https://pol.is/",
        "participants",
    )
    .unwrap();
    let mut counts = [0; 3];
    let mut refusals = 0;
    for evidence in fixture["evidence"].as_array().unwrap() {
        let name = evidence["case"].as_str().unwrap();
        let recording = fixture["recordings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["case"] == name)
            .unwrap();
        let request = &recording["request"];
        let conversation = request["body"]["conversation_id"]
            .as_str()
            .or_else(|| request["query"]["conversation_id"].as_str())
            .unwrap();
        if name.ends_with("-expired")
            || name.ends_with("-signature")
            || name.ends_with("-audience")
            || name.ends_with("-issuer")
        {
            let token = evidence["credential"].as_str().unwrap();
            assert!(
                verifier
                    .verify_for_request(
                        &format!("Bearer {token}"),
                        conversation,
                        None,
                        1_700_000_000
                    )
                    .is_none(),
                "{name}"
            );
            refusals += 1;
        }
        let bytes = openssl::base64::decode_block(evidence["raw"]["body_base64"].as_str().unwrap())
            .unwrap();
        let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let Some(token) = body["auth"]["token"].as_str() else {
            continue;
        };
        let identity = verifier
            .verify_for_request(
                &format!("Bearer {token}"),
                conversation,
                None,
                1_700_000_000,
            )
            .unwrap_or_else(|| panic!("returned token refused: {name}"));
        let (kind, index) = match name {
            "anonymous-first-vote"
            | "anonymous-other-conversation"
            | "pc-anonymous"
            | "treevite-accept"
            | "treevite-login" => (Kind::Anonymous, 0),
            "standard-user-first-join" => (Kind::StandardUser, 2),
            _ => (Kind::Xid, 1),
        };
        assert_eq!(identity.kind, kind, "{name}");
        counts[index] += 1;
        let uid = identity.uid().unwrap().0;
        let pid = identity.pid().unwrap().0;
        let zid = recording["credentialBinding"]["zid"].as_i64().unwrap();
        assert!(
            evidence["after"]["users"]
                .as_array()
                .unwrap()
                .iter()
                .any(|u| u["uid"] == uid),
            "{name}"
        );
        assert!(
            evidence["after"]["participants"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["uid"] == uid && p["pid"] == pid && p["zid"] == zid),
            "{name}"
        );
        if let Some(actor) = recording["credentialBinding"]["actorUid"].as_i64() {
            assert_eq!(i64::from(uid), actor, "{name}");
        } else if name == "treevite-login" {
            let accepted = fixture["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["case"] == "treevite-accept")
                .unwrap();
            let row = &accepted["after"]["treevite_login_codes"][0];
            assert!(
                accepted["after"]["participants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["uid"] == uid && p["pid"] == row["pid"] && p["zid"] == row["zid"]),
                "{name}"
            );
            assert_eq!(row["pid"], pid, "{name}");
        } else {
            let created: Vec<_> = evidence["after"]["participants"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| {
                    !evidence["before"]["participants"]
                        .as_array()
                        .unwrap()
                        .contains(p)
                })
                .collect();
            assert_eq!(created.len(), 1, "{name}");
            assert_eq!(created[0]["uid"], uid, "{name}");
            assert_eq!(created[0]["pid"], pid, "{name}");
        }
        if kind == Kind::Xid {
            assert_eq!(
                identity.xid(),
                recording["credentialBinding"]["xid"].as_str(),
                "{name}"
            );
        }
    }
    assert_eq!(counts, [5, 14, 1]);
    assert_eq!(refusals, 14);
}
