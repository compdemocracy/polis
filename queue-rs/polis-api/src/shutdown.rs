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
//! nothing; it waits, on its own bound, for its observations to print their
//! lines (`shadow::stop`).
//!
//! Either way, blocking work still running when the process returns is waited
//! for at most [`RUNTIME_BOUND`], so a stop ends inside the 10 s window. The
//! wait holds no database connection: it reads counters.
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

/// A process's stop: whether it has begun, the writes dispatched and not yet
/// ended, and the writes handed back because it had begun. The process has
/// one ([`stopping`], [`dispatched`]); a test holds its own, so that it can
/// stop without stopping the other tests in its process.
pub(crate) struct Stop {
    stopping: AtomicBool,
    dispatched: AtomicUsize,
    handed_back: AtomicUsize,
    /// A test's pause between a dispatch's count and its read of the stop.
    #[cfg(test)]
    pause: race_tests::Pause,
}

/// The process's stop.
static PROCESS: Stop = Stop::new();

impl Stop {
    const fn new() -> Self {
        Self {
            stopping: AtomicBool::new(false),
            dispatched: AtomicUsize::new(0),
            handed_back: AtomicUsize::new(0),
            #[cfg(test)]
            pause: race_tests::Pause::new(),
        }
    }

    /// A stop of a test's own.
    #[cfg(test)]
    pub(crate) fn for_test() -> &'static Self {
        Box::leak(Box::new(Self::new()))
    }

    /// The stop has begun: from here no write is dispatched.
    pub(crate) fn stop(&self) {
        self.stopping.store(true, SeqCst);
    }

    /// None once the stop has begun: the caller hands the request back
    /// instead of dispatching it. The count is raised before the stop is
    /// read, and the stop is set before the count is read, so a drain that
    /// begins at the same moment either waits for this write or this request
    /// sees the stop.
    fn begin(&'static self) -> Option<Dispatched> {
        self.dispatched.fetch_add(1, SeqCst);
        #[cfg(test)]
        self.pause.between_count_and_stop();
        if self.stopping.load(SeqCst) {
            self.dispatched.fetch_sub(1, SeqCst);
            self.handed_back.fetch_add(1, SeqCst);
            return None;
        }
        Some(Dispatched(self))
    }

    /// Dispatched writes not yet ended.
    pub(crate) fn dispatched(&self) -> usize {
        self.dispatched.load(SeqCst)
    }

    /// Writes handed back because the stop had begun.
    pub(crate) fn handed_back(&self) -> usize {
        self.handed_back.load(SeqCst)
    }
}

#[cfg(test)]
tokio::task_local! {
    static SCOPED: &'static Stop;
}

/// Runs `work` with `stop` in place of the process's: the writes it begins
/// are counted, and handed back, by the test's own stop.
#[cfg(test)]
pub(crate) fn scoped<F: std::future::Future>(
    stop: &'static Stop,
    work: F,
) -> impl std::future::Future<Output = F::Output> {
    SCOPED.scope(stop, work)
}

/// The stop a write begins under: the process's, or in a test that asked
/// for it, the test's own.
fn current() -> &'static Stop {
    #[cfg(test)]
    if let Ok(stop) = SCOPED.try_with(|stop| *stop) {
        return stop;
    }
    &PROCESS
}

/// The process's stop has begun: from here no write is dispatched.
pub(crate) fn stopping() {
    PROCESS.stop();
}

/// A write whose dispatch has begun: held from just before the write is
/// spawned until it ends, however its caller fares.
pub(crate) struct Dispatched(&'static Stop);

impl Dispatched {
    /// None once the process is stopping: the caller hands the request back
    /// instead of dispatching it (see `Stop::begin`).
    pub(crate) fn begin() -> Option<Self> {
        current().begin()
    }
}

impl Drop for Dispatched {
    fn drop(&mut self) {
        self.0.dispatched.fetch_sub(1, SeqCst);
    }
}

/// The process's dispatched writes not yet ended.
pub(crate) fn dispatched() -> usize {
    PROCESS.dispatched()
}

/// What is in flight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Pending {
    /// Connections reading or answering a request (`http::in_progress`).
    pub(crate) requests: usize,
    /// Dispatched writes (votes, comments, waves, Treevite acceptances and
    /// logins, topic selections).
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
        PROCESS.handed_back()
    );
    left
}

#[cfg(test)]
mod tests {
    use super::*;

    // The process's stop is never set here: other tests in this binary
    // dispatch writes, and a stop would hand theirs back. A test that stops
    // holds a stop of its own (`Stop::for_test`, `scoped`, `race_tests`).

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

    /// A write begun inside `scoped` is counted and handed back by the test's
    /// stop, and the process's stop is untouched.
    #[tokio::test]
    async fn a_scoped_stop_counts_and_hands_back_its_own_writes_only() {
        let stop = Stop::for_test();
        let process_before = PROCESS.handed_back();
        let held = scoped(stop, async { Dispatched::begin() }).await;
        assert!(held.is_some());
        assert_eq!(stop.dispatched(), 1);
        drop(held);
        assert_eq!(stop.dispatched(), 0);
        stop.stop();
        assert!(scoped(stop, async { Dispatched::begin() }).await.is_none());
        assert_eq!(stop.handed_back(), 1);
        assert_eq!(stop.dispatched(), 0);
        assert!(!PROCESS.stopping.load(SeqCst));
        assert_eq!(PROCESS.handed_back(), process_before);
    }
}

/// The stop and a dispatch raced on purpose, with a pause or a random spin
/// forced between a dispatch's count and its read of the stop (the
/// independent review's forced-interleaving tests). Each test holds a stop of
/// its own, so it runs beside every other test.
#[cfg(test)]
pub(crate) mod race_tests {
    use super::*;
    use std::sync::{Condvar, Mutex, atomic::AtomicU64, mpsc};

    /// A stop's pause: armed, the next dispatch that has raised the count
    /// waits there until it is released; spinning, every dispatch spins a
    /// random while there.
    pub(crate) struct Pause {
        /// 0: no pause; 1: armed; 2: paused (counted, stop not yet read);
        /// 3: released.
        step: Mutex<u8>,
        changed: Condvar,
        armed: AtomicBool,
        spin: AtomicBool,
    }

    impl Pause {
        pub(super) const fn new() -> Self {
            Self {
                step: Mutex::new(0),
                changed: Condvar::new(),
                armed: AtomicBool::new(false),
                spin: AtomicBool::new(false),
            }
        }

        pub(super) fn between_count_and_stop(&self) {
            if self.spin.load(SeqCst) {
                spin(xorshift() % 400);
            }
            if !self.armed.load(SeqCst) {
                return;
            }
            let mut g = self.step.lock().unwrap_or_else(|e| e.into_inner());
            if *g != 1 {
                return;
            }
            *g = 2;
            self.changed.notify_all();
            while *g != 3 {
                g = self.changed.wait(g).unwrap_or_else(|e| e.into_inner());
            }
            *g = 0;
            self.armed.store(false, SeqCst);
            self.changed.notify_all();
        }

        fn arm(&self) {
            *self.step.lock().unwrap() = 1;
            self.armed.store(true, SeqCst);
        }

        fn set(&self, v: u8) {
            *self.step.lock().unwrap() = v;
            self.changed.notify_all();
        }

        fn wait_for(&self, v: u8) {
            let mut g = self.step.lock().unwrap();
            while *g != v {
                g = self.changed.wait(g).unwrap();
            }
        }
    }

    fn xorshift() -> u64 {
        thread_local!(static STATE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) });
        STATE.with(|s| {
            let mut x = s.get();
            if x == 0 {
                x = (std::ptr::addr_of!(*s) as u64) ^ 0x9e37_79b9_7f4a_7c15;
            }
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            s.set(x);
            x
        })
    }

    fn spin(n: u64) {
        for _ in 0..n {
            std::hint::spin_loop();
        }
    }

    fn pending(stop: &'static Stop) -> impl Fn() -> Pending {
        move || Pending {
            requests: 0,
            dispatches: stop.dispatched(),
            background: 0,
        }
    }

    fn drain_now(stop: &'static Stop, bound: Duration) -> (Pending, Duration) {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let started = Instant::now();
        let left = rt.block_on(drain(bound, pending(stop)));
        (left, started.elapsed())
    }

    /// A dispatch has raised the count and is paused before it reads the
    /// stop; the stop is set; the drain begins. The drain waits, and the
    /// paused request, once released, reads the stop and is handed back:
    /// never dispatched.
    #[test]
    fn paused_after_the_count_the_drain_waits_and_the_request_is_handed_back() {
        let stop = Stop::for_test();
        stop.pause.arm();
        let request = std::thread::spawn(move || stop.begin().is_some());
        stop.pause.wait_for(2);
        stop.stop();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            stop.pause.set(3);
        });
        let (left, waited) = drain_now(stop, Duration::from_secs(3));
        let dispatched = request.join().unwrap();
        releaser.join().unwrap();
        assert_eq!(left, Pending::default());
        assert!(
            waited >= Duration::from_millis(300),
            "the drain ended while a counted request had not read the stop: {waited:?}"
        );
        assert!(
            !dispatched,
            "a request that read the stop after it was set was dispatched"
        );
        assert_eq!(stop.handed_back(), 1);
        assert_eq!(stop.dispatched(), 0);
    }

    /// The other order: the paused request reads the stop before it is set,
    /// so it is dispatched; the stop then begins while it runs. The drain
    /// waits for it to end.
    #[test]
    fn read_before_the_stop_the_dispatch_runs_and_the_drain_waits_for_it() {
        let stop = Stop::for_test();
        stop.pause.arm();
        let (started_tx, started_rx) = mpsc::channel();
        let (end_tx, end_rx) = mpsc::channel::<()>();
        let request = std::thread::spawn(move || {
            let dispatch = stop.begin();
            started_tx.send(dispatch.is_some()).unwrap();
            end_rx.recv().unwrap();
            drop(dispatch);
        });
        stop.pause.wait_for(2);
        stop.pause.set(3);
        assert!(
            started_rx.recv().unwrap(),
            "read before the stop, it must dispatch"
        );
        stop.stop();
        let ender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            end_tx.send(()).unwrap();
        });
        let (left, waited) = drain_now(stop, Duration::from_secs(3));
        request.join().unwrap();
        ender.join().unwrap();
        assert_eq!(left, Pending::default());
        assert!(waited >= Duration::from_millis(300), "{waited:?}");
        assert_eq!(stop.handed_back(), 0);
    }

    /// The harness can see the defect the real order prevents: the same
    /// pause with the two steps swapped (read the stop, then count) lets the
    /// drain read zero and end at once, and the paused request then
    /// dispatches after the drain has ended.
    #[test]
    fn the_swapped_order_lets_a_dispatch_start_after_the_drain_ended() {
        fn swapped(stop: &'static Stop) -> Option<Dispatched> {
            if stop.stopping.load(SeqCst) {
                return None;
            }
            stop.pause.between_count_and_stop();
            stop.dispatched.fetch_add(1, SeqCst);
            Some(Dispatched(stop))
        }
        let stop = Stop::for_test();
        stop.pause.arm();
        let request = std::thread::spawn(move || swapped(stop).is_some());
        stop.pause.wait_for(2);
        stop.stop();
        let (left, waited) = drain_now(stop, Duration::from_secs(3));
        stop.pause.set(3);
        let dispatched = request.join().unwrap();
        assert_eq!(left, Pending::default());
        assert!(waited < Duration::from_millis(100), "{waited:?}");
        assert!(dispatched, "the swapped order dispatches after the drain");
    }

    /// Many requests racing many stops, with a random spin between the count
    /// and the read: after the drain returns (it read zero after the stop),
    /// no dispatch may be alive or begin. `RACE_ROUNDS` and `RACE_THREADS`
    /// raise the default 200 rounds of 4 threads.
    #[test]
    fn no_dispatch_is_alive_or_begins_after_the_drain_returns_under_stress() {
        let env = |name: &str, default: u64| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        };
        let (rounds, threads) = (env("RACE_ROUNDS", 200), env("RACE_THREADS", 4));
        let violations = std::sync::Arc::new(AtomicU64::new(0));
        let dispatches = std::sync::Arc::new(AtomicU64::new(0));
        let backs = std::sync::Arc::new(AtomicU64::new(0));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut bounded = 0;
        for _ in 0..rounds {
            let stop = Stop::for_test();
            stop.pause.spin.store(true, SeqCst);
            let drained = std::sync::Arc::new(AtomicBool::new(false));
            let workers: Vec<_> = (0..threads)
                .map(|_| {
                    let (drained, violations, dispatches, backs) = (
                        drained.clone(),
                        violations.clone(),
                        dispatches.clone(),
                        backs.clone(),
                    );
                    std::thread::spawn(move || {
                        // Requests arrive until one is handed back: after the
                        // stop, each worker makes exactly one more attempt.
                        loop {
                            match stop.begin() {
                                Some(dispatch) => {
                                    if drained.load(SeqCst) {
                                        violations.fetch_add(1, SeqCst);
                                    }
                                    spin(xorshift() % 2000);
                                    if drained.load(SeqCst) {
                                        violations.fetch_add(1, SeqCst);
                                    }
                                    drop(dispatch);
                                    dispatches.fetch_add(1, SeqCst);
                                }
                                None => {
                                    backs.fetch_add(1, SeqCst);
                                    break;
                                }
                            }
                        }
                    })
                })
                .collect();
            std::thread::sleep(Duration::from_micros(xorshift() % 2000));
            stop.stop();
            let left = rt.block_on(drain(Duration::from_secs(2), pending(stop)));
            drained.store(true, SeqCst);
            if left != Pending::default() {
                bounded += 1;
            }
            for w in workers {
                w.join().unwrap();
            }
        }
        eprintln!(
            "RACE stress: {rounds} rounds x {threads} threads: dispatches {} hand-backs {} drains at bound {bounded} violations {}",
            dispatches.load(SeqCst),
            backs.load(SeqCst),
            violations.load(SeqCst)
        );
        assert_eq!(backs.load(SeqCst), rounds * threads);
        assert_eq!(bounded, 0);
        assert_eq!(violations.load(SeqCst), 0);
    }
}
