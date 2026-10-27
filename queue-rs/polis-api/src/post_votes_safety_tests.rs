use super::{database::Database, *};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::json;
use std::sync::{Barrier, atomic::Ordering};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

fn setup(db: &Database) -> (Arc<App>, Request) {
    db.connect()
        .batch_execute(
            "INSERT INTO users(uid) VALUES(1);
         INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
         INSERT INTO zinvites(zid,zinvite) VALUES(1,'2fixture');
         ALTER TABLE participants DISABLE TRIGGER USER;
         INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,0,1,3);
         ALTER TABLE participants ENABLE TRIGGER USER;",
        )
        .unwrap();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let token = encode(
        &Header::new(Algorithm::RS256),
        &json!({
            "uid":1,"pid":0,"conversation_id":"2fixture","sub":"anon:1",
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,
            "anonymous_participant":true
        }),
        &key,
    )
    .unwrap();
    let connector = || Connector::Plain(Box::new(db.config.clone()));
    let limits = db::Limits {
        size: 4,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_secs(1),
        max_lifetime: Duration::from_secs(300),
    };
    let cfg = config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: limits.clone(),
    };
    let mut app = App::new(&cfg, db::Pool::new(connector(), read_limits()));
    app.post_votes = Some(Writer {
        pool: db::Pool::writer(connector(), limits.clone()),
        reads: db::Pool::new(connector(), read_limits()),
        background: NotificationPool::new(db::Pool::writer(
            connector(),
            db::Limits { size: 2, ..limits },
        )),
        verifier: participant::Verifier::new(&public, "fixture", "fixture").unwrap(),
        admins: vec![],
    });
    let mut request = req(&json!({"conversation_id":"2fixture","tid":7,
        "vote":crate::votes::WIRE_AGREE})
    .to_string());
    request.headers = Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("authorization", &format!("Bearer {token}")),
    ]);
    (Arc::new(app), request)
}

#[test]
fn narrow_priorities_read_succeeds_with_all_writer_slots_occupied() {
    let db = Database::new("read_isolation");
    let (app, _) = setup(&db);
    // A large unrelated published payload must not cross the priorities query.
    db.connect()
        .batch_execute(
            "INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data)
        VALUES(1,'test',1,0,jsonb_build_object('comment-priorities',jsonb_build_object('7',2),
        'projection',repeat('x',8*1024*1024)))",
        )
        .unwrap();
    let rt = runtime();
    rt.block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let barrier = Arc::new(Barrier::new(5));
        let (ready_tx, mut ready_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = vec![];
        for _ in 0..4 {
            let pool = writer.pool.clone();
            let barrier = barrier.clone();
            let ready = ready_tx.clone();
            tasks.push(tokio::spawn(async move {
                pool.with(move |_| {
                    ready.send(()).unwrap();
                    barrier.wait();
                    Ok(())
                })
                .await
                .unwrap()
            }));
        }
        for _ in 0..4 {
            ready_rx.recv().await.unwrap();
        }
        let before = writer.pool.evidence.snapshot();
        assert_eq!(before[0] - before[3], 4);
        let mut reads = vec![];
        for _ in 0..8 {
            let pool = writer.reads.clone();
            reads.push(tokio::spawn(async move {
                pool.with(|c| priorities(c, 1, "test"))
                    .await
                    .unwrap()
                    .unwrap()
            }));
        }
        for read in reads {
            let data = read.await.unwrap();
            assert_eq!(js::stringify(&data), r#"{"7":2}"#);
        }
        assert_eq!(writer.pool.evidence.snapshot(), before);
        assert_eq!(writer.reads.evidence.snapshot()[0], 8);
        let release = barrier.clone();
        tokio::task::spawn_blocking(move || release.wait())
            .await
            .unwrap();
        for task in tasks {
            task.await.unwrap();
        }
        // Both read and writer pools have populated synchronous clients.
        drop(app);
    });
}

#[test]
fn dispatch_deadline_reports_unknown_and_retains_late_append() {
    let db = Database::new("deadline");
    let (mut app, request) = setup(&db);
    let limits = db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_secs(3),
        max_lifetime: Duration::from_secs(300),
    };
    // Extend only the test statement limit to force the outer deadline first.
    Arc::get_mut(&mut app)
        .unwrap()
        .post_votes
        .as_mut()
        .unwrap()
        .pool = db::Pool::writer(Connector::Plain(Box::new(db.config.clone())), limits);
    db.connect().batch_execute("CREATE FUNCTION pause_append() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$;
        CREATE TRIGGER pause_append BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION pause_append();").unwrap();
    runtime().block_on(async {
        let started = std::time::Instant::now();
        let response = route::handle(app.clone(), request).await;
        assert_eq!(response.status, 202);
        let bytes = crate::http::write_response(&response, false, false, "D").unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("unknown"));
        assert!(started.elapsed() >= DISPATCH_DEADLINE);
        assert!(started.elapsed() < Duration::from_millis(1400));
        let writer = app.post_votes.as_ref().unwrap();
        let evidence = writer.pool.evidence.snapshot();
        assert_eq!(
            evidence[0] - evidence[3],
            1,
            "timed-out operation retains its slot"
        );
        assert!(writer.pool.with(|_| Ok(())).await.is_err());
        tokio::time::sleep(Duration::from_millis(800)).await;
        let counts = writer
            .reads
            .with(|c| {
                Ok((
                    c.query_one("select count(*) from votes", &[])?
                        .get::<_, i64>(0),
                    c.query_one("select nsli::integer from participants", &[])?
                        .get::<_, i32>(0),
                ))
            })
            .await
            .unwrap();
        assert_eq!(
            counts,
            (1, 0),
            "late work commits exactly once and schedules bookkeeping"
        );
        drop(app);
    });
}

#[test]
fn notification_runs_before_slow_star_without_count_or_activity_writes() {
    let db = Database::new("bookkeeping_order");
    let (app, mut request) = setup(&db);
    request.body = json!({"conversation_id":"2fixture","tid":7,
        "vote":crate::votes::WIRE_AGREE,"starred":true})
    .to_string()
    .into_bytes();
    db.connect().batch_execute("CREATE FUNCTION pause_star() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN PERFORM pg_sleep(0.7); RETURN NEW; END $$;
        CREATE TRIGGER pause_star BEFORE INSERT ON stars FOR EACH ROW EXECUTE FUNCTION pause_star();").unwrap();
    runtime().block_on(async {
        let task = tokio::spawn(route::handle(app.clone(),request));
        let writer = app.post_votes.as_ref().unwrap();
        let observed = tokio::time::timeout(Duration::from_millis(600),async {
            loop {
                let row = writer.reads.with(|c| Ok(c.query_one(
                    "select p.vote_count,p.nsli,p.last_interaction,c.modified,
                     (select count(*) from stars) from participants p join conversations c using(zid)", &[])?)).await.unwrap();
                if row.get::<_,i16>(1)==0 {
                    assert_eq!(row.get::<_,i32>(0),0);
                    assert_eq!(row.get::<_,i16>(1),0);
                    assert!(row.get::<_,i64>(2)>0);
                    assert_eq!(row.get::<_,i64>(3),0);
                    assert_eq!(row.get::<_,i64>(4),0);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await;
        assert!(observed.is_ok(),"notification must precede star completion");
        assert!(!task.is_finished());
        assert_eq!(task.await.unwrap().status,200);
        tokio::time::sleep(Duration::from_millis(150)).await;
        drop(app);
    });
}

#[test]
fn populated_read_writer_and_bookkeeping_pools_drop_inside_runtime() {
    let db = Database::new("shutdown");
    let (app, _) = setup(&db);
    runtime().block_on(async move {
        let writer = app.post_votes.as_ref().unwrap();
        assert!(app.db.ping().await);
        assert!(writer.pool.ping().await);
        assert!(writer.reads.ping().await);
        assert!(writer.background.pool.ping().await);
        drop(app);
    });
}

#[test]
fn stalled_connect_returns_terminal_deadline_without_releasing_slot() {
    let db = Database::new("stalled_connect");
    let (mut app, request) = setup(&db);
    runtime().block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        // Use a fresh config: adding hosts to the existing one could connect to
        // the real database first and would not exercise a stalled handshake.
        let mut stalled = postgres::Config::new();
        stalled
            .host("127.0.0.1")
            .port(listener.local_addr().unwrap().port())
            .user("postgres")
            .dbname("unused")
            .connect_timeout(Duration::from_secs(3));
        Arc::get_mut(&mut app)
            .unwrap()
            .post_votes
            .as_mut()
            .unwrap()
            .pool = db::Pool::writer(
            Connector::Plain(Box::new(stalled)),
            db::Limits {
                size: 1,
                acquire_timeout: Duration::from_millis(100),
                statement_timeout: Duration::from_secs(1),
                max_lifetime: Duration::from_secs(300),
            },
        );
        let task = tokio::spawn(route::handle(app.clone(), request));
        let (socket, _) = listener.accept().await.unwrap();
        let response = task.await.unwrap();
        assert_eq!(response.status, 202);
        let writer = app.post_votes.as_ref().unwrap();
        let evidence = writer.pool.evidence.snapshot();
        assert_eq!(evidence[0] - evidence[3], 1);
        assert!(writer.pool.with(|_| Ok(())).await.is_err());
        drop(socket);
        tokio::time::timeout(Duration::from_secs(1), async {
            while writer.pool.evidence.snapshot()[3] == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            writer
                .reads
                .with(|c| Ok(c
                    .query_one("select count(*) from votes", &[])?
                    .get::<_, i64>(0)))
                .await
                .unwrap(),
            0
        );
        drop(app);
    });
}

#[test]
fn lost_response_does_not_cancel_or_repeat_dispatched_vote() {
    let db = Database::new("lost_response");
    let (app, request) = setup(&db);
    db.connect().batch_execute("CREATE FUNCTION pause_append() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
        CREATE TRIGGER pause_append BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION pause_append();").unwrap();
    runtime().block_on(async {
        let retry = copy_request(&request);
        let task = tokio::spawn(route::handle(app.clone(), request));
        let writer = app.post_votes.as_ref().unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while writer.pool.evidence.snapshot()[0] == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(matches!(task.await, Err(e) if e.is_cancelled()));
        tokio::time::sleep(Duration::from_millis(800)).await;
        let counts = writer
            .reads
            .with(|c| {
                Ok((
                    c.query_one("select count(*) from votes", &[])?
                        .get::<_, i64>(0),
                    c.query_one("select nsli::integer from participants", &[])?
                        .get::<_, i32>(0),
                ))
            })
            .await
            .unwrap();
        assert_eq!(counts, (1, 0));
        let reply = route::handle(app.clone(), retry).await;
        assert_eq!(reply.status, 200);
        assert!(accepted_body(&reply).vote.replayed);
        assert_eq!(
            writer
                .reads
                .with(|c| Ok(c
                    .query_one("select count(*) from votes", &[])?
                    .get::<_, i64>(0)))
                .await
                .unwrap(),
            1
        );
        drop(app);
    });
}

#[test]
fn blocked_notification_lane_drops_soft_without_occupying_writer_slots() {
    let db = Database::new("notification_pressure");
    let (app, request) = setup(&db);
    let mut lock = db.connect();
    lock.batch_execute("BEGIN; SELECT * FROM participants WHERE zid=1 FOR NO KEY UPDATE")
        .unwrap();
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let mut requests = Vec::new();
        for _ in 0..8 {
            requests.push(tokio::spawn(route::handle(
                app.clone(),
                Request {
                    method: request.method.clone(),
                    target: request.target.clone(),
                    headers: request.headers.clone(),
                    body: request.body.clone(),
                },
            )));
        }
        for response in requests {
            assert_eq!(response.await.unwrap().status, 200);
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let state = writer
            .reads
            .with(|c| {
                Ok(c.query_one(
                    "select nsli,vote_count,(select modified from conversations where zid=1),
             (select count(*) from votes where zid=1) from participants where zid=1",
                    &[],
                )?)
            })
            .await
            .unwrap();
        assert_eq!(
            state.get::<_, i16>(0),
            3,
            "blocked notification may be dropped"
        );
        assert_eq!(state.get::<_, i32>(1), 0, "no stored recount");
        assert_eq!(state.get::<_, i64>(2), 0, "no activity write");
        assert_eq!(
            state.get::<_, i64>(3),
            1,
            "same-choice retries share one history row"
        );
        let evidence = writer.pool.evidence.snapshot();
        assert_eq!(evidence[0], 8, "only append uses writer slots");
        assert_eq!(evidence[0], evidence[3], "all writer slots released");
        assert!(
            writer.background.pool.evidence.snapshot()[4] > 0,
            "notification SQL errors observed"
        );
        drop(app);
    });
    lock.batch_execute("ROLLBACK").unwrap();
}

#[test]
fn notification_admission_bounds_active_and_pending_before_spawn() {
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    let db = Database::new("notification_admission");
    let (app, _) = setup(&db);
    let rt = runtime();
    rt.block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let lane = &writer.background;
        let barrier = Arc::new(Barrier::new(3));
        let (ready_tx, mut ready_rx) = tokio::sync::mpsc::unbounded_channel();
        for _ in 0..2 {
            let barrier = barrier.clone();
            let ready = ready_tx.clone();
            assert!(lane.schedule(move |_| {
                ready.send(()).unwrap();
                barrier.wait();
                Ok(())
            }));
        }
        for _ in 0..2 {
            ready_rx.recv().await.unwrap();
        }
        let completed = Arc::new(AtomicUsize::new(0));
        for _ in 0..62 {
            let completed = completed.clone();
            assert!(lane.schedule(move |_| {
                completed.fetch_add(1, SeqCst);
                Ok(())
            }));
        }
        assert_eq!(lane.admitted.available_permits(), 0);
        for _ in 0..100 {
            assert!(!lane.schedule(|_| panic!("overflow work must never run")));
        }
        assert_eq!(lane.dropped.load(SeqCst), 100);
        // Both notification connections are still occupied. The writer's
        // independent slots must remain available while this lane is full.
        assert!(writer.pool.ping().await);
        barrier.wait();
        tokio::time::timeout(Duration::from_secs(2), async {
            while lane.admitted.available_permits() != 64
                || completed.load(SeqCst) as u64 + lane.dropped.load(SeqCst) != 162
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // All 62 admitted waiters either finish or are softly dropped by the
        // unchanged acquisition bound. The 100 overflow jobs never execute.
        assert_eq!(
            completed.load(SeqCst) as u64 + lane.dropped.load(SeqCst),
            162
        );
        assert!(lane.schedule(|_| Ok(())));
    });
}

#[test]
fn read_and_write_switches_dispatch_independently_on_the_shared_votes_path() {
    let db = Database::new("read_write_dispatch");
    let (mut app, template) = setup(&db);
    let post = || Request {
        method: template.method.clone(),
        target: template.target.clone(),
        headers: template.headers.clone(),
        body: template.body.clone(),
    };
    let read_pool = || {
        db::Pool::new(
            Connector::Plain(Box::new(db.config.clone())),
            crate::votes_read::pool_limits(),
        )
    };
    let get = || Request {
        method: "GET".into(),
        target: "/api/v3/votes?conversation_id=2fixture".into(),
        headers: Headers::from_raw([("host", "localhost"), ("x-forwarded-proto", "https")]),
        body: vec![],
    };
    runtime().block_on(async {
        let state = Arc::get_mut(&mut app).unwrap();
        state.votes_read_db = Some(read_pool());
        state.votes_read_auth_db = Some(read_pool());
        assert_eq!(route::handle(app.clone(), get()).await.status, 200);
        assert_eq!(route::handle(app.clone(), post()).await.status, 200);
        assert_eq!(app.votes_read_served.load(Ordering::Relaxed), 1);
        assert_eq!(app.votes_read_fallback.load(Ordering::Relaxed), 0);

        let state = Arc::get_mut(&mut app).unwrap();
        state.votes_read_db = None;
        state.votes_read_auth_db = None;
        assert_eq!(route::handle(app.clone(), get()).await.status, 502);
        assert_eq!(route::handle(app.clone(), post()).await.status, 200);
        assert_eq!(app.votes_read_served.load(Ordering::Relaxed), 1);
        assert_eq!(app.votes_read_fallback.load(Ordering::Relaxed), 1);

        let state = Arc::get_mut(&mut app).unwrap();
        state.post_votes = None;
        state.votes_read_db = Some(read_pool());
        state.votes_read_auth_db = Some(read_pool());
        assert_eq!(route::handle(app.clone(), post()).await.status, 502);
        assert_eq!(route::handle(app.clone(), get()).await.status, 200);
        assert_eq!(app.votes_read_served.load(Ordering::Relaxed), 2);
        assert_eq!(app.votes_read_fallback.load(Ordering::Relaxed), 2);

        let state = Arc::get_mut(&mut app).unwrap();
        state.votes_read_db = None;
        state.votes_read_auth_db = None;
        assert_eq!(route::handle(app.clone(), get()).await.status, 502);
        assert_eq!(route::handle(app.clone(), post()).await.status, 502);
        drop(app);
    });
    assert_eq!(
        db.connect()
            .query_one("SELECT count(*) FROM votes", &[])
            .unwrap()
            .get::<_, i64>(0),
        1,
    );
}

fn copy_request(request: &Request) -> Request {
    Request {
        method: request.method.clone(),
        target: request.target.clone(),
        headers: request.headers.clone(),
        body: request.body.clone(),
    }
}
fn accepted_body(response: &Outgoing) -> DurableSuccess {
    let crate::http::Body::Fixed(bytes) = &response.body else {
        panic!("fixed response")
    };
    DurableSuccess::decode(bytes).unwrap()
}

#[test]
fn post_commit_failures_and_follow_on_deadline_keep_the_vote_and_retry_receipt() {
    for (name, fault, star, next_state) in [
        ("success", "", false, FollowOnState::Absent),
        ("star_fault", "CREATE FUNCTION fail_follow() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'star failed'; END $$;
          CREATE TRIGGER fail_follow BEFORE INSERT ON stars FOR EACH ROW EXECUTE FUNCTION fail_follow();",
          true, FollowOnState::Degraded),
        ("next_fault", "CREATE OR REPLACE FUNCTION get_visible_comments(the_zid integer)
          RETURNS TABLE(tid integer, mod integer, strict_moderation boolean)
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'next failed'; END $$;",
          false, FollowOnState::Degraded),
        ("star_deadline", "CREATE FUNCTION fail_follow() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$;
          CREATE TRIGGER fail_follow BEFORE INSERT ON stars FOR EACH ROW EXECUTE FUNCTION fail_follow();",
          true, FollowOnState::Degraded),
    ] {
        let db = Database::new(name);
        let (app, mut request) = setup(&db);
        if star {
            let mut body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            body["starred"] = json!(true);
            request.body = body.to_string().into_bytes();
        }
        db.connect().batch_execute("CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 1700000000000::bigint'").unwrap();
        db.connect().batch_execute(fault).unwrap();
        runtime().block_on(async {
            let first = route::handle(app.clone(), copy_request(&request)).await;
            assert_eq!(first.status, 200, "{name}");
            let body = accepted_body(&first);
            assert_eq!(body.vote.vote, crate::votes::VoteChoice::Agree.wire());
            assert!(!body.vote.replayed);
            assert_eq!(body.follow_on.next_comment, next_state);
            assert!(body.next_comment.is_none());
            let again = route::handle(app.clone(), copy_request(&request)).await;
            assert_eq!(again.status, 200, "{name}");
            let replay = accepted_body(&again);
            assert!(replay.vote.replayed);
            assert_eq!(replay.vote.created, body.vote.created);
            assert_eq!(app.post_votes.as_ref().unwrap().reads.with(|c| Ok(c.query_one(
                "select count(*) from votes", &[])?.get::<_,i64>(0))).await.unwrap(), 1);
            if let Ok(path) = std::env::var("POLIS_API_DURABLE_RECORDINGS") {
                std::fs::create_dir_all(&path).unwrap();
                let fixed = |out: &Outgoing| match &out.body {
                    crate::http::Body::Fixed(bytes) => serde_json::from_slice::<serde_json::Value>(bytes).unwrap(),
                    _ => panic!("fixed response"),
                };
                std::fs::write(std::path::Path::new(&path).join(format!("{name}.json")),
                    serde_json::to_vec_pretty(&json!({"first":fixed(&first),"retry":fixed(&again),"historyRows":1})).unwrap()).unwrap();
            }
            let fixture: serde_json::Value = serde_json::from_str(include_str!(
                "../../../server/characterization/votes/durable-cases.json")).unwrap();
            assert_eq!(serde_json::to_value(&body).unwrap(), fixture[name]["first"]);
            assert_eq!(serde_json::to_value(&replay).unwrap(), fixture[name]["retry"]);
            assert_eq!(fixture[name]["historyRows"], 1);
            // Detached work keeps its own pool/permit through actual completion.
            tokio::time::sleep(Duration::from_millis(600)).await;
        });
    }
}

#[test]
fn concurrent_same_choice_retries_append_once_and_priority_is_not_a_new_vote() {
    let db = Database::new("same_choice");
    let (app, request) = setup(&db);
    runtime().block_on(async {
        // Establish every connection before measuring concurrent retry semantics.
        // Cold connection setup belongs to admission-shedding tests, not this
        // same-choice race. Keep all 16 callers and the production 100 ms bound.
        let writer = app.post_votes.as_ref().unwrap();
        for (pool, size) in [(&writer.reads, 2), (&writer.pool, 4)] {
            let barrier = Arc::new(Barrier::new(size + 1));
            let (ready, mut receive) = tokio::sync::mpsc::unbounded_channel();
            let mut warm = Vec::new();
            for _ in 0..size {
                let pool = pool.clone();
                let barrier = barrier.clone();
                let ready = ready.clone();
                warm.push(tokio::spawn(async move {
                    pool.with(move |_| {
                        ready.send(()).unwrap();
                        barrier.wait();
                        Ok(())
                    })
                    .await
                    .unwrap()
                }));
            }
            for _ in 0..size {
                receive.recv().await.unwrap();
            }
            barrier.wait();
            for task in warm {
                task.await.unwrap();
            }
        }
        let mut tasks = Vec::new();
        for _ in 0..16 {
            tasks.push(tokio::spawn(route::handle(
                app.clone(),
                copy_request(&request),
            )));
        }
        let mut appended = 0;
        for task in tasks {
            let response = task.await.unwrap();
            assert_eq!(response.status, 200);
            appended += usize::from(!accepted_body(&response).vote.replayed);
        }
        assert_eq!(appended, 1);
        let mut priority = copy_request(&request);
        priority.body = json!({"conversation_id":"2fixture","tid":7,
            "vote":crate::votes::VoteChoice::Agree.wire(),"high_priority":true})
        .to_string()
        .into_bytes();
        assert!(
            accepted_body(&route::handle(app.clone(), priority).await)
                .vote
                .replayed
        );
        let writer = app.post_votes.as_ref().unwrap();
        let state = writer
            .reads
            .with(|c| Ok(c.query_one("select count(*),bool_or(high_priority) from votes", &[])?))
            .await
            .unwrap();
        assert_eq!(state.get::<_, i64>(0), 1);
        assert!(!state.get::<_, bool>(1));
    });
}

#[test]
fn notification_overflow_is_explicit_in_accepted_body() {
    let db = Database::new("notify_degraded");
    let (app, request) = setup(&db);
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let permits = writer
            .background
            .admitted
            .clone()
            .acquire_many_owned(64)
            .await
            .unwrap();
        let response = route::handle(app.clone(), request).await;
        assert_eq!(response.status, 200);
        assert_eq!(
            accepted_body(&response).follow_on.notifications,
            NotificationState::Degraded
        );
        assert!(writer.background.dropped.load(Ordering::Relaxed) > 0);
        drop(permits);
    });
}

#[test]
fn fresh_statement_rejection_rolls_back_the_provisional_latest_row() {
    for (label, code, status) in [
        ("sql_failure", "XX000", 500),
        ("sql_duplicate", "23505", 406),
    ] {
        let db = Database::new(label);
        let (app, request) = setup(&db);
        db.connect().batch_execute(&format!("CREATE FUNCTION fail_vote() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'controlled insert failure' USING ERRCODE='{code}'; END $$;
            CREATE TRIGGER fail_vote BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION fail_vote();")).unwrap();
        runtime().block_on(async {
            let response = route::handle(app.clone(), request).await;
            assert_eq!(response.status, status);
            assert!(
                !response
                    .headers
                    .iter()
                    .any(|(name, _)| name == "X-Polis-Vote-Dispatch")
            );
        });
        let row = db
            .connect()
            .query_one(
                "select (select count(*) from votes),
            (select count(*) from votes_latest_unique)",
                &[],
            )
            .unwrap();
        assert_eq!((row.get::<_, i64>(0), row.get::<_, i64>(1)), (0, 0));
    }
}

#[test]
fn node_insert_rule_and_rust_retry_serialize_on_the_same_latest_key() {
    for commit in [true, false] {
        let db = Database::new(if commit {
            "node_commit"
        } else {
            "node_rollback"
        });
        let mut node = db.connect();
        node.batch_execute("BEGIN").unwrap();
        // Use the real Node statement shape and the shared storage boundary.
        let stored = i16::try_from(contract::stored_vote(crate::votes::VoteChoice::Agree)).unwrap();
        node.execute(
            "insert into votes(zid,pid,tid,vote,weight_x_32767,high_priority)
            values($1,$2,$3,$4,0,false)",
            &[&1_i32, &0_i32, &7_i32, &stored],
        )
        .unwrap();
        let mut rust = db.connect();
        let backend: i32 = rust
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        let task = std::thread::spawn(move || {
            append(
                &mut rust,
                &database::actor(),
                &database::fields(crate::votes::VoteChoice::Agree),
            )
            .unwrap()
        });
        let mut observer = db.connect();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let blocked: bool = observer
                .query_one(
                    "select exists(select 1 from pg_stat_activity
                where pid=$1 and wait_event_type='Lock')",
                    &[&backend],
                )
                .unwrap()
                .get(0);
            if blocked {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "must observe actual lock contention"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        node.batch_execute(if commit { "COMMIT" } else { "ROLLBACK" })
            .unwrap();
        assert_eq!(task.join().unwrap().replayed, commit);
        assert_eq!(
            observer
                .query_one("select count(*) from votes", &[])
                .unwrap()
                .get::<_, i64>(0),
            1
        );
    }
}

#[test]
fn commit_failure_is_unknown_and_retry_can_append_after_rollback() {
    let db = Database::new("commit_failure");
    let (app, request) = setup(&db);
    db.connect()
        .batch_execute(
            "CREATE FUNCTION fail_vote_commit() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'controlled commit failure'; END $$;
        CREATE CONSTRAINT TRIGGER fail_vote_commit AFTER INSERT ON votes
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_vote_commit();",
        )
        .unwrap();
    let rt = runtime();
    let response = rt.block_on(route::handle(app.clone(), copy_request(&request)));
    assert_eq!(response.status, 202);
    assert!(
        !response
            .headers
            .iter()
            .any(|(name, _)| name == "X-Polis-Vote-Dispatch")
    );
    let mut c = db.connect();
    let row = c
        .query_one(
            "select (select count(*) from votes),
        (select count(*) from votes_latest_unique)",
            &[],
        )
        .unwrap();
    assert_eq!((row.get::<_, i64>(0), row.get::<_, i64>(1)), (0, 0));
    c.batch_execute("DROP TRIGGER fail_vote_commit ON votes")
        .unwrap();
    let retry = rt.block_on(route::handle(app.clone(), request));
    assert_eq!(retry.status, 200);
    assert!(!accepted_body(&retry).vote.replayed);
    assert_eq!(
        c.query_one("select count(*) from votes", &[])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
}
