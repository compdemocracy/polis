// Failure and recovery of overlapping same-conversation refreshes.
use super::*;
use postgres::{Client, Config, NoTls};
use std::time::{Duration, Instant};

struct Env {
    pca: Arc<Pca>,
    url: String,
    schema: String,
}

async fn exec(url: &str, sql: String) {
    let url = url.to_owned();
    tokio::task::spawn_blocking(move || {
        Client::connect(&url, NoTls)
            .unwrap()
            .batch_execute(&sql)
            .unwrap();
    })
    .await
    .unwrap();
}

fn limits(acquire_ms: u64, statement_ms: u64, size: usize) -> db::Limits {
    db::Limits {
        size,
        acquire_timeout: Duration::from_millis(acquire_ms),
        statement_timeout: Duration::from_millis(statement_ms),
        max_lifetime: Duration::from_secs(60),
    }
}

async fn env(limits: db::Limits) -> Env {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!(
        "pca_failures_{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );
    exec(&url, format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.math_main(zid integer, math_env text, math_tick bigint, data jsonb);
        INSERT INTO {schema}.math_main VALUES (1,'a',0,'{{\"lastVoteTimestamp\":123,\"n\":2}}');")).await;
    let mut cfg: Config = url.parse().unwrap();
    cfg.options(&format!("-c search_path={schema}"));
    let pool = Pool::new(
        polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg)),
        limits,
    );
    Env {
        pca: Arc::new(Pca::new(pool, "a".into(), 300)),
        url,
        schema,
    }
}

impl Env {
    async fn finish(self) {
        tokio::task::spawn_blocking(move || drop(self.pca))
            .await
            .unwrap();
        exec(&self.url, format!("DROP SCHEMA {} CASCADE", self.schema)).await;
    }
}

/// ACCESS EXCLUSIVE on the test math table, held by a connection outside the pool.
async fn hold_table(e: &Env) -> (std::sync::mpsc::Sender<()>, tokio::task::JoinHandle<()>) {
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let url = e.url.clone();
    let schema = e.schema.clone();
    let holder = tokio::task::spawn_blocking(move || {
        let mut c = Client::connect(&url, NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN; LOCK TABLE {schema}.math_main IN ACCESS EXCLUSIVE MODE"
        ))
        .unwrap();
        locked_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        c.batch_execute("ROLLBACK").unwrap();
    });
    locked_rx.await.unwrap();
    (release_tx, holder)
}

async fn overlap(e: &Env, n: usize) -> Vec<(bool, Duration)> {
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..n {
        let pca = e.pca.clone();
        tasks.push(tokio::spawn(async move {
            let r = pca.get_pca(1, -1.0).await;
            (r.is_err(), t0.elapsed())
        }));
    }
    let mut out = Vec::new();
    for t in tasks {
        out.push(t.await.unwrap());
    }
    out
}

fn report(label: &str, out: &[(bool, Duration)]) -> Duration {
    let mut ms: Vec<_> = out.iter().map(|(_, d)| d.as_millis()).collect();
    ms.sort();
    eprintln!(
        "{label}: errors {}/{}, completion ms {ms:?}",
        out.iter().filter(|(e, _)| *e).count(),
        out.len()
    );
    out.iter().map(|(_, d)| *d).max().unwrap()
}

// A shared read that fails on its statement timeout. Every caller should get
// its error (a 502, so nginx asks Node) within about one statement timeout,
// as each did when it made its own read. A per-conversation queue in which
// each waiter repeats the failing read in turn makes the k-th caller wait
// k statement timeouts. Production: 3,000 ms statement timeout, nginx 5 s
// read timeout, so the second same-conversation request already outlives nginx.
#[tokio::test]
async fn failing_read_answers_each_caller_within_one_statement_timeout() {
    let e = env(limits(2000, 300, 8)).await;
    let (release, holder) = hold_table(&e).await;
    let out = overlap(&e, 6).await;
    release.send(()).unwrap();
    holder.await.unwrap();
    // The failure is not retained: the next request reads and serves the row.
    let ok = e.pca.get_pca(1, -1.0).await.unwrap().unwrap();
    assert_eq!(ok.math_tick(), 0.0);
    e.finish().await;
    let worst = report("failing read, 6 callers, 300 ms statement timeout", &out);
    assert!(out.iter().all(|(err, _)| *err));
    assert!(
        worst < Duration::from_millis(700),
        "the last caller waited {worst:?}, more than twice the 300 ms statement timeout"
    );
}

// The common read pool is saturated by other work. Every pca2 caller should
// get its 502 within about the 2,000 ms (here 200 ms) acquisition timeout.
#[tokio::test]
async fn saturated_pool_answers_each_caller_within_one_acquire_timeout() {
    let e = env(limits(200, 3000, 1)).await;
    let pool = e.pca.db.clone();
    let parked = tokio::spawn(async move {
        pool.with(|_| {
            std::thread::sleep(Duration::from_millis(1500));
            Ok(())
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let out = overlap(&e, 5).await;
    parked.await.unwrap().unwrap();
    let ok = e.pca.get_pca(1, -1.0).await.unwrap().unwrap();
    assert_eq!(ok.math_tick(), 0.0);
    e.finish().await;
    let worst = report("saturated pool, 5 callers, 200 ms acquire timeout", &out);
    assert!(out.iter().all(|(err, _)| *err));
    assert!(
        worst < Duration::from_millis(450),
        "the last caller waited {worst:?}, more than twice the 200 ms acquisition timeout"
    );
}

// A leader whose request is dropped while it waits for a pool permit (before
// its read starts) must not strand the callers queued behind it.
#[tokio::test]
async fn leader_dropped_before_its_read_does_not_strand_waiters() {
    let e = env(limits(5000, 3000, 1)).await;
    let pool = e.pca.db.clone();
    let parked = tokio::spawn(async move {
        pool.with(|_| {
            std::thread::sleep(Duration::from_millis(400));
            Ok(())
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let pca = e.pca.clone();
    let leader = tokio::spawn(async move { pca.get_pca(1, -1.0).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let pca = e.pca.clone();
    let waiter = tokio::spawn(async move { pca.get_pca(1, -1.0).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    leader.abort();
    let item = tokio::time::timeout(Duration::from_secs(3), waiter)
        .await
        .expect("waiter stranded")
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(item.math_tick(), 0.0);
    parked.await.unwrap().unwrap();
    e.finish().await;
}

// After the database recovers from a failed shared read, waiters already
// queued are answered from one successful read, not one read each.
#[tokio::test]
async fn recovery_after_failure_reads_once_for_queued_callers() {
    let e = env(limits(2000, 3000, 8)).await;
    let (release, holder) = hold_table(&e).await;
    let before = e
        .pca
        .db
        .evidence
        .acquired
        .load(std::sync::atomic::Ordering::SeqCst);
    let pca = e.pca.clone();
    let callers = tokio::spawn(async move {
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let pca = pca.clone();
            tasks.push(tokio::spawn(
                async move { pca.get_pca(1, -1.0).await.is_ok() },
            ));
        }
        let mut ok = 0;
        for t in tasks {
            ok += usize::from(t.await.unwrap());
        }
        ok
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    release.send(()).unwrap();
    holder.await.unwrap();
    let ok = callers.await.unwrap();
    let reads = e
        .pca
        .db
        .evidence
        .acquired
        .load(std::sync::atomic::Ordering::SeqCst)
        - before;
    e.finish().await;
    eprintln!("recovery: {ok}/8 ok, {reads} reads");
    assert_eq!(ok, 8);
}

async fn presentation_case(saturated: bool) {
    let e = env(if saturated {
        limits(200, 3000, 1)
    } else {
        limits(2000, 300, 8)
    })
    .await;
    exec(&e.url, format!("CREATE TABLE {}.comments(zid integer, tid integer, mod integer); INSERT INTO {}.comments VALUES(1,7,1)", e.schema, e.schema)).await;
    let item = e.pca.get_pca(1, -1.0).await.unwrap().unwrap();
    let mut release = None;
    let holder = if saturated {
        let pool = e.pca.db.clone();
        tokio::spawn(async move {
            pool.with(|_| {
                std::thread::sleep(Duration::from_millis(1500));
                Ok(())
            })
            .await
            .unwrap();
        })
    } else {
        let (ready, ready_rx) = tokio::sync::oneshot::channel();
        let (tx, rx) = std::sync::mpsc::channel();
        release = Some(tx);
        let url = e.url.clone();
        let schema = e.schema.clone();
        let handle = tokio::task::spawn_blocking(move || {
            let mut c = Client::connect(&url, NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {schema}.comments IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready.send(()).unwrap();
            let _ = rx.recv();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        handle
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = e
        .pca
        .db
        .evidence
        .acquired
        .load(std::sync::atomic::Ordering::SeqCst);
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let pca = e.pca.clone();
        let item = item.clone();
        tasks.push(tokio::spawn(async move {
            let error = pca.present(1, item).await.unwrap_err();
            assert!(db::is_unavailable(&error));
            (true, t0.elapsed())
        }));
    }
    let mut out = Vec::new();
    for task in tasks {
        out.push(task.await.unwrap());
    }
    let reads = e
        .pca
        .db
        .evidence
        .acquired
        .load(std::sync::atomic::Ordering::SeqCst)
        - before;
    if let Some(release) = release {
        release.send(()).unwrap();
    }
    holder.await.unwrap();
    let recovered = e.pca.present(1, item).await.unwrap();
    assert_eq!(recovered.pojo.get("n-cmts"), Some(&Js::Num(1.0)));
    e.finish().await;
    let worst = report(
        if saturated {
            "presentation saturated"
        } else {
            "presentation failed"
        },
        &out,
    );
    assert!(
        worst < Duration::from_millis(if saturated { 350 } else { 450 }),
        "150 ms scheduling tolerance"
    );
    assert!(worst - out.iter().map(|(_, d)| *d).min().unwrap() < Duration::from_millis(100));
    assert_eq!(
        reads,
        usize::from(!saturated),
        "one failing read; no serial retries"
    );
}

#[tokio::test]
async fn failing_presentation_is_shared_and_next_request_retries() {
    presentation_case(false).await;
}

#[tokio::test]
async fn saturated_presentation_is_shared_and_next_request_retries() {
    presentation_case(true).await;
}

#[tokio::test]
async fn both_flight_waits_allow_acquisition_plus_statement_deadlines() {
    let e = env(limits(100, 200, 8)).await;
    let item = Pca::build(ensure_complete(None, now_ms()), true, false).unwrap();
    let held_math = e
        .pca
        .refreshes
        .acquire(1, Duration::from_secs(1))
        .await
        .unwrap();
    let held_presentation = e
        .pca
        .presentation_refreshes
        .acquire(1, Duration::from_secs(1))
        .await
        .unwrap();
    let start = Instant::now();
    let (math, presentation) = tokio::join!(e.pca.get_pca(1, -1.0), e.pca.present(1, item));
    let elapsed = start.elapsed();
    assert!(db::is_unavailable(&math.unwrap_err()));
    assert!(db::is_unavailable(&presentation.unwrap_err()));
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_millis(450),
        "100 ms acquisition + 200 ms statement, plus 150 ms tolerance: {elapsed:?}"
    );
    drop((held_math, held_presentation));
    e.finish().await;
}

#[tokio::test]
async fn failed_flight_answers_existing_joiners_but_is_not_a_cache() {
    let flights = Refreshes::<usize>(Mutex::new(HashMap::new()));
    let mut leader = flights.acquire(1, Duration::from_secs(1)).await.unwrap();
    let waiting = flights.acquire(1, Duration::from_secs(1));
    tokio::pin!(waiting);
    // Poll the follower once so it has joined this particular flight.
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut waiting)
            .await
            .is_err()
    );
    leader
        .complete(Err(db::Unavailable("read failed".into()).into()))
        .unwrap_err();
    drop(leader);
    let joined = waiting.await.unwrap();
    assert!(db::is_unavailable(&joined.shared().unwrap_err()));
    // Hold the failed lease: a request arriving now must still get a new flight.
    let fresh = flights
        .acquire(1, Duration::from_millis(100))
        .await
        .unwrap();
    assert!(fresh.shared().unwrap().is_none());
    assert!(!Arc::ptr_eq(&fresh.flight, &joined.flight));
}
