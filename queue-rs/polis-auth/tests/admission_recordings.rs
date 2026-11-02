//! Admission projection of the committed Node recordings, not an HTTP server
//! comparison. Authentication, response signing and downstream votes/comments
//! retain their own existing contracts; this test writes no votes or comments.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "support/admission.rs"]
mod support;
use polis_auth::{
    Uid, Unavailable, Zid,
    admission::*,
    participant::Verifier,
    xid_account::{Account, Check},
};

/// The recordings are of plain participants: the account lookup finds no privileged account.
fn plain_lookup() -> impl FnMut(Uid) -> Result<Option<Account>, Unavailable> {
    |_uid| Ok(None)
}
use serde_json::{Value, json};
use support::*;

fn n(v: &Value, key: &str) -> i32 {
    v[key].as_i64().unwrap() as i32
}
fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str()
}
fn rows<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key].as_array().unwrap()
}
fn projection(db: &mut postgres::Client, table: &str, columns: &[&str]) -> Vec<Value> {
    let sql = format!(
        "SELECT row_to_json(r)::text FROM (SELECT {} FROM {table}) r",
        columns.join(",")
    );
    let mut result: Vec<Value> = db
        .query(&sql, &[])
        .unwrap()
        .iter()
        .map(|r| serde_json::from_str(&r.get::<_, String>(0)).unwrap())
        .collect();
    result.sort_by_key(Value::to_string);
    result
}
fn expected(after: &Value, table: &str, columns: &[&str]) -> Vec<Value> {
    let mut result: Vec<Value> = rows(after, table)
        .iter()
        .map(|r| {
            columns
                .iter()
                .map(|c| (c.to_string(), r[*c].clone()))
                .collect::<serde_json::Map<String, Value>>()
                .into()
        })
        .collect();
    result.sort_by_key(Value::to_string);
    result
}

#[test]
fn recorded_node_admission_results_match_on_the_shared_cases() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../server/__tests__/fixtures/identity/recordings.json"
    ))
    .unwrap();
    let verifier = Verifier::new(
        fixture["public_key"].as_str().unwrap().as_bytes(),
        "https://pol.is/",
        "participants",
    )
    .unwrap();
    let mut count = 0;
    for evidence in rows(&fixture, "evidence") {
        let name = evidence["case"].as_str().unwrap();
        // OIDC provisioning and retired cookie/classifier paths are outside
        // admission. Partial-state failures are exercised separately below.
        if !([
            "anonymous-first-vote",
            "anonymous-repeat",
            "anonymous-other-conversation",
        ]
        .contains(&name)
            || name.starts_with("bare-xid-")
            || name.starts_with("xid-own-")
            || name == "xid-other-conversation"
            || name == "xid-other-owner"
            || name == "xid-request-precedence"
            || name.starts_with("standard-user-")
            || [
                "treevite-accept",
                "treevite-login",
                "treevite-used-invite",
                "treevite-invalid-login",
            ]
            .contains(&name))
        {
            continue;
        }
        let recording = rows(&fixture, "recordings")
            .iter()
            .find(|r| r["case"] == name)
            .unwrap();
        let mut f = Fixture::new();
        f.db.batch_execute("TRUNCATE users CASCADE").unwrap();
        let before = &evidence["before"];
        let after = &evidence["after"];
        for u in rows(before, "users") {
            f.db.execute(
                "INSERT INTO users(uid,site_id,is_owner,site_owner) VALUES($1,$2,$3,$4)",
                &[
                    &n(u, "uid"),
                    &s(u, "site_id"),
                    &u["is_owner"].as_bool(),
                    &u["site_owner"].as_bool(),
                ],
            )
            .unwrap();
        }
        f.db.batch_execute("INSERT INTO conversations(zid,owner) VALUES(1,1),(2,1),(3,2); ALTER TABLE participants DISABLE TRIGGER pid_auto").unwrap();
        for p in rows(before, "participants") {
            f.db.execute(
                "INSERT INTO participants(zid,uid,pid) VALUES($1,$2,$3)",
                &[&n(p, "zid"), &n(p, "uid"), &n(p, "pid")],
            )
            .unwrap();
        }
        f.db.batch_execute("ALTER TABLE participants ENABLE TRIGGER pid_auto; UPDATE conversations c SET participant_count=(SELECT count(*) FROM participants p WHERE p.zid=c.zid)").unwrap();
        for p in rows(before, "participants_extended") {
            f.db.execute(
                "INSERT INTO participants_extended(zid,uid) VALUES($1,$2)",
                &[&n(p, "zid"), &n(p, "uid")],
            )
            .unwrap();
        }
        for x in rows(before, "xids") {
            f.db.execute("INSERT INTO xids(owner,uid,xid,zid,pid,x_name,x_email,x_profile_image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",&[&n(x,"owner"),&n(x,"uid"),&s(x,"xid"),&x["zid"].as_i64().map(|v|v as i32),&x["pid"].as_i64().map(|v|v as i32),&s(x,"x_name"),&s(x,"x_email"),&s(x,"x_profile_image_url")]).unwrap();
        }
        for m in rows(before, "oidc_user_mappings") {
            f.db.execute(
                "INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES($1,$2)",
                &[&s(m, "oidc_sub"), &n(m, "uid")],
            )
            .unwrap();
        }
        f.db.batch_execute("INSERT INTO treevite_waves(id,zid,wave,invites_per_user,owner_invites) VALUES(1,1,1,0,1)").unwrap();
        for i in rows(before, "treevite_invites") {
            f.db.execute("INSERT INTO treevite_invites(id,zid,wave_id,invite_code,status,invite_used_by_pid) VALUES($1,$2,$3,$4,$5,$6)",&[&i["id"].as_str().and_then(|v|v.parse::<i64>().ok()).unwrap_or_else(||i["id"].as_i64().unwrap()),&n(i,"zid"),&1_i64,&s(i,"invite_code"),&(n(i,"status") as i16),&i["invite_used_by_pid"].as_i64().map(|v|v as i32)]).unwrap();
        }
        for l in rows(before, "treevite_login_codes") {
            f.db.execute("INSERT INTO treevite_login_codes(zid,pid,login_code_hash,login_code_fingerprint,login_code_lookup,revoked) VALUES($1,$2,$3,$4,$5,$6)",&[&n(l,"zid"),&n(l,"pid"),&s(l,"login_code_hash"),&s(l,"login_code_fingerprint"),&s(l,"login_code_lookup"),&l["revoked"].as_bool()]).unwrap();
        }
        // Preserve generated UID symbols from the recording, including gaps
        // caused by earlier failed Node requests. Never infer a PID in Rust.
        let next = rows(after, "users")
            .iter()
            .filter(|u| !rows(before, "users").iter().any(|b| b["uid"] == u["uid"]))
            .map(|u| n(u, "uid"))
            .min()
            .unwrap_or_else(|| {
                rows(before, "users")
                    .iter()
                    .map(|u| n(u, "uid"))
                    .max()
                    .unwrap()
                    + 1
            });
        f.db.query_one(
            "SELECT setval('users_uid_seq',$1,false)",
            &[&i64::from(next)],
        )
        .unwrap();
        let wire_request = &recording["request"];
        let data = if wire_request["method"] == "GET" {
            &wire_request["query"]
        } else {
            &wire_request["body"]
        };
        let conversation = data["conversation_id"].as_str().unwrap();
        let zid = match conversation {
            "2p027identity2" => 2,
            "2p027identity3" => 3,
            _ => 1,
        };
        let whitelist = name.ends_with("-allowed")
            || name.ends_with("-denied")
            || name.ends_with("-allowed-missing");
        let required = name.ends_with("-required") || name.ends_with("-required-missing");
        f.db.execute("UPDATE conversations SET use_xid_whitelist=$1,xid_required=$2,treevite_enabled=$3 WHERE zid=$4",&[&whitelist,&required,&name.starts_with("treevite-"),&zid]).unwrap();
        let xid = s(data, "xid");
        if whitelist && name.ends_with("-allowed") {
            f.db.execute(
                "INSERT INTO xid_whitelist(owner,xid,zid) VALUES(1,$1,2)",
                &[&xid],
            )
            .unwrap();
        }
        let authorization = evidence["credential"]
            .as_str()
            .map(|s| format!("Bearer {s}"));
        let mut lookup = plain_lookup();
        let mut check = Check {
            db: &mut lookup,
            admin_uids: &[],
        };
        let verified = authorization.as_ref().map(|s| {
            verifier
                .verify_for_request(s, conversation, xid, 1_700_000_000, &mut check)
                .unwrap_or_else(|e| panic!("recorded credential refused: {name}: {e:?}"))
                .unwrap_or_else(|| panic!("recorded credential did not verify: {name}"))
        });
        let identity = if let Some(identity) = verified.as_ref() {
            Identity::from_verified(identity, Zid(zid))
        } else if let Some(xid) = xid {
            Identity::Xid { xid, uid: None }
        } else {
            Identity::Anonymous
        };
        let mut r = request(identity);
        r.zid = Zid(zid);
        r.entry = Entry::Participation {
            create_if_missing: wire_request["method"] != "GET",
        };
        let raw = openssl::base64::decode_block(evidence["raw"]["body_base64"].as_str().unwrap())
            .unwrap();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        if name == "treevite-accept" {
            let l = &rows(after, "treevite_login_codes")[0];
            r.entry = Entry::Invite {
                code: "generated-invite",
                recovery: PreparedRecovery {
                    code: body["login_code"].as_str().unwrap(),
                    bcrypt_hash: s(l, "login_code_hash").unwrap(),
                    lookup: s(l, "login_code_lookup").unwrap(),
                    fingerprint_key: b"generated-identity-fingerprint",
                },
            };
        } else if name == "treevite-used-invite" {
            r.entry = Entry::Invite {
                code: "generated-invite",
                recovery: PreparedRecovery {
                    code: "unused",
                    bcrypt_hash: "unused",
                    lookup: "unused",
                    fingerprint_key: b"unused",
                },
            };
        } else if name == "treevite-login" {
            let l = &rows(before, "treevite_login_codes")[0];
            r.entry = Entry::Login(VerifiedLogin {
                lookup: s(l, "login_code_lookup").unwrap(),
                bcrypt_hash: s(l, "login_code_hash").unwrap(),
            });
        } else if name == "treevite-invalid-login" {
            r.entry = Entry::Login(VerifiedLogin {
                lookup: "invalid",
                bcrypt_hash: "invalid",
            });
        }
        let result = admit(&mut f.db, &r);
        if let Err(Error::Refused(refusal)) = result {
            assert_eq!(evidence["raw"]["status"], refusal.status, "{name}");
            assert_eq!(
                raw,
                format!(
                    "{{\"error\":\"{0}\",\"message\":\"{0}\",\"status\":{1}}}",
                    refusal.code, refusal.status
                )
                .as_bytes(),
                "{name}"
            );
        } else {
            let admitted = result.unwrap();
            assert!(evidence["raw"]["status"].as_u64().unwrap() < 300, "{name}");
            if let Some(p) = admitted {
                assert_eq!(evidence["proof"]["users"], i32::from(p.new_user), "{name}");
                assert_eq!(
                    evidence["proof"]["participants"],
                    i32::from(p.new_participant),
                    "{name}"
                );
                if let Some(token) = body["auth"]["token"].as_str() {
                    let mut lookup = plain_lookup();
                    let mut check = Check {
                        db: &mut lookup,
                        admin_uids: &[],
                    };
                    let expected = verifier
                        .verify_for_request(
                            &format!("Bearer {token}"),
                            conversation,
                            None,
                            1_700_000_000,
                            &mut check,
                        )
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        (Some(p.uid), Some(p.pid)),
                        (expected.uid(), expected.pid()),
                        "{name}"
                    );
                }
            }
        }
        for (table, columns) in [
            ("users", vec!["uid", "is_owner", "site_owner"]),
            ("participants", vec!["zid", "uid", "pid"]),
            ("participants_extended", vec!["zid", "uid"]),
            (
                "xids",
                vec![
                    "owner",
                    "uid",
                    "xid",
                    "zid",
                    "pid",
                    "x_name",
                    "x_email",
                    "x_profile_image_url",
                ],
            ),
            (
                "treevite_invites",
                vec!["zid", "status", "invite_used_by_pid"],
            ),
            (
                "treevite_login_codes",
                vec![
                    "zid",
                    "pid",
                    "login_code_hash",
                    "login_code_lookup",
                    "login_code_fingerprint",
                    "revoked",
                ],
            ),
        ] {
            assert_eq!(
                projection(&mut f.db, table, &columns),
                expected(after, table, &columns),
                "{name}: {table}"
            );
        }
        count += 1;
    }
    assert_eq!(count, 31);
}

#[test]
fn recorded_node_partial_states_are_explicit_deltas() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../server/__tests__/fixtures/identity/recordings.json"
    ))
    .unwrap();
    for (name, node_users, node_members) in [
        ("treevite-refused-first-join", 1, 0),
        ("xid-upsert-failure", 1, 1),
    ] {
        let e = rows(&fixture, "evidence")
            .iter()
            .find(|e| e["case"] == name)
            .unwrap();
        assert_eq!(e["proof"]["users"], json!(node_users));
        assert_eq!(e["proof"]["participants"], json!(node_members));
        let mut f = Fixture::new();
        let r = if name == "treevite-refused-first-join" {
            f.db.batch_execute("UPDATE conversations SET treevite_enabled=true")
                .unwrap();
            request(Identity::Anonymous)
        } else {
            f.db.batch_execute("ALTER TABLE xids ADD CONSTRAINT injected_failure CHECK(false)")
                .unwrap();
            request(Identity::Xid {
                xid: "generated-retry-xid",
                uid: None,
            })
        };
        assert!(admit(&mut f.db, &r).is_err());
        f.assert_clean();
    }
}
