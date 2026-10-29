use super::{database::Database, *};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::json;
use std::sync::atomic::Ordering;

fn runtime() -> tokio::runtime::Runtime {
    // Route polls stay on one thread so the dispatch observer can attribute a
    // newly owned notification lane to that caller. Async callers still race;
    // PostgreSQL operations run concurrently on the four blocking writer slots.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn setup(db: &Database) -> (Arc<App>, Request) {
    setup_with_statement_timeout(db, Duration::from_secs(1))
}

fn setup_with_statement_timeout(db: &Database, statement_timeout: Duration) -> (Arc<App>, Request) {
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
        statement_timeout,
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
    // Connection establishment is not part of these route/property tests.
    // Occupy every slot until all clients exist, then join their release.
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        warm_pool(&writer.reads, 2).await;
        warm_pool(&writer.pool, 4).await;
        warm_pool(&writer.background.pool, 2).await;
    });
    (Arc::new(app), request)
}

// A watchdog diagnoses a missing event; elapsed time never establishes ordering.
const EVENT_WATCHDOG: Duration = Duration::from_secs(30);

async fn wait_for(label: &str, mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(EVENT_WATCHDOG, async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("event not observed: {label}"));
}

struct HeldPool {
    releases: Vec<std::sync::mpsc::Sender<()>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl HeldPool {
    async fn release(self) {
        drop(self.releases);
        for task in self.tasks {
            task.await.unwrap();
        }
    }
}

async fn hold_pool(pool: &Arc<db::Pool>, size: usize) -> HeldPool {
    hold_prepared_pool(pool, size, |_| Ok(())).await
}

async fn hold_prepared_pool(
    pool: &Arc<db::Pool>,
    size: usize,
    prepare: fn(&mut postgres::Client) -> anyhow::Result<()>,
) -> HeldPool {
    let (ready, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let mut held_pool = HeldPool {
        releases: Vec::new(),
        tasks: Vec::new(),
    };
    for _ in 0..size {
        let pool = pool.clone();
        let ready = ready.clone();
        let (release, held) = std::sync::mpsc::channel::<()>();
        held_pool.releases.push(release);
        held_pool.tasks.push(tokio::spawn(async move {
            pool.with(move |client| {
                prepare(client)?;
                ready.send(()).unwrap();
                drop(ready);
                // Dropping the sender also releases this worker on assertion failure.
                let _ = held.recv();
                Ok(())
            })
            .await
            .unwrap();
        }));
    }
    drop(ready);
    for _ in 0..size {
        tokio::time::timeout(EVENT_WATCHDOG, receive.recv())
            .await
            .unwrap()
            .unwrap();
    }
    held_pool
}

async fn warm_pool(pool: &Arc<db::Pool>, size: usize) {
    hold_pool(pool, size).await.release().await;
}

async fn wait_for_sql(db: &Database, sql: String) {
    let config = db.config.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = config.connect(postgres::NoTls).unwrap();
        database::wait_for_query(&mut c, &sql);
    })
    .await
    .unwrap();
}

/// Observe the ownership transferred to dispatch at creation, before it can
/// acquire a writer connection. Tokio never polls a spawned task inline. On
/// this current-thread runtime no other async task can change this fixture's
/// notification-lane Arc during a route poll, and blocking SQL closures do not
/// own that Arc. Thus each +1 is this caller creating its dispatch, including
/// a task suspended before its first poll. Other tests own different lanes.
async fn observed_handle(app: Arc<App>, request: Request) -> (Outgoing, Option<Duration>) {
    use std::{future::Future, task::Poll, time::Instant};
    assert_eq!(
        tokio::runtime::Handle::current().runtime_flavor(),
        tokio::runtime::RuntimeFlavor::CurrentThread
    );
    let writer = app.post_votes.as_ref().unwrap();
    let mut route = Box::pin(route::handle(app.clone(), request));
    let mut dispatched = None;
    std::future::poll_fn(|cx| {
        let before = Arc::strong_count(&writer.background);
        let started = Instant::now();
        let result = route.as_mut().poll(cx);
        let after = Arc::strong_count(&writer.background);
        if after != before {
            assert_eq!(after, before + 1, "one dispatch owns one notification lane");
            assert!(
                dispatched.replace(started).is_none(),
                "one dispatch per caller"
            );
        }
        match result {
            Poll::Pending => Poll::Pending,
            Poll::Ready(response) => {
                if response.status == 502 {
                    assert_handback(&response);
                    assert!(
                        dispatched.is_none(),
                        "marked handback must create no dispatch"
                    );
                }
                Poll::Ready((response, dispatched.map(|start| start.elapsed())))
            }
        }
    })
    .await
}

/// Reach the operation a semantic test is about despite pre-dispatch shedding.
/// A handback has no receipt or writer work; only that outcome is safe to retry.
/// Tests of concurrent admission and the real deadline call the route directly.
async fn handle_after_admission(app: Arc<App>, request: Request) -> Outgoing {
    handle_after_admission_timed(app, request).await.0
}

async fn handle_after_admission_timed(
    app: Arc<App>,
    request: Request,
) -> (Outgoing, Option<Duration>) {
    tokio::time::timeout(EVENT_WATCHDOG, async {
        let writer = app.post_votes.as_ref().unwrap();
        let mut handed_back = 0;
        loop {
            let (response, elapsed) = observed_handle(app.clone(), copy_request(&request)).await;
            if response.status != 502 {
                if handed_back > 0 {
                    eprintln!("semantic fixture admission handbacks={handed_back}");
                }
                return (response, elapsed);
            }
            assert_handback(&response);
            handed_back += 1;
            // An outer admission timeout can leave a read closure running.
            // Observe its release before trying the still-unwritten request.
            wait_for("admission read operations released", || {
                let evidence = writer.reads.evidence.snapshot();
                evidence[0] == evidence[3]
            })
            .await;
        }
    })
    .await
    .expect("semantic fixture must reach dispatch")
}

fn assert_handback(response: &Outgoing) {
    assert_eq!(response.status, 502);
    assert!(response.headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("x-polis-vote-dispatch") && value == "not-started"
    }));
    let crate::http::Body::Fixed(bytes) = &response.body else {
        panic!("fixed handback response")
    };
    assert_eq!(bytes, b"Bad Gateway\n");
}

async fn wait_for_idle(writer: &Writer) {
    wait_for("all pool operations and notifications released", || {
        [&writer.pool, &writer.reads, &writer.background.pool]
            .iter()
            .all(|pool| {
                let evidence = pool.evidence.snapshot();
                evidence[0] == evidence[3]
            })
            && writer.background.admitted.available_permits() == 64
    })
    .await;
}

/// The trigger cannot proceed until the test releases its database-scoped lock.
/// Its own lock timeout is disabled; the test pool's statement watchdog remains.
struct SqlGate {
    holder: Option<postgres::Client>,
    pid: i32,
}

impl SqlGate {
    fn new(db: &Database, table: &str, operation: &str, key: i32) -> Self {
        let mut holder = db.connect();
        let pid = holder
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        holder
            .batch_execute(&format!(
                "SELECT pg_advisory_lock(7319, {key});
            CREATE FUNCTION test_gate_{key}() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN
                PERFORM set_config('lock_timeout', '0', true);
                PERFORM pg_advisory_xact_lock(7319, {key});
                RETURN NEW;
            END $$;
            CREATE TRIGGER test_gate_{key} BEFORE {operation} ON {table}
            FOR EACH ROW EXECUTE FUNCTION test_gate_{key}();"
            ))
            .unwrap();
        Self {
            holder: Some(holder),
            pid,
        }
    }

    async fn entered(&self, db: &Database) {
        wait_for_sql(
            db,
            format!(
                "select exists(select 1 from pg_stat_activity
            where datname=current_database() and wait_event='advisory'
            and {} = any(pg_blocking_pids(pid)))",
                self.pid
            ),
        )
        .await;
    }

    async fn release(&mut self) {
        let holder = self.holder.take().unwrap();
        // Closing the session releases the lock, including on assertion failure.
        tokio::task::spawn_blocking(move || drop(holder))
            .await
            .unwrap();
    }
}

impl Drop for SqlGate {
    fn drop(&mut self) {
        if let Some(holder) = self.holder.take() {
            std::thread::spawn(move || drop(holder)).join().unwrap();
        }
    }
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
        // Establish both read clients and warm the actual narrow projection of
        // the large row before starting the bounded eight-reader race. Both
        // acquisition and statement limits remain the real 100 ms limits.
        hold_prepared_pool(&writer.reads, 2, |c| priorities(c, 1, "test").map(|_| ()))
            .await
            .release()
            .await;
        let held = hold_pool(&writer.pool, 4).await;
        let before = writer.pool.evidence.snapshot();
        assert_eq!(before[0] - before[3], 4);
        let mut reads = vec![];
        for reader in 0..8 {
            let pool = writer.reads.clone();
            let writers = writer.pool.clone();
            reads.push(tokio::spawn(async move {
                // A read-lane acquisition timeout under CPU load is retryable
                // only while all four writer slots remain held and every writer
                // counter is unchanged. Reads still never wait on the writer
                // lane: no attempt releases a writer or changes either real
                // 100 ms limit. SQL/statement failures are never retried.
                for attempt in 1..=3 {
                    assert_eq!(writers.evidence.snapshot(), before);
                    let result = pool.with(|c| priorities(c, 1, "test")).await;
                    assert_eq!(writers.evidence.snapshot(), before);
                    match result {
                        Ok(data) => return (data.unwrap(), attempt - 1),
                        Err(error) => {
                            assert!(
                                error.downcast_ref::<db::Unavailable>().is_some_and(
                                    |cause| cause.0 == "pool acquire timeout"
                                ),
                                "reader {reader} attempt {attempt}: {error:#}"
                            );
                            eprintln!(
                                "narrow reader={reader} attempt={attempt}: read acquisition timeout; writer evidence unchanged {before:?}"
                            );
                            assert!(attempt < 3, "reader {reader} exhausted three attempts");
                            tokio::task::yield_now().await;
                        }
                    }
                }
                unreachable!("last failed attempt panics")
            }));
        }
        let mut retries = 0;
        for read in reads {
            let (data, retried) = read.await.unwrap();
            retries += retried;
            assert_eq!(js::stringify(&data), r#"{"7":2}"#);
        }
        eprintln!("narrow reads: readers=8 acquisition_retries={retries}");
        assert_eq!(writer.reads.evidence.snapshot()[2], retries);
        assert_eq!(writer.pool.evidence.snapshot(), before);
        assert_eq!(
            writer.reads.evidence.snapshot()[0],
            12,
            "four warmups and eight concurrent reads"
        );
        held.release().await;
        // Both read and writer pools have populated synchronous clients.
        drop(app);
    });
}

#[test]
fn dispatch_deadline_reports_unknown_and_retains_late_append() {
    let db = Database::new("deadline");
    let (mut app, request) = setup_with_statement_timeout(&db, EVENT_WATCHDOG);
    // Only this test's held SQL uses a longer statement watchdog. The real
    // dispatch deadline fires while the trigger is provably unable to finish.
    Arc::get_mut(&mut app)
        .unwrap()
        .post_votes
        .as_mut()
        .unwrap()
        .pool = db::Pool::writer(
        Connector::Plain(Box::new(db.config.clone())),
        db::Limits {
            size: 1,
            acquire_timeout: Duration::from_millis(100),
            statement_timeout: EVENT_WATCHDOG,
            max_lifetime: Duration::from_secs(300),
        },
    );
    let mut append_gate = SqlGate::new(&db, "votes", "INSERT", 1);
    let mut notification_gate = SqlGate::new(&db, "participants", "UPDATE", 2);
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        warm_pool(&writer.pool, 1).await;
        let task = tokio::spawn(handle_after_admission_timed(app.clone(), request));
        append_gate.entered(&db).await;
        let (response, elapsed) = task.await.unwrap();
        assert_eq!(response.status, 202);
        let elapsed = elapsed.expect("unknown response follows dispatch creation");
        assert!(
            elapsed >= DISPATCH_DEADLINE,
            "unknown response before dispatch deadline: {elapsed:?}"
        );
        // The append gate is still held, so only the dispatch deadline can
        // produce this 202. Allow 500 ms for scheduling under four niced CPU
        // workers, while still rejecting a timeout extended to two seconds.
        eprintln!("held append dispatch-to-response: {elapsed:?}");
        assert!(
            elapsed <= DISPATCH_DEADLINE + Duration::from_millis(500),
            "unknown response after dispatch deadline plus scheduling slack: {elapsed:?}"
        );
        let bytes = crate::http::write_response(&response, false, false, "D").unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("unknown"));
        let evidence = writer.pool.evidence.snapshot();
        assert_eq!(
            evidence[0] - evidence[3],
            1,
            "timed-out operation retains its slot"
        );
        assert!(writer.pool.with(|_| Ok(())).await.is_err());
        append_gate.release().await;
        notification_gate.entered(&db).await;
        let counts = writer
            .reads
            .with(|c| {
                Ok(c.query_one(
                    "select (select count(*) from votes), nsli from participants",
                    &[],
                )?)
            })
            .await
            .unwrap();
        assert_eq!(
            counts.get::<_, i64>(0),
            1,
            "late append committed exactly once"
        );
        assert_eq!(
            counts.get::<_, i16>(1),
            3,
            "notification is held before its write"
        );
        notification_gate.release().await;
        wait_for_sql(&db, "select nsli=0 from participants".into()).await;
        wait_for_sql(
            &db,
            "select count(*)=1 from event_ptpt_no_more_comments".into(),
        )
        .await;
        wait_for_idle(writer).await;
    });
}

#[test]
fn notification_runs_before_slow_star_without_count_or_activity_writes() {
    let db = Database::new("bookkeeping_order");
    let (app, mut request) = setup_with_statement_timeout(&db, EVENT_WATCHDOG);
    request.body = json!({"conversation_id":"2fixture","tid":7,
        "vote":crate::votes::WIRE_AGREE,"starred":true})
    .to_string()
    .into_bytes();
    let mut star_gate = SqlGate::new(&db, "stars", "INSERT", 1);
    let mut observer = db.connect();
    runtime().block_on(async {
        // Observe commit independently of star entry: a delay before both
        // notification and star would otherwise satisfy gate ordering alone.
        // Establish the observer before dispatch so connection setup and
        // admission are outside the measured commit-to-notification interval.
        let (ready, started) = tokio::sync::oneshot::channel();
        let notification = tokio::task::spawn_blocking(move || {
            assert_eq!(
                observer
                    .query_one("select count(*) from votes", &[])
                    .unwrap()
                    .get::<_, i64>(0),
                0
            );
            ready.send(()).unwrap();
            database::wait_for_query(&mut observer, "select count(*)=1 from votes");
            let committed = std::time::Instant::now();
            database::wait_for_query(&mut observer, "select nsli=0 from participants");
            let elapsed = committed.elapsed();
            eprintln!("vote commit-to-notification observation: {elapsed:?}");
            // Retain the original 600 ms promptness budget in addition to the
            // controlled star gate. The observer uses an established connection
            // and measures committed rows, without waiting for star scheduling.
            assert!(
                elapsed <= Duration::from_millis(600),
                "notification must promptly follow vote commit: {elapsed:?}"
            );
        });
        started.await.unwrap();
        let task = tokio::spawn(handle_after_admission(app.clone(), request));
        let writer = app.post_votes.as_ref().unwrap();
        star_gate.entered(&db).await;
        notification.await.unwrap();
        let row = writer
            .reads
            .with(|c| {
                Ok(c.query_one(
                    "select p.vote_count,p.nsli,p.last_interaction,c.modified,
             (select count(*) from stars) from participants p join conversations c using(zid)",
                    &[],
                )?)
            })
            .await
            .unwrap();
        assert_eq!(row.get::<_, i32>(0), 0);
        assert_eq!(row.get::<_, i16>(1), 0);
        assert!(row.get::<_, i64>(2) > 0);
        assert_eq!(row.get::<_, i64>(3), 0);
        assert_eq!(
            row.get::<_, i64>(4),
            0,
            "notification committed while star cannot commit"
        );
        assert!(
            !task.is_finished(),
            "route remains unfinished while star is held"
        );
        star_gate.release().await;
        assert_eq!(task.await.unwrap().status, 200);
        wait_for_sql(&db, "select count(*)=1 from stars".into()).await;
        wait_for_sql(
            &db,
            "select count(*)=1 from event_ptpt_no_more_comments".into(),
        )
        .await;
        wait_for_idle(writer).await;
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
            .connect_timeout(EVENT_WATCHDOG);
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
        let task = tokio::spawn(handle_after_admission(app.clone(), request));
        let (socket, _) = listener.accept().await.unwrap();
        let response = task.await.unwrap();
        assert_eq!(response.status, 202);
        let writer = app.post_votes.as_ref().unwrap();
        let evidence = writer.pool.evidence.snapshot();
        assert_eq!(evidence[0] - evidence[3], 1);
        assert!(writer.pool.with(|_| Ok(())).await.is_err());
        drop(socket);
        wait_for(
            "stalled connection releases its slot after socket close",
            || writer.pool.evidence.snapshot()[3] == 1,
        )
        .await;
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
    let (app, request) = setup_with_statement_timeout(&db, EVENT_WATCHDOG);
    let mut append_gate = SqlGate::new(&db, "votes", "INSERT", 1);
    runtime().block_on(async {
        let retry = copy_request(&request);
        let writer = app.post_votes.as_ref().unwrap();
        let task = tokio::spawn(handle_after_admission(app.clone(), request));
        // Cancel the actual route future once the writer has acquired a slot,
        // before doing a SQL observer round trip that could outlive its deadline.
        wait_for("dispatched writer acquired", || {
            let evidence = writer.pool.evidence.snapshot();
            evidence[0] > evidence[3]
        })
        .await;
        assert!(!task.is_finished(), "abort an outstanding route");
        task.abort();
        assert!(matches!(task.await, Err(e) if e.is_cancelled()));
        append_gate.entered(&db).await;
        append_gate.release().await;
        wait_for_sql(&db, "select nsli=0 from participants".into()).await;
        wait_for_sql(
            &db,
            "select count(*)=1 from event_ptpt_no_more_comments".into(),
        )
        .await;
        wait_for_idle(writer).await;
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
        let reply = handle_after_admission(app.clone(), retry).await;
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
    database::unbounded_key_wait(&db);
    let (app, request) = setup(&db);
    let mut lock = db.connect();
    lock.batch_execute("BEGIN; SELECT * FROM participants WHERE zid=1 FOR NO KEY UPDATE")
        .unwrap();
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        // All callers are launched together while notification SQL is blocked.
        // Each may retry only a verified no-dispatch admission handback.
        let mut tasks = Vec::new();
        for _ in 0..8 {
            tasks.push(tokio::spawn(handle_after_admission(
                app.clone(),
                copy_request(&request),
            )));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().status, 200);
        }
        wait_for("blocked notification reports SQL failure", || {
            writer.background.pool.evidence.snapshot()[4] > 0
        })
        .await;
        wait_for_idle(writer).await;
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
        assert_eq!(
            evidence[0], 12,
            "four warmups, then only append uses writer slots"
        );
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
        let mut releases = Vec::new();
        let (ready_tx, mut ready_rx) = tokio::sync::mpsc::unbounded_channel();
        for _ in 0..2 {
            let (release, held) = std::sync::mpsc::channel::<()>();
            releases.push(release);
            let ready = ready_tx.clone();
            assert!(lane.schedule(move |_| {
                ready.send(()).unwrap();
                let _ = held.recv();
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
        drop(releases);
        tokio::time::timeout(EVENT_WATCHDOG, async {
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
        warm_pool(
            state.votes_read_db.as_ref().unwrap(),
            crate::votes_read::pool_limits().size,
        )
        .await;
        warm_pool(
            state.votes_read_auth_db.as_ref().unwrap(),
            crate::votes_read::pool_limits().size,
        )
        .await;
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
        warm_pool(
            state.votes_read_db.as_ref().unwrap(),
            crate::votes_read::pool_limits().size,
        )
        .await;
        warm_pool(
            state.votes_read_auth_db.as_ref().unwrap(),
            crate::votes_read::pool_limits().size,
        )
        .await;
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
        ("star_deadline", "", true, FollowOnState::Degraded),
    ] {
        let db = Database::new(name);
        let (app, mut request) = setup_with_statement_timeout(&db, EVENT_WATCHDOG);
        let mut gate = (name == "star_deadline").then(|| SqlGate::new(&db, "stars", "INSERT", 1));
        if star {
            let mut body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            body["starred"] = json!(true);
            request.body = body.to_string().into_bytes();
        }
        db.connect().batch_execute("CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 1700000000000::bigint'").unwrap();
        db.connect().batch_execute(fault).unwrap();
        runtime().block_on(async {
            let first_task = tokio::spawn(handle_after_admission(app.clone(), copy_request(&request)));
            if let Some(gate) = &gate {
                gate.entered(&db).await;
            }
            let first = first_task.await.unwrap();
            assert_eq!(first.status, 200, "{name}");
            let body = accepted_body(&first);
            assert_eq!(body.vote.vote, crate::votes::VoteChoice::Agree.wire());
            assert!(!body.vote.replayed);
            assert_eq!(body.follow_on.next_comment, next_state);
            assert!(body.next_comment.is_none());
            let again = handle_after_admission(app.clone(), copy_request(&request)).await;
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
            if let Some(gate) = &mut gate {
                // Both replies kept the receipt while the star could not commit.
                gate.release().await;
                wait_for_sql(&db, "select count(*)=2 from event_ptpt_no_more_comments".into()).await;
            }
            wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        });
    }
}

#[test]
fn single_warm_caller_receives_commit_receipt_within_dispatch_deadline() {
    let db = Database::new("warm_receipt");
    let (app, request) = setup(&db);
    runtime().block_on(async {
        // One caller, established clients, and the real route deadline. A 202
        // would mean that deadline elapsed without a commit receipt.
        let (response, elapsed) = observed_handle(app.clone(), request).await;
        assert_eq!(response.status, 200);
        // A single warm caller must finish before the real dispatch budget.
        assert!(elapsed.unwrap() < DISPATCH_DEADLINE);
        let vote = accepted_body(&response).vote;
        assert!(!vote.replayed);
        assert_eq!(vote.vote, crate::votes::VoteChoice::Agree.wire());
        assert_eq!(vote.tid, 7);
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        wait_for_sql(&db, "select count(*)=1 from votes".into()).await;
    });
}

#[test]
fn concurrent_same_choice_retries_append_once_and_priority_is_not_a_new_vote() {
    let db = Database::new("same_choice");
    database::unbounded_key_wait(&db);
    let (app, request) = setup(&db);
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        // Retry the entire round only if all sixteen callers were verified
        // pre-dispatch handbacks. Every round is a simultaneous sixteen-way
        // first-append race on the same four connections, never a seeded write
        // or a sequence of callers. Empty rounds must have no SQL writes; the
        // successful round still proves exactly one original and one history row.
        const MAX_ROUNDS: usize = 16;
        let mut reached_dispatch = false;
        for round in 1..=MAX_ROUNDS {
            let start = Arc::new(tokio::sync::Barrier::new(17));
            let mut tasks = Vec::new();
            for _ in 0..16 {
                let app = app.clone();
                let request = copy_request(&request);
                let start = start.clone();
                tasks.push(tokio::spawn(async move {
                    start.wait().await;
                    observed_handle(app, request).await
                }));
            }
            start.wait().await;
            let mut appended = 0;
            let mut replayed = 0;
            let mut handed_back = 0;
            let mut dispatches = 0;
            for task in tasks {
                let (response, elapsed) = task.await.unwrap();
                dispatches += usize::from(elapsed.is_some());
                match response.status {
                    200 => {
                        assert!(elapsed.is_some(), "receipt must follow dispatch");
                        let vote = accepted_body(&response).vote;
                        assert_eq!(vote.vote, crate::votes::VoteChoice::Agree.wire());
                        assert_eq!(vote.tid, 7);
                        if vote.replayed { replayed += 1; } else { appended += 1; }
                    }
                    502 => {
                        handed_back += 1;
                        assert_handback(&response);
                        assert!(elapsed.is_none(), "handback must create no dispatch");
                    }
                    status => panic!("unexpected retry status {status}; reads={:?}; writes={:?}", writer.reads.evidence.snapshot(), writer.pool.evidence.snapshot()),
                }
            }
            eprintln!("same-choice round={round}: appended={appended} replayed={replayed} handed_back={handed_back} dispatches={dispatches}");
            assert_eq!(appended + replayed + handed_back, 16);
            assert_eq!(dispatches, appended + replayed, "every handback created no dispatch");
            wait_for_idle(writer).await;
            let evidence = writer.pool.evidence.snapshot();
            assert_eq!(evidence[0], 4 + dispatches, "four warmups and one acquisition per dispatch");
            assert_eq!(evidence[0], evidence[3]);
            assert_eq!(evidence[2], 0, "no unaccounted writer acquisition timeout");
            if handed_back == 16 {
                let rows = writer.reads.with(|c| Ok(c.query_one(
                    "select (select count(*) from votes),(select count(*) from votes_latest_unique)", &[])?)).await.unwrap();
                assert_eq!((rows.get::<_, i64>(0), rows.get::<_, i64>(1)), (0, 0));
                eprintln!("retrying whole all-handback round {round}/{MAX_ROUNDS}");
                continue;
            }
            assert_eq!(appended, 1, "exactly one caller receives the original receipt");
            reached_dispatch = true;
            break;
        }
        assert!(reached_dispatch, "no admitted caller in {MAX_ROUNDS} sixteen-way rounds");
        let mut priority = copy_request(&request);
        priority.body = json!({"conversation_id":"2fixture","tid":7,
            "vote":crate::votes::VoteChoice::Agree.wire(),"high_priority":true})
        .to_string()
        .into_bytes();
        assert!(
            accepted_body(&handle_after_admission(app.clone(), priority).await)
                .vote
                .replayed
        );
        let writer = app.post_votes.as_ref().unwrap();
        let state = writer
            .reads
            .with(|c| Ok(c.query_one("select count(*),bool_or(high_priority),(select count(*) from votes_latest_unique) from votes", &[])?))
            .await
            .unwrap();
        assert_eq!(state.get::<_, i64>(0), 1);
        assert!(!state.get::<_, bool>(1));
        assert_eq!(state.get::<_, i64>(2), 1, "one latest row for the same key");
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
        let response = handle_after_admission(app.clone(), request).await;
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
            let response = handle_after_admission(app.clone(), request).await;
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
        database::unbounded_key_wait(&db);
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
        database::wait_for_query(
            &mut observer,
            &format!(
                "select exists(select 1 from pg_stat_activity where pid={backend} and wait_event_type='Lock')"
            ),
        );
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
    let response = rt.block_on(handle_after_admission(app.clone(), copy_request(&request)));
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
    let retry = rt.block_on(handle_after_admission(app.clone(), request));
    assert_eq!(retry.status, 200);
    assert!(!accepted_body(&retry).vote.replayed);
    assert_eq!(
        c.query_one("select count(*) from votes", &[])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
}

// A waiting credential exchange must not block citizen writes.
#[test]
fn second_accept_cannot_reject_participation() {
    use polis_auth::{
        Uid, Zid,
        admission::{self, Entry, Identity, PreparedRecovery},
    };
    let db = Database::new("treevite_lock");
    let (app, request) = setup(&db);
    let mut primary = db.connect();
    // The vote baseline predates these tables; use the released definitions
    // when a fully migrated template has not been supplied.
    primary
        .batch_execute(include_str!(
            "../../../server/postgres/migrations/000010_create_oidc_user_mappings.sql"
        ))
        .unwrap();
    primary
        .batch_execute(include_str!(
            "../../../server/postgres/migrations/000013_create_treevite.sql"
        ))
        .unwrap();
    primary.batch_execute("INSERT INTO users(uid,site_id,is_owner) VALUES(2,'generated-owner',true); UPDATE users SET site_id='generated-participant' WHERE uid=1; UPDATE conversations SET owner=2 WHERE zid=1; INSERT INTO treevite_waves(zid,wave,invites_per_user,owner_invites) VALUES(1,1,0,1); INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES(1,1,'second'); INSERT INTO treevite_login_codes(zid,pid,login_code_hash,login_code_lookup,login_code_fingerprint) VALUES(1,0,'prepared','lookup','fingerprint')").unwrap();
    let mut held_connection = db.connect();
    let mut held = held_connection.transaction().unwrap();
    held.query_one("SELECT pid FROM treevite_login_codes FOR UPDATE", &[])
        .unwrap();
    let mut accepting = db.connect();
    let backend: i32 = accepting
        .query_one("SELECT pg_backend_pid()", &[])
        .unwrap()
        .get(0);
    let worker = std::thread::spawn(move || {
        admission::admit(
            &mut accepting,
            &admission::Request {
                zid: Zid(1),
                identity: Identity::AnonymousParticipant {
                    uid: Uid(1),
                    conversation: Zid(1),
                },
                entry: Entry::Invite {
                    code: "second",
                    recovery: PreparedRecovery {
                        code: "prepared",
                        bcrypt_hash: "prepared",
                        lookup: "second-lookup",
                        fingerprint_key: b"generated",
                    },
                },
                admin_uids: &[],
                x_name: None,
                x_email: None,
                x_profile_image_url: None,
            },
        )
    });
    let started = std::time::Instant::now();
    loop {
        let waiting: bool = primary
            .query_one(
                "SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1",
                &[&backend],
            )
            .unwrap()
            .get::<_, Option<bool>>(0)
            .unwrap_or(false);
        if waiting {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(10));
    }
    // Calls the actual HTTP route; setup uses the shared vote convention constant.
    let response = runtime().block_on(route::handle(app, request));
    let count: i64 = primary
        .query_one("SELECT count(*) FROM votes", &[])
        .unwrap()
        .get(0);
    let wire = crate::http::write_response(&response, false, false, "D").unwrap();
    eprintln!(
        "Actual vote: status={}, durable_votes={count}, response={}",
        response.status,
        String::from_utf8(wire).unwrap()
    );
    primary.batch_execute("SET lock_timeout='100ms'").unwrap();
    let comment = primary.execute(
        "INSERT INTO comments(zid,pid,uid,txt) VALUES(1,0,1,'Generated comment')",
        &[],
    );
    eprintln!(
        "Actual comment insert: {:?}",
        comment.as_ref().map_err(|e| e.code().map(|s| s.code()))
    );
    held.rollback().unwrap();
    assert!(matches!(
        worker.join().unwrap(),
        Err(admission::Error::Refused(_))
    ));
    assert_eq!(
        response.status, 200,
        "second accept must not reject a citizen vote"
    );
    assert_eq!(count, 1);
    assert!(
        comment.is_ok(),
        "second accept must not reject a citizen comment"
    );
}

/// A loopback-only protocol observer counts statements on the real vote
/// connections. It needs no PostgreSQL extension or production instrumentation.
async fn count_statements(
    client: tokio::net::TcpStream,
    backend: tokio::net::TcpStream,
    counts: Arc<Mutex<std::collections::BTreeMap<String, usize>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut cr, mut cw) = client.into_split();
    let (mut br, mut bw) = backend.into_split();
    let upstream = async {
        // This fixture uses NoTls: the initial packet is the startup packet.
        let length = cr.read_u32().await?;
        let mut bytes = vec![0; length as usize - 4];
        cr.read_exact(&mut bytes).await?;
        bw.write_u32(length).await?;
        bw.write_all(&bytes).await?;
        loop {
            let tag = cr.read_u8().await?;
            let length = cr.read_u32().await?;
            let mut bytes = vec![0; length as usize - 4];
            cr.read_exact(&mut bytes).await?;
            if matches!(tag, b'P' | b'Q') {
                let mut strings = bytes.split(|b| *b == 0);
                if tag == b'P' {
                    strings.next();
                } // prepared statement name
                let sql = std::str::from_utf8(strings.next().unwrap())
                    .unwrap()
                    .to_owned();
                *counts.lock().unwrap().entry(sql).or_default() += 1;
            }
            bw.write_u8(tag).await?;
            bw.write_u32(length).await?;
            bw.write_all(&bytes).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), std::io::Error>(())
    };
    let downstream = tokio::io::copy(&mut br, &mut cw);
    tokio::select! { _ = upstream => {}, _ = downstream => {} }
}

#[test]
fn revocation_snapshot_adds_no_vote_request_statements() {
    let mut measurements = Vec::new();
    for with_snapshot in [false, true] {
        let db = Database::new(if with_snapshot {
            "revocation_with"
        } else {
            "revocation_without"
        });
        let (mut app, request) = setup(&db);
        let mut c = db.connect();
        c.batch_execute(include_str!(
            "../../../server/postgres/migrations/000013_create_treevite.sql"
        ))
        .unwrap();
        c.batch_execute(
            "INSERT INTO users(uid) VALUES(2);
            ALTER TABLE participants DISABLE TRIGGER USER;
            INSERT INTO participants(zid,pid,uid) VALUES(1,1,2);
            ALTER TABLE participants ENABLE TRIGGER USER;
            INSERT INTO treevite_login_codes(zid,pid,login_code_hash,login_code_fingerprint,revoked)
            VALUES(1,1,'fixture','fixture',true);",
        )
        .unwrap();
        let measured = runtime().block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let backend_port = db.config.get_ports()[0];
            let backend_host = match &db.config.get_hosts()[0] {
                postgres::config::Host::Tcp(host) => host.clone(),
                _ => panic!("loopback test database required"),
            };
            let counts = Arc::new(Mutex::new(std::collections::BTreeMap::new()));
            let observed = counts.clone();
            let (stop_proxy, mut stopping) = tokio::sync::oneshot::channel::<()>();
            let proxy = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    let (client, _) = tokio::select! {
                        _ = &mut stopping => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    let backend = tokio::net::TcpStream::connect((backend_host.as_str(), backend_port))
                        .await.unwrap();
                    connections.spawn(count_statements(client, backend, observed.clone()));
                }
                connections.shutdown().await;
            });
            let mut config = postgres::Config::new();
            config.host("127.0.0.1").port(port)
                .user(db.config.get_user().unwrap())
                .dbname(db.config.get_dbname().unwrap());
            if let Some(password) = db.config.get_password() {
                config.password(password);
            }
            let connector = || Connector::Plain(Box::new(config.clone()));
            let writer = Arc::get_mut(&mut app).unwrap().post_votes.as_mut().unwrap();
            writer.reads = db::Pool::new(connector(), read_limits());
            let limits = db::Limits {
                size: 4,
                acquire_timeout: Duration::from_millis(100),
                statement_timeout: Duration::from_secs(1),
                max_lifetime: Duration::from_secs(300),
            };
            writer.pool = db::Pool::writer(connector(), limits.clone());
            writer.background = NotificationPool::new(db::Pool::writer(connector(), db::Limits { size: 2, ..limits }));
            warm_pool(&writer.reads, 2).await;
            warm_pool(&writer.pool, 4).await;
            warm_pool(&writer.background.pool, 2).await;

            // Refresh uses the production operation and its own warm connection.
            // Hold only the login-code table and observe the refresh's exact
            // backend waiting there before issuing either measured vote.
            let refresh_pool = db::Pool::new(
                Connector::Plain(Box::new(db.config.clone())), crate::revocation::limits());
            warm_pool(&refresh_pool, 1).await;
            let refresh = crate::revocation::Refresh::load(refresh_pool.clone()).await.unwrap();
            assert!(refresh.snapshot.contains("2fixture", 1));
            let refresh_pid: i32 = refresh_pool.with(|c| Ok(c.query_one("select pg_backend_pid()", &[])?.get(0))).await.unwrap();
            if with_snapshot {
                let state = Arc::get_mut(&mut app).unwrap();
                state.post_votes.as_mut().unwrap().set_revocations(refresh.snapshot.clone());
                state.revocations = Some(refresh.clone());
            }
            let (release_lock, held) = std::sync::mpsc::channel::<()>();
            let (ready, locked) = tokio::sync::oneshot::channel();
            let holder = tokio::task::spawn_blocking(move || {
                c.batch_execute("BEGIN; LOCK TABLE treevite_login_codes IN ACCESS EXCLUSIVE MODE").unwrap();
                let pid: i32 = c.query_one("select pg_backend_pid()", &[]).unwrap().get(0);
                ready.send(pid).unwrap();
                // Dropping the sender also releases the lock on assertion failure.
                let _ = held.recv();
                c.batch_execute("COMMIT").unwrap();
            });
            let holder_pid = tokio::time::timeout(EVENT_WATCHDOG, locked).await.unwrap().unwrap();
            let refresh_before = refresh_pool.evidence.snapshot();
            let refreshing = tokio::spawn({
                let refresh = refresh.clone();
                async move { refresh.refresh().await }
            });
            wait_for_sql(&db, format!("select exists(select 1 from pg_stat_activity where pid={refresh_pid} and wait_event_type='Lock' and {holder_pid}=any(pg_blocking_pids(pid)))")).await;
            let mut measured = Vec::new();
            for replayed in [false, true] {
                let writer = app.post_votes.as_ref().unwrap();
                wait_for_idle(writer).await;
                let pools = [&writer.reads, &writer.pool, &writer.background.pool];
                let before = pools.map(|p| p.evidence.snapshot());
                counts.lock().unwrap().clear();
                let (response, dispatched) = observed_handle(app.clone(), copy_request(&request)).await;
                assert_eq!(response.status, 200);
                assert!(dispatched.is_some(), "vote must create a dispatch");
                let vote = accepted_body(&response).vote;
                assert_eq!(vote.replayed, replayed);
                assert_eq!(vote.vote, crate::votes::VoteChoice::Agree.wire());
                assert_eq!(vote.tid, 7);
                wait_for_idle(writer).await;
                // Receipt alone does not close the statement-counting window:
                // every read, append and detached notification must finish.
                for (i, operations) in [2, 1, 2].into_iter().enumerate() {
                    let after = pools[i].evidence.snapshot();
                    let delta = std::array::from_fn::<_, 6, _>(|j| after[j] - before[i][j]);
                    assert_eq!(delta, [operations, 0, 0, operations, 0, 0]);
                }
                let statements = std::mem::take(&mut *counts.lock().unwrap());
                assert!(!statements.is_empty());
                assert!(statements.keys().all(|q| !q.contains("treevite_login_codes")));
                assert!(!refreshing.is_finished(), "vote must finish while refresh is blocked");
                let during = refresh_pool.evidence.snapshot();
                assert_eq!(during[0], refresh_before[0] + 1);
                assert_eq!(during[3], refresh_before[3]);
                measured.push(statements);
            }
            wait_for_sql(&db, "select (select count(*) from votes)=1 and (select count(*) from votes_latest_unique)=1 and (select nsli from participants where zid=1 and pid=0)=0 and (select count(*) from event_ptpt_no_more_comments)=2".into()).await;

            // Conversely, refresh must complete while every vote connection is
            // held. Its completion must neither acquire nor issue SQL on them.
            let writer = app.post_votes.as_ref().unwrap();
            let held_reads = hold_pool(&writer.reads, 2).await;
            let held_writes = hold_pool(&writer.pool, 4).await;
            let held_notifications = hold_pool(&writer.background.pool, 2).await;
            let pools = [&writer.reads, &writer.pool, &writer.background.pool];
            let held_evidence = pools.map(|p| p.evidence.snapshot());
            counts.lock().unwrap().clear();
            drop(release_lock);
            tokio::time::timeout(EVENT_WATCHDOG, holder).await.unwrap().unwrap();
            tokio::time::timeout(EVENT_WATCHDOG, refreshing).await.unwrap().unwrap();
            assert_eq!(pools.map(|p| p.evidence.snapshot()), held_evidence);
            assert!(counts.lock().unwrap().is_empty(), "refresh must issue no vote-pool SQL");
            let after = refresh_pool.evidence.snapshot();
            let delta = std::array::from_fn::<_, 6, _>(|j| after[j] - refresh_before[j]);
            assert_eq!(delta, [1, 0, 0, 1, 0, 0]);
            assert!(refresh.snapshot.contains("2fixture", 1));
            if with_snapshot {
                let health: serde_json::Value = serde_json::from_str(&crate::js::stringify(&crate::revocation::health(&app))).unwrap();
                assert_eq!(health["refreshSuccesses"], 2);
                assert_eq!(health["refreshFailures"], 0);
            }
            held_reads.release().await;
            held_writes.release().await;
            held_notifications.release().await;
            // Close and join every proxy connection before synchronous pool
            // destruction, which otherwise waits for this runtime to forward EOF.
            drop(stop_proxy);
            tokio::time::timeout(EVENT_WATCHDOG, proxy).await.unwrap().unwrap();
            drop(app);
            measured
        });
        measurements.push(measured);
    }
    for (i, label) in ["fresh", "replay"].into_iter().enumerate() {
        let without = &measurements[0][i];
        let with = &measurements[1][i];
        assert_eq!(
            with, without,
            "snapshot must add zero request-time SQL statements"
        );
        println!(
            "vote {label} statement counts unchanged across read, writer and notification pools: {} before and {} with snapshot",
            without.values().sum::<usize>(),
            with.values().sum::<usize>()
        );
    }
}
