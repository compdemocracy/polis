use super::*;
use postgres::{Config, NoTls};
use std::{
    sync::atomic::{AtomicUsize, Ordering::SeqCst},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Traffic {
    sync: AtomicUsize,
    parse: AtomicUsize,
    execute: AtomicUsize,
    close: AtomicUsize,
}
impl Traffic {
    fn snapshot(&self) -> [usize; 4] {
        [
            self.sync.load(SeqCst),
            self.parse.load(SeqCst),
            self.execute.load(SeqCst),
            self.close.load(SeqCst),
        ]
    }
}

struct Fixture {
    pca: Arc<Pca>,
    traffic: Arc<Traffic>,
    url: String,
    schema: String,
    proxy: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!(
            "pca_protocol_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, SeqCst)
        );
        let sql = format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.math_main(zid integer, math_env text, math_tick bigint, data jsonb);
            INSERT INTO {schema}.math_main VALUES (1,'a',0,'{{\"lastVoteTimestamp\":123,\"n\":2}}'), (1,'b',9,'{{\"lastVoteTimestamp\":123,\"n\":3}}');");
        execute(&url, sql).await;
        let mut cfg: Config = url.parse().unwrap();
        let host = match &cfg.get_hosts()[0] {
            postgres::config::Host::Tcp(h) => h.clone(),
            _ => panic!("test requires TCP Postgres"),
        };
        let port = cfg.get_ports().first().copied().unwrap_or(5432);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let traffic = Arc::new(Traffic::default());
        let seen = traffic.clone();
        let proxy = tokio::spawn(async move {
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = tokio::net::TcpStream::connect((host.as_str(), port))
                    .await
                    .unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    client.set_nodelay(true).unwrap();
                    server.set_nodelay(true).unwrap();
                    // The test uses plaintext TCP. Forward its startup packet before
                    // counting framed frontend messages, independent of TCP chunks.
                    let len = client.read_u32().await.unwrap();
                    let mut startup = vec![0; len as usize - 4];
                    client.read_exact(&mut startup).await.unwrap();
                    server.write_u32(len).await.unwrap();
                    server.write_all(&startup).await.unwrap();
                    let (mut cr, mut cw) = client.into_split();
                    let (mut sr, mut sw) = server.into_split();
                    let front = async {
                        while let Ok(tag) = cr.read_u8().await {
                            let len = cr.read_u32().await?;
                            let mut body = vec![0; len as usize - 4];
                            cr.read_exact(&mut body).await?;
                            match tag {
                                b'S' => {
                                    seen.sync.fetch_add(1, SeqCst);
                                }
                                b'P' => {
                                    seen.parse.fetch_add(1, SeqCst);
                                }
                                b'E' => {
                                    seen.execute.fetch_add(1, SeqCst);
                                }
                                b'C' => {
                                    seen.close.fetch_add(1, SeqCst);
                                }
                                _ => {}
                            }
                            sw.write_u8(tag).await?;
                            sw.write_u32(len).await?;
                            sw.write_all(&body).await?;
                        }
                        Ok::<(), std::io::Error>(())
                    };
                    tokio::select! { _ = front => {}, _ = tokio::io::copy(&mut sr, &mut cw) => {} }
                });
            }
        });
        // Reparse so replacing the host/port does not append a failover address.
        let mut via = Config::new();
        via.host("127.0.0.1")
            .port(proxy_port)
            .user(cfg.get_user().unwrap())
            .dbname(cfg.get_dbname().unwrap());
        if let Some(password) = cfg.get_password() {
            via.password(password);
        }
        via.ssl_mode(postgres::config::SslMode::Disable)
            .options(&format!("-c search_path={schema}"));
        cfg.options(&format!("-c search_path={schema}"));
        let pool = Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(via)),
            db::Limits {
                size: 8,
                acquire_timeout: Duration::from_secs(2),
                statement_timeout: Duration::from_secs(3),
                max_lifetime: Duration::from_secs(60),
            },
        );
        pool.with(|_| Ok(())).await.unwrap();
        Self {
            pca: Arc::new(Pca::new(pool, "a".into(), 300)),
            traffic,
            url,
            schema,
            proxy,
        }
    }
    fn expire(&self) {
        let mut cache = lock(&self.pca.cache).unwrap();
        let mut entry = (*cache.get(&1).unwrap()).clone();
        entry.expiration = 0.0;
        cache.set(1, Arc::new(entry));
    }
    async fn settle(&self) -> [usize; 4] {
        // A string query's asynchronous Close can trail its returned rows.
        tokio::time::sleep(Duration::from_millis(40)).await;
        self.traffic.snapshot()
    }
    async fn finish(self) {
        tokio::task::spawn_blocking(move || drop(self.pca))
            .await
            .unwrap();
        execute(&self.url, format!("DROP SCHEMA {} CASCADE", self.schema)).await;
        self.proxy.abort();
    }
}
async fn execute(url: &str, sql: String) {
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
use postgres::Client;

async fn exchanges(case: &str) {
    let f = Fixture::new().await;
    if case != "first" {
        f.pca.get_pca(1, -1.0).await.unwrap();
        f.expire();
    }
    if case == "changed" {
        execute(
            &f.url,
            format!(
                "UPDATE {}.math_main SET math_tick=1 WHERE math_env='a'",
                f.schema
            ),
        )
        .await;
    }
    let before = f.settle().await;
    let item = f.pca.get_pca(1, -1.0).await.unwrap().unwrap();
    let after = f.settle().await;
    let counts: Vec<_> = after.iter().zip(before).map(|(a, b)| a - b).collect();
    assert_eq!(item.math_tick(), if case == "changed" { 1.0 } else { 0.0 });
    f.finish().await;
    eprintln!("{case}: [Sync, Parse, Execute, Close] = {counts:?}");
    assert_eq!(
        counts[0], 1,
        "one protocol exchange per math refresh: {counts:?}"
    );
    assert_eq!(counts[2], 1, "one statement per math refresh");
    assert_eq!(counts[3], 0, "no per-request Close");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_generation_uses_one_exchange() {
    exchanges("same").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_generation_uses_one_exchange() {
    exchanges("changed").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_generation_uses_one_exchange() {
    exchanges("first").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_refresh_builds_one_shared_body() {
    let f = Fixture::new().await;
    // Hold the row read until all sixteen requests have reached an await.
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let url = f.url.clone();
    let schema = f.schema.clone();
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
    let started = Arc::new(AtomicUsize::new(0));
    let reads_before = f.pca.db.evidence.acquired.load(SeqCst);
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let pca = f.pca.clone();
        let started = started.clone();
        tasks.push(tokio::spawn(async move {
            started.fetch_add(1, SeqCst);
            pca.get_pca(1, -1.0).await.unwrap().unwrap()
        }));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while started.load(SeqCst) != 16 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    release_tx.send(()).unwrap();
    holder.await.unwrap();
    let mut bodies = Vec::new();
    for task in tasks {
        bodies.push(task.await.unwrap());
    }
    let reads = f.pca.db.evidence.acquired.load(SeqCst) - reads_before;
    let mut allocations = std::collections::HashSet::new();
    for item in &bodies {
        allocations.insert(Arc::as_ptr(&item.pojo));
        assert_eq!(item.gzip, bodies[0].gzip);
    }
    eprintln!(
        "16 requests: {reads} reads, {} body allocations",
        allocations.len()
    );
    f.finish().await;
    assert_eq!(reads, 1, "one database read for the overlapping requests");
    assert_eq!(
        allocations.len(),
        1,
        "one body build shared by the overlapping requests"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_presentation_builds_one_shared_body() {
    let f = Fixture::new().await;
    execute(&f.url, format!("CREATE TABLE {}.comments (zid integer, tid integer, mod integer); INSERT INTO {}.comments VALUES (1,7,1)", f.schema, f.schema)).await;
    let item = f.pca.get_pca(1, -1.0).await.unwrap().unwrap();
    let before = f.pca.db.evidence.acquired.load(SeqCst);
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let pca = f.pca.clone();
        let item = item.clone();
        tasks.push(tokio::spawn(
            async move { pca.present(1, item).await.unwrap() },
        ));
    }
    let mut allocations = std::collections::HashSet::new();
    let mut bodies = Vec::new();
    for task in tasks {
        let item = task.await.unwrap();
        allocations.insert(Arc::as_ptr(&item.pojo));
        bodies.push(item);
    }
    let reads = f.pca.db.evidence.acquired.load(SeqCst) - before;
    eprintln!(
        "16 presentations: {reads} reads, {} body allocations",
        allocations.len()
    );
    f.finish().await;
    assert_eq!(reads, 1);
    assert_eq!(allocations.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_keys_and_instances_do_not_share_waits() {
    let f = Fixture::new().await;
    let held = f
        .pca
        .refreshes
        .acquire(1, Duration::from_secs(2))
        .await
        .unwrap();
    let other = Pca::new(f.pca.db.clone(), "b".into(), 300);
    let item = tokio::time::timeout(Duration::from_secs(1), other.get_pca(1, -1.0))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(item.math_tick(), 9.0);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), f.pca.get_pca(2, -1.0))
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .synthesized
    );
    drop(held);
    drop(other);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_refresh_keeps_its_conversation_until_the_read_finishes() {
    let f = Fixture::new().await;
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let url = f.url.clone();
    let schema = f.schema.clone();
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
    let before = f.pca.db.evidence.acquired.load(SeqCst);
    let pca = f.pca.clone();
    let first = tokio::spawn(async move { pca.get_pca(1, -1.0).await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while f.pca.db.evidence.acquired.load(SeqCst) == before {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    let pca = f.pca.clone();
    let second = tokio::spawn(async move { pca.get_pca(1, -1.0).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let during = f.pca.db.evidence.acquired.load(SeqCst) - before;
    release_tx.send(()).unwrap();
    holder.await.unwrap();
    assert_eq!(second.await.unwrap().unwrap().unwrap().math_tick(), 0.0);
    f.finish().await;
    assert_eq!(
        during, 1,
        "cancelled callers must not permit a simultaneous second read"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_cache_still_shares_overlapping_refreshes() {
    let mut f = Fixture::new().await;
    Arc::get_mut(&mut f.pca).unwrap().cache = Mutex::new(Cache::new(0, DEFAULT_CACHE_BYTES));
    let before = f.pca.db.evidence.acquired.load(SeqCst);
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let pca = f.pca.clone();
        tasks.push(tokio::spawn(async move {
            pca.get_pca(1, -1.0).await.unwrap().unwrap()
        }));
    }
    let mut bodies = Vec::new();
    for task in tasks {
        bodies.push(task.await.unwrap());
    }
    let reads = f.pca.db.evidence.acquired.load(SeqCst) - before;
    assert_eq!(reads, 1);
    assert!(bodies.iter().all(|item| Arc::ptr_eq(&bodies[0], item)));
    assert!(lock(&f.pca.cache).unwrap().get(&1).is_none());
    f.pca.get_pca(1, -1.0).await.unwrap();
    assert_eq!(
        f.pca.db.evidence.acquired.load(SeqCst) - before,
        2,
        "a later caller still reads with caching disabled"
    );
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waiter_revalidates_a_shared_result_that_has_expired() {
    let f = Fixture::new().await;
    let mut flight = f
        .pca
        .refreshes
        .acquire(1, Duration::from_secs(2))
        .await
        .unwrap();
    let mut pojo = Obj::new();
    pojo.set("math_tick", Js::Num(8.0));
    let mut item = (*Pca::build(pojo, false, true).unwrap()).clone();
    item.expiration = 0.0;
    *flight.value = Some(Ok(MathRefresh::Ready(Arc::new(item), "miss")));
    let pca = f.pca.clone();
    let waiter = tokio::spawn(async move { pca.get_pca(1, -1.0).await.unwrap().unwrap() });
    tokio::time::timeout(Duration::from_secs(1), async {
        while Arc::strong_count(&flight.flight) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("waiter must join the held flight before it is released");
    drop(flight);
    let tick = waiter.await.unwrap().math_tick();
    f.finish().await;
    assert_eq!(
        tick, 0.0,
        "a shared result cannot extend the freshness window"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_uncommitted_row_is_still_labelled_a_miss() {
    let f = Fixture::new().await;
    execute(
        &f.url,
        format!("UPDATE {}.math_main SET math_tick=-1", f.schema),
    )
    .await;
    let outcome = CACHE_OUTCOME
        .scope(std::cell::Cell::new("none"), async {
            assert!(f.pca.get_pca(1, -1.0).await.unwrap().is_none());
            CACHE_OUTCOME.with(|c| c.get())
        })
        .await;
    f.finish().await;
    assert_eq!(outcome, "miss");
}
