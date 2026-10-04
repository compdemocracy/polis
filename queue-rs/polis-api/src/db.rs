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
//! a fixed-size pool bounds how many run at once.

use anyhow::{Context, Result, anyhow};
use polis_queue_adapter::jobs::transport::Connector;
use postgres::Client;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
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

pub struct Pool {
    connector: Connector,
    idle: Mutex<Vec<Client>>,
    permits: Semaphore,
    acquire_timeout: Duration,
}

impl Pool {
    pub fn new(connector: Connector, size: usize, acquire_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            connector,
            idle: Mutex::new(Vec::new()),
            permits: Semaphore::new(size),
            acquire_timeout,
        })
    }

    fn connect(&self) -> Result<Client> {
        let mut client = self.connector.connect()?;
        // Every statement here is a read; the session refuses writes outright.
        client.batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")?;
        Ok(client)
    }

    /// Runs `f` on a pooled connection on the blocking thread pool. A client
    /// whose connection broke is discarded; the next call opens a fresh one.
    pub async fn with<T, F>(self: &Arc<Self>, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Client) -> Result<T> + Send + 'static,
    {
        let permit = tokio::time::timeout(self.acquire_timeout, self.permits.acquire())
            .await
            .map_err(|_| anyhow!("database pool acquire timeout"))??;
        let pool = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            let cached = pool.idle.lock().map_err(|_| anyhow!("pool lock"))?.pop();
            let mut client = match cached {
                Some(c) if !c.is_closed() => c,
                _ => pool.connect().context("database connect")?,
            };
            let out = f(&mut client);
            if !client.is_closed() {
                pool.idle
                    .lock()
                    .map_err(|_| anyhow!("pool lock"))?
                    .push(client);
            }
            out
        })
        .await
        .map_err(|e| anyhow!("database task: {e}"))?;
        drop(permit);
        result
    }

    /// `select 1` through the pool, for `/health`.
    pub async fn ping(self: &Arc<Self>) -> bool {
        self.with(|c| Ok(c.query_one("select 1", &[])?.get::<_, i32>(0) == 1))
            .await
            .unwrap_or(false)
    }
}
