//! Capture the actual access-log line without replacing its production sink.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::{config::Config, http::Headers};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::Value;
use std::{cell::RefCell, sync::Arc, time::Duration};

tokio::task_local! {
    static LINES: RefCell<Vec<String>>;
}
pub(super) fn record(line: &str) {
    let _ = LINES.try_with(|lines| lines.borrow_mut().push(line.into()));
}
fn app(pool: Arc<Pool>) -> Arc<App> {
    let cfg = Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 300,
        pca_cache_size: 300,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: crate::next_comment::pool_limits(),
    };
    let mut app = App::new(&cfg, pool.clone());
    app.next_comment_db = Some(pool);
    app.next_comment_plain = true;
    Arc::new(app)
}
fn pool(config: postgres::Config, lifetime: Duration) -> Arc<Pool> {
    let mut limits = crate::next_comment::pool_limits();
    limits.max_lifetime = lifetime;
    Pool::new(Connector::Plain(Box::new(config)), limits)
}
async fn logged(app: Arc<App>, path: &str) -> (Outgoing, Value) {
    LINES
        .scope(RefCell::new(Vec::new()), async {
            let req = Request {
                method: "GET".into(),
                target: path.into(),
                headers: Headers::from_raw([("host", "localhost")]),
                body: Vec::new(),
            };
            let out = handle(app, req).await;
            let lines = LINES.with(|l| l.borrow().clone());
            assert_eq!(lines.len(), 1);
            let value: Value = serde_json::from_str(&lines[0]).unwrap();
            assert_eq!(value["http"]["status_code"], out.status);
            let field = value["db_connect"]
                .as_object()
                .expect("db_connect must always be present");
            assert_eq!(field.len(), 4);
            let milliseconds = lines[0]
                .split("\"ms\":")
                .nth(1)
                .unwrap()
                .split(',')
                .next()
                .unwrap();
            assert_eq!(milliseconds.split('.').nth(1).unwrap().len(), 3);

            for key in ["count", "failed", "ms", "in_flight"] {
                assert!(field[key].is_number(), "numeric {key}");
            }
            assert!(lines[0].find("\"cache\"").unwrap() < lines[0].find("\"db_connect\"").unwrap());
            (out, value)
        })
        .await
}
fn zeros(v: &Value) {
    for key in ["count", "failed", "in_flight"] {
        assert_eq!(v["db_connect"][key], 0);
    }
    assert_eq!(v["db_connect"]["ms"].as_f64(), Some(0.0));
}

#[cfg(feature = "db-tests")]
fn cold(v: &Value) {
    assert_eq!(v["db_connect"]["count"], 1);
    assert_eq!(v["db_connect"]["failed"], 0);
    assert_eq!(v["db_connect"]["in_flight"], 0);
    assert!(v["db_connect"]["ms"].as_f64().unwrap() > 0.0);
}
#[cfg(feature = "db-tests")]
const PCA: &str = "/api/v3/math/pca2?conversation_id=a";
const NEXT: &str = "/api/v3/nextComment?conversation_id=a";

#[tokio::test]
async fn db_connect_field_has_only_four_numbers_even_without_database_work() {
    let cfg = "postgres://unused@127.0.0.1:1/unused".parse().unwrap();
    let (_, line) = logged(app(pool(cfg, Duration::from_secs(300))), "/not-a-route").await;
    zeros(&line);
}

#[tokio::test]
async fn db_connect_refused_connection_is_failed_on_the_502_line() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let cfg = format!("postgres://unused@127.0.0.1:{port}/unused")
        .parse()
        .unwrap();
    let (out, line) = logged(app(pool(cfg, Duration::from_secs(300))), NEXT).await;
    assert_eq!(out.status, 502);
    assert_eq!(line["db_connect"]["count"], 1);
    assert_eq!(line["db_connect"]["failed"], 1);
    assert_eq!(line["db_connect"]["in_flight"], 0);
    assert!(line["db_connect"]["ms"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn db_connect_stalled_next_comment_is_censored_at_the_real_deadline() {
    // A plain thread releases the stalled peer even if a test assertion unwinds.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let peer = std::thread::spawn(move || {
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < until {
            if let Ok((stream, _)) = listener.accept() {
                let _ = wait.recv_timeout(Duration::from_secs(5));
                drop(stream);
                return;
            }
            if wait
                .try_recv()
                .is_err_and(|e| matches!(e, std::sync::mpsc::TryRecvError::Disconnected))
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    let cfg = format!("postgres://unused@127.0.0.1:{port}/unused")
        .parse()
        .unwrap();
    let db = Pool::new(
        Connector::Plain(Box::new(cfg)),
        crate::next_comment::pool_limits(),
    );
    let (out, line) = logged(app(db.clone()), NEXT).await;
    assert_eq!(out.status, 502);
    assert_eq!(line["db_connect"]["count"], 1);
    assert_eq!(line["db_connect"]["failed"], 0);
    assert_eq!(line["db_connect"]["in_flight"], 1);
    assert!(line["db_connect"]["ms"].as_f64().unwrap() >= 75.0, "{line}");
    release.send(()).unwrap();
    peer.join().unwrap();
}

#[cfg(feature = "db-tests")]
struct Fixture {
    schema: String,
    url: String,
    config: postgres::Config,
}
#[cfg(feature = "db-tests")]
impl Fixture {
    async fn new(name: &str) -> Self {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("connect_log_{name}_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
                CREATE TABLE zinvites(zid integer,zinvite text);
                CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
                CREATE TABLE comments(zid integer,tid integer,mod integer);
                INSERT INTO zinvites VALUES(1,'a'),(2,'b'),(3,'c');
                INSERT INTO comments VALUES(1,0,1);
                INSERT INTO math_main SELECT n,'test',0,'{{\"lastVoteTimestamp\":123,\"n\":2}}'::jsonb FROM generate_series(1,3) n;" )).unwrap();
        }).await.unwrap();
        let mut config: postgres::Config = url.parse().unwrap();
        config.options(&format!("-c search_path={schema}"));
        Self {
            schema,
            url,
            config,
        }
    }
}
#[cfg(feature = "db-tests")]
impl Drop for Fixture {
    fn drop(&mut self) {
        let url = self.url.clone();
        let schema = self.schema.clone();
        std::thread::spawn(move || {
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .join()
        .unwrap();
    }
}
#[cfg(feature = "db-tests")]
#[tokio::test]
async fn db_connect_cold_warm_and_expired_pool_requests() {
    let fixture = Fixture::new("lifetime").await;
    let state = app(pool(fixture.config.clone(), Duration::from_millis(250)));
    let (out, first) = logged(state.clone(), PCA).await;
    assert_eq!(out.status, 200);
    cold(&first);
    let (out, warm) = logged(state.clone(), "/api/v3/math/pca2?conversation_id=b").await;
    assert_eq!(out.status, 200);
    zeros(&warm);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (out, expired) = logged(state, "/api/v3/math/pca2?conversation_id=c").await;
    assert_eq!(out.status, 200);
    cold(&expired);
}
#[cfg(feature = "db-tests")]
#[tokio::test]
async fn db_connect_concurrent_requests_do_not_share_pool_observations() {
    let fixture = Fixture::new("parallel").await;
    let cold_pool = pool(fixture.config.clone(), Duration::from_secs(300));
    let warm_pool = pool(fixture.config.clone(), Duration::from_secs(300));
    assert!(warm_pool.ping().await);
    let ((a, first), (b, second)) =
        tokio::join!(logged(app(cold_pool), PCA), logged(app(warm_pool), PCA));
    assert_eq!(a.status, 200);
    assert_eq!(b.status, 200);
    cold(&first);
    zeros(&second);
}
#[cfg(feature = "db-tests")]
#[tokio::test]
async fn db_connect_pca_miss_hit_and_warm_and_expired_revalidation() {
    let fixture = Fixture::new("cache").await;
    let db = pool(fixture.config.clone(), Duration::from_secs(4));
    let state = app(db.clone());
    let (out, miss) = logged(state.clone(), PCA).await;
    assert_eq!(out.status, 200);
    assert_eq!(miss["cache"], "miss");
    cold(&miss);
    let before = db.evidence.snapshot()[0];
    let (out, hit) = logged(state.clone(), PCA).await;
    assert_eq!(out.status, 200);
    assert_eq!(hit["cache"], "hit");
    zeros(&hit);
    assert_eq!(
        db.evidence.snapshot()[0],
        before,
        "complete hit avoids all SQL"
    );
    tokio::time::sleep(Duration::from_millis(3050)).await;
    let (out, warm) = logged(state.clone(), PCA).await;
    assert_eq!(out.status, 200);
    assert_eq!(warm["cache"], "revalidated");
    zeros(&warm);
    assert_eq!(
        db.evidence.snapshot()[0] - before,
        2,
        "tick read and presentation backfill"
    );
    tokio::time::sleep(Duration::from_millis(3050)).await;
    let (out, expired) = logged(state, PCA).await;
    assert_eq!(out.status, 200);
    assert_eq!(expired["cache"], "revalidated");
    cold(&expired);
}
