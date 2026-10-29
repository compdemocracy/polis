#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::http::Headers;
#[cfg(feature = "db-tests")]
use crate::votes::VoteChoice;

fn req(body: &str) -> Request {
    Request {
        method: "POST".into(),
        target: PATH.into(),
        headers: Headers::from_raw([
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
        ]),
        body: body.as_bytes().to_vec(),
    }
}

#[test]
fn unsupported_shapes_are_handed_back_before_identity_or_database_work() {
    for body in [
        "{}",
        "[]",
        r#"{"conversation_id":"a","xid":"external"}"#,
        r#"{"conversation_id":"a","pid":0}"#,
        r#"{"conversation_id":"a","unknown":true}"#,
        r#"{"conversation_id":"a/b"}"#,
    ] {
        assert!(request(&req(body)).is_none());
    }
    let body = r#"{"conversation_id":"a","tid":0,"vote":null}"#;
    assert!(request(&req(body)).is_some());
    let mut r = req(body);
    r.method = "GET".into();
    assert!(request(&r).is_none());
    r.method = "POST".into();
    r.target.push_str("?xid=external");
    assert!(request(&r).is_none());
}

#[cfg(all(feature = "db-tests", feature = "fixture-clock"))]
#[path = "post_votes_replay.rs"]
mod replay;

#[cfg(feature = "db-tests")]
mod database {
    use super::*;
    use postgres::NoTls;
    use std::sync::Barrier;

    /// A separately owned database uses the published table definitions and
    /// rule, rather than mocking the append or latest-state SQL.
    pub(super) struct Database {
        admin: Client,
        name: String,
        pub(super) config: postgres::Config,
    }
    impl Database {
        pub(super) fn new(label: &str) -> Self {
            let mut config: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
                .unwrap()
                .parse()
                .unwrap();
            let mut admin = config.connect(NoTls).unwrap();
            let name = format!("post_votes_{label}_{}", std::process::id());
            // An optional, fully migrated disposable template exercises the
            // current release in addition to the recorded Node baseline.
            let template = std::env::var("POLIS_API_VOTE_TEST_TEMPLATE").ok();
            let create = if let Some(template) = &template {
                assert!(
                    template
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                );
                format!("CREATE DATABASE {name} TEMPLATE {template}")
            } else {
                format!("CREATE DATABASE {name}")
            };
            admin.batch_execute(&create).unwrap();
            config.dbname(&name);
            let db = Self {
                admin,
                name,
                config,
            };
            if template.is_some() {
                return db;
            }
            let mut c = db.connect();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000000_initial.sql"
            ))
            .unwrap();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000006_update_votes_rule.sql"
            ))
            .unwrap();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000008_add_comment_priority.sql"
            ))
            .unwrap();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000016_add_orig_id.sql"
            ))
            .unwrap();
            c.batch_execute(
                "ALTER TABLE conversations ADD treevite_enabled boolean DEFAULT false;
                ALTER TABLE conversations ADD xid_required boolean DEFAULT false;",
            )
            .unwrap();
            db
        }
        pub(super) fn connect(&self) -> Client {
            self.config.connect(NoTls).unwrap()
        }
    }
    impl Drop for Database {
        fn drop(&mut self) {
            self.admin
                .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
                .unwrap();
        }
    }
    pub(super) fn wait_for_query(c: &mut Client, sql: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !c.query_one(sql, &[]).unwrap().get::<_, bool>(0) {
            assert!(
                std::time::Instant::now() < deadline,
                "database event not observed: {sql}"
            );
            std::thread::yield_now();
        }
    }

    pub(super) fn unbounded_key_wait(db: &Database) {
        // These tests prove serialization once a transaction reaches the key.
        // The fixture removes only its lock-wait cutoff, so a delayed observer
        // cannot turn the intended overlap into a legitimate overload rejection.
        // Keep the full append/commit path and the real history/latest rule.
        db.connect()
            .batch_execute(
                "CREATE FUNCTION test_key_wait() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                PERFORM set_config('lock_timeout', '0', true);
                RETURN NEW;
            END $$;
            CREATE TRIGGER test_key_wait BEFORE INSERT ON votes_latest_unique
            FOR EACH ROW EXECUTE FUNCTION test_key_wait();",
            )
            .unwrap();
    }

    pub(super) fn fields(choice: VoteChoice) -> ParsedFields {
        ParsedFields {
            tid: 7.0,
            vote: choice,
            starred: None,
            high_priority: false,
            lang: None,
        }
    }
    pub(super) fn actor() -> Admitted {
        Admitted {
            zid: 1,
            pid: 0,
            uid: 1,
            active: true,
        }
    }

    #[test]
    fn append_preserves_sign_history_latest_weight_and_rollback() {
        let db = Database::new("transaction");
        let mut c = db.connect();
        let a = actor();
        for (choice, replayed, expected_count) in [
            (VoteChoice::Agree, false, 1_i64),
            (VoteChoice::Agree, true, 1),
            (VoteChoice::Disagree, false, 2),
            (VoteChoice::Disagree, true, 2),
            (VoteChoice::Pass, false, 3),
        ] {
            assert_eq!(
                append(&mut c, &a, &fields(choice)).unwrap().replayed,
                replayed
            );
            assert_eq!(
                c.query_one("select count(*) from votes", &[])
                    .unwrap()
                    .get::<_, i64>(0),
                expected_count
            );
            let value: i16 = c
                .query_one("select vote from votes_latest_unique", &[])
                .unwrap()
                .get(0);
            assert_eq!(i32::from(value), contract::stored_vote(choice));
        }
        let count: i64 = c
            .query_one("select count(*) from votes", &[])
            .unwrap()
            .get(0);
        assert_eq!(count, 3);
        c.batch_execute("UPDATE votes_latest_unique SET weight_x_32767=42;
            CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 10::bigint'").unwrap();
        let created = append(&mut c, &a, &fields(VoteChoice::Agree)).unwrap();
        assert_eq!(created.created, 10);
        let latest = c
            .query_one(
                "select vote,modified,weight_x_32767 from votes_latest_unique",
                &[],
            )
            .unwrap();
        assert_eq!(
            i32::from(latest.get::<_, i16>(0)),
            contract::stored_vote(VoteChoice::Agree)
        );
        assert_eq!(
            latest.get::<_, i64>(1),
            10,
            "older timestamps still replace latest"
        );
        assert_eq!(latest.get::<_, i16>(2), 42, "latest weight is retained");
        let mut tx = c.transaction().unwrap();
        append_in_transaction(&mut tx, &a, &fields(VoteChoice::Pass)).unwrap();
        tx.rollback().unwrap();
        assert_eq!(
            c.query_one("select count(*) from votes", &[])
                .unwrap()
                .get::<_, i64>(0),
            4
        );
        assert_eq!(
            i32::from(
                c.query_one("select vote from votes_latest_unique", &[])
                    .unwrap()
                    .get::<_, i16>(0)
            ),
            contract::stored_vote(VoteChoice::Agree)
        );
    }

    #[test]
    fn two_writers_append_same_key_without_losing_history_or_latest() {
        let db = Database::new("concurrent");
        unbounded_key_wait(&db);
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = [VoteChoice::Agree, VoteChoice::Disagree]
            .into_iter()
            .map(|choice| {
                let mut c = db.connect();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..25)
                        .filter(|_| !append(&mut c, &actor(), &fields(choice)).unwrap().replayed)
                        .count()
                })
            })
            .collect();
        let appended: usize = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .sum();
        let mut c = db.connect();
        let row = c
            .query_one("select count(*),count(distinct vote) from votes", &[])
            .unwrap();
        assert_eq!(row.get::<_, i64>(0), appended as i64);
        assert!((2..=50).contains(&appended));
        assert_eq!(row.get::<_, i64>(1), 2);
        assert_eq!(
            c.query_one("select count(*) from votes_latest_unique", &[])
                .unwrap()
                .get::<_, i64>(0),
            1
        );
        let mut important = fields(VoteChoice::Pass);
        important.high_priority = true;
        assert!(!append(&mut c, &actor(), &important).unwrap().replayed);
        assert!(
            c.query_one(
                "select high_priority from votes order by ctid desc limit 1",
                &[]
            )
            .unwrap()
            .get::<_, bool>(0)
        );
    }
}

#[cfg(feature = "db-tests")]
#[path = "post_votes_safety_tests.rs"]
mod safety;
