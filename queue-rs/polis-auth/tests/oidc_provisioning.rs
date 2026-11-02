//! Real migrated PostgreSQL, including the production users defaults and both
//! mapping uniqueness constraints. No votes, comments, routes or Node changes.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use polis_auth::{
    Uid,
    observability::Counters,
    oidc::{self, Error, Profile},
    provider::{Settings, Verifier},
};
use postgres::{Client, Config, NoTls};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

struct Db {
    db: Client,
    admin: Client,
    config: Config,
    name: String,
}
impl Db {
    fn new() -> Self {
        let url = std::env::var("POLIS_AUTH_TEST_DATABASE_URL")
            .expect("db-tests requires a disposable PostgreSQL");
        let mut config: Config = url.parse().unwrap();
        let mut admin = config.connect(NoTls).unwrap();
        let name = format!("oidc_{}", std::process::id());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        config.dbname(&name);
        let mut db = config.connect(NoTls).unwrap();
        let release = polis_migrate::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/postgres/migrations"),
        )
        .unwrap();
        polis_migrate::apply(&mut db, &release).unwrap();
        Self {
            db,
            admin,
            config,
            name,
        }
    }
    fn connect(&self) -> Client {
        let mut c = self.config.connect(NoTls).unwrap();
        c.batch_execute("SET application_name='oidc_race_test'")
            .unwrap();
        c
    }
    fn reset(&mut self) {
        self.db
            .batch_execute("TRUNCATE users CASCADE; ALTER SEQUENCE users_uid_seq RESTART WITH 1")
            .unwrap();
    }
    fn counts(&mut self) -> (i64, i64) {
        let r = self
            .db
            .query_one(
                "SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM oidc_user_mappings)",
                &[],
            )
            .unwrap();
        (r.get(0), r.get(1))
    }
}
impl Drop for Db {
    fn drop(&mut self) {
        let _ = self
            .admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name));
    }
}
fn profile(sub: &str, email: &str, name: &str) -> Profile {
    Profile::from_verified_claims(&json!({"sub":sub,"email":email,"name":name,"nickname":name,"email_verified":true,"ns/delphi_enabled":true}),"ns/").unwrap()
}
fn counter(c: &Counters, label: &str) -> u64 {
    c.snapshot().find(|(k, _)| *k == label).unwrap().1
}

#[test]
fn migrated_postgres_first_repeat_conflict_race_rollback_and_node_recordings() {
    let mut f = Db::new();
    let counters = Counters::new();
    let p = profile("subject", "first@example.invalid", "First");
    let uid = oidc::provision(&mut f.db, &p, &counters).unwrap();
    let r =
        f.db.query_one(
            "SELECT email,hname,username,is_owner,site_id,site_owner FROM users WHERE uid=$1",
            &[&uid.0],
        )
        .unwrap();
    assert_eq!(r.get::<_, String>(0), p.email);
    assert_eq!(r.get::<_, String>(1), "First");
    assert_eq!(r.get::<_, String>(2), "First");
    assert!(r.get::<_, bool>(3));
    assert!(r.get::<_, String>(4).starts_with("polis_site_id_"));
    assert!(r.get::<_, bool>(5));
    assert_eq!(f.counts(), (1, 1));
    assert_eq!(
        oidc::provision(
            &mut f.db,
            &profile("subject", "changed@example.invalid", "Changed"),
            &counters
        ),
        Ok(uid)
    );
    assert_eq!(
        f.db.query_one("SELECT hname FROM users WHERE uid=$1", &[&uid.0])
            .unwrap()
            .get::<_, String>(0),
        "First"
    );
    assert_eq!(counter(&counters, "users_created_oidc"), 1);
    assert_eq!(
        oidc::provision(
            &mut f.db,
            &profile("new-social", &p.email, "Social"),
            &counters
        ),
        Ok(uid)
    );
    assert_eq!(
        f.db.query_one(
            "SELECT oidc_sub FROM oidc_user_mappings WHERE uid=$1",
            &[&uid.0]
        )
        .unwrap()
        .get::<_, String>(0),
        "new-social"
    );
    assert_eq!(
        f.db.query_one("SELECT hname FROM users WHERE uid=$1", &[&uid.0])
            .unwrap()
            .get::<_, String>(0),
        "Social"
    );
    assert_eq!(f.counts(), (1, 1));
    assert_eq!(counter(&counters, "users_created_oidc"), 1);
    // Existing email conflicts preserve a non-owner's privileges and site.
    f.db.execute("INSERT INTO users(email,is_owner,site_id) VALUES('existing@example.invalid',false,'shared-site')",&[]).unwrap();
    let existing = oidc::provision(
        &mut f.db,
        &profile("existing", "existing@example.invalid", "Renamed"),
        &counters,
    )
    .unwrap();
    let r =
        f.db.query_one(
            "SELECT is_owner,site_id,hname,username FROM users WHERE uid=$1",
            &[&existing.0],
        )
        .unwrap();
    assert!(!r.get::<_, bool>(0));
    assert_eq!(r.get::<_, String>(1), "shared-site");
    assert_eq!(r.get::<_, String>(2), "Renamed");
    assert_eq!(r.get::<_, String>(3), "Renamed");

    for different_emails in [false, true] {
        f.reset();
        let mut blocker = f.connect();
        let mut held = blocker.transaction().unwrap();
        held.batch_execute("LOCK TABLE users IN SHARE MODE")
            .unwrap();
        let cs = [f.connect(), f.connect()];
        let shared = Arc::new(Counters::new());
        let threads: Vec<_> = cs
            .into_iter()
            .enumerate()
            .map(|(i, mut c)| {
                let shared = shared.clone();
                std::thread::spawn(move || {
                    oidc::provision(
                        &mut c,
                        &profile(
                            "same-sub",
                            if different_emails && i == 1 {
                                "b@example.invalid"
                            } else {
                                "a@example.invalid"
                            },
                            "Race",
                        ),
                        &shared,
                    )
                })
            })
            .collect();
        // Both calls have missed the mapping and reached INSERT before release.
        let start = std::time::Instant::now();
        loop {
            let n:i64=f.db.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='oidc_race_test' AND wait_event_type='Lock'",&[]).unwrap().get(0);
            if n == 2 {
                break;
            }
            assert!(start.elapsed() < std::time::Duration::from_secs(3));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        held.commit().unwrap();
        let results: Vec<_> = threads
            .into_iter()
            .map(|t| t.join().unwrap().unwrap())
            .collect();
        assert_eq!(results[0], results[1]);
        assert_eq!(f.counts(), (1, 1));
        assert_eq!(counter(&shared, "users_created_oidc"), 1);
        if different_emails {
            assert_eq!(counter(&shared, "retries_23505"), 1);
        }
    }
    // Failure after account creation rolls back both rows; replacement failure
    // also restores the old names/mapping. Deferred COMMIT failure is distinct.
    f.reset();
    f.db.batch_execute("CREATE FUNCTION fail_oidc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test mapping failure'; END $$; CREATE TRIGGER fail_oidc BEFORE INSERT ON oidc_user_mappings FOR EACH ROW EXECUTE FUNCTION fail_oidc()").unwrap();
    assert_eq!(
        oidc::provision(&mut f.db, &p, &counters),
        Err(Error::Unavailable)
    );
    assert_eq!(f.counts(), (0, 0));
    f.db.batch_execute("DROP TRIGGER fail_oidc ON oidc_user_mappings")
        .unwrap();
    let uid = oidc::provision(&mut f.db, &p, &counters).unwrap();
    f.db.batch_execute("CREATE TRIGGER fail_oidc BEFORE INSERT ON oidc_user_mappings FOR EACH ROW EXECUTE FUNCTION fail_oidc()").unwrap();
    assert_eq!(
        oidc::provision(
            &mut f.db,
            &profile("replacement", &p.email, "Replacement"),
            &counters
        ),
        Err(Error::Unavailable)
    );
    let r=f.db.query_one("SELECT u.hname,m.oidc_sub FROM users u JOIN oidc_user_mappings m USING(uid) WHERE uid=$1",&[&uid.0]).unwrap();
    assert_eq!(r.get::<_, String>(0), "First");
    assert_eq!(r.get::<_, String>(1), "subject");
    f.db.batch_execute("DROP TRIGGER fail_oidc ON oidc_user_mappings; CREATE CONSTRAINT TRIGGER fail_oidc AFTER INSERT ON oidc_user_mappings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_oidc()").unwrap();
    assert_eq!(
        oidc::provision(
            &mut f.db,
            &profile("commit", "commit@example.invalid", "Commit"),
            &counters
        ),
        Err(Error::CommitUnknown)
    );
    assert_eq!(f.counts(), (1, 1));
    f.db.batch_execute("DROP TRIGGER fail_oidc ON oidc_user_mappings; DROP FUNCTION fail_oidc()")
        .unwrap();
    replay_committed_node(&mut f);
    replay_profile_recordings(&mut f);
}

fn replay_committed_node(f: &mut Db) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../server/__tests__/fixtures/identity/recordings.json"
    ))
    .unwrap();
    let (verifier, _) = Verifier::from_snapshot(
        Settings {
            issuer: "https://oidc-simulator:3000/".into(),
            audience: "users".into(),
            namespace: "https://pol.is/".into(),
            jwks_uri: "http://127.0.0.1:1/unused".into(),
        },
        &serde_json::to_vec(&fixture["provider_jwks"]).unwrap(),
        Arc::new(Counters::new()),
    )
    .unwrap();
    let mut compared = 0;
    for evidence in fixture["evidence"].as_array().unwrap() {
        let case = evidence["case"].as_str().unwrap();
        if !["oidc-first-use", "oidc-repeat", "oidc-missing-email"].contains(&case) {
            continue;
        }
        f.reset();
        for u in evidence["before"]["users"].as_array().unwrap() {
            f.db.execute("INSERT INTO users(uid,email,hname,username,is_owner,site_id,site_owner,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",&[&(u["uid"].as_i64().unwrap() as i32),&u["email"].as_str(),&u["hname"].as_str(),&u["username"].as_str(),&u["is_owner"].as_bool(),&u["site_id"].as_str(),&u["site_owner"].as_bool(),&u["created"].as_i64()]).unwrap();
        }
        for m in evidence["before"]["oidc_user_mappings"].as_array().unwrap() {
            f.db.execute(
                "INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES($1,$2,$3)",
                &[
                    &m["oidc_sub"].as_str(),
                    &(m["uid"].as_i64().unwrap() as i32),
                    &m["created"].as_i64(),
                ],
            )
            .unwrap();
        }
        f.db.batch_execute("SELECT setval('users_uid_seq',(SELECT max(uid) FROM users))")
            .unwrap();
        let claims = verifier
            .verify_at(
                &format!("Bearer {}", evidence["credential"].as_str().unwrap()),
                1_700_000_000,
            )
            .unwrap();
        let p = Profile::from_verified_claims(&claims, verifier.namespace());
        if case == "oidc-missing-email" {
            assert!(matches!(p, Err(Error::InvalidUserData)));
            continue;
        }
        let p = p.unwrap();
        let uid = oidc::provision(&mut f.db, &p, &Counters::new()).unwrap();
        let expected = evidence["after"]["oidc_user_mappings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["oidc_sub"] == p.subject)
            .unwrap();
        assert_eq!(uid, Uid(expected["uid"].as_i64().unwrap() as i32));
        // Exact JSON bytes for deterministic account fields. The database clock
        // and random site_id are checked structurally instead of normalized away.
        let expected = evidence["after"]["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["uid"] == uid.0)
            .unwrap();
        let actual:Value=serde_json::from_str(&f.db.query_one("SELECT row_to_json(r)::text FROM (SELECT uid,email,hname,username,is_owner,site_owner FROM users WHERE uid=$1) r",&[&uid.0]).unwrap().get::<_,String>(0)).unwrap();
        let expected: Value = [
            "uid",
            "email",
            "hname",
            "username",
            "is_owner",
            "site_owner",
        ]
        .into_iter()
        .map(|k| (k.to_string(), expected[k].clone()))
        .collect::<serde_json::Map<_, _>>()
        .into();
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
        let row =
            f.db.query_one("SELECT site_id,created FROM users WHERE uid=$1", &[&uid.0])
                .unwrap();
        assert!(row.get::<_, String>(0).starts_with("polis_site_id_"));
        assert!(row.get::<_, i64>(1) > 0);
        assert_eq!(
            f.counts(),
            (
                evidence["after"]["users"].as_array().unwrap().len() as i64,
                evidence["after"]["oidc_user_mappings"]
                    .as_array()
                    .unwrap()
                    .len() as i64
            )
        );
        compared += 1;
    }
    assert_eq!(compared, 2);
}

fn replay_profile_recordings(f: &mut Db) {
    use sha2::{Digest, Sha256};
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/oidc-provisioning.json")).unwrap();
    let digest = Sha256::digest(include_bytes!("../../../server/src/auth/create-user.ts"));
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        fixture["source_sha256"], hex,
        "re-record if the Node function changes"
    );
    fn snapshot(db: &mut Client) -> Value {
        let users:Vec<Value>=db.query("SELECT row_to_json(r)::text FROM (SELECT uid,email,hname,username,is_owner,site_owner,CASE WHEN site_id LIKE 'polis_site_id_%' THEN '<default>' ELSE site_id END AS site_id,created>0 AS created FROM users ORDER BY uid) r",&[]).unwrap().iter().map(|r|serde_json::from_str(&r.get::<_,String>(0)).unwrap()).collect();
        let mappings:Vec<Value>=db.query("SELECT row_to_json(r)::text FROM (SELECT oidc_sub,uid,created>0 AS created FROM oidc_user_mappings ORDER BY oidc_sub) r",&[]).unwrap().iter().map(|r|serde_json::from_str(&r.get::<_,String>(0)).unwrap()).collect();
        json!({"users":users,"mappings":mappings})
    }
    let mut compared = 0;
    for case in fixture["cases"].as_array().unwrap() {
        f.reset();
        if let Some(seed) = case.get("seed") {
            let uid:i32=f.db.query_one("INSERT INTO users(email,hname,username,is_owner,site_id) VALUES($1,$2,$3,$4,$5) RETURNING uid",&[&seed["email"].as_str(),&seed["hname"].as_str(),&seed["username"].as_str(),&seed["is_owner"].as_bool(),&seed["site_id"].as_str()]).unwrap().get(0);
            if let Some(sub) = seed.get("sub") {
                f.db.execute(
                    "INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES($1,$2)",
                    &[&sub.as_str(), &uid],
                )
                .unwrap();
            }
        }
        assert_eq!(snapshot(&mut f.db), case["before"]);
        for (claims, expected) in case["steps"]
            .as_array()
            .unwrap()
            .iter()
            .zip(case["results"].as_array().unwrap())
        {
            let result = Profile::from_verified_claims(claims, "ns/")
                .and_then(|p| oidc::provision(&mut f.db, &p, &Counters::new()));
            let (uid, error) = match result {
                Ok(uid) => (Some(uid.0), None),
                Err(Error::InvalidUserData) => (None, Some("invalid_user_data")),
                Err(e) => panic!("unexpected {e:?}"),
            };
            let actual = json!({"uid":uid,"error":error,"after":snapshot(&mut f.db)});
            assert_eq!(
                serde_json::to_vec(&actual).unwrap(),
                serde_json::to_vec(expected).unwrap(),
                "{}",
                case["name"]
            );
            compared += 1;
        }
    }
    assert_eq!(compared, 13);
}
