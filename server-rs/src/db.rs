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
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::{Client, NoTls};
/// Bounded retry. Five attempts over roughly 1.5s covers a failover or a restart
/// without turning an outage into an unbounded reconnect storm.
const ATTEMPTS: u32 = 5;
const BACKOFF_MS: u64 = 50;
pub struct Pool {
    url: String,
    /// Bounds LIVE connections, not the idle list. Bounding only the idle list
    /// bounds nothing: every concurrent lease that finds the list empty opens
    /// another real backend, so N concurrent requests reach N backends whatever
    /// the configured maximum. A permit is held for the whole life of a lease.
    permits: Arc<Semaphore>,
    max: usize,
    /// How long a caller waits for a permit before the request fails. Without it
    /// a saturated pool turns into an unbounded queue behind the database.
    acquire_timeout: Duration,
    attempts: u32,
    idle: Mutex<Vec<Client>>,
    opened: AtomicU64,
    failed: AtomicU64,
    timeouts: AtomicU64,
}
pub struct Lease {
    client: Option<Client>,
    pool: Arc<Pool>,
    /// Released after the client is returned or discarded, never before.
    _permit: OwnedSemaphorePermit,
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
    pub async fn open(
        url: String,
        max: usize,
        acquire_timeout: Duration,
    ) -> Result<Arc<Self>, Error> {
        let pool = Self::new(url, max, acquire_timeout, ATTEMPTS);
        let client = pool.connect().await?;
        pool.idle.lock().expect("pool mutex").push(client);
        Ok(pool)
    }
    fn new(url: String, max: usize, acquire_timeout: Duration, attempts: u32) -> Arc<Self> {
        Arc::new(Self {
            url,
            permits: Arc::new(Semaphore::new(max)),
            max,
            acquire_timeout,
            attempts,
            idle: Mutex::new(Vec::new()),
            opened: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
        })
    }
    async fn connect(&self) -> Result<Client, Error> {
        let mut last: Option<Error> = None;
        for attempt in 0..self.attempts {
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
    /// Waits for a permit, then hands back a live client. Cancelling this future
    /// before it resolves releases the permit with it.
    pub async fn get(self: &Arc<Self>) -> Result<Lease, Error> {
        let permit =
            match tokio::time::timeout(self.acquire_timeout, self.permits.clone().acquire_owned())
                .await
            {
                Ok(permit) => permit?,
                Err(_) => {
                    self.timeouts.fetch_add(1, Ordering::Relaxed);
                    return Err(format!(
                        "no database connection available within {:?} (pool max {})",
                        self.acquire_timeout, self.max
                    )
                    .into());
                }
            };
        loop {
            let pooled = self.idle.lock().expect("pool mutex").pop();
            match pooled {
                Some(client) if !client.is_closed() => {
                    return Ok(Lease {
                        client: Some(client),
                        pool: self.clone(),
                        _permit: permit,
                    });
                }
                // Discard a dead pooled client and try the next one.
                Some(_) => continue,
                // A failed connect drops the permit with the error, so a database
                // outage cannot leak the pool away one request at a time.
                None => {
                    return Ok(Lease {
                        client: Some(self.connect().await?),
                        pool: self.clone(),
                        _permit: permit,
                    });
                }
            }
        }
    }
    /// The permit half of `get`, so the bound itself is testable without a server.
    #[cfg(test)]
    async fn permit(self: &Arc<Self>) -> Result<OwnedSemaphorePermit, Error> {
        match tokio::time::timeout(self.acquire_timeout, self.permits.clone().acquire_owned()).await
        {
            Ok(permit) => Ok(permit?),
            Err(_) => {
                self.timeouts.fetch_add(1, Ordering::Relaxed);
                Err("acquire timeout".into())
            }
        }
    }
    pub fn stats(&self) -> Stats {
        Stats {
            idle: self.idle.lock().expect("pool mutex").len(),
            live: self.max - self.permits.available_permits(),
            max: self.max,
            opened: self.opened.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            timeouts: self.timeouts.load(Ordering::Relaxed),
        }
    }
}
pub struct Stats {
    pub idle: usize,
    pub live: usize,
    pub max: usize,
    pub opened: u64,
    pub failed: u64,
    pub timeouts: u64,
}
#[cfg(test)]
mod tests {
    use super::*;
    // 127.0.0.1:1 refuses immediately, so a connect failure is fast and offline.
    const REFUSED: &str = "postgres://postgres@127.0.0.1:1/none";
    #[tokio::test]
    async fn the_bound_is_on_live_connections_not_the_idle_list() {
        let pool = Pool::new(REFUSED.into(), 1, Duration::from_millis(50), 1);
        let first = pool.permit().await.expect("first permit");
        assert_eq!(pool.stats().live, 1);
        // Before this change a second concurrent lease simply opened another real
        // backend, because `max` was only consulted when a client was returned.
        assert!(
            pool.permit().await.is_err(),
            "a second live lease must wait"
        );
        assert_eq!(pool.stats().timeouts, 1);
        drop(first);
        assert!(
            pool.permit().await.is_ok(),
            "the permit is released on drop"
        );
    }
    #[tokio::test]
    async fn a_failed_connect_releases_its_permit() {
        let pool = Pool::new(REFUSED.into(), 1, Duration::from_millis(50), 1);
        assert!(pool.get().await.is_err(), "connection refused");
        assert_eq!(
            pool.stats().live,
            0,
            "an outage must not leak the pool away"
        );
        assert!(pool.get().await.is_err());
        assert_eq!(pool.stats().failed, 2);
    }
    #[tokio::test]
    async fn a_cancelled_acquire_releases_its_permit() {
        let pool = Pool::new(REFUSED.into(), 1, Duration::from_secs(60), 1);
        let held = pool.permit().await.expect("permit");
        let waiter = pool.clone();
        let pending = tokio::spawn(async move { waiter.permit().await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(20)).await;
        pending.abort();
        let _ = pending.await;
        drop(held);
        assert_eq!(pool.stats().live, 0);
    }
}
