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
