//! Stopping. `docker stop`, `docker compose down` and the web deploy send
//! SIGTERM and, 10 s later (Compose's default `stop_grace_period`, which no
//! polis-api service changes), SIGKILL. SIGTERM and SIGINT are handled alike.
//!
//! The process is PID 1 in its container, where a signal with no handler is
//! ignored, so the handlers are installed before any startup work.
//!
//! The main role then stops accepting connections, serves the ones the kernel
//! had already completed, and waits until nothing is in flight: no request
//! being read or answered, no dispatched write, no queued notification. A
//! write that has not been dispatched when the stop begins is not dispatched:
//! the request is handed back (502, marked for nginx to send it to Node). The
//! wait is bounded by [`DRAIN_BOUND`]; whatever is still running then is left,
//! and the line the process prints says how much. The shadow role writes
//! nothing and waits for nothing.
//!
//! Either way, blocking work still running when the process returns is waited
//! for at most [`RUNTIME_BOUND`], so a stop ends within about 5.5 s, inside the
//! 10 s window. The wait holds no database connection: it reads counters.
use anyhow::Result;
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    time::{Duration, Instant},
};
use tokio::signal::unix::{Signal, SignalKind, signal};

/// The longest the main role waits for work in flight. Above the writers' own
/// bounds on an answer (a vote is answered within 1.25 s of its arrival) and
/// on waiting for a connection (5 s), well inside the 10 s window.
pub(crate) const DRAIN_BOUND: Duration = Duration::from_secs(5);
/// The longest the process waits for blocking work still running once its
/// tasks are dropped.
pub(crate) const RUNTIME_BOUND: Duration = Duration::from_millis(500);
/// How often the drain reads the counters.
const POLL: Duration = Duration::from_millis(10);

static STOPPING: AtomicBool = AtomicBool::new(false);
static DISPATCHED: AtomicUsize = AtomicUsize::new(0);
/// Writes handed back because the process was stopping.
static HANDED_BACK: AtomicUsize = AtomicUsize::new(0);

/// SIGTERM and SIGINT, installed together.
pub(crate) struct Signals {
    terminate: Signal,
    interrupt: Signal,
}

impl Signals {
    pub(crate) fn install() -> Result<Self> {
        Ok(Self {
            terminate: signal(SignalKind::terminate())?,
            interrupt: signal(SignalKind::interrupt())?,
        })
    }

    /// The name of the first signal to arrive.
    pub(crate) async fn recv(&mut self) -> &'static str {
        tokio::select! {
            _ = self.terminate.recv() => "SIGTERM",
            _ = self.interrupt.recv() => "SIGINT",
        }
    }
}

/// The stop has begun: from here no write is dispatched.
pub(crate) fn stopping() {
    STOPPING.store(true, SeqCst);
}

/// A write whose dispatch has begun: held from just before the write is
/// spawned until it ends, however its caller fares.
pub(crate) struct Dispatched(());

impl Dispatched {
    /// None once the process is stopping: the caller hands the request back
    /// instead of dispatching it. The count is raised before the stop is
    /// read, and the stop is set before the count is read, so a drain that
    /// begins at the same moment either waits for this write or this request
    /// sees the stop.
    pub(crate) fn begin() -> Option<Self> {
        DISPATCHED.fetch_add(1, SeqCst);
        if STOPPING.load(SeqCst) {
            DISPATCHED.fetch_sub(1, SeqCst);
            HANDED_BACK.fetch_add(1, SeqCst);
            return None;
        }
        Some(Self(()))
    }
}

impl Drop for Dispatched {
    fn drop(&mut self) {
        DISPATCHED.fetch_sub(1, SeqCst);
    }
}

/// Dispatched writes not yet ended.
pub(crate) fn dispatched() -> usize {
    DISPATCHED.load(SeqCst)
}

/// What is in flight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Pending {
    /// Connections reading or answering a request (`http::in_progress`).
    pub(crate) requests: usize,
    /// Dispatched writes (votes, comments, waves).
    pub(crate) dispatches: usize,
    /// Notification work the vote and comment writers queued after a write.
    pub(crate) background: usize,
}

impl Pending {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Waits until `pending` reports nothing in flight, at most `bound`, and
/// prints what it left and how many writes the stop handed back. Call after
/// `stopping` and after the listener is closed, so the counts can only fall.
pub(crate) async fn drain(bound: Duration, pending: impl Fn() -> Pending) -> Pending {
    let started = Instant::now();
    let left = loop {
        let now = pending();
        if now.is_empty() || started.elapsed() >= bound {
            break now;
        }
        tokio::time::sleep(POLL).await;
    };
    eprintln!(
        "{{\"event\":\"polis_api_stopped\",\"drained\":{},\"ms\":{},\"boundMs\":{},\"requests\":{},\"dispatches\":{},\"background\":{},\"handedBack\":{}}}",
        left.is_empty(),
        started.elapsed().as_millis(),
        bound.as_millis(),
        left.requests,
        left.dispatches,
        left.background,
        HANDED_BACK.load(SeqCst)
    );
    left
}

#[cfg(test)]
mod tests {
    use super::*;

    // The process-wide stop is never set here: other tests in this binary
    // dispatch writes, and a stop would hand theirs back.

    #[test]
    fn the_stop_window_has_margin() {
        assert!(DRAIN_BOUND + RUNTIME_BOUND + Duration::from_secs(1) < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn the_drain_ends_when_nothing_is_in_flight_and_at_its_bound_otherwise() {
        let started = Instant::now();
        assert_eq!(
            drain(Duration::from_secs(5), Pending::default).await,
            Pending::default()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        let left = Pending {
            requests: 0,
            dispatches: 1,
            background: 0,
        };
        let started = Instant::now();
        assert_eq!(drain(Duration::from_millis(200), || left).await, left);
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[tokio::test]
    async fn the_drain_waits_for_work_that_ends() {
        let remaining = std::sync::Arc::new(AtomicUsize::new(3));
        let counted = remaining.clone();
        let left = drain(Duration::from_secs(5), move || Pending {
            requests: 0,
            dispatches: counted
                .fetch_update(SeqCst, SeqCst, |n| Some(n.saturating_sub(1)))
                .unwrap_or(0),
            background: 0,
        })
        .await;
        assert_eq!(left, Pending::default());
        assert_eq!(remaining.load(SeqCst), 0);
    }
}
