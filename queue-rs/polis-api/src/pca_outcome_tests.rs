// Shared healthy reads, uncommitted rows and sustained read failures.
use super::*;
use postgres::{Client, Config, NoTls};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
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

/// `math_main` is a view whose every read sleeps `sleep_s` seconds, over one
/// row for conversation 1 at `tick`.
async fn env(limits: db::Limits, sleep_s: f64, tick: i64) -> Env {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!(
        "pca_shared_{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, SeqCst)
    );
    exec(&url, format!("CREATE SCHEMA {schema};
        CREATE TABLE {schema}.math_rows(zid integer, math_env text, math_tick bigint, data jsonb);
        INSERT INTO {schema}.math_rows VALUES (1,'a',{tick},'{{\"lastVoteTimestamp\":123,\"n\":2}}');
        CREATE VIEW {schema}.math_main AS SELECT m.* FROM {schema}.math_rows m, LATERAL (SELECT pg_sleep({sleep_s})) s;")).await;
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
    fn reads(&self) -> usize {
        self.pca.db.evidence.acquired.load(SeqCst)
    }
}

async fn overlap(e: &Env, n: usize) -> Vec<(Result<bool, bool>, Duration)> {
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..n {
        let pca = e.pca.clone();
        tasks.push(tokio::spawn(async move {
            // Ok(served a body) / Err(is a 502 hand-back)
            let r = match pca.get_pca(1, -1.0).await {
                Ok(v) => Ok(v.is_some()),
                Err(e) => Err(db::is_unavailable(&e)),
            };
            (r, t0.elapsed())
        }));
    }
    let mut out = Vec::new();
    for t in tasks {
        out.push(t.await.unwrap());
    }
    out
}

fn report(label: &str, out: &[(Result<bool, bool>, Duration)], reads: usize) {
    let mut rows: Vec<_> = out
        .iter()
        .map(|(r, d)| {
            let tag = match r {
                Ok(true) => "body",
                Ok(false) => "none",
                Err(true) => "502",
                Err(false) => "500",
            };
            (d.as_millis(), tag)
        })
        .collect();
    rows.sort();
    eprintln!("{label}: {reads} reads; (ms, answer) {rows:?}");
}

// A healthy read that is slower than the pool acquisition timeout (here 300 ms
// against 200 ms; in production a read between 2,000 and 3,000 ms). On the base
// every caller makes its own read and is served. Callers that join one flight
// should also be served, not handed back while the shared read is still healthy.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_slow_healthy_read_serves_every_caller() {
    let e = env(limits(200, 3000, 8), 0.3, 0).await;
    let before = e.reads();
    let out = overlap(&e, 6).await;
    let reads = e.reads() - before;
    e.finish().await;
    report(
        "slow healthy read (300 ms read, 200 ms acquire timeout), 6 callers",
        &out,
        reads,
    );
    assert!(
        out.iter()
            .all(|(_, elapsed)| *elapsed < Duration::from_millis(450)),
        "300 ms read plus 150 ms scheduling tolerance"
    );
    assert!(
        out.iter().all(|(r, _)| matches!(r, Ok(true))),
        "a caller was handed back while the shared read was healthy"
    );
}

// An uncommitted row is shared: ten overlapping callers receive the
// uncommitted answer from one read. With a 100 ms read and a 450 ms acquisition
// timeout, all callers should answer together at about 100 ms.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_uncommitted_row_answers_overlapping_callers_together() {
    let e = env(limits(450, 3000, 8), 0.1, -1).await;
    let before = e.reads();
    let out = overlap(&e, 10).await;
    let reads = e.reads() - before;
    e.finish().await;
    report(
        "uncommitted row (100 ms read, 450 ms acquire timeout), 10 callers",
        &out,
        reads,
    );
    let worst = out.iter().map(|(_, d)| *d).max().unwrap();
    assert!(
        out.iter().all(|(r, _)| matches!(r, Ok(false))),
        "every caller gets the uncommitted answer"
    );
    assert!(worst < Duration::from_millis(400), "slowest {worst:?}");
}

// Sustained failure: math_main locked, 150 ms statement timeout, a new request
// for the same conversation every 10 ms for 1.5 s. Count how many pool reads
// are in progress at once and how long the slowest caller waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shared_sustained_failure_runs_one_read_at_a_time() {
    let e = env(limits(2000, 150, 8), 0.0, 0).await;
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let (url, schema) = (e.url.clone(), e.schema.clone());
    let holder = tokio::task::spawn_blocking(move || {
        let mut c = Client::connect(&url, NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN; LOCK TABLE {schema}.math_rows IN ACCESS EXCLUSIVE MODE"
        ))
        .unwrap();
        locked_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        c.batch_execute("ROLLBACK").unwrap();
    });
    locked_rx.await.unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let pca = e.pca.clone();
    let stop2 = stop.clone();
    let sampler = tokio::spawn(async move {
        let mut max = 0;
        while !stop2.load(SeqCst) {
            let ev = &pca.db.evidence;
            let busy = ev.acquired.load(SeqCst) - ev.completed.load(SeqCst);
            max = max.max(busy);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        max
    });
    let before = e.reads();
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..150 {
        let pca = e.pca.clone();
        tasks.push(tokio::spawn(async move {
            let start = Instant::now();
            let r = pca.get_pca(1, -1.0).await;
            (r.is_err(), start.elapsed())
        }));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut worst = Duration::ZERO;
    let mut errors = 0;
    for t in tasks {
        let (err, d) = t.await.unwrap();
        errors += usize::from(err);
        worst = worst.max(d);
    }
    let elapsed = t0.elapsed();
    stop.store(true, SeqCst);
    let max_busy = sampler.await.unwrap();
    let reads = e.reads() - before;
    release_tx.send(()).unwrap();
    holder.await.unwrap();
    e.finish().await;
    eprintln!(
        "sustained failure: 150 requests over {elapsed:?}, {errors} errors, {reads} reads, at most {max_busy} reads at once, slowest caller {worst:?}"
    );
    assert_eq!(errors, 150);
    assert!(max_busy <= 2, "{max_busy} reads at once");
    assert!(
        worst < Duration::from_millis(450),
        "slowest caller {worst:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uncommitted_joiners_keep_their_own_requested_tick() {
    let e = env(limits(450, 3000, 8), 0.1, -1).await;
    let before = e.reads();
    let leader_pca = e.pca.clone();
    let leader = tokio::spawn(async move { leader_pca.get_pca(1, -1.0).await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while e.reads() == before {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let (older, current) = tokio::join!(e.pca.get_pca(1, -2.0), e.pca.get_pca(1, -1.0));
    assert!(leader.await.unwrap().unwrap().is_none());
    assert_eq!(older.unwrap().unwrap().math_tick(), -1.0);
    assert!(current.unwrap().is_none());
    assert_eq!(e.reads() - before, 1);
    e.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn earlier_handler_deadline_cancels_both_flight_waits() {
    let e = env(limits(100, 200, 8), 0.0, 0).await;
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
    let item = Pca::build(ensure_complete(None, now_ms()), true, false).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(50);
    let (math, presentation) = tokio::join!(
        tokio::time::timeout_at(deadline, e.pca.get_pca(1, -1.0)),
        tokio::time::timeout_at(deadline, e.pca.present(1, item)),
    );
    assert!(math.is_err() && presentation.is_err());
    assert_eq!(Arc::strong_count(&held_math.flight), 1);
    assert_eq!(Arc::strong_count(&held_presentation.flight), 1);
    assert_eq!(e.reads(), 0);
    drop((held_math, held_presentation));
    e.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_healthy_presentation_serves_every_joiner() {
    let e = env(limits(200, 3000, 8), 0.0, 0).await;
    exec(&e.url, format!(
        "CREATE VIEW {}.comments AS SELECT 1::int zid, 7::int tid, 1::int mod FROM pg_sleep(0.3)", e.schema
    )).await;
    let item = Pca::build(ensure_complete(None, now_ms()), true, false).unwrap();
    let start = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let pca = e.pca.clone();
        let item = item.clone();
        tasks.push(tokio::spawn(async move { pca.present(1, item).await }));
    }
    let mut answers = Vec::new();
    for task in tasks {
        answers.push(task.await.unwrap().unwrap());
    }
    let elapsed = start.elapsed();
    assert!(answers.iter().all(|a| Arc::ptr_eq(a, &answers[0])));
    assert_eq!(answers[0].pojo.get("n-cmts"), Some(&Js::Num(1.0)));
    assert_eq!(e.reads(), 1);
    assert!(
        elapsed < Duration::from_millis(450),
        "300 ms read plus 150 ms tolerance: {elapsed:?}"
    );
    e.finish().await;
}
