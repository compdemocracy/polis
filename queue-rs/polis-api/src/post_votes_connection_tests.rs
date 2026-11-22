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
        assert!(
            maps.iter().filter(|(s, ..)| *s == 200).count() >= 4,
            "{maps:?}"
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
/// route answers them (the route at its places, shedding the rest). Run it
/// under the service's own budget (half a CPU, 512 MiB) for the figure that
/// matters (the command is in the change's notes). Every read must be
/// isolated (no wait for a slot of its own pool); the saturated route may not
/// add misses of a read's own deadline beyond the control's (by more than
/// two of forty), and each read's 95th percentile must stay within twice the
/// control's plus 25 ms. The figures are printed whatever the outcome.
#[test]
fn connection_bounds_topic_map_saturation_keeps_participation_latency() {
    let database = Database::new("topic_map_saturation");
    let (mut app, _) = setup(&database);
    store_topic_map(&database, 30_000);
    const ROUNDS: usize = 40;
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
        let reads = participation_reads(&app);
        async fn sample(
            app: &Arc<App>,
            reads: &[(&'static str, Arc<db::Pool>); 3],
        ) -> Vec<Vec<(u16, Duration, [usize; 6])>> {
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
        // Warm every path once, then the control.
        let _ = sample(&app, &reads).await;
        let control = sample(&app, &reads).await;
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
        let loaded = sample(&app, &reads).await;
        stop.store(true, Ordering::SeqCst);
        let mut maps = std::collections::BTreeMap::<u16, usize>::new();
        for client in clients {
            for (status, n) in client.await.unwrap() {
                *maps.entry(status).or_insert(0) += n;
            }
        }
        let cgroup = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").unwrap_or_else(|_| "none".into());
        let mut lines = vec![format!(
            "topic map saturation: cpu.max={} rounds={ROUNDS} maps={maps:?} busy={} max_in_flight={} max_held_bytes={}",
            cgroup.trim(),
            state.busy(),
            state.max_in_flight(),
            state.max_held()
        )];
        for (i, (path, _)) in reads.iter().enumerate() {
            let answered = |v: &[(u16, Duration, [usize; 6])]| v.iter().filter(|s| s.0 == 200).count();
            lines.push(format!(
                "  {path}: answered control {}/{ROUNDS} loaded {}/{ROUNDS}",
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
            let (c_missed, l_missed) = (missed(&control[i]), missed(&loaded[i]));
            assert!(
                l_missed <= c_missed + 2,
                "{path} missed its deadline more under a saturated topic map: control {c_missed}, loaded {l_missed} of {ROUNDS}"
            );
            let (c95, l95) = (quantile(&control[i], 0.95), quantile(&loaded[i], 0.95));
            assert!(
                l95 <= c95 * 2 + Duration::from_millis(25),
                "{path} lost its latency under a saturated topic map: control p95 {c95:?}, loaded p95 {l95:?}"
            );
        }
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
