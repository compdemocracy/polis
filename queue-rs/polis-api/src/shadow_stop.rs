//! The shadow role's stop. On SIGTERM or SIGINT the shadow stops accepting
//! copies (`http::serve_until`) and waits for the observations it has begun to
//! print their own lines, at most [`BOUND`]. Each observation still in flight
//! then gets one `shadow_observation` line of its route, marked `stopped`,
//! whose `reason` says where it was ([`Stage`]), and the process prints one
//! `shadow_stopped` line with the counts. No copy it answered goes without a
//! line, and none gets two.
//!
//! The window. `docker stop`, Compose's `down` and the web deploy's teardown
//! (`scripts/after_install.sh`, `--profile rust-api down`, with no `-t`) give
//! each polis-api service Compose's default `stop_grace_period`, 10 s, before
//! SIGKILL: none of the three services sets one (docker-compose.yml). The
//! bound leaves 2.5 s of it: the runtime's half second for blocking work
//! (`crate::shutdown::RUNTIME_BOUND`), the lines, and the scheduling of a
//! container that has a quarter of a CPU (`cpus: 0.25`).
//!
//! What the bound keeps. A copy's line is printed after its read-back of what
//! Node stored: 2 s after the copy arrived, or, when Node's row is not there
//! yet, after a second look 10 s after it arrived
//! (`post_votes::observe::ReadbackTiming`; the comment observer the same). A
//! copy whose row is there at the first look is kept, whenever it arrived. A
//! copy whose row is not is kept when it arrived at least 2.5 s (10 s less the
//! bound) before the stop: with copies arriving evenly, three in four of those
//! in flight. The others are the stopped lines. A read lane's copy prints its
//! line as soon as its handler ends, inside the handler's own deadline.
//!
//! The wait holds no database connection of its own: it reads two counters
//! every 10 ms. An observation in flight holds only what it already held.
use crate::js::Js;
use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

/// The longest the shadow role waits, after the stop, for its observations.
pub(crate) const BOUND: Duration = Duration::from_millis(7500);
/// How often the wait reads the counters.
const POLL: Duration = Duration::from_millis(10);
/// The `outcome` of a stopped line.
pub(crate) const OUTCOME: &str = "stopped";

/// Where an observation was when the bound came: its stopped line's `reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    /// In the route's prelude and handler (admission, the next statement's
    /// selection, a read).
    Handler,
    /// Its handler ended; waiting for, or reading, the first look at what
    /// Node stored (and what follows it: the membership lookup, identity).
    Readback,
    /// The first look found nothing: waiting for the second, 10 s after the
    /// copy arrived.
    Retry,
}

impl Stage {
    pub(crate) const ALL: [Stage; 3] = [Stage::Handler, Stage::Readback, Stage::Retry];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Stage::Handler => "in_handler",
            Stage::Readback => "before_readback",
            Stage::Retry => "before_retry",
        }
    }

    /// The key that counts this stage on the `shadow_stopped` line.
    fn count_key(self) -> &'static str {
        match self {
            Stage::Handler => "inHandler",
            Stage::Readback => "beforeReadback",
            Stage::Retry => "beforeRetry",
        }
    }
}

/// Which route's line a copy gets, and what of the request its stopped line
/// may carry: the same request facts its shed line carries, nothing more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A vote copy: whether it carries a star and a language, and whether
    /// this process observes identity (its lines then carry the identity
    /// keys, each null on a stopped line).
    Votes { facts: (bool, bool), identity: bool },
    /// A comment copy: whether it carries a vote and a seed flag, and its
    /// body's size class.
    Comments {
        facts: (bool, bool),
        body_class: &'static str,
    },
    /// A copy of a read.
    Read(super::reads::Route),
}

/// An observation begun and not yet printed.
#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) kind: Kind,
    /// nginx's request id, when the copy carries a well-formed one.
    pub(crate) request_id: Option<String>,
    pub(crate) stage: Stage,
}

#[derive(Default)]
struct State {
    next: u64,
    entries: BTreeMap<u64, Entry>,
    /// The stop has begun: a line an observation prints from here is kept.
    stopping: bool,
    /// The stop has printed its lines: nothing more is registered.
    closed: bool,
    kept: u64,
}

/// The observations of one process, from the moment a copy is answered until
/// one line has been printed for it. Exactly one line: the observation's own,
/// or its stopped line, whichever claims the entry first.
pub(crate) struct Registry(Mutex<Option<State>>);

/// This process's observations.
pub(crate) static OBSERVATIONS: Registry = Registry::new();

impl Registry {
    pub(crate) const fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let mut held: MutexGuard<'_, Option<State>> =
            self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(held.get_or_insert_with(State::default))
    }

    /// Registers a copy that is about to be observed. `Err` once the stop has
    /// printed its lines: the copy is not observed, and the caller prints
    /// its stopped line at once.
    pub(crate) fn begin(
        &'static self,
        kind: Kind,
        request_id: Option<&str>,
    ) -> Result<Observation, Entry> {
        let entry = Entry {
            kind,
            request_id: request_id.map(str::to_owned),
            stage: Stage::Handler,
        };
        self.with(|state| {
            if state.closed {
                return Err(entry);
            }
            let id = state.next;
            state.next += 1;
            state.entries.insert(id, entry);
            Ok(Observation {
                registry: self,
                id,
                done: false,
            })
        })
    }

    /// Observations registered and not yet printed.
    pub(crate) fn in_flight(&self) -> usize {
        self.with(|state| state.entries.len())
    }

    /// The stop has begun.
    pub(crate) fn stopping(&self) {
        self.with(|state| state.stopping = true);
    }

    fn set(&self, id: u64, stage: Stage) {
        self.with(|state| {
            if let Some(entry) = state.entries.get_mut(&id) {
                entry.stage = stage;
            }
        });
    }

    /// Takes every observation still in flight, and how many printed their
    /// own line after the stop began. After this nothing is registered.
    pub(crate) fn close(&self) -> (Vec<Entry>, u64) {
        self.with(|state| {
            state.closed = true;
            let left = std::mem::take(&mut state.entries).into_values().collect();
            (left, state.kept)
        })
    }
}

/// One observation's place in its registry.
pub(crate) struct Observation {
    registry: &'static Registry,
    id: u64,
    done: bool,
}

impl Observation {
    pub(crate) fn stage(&self, stage: Stage) {
        self.registry.set(self.id, stage);
    }

    /// The right to print this copy's own line: false when the stop has
    /// already printed its stopped line instead.
    pub(crate) fn finish(mut self) -> bool {
        self.done = true;
        let (registry, id) = (self.registry, self.id);
        registry.with(|state| {
            let mine = state.entries.remove(&id).is_some();
            if mine && state.stopping {
                state.kept += 1;
            }
            mine
        })
    }

    /// What `scope` needs to name this observation to the read-backs.
    pub(crate) fn current(&self) -> Current {
        Current(self.registry, self.id)
    }
}

impl Drop for Observation {
    /// An observation that ends without a line of its own (it returned early,
    /// or panicked) leaves the registry, as before the stop existed.
    fn drop(&mut self) {
        if !self.done {
            let id = self.id;
            self.registry.with(|state| state.entries.remove(&id));
        }
    }
}

/// The observation a task runs, for the read-backs inside it.
#[derive(Clone, Copy)]
pub(crate) struct Current(&'static Registry, u64);

tokio::task_local! {
    static CURRENT: Current;
}

/// Runs an observation's task with its place known to the read-backs.
pub(crate) fn scope<F: std::future::Future>(
    current: Current,
    observation: F,
) -> impl std::future::Future<Output = F::Output> {
    CURRENT.scope(current, observation)
}

/// Called by a read-back as it starts waiting for its second look. Outside
/// an observation's task (a test that runs a read-back directly) nothing.
pub(crate) fn waiting_for_second_look() {
    let _ = CURRENT.try_with(|Current(registry, id)| registry.set(*id, Stage::Retry));
}

/// What the stop printed.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Stopped {
    pub(crate) kept: u64,
    pub(crate) stopped: Vec<Stage>,
    pub(crate) connections: usize,
}

/// Waits, once the stop has begun and the listener is closed, until no copy
/// is being read (`connections`) and no observation is in flight, at most
/// `bound`; then prints, through `print`, one stopped line for each
/// observation still in flight, and the `shadow_stopped` line.
pub(crate) async fn drain(
    registry: &'static Registry,
    bound: Duration,
    connections: impl Fn() -> usize,
    print: impl Fn(&Entry),
) -> Stopped {
    let started = tokio::time::Instant::now();
    while (connections() > 0 || registry.in_flight() > 0) && started.elapsed() < bound {
        tokio::time::sleep(POLL).await;
    }
    let connections = connections();
    let (left, kept) = registry.close();
    for entry in &left {
        print(entry);
    }
    let stopped: Vec<Stage> = left.iter().map(|entry| entry.stage).collect();
    let mut fields = vec![
        ("drained", Js::Bool(stopped.is_empty() && connections == 0)),
        ("ms", Js::Num(started.elapsed().as_millis() as f64)),
        ("boundMs", Js::Num(bound.as_millis() as f64)),
        ("kept", Js::Num(kept as f64)),
        ("stopped", Js::Num(stopped.len() as f64)),
    ];
    for stage in Stage::ALL {
        let n = stopped.iter().filter(|s| **s == stage).count();
        fields.push((stage.count_key(), Js::Num(n as f64)));
    }
    fields.push(("connections", Js::Num(connections as f64)));
    super::event("shadow_stopped", &fields);
    Stopped {
        kept,
        stopped,
        connections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
    };

    fn registry() -> &'static Registry {
        Box::leak(Box::new(Registry::new()))
    }

    const VOTE: Kind = Kind::Votes {
        facts: (false, false),
        identity: false,
    };

    /// SIGKILL comes 10 s after SIGTERM. The bound, the runtime's bound for
    /// blocking work and 2 s for the lines and scheduling fit inside it; and
    /// the bound is past the first look, so every copy whose row Node has
    /// stored by then is kept.
    #[test]
    fn the_bound_keeps_the_first_look_and_leaves_margin_in_the_window() {
        let window = Duration::from_secs(10);
        assert!(BOUND + crate::shutdown::RUNTIME_BOUND + Duration::from_secs(2) <= window);
        let timing = crate::post_votes::observe::ReadbackTiming::default();
        assert!(BOUND > timing.first + Duration::from_secs(1));
        // The share of the second look's copies in flight that is kept, with
        // copies arriving evenly: what the module's notes say.
        let kept = BOUND.as_secs_f64() / timing.retry.as_secs_f64();
        assert_eq!(kept, 0.75);
    }

    /// Exactly one line per observation: its own when it finishes before the
    /// stop takes it, the stop's otherwise; and after the stop has printed,
    /// a new copy is refused registration, so its caller prints its line.
    #[test]
    fn an_observation_gets_its_own_line_or_a_stopped_line_never_both() {
        let r = registry();
        let first = r.begin(VOTE, Some("a")).unwrap();
        let second = r.begin(VOTE, Some("b")).unwrap();
        let third = r.begin(VOTE, None).unwrap();
        third.stage(Stage::Retry);
        assert_eq!(r.in_flight(), 3);
        // Before the stop: its own line, not kept (the stop has not begun).
        assert!(first.finish());
        r.stopping();
        // After the stop began and before its bound: its own line, kept.
        assert!(second.finish());
        let (left, kept) = r.close();
        assert_eq!(kept, 1);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].stage, Stage::Retry);
        assert_eq!(left[0].request_id, None);
        // The stop printed its line: the observation's own is refused.
        assert!(!third.finish());
        let Err(late) = r.begin(VOTE, Some("late")) else {
            panic!("a copy registered after the stop printed its lines");
        };
        assert_eq!(late.request_id.as_deref(), Some("late"));
        assert_eq!(late.stage, Stage::Handler);
        assert_eq!(r.in_flight(), 0);
    }

    /// An observation that ends without printing (an early return, a panic)
    /// leaves no entry for the stop to print a line for.
    #[test]
    fn an_observation_dropped_without_a_line_leaves_nothing_behind() {
        let r = registry();
        let observation = r.begin(VOTE, Some("a")).unwrap();
        assert_eq!(r.in_flight(), 1);
        drop(observation);
        assert_eq!(r.in_flight(), 0);
        assert!(r.close().0.is_empty());
    }

    /// Many observations finishing on many threads while the stop takes what
    /// is left at a random moment: every observation is printed exactly once,
    /// by itself or by the stop.
    #[test]
    fn finishing_and_the_stop_racing_print_each_observation_once() {
        for round in 0..200u64 {
            let r = registry();
            let own = Arc::new(AtomicU64::new(0));
            let refused = Arc::new(AtomicU64::new(0));
            let go = Arc::new(AtomicBool::new(false));
            let threads: Vec<_> = (0..4)
                .map(|t| {
                    let (own, refused, go) = (own.clone(), refused.clone(), go.clone());
                    std::thread::spawn(move || {
                        let mine: Vec<_> =
                            (0..50).filter_map(|_| r.begin(VOTE, None).ok()).collect();
                        let begun = mine.len() as u64;
                        while !go.load(SeqCst) {
                            std::hint::spin_loop();
                        }
                        for (n, observation) in mine.into_iter().enumerate() {
                            if (n as u64 + t + round).is_multiple_of(7) {
                                std::thread::yield_now();
                            }
                            if observation.finish() {
                                own.fetch_add(1, SeqCst);
                            } else {
                                refused.fetch_add(1, SeqCst);
                            }
                        }
                        begun
                    })
                })
                .collect();
            // Every thread has registered its fifty before any finishes.
            while r.in_flight() < 200 {
                std::hint::spin_loop();
            }
            go.store(true, SeqCst);
            for _ in 0..(round % 50) {
                std::thread::yield_now();
            }
            let (left, _) = r.close();
            let begun: u64 = threads.into_iter().map(|t| t.join().unwrap()).sum();
            assert_eq!(begun, 200);
            assert_eq!(own.load(SeqCst) + left.len() as u64, 200, "round {round}");
            assert_eq!(refused.load(SeqCst), left.len() as u64, "round {round}");
        }
    }

    /// A read-back marks its observation as waiting for the second look, from
    /// inside the observation's task only.
    #[tokio::test]
    async fn a_read_back_marks_the_wait_for_its_second_look() {
        let r = registry();
        let observation = r.begin(VOTE, None).unwrap();
        observation.stage(Stage::Readback);
        // Outside the task: nothing happens.
        waiting_for_second_look();
        let current = observation.current();
        scope(current, async { waiting_for_second_look() }).await;
        let (left, _) = r.close();
        assert_eq!(left[0].stage, Stage::Retry);
        drop(observation);
    }

    /// The wait ends as soon as nothing is in flight, and prints nothing.
    #[tokio::test]
    async fn the_stop_ends_at_once_when_nothing_is_in_flight() {
        let r = registry();
        r.stopping();
        let started = tokio::time::Instant::now();
        let printed = std::sync::Mutex::new(vec![]);
        let stopped = drain(
            r,
            BOUND,
            || 0,
            |entry| printed.lock().unwrap().push(entry.stage),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(stopped, Stopped::default());
        assert!(printed.lock().unwrap().is_empty());
    }

    /// The wait keeps an observation that finishes inside the bound and
    /// prints a stopped line for one that does not, once, at the bound; and
    /// it waits for a copy still being read, which it counts if it is still
    /// being read at the bound.
    #[tokio::test]
    async fn the_stop_waits_its_bound_then_prints_one_line_for_each_left() {
        let r = registry();
        let quick = r.begin(VOTE, Some("quick")).unwrap();
        let slow = r.begin(VOTE, Some("slow")).unwrap();
        slow.stage(Stage::Retry);
        r.stopping();
        let finisher = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(quick.finish());
        });
        let printed = std::sync::Mutex::new(vec![]);
        let bound = Duration::from_millis(400);
        let started = tokio::time::Instant::now();
        let stopped = drain(
            r,
            bound,
            || 1,
            |entry| printed.lock().unwrap().push(entry.request_id.clone()),
        )
        .await;
        finisher.await.unwrap();
        assert!(started.elapsed() >= bound);
        assert_eq!(
            stopped,
            Stopped {
                kept: 1,
                stopped: vec![Stage::Retry],
                connections: 1,
            }
        );
        assert_eq!(*printed.lock().unwrap(), vec![Some("slow".to_owned())]);
        assert!(!slow.finish(), "the stop printed its line");
    }
}
