//! A connection pool with reconnect, replacing the single `tokio_postgres::Client`
//! whose connection task called `std::process::exit(1)` on any error. Node runs a
//! `pg` pool; a transient blip there is a reconnect, not a process death.
//!
//! Deliberately hand-rolled rather than pulled from a pool crate: the crate's
//! dependency set is pinned and reviewed, and the behaviour needed here is small.
use crate::Error;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio_postgres::{Client, NoTls};
/// Bounded retry. Five attempts over roughly 1.5s covers a failover or a restart
/// without turning an outage into an unbounded reconnect storm.
const ATTEMPTS: u32 = 5;
const BACKOFF_MS: u64 = 50;
pub struct Pool {
    url: String,
    max: usize,
    idle: Mutex<Vec<Client>>,
    opened: AtomicU64,
    failed: AtomicU64,
}
pub struct Lease {
    client: Option<Client>,
    pool: Arc<Pool>,
}
impl std::ops::Deref for Lease {
    type Target = Client;
    fn deref(&self) -> &Client {
        self.client
            .as_ref()
            .expect("lease holds a client until drop")
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            // A client whose connection task has ended is discarded, not pooled.
            if !client.is_closed() {
                let mut idle = self.pool.idle.lock().expect("pool mutex");
                if idle.len() < self.pool.max {
                    idle.push(client);
                }
            }
        }
    }
}
impl Pool {
    /// Opens one connection eagerly so a misconfigured URL fails at startup rather
    /// than on the first request.
    pub async fn open(url: String, max: usize) -> Result<Arc<Self>, Error> {
        let pool = Arc::new(Self {
            url,
            max,
            idle: Mutex::new(Vec::new()),
            opened: AtomicU64::new(0),
            failed: AtomicU64::new(0),
        });
        let client = pool.connect().await?;
        pool.idle.lock().expect("pool mutex").push(client);
        Ok(pool)
    }
    async fn connect(&self) -> Result<Client, Error> {
        let mut last: Option<Error> = None;
        for attempt in 0..ATTEMPTS {
            match tokio_postgres::connect(&self.url, NoTls).await {
                Ok((client, connection)) => {
                    self.opened.fetch_add(1, Ordering::Relaxed);
                    tokio::spawn(async move {
                        // Ending this task marks the client closed; the pool then
                        // discards it and opens a replacement on the next lease.
                        if let Err(e) = connection.await {
                            eprintln!(
                                "{}",
                                serde_json::json!({
                                    "event": "pg_connection_lost",
                                    "detail": e.to_string(),
                                })
                            );
                        }
                    });
                    return Ok(client);
                }
                Err(e) => {
                    self.failed.fetch_add(1, Ordering::Relaxed);
                    last = Some(e.into());
                    tokio::time::sleep(Duration::from_millis(BACKOFF_MS << attempt)).await;
                }
            }
        }
        Err(last.unwrap_or_else(|| "no connection attempt was made".into()))
    }
    pub async fn get(self: &Arc<Self>) -> Result<Lease, Error> {
        loop {
            let pooled = self.idle.lock().expect("pool mutex").pop();
            match pooled {
                Some(client) if !client.is_closed() => {
                    return Ok(Lease {
                        client: Some(client),
                        pool: self.clone(),
                    });
                }
                // Discard a dead pooled client and try the next one.
                Some(_) => continue,
                None => {
                    return Ok(Lease {
                        client: Some(self.connect().await?),
                        pool: self.clone(),
                    });
                }
            }
        }
    }
    pub fn stats(&self) -> (usize, u64, u64) {
        (
            self.idle.lock().expect("pool mutex").len(),
            self.opened.load(Ordering::Relaxed),
            self.failed.load(Ordering::Relaxed),
        )
    }
}
