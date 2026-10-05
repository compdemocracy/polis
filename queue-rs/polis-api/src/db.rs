//! The typed database boundary for this route: three read-only queries, each
//! returning a typed row, over the workspace's shared transport rules.
//!
//! The Node route issues exactly these reads (`conversation.ts`
//! `getZidFromConversationId`, `pca.ts` `getPca`, `pcaPresentation.ts`
//! `backfilledTids`). The math blob stays opaque text at this boundary: its
//! column is `jsonb`, and the route's own reshaping rules live in `pca.rs`.
//!
//! Connections are synchronous `postgres` clients (the transport this
//! workspace already certifies); each query runs on Tokio's blocking pool, and
//! a fixed-size pool bounds how many run at once. The pool slot belongs to
//! the blocking operation, not to the caller awaiting it: a caller that gives
//! up (a request deadline, a dropped connection) leaves the slot held until
//! the database work has really finished, so at most `size` operations ever
//! run and at most `size` clients are ever kept.

use anyhow::Result;
use polis_queue_adapter::jobs::transport::Connector;
use postgres::Client;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

/// One `math_main` row for `(zid, math_env)`.
#[derive(Clone, Debug)]
pub struct MathMainRow {
    /// `math_main.math_tick` (BIGINT, default -1 before a tick is assigned).
    pub math_tick: i64,
    /// `math_main.data` (JSONB) as Postgres prints it.
    pub data: String,
}

pub fn zid_for_conversation_id(client: &mut Client, conversation_id: &str) -> Result<Option<i32>> {
    let rows = client.query(
        "select zid from zinvites where zinvite = ($1)",
        &[&conversation_id],
    )?;
    Ok(rows.first().map(|r| r.get::<_, i32>(0)))
}

pub fn math_main(client: &mut Client, zid: i32, math_env: &str) -> Result<Option<MathMainRow>> {
    let rows = client.query(
        "select math_tick, data::text from math_main where zid = ($1) and math_env = ($2)",
        &[&zid, &math_env],
    )?;
    Ok(rows.first().map(|r| MathMainRow {
        math_tick: r.get(0),
        data: r.get(1),
    }))
}

/// `select tid from comments where zid = ($1) and mod >= 1 order by tid`
pub fn approved_tids(client: &mut Client, zid: i32) -> Result<Vec<i32>> {
    let rows = client.query(
        "select tid from comments where zid = ($1) and mod >= 1 order by tid",
        &[&zid],
    )?;
    Ok(rows.iter().map(|r| r.get::<_, i32>(0)).collect())
}

/// The database could not answer: no connection, no free pool slot in time,
/// a statement timeout, or any other query error. The route answers 502 for
/// this, so nginx asks the Node server instead of serving a wrong page.
#[derive(Debug)]
pub struct Unavailable(pub String);

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "database unavailable: {}", self.0)
    }
}

impl std::error::Error for Unavailable {}

/// True when `e` (or anything it wraps) is a database failure.
pub fn is_unavailable(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.is::<Unavailable>())
}

fn unavailable(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow::Error::new(Unavailable(format!("{e:#}")))
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub size: usize,
    pub acquire_timeout: Duration,
    /// `statement_timeout` for every statement on a pooled connection.
    pub statement_timeout: Duration,
    /// A connection older than this is closed instead of reused.
    pub max_lifetime: Duration,
}

pub struct Pool {
    connector: Connector,
    idle: Mutex<Vec<(Client, Instant)>>,
    permits: Arc<Semaphore>,
    limits: Limits,
}

impl Pool {
    pub fn new(connector: Connector, limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            connector,
            idle: Mutex::new(Vec::new()),
            permits: Arc::new(Semaphore::new(limits.size)),
            limits,
        })
    }

    fn connect(&self) -> Result<Client> {
        let mut client = self.connector.connect()?;
        // Every statement here is a read; the session refuses writes outright.
        client.batch_execute(&format!(
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SET statement_timeout = {}",
            self.limits.statement_timeout.as_millis()
        ))?;
        Ok(client)
    }

    /// Runs `f` on a pooled connection on the blocking thread pool. Any
    /// failure is [`Unavailable`]. A client whose connection broke, or that
    /// has outlived `max_lifetime`, is discarded; the next call opens a fresh one.
    ///
    /// The slot is moved into the blocking closure and released only when
    /// that closure returns, after the client is back in `idle` or dropped.
    /// Cancelling the returned future (dropping it while the query or the
    /// connect is still running) therefore frees nothing early.
    pub async fn with<T, F>(self: &Arc<Self>, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Client) -> Result<T> + Send + 'static,
    {
        let permit = tokio::time::timeout(
            self.limits.acquire_timeout,
            self.permits.clone().acquire_owned(),
        )
        .await
        .map_err(|_| unavailable("pool acquire timeout"))?
        .map_err(unavailable)?;
        let pool = self.clone();
        tokio::task::spawn_blocking(move || -> Result<T> {
            let _permit = permit;
            let cached = pool
                .idle
                .lock()
                .map_err(|_| unavailable("pool lock"))?
                .pop();
            let (mut client, born) = match cached {
                Some((c, born)) if !c.is_closed() && born.elapsed() < pool.limits.max_lifetime => {
                    (c, born)
                }
                _ => (pool.connect().map_err(unavailable)?, Instant::now()),
            };
            let out = f(&mut client).map_err(unavailable);
            if !client.is_closed() && born.elapsed() < pool.limits.max_lifetime {
                let mut idle = pool.idle.lock().map_err(|_| unavailable("pool lock"))?;
                if idle.len() < pool.limits.size {
                    idle.push((client, born));
                }
            }
            out
        })
        .await
        .map_err(unavailable)?
    }

    #[cfg(all(test, feature = "db-tests"))]
    fn idle_len(&self) -> usize {
        self.idle.lock().unwrap().len()
    }

    /// `select 1` through the pool, for `/health`.
    pub async fn ping(self: &Arc<Self>) -> bool {
        self.with(|c| Ok(c.query_one("select 1", &[])?.get::<_, i32>(0) == 1))
            .await
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use postgres::Config as PgConfig;
    #[cfg(feature = "db-tests")]
    use postgres::NoTls;

    fn limits() -> Limits {
        Limits {
            size: 2,
            acquire_timeout: Duration::from_millis(500),
            statement_timeout: Duration::from_millis(300),
            max_lifetime: Duration::from_secs(60),
        }
    }

    /// Nothing listens on port 1, so every call fails to connect.
    #[tokio::test]
    async fn a_refused_connection_is_unavailable() {
        let mut cfg: PgConfig = "postgresql://u@127.0.0.1:1/d".parse().unwrap();
        cfg.connect_timeout(Duration::from_secs(2));
        let pool = Pool::new(Connector::Plain(Box::new(cfg)), limits());
        let err = pool
            .with(|c| zid_for_conversation_id(c, "x"))
            .await
            .unwrap_err();
        assert!(is_unavailable(&err), "{err:#}");
        assert!(!pool.ping().await);
    }

    #[tokio::test]
    async fn a_full_pool_times_out_as_unavailable() {
        let mut cfg: PgConfig = "postgresql://u@127.0.0.1:1/d".parse().unwrap();
        cfg.connect_timeout(Duration::from_secs(2));
        let pool = Pool::new(
            Connector::Plain(Box::new(cfg)),
            Limits {
                size: 1,
                acquire_timeout: Duration::from_millis(50),
                ..limits()
            },
        );
        let _held = pool.permits.acquire().await.unwrap();
        let err = pool.with(|_| Ok(())).await.unwrap_err();
        assert!(
            is_unavailable(&err) && format!("{err}").contains("acquire"),
            "{err:#}"
        );
    }

    /// A caller that gives up while its connect is still stalled (a listener
    /// that accepts, says nothing for 600 ms, then hangs up) does not free its
    /// slot: with a pool of one, the next call waits for the slot and times
    /// out instead of starting a second connection alongside the first. The
    /// slot comes back once the stalled connect itself has ended.
    #[tokio::test]
    async fn a_cancelled_caller_keeps_its_slot_until_the_work_ends() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepted.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(600));
                    drop(stream);
                });
            }
        });
        let mut cfg: PgConfig = format!("postgresql://u@127.0.0.1:{port}/d")
            .parse()
            .unwrap();
        cfg.connect_timeout(Duration::from_millis(800));
        let pool = Pool::new(
            Connector::Plain(Box::new(cfg)),
            Limits {
                size: 1,
                acquire_timeout: Duration::from_millis(200),
                ..limits()
            },
        );
        let cancelled =
            tokio::time::timeout(Duration::from_millis(100), pool.with(|_| Ok(()))).await;
        assert!(cancelled.is_err(), "the first caller should have given up");
        let err = pool.with(|_| Ok(())).await.unwrap_err();
        assert!(
            is_unavailable(&err) && format!("{err}").contains("acquire"),
            "{err:#}"
        );
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Once the stalled connect has ended, the slot is free again.
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(pool.permits.available_permits(), 1);
    }

    /// Against a real Postgres (`--features db-tests`, `POLIS_API_TEST_DATABASE_URL`):
    /// the three queries on the schema's column types, the read-only session,
    /// the statement timeout and connection retirement.
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn the_three_queries_against_postgres() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL")
            .expect("db-tests needs POLIS_API_TEST_DATABASE_URL");
        let schema = format!("polis_api_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, NoTls).unwrap();
            c.batch_execute(&format!(
                "DROP SCHEMA IF EXISTS {s} CASCADE; CREATE SCHEMA {s};
                 -- column types as in server/postgres/migrations/000000_initial.sql
                 CREATE TABLE {s}.zinvites (zid INTEGER NOT NULL, zinvite VARCHAR(300) NOT NULL, UNIQUE (zinvite));
                 CREATE TABLE {s}.math_main (zid INTEGER NOT NULL, math_env VARCHAR(999) NOT NULL, data jsonb NOT NULL,
                   last_vote_timestamp BIGINT NOT NULL, caching_tick BIGINT NOT NULL DEFAULT 0,
                   math_tick BIGINT NOT NULL DEFAULT -1, UNIQUE (zid, math_env));
                 CREATE TABLE {s}.comments (tid INTEGER NOT NULL, zid INTEGER NOT NULL, mod INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO {s}.zinvites VALUES (7, 'abc');
                 INSERT INTO {s}.math_main (zid, math_env, data, last_vote_timestamp, math_tick)
                   VALUES (7, 'p', '{{\"n\": 2, \"tids\": [1]}}', 0, 9), (7, 'q', '{{}}', 0, 1);
                 INSERT INTO {s}.comments VALUES (3, 7, 1), (1, 7, 0), (2, 7, 1), (4, 8, 1);",
                s = setup_schema
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let mut cfg: PgConfig = url.parse().unwrap();
        cfg.options(&format!("-c search_path={schema}"));
        let pool = Pool::new(
            Connector::Plain(Box::new(cfg)),
            Limits {
                max_lifetime: Duration::from_millis(200),
                ..limits()
            },
        );
        assert_eq!(
            pool.with(|c| zid_for_conversation_id(c, "abc"))
                .await
                .unwrap(),
            Some(7)
        );
        assert_eq!(
            pool.with(|c| zid_for_conversation_id(c, "nope"))
                .await
                .unwrap(),
            None
        );
        let row = pool.with(|c| math_main(c, 7, "p")).await.unwrap().unwrap();
        assert_eq!(row.math_tick, 9);
        assert_eq!(row.data, r#"{"n": 2, "tids": [1]}"#);
        assert!(pool.with(|c| math_main(c, 7, "r")).await.unwrap().is_none());
        assert_eq!(
            pool.with(|c| approved_tids(c, 7)).await.unwrap(),
            vec![2, 3]
        );
        // Writes are refused by the session, and that is a database failure.
        let err = pool
            .with(|c| Ok(c.batch_execute("INSERT INTO zinvites VALUES (8, 'w')")?))
            .await
            .unwrap_err();
        assert!(
            is_unavailable(&err) && format!("{err:#}").contains("read-only"),
            "{err:#}"
        );
        // The statement timeout cancels a slow read.
        let err = pool
            .with(|c| Ok(c.batch_execute("SELECT pg_sleep(2)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("statement timeout"), "{err:#}");
        // A connection past its lifetime is replaced, not reused.
        let first = pool
            .with(|c| {
                Ok(c.query_one("select pg_backend_pid()", &[])?
                    .get::<_, i32>(0))
            })
            .await
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let second = pool
            .with(|c| {
                Ok(c.query_one("select pg_backend_pid()", &[])?
                    .get::<_, i32>(0))
            })
            .await
            .unwrap();
        assert_ne!(first, second);
        // Cancellation: a caller abandons a running `pg_sleep`. Its slot stays
        // taken until the statement ends, so with a pool of one a second call
        // cannot run beside it, and no more than one client is ever kept.
        let mut one: PgConfig = url.parse().unwrap();
        one.options(&format!("-c search_path={schema}"));
        let single = Pool::new(
            Connector::Plain(Box::new(one)),
            Limits {
                size: 1,
                acquire_timeout: Duration::from_millis(100),
                statement_timeout: Duration::from_secs(5),
                max_lifetime: Duration::from_secs(60),
            },
        );
        assert_eq!(single.with(|_| Ok(())).await.unwrap(), ());
        let abandoned = tokio::time::timeout(
            Duration::from_millis(100),
            single.with(|c| Ok(c.batch_execute("SELECT pg_sleep(0.5)")?)),
        )
        .await;
        assert!(
            abandoned.is_err(),
            "the sleeping caller should have given up"
        );
        let err = single.with(|_| Ok(())).await.unwrap_err();
        assert!(format!("{err}").contains("acquire"), "{err:#}");
        tokio::time::sleep(Duration::from_millis(700)).await;
        single.with(|_| Ok(())).await.unwrap();
        assert_eq!(single.idle_len(), 1);
        tokio::task::spawn_blocking(move || drop(single))
            .await
            .unwrap();
        // Synchronous clients must be dropped off the async runtime.
        tokio::task::spawn_blocking(move || drop(pool))
            .await
            .unwrap();
        let cleanup = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&url, NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {cleanup} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
}
