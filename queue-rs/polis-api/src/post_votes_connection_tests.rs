use super::*;
use crate::db::connection_bounds_tests::Peer;

fn silent_writer_retry(warm: bool) {
    let database = Database::new(if warm { "silent_warm" } else { "silent_setup" });
    let (mut app, request) = setup(&database);
    let rt = runtime();
    rt.block_on(async {
        let peer = Peer::new(Some(database.config.get_ports()[0])).await;
        let dsn = format!("postgres://postgres@127.0.0.1:{}/{}", database.config.get_ports()[0], database.config.get_dbname().unwrap());
        let pool = db::Pool::writer(peer.connector(&dsn), db::Limits {
            size: 4,
            acquire_timeout: Duration::from_millis(100),
            statement_timeout: Duration::from_secs(1),
            max_lifetime: Duration::from_secs(300),
        });
        if warm { assert!(pool.ping().await); }
        peer.silence();
        tokio::time::sleep(Duration::from_millis(30)).await;
        Arc::get_mut(&mut app).unwrap().post_votes.as_mut().unwrap().pool = pool.clone();
        let before = pool.evidence.snapshot();
        let (first, _, observation) = observed_after_admission(app.clone(), copy_request(&request)).await;
        let reclaimed = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if pool.evidence.snapshot()[3] == before[3] + 1 && observation.lock().unwrap().finished && peer.closed.load(Ordering::SeqCst) == 1 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.is_ok();
        let closed = peer.closed.load(Ordering::SeqCst);
        if !reclaimed {
            // End baseline work before failing. Never use this close as proof.
            peer.stop().await;
            wait_for("failed transport released", || observation.lock().unwrap().finished).await;
            panic!("silent writer retained its dispatched slot beyond the bound");
        }
        assert_eq!(first.status, 202, "post-dispatch failure stays unknown");
        assert!(!first.headers.iter().any(|(key, _)| key == "X-Polis-Vote-Dispatch"));
        assert!(observation.lock().unwrap().receipt.as_ref().unwrap().lock().unwrap().is_none());
        assert_eq!(closed, 1);
        let count = tokio::task::spawn_blocking({
            let config = database.config.clone();
            move || config.connect(postgres::NoTls).unwrap().query_one("SELECT count(*) FROM votes", &[]).unwrap().get::<_, i64>(0)
        }).await.unwrap();
        assert_eq!(count, 0, "unknown setup/transport failure wrote no vote");
        peer.resume();
        let retry = handle_after_admission(app.clone(), copy_request(&request)).await;
        assert_eq!(retry.status, 200);
        let receipt = accepted_body(&retry);
        assert!(!receipt.vote.replayed);
        let replay = handle_after_admission(app.clone(), request).await;
        assert_eq!(replay.status, 200);
        assert!(accepted_body(&replay).vote.replayed);
        let (count, stored) = tokio::task::spawn_blocking({
            let config = database.config.clone();
            move || {
                let row = config.connect(postgres::NoTls).unwrap().query_one("SELECT count(*), min(vote) FROM votes", &[]).unwrap();
                (row.get::<_, i64>(0), row.get::<_, i16>(1))
            }
        }).await.unwrap();
        assert_eq!(count, 1, "retry and replay append exactly one durable vote");
        assert_eq!(i32::from(stored), contract::stored_vote(crate::votes::VoteChoice::Agree));
        assert_eq!(receipt.vote.vote, crate::votes::WIRE_AGREE);
        eprintln!("connection writer warm={warm} first=202 retry=200 replay=200 history={count} stored_agree={stored} wire_agree={}", receipt.vote.vote);
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        peer.stop().await;
    });
}

#[test]
fn connection_bounds_cold_writer_preserves_unknown_and_retry_receipt() {
    silent_writer_retry(false);
}

#[test]
fn connection_bounds_warm_writer_preserves_unknown_and_retry_receipt() {
    silent_writer_retry(true);
}

#[test]
fn connection_bounds_blackhole_pools_leave_participation_clear() {
    let database = Database::new("blackhole_isolation");
    let (fixture_app, _) = setup(&database);
    drop(fixture_app);
    runtime().block_on(async {
        let common_peer = Peer::new(None).await;
        let result_peer = Peer::new(None).await;
        let dsn = format!("postgres://postgres@127.0.0.1:{}/{}", database.config.get_ports()[0], database.config.get_dbname().unwrap());
        let common_limits = db::Limits {
            size: 8,
            acquire_timeout: Duration::from_millis(2000),
            statement_timeout: Duration::from_millis(3000),
            max_lifetime: Duration::from_secs(300),
        };
        let common = db::Pool::new(common_peer.connector(&dsn), common_limits.clone());
        let results = db::Pool::new(result_peer.connector(&dsn), crate::delphi_result_read::pool_limits());
        let healthy = |limits| db::Pool::new(Connector::Plain(Box::new(database.config.clone())), limits);
        let cfg = config::Config {
            listen: String::new(), math_env: "test".into(), cache_size: 10,
            pca_cache_size: 10, pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES, dev_mode: true, use_network_host: false,
            production: true, pool: common_limits,
        };
        let mut app = App::new(&cfg, common.clone());
        app.delphi_result_db = Some(results.clone());
        app.next_comment_db = Some(healthy(next_comment::pool_limits()));
        app.next_comment_plain = true;
        app.comments_db = Some(healthy(db::Limits {
            size: 2, acquire_timeout: Duration::from_millis(100),
            statement_timeout: Duration::from_millis(1000), max_lifetime: Duration::from_secs(300),
        }));
        app.comments_count_db = Some(healthy(db::Limits {
            size: 1, acquire_timeout: Duration::from_millis(100),
            statement_timeout: Duration::from_millis(1000), max_lifetime: Duration::from_secs(300),
        }));
        app.votes_read_db = Some(healthy(crate::votes_read::pool_limits()));
        app.votes_read_auth_db = Some(healthy(crate::votes_read::pool_limits()));
        // Isolate contention, not initial TLS cost: warm only the TEST's
        // healthy participation pools, with unchanged production limits.
        warm_pool(app.next_comment_db.as_ref().unwrap(), 2).await;
        warm_pool(app.comments_db.as_ref().unwrap(), 2).await;
        warm_pool(app.comments_count_db.as_ref().unwrap(), 1).await;
        warm_pool(app.votes_read_db.as_ref().unwrap(), 1).await;
        warm_pool(app.votes_read_auth_db.as_ref().unwrap(), 1).await;
        let app = Arc::new(app);
        let paths = [
            ("/api/v3/nextComment?conversation_id=2fixture", app.next_comment_db.as_ref().unwrap()),
            ("/api/v3/comments?conversation_id=2fixture", app.comments_db.as_ref().unwrap()),
            ("/api/v3/votes?conversation_id=2fixture", app.votes_read_db.as_ref().unwrap()),
        ];
        async fn observe(app: Arc<App>, path: &str, pool: &Arc<db::Pool>) -> (u16, Duration, [usize; 6]) {
            let before = pool.evidence.snapshot();
            let start = std::time::Instant::now();
            let response = crate::dispatch(app, None, Request {
                method: "GET".into(), target: path.into(),
                headers: Headers::from_raw([]), body: vec![],
            }).await;
            // A caller deadline can precede its blocking operation's end.
            // Drain all acquired work before the next sample, including a
            // comments request's separate context and row checkouts.
            wait_for("participation database operation completed", || {
                let now = pool.evidence.snapshot();
                now[2] > before[2] || (now[0] > before[0] && now[3] - before[3] == now[0] - before[0])
            }).await;
            let after = pool.evidence.snapshot();
            (response.status, start.elapsed(), std::array::from_fn(|i| after[i] - before[i]))
        }
        fn assert_isolated(path: &str, status: u16, delta: [usize; 6]) {
            let [acquired, waits, timeouts, completed, errors, deadlines] = delta;
            assert_eq!((waits, timeouts), (0, 0), "participation must not wait on a pool slot: {path} {delta:?}");
            // Comments reads context and rows in separate checkouts; a failed
            // context read can return before the second checkout is needed.
            let comments = path.starts_with("/api/v3/comments?");
            let expected = if comments { 2 } else { 1 };
            assert!(acquired == expected || (comments && status == 502 && acquired == 1),
                "the participation request must acquire its own pool: {path} {delta:?}");
            assert_eq!(completed, acquired, "all acquired participation work must finish");
            if status == 200 {
                assert_eq!((errors, deadlines), (0, 0));
            } else {
                assert_eq!(status, 502, "only an own-route failure can count as isolated");
                assert!(errors <= 1 && deadlines <= 1, "unexpected failures: {path} {delta:?}");
                // nextComment records its caller deadline; a statement timeout
                // records one pool error. Votes read has no caller-deadline
                // counter, so a clean completed checkout can accompany its 502.
                let uncounted_deadline = path.starts_with("/api/v3/votes?");
                assert!(errors == 1 || deadlines == 1 || uncounted_deadline,
                    "502 without own-route failure evidence: {path} {delta:?}");
            }
        }
        // Priming is subject to the same isolation rule as loaded samples.
        // Database speed is not proof of sharing another pool's slots.
        for (path, pool) in paths {
            let (status, elapsed, delta) = observe(app.clone(), path, pool).await;
            eprintln!("blackhole prime {path} status={status} elapsed={elapsed:?} pool_delta={delta:?}");
            assert_isolated(path, status, delta);
        }
        let mut stalled = Vec::new();
        for (pool, size) in [(&common, 8), (&results, 2)] {
            for _ in 0..size {
                let pool = pool.clone();
                stalled.push(tokio::spawn(async move { pool.ping().await }));
            }
        }
        wait_for("all common and result connectors accepted", || {
            common_peer.accepted.load(Ordering::SeqCst) == 8 && result_peer.accepted.load(Ordering::SeqCst) == 2
        }).await;
        assert_eq!(common.evidence.snapshot()[3], 0);
        assert_eq!(results.evidence.snapshot()[3], 0);
        let health_app = app.clone();
        let health = tokio::spawn(async move {
            crate::dispatch(health_app, None, Request {
                method: "GET".into(), target: "/health".into(),
                headers: Headers::from_raw([]), body: vec![],
            }).await
        });
        let mut samples = Vec::new();
        for _ in 0..3 {
            for (path, pool) in paths {
                let before_common = common.evidence.snapshot();
                let before_results = results.evidence.snapshot();
                let (status, elapsed, delta) = observe(app.clone(), path, pool).await;
                samples.push((path, status, elapsed, delta,
                    before_common[3], before_results[3], common.evidence.snapshot()[3], results.evidence.snapshot()[3]));
            }
        }
        let health = health.await.unwrap();
        let still_connecting = common.evidence.snapshot()[3] == 0 && results.evidence.snapshot()[3] == 0;
        common_peer.stop().await;
        result_peer.stop().await;
        for task in stalled { assert!(!task.await.unwrap()); }
        for (path, status, elapsed, delta, c0, r0, c1, r1) in samples {
            eprintln!("blackhole {path} status={status} elapsed={elapsed:?} pool_delta={delta:?} common_completed={c0}/{c1} result_completed={r0}/{r1}");
            assert_isolated(path, status, delta);
            assert_eq!((c0, r0, c1, r1), (0, 0, 0, 0), "all unrelated slots must remain mid-connect throughout each sample");
        }
        // Only the deliberate health probe may wait on the common pool.
        // This also rejects a route that waits there before using its own pool.
        let common_end = common.evidence.snapshot();
        let results_end = results.evidence.snapshot();
        assert_eq!((common_end[1], common_end[2]), (1, 1));
        assert_eq!((results_end[1], results_end[2]), (0, 0));
        assert!(still_connecting);
        assert_eq!(health.status, 503, "health observes its unavailable common pool");
        assert_eq!(common.evidence.snapshot()[0], 8, "no spare common connection");
        assert_eq!(results.evidence.snapshot()[0], 2, "no spare result connection");
    });
}

/// The participation pools, healthy and warmed, with the production limits
/// the connection tests use, beside the report topic map's own two pools.
async fn topic_map_beside_participation(
    database: &Database,
    app: &mut Arc<App>,
    topic_map: Arc<db::Pool>,
) {
    let healthy =
        |limits| db::Pool::new(Connector::Plain(Box::new(database.config.clone())), limits);
    {
        let app = Arc::get_mut(app).unwrap();
        app.delphi_topic_map_db = Some(topic_map);
        app.delphi_topic_map_auth_db = Some(healthy(crate::delphi_topic_map::auth_pool_limits()));
        app.delphi_topic_map_env = "test".into();
        app.next_comment_db = Some(healthy(next_comment::pool_limits()));
        app.next_comment_plain = true;
        app.comments_db = Some(healthy(db::Limits {
            size: 2,
            acquire_timeout: Duration::from_millis(100),
            statement_timeout: Duration::from_millis(1000),
            max_lifetime: Duration::from_secs(300),
        }));
        app.comments_count_db = Some(healthy(db::Limits {
            size: 1,
            acquire_timeout: Duration::from_millis(100),
            statement_timeout: Duration::from_millis(1000),
            max_lifetime: Duration::from_secs(300),
        }));
        app.votes_read_db = Some(healthy(crate::votes_read::pool_limits()));
        app.votes_read_auth_db = Some(healthy(crate::votes_read::pool_limits()));
    }
    warm_pool(app.next_comment_db.as_ref().unwrap(), 2).await;
    warm_pool(app.comments_db.as_ref().unwrap(), 2).await;
    warm_pool(app.comments_count_db.as_ref().unwrap(), 1).await;
    warm_pool(app.votes_read_db.as_ref().unwrap(), 1).await;
    warm_pool(app.votes_read_auth_db.as_ref().unwrap(), 1).await;
}

fn participation_reads(app: &App) -> [(&'static str, Arc<db::Pool>); 3] {
    [
        (
            "/api/v3/nextComment?conversation_id=2fixture",
            app.next_comment_db.clone().unwrap(),
        ),
        (
            "/api/v3/comments?conversation_id=2fixture",
            app.comments_db.clone().unwrap(),
        ),
        (
            "/api/v3/votes?conversation_id=2fixture",
            app.votes_read_db.clone().unwrap(),
        ),
    ]
}

/// As nginx forwards a request: this app redirects one without these.
fn forwarded(target: &str, extra: &[(&str, &str)]) -> Request {
    let mut headers = vec![("host", "localhost"), ("x-forwarded-proto", "https")];
    headers.extend_from_slice(extra);
    Request {
        method: "GET".into(),
        target: target.into(),
        headers: Headers::from_raw(headers),
        body: vec![],
    }
}

/// One participation read: its status, how long it took, and its own pool's
/// evidence across it (acquired, waits, timeouts, completed, errors,
/// deadlines), once every operation it acquired has finished.
async fn participation_read(
    app: Arc<App>,
    path: &str,
    pool: &Arc<db::Pool>,
) -> (u16, Duration, [usize; 6]) {
    let before = pool.evidence.snapshot();
    let start = std::time::Instant::now();
    let response = crate::dispatch(app, None, forwarded(path, &[])).await;
    let took = start.elapsed();
    wait_for("participation database operation completed", || {
        let now = pool.evidence.snapshot();
        now[2] > before[2] || (now[0] > before[0] && now[3] - before[3] == now[0] - before[0])
    })
    .await;
    let after = pool.evidence.snapshot();
    (
        response.status,
        took,
        std::array::from_fn(|i| after[i] - before[i]),
    )
}

/// No wait for a slot of its own pool, every acquired operation finished,
/// and a 502 only with its own failure.
fn participation_isolated(path: &str, status: u16, delta: [usize; 6]) {
    let [acquired, waits, timeouts, completed, errors, deadlines] = delta;
    assert_eq!(
        (waits, timeouts),
        (0, 0),
        "participation must not wait on a pool slot: {path} {delta:?}"
    );
    assert!(
        acquired >= 1,
        "the participation request must acquire its own pool: {path} {delta:?}"
    );
    assert_eq!(
        completed, acquired,
        "all acquired participation work must finish: {path}"
    );
    if status != 200 {
        assert_eq!(status, 502, "{path}");
        assert!(
            errors == 1 || deadlines == 1 || path.starts_with("/api/v3/votes?"),
            "502 without own-route failure evidence: {path} {delta:?}"
        );
    }
}

/// A stored map of about `points` comments for conversation 1 (the vote
/// fixture's), served for report `r1`.
fn store_topic_map(
    database: &Database,
    points: usize,
) -> crate::delphi_topic_map::tests::database_tests::Stored {
    use crate::delphi_topic_map::tests::{database_tests as t, document};
    let map = t::stored(document(points, "load"));
    let mut c = database.connect();
    t::stand_ins(&mut c, false);
    c.batch_execute("INSERT INTO reports(report_id, zid) VALUES('r1', 1)")
        .unwrap();
    t::served(
        &mut c,
        "test",
        1,
        "delphi",
        "participant_visible/1",
        Some(&t::map_family(1, &map)),
    );
    map
}

/// A flood of report topic map requests with the route's own pool stuck
/// mid-connect to a database that never answers: the route takes its few
/// places, sheds every other request at once (503, never a wait), and a vote
/// is written and the next comment, the comments and the votes are read
/// meanwhile, each on its own pool with no wait for a slot.
#[test]
fn connection_bounds_topic_map_flood_leaves_participation_clear() {
    let database = Database::new("topic_map_isolation");
    let (mut app, vote) = setup(&database);
    store_topic_map(&database, 10);
    runtime().block_on(async {
        let peer = Peer::new(None).await;
        let dsn = format!(
            "postgres://postgres@127.0.0.1:{}/{}",
            database.config.get_ports()[0],
            database.config.get_dbname().unwrap()
        );
        let topic_map = db::Pool::new(peer.connector(&dsn), crate::delphi_topic_map::pool_limits());
        topic_map_beside_participation(&database, &mut app, topic_map.clone()).await;
        let state = app.delphi_topic_map.clone();
        let flood: Vec<_> = (0..64)
            .map(|n| {
                let coding = if n % 2 == 0 { "gzip" } else { "identity" };
                tokio::spawn(crate::dispatch(
                    app.clone(),
                    None,
                    forwarded("/api/v3/delphi/topicMap?report_id=r1", &[("accept-encoding", coding)]),
                ))
            })
            .collect();
        wait_for("both topic map slots mid-connect", || peer.accepted.load(Ordering::SeqCst) == 2).await;
        let writer = app.post_votes.as_ref().unwrap();
        let writer_before = [writer.pool.evidence.snapshot(), writer.reads.evidence.snapshot()];
        let voted = handle_after_admission(app.clone(), vote).await;
        assert_eq!(voted.status, 200, "the vote is written while the topic map is flooded");
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        for (path, pool) in &participation_reads(&app) {
            let (status, took, delta) = participation_read(app.clone(), path, pool).await;
            eprintln!("topic map flood {path} status={status} took={took:?} pool_delta={delta:?} in_flight={}", state.in_flight());
            participation_isolated(path, status, delta);
        }
        let writer_after = [writer.pool.evidence.snapshot(), writer.reads.evidence.snapshot()];
        for (before, after) in writer_before.iter().zip(&writer_after) {
            assert_eq!((after[1] - before[1], after[2] - before[2]), (0, 0), "the vote writer waited for a slot");
        }
        // Every map request is the route shedding itself: no place, no free
        // connection, or its database slower than its deadline. None is an
        // answer about the conversation, and none reached Node.
        let mut statuses = std::collections::BTreeMap::new();
        for task in flood {
            *statuses.entry(task.await.unwrap().status).or_insert(0) += 1;
        }
        eprintln!("topic map flood answers {statuses:?} busy={} max_in_flight={}", state.busy(), state.max_in_flight());
        assert_eq!(statuses, std::collections::BTreeMap::from([(503, 64)]));
        assert!(state.max_in_flight() <= crate::delphi_topic_map::MAX_IN_FLIGHT);
        assert!(state.busy() >= 60, "shed at the door, before any read");
        let stuck = topic_map.evidence.snapshot();
        eprintln!("topic map pool {stuck:?}");
        assert_eq!(stuck[0], 2, "only the route's own two slots were taken");
        assert_eq!(app.delphi_topic_map_fallback.load(Ordering::Relaxed), 0);
        peer.stop().await;
    });
}

/// Stored report topic map answers of about a megabyte, sixty-four at once,
/// gzip and identity: the route sends the stored bytes as they are, sheds
/// what its places cannot take, and a vote is written and the next comment,
/// the comments and the votes are read meanwhile, each on its own pool with
/// no wait for a slot; this single-threaded runtime's 1 ms timer is never
/// held back by a map.
#[test]
fn connection_bounds_warm_topic_map_answers_leave_participation_clear() {
    use crate::delphi_topic_map::tests::lateness;
    let database = Database::new("topic_map_warm");
    let (mut app, vote) = setup(&database);
    let map = store_topic_map(&database, 30_000);
    runtime().block_on(async {
        let healthy =
            |limits| db::Pool::new(Connector::Plain(Box::new(database.config.clone())), limits);
        topic_map_beside_participation(
            &database,
            &mut app,
            healthy(crate::delphi_topic_map::pool_limits()),
        )
        .await;
        warm_pool(app.delphi_topic_map_db.as_ref().unwrap(), 2).await;
        let first = crate::dispatch(
            app.clone(),
            None,
            forwarded(
                "/api/v3/delphi/topicMap?report_id=r1",
                &[("accept-encoding", "gzip")],
            ),
        )
        .await;
        assert_eq!(first.status, 200);
        let reads = participation_reads(&app);
        let writer = app.post_votes.as_ref().unwrap();
        let writer_before = [
            writer.pool.evidence.snapshot(),
            writer.reads.evidence.snapshot(),
        ];
        let ((maps, voted, sampled), late) = lateness(async {
            let maps: Vec<_> = ["gzip", "identity", "deflate", "gzip, deflate"]
                .iter()
                .cycle()
                .take(64)
                .map(|coding| {
                    tokio::spawn(crate::dispatch(
                        app.clone(),
                        None,
                        forwarded(
                            "/api/v3/delphi/topicMap?report_id=r1",
                            &[("accept-encoding", coding)],
                        ),
                    ))
                })
                .collect();
            let voted = handle_after_admission(app.clone(), vote).await.status;
            let mut sampled = Vec::new();
            for (path, pool) in &reads {
                sampled.push((*path, participation_read(app.clone(), path, pool).await));
            }
            let mut answered = Vec::new();
            for task in maps {
                let out = task.await.unwrap();
                answered.push((
                    out.status,
                    out.headers
                        .iter()
                        .any(|(k, v)| k == "Content-Encoding" && v == "gzip"),
                    match out.body {
                        crate::http::Body::Fixed(b) => b.len(),
                        _ => 0,
                    },
                ));
            }
            (answered, voted, sampled)
        })
        .await;
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        eprintln!(
            "warm topic map flood: timer lateness {late:?}, participation {sampled:?}, vote {voted}"
        );
        assert_eq!(voted, 200, "the vote is written beside the maps");
        for (path, (status, _, delta)) in &sampled {
            participation_isolated(path, *status, *delta);
            assert_eq!(*status, 200, "{path}");
        }
        // Every map answered is whole and as stored; the rest were shed.
        for (status, gzip, length) in &maps {
            match status {
                200 => assert_eq!(
                    *length,
                    if *gzip {
                        map.gzip.len()
                    } else {
                        map.document.len()
                    }
                ),
                503 => {}
                other => panic!("a stored map answered {other}"),
            }
        }
        // How many are answered depends on the machine: the route has more
        // places than read connections, so a request holding a place is shed
        // too when it waits longer than its pool's acquire timeout while two
        // others read. At least one answer is a liveness expectation for this
        // healthy fixture, assuming successful reads and scheduling progress
        // within the deadlines. It is not an unconditional route guarantee:
        // even a connection holder can fail a statement or the route deadline.
        let answered = maps.iter().filter(|(s, ..)| *s == 200).count();
        eprintln!(
            "warm topic map flood: {answered} of {} answered",
            maps.len()
        );
        assert!(
            answered > 0,
            "the healthy fixture should answer at least one map within the deadlines: {maps:?}"
        );
        let writer_after = [
            writer.pool.evidence.snapshot(),
            writer.reads.evidence.snapshot(),
        ];
        for (before, after) in writer_before.iter().zip(&writer_after) {
            assert_eq!(
                (after[1] - before[1], after[2] - before[2]),
                (0, 0),
                "the vote writer waited for a slot"
            );
        }
        let state = &app.delphi_topic_map;
        assert!(state.max_in_flight() <= crate::delphi_topic_map::MAX_IN_FLIGHT);
        assert!(
            state.max_held() <= crate::delphi_topic_map::MAX_IN_FLIGHT * map.document.len(),
            "stored bytes held at once are bounded by the places: {}",
            state.max_held()
        );
        // Check that the flood gives back every place and byte it held. With
        // this healthy fixture and scheduling progress within the deadline,
        // a lone request should then receive the whole stored document.
        wait_for("the flood's places and bytes given back", || {
            state.in_flight() == 0 && state.held_now() == 0
        })
        .await;
        let started = std::time::Instant::now();
        let again = crate::dispatch(
            app.clone(),
            None,
            forwarded(
                "/api/v3/delphi/topicMap?report_id=r1",
                &[("accept-encoding", "identity")],
            ),
        )
        .await;
        let took = started.elapsed();
        assert_eq!(again.status, 200, "the route serves again after the flood");
        match &again.body {
            crate::http::Body::Fixed(b) => assert!(
                b[..] == map.document.as_bytes()[..],
                "the map after the flood is the stored document"
            ),
            _ => panic!("the map after the flood is not a whole body"),
        }
        assert!(
            took < crate::delphi_topic_map::DEADLINE,
            "answered after {took:?}"
        );
        drop(again);
        // Nothing here hashes, compresses or builds a map: the runtime's
        // thread only copies bytes it was handed.
        assert!(
            late < Duration::from_millis(100),
            "the runtime's thread was held {late:?}"
        );
    });
}

/// The load test of the item that made this route a read of stored bytes:
/// the votes-path reads (the next comment, the comments, the votes) keep
/// their latency while the report topic map is saturated. Each read is
/// sampled sequentially, first with the route idle (the control), then while
/// sixteen clients ask for a stored map of about a megabyte as fast as the
/// route answers them (the route at its places, shedding the rest). Each
/// phase takes at least forty rounds and lasts at least two seconds (twenty
/// periods of the kernel's CPU quota), and the loaded phase takes at least as
/// many rounds as the control. Run it from a release build under the
/// service's own budget (half a CPU, 512 MiB) for the figure that matters
/// (the command is in the change's notes). Every read must be isolated (no
/// wait for a slot of its own pool); the saturated route may not add misses
/// of a read's own deadline beyond the control's (by a share of more than
/// two in forty of the samples taken), and each read's 95th percentile must
/// stay within twice the control's plus 25 ms. The figures are printed
/// whatever the outcome.
#[test]
fn connection_bounds_topic_map_saturation_keeps_participation_latency() {
    // The clients of the split run (see `saturation_over_tcp`): no database.
    if let Ok(target) = std::env::var("POLIS_API_SATURATION_TARGET") {
        return saturation_over_tcp::clients(&target);
    }
    let database = Database::new("topic_map_saturation");
    let (mut app, _) = setup(&database);
    store_topic_map(&database, 30_000);
    // The fewest rounds a phase takes, and the misses of a read's own
    // deadline the saturated route may add in that many samples.
    const ROUNDS: usize = 40;
    const EXTRA_MISSES: usize = 2;
    // Each phase samples for at least this long: twenty periods of the
    // kernel's CPU quota (100 ms each), so that under a quota of half a CPU a
    // pass means the reads stayed clear across many periods, not a few.
    const WINDOW: Duration = Duration::from_secs(2);
    // The service's runtime has threads of its own; a test on one thread
    // would only measure that thread's queue.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let healthy = |limits| db::Pool::new(Connector::Plain(Box::new(database.config.clone())), limits);
        topic_map_beside_participation(&database, &mut app, healthy(crate::delphi_topic_map::pool_limits())).await;
        warm_pool(app.delphi_topic_map_db.as_ref().unwrap(), 2).await;
        // The server of the split run: the same app, served over HTTP.
        if let Ok(address) = std::env::var("POLIS_API_SATURATION_SERVE") {
            return saturation_over_tcp::serve(app.clone(), &address).await;
        }
        let reads = participation_reads(&app);
        // Rounds of the three reads, one of each per round, until at least
        // `min_rounds` rounds have been taken and at least `floor` has
        // passed. Returns the samples and how long they took.
        async fn sample(
            app: &Arc<App>,
            reads: &[(&'static str, Arc<db::Pool>); 3],
            min_rounds: usize,
            floor: Duration,
        ) -> (Vec<Vec<(u16, Duration, [usize; 6])>>, Duration) {
            let mut out = vec![Vec::new(); reads.len()];
            let started = std::time::Instant::now();
            let mut rounds = 0;
            while rounds < min_rounds || started.elapsed() < floor {
                for (i, (path, pool)) in reads.iter().enumerate() {
                    out[i].push(participation_read(app.clone(), path, pool).await);
                }
                rounds += 1;
            }
            (out, started.elapsed())
        }
        fn quantile(samples: &[(u16, Duration, [usize; 6])], q: f64) -> Duration {
            let mut d: Vec<Duration> = samples.iter().map(|s| s.1).collect();
            d.sort();
            d[((d.len() - 1) as f64 * q).round() as usize]
        }
        // Warm every path once, then the control, over the same window floor
        // as the loaded phase.
        let _ = sample(&app, &reads, ROUNDS, Duration::ZERO).await;
        let (control, control_window) = sample(&app, &reads, ROUNDS, WINDOW).await;
        let control_rounds = control[0].len();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let clients: Vec<_> = (0..16)
            .map(|n| {
                let (app, stop) = (app.clone(), stop.clone());
                tokio::spawn(async move {
                    let mut answers = std::collections::BTreeMap::<u16, usize>::new();
                    let coding = if n % 4 == 3 { "identity" } else { "gzip" };
                    while !stop.load(Ordering::SeqCst) {
                        let out = crate::dispatch(
                            app.clone(),
                            None,
                            forwarded("/api/v3/delphi/topicMap?report_id=r1", &[("accept-encoding", coding)]),
                        )
                        .await;
                        *answers.entry(out.status).or_insert(0) += 1;
                        if out.status == 503 {
                            tokio::task::yield_now().await;
                        }
                    }
                    answers
                })
            })
            .collect();
        // The route is saturated before the first loaded sample.
        let state = app.delphi_topic_map.clone();
        wait_for("the topic map at its places", || {
            state.max_in_flight() == crate::delphi_topic_map::MAX_IN_FLIGHT && state.busy() > 0
        })
        .await;
        // At least as many rounds as the control, and across at least the
        // window floor, all under the same flood.
        let (loaded, loaded_window) = sample(&app, &reads, control_rounds, WINDOW).await;
        let loaded_rounds = loaded[0].len();
        stop.store(true, Ordering::SeqCst);
        let mut maps = std::collections::BTreeMap::<u16, usize>::new();
        for client in clients {
            for (status, n) in client.await.unwrap() {
                *maps.entry(status).or_insert(0) += n;
            }
        }
        let cgroup = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").unwrap_or_else(|_| "none".into());
        let mut lines = vec![format!(
            "topic map saturation: cpu.max={} control rounds={control_rounds} in {control_window:?}; loaded rounds={loaded_rounds} in {loaded_window:?}; maps={maps:?} busy={} max_in_flight={} max_held_bytes={}",
            cgroup.trim(),
            state.busy(),
            state.max_in_flight(),
            state.max_held()
        )];
        for (i, (path, _)) in reads.iter().enumerate() {
            let answered = |v: &[(u16, Duration, [usize; 6])]| v.iter().filter(|s| s.0 == 200).count();
            lines.push(format!(
                "  {path}: answered control {}/{control_rounds} loaded {}/{loaded_rounds}",
                answered(&control[i]),
                answered(&loaded[i])
            ));
            lines.push(format!(
                "  {path}: control p50={:?} p95={:?} max={:?}; loaded p50={:?} p95={:?} max={:?}",
                quantile(&control[i], 0.5),
                quantile(&control[i], 0.95),
                quantile(&control[i], 1.0),
                quantile(&loaded[i], 0.5),
                quantile(&loaded[i], 0.95),
                quantile(&loaded[i], 1.0),
            ));
        }
        // Bypass the test harness's capture: the figures are the evidence.
        let report = lines.join("\n") + "\n";
        std::io::Write::write_all(&mut std::io::stdout(), report.as_bytes()).unwrap();
        assert!(maps.get(&200).copied().unwrap_or(0) > 0, "maps were served: {maps:?}");
        assert!(maps.get(&503).copied().unwrap_or(0) > 0, "the route was saturated: {maps:?}");
        assert!(maps.keys().all(|s| *s == 200 || *s == 503), "{maps:?}");
        for (i, (path, _)) in reads.iter().enumerate() {
            // Never a wait for a slot of its own pool. A read may miss its own
            // short deadline on a busy machine (the next comment's is 75 ms)
            // and go back to Node, with its own evidence; the saturated route
            // may not add such misses beyond the control's.
            let missed = |samples: &[(u16, Duration, [usize; 6])]| {
                samples.iter().filter(|(status, ..)| *status != 200).count()
            };
            for (status, _, delta) in control[i].iter().chain(&loaded[i]) {
                participation_isolated(path, *status, *delta);
            }
            // The loaded share of misses may exceed the control's share by
            // at most EXTRA_MISSES in ROUNDS (two in forty), over all the
            // samples taken: loaded/n_l <= control/n_c + 2/40, in integers.
            // With forty samples in each phase this is "control + 2".
            let (c_missed, l_missed) = (missed(&control[i]), missed(&loaded[i]));
            let (n_c, n_l) = (control[i].len(), loaded[i].len());
            assert!(
                l_missed * ROUNDS * n_c <= c_missed * ROUNDS * n_l + EXTRA_MISSES * n_l * n_c,
                "{path} missed its deadline more under a saturated topic map: control {c_missed} of {n_c}, loaded {l_missed} of {n_l} (at most {EXTRA_MISSES} in {ROUNDS} more)"
            );
            let (c95, l95) = (quantile(&control[i], 0.95), quantile(&loaded[i], 0.95));
            assert!(
                l95 <= c95 * 2 + Duration::from_millis(25),
                "{path} lost its latency under a saturated topic map: control p95 {c95:?}, loaded p95 {l95:?}"
            );
        }
    });
}

/// The load test of the reader's form, at the proxy's bound: sixteen clients
/// ask for report topic maps from readers who are not moderators at 200
/// requests a second in all (the nginx rate of this route), while a vote is
/// written, a comment is written, and the next comment, the comments and the
/// votes are read, round after round, as when the route is idle. Each map
/// asked for needs the reader's form: a stored map of 30,000 comments, of
/// which the conversation holds some back (inflate, rewrite, colours chosen
/// again, deflate).
///
/// - One hot map ([`connection_bounds_rewritten_topic_map_keeps_participation_latency`]):
///   every request is for the same map with the same held-back set.
/// - Many maps ([`connection_bounds_rewritten_topic_maps_past_the_cache_keep_participation_latency`]):
///   the requests cycle through more conversations than the route keeps
///   readers' forms for, each with a map and comments held back, so that
///   every request needs a rewrite of its own.
///
/// The rules are the saturation test's, applied to the two writes as well as
/// the three reads: every read isolated (no wait for a slot of its own pool),
/// the vote writer never waiting for a slot, the loaded share of answers
/// other than 200 at most the control's plus two in forty, and each one's
/// 95th percentile within twice the control's plus 25 ms. The comment is
/// written by the comment writer on a database of its own on the same
/// server. The figures, the process's CPU (the cgroup's `cpu.stat`, under a
/// quota when there is one) in each phase, and the route's counters are
/// printed whatever the outcome. Run it from a release build under the
/// service's own budget (half a CPU, 512 MiB) for the figure that matters.
#[test]
fn connection_bounds_rewritten_topic_map_keeps_participation_latency() {
    rewritten_topic_map_load("topic_map_rewrite_load", 0);
}

/// See [`connection_bounds_rewritten_topic_map_keeps_participation_latency`].
#[test]
fn connection_bounds_rewritten_topic_maps_past_the_cache_keep_participation_latency() {
    rewritten_topic_map_load("topic_map_rewrite_many", 72);
}

/// The cgroup's CPU used and throttled, in microseconds, if there is one.
fn cgroup_cpu() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/sys/fs/cgroup/cpu.stat").ok()?;
    let field = |name: &str| {
        stat.lines()
            .find_map(|l| l.strip_prefix(name)?.trim().parse::<u64>().ok())
    };
    Some((field("usage_usec ")?, field("throttled_usec ").unwrap_or(0)))
}

/// The route's `/health` counters, on one line.
fn topic_map_health(state: &crate::delphi_topic_map::State) -> String {
    let health = state.health();
    let Some(obj) = health.as_obj() else {
        return String::new();
    };
    obj.iter()
        .map(|(k, v)| format!("{k}={}", v.to_js_string()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `many`: besides report `r1`, that many more conversations with a map and
/// held-back comments each, the flood cycling through them; zero, every
/// request for `r1`.
fn rewritten_topic_map_load(name: &str, many: usize) {
    use crate::post_comments::tests::database as comments_db;
    const ROUNDS: usize = 40;
    const EXTRA_MISSES: usize = 2;
    const WINDOW: Duration = Duration::from_secs(2);
    // The proxy's rate for this route (`delphiTopicMap-rate.conf.template`).
    const RATE: u64 = 200;
    const CLIENTS: u64 = 16;
    let database = Database::new(name);
    let (mut app, vote) = setup(&database);
    let map = store_topic_map(&database, 30_000);
    // Held back: from comment 1,000 on, every other one, moderated out,
    // inactive or muted in turn.
    database
        .connect()
        .batch_execute(
            "ALTER TABLE comments DISABLE TRIGGER USER;
             INSERT INTO comments(zid, tid, pid, uid, txt, mod, active, velocity)
               SELECT 1, n, 0, 1, 'held back ' || n,
                 CASE WHEN n % 6 = 0 THEN -1 ELSE 1 END, n % 6 <> 2, CASE WHEN n % 6 = 4 THEN 0 ELSE 1 END
               FROM generate_series(1000, 29999, 2) n
             ON CONFLICT DO NOTHING;
             ALTER TABLE comments ENABLE TRIGGER USER;",
        )
        .unwrap();
    // The other conversations: the same stored map under each one's own
    // report, and 2,000 comments of each held back (their own set, so their
    // own reader's form). Rows only the route reads, so no constraint is
    // checked.
    let reports: Vec<String> = if many == 0 {
        vec!["r1".to_owned()]
    } else {
        let mut c = database.connect();
        c.batch_execute(&format!(
            "ALTER TABLE comments DISABLE TRIGGER ALL;
             ALTER TABLE reports DISABLE TRIGGER ALL;
             INSERT INTO reports(report_id, zid) SELECT 'r' || z, z FROM generate_series(2, {last}) z;
             INSERT INTO comments(zid, tid, pid, uid, txt, mod, active, velocity)
               SELECT z, n, 0, 1, 'held back ' || n, -1, true, 1
               FROM generate_series(2, {last}) z, generate_series(1000, 4999, 2) n
             ON CONFLICT DO NOTHING;
             ALTER TABLE comments ENABLE TRIGGER ALL;
             ALTER TABLE reports ENABLE TRIGGER ALL;",
            last = many + 1
        ))
        .unwrap();
        use crate::delphi_topic_map::tests::database_tests as t;
        for z in 2..=(many as i32 + 1) {
            let family = t::map_family(z, &map);
            t::served(
                &mut c,
                "test",
                z,
                "delphi",
                "participant_visible/1",
                Some(&family),
            );
        }
        (2..=many + 1).map(|z| format!("r{z}")).collect()
    };
    let comments = comments_db::Database::new(&format!("{name}_comments"));
    let (writer, key) = comments_db::writer(&comments, vec![]);
    let author = comments_db::bearer(&key, &comments_db::member());
    Arc::get_mut(&mut app).unwrap().post_comments = Some(writer);
    let again = |r: &Request| Request {
        method: r.method.clone(),
        target: r.target.clone(),
        headers: r.headers.clone(),
        body: r.body.clone(),
    };
    let comment = |n: usize| {
        Request {
        method: "POST".into(),
        target: crate::post_comments::PATH.into(),
        headers: Headers::from_raw(vec![
            ("host", "localhost"),
            ("x-forwarded-proto", "https"),
            ("content-type", "application/json"),
            ("authorization", author.as_str()),
        ]),
        body: json!({"conversation_id": "2p027generated", "txt": format!("Generated load comment {n}")})
            .to_string()
            .into_bytes(),
    }
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let healthy = |limits| db::Pool::new(Connector::Plain(Box::new(database.config.clone())), limits);
        topic_map_beside_participation(&database, &mut app, healthy(crate::delphi_topic_map::pool_limits())).await;
        warm_pool(app.delphi_topic_map_db.as_ref().unwrap(), 2).await;
        let reads = participation_reads(&app);
        let writer = app.post_votes.as_ref().unwrap();
        type Sample = (u16, Duration);
        let mut written = 0usize;
        // Rounds of the vote, the comment and the three reads until at least
        // `min_rounds` rounds and `floor` have passed: samples per call, in
        // the order vote, comment, reads; and the cgroup's CPU across them.
        let mut sample = async |min_rounds: usize, floor: Duration| -> (Vec<Vec<Sample>>, String) {
            let mut out = vec![Vec::new(); 2 + reads.len()];
            let (started, cpu) = (std::time::Instant::now(), cgroup_cpu());
            let mut rounds = 0;
            while rounds < min_rounds || started.elapsed() < floor {
                let start = std::time::Instant::now();
                let voted = crate::dispatch(app.clone(), None, again(&vote)).await;
                out[0].push((voted.status, start.elapsed()));
                written += 1;
                let start = std::time::Instant::now();
                let commented = crate::dispatch(app.clone(), None, comment(written)).await;
                out[1].push((commented.status, start.elapsed()));
                for (i, (path, pool)) in reads.iter().enumerate() {
                    let (status, took, delta) = participation_read(app.clone(), path, pool).await;
                    participation_isolated(path, status, delta);
                    out[2 + i].push((status, took));
                }
                rounds += 1;
            }
            let window = started.elapsed();
            let cpu = match (cpu, cgroup_cpu()) {
                (Some((u0, t0)), Some((u1, t1))) => format!(
                    "cpu {:.3} s/s, throttled {:.3} s/s over {window:?}",
                    (u1 - u0) as f64 / 1e6 / window.as_secs_f64(),
                    (t1 - t0) as f64 / 1e6 / window.as_secs_f64()
                ),
                _ => format!("cpu unknown (no cgroup) over {window:?}"),
            };
            (out, cpu)
        };
        let _ = sample(ROUNDS / 4, Duration::ZERO).await;
        let writer_before = [writer.pool.evidence.snapshot(), writer.reads.evidence.snapshot()];
        let (control, control_cpu) = sample(ROUNDS, WINDOW).await;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reports = Arc::new(reports);
        let (gzip_len, plain_len) = (map.gzip.len(), map.document.len());
        let clients: Vec<_> = (0..CLIENTS)
            .map(|n| {
                let (app, stop, asked, reports) = (app.clone(), stop.clone(), asked.clone(), reports.clone());
                tokio::spawn(async move {
                    // (status, whether a 200 was the reader's form)
                    let mut answers = std::collections::BTreeMap::<(u16, bool), usize>::new();
                    let coding = if n % 4 == 3 { "identity" } else { "gzip" };
                    // Each client its share of the rate, never catching up.
                    let mut pace = tokio::time::interval(Duration::from_micros(1_000_000 * CLIENTS / RATE));
                    pace.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    while !stop.load(Ordering::SeqCst) {
                        pace.tick().await;
                        let k = asked.fetch_add(1, Ordering::SeqCst);
                        let target = format!("/api/v3/delphi/topicMap?report_id={}", reports[k % reports.len()]);
                        let out = crate::dispatch(app.clone(), None, forwarded(&target, &[("accept-encoding", coding)])).await;
                        let rewritten = match &out.body {
                            crate::http::Body::Fixed(b) => b.len() != gzip_len && b.len() != plain_len,
                            _ => false,
                        };
                        *answers.entry((out.status, out.status == 200 && rewritten)).or_insert(0) += 1;
                    }
                    answers
                })
            })
            .collect();
        let state = app.delphi_topic_map.clone();
        // The flood is under way (a second of it) before the first loaded sample.
        wait_for("the topic map flood under way", || asked.load(Ordering::SeqCst) >= RATE as usize).await;
        let (loaded, loaded_cpu) = sample(control[0].len(), WINDOW).await;
        stop.store(true, Ordering::SeqCst);
        let mut maps = std::collections::BTreeMap::<(u16, bool), usize>::new();
        for client in clients {
            for (k, n) in client.await.unwrap() {
                *maps.entry(k).or_insert(0) += n;
            }
        }
        let writer_after = [writer.pool.evidence.snapshot(), writer.reads.evidence.snapshot()];
        let names = ["POST /api/v3/votes", "POST /api/v3/comments"]
            .into_iter()
            .chain(reads.iter().map(|(path, _)| *path))
            .collect::<Vec<_>>();
        fn quantile(samples: &[(u16, Duration)], q: f64) -> Duration {
            let mut d: Vec<Duration> = samples.iter().map(|s| s.1).collect();
            d.sort();
            d[((d.len() - 1) as f64 * q).round() as usize]
        }
        let mut lines = vec![
            format!(
                "rewritten topic map load ({}): cpu.max={}; {RATE}/s from {CLIENTS} clients, asked {}; control rounds={} loaded rounds={}; maps (status, rewritten)={maps:?}",
                if many == 0 { "one hot map".to_owned() } else { format!("{many} maps") },
                std::fs::read_to_string("/sys/fs/cgroup/cpu.max").unwrap_or_else(|_| "none".into()).trim(),
                asked.load(Ordering::SeqCst),
                control[0].len(),
                loaded[0].len(),
            ),
            format!("  process control: {control_cpu}"),
            format!("  process loaded: {loaded_cpu}"),
            format!("  route: {}", topic_map_health(&state)),
        ];
        for (i, name) in names.iter().enumerate() {
            let statuses = |v: &[(u16, Duration)]| {
                let mut s = std::collections::BTreeMap::<u16, usize>::new();
                for (status, _) in v {
                    *s.entry(*status).or_insert(0) += 1;
                }
                s
            };
            lines.push(format!(
                "  {name}: control {:?} p50={:?} p95={:?} max={:?}; loaded {:?} p50={:?} p95={:?} max={:?}",
                statuses(&control[i]),
                quantile(&control[i], 0.5),
                quantile(&control[i], 0.95),
                quantile(&control[i], 1.0),
                statuses(&loaded[i]),
                quantile(&loaded[i], 0.5),
                quantile(&loaded[i], 0.95),
                quantile(&loaded[i], 1.0),
            ));
        }
        let report = lines.join("\n") + "\n";
        std::io::Write::write_all(&mut std::io::stdout(), report.as_bytes()).unwrap();
        assert!(maps.get(&(200, true)).copied().unwrap_or(0) > 0, "readers' forms were served: {maps:?}");
        assert_eq!(maps.get(&(200, false)), None, "no reader received the stored bytes: {maps:?}");
        assert!(maps.keys().all(|(s, _)| *s == 200 || *s == 503), "{maps:?}");
        // Never more rewrites at once than the bound; for one hot map, the
        // form is made once (again only if the flood outran a first attempt).
        assert!(state.max_rewriting() <= crate::delphi_topic_map::MAX_REWRITES);
        if many == 0 {
            assert!(state.rewrites() <= 2, "one map, one form: {} rewrites", state.rewrites());
        }
        for (before, after) in writer_before.iter().zip(&writer_after) {
            assert_eq!((after[1] - before[1], after[2] - before[2]), (0, 0), "the vote writer waited for a slot");
        }
        for (i, name) in names.iter().enumerate() {
            let missed = |v: &[(u16, Duration)]| v.iter().filter(|(status, _)| *status != 200).count();
            let (c_missed, l_missed) = (missed(&control[i]), missed(&loaded[i]));
            let (n_c, n_l) = (control[i].len(), loaded[i].len());
            assert!(
                l_missed * ROUNDS * n_c <= c_missed * ROUNDS * n_l + EXTRA_MISSES * n_l * n_c,
                "{name} answered other than 200 more under the rewritten topic map: control {c_missed} of {n_c}, loaded {l_missed} of {n_l}"
            );
            let (c95, l95) = (quantile(&control[i], 0.95), quantile(&loaded[i], 0.95));
            assert!(
                l95 <= c95 * 2 + Duration::from_millis(25),
                "{name} lost its latency under the rewritten topic map: control p95 {c95:?}, loaded p95 {l95:?}"
            );
        }
        // The writes were the participation path's own, answered.
        assert_eq!(missed_all(&control[0]) + missed_all(&loaded[0]), 0, "every vote was written");
        assert_eq!(missed_all(&control[1]) + missed_all(&loaded[1]), 0, "every comment was written");
        fn missed_all(v: &[(u16, Duration)]) -> usize {
            v.iter().filter(|(status, _)| *status != 200).count()
        }
    });
}

/// The saturation load test split across two processes, so that the flood
/// and the samplers can run outside the server's CPU quota (the server in a
/// container limited to half a CPU, the clients in another, over TCP).
///
/// `POLIS_API_SATURATION_SERVE=<ip:port>`: the test seeds the same fixture,
/// builds the same app and serves it over HTTP at that address, with a
/// control listener on the next port, until the clients say stop.
/// `POLIS_API_SATURATION_TARGET=<host:port>`: the test is the clients: the
/// same warm-up, control phase, sixteen-client flood and loaded phase, over
/// HTTP/1.1 with keep-alive, with the same rules. A read's isolation (no wait
/// for a slot of its own pool, every acquired operation finished, a 502 only
/// with its own failure) is checked on the server's pool evidence across
/// each phase, which the control listener reports, with the server's
/// `cpu.stat`. `POLIS_API_SATURATION_FLOOD=<path>` floods another route;
/// `POLIS_API_SATURATION_RATE=<requests per second>` paces the flood.
/// With neither variable set the test runs in one process, as above.
mod saturation_over_tcp {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;

    // The same as the test's.
    const ROUNDS: usize = 40;
    const EXTRA_MISSES: usize = 2;
    const WINDOW: Duration = Duration::from_secs(2);
    const MAP: &str = "/api/v3/delphi/topicMap?report_id=r1";
    const READS: [&str; 3] = [
        "/api/v3/nextComment?conversation_id=2fixture",
        "/api/v3/comments?conversation_id=2fixture",
        "/api/v3/votes?conversation_id=2fixture",
    ];

    fn say(line: String) {
        let line = line + "\n";
        std::io::Write::write_all(&mut std::io::stdout(), line.as_bytes()).unwrap();
        std::io::Write::flush(&mut std::io::stdout()).unwrap();
    }

    fn cgroup(file: &str) -> String {
        std::fs::read_to_string(format!("/sys/fs/cgroup/{file}"))
            .unwrap_or_else(|_| "none".into())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub(super) async fn serve(app: Arc<App>, address: &str) {
        let reads = participation_reads(&app);
        for ((path, _), expected) in reads.iter().zip(READS) {
            assert_eq!(*path, expected);
        }
        let address: std::net::SocketAddr = address.parse().unwrap();
        let control_address = std::net::SocketAddr::new(address.ip(), address.port() + 1);
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let control = tokio::net::TcpListener::bind(control_address)
            .await
            .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = app.clone();
        // Per read, the pool evidence at the arrival of each request for it
        // since the client last asked (`settle`): the evidence of one sample
        // alone, as `participation_read` takes it in one process.
        let arrivals: Arc<[std::sync::Mutex<Vec<[usize; 6]>>; 3]> = Arc::new(Default::default());
        let pools: Vec<Arc<db::Pool>> = reads.iter().map(|(_, pool)| pool.clone()).collect();
        let seen = arrivals.clone();
        let handler = Arc::new(move |req: Request| {
            if let Some(i) = READS.iter().position(|path| req.target == *path) {
                seen[i].lock().unwrap().push(pools[i].evidence.snapshot());
            }
            crate::dispatch(served.clone(), None, req)
        });
        let server = tokio::spawn(crate::http::serve_until(
            listener,
            handler,
            crate::http::Listener::Main,
            async move {
                let _ = stopped.await;
            },
        ));
        say(format!(
            "saturation server ready on {address} (control {control_address}) cpu.max={} memory.max={}",
            cgroup("cpu.max"),
            cgroup("memory.max")
        ));
        let state = app.delphi_topic_map.clone();
        let (socket, _) = control.accept().await.unwrap();
        let (r, mut w) = socket.into_split();
        let mut lines = BufReader::new(r).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            if line == "stop" {
                w.write_all(b"stopping\n").await.unwrap();
                break;
            }
            // `settle <read>`: the requests for that read since the last
            // settle, and its own pool's evidence across them once every
            // operation they acquired has finished (`participation_read`'s
            // condition, here with a ceiling of five seconds).
            if let Some(i) = line.strip_prefix("settle ") {
                let i: usize = i.parse().unwrap();
                let arrived = std::mem::take(&mut *arrivals[i].lock().unwrap());
                let reply = match arrived.first() {
                    None => "settled 0".to_string(),
                    Some(before) => {
                        let pool = &reads[i].1;
                        let started = std::time::Instant::now();
                        loop {
                            let now = pool.evidence.snapshot();
                            if now[2] > before[2]
                                || (now[0] > before[0] && now[3] - before[3] == now[0] - before[0])
                                || started.elapsed() > Duration::from_secs(5)
                            {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                        let after = pool.evidence.snapshot();
                        let delta: Vec<String> =
                            (0..6).map(|k| (after[k] - before[k]).to_string()).collect();
                        format!("settled {} {}", arrived.len(), delta.join(","))
                    }
                };
                w.write_all((reply + "\n").as_bytes()).await.unwrap();
                continue;
            }
            let label = line.strip_prefix("mark ").unwrap_or(&line).to_string();
            // Once every operation the participation pools acquired has finished.
            let started = std::time::Instant::now();
            let settled = loop {
                let settled = reads.iter().all(|(_, pool)| {
                    let s = pool.evidence.snapshot();
                    s[0] == s[3]
                });
                if settled || started.elapsed() > Duration::from_secs(2) {
                    break settled;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            let pools: Vec<String> = reads
                .iter()
                .map(|(_, pool)| {
                    let s = pool.evidence.snapshot();
                    s.iter()
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .collect();
            let reply = format!(
                "{label} {} {} {} {} | {}",
                state.busy(),
                state.max_in_flight(),
                settled as u8,
                pools.join(" "),
                cgroup("cpu.stat")
            );
            say(format!("saturation server mark {reply}"));
            w.write_all((reply + "\n").as_bytes()).await.unwrap();
        }
        let _ = stop.send(());
        let _ = tokio::time::timeout(Duration::from_secs(10), server).await;
        say("saturation server stopped".into());
    }

    /// The server's evidence at one moment.
    struct Mark {
        busy: usize,
        max_in_flight: usize,
        settled: bool,
        pools: [[usize; 6]; 3],
        cpu: BTreeMap<String, u64>,
    }

    impl Mark {
        fn parse(line: &str) -> Mark {
            let (head, cpu) = line.split_once(" | ").expect("a mark line");
            let f: Vec<&str> = head.split_whitespace().collect();
            let pool = |s: &str| -> [usize; 6] {
                let v: Vec<usize> = s.split(',').map(|n| n.parse().unwrap()).collect();
                v.try_into().unwrap()
            };
            let words: Vec<&str> = cpu.split_whitespace().collect();
            Mark {
                busy: f[1].parse().unwrap(),
                max_in_flight: f[2].parse().unwrap(),
                settled: f[3] == "1",
                pools: [pool(f[4]), pool(f[5]), pool(f[6])],
                cpu: words
                    .chunks(2)
                    .filter_map(|kv| Some((kv[0].to_string(), kv.get(1)?.parse().ok()?)))
                    .collect(),
            }
        }
        fn pool_delta(&self, before: &Mark, i: usize) -> [usize; 6] {
            std::array::from_fn(|k| self.pools[i][k] - before.pools[i][k])
        }
        fn cpu_delta(&self, before: &Mark) -> String {
            ["nr_periods", "nr_throttled", "throttled_usec", "usage_usec"]
                .iter()
                .map(|k| {
                    let d = self.cpu.get(*k).copied().unwrap_or(0) as i64
                        - before.cpu.get(*k).copied().unwrap_or(0) as i64;
                    format!("{k}={d}")
                })
                .collect::<Vec<_>>()
                .join(" ")
        }
    }

    struct Control {
        lines: tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
        w: tokio::net::tcp::OwnedWriteHalf,
    }

    impl Control {
        async fn connect(address: &str) -> Control {
            let started = std::time::Instant::now();
            let socket = loop {
                match TcpStream::connect(address).await {
                    Ok(s) => break s,
                    Err(e) if started.elapsed() < Duration::from_secs(180) => {
                        let _ = e;
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    Err(e) => panic!("the saturation server's control listener {address}: {e}"),
                }
            };
            let (r, w) = socket.into_split();
            Control {
                lines: BufReader::new(r).lines(),
                w,
            }
        }
        async fn send(&mut self, line: &str) -> String {
            self.w
                .write_all(format!("{line}\n").as_bytes())
                .await
                .unwrap();
            self.lines
                .next_line()
                .await
                .unwrap()
                .expect("a control reply")
        }
        async fn mark(&mut self, label: &str) -> Mark {
            Mark::parse(&self.send(&format!("mark {label}")).await)
        }
        /// How many requests for read `i` reached the server since the last
        /// settle, and its own pool's evidence across them.
        async fn settle(&mut self, i: usize) -> (usize, [usize; 6]) {
            let reply = self.send(&format!("settle {i}")).await;
            let f: Vec<&str> = reply.split_whitespace().collect();
            assert_eq!(f[0], "settled", "{reply}");
            let seen: usize = f[1].parse().unwrap();
            if seen == 0 {
                return (0, [0; 6]);
            }
            let v: Vec<usize> = f[2].split(',').map(|n| n.parse().unwrap()).collect();
            (seen, v.try_into().unwrap())
        }
    }

    /// One HTTP/1.1 connection, kept alive while the server keeps it.
    struct Conn {
        address: String,
        stream: Option<BufReader<TcpStream>>,
        body: Vec<u8>,
        /// Connections opened, the first included.
        opened: usize,
    }

    impl Conn {
        fn new(address: &str) -> Conn {
            Conn {
                address: address.into(),
                stream: None,
                body: Vec::new(),
                opened: 0,
            }
        }
        /// A GET as nginx forwards it; the answer is read whole. Its status.
        async fn get(&mut self, target: &str, coding: Option<&str>) -> std::io::Result<u16> {
            if self.stream.is_none() {
                self.opened += 1;
                let s = TcpStream::connect(&self.address).await?;
                s.set_nodelay(true)?;
                self.stream = Some(BufReader::new(s));
            }
            let mut request =
                format!("GET {target} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-Proto: https\r\n");
            if let Some(coding) = coding {
                request += &format!("Accept-Encoding: {coding}\r\n");
            }
            request += "\r\n";
            let s = self.stream.as_mut().unwrap();
            match exchange(s, &request, &mut self.body).await {
                Ok((status, keep)) => {
                    if !keep {
                        self.stream = None;
                    }
                    Ok(status)
                }
                Err(e) => {
                    self.stream = None;
                    Err(e)
                }
            }
        }
    }

    async fn exchange(
        s: &mut BufReader<TcpStream>,
        request: &str,
        body: &mut Vec<u8>,
    ) -> std::io::Result<(u16, bool)> {
        use std::io::{Error, ErrorKind};
        let eof = || Error::new(ErrorKind::UnexpectedEof, "closed mid-answer");
        s.get_mut().write_all(request.as_bytes()).await?;
        let mut line = String::new();
        if s.read_line(&mut line).await? == 0 {
            return Err(eof());
        }
        let status: u16 = line
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse().ok())
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, line.clone()))?;
        let (mut length, mut chunked, mut keep) = (None, false, true);
        loop {
            line.clear();
            if s.read_line(&mut line).await? == 0 {
                return Err(eof());
            }
            let h = line.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
                match k.as_str() {
                    "content-length" => length = v.parse::<usize>().ok(),
                    "transfer-encoding" => chunked = v.contains("chunked"),
                    "connection" => keep = !v.contains("close"),
                    _ => {}
                }
            }
        }
        if chunked {
            loop {
                line.clear();
                if s.read_line(&mut line).await? == 0 {
                    return Err(eof());
                }
                let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                    .map_err(|_| Error::new(ErrorKind::InvalidData, line.clone()))?;
                if size == 0 {
                    loop {
                        line.clear();
                        if s.read_line(&mut line).await? == 0 || line.trim().is_empty() {
                            break;
                        }
                    }
                    break;
                }
                body.resize(size + 2, 0);
                s.read_exact(body).await?;
            }
        } else if let Some(n) = length {
            body.resize(n, 0);
            s.read_exact(body).await?;
        } else {
            body.clear();
            s.read_to_end(body).await?;
            keep = false;
        }
        Ok((status, keep))
    }

    /// The status a sample carries when its attempt failed (the connection
    /// refused, closed or broken before a whole answer): not an HTTP status,
    /// and a miss.
    const FAILED: u16 = 0;

    /// One participation read as the client saw it, with the server's
    /// evidence for it alone: how many requests for the read reached the
    /// server since the sample before it (one, when it reached it at all),
    /// and the read's own pool evidence across them once every operation
    /// they acquired had finished.
    #[derive(Clone, Copy, Debug)]
    struct Sample {
        status: u16,
        took: Duration,
        seen: usize,
        delta: [usize; 6],
    }

    /// One phase: the samples of each read, and per read the attempts that
    /// failed and the connections opened again.
    struct Phase {
        samples: [Vec<Sample>; 3],
        failed: [usize; 3],
        reconnects: [usize; 3],
        window: Duration,
    }

    /// One read, timed from its first byte. A failed attempt is never retried
    /// and never replaced by a later answer: it is the sample, as FAILED (a
    /// miss) with the time it took to fail, and the next read opens a new
    /// connection. The flag says whether this read opened one again.
    async fn timed_read(conn: &mut Conn, path: &str) -> (u16, Duration, bool) {
        let opened = conn.opened;
        let start = std::time::Instant::now();
        let status = conn.get(path, None).await.unwrap_or(FAILED);
        (status, start.elapsed(), opened > 0 && conn.opened > opened)
    }

    /// Rounds of the three reads, as the test's `sample`, each read followed
    /// (outside its time) by the server's evidence for it alone.
    async fn sample(
        conn: &mut Conn,
        control: &mut Control,
        min_rounds: usize,
        floor: Duration,
    ) -> Phase {
        let mut phase = Phase {
            samples: Default::default(),
            failed: [0; 3],
            reconnects: [0; 3],
            window: Duration::ZERO,
        };
        let started = std::time::Instant::now();
        let mut rounds = 0;
        while rounds < min_rounds || started.elapsed() < floor {
            for (i, path) in READS.iter().enumerate() {
                let (status, took, reconnected) = timed_read(conn, path).await;
                phase.failed[i] += usize::from(status == FAILED);
                phase.reconnects[i] += usize::from(reconnected);
                let (seen, delta) = control.settle(i).await;
                phase.samples[i].push(Sample {
                    status,
                    took,
                    seen,
                    delta,
                });
            }
            rounds += 1;
        }
        phase.window = started.elapsed();
        phase
    }

    fn missed(samples: &[Sample]) -> usize {
        samples.iter().filter(|s| s.status != 200).count()
    }

    fn quantile(samples: &[Sample], q: f64) -> Duration {
        let mut d: Vec<Duration> = samples.iter().map(|s| s.took).collect();
        d.sort();
        d[((d.len() - 1) as f64 * q).round() as usize]
    }

    /// Why one sample breaks `participation_isolated`'s obligations, or
    /// reached the server other than once, or failed: for the counts printed
    /// before the assertions, which apply `participation_isolated` itself.
    fn violation(path: &str, s: &Sample) -> Option<&'static str> {
        let [acquired, waits, timeouts, completed, errors, deadlines] = s.delta;
        if s.status == FAILED {
            Some("failed_attempt")
        } else if s.seen != 1 {
            Some("not_one_request")
        } else if (waits, timeouts) != (0, 0) {
            Some("waited")
        } else if acquired < 1 {
            Some("acquired_nothing")
        } else if completed != acquired {
            Some("unfinished")
        } else if s.status != 200
            && (s.status != 502
                || !(errors == 1 || deadlines == 1 || path.starts_with("/api/v3/votes?")))
        {
            Some("failure_without_own_evidence")
        } else {
            None
        }
    }

    /// The original obligations, for each sample of one read in one phase.
    fn each_isolated(path: &str, phase: &str, samples: &[Sample]) {
        for s in samples {
            assert_ne!(
                s.status, FAILED,
                "{path}: a participation read failed over HTTP in the {phase} phase after {:?}; a failed attempt is a miss and is not retried: {s:?}",
                s.took
            );
            assert_eq!(
                s.seen, 1,
                "{path}: each sample must reach the server once ({phase}): {s:?}"
            );
            participation_isolated(path, s.status, s.delta);
        }
    }

    /// `participation_isolated`, over a phase: the pool's evidence across
    /// all of the phase's samples of one read.
    fn isolated_over(path: &str, samples: &[Sample], delta: [usize; 6], settled: bool) {
        let [acquired, waits, timeouts, completed, errors, deadlines] = delta;
        assert_eq!(
            (waits, timeouts),
            (0, 0),
            "participation must not wait on a pool slot: {path} {delta:?}"
        );
        assert!(
            acquired >= samples.len(),
            "every participation request must acquire its own pool: {path} {delta:?} for {} samples",
            samples.len()
        );
        assert!(settled, "the server's participation work had not finished");
        assert_eq!(
            completed, acquired,
            "all acquired participation work must finish: {path}"
        );
        let failed = missed(samples);
        assert!(
            samples.iter().all(|s| s.status == 200 || s.status == 502),
            "{path}"
        );
        assert!(
            errors + deadlines >= failed || path.starts_with("/api/v3/votes?"),
            "502 without own-route failure evidence: {path} {delta:?}, {failed} answered 502"
        );
    }

    pub(super) fn clients(target: &str) {
        let (host, port) = target.rsplit_once(':').expect("host:port");
        let control_address = format!("{host}:{}", port.parse::<u16>().unwrap() + 1);
        let flood_path = std::env::var("POLIS_API_SATURATION_FLOOD").unwrap_or_else(|_| MAP.into());
        // `POLIS_API_SATURATION_RATE=<requests per second>`: the sixteen
        // clients together ask no faster than this (unset: as fast as the
        // server answers, as in the test).
        let every = std::env::var("POLIS_API_SATURATION_RATE")
            .ok()
            .map(|r| Duration::from_secs_f64(16.0 / r.parse::<f64>().expect("a rate")));
        // The flood has a runtime of its own, the samplers and the control
        // this thread's, so the samplers do not queue behind the flood.
        let flood_rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let mut control = Control::connect(&control_address).await;
            let mut conn = Conn::new(target);
            let warm = sample(&mut conn, &mut control, ROUNDS, Duration::ZERO).await;
            let c0 = control.mark("control-start").await;
            let control_phase = sample(&mut conn, &mut control, ROUNDS, WINDOW).await;
            let c1 = control.mark("control-end").await;
            let (control_samples, control_window) = (&control_phase.samples, control_phase.window);
            let control_rounds = control_samples[0].len();
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let answered = Arc::new(AtomicUsize::new(0));
            let flood_started = std::time::Instant::now();
            let flooders: Vec<_> = (0..16)
                .map(|n| {
                    let (stop, answered) = (stop.clone(), answered.clone());
                    let (target, path) = (target.to_string(), flood_path.clone());
                    let coding = if n % 4 == 3 { "identity" } else { "gzip" };
                    flood_rt.spawn(async move {
                        let mut conn = Conn::new(&target);
                        let mut answers = BTreeMap::<u16, usize>::new();
                        let mut errors = 0usize;
                        // Paced at its share of the rate, if one is given:
                        // never faster, slower when the server is.
                        let mut next = tokio::time::Instant::now();
                        while !stop.load(Ordering::SeqCst) {
                            if let Some(every) = every {
                                next += every;
                                tokio::time::sleep_until(next).await;
                            }
                            match tokio::time::timeout(Duration::from_secs(10), conn.get(&path, Some(coding))).await {
                                Ok(Ok(status)) => {
                                    *answers.entry(status).or_insert(0) += 1;
                                    answered.fetch_add(1, Ordering::Relaxed);
                                }
                                _ => {
                                    errors += 1;
                                    conn.stream = None;
                                }
                            }
                        }
                        (answers, errors)
                    })
                })
                .collect();
            // The route is saturated before the first loaded sample.
            if flood_path == MAP {
                loop {
                    let m = control.mark("waiting").await;
                    if m.max_in_flight == crate::delphi_topic_map::MAX_IN_FLIGHT && m.busy > 0 {
                        break;
                    }
                    assert!(flood_started.elapsed() < Duration::from_secs(30), "the topic map never reached its places");
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            } else {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let l0 = control.mark("loaded-start").await;
            let answered_before = answered.load(Ordering::Relaxed);
            let loaded_phase = sample(&mut conn, &mut control, control_rounds, WINDOW).await;
            let (loaded, loaded_window) = (&loaded_phase.samples, loaded_phase.window);
            let answered_loaded = answered.load(Ordering::Relaxed) - answered_before;
            let l1 = control.mark("loaded-end").await;
            stop.store(true, Ordering::SeqCst);
            let flood_time = flood_started.elapsed();
            let (mut maps, mut flood_errors) = (BTreeMap::<u16, usize>::new(), 0);
            for f in flooders {
                let (answers, errors) = f.await.unwrap();
                flood_errors += errors;
                for (status, n) in answers {
                    *maps.entry(status).or_insert(0) += n;
                }
            }
            let _ = control.send("stop").await;
            let loaded_rounds = loaded[0].len();
            let mut lines = vec![
                format!(
                    "topic map saturation over tcp: flood {flood_path} target {target}; clients cpu.max={}; control rounds={control_rounds} in {control_window:?}; loaded rounds={loaded_rounds} in {loaded_window:?}; maps={maps:?} flood_errors={flood_errors} warm-up failed={:?} reconnects={:?} busy={} max_in_flight={}",
                    cgroup("cpu.max"),
                    warm.failed,
                    warm.reconnects,
                    l1.busy,
                    l1.max_in_flight
                ),
                format!(
                    "  flood rate: {:.0}/s over the loaded phase ({answered_loaded} in {loaded_window:?}), {:.0}/s over the flood ({} in {flood_time:?})",
                    answered_loaded as f64 / loaded_window.as_secs_f64(),
                    maps.values().sum::<usize>() as f64 / flood_time.as_secs_f64(),
                    maps.values().sum::<usize>()
                ),
                format!("  server cpu.stat control: {}", c1.cpu_delta(&c0)),
                format!("  server cpu.stat loaded: {}", l1.cpu_delta(&l0)),
            ];
            for (i, path) in READS.iter().enumerate() {
                let (c, l) = (&control_samples[i], &loaded[i]);
                let (c_missed, l_missed, n_c, n_l) = (missed(c), missed(l), c.len(), l.len());
                let misses_ok = l_missed * ROUNDS * n_c <= c_missed * ROUNDS * n_l + EXTRA_MISSES * n_l * n_c;
                let (c95, l95) = (quantile(c, 0.95), quantile(l, 0.95));
                let p95_ok = l95 <= c95 * 2 + Duration::from_millis(25);
                lines.push(format!(
                    "  {path}: control n={n_c} missed={c_missed} p50={:?} p95={c95:?} max={:?}; loaded n={n_l} missed={l_missed} p50={:?} p95={l95:?} max={:?}; misses rule {} p95 rule {} (bound {:?})",
                    quantile(c, 0.5),
                    quantile(c, 1.0),
                    quantile(l, 0.5),
                    quantile(l, 1.0),
                    if misses_ok { "ok" } else { "FAIL" },
                    if p95_ok { "ok" } else { "FAIL" },
                    c95 * 2 + Duration::from_millis(25)
                ));
                lines.push(format!(
                    "  {path}: server pool evidence control {:?} loaded {:?}",
                    c1.pool_delta(&c0, i),
                    l1.pool_delta(&l0, i)
                ));
                // Per read and phase: failed attempts (each also a miss
                // above), connections opened again, and the samples whose
                // own evidence breaks a per-request obligation, by reason.
                let broken = |v: &[Sample]| {
                    let mut by = BTreeMap::<&str, usize>::new();
                    for s in v {
                        if let Some(reason) = violation(path, s) {
                            *by.entry(reason).or_insert(0) += 1;
                        }
                    }
                    by
                };
                lines.push(format!(
                    "  {path}: control failed_attempts={} reconnects={} per_request_violations={:?}; loaded failed_attempts={} reconnects={} per_request_violations={:?}",
                    control_phase.failed[i],
                    control_phase.reconnects[i],
                    broken(c),
                    loaded_phase.failed[i],
                    loaded_phase.reconnects[i],
                    broken(l)
                ));
            }
            say(lines.join("\n"));
            assert!(maps.get(&200).copied().unwrap_or(0) > 0, "maps were served: {maps:?}");
            assert!(maps.get(&503).copied().unwrap_or(0) > 0, "the route was saturated: {maps:?}");
            assert!(maps.keys().all(|s| *s == 200 || *s == 503), "{maps:?}");
            for (i, path) in READS.iter().enumerate() {
                each_isolated(path, "control", &control_samples[i]);
                each_isolated(path, "loaded", &loaded[i]);
                isolated_over(path, &control_samples[i], c1.pool_delta(&c0, i), c1.settled);
                isolated_over(path, &loaded[i], l1.pool_delta(&l0, i), l1.settled);
                let (c_missed, l_missed) = (missed(&control_samples[i]), missed(&loaded[i]));
                let (n_c, n_l) = (control_samples[i].len(), loaded[i].len());
                assert!(
                    l_missed * ROUNDS * n_c <= c_missed * ROUNDS * n_l + EXTRA_MISSES * n_l * n_c,
                    "{path} missed its deadline more under a saturated topic map: control {c_missed} of {n_c}, loaded {l_missed} of {n_l} (at most {EXTRA_MISSES} in {ROUNDS} more)"
                );
                let (c95, l95) = (quantile(&control_samples[i], 0.95), quantile(&loaded[i], 0.95));
                assert!(
                    l95 <= c95 * 2 + Duration::from_millis(25),
                    "{path} lost its latency under a saturated topic map: control p95 {c95:?}, loaded p95 {l95:?}"
                );
            }
        });
    }

    /// A first attempt that reaches the server, takes 100 ms and is closed
    /// before any answer is a miss with its 100 ms in the split client's
    /// samples: the next read, answered at once on a new connection, is its
    /// own sample and replaces nothing.
    #[tokio::test]
    async fn split_client_counts_a_failed_first_attempt_as_a_miss() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let mut request = [0u8; 1024];
            let (mut first, _) = listener.accept().await.unwrap();
            assert!(
                first.read(&mut request).await.unwrap() > 0,
                "the first attempt reached the server"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(first);
            let (mut second, _) = listener.accept().await.unwrap();
            assert!(second.read(&mut request).await.unwrap() > 0);
            second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
            second
        });
        let mut conn = Conn::new(&address);
        let mut samples = vec![];
        for _ in 0..2 {
            let (status, took, reconnected) = timed_read(&mut conn, READS[0]).await;
            samples.push((
                Sample {
                    status,
                    took,
                    seen: 1,
                    delta: [1, 0, 0, 1, 0, 0],
                },
                reconnected,
            ));
        }
        let _ = server.await.unwrap();
        let (first, second) = (samples[0], samples[1]);
        assert_eq!(first.0.status, FAILED, "{samples:?}");
        assert!(first.0.took >= Duration::from_millis(100), "{samples:?}");
        assert!(!first.1, "the first connection is not a reconnect");
        assert_eq!(second.0.status, 200, "{samples:?}");
        assert!(second.1, "the second read opened a new connection");
        let recorded: Vec<Sample> = samples.iter().map(|s| s.0).collect();
        assert_eq!(missed(&recorded), 1, "the failed attempt is a miss");
        assert!(quantile(&recorded, 1.0) >= Duration::from_millis(100));
        assert_eq!(violation(READS[0], &first.0), Some("failed_attempt"));
        assert_eq!(violation(READS[0], &second.0), None);
        let caught = std::panic::catch_unwind(|| each_isolated(READS[0], "test", &recorded));
        assert!(
            caught.is_err(),
            "the per-sample rule refuses a failed attempt"
        );
    }
}

/// Stored map answers held on their way to clients that do not read, through
/// the real HTTP server: the route's places and byte count last as long as
/// each answer is being written, so a fifth request is shed while four
/// answers wait on their readers, the bytes held are four documents, a
/// dropped connection or the write deadline lets go of its answer, and the
/// votes-path reads keep their latency meanwhile (the load test's rule:
/// no wait for a slot of their own pool, no more misses of their own
/// deadline than the control's plus two, the 95th percentile within twice
/// the control's plus 25 ms).
#[test]
fn connection_bounds_held_topic_map_answers_keep_their_places_until_written() {
    let database = Database::new("topic_map_held");
    let (mut app, _) = setup(&database);
    let map = store_topic_map(&database, 30_000);
    const ROUNDS: usize = 20;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let healthy = |limits| db::Pool::new(Connector::Plain(Box::new(database.config.clone())), limits);
        topic_map_beside_participation(&database, &mut app, healthy(crate::delphi_topic_map::pool_limits())).await;
        let state = app.delphi_topic_map.clone();
        let reads = participation_reads(&app);
        // The server's send buffer is set small on the listening socket, and
        // the connections it accepts inherit it, so the kernel cannot take a
        // whole answer from the server while its reader reads nothing. Left
        // at its default, an accepted loopback socket on Linux starts with a
        // send buffer of megabytes, larger than the document: the write would
        // complete at once and let go of its place, as a completed write
        // should, and nothing here would be held.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_send_buffer_size(4096).unwrap();
        let send_buffer = socket.send_buffer_size().unwrap() as usize;
        assert!(
            send_buffer * 8 < map.document.len(),
            "the server's send buffer ({send_buffer} bytes) must be far smaller than the document ({} bytes)",
            map.document.len()
        );
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(64).unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = app.clone();
        let handler = Arc::new(move |req: Request| crate::dispatch(served.clone(), None, req));
        let server = tokio::spawn(crate::http::serve_until(listener, handler, crate::http::Listener::Main, async move {
            let _ = stopped.await;
        }));
        // A client that asks for the document and reads nothing, with a
        // receive buffer far smaller than the answer.
        async fn stalled(address: std::net::SocketAddr) -> tokio::net::TcpStream {
            let socket = tokio::net::TcpSocket::new_v4().unwrap();
            socket.set_recv_buffer_size(4096).unwrap();
            let mut stream = socket.connect(address).await.unwrap();
            tokio::io::AsyncWriteExt::write_all(
                &mut stream,
                b"GET /api/v3/delphi/topicMap?report_id=r1 HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            stream
        }
        // The family is checked once, before the clock starts.
        let first = crate::dispatch(app.clone(), None, forwarded("/api/v3/delphi/topicMap?report_id=r1", &[])).await;
        assert_eq!(first.status, 200);
        async fn sample(app: &Arc<App>, reads: &[(&'static str, Arc<db::Pool>); 3]) -> Vec<Vec<(u16, Duration, [usize; 6])>> {
            let mut out = vec![Vec::new(); reads.len()];
            for _ in 0..ROUNDS {
                for (i, (path, pool)) in reads.iter().enumerate() {
                    out[i].push(participation_read(app.clone(), path, pool).await);
                }
            }
            out
        }
        fn quantile(samples: &[(u16, Duration, [usize; 6])], q: f64) -> Duration {
            let mut d: Vec<Duration> = samples.iter().map(|s| s.1).collect();
            d.sort();
            d[((d.len() - 1) as f64 * q).round() as usize]
        }
        let _ = sample(&app, &reads).await;
        let control = sample(&app, &reads).await;
        let busy_before = state.busy();
        let doc = map.document.len();
        // The four that are answered arrive one at a time, each once the one
        // before holds its answer, so none of them waits for a read
        // connection: the route has more places than read connections, and a
        // request reading beside two others can be shed at its pool on a slow
        // machine, which is not what this test is about. This healthy-fixture
        // setup requires all four answers to become held before the earlier
        // answers reach their write deadlines. Then eight more arrive while
        // every place is taken.
        let mut clients = Vec::new();
        for n in 1..=crate::delphi_topic_map::MAX_IN_FLIGHT {
            clients.push(stalled(address).await);
            wait_for("one more answer held", || state.in_flight() == n && state.held_now() == n * doc).await;
        }
        for _ in 0..8 {
            clients.push(stalled(address).await);
        }
        wait_for("four answers held, eight shed", || {
            state.in_flight() == crate::delphi_topic_map::MAX_IN_FLIGHT && state.busy() >= busy_before + 8
        })
        .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (held_places, held_bytes) = (state.in_flight(), state.held_now());
        eprintln!("held topic map answers: places {held_places}, bytes {held_bytes}, shed {}", state.busy() - busy_before);
        assert_eq!(held_places, crate::delphi_topic_map::MAX_IN_FLIGHT, "the places last while the answers are written");
        assert_eq!(held_bytes, crate::delphi_topic_map::MAX_IN_FLIGHT * doc, "the bytes on their way are counted");
        // A fifth asker is shed at once while four answers wait on readers.
        let shed = crate::dispatch(app.clone(), None, forwarded("/api/v3/delphi/topicMap?report_id=r1", &[])).await;
        assert_eq!(shed.status, 503);
        let loaded = sample(&app, &reads).await;
        assert_eq!(state.in_flight(), crate::delphi_topic_map::MAX_IN_FLIGHT, "still held throughout the samples");
        let mut lines = vec![format!(
            "held topic map answers: places {held_places} bytes {held_bytes} (document {doc}) rounds={ROUNDS}"
        )];
        for (i, (path, _)) in reads.iter().enumerate() {
            lines.push(format!(
                "  {path}: control p50={:?} p95={:?}; held p50={:?} p95={:?}",
                quantile(&control[i], 0.5),
                quantile(&control[i], 0.95),
                quantile(&loaded[i], 0.5),
                quantile(&loaded[i], 0.95),
            ));
        }
        let report = lines.join("\n") + "\n";
        std::io::Write::write_all(&mut std::io::stdout(), report.as_bytes()).unwrap();
        for (i, (path, _)) in reads.iter().enumerate() {
            let missed = |v: &[(u16, Duration, [usize; 6])]| v.iter().filter(|s| s.0 != 200).count();
            for (status, _, delta) in control[i].iter().chain(&loaded[i]) {
                participation_isolated(path, *status, *delta);
            }
            assert!(missed(&loaded[i]) <= missed(&control[i]) + 2, "{path} missed its deadline more while answers were held");
            let (c95, l95) = (quantile(&control[i], 0.95), quantile(&loaded[i], 0.95));
            assert!(l95 <= c95 * 2 + Duration::from_millis(25), "{path}: control p95 {c95:?}, held p95 {l95:?}");
        }
        // Which clients hold a map and which were shed: the first bytes of
        // each answer.
        let mut held = Vec::new();
        for mut client in clients {
            let mut status = [0u8; 12];
            tokio::io::AsyncReadExt::read_exact(&mut client, &mut status).await.unwrap();
            if &status == b"HTTP/1.1 200" {
                held.push(client);
            }
        }
        assert_eq!(held.len(), crate::delphi_topic_map::MAX_IN_FLIGHT);
        // Readers that leave let go of their answers.
        drop(held.drain(..2).collect::<Vec<_>>());
        wait_for("dropped connections let go", || {
            state.in_flight() == crate::delphi_topic_map::MAX_IN_FLIGHT - 2
                && state.held_now() == (crate::delphi_topic_map::MAX_IN_FLIGHT - 2) * doc
        })
        .await;
        // The rest read: every answer that was held arrives whole.
        for mut client in held {
            let mut got = Vec::new();
            tokio::time::timeout(Duration::from_secs(10), tokio::io::AsyncReadExt::read_to_end(&mut client, &mut got))
                .await
                .expect("a held answer is written once read")
                .unwrap();
            assert!(got.len() > doc, "the held answer arrives whole: {} bytes", got.len());
        }
        wait_for("every answer written or let go", || state.in_flight() == 0 && state.held_now() == 0).await;
        // A reader that never reads is let go at the write deadline.
        let never = stalled(address).await;
        wait_for("one answer held", || state.in_flight() == 1).await;
        let started = std::time::Instant::now();
        tokio::time::timeout(crate::http::HELD_WRITE_DEADLINE + Duration::from_secs(3), async {
            while state.in_flight() != 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the write deadline lets go of a held answer");
        assert!(started.elapsed() >= crate::http::HELD_WRITE_DEADLINE - Duration::from_millis(500));
        assert_eq!(state.held_now(), 0);
        drop(never);
        let _ = stop.send(());
        let _ = server.await;
    });
}

#[test]
fn connection_bounds_warm_next_comment_hands_back_and_reclaims() {
    let database = Database::new("silent_next_comment");
    let (mut app, _) = setup(&database);
    runtime().block_on(async {
        let peer = Peer::new(Some(database.config.get_ports()[0])).await;
        let dsn = format!(
            "postgres://postgres@127.0.0.1:{}/{}",
            database.config.get_ports()[0],
            database.config.get_dbname().unwrap()
        );
        let pool = db::Pool::new(peer.connector(&dsn), next_comment::pool_limits());
        let app_mut = Arc::get_mut(&mut app).unwrap();
        app_mut.next_comment_db = Some(pool.clone());
        app_mut.next_comment_plain = true;
        let request = || Request {
            method: "GET".into(),
            target: "/api/v3/nextComment?conversation_id=2fixture".into(),
            headers: Headers::from_raw([("x-forwarded-proto", "https")]),
            body: vec![],
        };
        assert!(
            pool.ping().await,
            "establish the warm client before the route sample"
        );
        assert_eq!(
            crate::dispatch(app.clone(), None, request()).await.status,
            200
        );
        let before = pool.evidence.snapshot();
        peer.silence();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let response = crate::dispatch(app.clone(), None, request()).await;
        let reclaimed = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if pool.evidence.snapshot()[3] == before[3] + 1
                    && peer.closed.load(Ordering::SeqCst) == 1
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let closed = peer.closed.load(Ordering::SeqCst);
        peer.stop().await;
        wait_for("next comment work finished after fixture cleanup", || {
            pool.evidence.snapshot()[3] == before[3] + 1
        })
        .await;
        eprintln!(
            "warm next comment status={} reclaimed={reclaimed} peer_closed={closed}",
            response.status
        );
        assert_eq!(response.status, 502, "read failure hands back");
        assert!(
            reclaimed,
            "the caller deadline alone must not retain a slot indefinitely"
        );
        assert_eq!(closed, 1);
    });
}

#[test]
fn connection_bounds_queued_writer_preserves_unknown_and_retry_receipt() {
    let database = Database::new("bounded_writer_wait");
    let (app, request) = setup(&database);
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let held = hold_pool(&writer.pool, 4).await;
        let before = writer.pool.evidence.snapshot();
        let (first, _, observation) =
            observed_after_admission(app.clone(), copy_request(&request)).await;
        let ended = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if observation.lock().unwrap().finished {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let acquired = writer.pool.evidence.snapshot()[0];
        // Release on the baseline too, before any failing assertion.
        held.release().await;
        wait_for("queued dispatch ended", || {
            observation.lock().unwrap().finished
        })
        .await;
        assert!(ended, "dispatched slot wait must have a cutoff");
        assert_eq!(
            acquired, before[0],
            "timed-out dispatch never acquired a connection"
        );
        assert_eq!(first.status, 202);
        assert!(
            !first
                .headers
                .iter()
                .any(|(name, _)| name == "X-Polis-Vote-Dispatch")
        );
        assert!(
            observation
                .lock()
                .unwrap()
                .receipt
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .is_none()
        );
        let count = tokio::task::spawn_blocking({
            let config = database.config.clone();
            move || {
                config
                    .connect(postgres::NoTls)
                    .unwrap()
                    .query_one("SELECT count(*) FROM votes", &[])
                    .unwrap()
                    .get::<_, i64>(0)
            }
        })
        .await
        .unwrap();
        assert_eq!(count, 0);
        let retry = handle_after_admission(app.clone(), copy_request(&request)).await;
        assert_eq!(retry.status, 200);
        assert!(!accepted_body(&retry).vote.replayed);
        let replay = handle_after_admission(app.clone(), request).await;
        assert_eq!(replay.status, 200);
        assert!(accepted_body(&replay).vote.replayed);
        let count = tokio::task::spawn_blocking({
            let config = database.config.clone();
            move || {
                config
                    .connect(postgres::NoTls)
                    .unwrap()
                    .query_one("SELECT count(*) FROM votes", &[])
                    .unwrap()
                    .get::<_, i64>(0)
            }
        })
        .await
        .unwrap();
        assert_eq!(count, 1);
        eprintln!("queued writer first=202 retry=200 replay=200 history={count}");
        wait_for_idle(writer).await;
    });
}
