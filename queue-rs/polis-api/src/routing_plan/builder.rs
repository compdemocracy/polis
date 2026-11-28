//! The build scheduler: which conversation's plan is built next, when, and
//! on which thread.
//!
//! - **Its own OS threads.** Each builder is a `std::thread` of its own, one
//!   per [`Build`] it is given (at most [`MAX_BUILDERS`]); never the async
//!   runtime's blocking pool and never a request's task.
//! - **The request never waits.** A request's only touch point is
//!   [`Requests::request`]: one `try_send` on a bounded
//!   `std::sync::mpsc::sync_channel`. A full channel drops the request and
//!   counts it; the conversation's next request enqueues again. The request
//!   side takes no lock. No builder ever blocks receiving on that channel
//!   (builders only `try_recv`, and wait on their own condition variable),
//!   so a sender never finds a receiver to wake, which is the one case in
//!   which the standard channel's `try_send` takes its internal lock.
//! - **Coalescing on the builder side.** Builders drain the channel into a
//!   bounded pending map keyed by conversation, environment and
//!   configuration digest, keeping the newest tick asked for.
//! - **Rate.** After each build, the conversation is not built again before
//!   `factor` times that build's measured cost has passed (`factor` at
//!   least [`MIN_INTERVAL_FACTOR`]), plus up to a quarter more of jitter.
//!   The interval runs from the end of the last build and is never reset by
//!   newer ticks: ticks that arrive inside it coalesce, and when it passes
//!   the newest is built. So updates at one a second neither rebuild
//!   continuously nor postpone a rebuild indefinitely.
//! - **Fairness.** Pending conversations are taken round-robin, oldest
//!   waiting first; a conversation just built goes to the back.
//! - **One build in flight per conversation.**
//! - **Failures** pace re-reads with the cache's capped, jittered backoff
//!   (`retry_delay_ns`). A stored result refused for its content is not read
//!   again for the same tick until that backoff passes; a newer tick may be
//!   read as soon as the rate allows.
//! - **Panics** in a build are caught at the thread's top, counted, and the
//!   thread goes on; the conversation's permit is returned in a `Drop`, and the
//!   build's reservations by their own `Drop`.
//! - **Reclamation.** Between builds and while idle, builders destroy the
//!   cache's retired plans that nothing borrows.
//! - **Outcomes are matched to their jobs.** A builder runs its build on its
//!   own thread and takes the return value; each report carries the
//!   conversation, environment, tick and configuration it was for.
//!
//! Every time is read from a [`Clock`], so tests step it by hand. Nothing
//! here is written anywhere but memory; losing it loses only pacing, which
//! starts again from the next request. Dormant: nothing in this crate starts
//! a scheduler.

use super::cache::{Reserved, RoutingPlanCache, Settings};
use super::load::{Job, Loader, NoHooks, Outcome};
use polis_routing_plan::{Monotonic, Rejection, RuleConfig, retry_delay_ns};
use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, TryLockError};
use std::thread::JoinHandle;
use std::time::Duration;

/// The most builder threads one process may run.
pub(crate) const MAX_BUILDERS: usize = 4;
/// The builder threads a process runs unless configured otherwise.
pub(crate) const DEFAULT_BUILDERS: usize = 1;
/// The smallest factor the rebuild interval may be set to.
pub(crate) const MIN_INTERVAL_FACTOR: u32 = 10;
/// The request channel's capacity unless configured otherwise.
pub(crate) const REQUEST_SLOTS: usize = 256;
/// The largest request channel capacity accepted.
pub(crate) const MAX_REQUEST_SLOTS: usize = 4096;
/// Distinct (conversation, environment, configuration) entries waiting to
/// be built. A request for a new entry when the map is full is dropped and
/// counted; the conversation's next request enqueues again.
pub(crate) const PENDING_ENTRIES: usize = 1024;
/// Conversations whose pacing (last cost, interval, backoff) is remembered.
/// When full, the least recently built conversation that is neither waiting
/// nor building is forgotten: it may then be built sooner, never later.
pub(crate) const PACE_ENTRIES: usize = 4096;
/// The longest an idle builder waits before it looks for requests again.
pub(crate) const IDLE_WAIT: Duration = Duration::from_millis(50);
/// Build reports that may wait unread before one is dropped and counted.
pub(crate) const REPORT_SLOTS: usize = 64;

/// The configuration a build is made under, captured when the request is
/// made: the digest, the parsed rule, its canonical text and its count
/// policy. A builder never relabels an old request with current settings.
#[derive(Debug, PartialEq)]
pub(crate) struct BuildConfig {
    pub(crate) digest: [u8; 32],
    pub(crate) rule: RuleConfig,
    pub(crate) rule_plain: String,
    pub(crate) policy: Option<String>,
}

impl BuildConfig {
    /// The build's view of `settings`, made once per configuration (not per
    /// request): a request clones the `Arc`.
    pub(crate) fn of(settings: &Settings) -> Arc<Self> {
        Arc::new(Self {
            digest: settings.digest(),
            rule: settings.rule,
            rule_plain: settings.rule.to_plain(),
            policy: settings.count_policy.clone(),
        })
    }
}

/// One request for a conversation's plan. Cloning its `Arc`s allocates
/// nothing, so a request can make one without allocating.
#[derive(Clone, Debug)]
pub(crate) struct BuildRequest {
    pub(crate) zid: i32,
    pub(crate) env: Arc<str>,
    /// The newest math tick the request saw; `None` if it read none.
    pub(crate) desired_tick: Option<i64>,
    pub(crate) config: Arc<BuildConfig>,
}

/// What [`Requests::request`] did. It never waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Enqueued {
    Queued,
    /// The channel was full: dropped and counted.
    Dropped,
    /// The scheduler has shut down.
    Closed,
}

/// One build: runs a job into the cache and says how it ended. The loader is
/// the one used outside tests.
pub(crate) trait Build: Send {
    fn build(&mut self, cache: &Arc<RoutingPlanCache>, job: &Job) -> Outcome;
    /// After a panic in `build`: drop anything that may be half used (the
    /// loader's connection).
    fn reset(&mut self) {}
}

impl Build for Loader {
    fn build(&mut self, cache: &Arc<RoutingPlanCache>, job: &Job) -> Outcome {
        self.load(cache, job, &mut NoHooks)
    }
    fn reset(&mut self) {
        self.close();
    }
}

/// The scheduler's time and jitter. Outside tests, the cache's monotonic
/// clock (never the wall clock) and a random jitter.
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> Monotonic;
    /// A jitter in thousandths, 0 to 1000.
    fn jitter_permille(&self) -> u16;
}

/// The cache's own clock, so a plan and its pacing read one clock.
pub(crate) struct CacheClock(pub(crate) Arc<RoutingPlanCache>);

impl Clock for CacheClock {
    fn now(&self) -> Monotonic {
        self.0.reading()
    }
    fn jitter_permille(&self) -> u16 {
        rand::random::<u16>() % 1001
    }
}

/// How one build ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuildResult {
    Loaded(Outcome),
    /// The build panicked; the panic was caught and counted.
    Panicked,
}

/// A build's report: what it was for, and how it ended.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Finished {
    pub(crate) zid: i32,
    pub(crate) env: Arc<str>,
    pub(crate) desired_tick: Option<i64>,
    pub(crate) config_digest: [u8; 32],
    pub(crate) result: BuildResult,
}

// ---- The schedule: a pure state machine, every time an argument ----

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Conversation {
    zid: i32,
    env: Arc<str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PendingKey {
    conversation: Conversation,
    digest: [u8; 32],
}

#[derive(Debug)]
struct Wanted {
    desired_tick: Option<i64>,
    config: Arc<BuildConfig>,
}

#[derive(Debug)]
struct Pace {
    in_flight: bool,
    /// The last admitted build's measured cost.
    cost_ns: u64,
    /// Not built again before this (the rebuild interval).
    interval_at: Monotonic,
    /// Consecutive failures, for the backoff.
    failures: u32,
    /// After a failure: not built again before this.
    retry_at: Option<Monotonic>,
    /// After a failure that belongs to the tick read (the content was
    /// refused): a request for a tick newer than this lifts the backoff.
    lift_above: Option<i64>,
    /// After a failure that belongs to the configuration (the build was
    /// refused): a request under another configuration lifts the backoff.
    held_digest: Option<[u8; 32]>,
    /// When it was last built, for forgetting the oldest.
    stamp: u64,
}

impl Pace {
    fn new() -> Self {
        Self {
            in_flight: false,
            cost_ns: 0,
            interval_at: Monotonic::from_nanos(0),
            failures: 0,
            retry_at: None,
            lift_above: None,
            held_digest: None,
            stamp: 0,
        }
    }

    /// When a request for `tick` under configuration `digest` may be built;
    /// `None` while in flight.
    fn eligible_at(&self, tick: Option<i64>, digest: &[u8; 32]) -> Option<Monotonic> {
        if self.in_flight {
            return None;
        }
        let newer = matches!((self.lift_above, tick), (Some(held), Some(t)) if t > held);
        let other_config = self.held_digest.is_some_and(|held| held != *digest);
        let lifted = newer || other_config;
        Some(match self.retry_at {
            Some(retry) if !lifted => retry.max(self.interval_at),
            _ => self.interval_at,
        })
    }
}

/// What [`Schedule::offer`] did with a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Offered {
    /// A new pending entry, at the back of the round.
    Queued,
    /// Folded into the entry already waiting (its tick kept if newer).
    Coalesced,
    /// The pending map is full: dropped and counted.
    Dropped,
}

/// A build taken from the schedule: the job and what it is for. It must be
/// handed back to [`Schedule::finish`].
#[derive(Debug)]
pub(crate) struct Ticket {
    key: PendingKey,
    desired_tick: Option<i64>,
    pub(crate) job: Job,
}

impl Ticket {
    pub(crate) fn zid(&self) -> i32 {
        self.key.conversation.zid
    }
    pub(crate) fn desired_tick(&self) -> Option<i64> {
        self.desired_tick
    }
    fn report(&self, result: BuildResult) -> Finished {
        Finished {
            zid: self.key.conversation.zid,
            env: self.key.conversation.env.clone(),
            desired_tick: self.desired_tick,
            config_digest: self.key.digest,
            result,
        }
    }
}

#[derive(Debug)]
pub(crate) enum Next {
    Build(Box<Ticket>),
    /// Nothing can be built now; the earliest moment something can, if any
    /// waiting entry is not in flight.
    Wait(Option<Monotonic>),
}

/// The pure schedule: pending requests, the round, and each conversation's
/// pacing. No lock, thread, clock or randomness: times and jitter are
/// arguments.
#[derive(Debug)]
pub(crate) struct Schedule {
    factor: u32,
    pending: HashMap<PendingKey, Wanted>,
    round: VecDeque<PendingKey>,
    paces: HashMap<Conversation, Pace>,
    stamp: u64,
}

impl Schedule {
    /// `factor`: the rebuild interval in multiples of the last build's cost;
    /// raised to [`MIN_INTERVAL_FACTOR`] if lower. Every table is allocated
    /// here, at its bound, so offering and building allocate nothing in it.
    pub(crate) fn new(factor: u32) -> Self {
        Self {
            factor: factor.max(MIN_INTERVAL_FACTOR),
            pending: HashMap::with_capacity(PENDING_ENTRIES),
            round: VecDeque::with_capacity(PENDING_ENTRIES),
            paces: HashMap::with_capacity(PACE_ENTRIES),
            stamp: 0,
        }
    }

    /// A bound on what the tables hold at their capacity: each entry twice
    /// (the hash tables' spare buckets), with its control bytes.
    pub(crate) fn charge() -> u64 {
        let pending = size_of::<(PendingKey, Wanted)>() + 1;
        let round = size_of::<PendingKey>();
        let pace = size_of::<(Conversation, Pace)>() + 1;
        (2 * (PENDING_ENTRIES * pending + PACE_ENTRIES * pace) + PENDING_ENTRIES * round) as u64
            + 4096
    }

    /// Entries waiting to be built.
    pub(crate) fn pending(&self) -> usize {
        self.pending.len()
    }

    /// Takes a request in: a new entry at the back of the round, or folded
    /// into the one waiting for the same conversation, environment and
    /// configuration, keeping the newest tick (a request that saw no tick
    /// never lowers one).
    pub(crate) fn offer(&mut self, request: BuildRequest) -> Offered {
        let key = PendingKey {
            conversation: Conversation {
                zid: request.zid,
                env: request.env,
            },
            digest: request.config.digest,
        };
        if let Some(wanted) = self.pending.get_mut(&key) {
            wanted.desired_tick = wanted.desired_tick.max(request.desired_tick);
            return Offered::Coalesced;
        }
        if self.pending.len() >= PENDING_ENTRIES {
            return Offered::Dropped;
        }
        self.round.push_back(key.clone());
        self.pending.insert(
            key,
            Wanted {
                desired_tick: request.desired_tick,
                config: request.config,
            },
        );
        Offered::Queued
    }

    /// The next build at `now`: the first entry in the round that is not in
    /// flight and whose interval and backoff have passed. It is taken out
    /// of the round and its conversation marked in flight.
    pub(crate) fn next(&mut self, now: Monotonic) -> Next {
        let mut earliest: Option<Monotonic> = None;
        let mut chosen = None;
        for (i, key) in self.round.iter().enumerate() {
            let tick = self.pending.get(key).and_then(|w| w.desired_tick);
            let at = match self.paces.get(&key.conversation) {
                None => Some(Monotonic::from_nanos(0)),
                Some(pace) => pace.eligible_at(tick, &key.digest),
            };
            match at {
                Some(at) if at <= now => {
                    chosen = Some(i);
                    break;
                }
                Some(at) => earliest = Some(earliest.map_or(at, |e| e.min(at))),
                None => {}
            }
        }
        let Some(i) = chosen else {
            return Next::Wait(earliest);
        };
        let Some(key) = self.round.remove(i) else {
            return Next::Wait(earliest);
        };
        let Some(wanted) = self.pending.remove(&key) else {
            return Next::Wait(earliest);
        };
        self.make_room_for(&key.conversation);
        self.stamp += 1;
        let pace = self
            .paces
            .entry(key.conversation.clone())
            .or_insert_with(Pace::new);
        pace.in_flight = true;
        pace.stamp = self.stamp;
        let config = &wanted.config;
        let job = Job {
            zid: key.conversation.zid,
            math_env: key.conversation.env.as_ref().to_owned(),
            // A request that saw no tick keys its failures under -1, below
            // every stored tick.
            desired_tick: wanted.desired_tick.unwrap_or(-1),
            rule: config.rule,
            rule_plain: config.rule_plain.clone(),
            policy: config.policy.clone(),
            config_digest: config.digest,
        };
        Next::Build(Box::new(Ticket {
            key,
            desired_tick: wanted.desired_tick,
            job,
        }))
    }

    /// Keeps the pace table within its bound: forgets the least recently
    /// built conversation that is neither in flight nor waiting.
    fn make_room_for(&mut self, conversation: &Conversation) {
        if self.paces.len() < PACE_ENTRIES || self.paces.contains_key(conversation) {
            return;
        }
        let waiting = |c: &Conversation| self.round.iter().any(|k| &k.conversation == c);
        let oldest = self
            .paces
            .iter()
            .filter(|(c, p)| !p.in_flight && !waiting(c))
            .min_by_key(|(_, p)| p.stamp)
            .map(|(c, _)| c.clone());
        if let Some(c) = oldest {
            self.paces.remove(&c);
        }
    }

    /// The build of `ticket` ran from `started` to `ended` and ended in
    /// `result`: the conversation's permit is returned, its interval set from
    /// the measured cost (when the build was admitted), and a failure paced.
    pub(crate) fn finish(
        &mut self,
        ticket: &Ticket,
        result: BuildResult,
        started: Monotonic,
        ended: Monotonic,
        jitter_permille: u16,
    ) {
        let Some(pace) = self.paces.get_mut(&ticket.key.conversation) else {
            return;
        };
        pace.in_flight = false;
        let pacing = Pacing::of(result);
        if pacing.admitted {
            pace.cost_ns = ended.since(started);
        }
        let interval = pace.cost_ns.saturating_mul(u64::from(self.factor));
        let jitter = (interval / 4).saturating_mul(u64::from(jitter_permille.min(1000))) / 1000;
        pace.interval_at = plus(ended, interval.saturating_add(jitter));
        if pacing.failed {
            pace.failures = pace.failures.saturating_add(1);
            pace.retry_at = Some(plus(ended, retry_delay_ns(pace.failures, jitter_permille)));
            pace.lift_above = pacing.tick_keyed.then(|| ticket.desired_tick.unwrap_or(-1));
            pace.held_digest = pacing.config_keyed.then_some(ticket.key.digest);
        } else {
            pace.failures = 0;
            pace.retry_at = None;
            pace.lift_above = None;
            pace.held_digest = None;
        }
    }

    /// Drops every waiting entry (shutdown).
    pub(crate) fn clear(&mut self) {
        self.pending.clear();
        self.round.clear();
    }
}

fn plus(at: Monotonic, nanos: u64) -> Monotonic {
    Monotonic::from_nanos(at.nanos().saturating_add(nanos))
}

/// How an outcome paces its conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pacing {
    /// The read or the build was paid: its time is the conversation's cost.
    admitted: bool,
    /// Backed off.
    failed: bool,
    /// The failure belongs to the tick read: a newer tick lifts it.
    tick_keyed: bool,
    /// The failure belongs to the configuration as well (the cache keys a
    /// build refusal by its digest): another configuration lifts it.
    config_keyed: bool,
}

impl Pacing {
    const fn new(admitted: bool, failed: bool, tick_keyed: bool) -> Self {
        Self {
            admitted,
            failed,
            tick_keyed,
            config_keyed: false,
        }
    }

    fn of(result: BuildResult) -> Self {
        let outcome = match result {
            BuildResult::Panicked => return Self::new(true, true, false),
            BuildResult::Loaded(outcome) => outcome,
        };
        match outcome {
            Outcome::Published => Self::new(true, false, false),
            // Another configuration is current: no failure; its own
            // requests carry their own digest.
            Outcome::Refused(Rejection::Discarded) => Self::new(true, false, false),
            // Nothing was read or reserved; the cache's own hold is per tick.
            Outcome::BackingOff => Self::new(false, true, true),
            Outcome::NoAllowance
            | Outcome::NotAdmitted
            | Outcome::ConnectionNotReserved
            | Outcome::CachePoisoned => Self::new(false, true, false),
            // The content of the tick read is what was refused, or a newer
            // plan or row may answer it.
            Outcome::NoRow
            | Outcome::SourceRefused
            | Outcome::KeyMismatch
            | Outcome::Refused(Rejection::Superseded | Rejection::GenerationConflict) => {
                Self::new(true, true, true)
            }
            // Refused under this rule: a newer tick, or another rule, may
            // build.
            Outcome::BuildRefused => Self {
                config_keyed: true,
                ..Self::new(true, true, true)
            },
            // The database, the budget or the cache's room: a newer tick
            // does not help. A projection over the size limit at one tick is
            // over it at the next (a conversation's result only grows), so it
            // backs off over every tick rather than paying for the
            // projection's length again at every new tick.
            Outcome::Oversized
            | Outcome::StepRefused(_)
            | Outcome::DatabaseUnavailable
            | Outcome::StatementTimeout
            | Outcome::Undercharged
            | Outcome::Refused(
                Rejection::Busy
                | Rejection::OverShare
                | Rejection::Undercharged
                | Rejection::FenceForgotten
                | Rejection::FenceFull,
            ) => Self::new(true, true, false),
        }
    }
}

// ---- The threads ----

/// Why a scheduler did not start.
#[derive(Debug)]
pub(crate) enum StartError {
    /// No build, or more than [`MAX_BUILDERS`].
    Builders(usize),
    /// A factor below [`MIN_INTERVAL_FACTOR`].
    Factor(u32),
    /// A request channel of no slots, or more than [`MAX_REQUEST_SLOTS`].
    Slots(usize),
    /// The cache's budget has no room for the scheduler's tables.
    NoRoom,
    Spawn(std::io::Error),
}

/// The scheduler's settings. Whatever starts the scheduler supplies them;
/// nothing here reads the environment.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SchedulerSettings {
    pub(crate) factor: u32,
    pub(crate) request_slots: usize,
    pub(crate) idle_wait: Duration,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            factor: MIN_INTERVAL_FACTOR,
            request_slots: REQUEST_SLOTS,
            idle_wait: IDLE_WAIT,
        }
    }
}

/// Counters, read without a lock.
#[derive(Debug, Default)]
struct Counters {
    dropped_full: AtomicU64,
    dropped_pending: AtomicU64,
    coalesced: AtomicU64,
    builds: AtomicU64,
    panics: AtomicU64,
    reclaimed: AtomicU64,
    reports_dropped: AtomicU64,
}

/// A copy of the counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Counts {
    /// Requests dropped because the channel was full.
    pub(crate) dropped_full: u64,
    /// Requests dropped because the pending map was full.
    pub(crate) dropped_pending: u64,
    pub(crate) coalesced: u64,
    pub(crate) builds: u64,
    pub(crate) panics: u64,
    /// Retired plans destroyed by the builders.
    pub(crate) reclaimed: u64,
    pub(crate) reports_dropped: u64,
}

/// The request side: cloned into whatever makes requests. It holds only the
/// channel's sending end and the counters.
#[derive(Clone)]
pub(crate) struct Requests {
    sender: SyncSender<BuildRequest>,
    counters: Arc<Counters>,
}

impl Requests {
    /// Asks for a build. One `try_send`: never waits, never locks. A full
    /// channel drops the request and counts it.
    pub(crate) fn request(&self, request: BuildRequest) -> Enqueued {
        match self.sender.try_send(request) {
            Ok(()) => Enqueued::Queued,
            Err(TrySendError::Full(_)) => {
                self.counters.dropped_full.fetch_add(1, Ordering::Relaxed);
                Enqueued::Dropped
            }
            Err(TrySendError::Disconnected(_)) => Enqueued::Closed,
        }
    }
}

/// What the builder threads share. A request reaches none of it.
struct Shared {
    schedule: Mutex<Schedule>,
    wake: Condvar,
    receiver: Mutex<Option<Receiver<BuildRequest>>>,
    stopping: AtomicBool,
    counters: Arc<Counters>,
    cache: Arc<RoutingPlanCache>,
    clock: Arc<dyn Clock>,
    reports: Option<SyncSender<Finished>>,
    settings: SchedulerSettings,
    /// The schedule's tables, charged to the cache's budget for the
    /// scheduler's life.
    _charge: Reserved,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The running scheduler. Dropping it shuts it down.
pub(crate) struct Scheduler {
    shared: Arc<Shared>,
    requests: Requests,
    threads: Vec<JoinHandle<()>>,
}

impl Scheduler {
    /// Starts one builder thread per build in `builds` (1 to
    /// [`MAX_BUILDERS`]), after charging the schedule's tables and the
    /// request channel to `cache`'s budget. `reports`, when given, receives a
    /// [`Finished`] for every build, without waiting (a full channel drops
    /// the report and counts it).
    pub(crate) fn start(
        cache: Arc<RoutingPlanCache>,
        builds: Vec<Box<dyn Build>>,
        clock: Arc<dyn Clock>,
        settings: SchedulerSettings,
        reports: Option<SyncSender<Finished>>,
    ) -> Result<Self, StartError> {
        if builds.is_empty() || builds.len() > MAX_BUILDERS {
            return Err(StartError::Builders(builds.len()));
        }
        if settings.factor < MIN_INTERVAL_FACTOR {
            return Err(StartError::Factor(settings.factor));
        }
        if settings.request_slots == 0 || settings.request_slots > MAX_REQUEST_SLOTS {
            return Err(StartError::Slots(settings.request_slots));
        }
        let channel = (settings.request_slots * (size_of::<BuildRequest>() + 16)) as u64 + 1024;
        let charge = cache
            .try_reserve(Schedule::charge() + channel)
            .map_err(|_| StartError::NoRoom)?;
        let (sender, receiver) = sync_channel(settings.request_slots);
        let counters = Arc::new(Counters::default());
        let shared = Arc::new(Shared {
            schedule: Mutex::new(Schedule::new(settings.factor)),
            wake: Condvar::new(),
            receiver: Mutex::new(Some(receiver)),
            stopping: AtomicBool::new(false),
            counters: counters.clone(),
            cache,
            clock,
            reports,
            settings,
            _charge: charge,
        });
        let mut scheduler = Self {
            shared: shared.clone(),
            requests: Requests { sender, counters },
            threads: Vec::with_capacity(builds.len()),
        };
        for (i, build) in builds.into_iter().enumerate() {
            let shared = shared.clone();
            let thread = std::thread::Builder::new()
                .name(format!("polis-api-routing-plan-builder-{i}"))
                .spawn(move || builder_thread(&shared, build))
                .map_err(StartError::Spawn)?;
            scheduler.threads.push(thread);
        }
        Ok(scheduler)
    }

    /// The request side, to clone into whatever makes requests.
    pub(crate) fn requests(&self) -> Requests {
        self.requests.clone()
    }

    pub(crate) fn counts(&self) -> Counts {
        let c = &self.shared.counters;
        let read = |a: &AtomicU64| a.load(Ordering::Relaxed);
        Counts {
            dropped_full: read(&c.dropped_full),
            dropped_pending: read(&c.dropped_pending),
            coalesced: read(&c.coalesced),
            builds: read(&c.builds),
            panics: read(&c.panics),
            reclaimed: read(&c.reclaimed),
            reports_dropped: read(&c.reports_dropped),
        }
    }

    /// Wakes every idle builder to look again now (after a test steps the
    /// clock, or the cache's configuration changes).
    pub(crate) fn nudge(&self) {
        self.shared.wake.notify_all();
    }

    /// Stops: queued builds and waiting requests are dropped, builds in
    /// flight finish, then the threads end.
    pub(crate) fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.shared.stopping.store(true, Ordering::Release);
        // The receiving end goes: what is queued is dropped, and later
        // requests are `Closed`.
        drop(locked(&self.shared.receiver).take());
        locked(&self.shared.schedule).clear();
        self.shared.wake.notify_all();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Returns a ticket's permit if its build never reached `finish` (a panic
/// outside the build itself, the thread unwinding).
struct InFlight<'a> {
    shared: &'a Shared,
    ticket: Option<&'a Ticket>,
    started: Monotonic,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        // Reads no clock: this runs while unwinding, where a second panic
        // would abort the process. The backoff runs from the build's start.
        if let Some(ticket) = self.ticket.take() {
            locked(&self.shared.schedule).finish(
                ticket,
                BuildResult::Panicked,
                self.started,
                self.started,
                0,
            );
        }
    }
}

fn builder_thread(shared: &Shared, mut build: Box<dyn Build>) {
    while !shared.stopping.load(Ordering::Acquire) {
        // The thread's top: a panic anywhere in a turn is counted and the
        // thread goes on.
        if catch_unwind(AssertUnwindSafe(|| turn(shared, build.as_mut()))).is_err() {
            shared.counters.panics.fetch_add(1, Ordering::Relaxed);
            build.reset();
        }
    }
}

/// One turn: reclaim, drain the channel, then build one entry or wait.
fn turn(shared: &Shared, build: &mut dyn Build) {
    if let Ok(n) = shared.cache.reclaim() {
        shared
            .counters
            .reclaimed
            .fetch_add(n as u64, Ordering::Relaxed);
    }
    drain(shared);
    let now = shared.clock.now();
    let next = locked(&shared.schedule).next(now);
    let ticket = match next {
        Next::Build(ticket) => *ticket,
        Next::Wait(until) => {
            let wait = until
                .map(|u| Duration::from_nanos(u.since(now)))
                .map_or(shared.settings.idle_wait, |d| {
                    d.min(shared.settings.idle_wait)
                });
            let schedule = locked(&shared.schedule);
            if !shared.stopping.load(Ordering::Acquire) {
                let _ = shared.wake.wait_timeout(schedule, wait);
            }
            return;
        }
    };
    // The time read before `next`, so nothing that can panic runs between
    // marking the conversation in flight and holding the record that
    // returns its permit.
    let started = now;
    let mut in_flight = InFlight {
        shared,
        ticket: Some(&ticket),
        started,
    };
    let result = match catch_unwind(AssertUnwindSafe(|| build.build(&shared.cache, &ticket.job))) {
        Ok(outcome) => BuildResult::Loaded(outcome),
        Err(_) => {
            shared.counters.panics.fetch_add(1, Ordering::Relaxed);
            build.reset();
            BuildResult::Panicked
        }
    };
    let ended = shared.clock.now();
    let jitter = shared.clock.jitter_permille();
    locked(&shared.schedule).finish(&ticket, result, started, ended, jitter);
    in_flight.ticket = None;
    shared.counters.builds.fetch_add(1, Ordering::Relaxed);
    if let Some(reports) = &shared.reports
        && reports.try_send(ticket.report(result)).is_err()
    {
        shared
            .counters
            .reports_dropped
            .fetch_add(1, Ordering::Relaxed);
    }
    // Another builder may take what this one's permit held back.
    shared.wake.notify_all();
}

/// Moves what is queued into the schedule: at most one channel's worth, so
/// a flood cannot keep a builder from building.
fn drain(shared: &Shared) {
    // Another builder draining is enough; this one goes on to build.
    let receiver = match shared.receiver.try_lock() {
        Ok(receiver) => receiver,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    let Some(receiver) = receiver.as_ref() else {
        return;
    };
    let mut schedule = locked(&shared.schedule);
    for _ in 0..shared.settings.request_slots {
        match receiver.try_recv() {
            Ok(request) => match schedule.offer(request) {
                Offered::Queued => {}
                Offered::Coalesced => {
                    shared.counters.coalesced.fetch_add(1, Ordering::Relaxed);
                }
                Offered::Dropped => {
                    shared
                        .counters
                        .dropped_pending
                        .fetch_add(1, Ordering::Relaxed);
                }
            },
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
        }
    }
}
