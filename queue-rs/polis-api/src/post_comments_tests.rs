#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::http::Headers;
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
fn unsupported_requests_are_handed_back() {
    for body in [
        "{}",
        "[]",
        r#"{"conversation_id":"a","txt":"x","xid":"x"}"#,
        r#"{"conversation_id":"a","txt":"x","is_seed":true}"#,
        r#"{"conversation_id":"a","txt":"x","vote":0}"#,
        r#"{"conversation_id":"a","txt":""}"#,
        r#"{"conversation_id":"a","txt":5}"#,
    ] {
        assert!(request(&req(body)).is_none(), "{body}");
    }
    assert!(request(&req(r#"{"conversation_id":"a","txt":"ordinary"}"#)).is_some());
    let mut r = req(r#"{"conversation_id":"a","txt":"ordinary"}"#);
    r.target.push_str("?xid=x");
    assert!(request(&r).is_none());
}

#[cfg(feature = "db-tests")]
mod database {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use postgres::NoTls;
    use serde_json::{Value, json};
    pub(super) struct Database {
        admin: Client,
        name: String,
        pub config: postgres::Config,
    }
    impl Database {
        pub fn new(label: &str) -> Self {
            let mut config: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
                .unwrap()
                .parse()
                .unwrap();
            let mut admin = config.connect(NoTls).unwrap();
            let name = format!("comment_writer_{label}_{}", std::process::id());
            admin
                .batch_execute(&format!("CREATE DATABASE {name}"))
                .unwrap();
            config.dbname(&name);
            let db = Self {
                admin,
                name,
                config,
            };
            let mut c = db.connect();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000000_initial.sql"
            ))
            .unwrap();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000016_add_orig_id.sql"
            ))
            .unwrap();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000042_tid_auto_transaction_lock.sql"
            ))
            .unwrap();
            c.batch_execute("ALTER TABLE conversations ADD treevite_enabled boolean DEFAULT false;
                ALTER TABLE conversations ADD xid_required boolean DEFAULT false;
                CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 1700000000000::bigint';").unwrap();
            db.seed(&mut c);
            db
        }
        pub fn connect(&self) -> Client {
            self.config.connect(NoTls).unwrap()
        }
        pub fn seed(&self, c: &mut Client) {
            c.batch_execute("TRUNCATE users,conversations,participants,comments,zinvites,notification_tasks CASCADE;
                INSERT INTO users(uid,site_id) VALUES(1,'owner'),(3,'participant');
                INSERT INTO conversations(zid,owner,is_active) VALUES(1,1,true);
                INSERT INTO zinvites(zid,zinvite) VALUES(1,'2p027generated');
                ALTER TABLE participants DISABLE TRIGGER USER;
                INSERT INTO participants(zid,uid,pid) VALUES(1,3,2);
                ALTER TABLE participants ENABLE TRIGGER USER;
                INSERT INTO comments(zid,pid,uid,txt) VALUES(1,2,3,'existing first'),(1,2,3,'existing second');").unwrap();
        }
    }
    impl Drop for Database {
        fn drop(&mut self) {
            self.admin
                .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
                .unwrap();
        }
    }
    pub(super) fn setup(db: &Database) -> (App, EncodingKey) {
        let connector =
            || polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(db.config.clone()));
        let cfg = config::Config {
            listen: String::new(),
            math_env: "generated".into(),
            cache_size: 300,
            dev_mode: false,
            use_network_host: false,
            production: true,
            pool: limits(2, 100),
        };
        let mut app = App::new(&cfg, db::Pool::new(connector(), limits(2, 100)));
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        app.post_comments = Some(Writer {
            pool: db::Pool::writer(connector(), limits(4, 1000), Duration::from_millis(100)),
            reads: db::Pool::new(connector(), limits(2, 100)),
            background: NotificationPool::new(connector()),
            verifier: participant::Verifier::new(
                &rsa.public_key_to_pem().unwrap(),
                "fixture",
                "fixture",
            )
            .unwrap(),
            admins: vec![],
        });
        (
            app,
            EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        )
    }
    pub(super) fn signed(key: &EncodingKey, body: Value) -> Request {
        let token = encode(
            &Header::new(Algorithm::RS256),
            &json!({"uid":3,"pid":2,
            "conversation_id":"2p027generated","sub":"anon:3","iss":"fixture","aud":"fixture",
            "iat":1600000000_u64,"exp":2100000000_u64,"anonymous_participant":true}),
            key,
        )
        .unwrap();
        let mut r = req(&body.to_string());
        r.headers = Headers::from_raw([
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            ("authorization", &format!("Bearer {token}")),
        ]);
        r
    }
    pub(super) fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }
    fn body(text: &str) -> Value {
        json!({"conversation_id":"2p027generated","txt":text})
    }
    fn send(
        rt: &tokio::runtime::Runtime,
        app: &Arc<App>,
        key: &EncodingKey,
        text: &str,
    ) -> Outgoing {
        rt.block_on(route::handle(app.clone(), signed(key, body(text))))
    }
    #[test]
    fn success_duplicate_closed_and_admission_boundaries() {
        let db = Database::new("route");
        let mut c = db.connect();
        let rt = runtime();
        let (app, key) = setup(&db);
        let app = Arc::new(app);
        assert_eq!(send(&rt, &app, &key, "new ordinary").status, 200);
        assert_eq!(send(&rt, &app, &key, "new ordinary").status, 409);
        c.batch_execute("UPDATE conversations SET is_active=false")
            .unwrap();
        assert_eq!(send(&rt, &app, &key, "new ordinary").status, 409);
        assert_eq!(send(&rt, &app, &key, "closed new").status, 403);
        c.batch_execute("UPDATE conversations SET is_active=true")
            .unwrap();
        for setting in [
            "strict_moderation",
            "xid_required",
            "use_xid_whitelist",
            "treevite_enabled",
        ] {
            c.batch_execute(&format!("UPDATE conversations SET {setting}=true"))
                .unwrap();
            assert_eq!(
                send(&rt, &app, &key, "unsupported").status,
                502,
                "{setting}"
            );
            c.batch_execute(&format!("UPDATE conversations SET {setting}=false"))
                .unwrap();
        }
        c.batch_execute("UPDATE users SET site_id='owner' WHERE uid=3")
            .unwrap();
        assert_eq!(send(&rt, &app, &key, "moderator").status, 502);
        c.batch_execute("UPDATE users SET site_id='participant' WHERE uid=3; DELETE FROM comments; DELETE FROM participants").unwrap();
        assert_eq!(send(&rt, &app, &key, "first contact").status, 502);
        assert_eq!(
            c.query_one("select count(*) from comments", &[])
                .unwrap()
                .get::<_, i64>(0),
            0
        );
        assert_eq!(
            c.query_one("select count(*) from votes", &[])
                .unwrap()
                .get::<_, i64>(0),
            0
        );
        drop(app);
        drop(rt);
    }
    #[test]
    fn allocator_is_held_to_commit_and_rollback_reuses_number() {
        let db = Database::new("locks");
        let mut c = db.connect();
        let a = Admitted {
            zid: 1,
            pid: 2,
            uid: 3,
            active: true,
            duplicate: false,
        };
        c.batch_execute("BEGIN").unwrap();
        assert_eq!(insert(&mut c, &a, "first").unwrap(), 2);
        let cfg = db.config.clone();
        let actor = a.clone();
        let handle = std::thread::spawn(move || {
            let mut other = cfg.connect(NoTls).unwrap();
            insert(&mut other, &actor, "second").unwrap()
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let n:i64=c.query_one("select count(*) from pg_locks where locktype='advisory' and not granted and classid=873791984 and database=(select oid from pg_database where datname=current_database())",&[]).unwrap().get(0);
            if n > 0 {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!handle.is_finished());
        c.batch_execute("COMMIT").unwrap();
        assert_eq!(handle.join().unwrap(), 3);
        c.batch_execute("BEGIN").unwrap();
        assert_eq!(insert(&mut c, &a, "rolled back").unwrap(), 4);
        c.batch_execute("ROLLBACK").unwrap();
        assert_eq!(insert(&mut c, &a, "after rollback").unwrap(), 4);
    }
    #[test]
    fn post_dispatch_failures_never_hand_back_and_constraints_are_specific() {
        let db = Database::new("faults");
        let mut c = db.connect();
        let rt = runtime();
        let (app, key) = setup(&db);
        let app = Arc::new(app);
        for (code, constraint, status) in [
            ("23505", "comments_zid_txt_key", 409),
            ("23505", "comments_zid_tid_key", 500),
            ("23503", "comments_zid_pid_fkey", 500),
            ("23503", "other_fkey", 500),
            ("XX000", "other", 500),
        ] {
            c.batch_execute(&format!("CREATE FUNCTION writer_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure' USING ERRCODE='{code}',CONSTRAINT='{constraint}'; END $$;
                CREATE TRIGGER writer_fault BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION writer_fault();")).unwrap();
            assert_eq!(send(&rt, &app, &key, "fault").status, status);
            c.batch_execute("DROP FUNCTION writer_fault() CASCADE")
                .unwrap();
        }
        assert_eq!(send(&rt, &app, &key, "after faults").status, 200);
        drop(app);
        drop(rt);
    }
    #[test]
    fn notification_capacity_does_not_take_writer_connections() {
        let db = Database::new("capacity");
        let rt = runtime();
        let (app, key) = setup(&db);
        let app = Arc::new(app);
        let lane = &app.post_comments.as_ref().unwrap().background;
        let permits = lane.admitted.clone().try_acquire_many_owned(64).unwrap();
        assert!(!rt.block_on(async { lane.schedule(|_| panic!("overflow must not run")) }));
        assert_eq!(send(&rt, &app, &key, "while background full").status, 200);
        assert!(lane.dropped.load(std::sync::atomic::Ordering::Relaxed) >= 3);
        drop(permits);
        drop(app);
        drop(rt);
    }
    #[test]
    fn notification_wait_budgets_are_independent_of_writer() {
        let db = Database::new("notification_waits");
        let rt = runtime();
        let (app, key) = setup(&db);
        let app = Arc::new(app);
        let writer = app.post_comments.as_ref().unwrap();
        let lane = &writer.background;
        for (pool, expected_lock) in [(&writer.pool, "100ms"), (&lane.pool, "250ms")] {
            rt.block_on(pool.with(move |c| {
                assert_eq!(
                    c.query_one("SHOW lock_timeout", &[])?.get::<_, String>(0),
                    expected_lock
                );
                assert_eq!(
                    c.query_one("SHOW statement_timeout", &[])?
                        .get::<_, String>(0),
                    "1s"
                );
                Ok(())
            }))
            .unwrap();
        }
        // Occupy both real connections. A third job must wait for a permit,
        // survive a 150ms wait, then drop softly when both slots stay occupied.
        for over_budget in [false, true] {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let mut releases = Vec::new();
            for _ in 0..2 {
                let (release_tx, release_rx) = std::sync::mpsc::channel();
                releases.push(release_tx);
                let started_tx = started_tx.clone();
                assert!(rt.block_on(async {
                    lane.schedule(move |_| {
                        started_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                        Ok(())
                    })
                }));
            }
            for _ in 0..2 {
                started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            let before = lane.pool.evidence.snapshot();
            let dropped = lane.dropped.load(std::sync::atomic::Ordering::Relaxed);
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            assert!(rt.block_on(async {
                lane.schedule(move |_| {
                    done_tx.send(()).unwrap();
                    Ok(())
                })
            }));
            rt.block_on(async {
                tokio::time::timeout(Duration::from_secs(2), async {
                    while lane.pool.evidence.snapshot()[1] == before[1] {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
            });
            if over_budget {
                // Comment insertion completes while notification slots remain
                // held, and the waiting work never runs after its budget.
                assert_eq!(send(&rt, &app, &key, "notifications waiting").status, 200);
                rt.block_on(async {
                    tokio::time::timeout(Duration::from_secs(2), async {
                        while lane.pool.evidence.snapshot()[2] < before[2] + 3
                            || lane.dropped.load(std::sync::atomic::Ordering::Relaxed) < dropped + 3
                        {
                            tokio::task::yield_now().await;
                        }
                    })
                    .await
                    .unwrap();
                });
                assert!(done_rx.try_recv().is_err());
            } else {
                std::thread::sleep(Duration::from_millis(150));
                assert_eq!(lane.pool.evidence.snapshot()[2], before[2]);
                assert_eq!(
                    lane.dropped.load(std::sync::atomic::Ordering::Relaxed),
                    dropped
                );
            }
            for release in releases {
                release.send(()).unwrap();
            }
            if !over_budget {
                done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            rt.block_on(async {
                tokio::time::timeout(Duration::from_secs(2), async {
                    while lane.admitted.available_permits() != 64 {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
            });
        }
        drop(app);
        drop(rt);
    }

    #[test]
    fn blocked_admission_hands_back_without_writing() {
        let db = Database::new("admission_wait");
        let mut c = db.connect();
        let rt = runtime();
        let (app, key) = setup(&db);
        let app = Arc::new(app);
        c.batch_execute("BEGIN; LOCK TABLE participants IN ACCESS EXCLUSIVE MODE")
            .unwrap();
        assert_eq!(send(&rt, &app, &key, "blocked admission").status, 502);
        c.batch_execute("ROLLBACK").unwrap();
        assert_eq!(
            c.query_one("select count(*) from comments", &[])
                .unwrap()
                .get::<_, i64>(0),
            2
        );
        assert_eq!(
            send(&rt, &app, &key, "after admission recovers").status,
            200
        );
        drop(app);
        drop(rt);
    }

    #[test]
    fn switch_off_is_a_handoff_without_writes() {
        let db = Database::new("off");
        let rt = runtime();
        let (mut app, key) = setup(&db);
        app.post_comments = None;
        let app = Arc::new(app);
        assert_eq!(send(&rt, &app, &key, "off").status, 502);
        let mut c = db.connect();
        assert_eq!(
            c.query_one("select count(*) from comments", &[])
                .unwrap()
                .get::<_, i64>(0),
            2
        );
    }
}

#[cfg(all(feature = "db-tests", feature = "fixture-clock"))]
#[path = "post_comments_replay.rs"]
mod replay;

#[test]
fn configuration_requires_explicit_switch_and_disabled_provider() {
    for switch in [None, Some("0"), Some("false"), Some("true"), Some("1")] {
        for provider in [None, Some("true"), Some("false"), Some("0")] {
            assert_eq!(
                configuration_enabled(switch, provider),
                switch == Some("1") && provider == Some("false")
            );
        }
    }
}
