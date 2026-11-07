use super::*;
use crate::db;
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
    cache: Arc<Priorities>,
    pool: Arc<db::Pool>,
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
            "priority_protocol_{}_{}",
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
        let pool = db::Pool::new(
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
            cache: Arc::new(Priorities::new(4)),
            pool,
            traffic,
            url,
            schema,
            proxy,
        }
    }
    fn expire(&self) {
        self.cache.expire(1, "a");
    }
    async fn read(&self) -> Option<Arc<Js>> {
        let cache = self.cache.clone();
        self.pool
            .with(move |c| cache.read(c, 1, "a"))
            .await
            .unwrap()
    }
    async fn settle(&self) -> [usize; 4] {
        // A string query's asynchronous Close can trail its returned rows.
        tokio::time::sleep(Duration::from_millis(40)).await;
        self.traffic.snapshot()
    }
    async fn finish(self) {
        tokio::task::spawn_blocking(move || drop(self.pool))
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
        f.read().await.unwrap();
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
    f.read().await.unwrap();
    let after = f.settle().await;
    let counts: Vec<_> = after.iter().zip(before).map(|(a, b)| a - b).collect();
    f.finish().await;
    eprintln!("{case}: [Sync, Parse, Execute, Close] = {counts:?}");
    assert_eq!(counts, vec![1, 1, 1, 0]);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_generation_uses_one_exchange() {
    exchanges("first").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_generation_uses_one_exchange() {
    exchanges("same").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_generation_uses_one_exchange() {
    exchanges("changed").await;
}
