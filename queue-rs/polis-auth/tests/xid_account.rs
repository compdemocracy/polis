#![allow(clippy::unwrap_used)]
use polis_auth::{
    Uid, Unavailable,
    observability::Counters,
    xid_account::{Account, Check, Class, Refusal, classify},
};

fn check(account: Account, expected: Class) {
    assert_eq!(classify(account, false), Some(expected));
    let counters = Counters::new();
    let mut db = |_| Ok(Some(account));
    let refusal = Check {
        db: &mut db,
        admin_uids: &[],
    }
    .require_participant(Uid(3))
    .unwrap_err();
    assert_eq!(refusal, Refusal::Privileged(expected));
    assert!(counters.snapshot().all(|(_, n)| n == 0));
    let response = refusal.into_response(&counters);
    assert_eq!(response.status, 403);
    assert_eq!(
        response.body,
        r#"{"error":"polis_err_xid_owner_account","message":"polis_err_xid_owner_account","status":403}"#
    );
    let counts: Vec<_> = counters.snapshot().filter(|(_, n)| *n > 0).collect();
    assert_eq!(
        counts,
        vec![(format!("xid.refused.{}", expected.label()).as_str(), 1)]
    );
}
#[test]
fn admin_precedes_every_class_and_bypasses_database() {
    let all = Account {
        owns_conversation: true,
        is_owner: true,
        site_moderator: true,
        oidc_mapped: true,
    };
    assert_eq!(classify(all, true), Some(Class::Admin));
    let mut db = |_| -> Result<Option<Account>, Unavailable> { panic!("admin must not query") };
    let error = Check {
        db: &mut db,
        admin_uids: &[Uid(3)],
    }
    .require_participant(Uid(3))
    .unwrap_err();
    let counters = Counters::new();
    assert_eq!(error, Refusal::Privileged(Class::Admin));
    assert_eq!(error.into_response(&counters).status, 403);
    assert_eq!(
        counters
            .snapshot()
            .find(|(label, _)| *label == "xid.refused.admin")
            .unwrap()
            .1,
        1
    );
}
#[test]
fn conversation_owner_precedes_flag_site_and_oidc() {
    check(
        Account {
            owns_conversation: true,
            is_owner: true,
            site_moderator: true,
            oidc_mapped: true,
        },
        Class::ConversationOwner,
    );
}
#[test]
fn owner_flag_precedes_site_and_oidc() {
    check(
        Account {
            is_owner: true,
            site_moderator: true,
            oidc_mapped: true,
            ..Account::default()
        },
        Class::OwnerFlag,
    );
}
#[test]
fn site_moderator_precedes_oidc() {
    check(
        Account {
            site_moderator: true,
            oidc_mapped: true,
            ..Account::default()
        },
        Class::SiteModerator,
    );
}
#[test]
fn oidc_mapping_is_refused() {
    check(
        Account {
            oidc_mapped: true,
            ..Account::default()
        },
        Class::OidcMapped,
    );
}
#[test]
fn plain_and_missing_accounts_are_admitted() {
    for account in [None, Some(Account::default())] {
        let mut db = |_| Ok(account);
        assert_eq!(
            Check {
                db: &mut db,
                admin_uids: &[]
            }
            .require_participant(Uid(3)),
            Ok(())
        );
    }
}
#[test]
fn database_failure_is_closed_with_nodes_500_and_one_counter() {
    let mut db = |_| Err(Unavailable);
    let error = Check {
        db: &mut db,
        admin_uids: &[],
    }
    .require_participant(Uid(3))
    .unwrap_err();
    assert_eq!(error, Refusal::CheckFailed);
    let counters = Counters::new();
    let response = error.into_response(&counters);
    assert_eq!(response.status, 500);
    assert_eq!(
        response.body,
        r#"{"error":"polis_err_participant_creation","message":"polis_err_participant_creation","status":500}"#
    );
    assert_eq!(
        counters
            .snapshot()
            .filter(|(_, n)| *n > 0)
            .collect::<Vec<_>>(),
        vec![("xid.refused.check_failed", 1)]
    );
}

#[test]
#[cfg(feature = "db-tests")]
fn real_tables_match_node_including_empty_sites_and_privilege_changes() {
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use polis_auth::{PostgresLookup, participant::Verifier};
    let mut db = postgres::Client::connect(
        &std::env::var("POLIS_AUTH_TEST_DATABASE_URL").unwrap(),
        postgres::NoTls,
    )
    .unwrap();
    let mut tx = db.transaction().unwrap();
    tx.batch_execute("SET LOCAL statement_timeout = '3s'; SET LOCAL lock_timeout = '1s'")
        .unwrap();
    // These are the migrated public tables, not a reduced replacement schema.
    let mut ids = Vec::new();
    for i in 0..8 {
        let site = format!("xid-rule-site-{}-{i}", std::process::id());
        ids.push(
            tx.query_one(
                "INSERT INTO users (site_id, is_owner) VALUES ($1, false) RETURNING uid",
                &[&site],
            )
            .unwrap()
            .get::<_, i32>(0),
        );
    }
    let owner = ids[0];
    tx.execute("INSERT INTO conversations (owner) VALUES ($1)", &[&owner])
        .unwrap();
    tx.execute(
        "UPDATE users SET is_owner = true WHERE uid = $1",
        &[&ids[1]],
    )
    .unwrap();
    tx.execute(
        "UPDATE users SET site_id = (SELECT site_id FROM users WHERE uid = $1) WHERE uid = $2",
        &[&owner, &ids[2]],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO oidc_user_mappings (oidc_sub, uid) VALUES ($1, $2)",
        &[
            &format!("generated-xid-rule-{}", std::process::id()),
            &ids[3],
        ],
    )
    .unwrap();
    for (uid, expected) in [
        (owner, Some(Class::ConversationOwner)),
        (ids[1], Some(Class::OwnerFlag)),
        (ids[2], Some(Class::SiteModerator)),
        (ids[3], Some(Class::OidcMapped)),
        (ids[4], Some(Class::Admin)),
        (ids[5], None),
    ] {
        assert_eq!(
            Check {
                db: &mut PostgresLookup(&mut tx),
                admin_uids: &[Uid(ids[4])]
            }
            .xid_account_class(Uid(uid))
            .unwrap(),
            expected
        );
    }
    tx.execute(
        "UPDATE users SET site_id = CASE WHEN uid = $2 THEN 'generated-Site' ELSE 'generated-site' END WHERE uid = ANY($1)",
        &[&vec![owner, ids[2]], &owner],
    )
    .unwrap();
    assert_eq!(
        Check {
            db: &mut PostgresLookup(&mut tx),
            admin_uids: &[]
        }
        .xid_account_class(Uid(ids[2]))
        .unwrap(),
        None
    );
    tx.execute(
        "UPDATE users SET site_id = '' WHERE uid = ANY($1)",
        &[&vec![owner, ids[2]]],
    )
    .unwrap();
    assert_eq!(
        Check {
            db: &mut PostgresLookup(&mut tx),
            admin_uids: &[]
        }
        .xid_account_class(Uid(ids[2]))
        .unwrap(),
        Some(Class::SiteModerator)
    );
    // An already issued token must be refused after a privilege change, even
    // when crossing conversations or replacing the request XID drops its UID.
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let verifier = Verifier::new(&rsa.public_key_to_pem().unwrap(), "issuer", "audience").unwrap();
    let claims = serde_json::json!({"uid":ids[5],"pid":0,"conversation_id":"original","sub":"xid:generated","xid":"generated","xid_participant":true,"iss":"issuer","aud":"audience","iat":100,"exp":200});
    let token = format!(
        "Bearer {}",
        encode(
            &Header::new(Algorithm::RS256),
            &claims,
            &EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap()
        )
        .unwrap()
    );
    assert!(
        verifier
            .verify_for_request(
                &token,
                "original",
                None,
                150,
                &mut Check {
                    db: &mut PostgresLookup(&mut tx),
                    admin_uids: &[]
                }
            )
            .unwrap()
            .is_some()
    );
    tx.execute(
        "UPDATE users SET is_owner = true WHERE uid = $1",
        &[&ids[5]],
    )
    .unwrap();
    for (conversation, xid) in [
        ("original", None),
        ("other", None),
        ("original", Some("replacement")),
    ] {
        assert!(matches!(
            verifier.verify_for_request(
                &token,
                conversation,
                xid,
                150,
                &mut Check {
                    db: &mut PostgresLookup(&mut tx),
                    admin_uids: &[]
                }
            ),
            Err(Refusal::Privileged(Class::OwnerFlag))
        ));
    }
    tx.batch_execute("SET LOCAL search_path = pg_catalog")
        .unwrap();
    assert_eq!(
        Check {
            db: &mut PostgresLookup(&mut tx),
            admin_uids: &[]
        }
        .require_participant(Uid(ids[5])),
        Err(Refusal::CheckFailed)
    );
    tx.rollback().unwrap();
}

#[test]
fn recorded_node_refusals_and_admitted_tokens_match_the_foundation() {
    use polis_auth::participant::Verifier;
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../polis-contracts/tests/fixtures/xid-account.json"
    ))
    .unwrap();
    let verifier = Verifier::new(
        fixture["public_key"].as_str().unwrap().as_bytes(),
        "https://pol.is/",
        "participants",
    )
    .unwrap();
    let now = fixture["now"].as_u64().unwrap();
    let conversation = fixture["conversation"].as_str().unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let uid = Uid(case["uid"].as_i64().unwrap() as i32);
        let class = case["account_class"].as_str().unwrap();
        let account = Account {
            owns_conversation: class == "conversation_owner",
            is_owner: class == "owner_flag",
            site_moderator: class == "site_moderator",
            oidc_mapped: class == "oidc_mapped",
        };
        let mut queries = 0;
        let mut lookup = |requested| {
            assert_eq!(requested, uid);
            queries += 1;
            Ok(Some(account))
        };
        let admins = if class == "admin" { vec![uid] } else { vec![] };
        let mut check = Check {
            db: &mut lookup,
            admin_uids: &admins,
        };
        let token = format!("Bearer {}", case["credential"].as_str().unwrap());
        let verified = verifier.verify_for_request(&token, conversation, None, now, &mut check);
        if class == "plain_participant" {
            assert_eq!(verified.unwrap().unwrap().uid(), Some(uid));
            let body: serde_json::Value =
                serde_json::from_str(case["bare"]["body"].as_str().unwrap()).unwrap();
            let issued = format!("Bearer {}", body["auth"]["token"].as_str().unwrap());
            assert_eq!(
                verifier
                    .verify_for_request(&issued, conversation, None, now, &mut check)
                    .unwrap()
                    .unwrap()
                    .uid(),
                Some(uid)
            );
        } else {
            let error = match verified {
                Err(error) => error,
                Ok(_) => panic!("privileged credential admitted"),
            };
            let counters = Counters::new();
            let response = error.into_response(&counters);
            for mode in ["bare", "existing"] {
                assert_eq!(serde_json::json!(response.status), case[mode]["status"]);
                assert_eq!(response.body, case[mode]["body"].as_str().unwrap());
            }
            assert_eq!(counters.snapshot().filter(|(_, n)| *n != 0).count(), 1);
        }
        assert_eq!(
            queries,
            if class == "admin" {
                0
            } else if class == "plain_participant" {
                2
            } else {
                1
            }
        );
    }
}
