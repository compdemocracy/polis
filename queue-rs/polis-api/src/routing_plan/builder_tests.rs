//! The build scheduler's tests. The schedule's own tests step a clock by
//! hand (`at`), so every time in them is exact; the thread tests use a
//! hand-stepped clock too, and order themselves with channels, never with a
//! sleep. Constructed conversations only; no vote value anywhere.
use super::builder::*;
use super::cache::RoutingPlanCache;
use super::cache_tests::{ENV, UNIFORM, plan, settings, uniform_settings};
use super::load::{Job, Outcome};
use polis_routing_plan::{
    DEFAULT_CACHE_BYTES, Lookup, MAX_SHARE_DIVISOR, Monotonic, RETRY_CAP_NS, Rejection, RuleConfig,
    retry_delay_ns,
};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MS: u64 = 1_000_000;
const S: u64 = 1_000 * MS;
/// How long a thread test waits for something that must happen, before it
/// fails rather than hangs. Never a pacing: nothing waits for it to pass.
const PATIENCE: Duration = Duration::from_secs(20);

fn at(nanos: u64) -> Monotonic {
    Monotonic::from_nanos(nanos)
}

fn config(digest: u8) -> Arc<BuildConfig> {
    let rule = RuleConfig::parse(UNIFORM, None).unwrap();
    Arc::new(BuildConfig {
        digest: [digest; 32],
        rule,
        rule_plain: rule.to_plain(),
        policy: None,
    })
}

fn req(zid: i32, tick: Option<i64>, config: &Arc<BuildConfig>) -> BuildRequest {
    BuildRequest {
        zid,
        env: Arc::from(ENV),
        desired_tick: tick,
        config: config.clone(),
    }
}

fn take(schedule: &mut Schedule, now: Monotonic) -> Ticket {
    match schedule.next(now) {
        Next::Build(ticket) => *ticket,
        Next::Wait(until) => panic!("expected a build at {now:?}, waiting until {until:?}"),
    }
}

fn waits(schedule: &mut Schedule, now: Monotonic) -> Option<Monotonic> {
    match schedule.next(now) {
        Next::Build(ticket) => panic!("expected no build at {now:?}, got {ticket:?}"),
        Next::Wait(until) => until,
    }
}

const PUBLISHED: BuildResult = BuildResult::Loaded(Outcome::Published);

// ---- Rate: the two properties the scheduler exists for ----

/// One new math tick for one conversation every millisecond, for a second,
/// and each build costs 1 ms. With the factor at 10, the conversation is
/// built at most once per 11 ms (its 1 ms build, then 10 ms of rest): never
/// continuously. Every build carries the newest tick offered by then.
#[test]
fn min_rebuild_interval_holds_under_rapid_ticks() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    let mut starts = vec![];
    for step in 0..1_000u64 {
        let now = at(step * MS);
        s.offer(req(7, Some(step as i64), &c));
        if let Next::Build(ticket) = s.next(now) {
            assert_eq!(ticket.desired_tick(), Some(step as i64), "the newest tick");
            starts.push(step);
            s.finish(&ticket, PUBLISHED, now, at((step + 1) * MS), 0);
        }
    }
    for pair in starts.windows(2) {
        assert!(
            pair[1] - pair[0] >= 11,
            "rebuilt after {} ms",
            pair[1] - pair[0]
        );
    }
    assert!(starts.len() <= 1_000 / 11 + 1, "{} builds", starts.len());
    // ... and never fewer than the interval allows: the rate is a ceiling
    // that the builder actually reaches, not a postponement.
    assert_eq!(starts.len(), 1_000usize.div_ceil(11));
}

/// Ticks keep arriving (one a millisecond, for ten seconds) and each build
/// costs 100 ms, so the interval is a second. The interval runs from the
/// end of the last build and newer ticks never reset it: a build starts at
/// the very moment each interval passes, with the newest tick.
#[test]
fn rapid_updates_still_rebuild_eventually() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    let mut builds = vec![];
    let mut busy_until = 0;
    for step in 0..10_000u64 {
        let now = step * MS;
        s.offer(req(7, Some(step as i64), &c));
        if now < busy_until {
            continue;
        }
        if let Next::Build(ticket) = s.next(at(now)) {
            builds.push((step, ticket.desired_tick()));
            busy_until = now + 100 * MS;
            s.finish(&ticket, PUBLISHED, at(now), at(busy_until), 0);
        }
    }
    let expected: Vec<(u64, Option<i64>)> = (0..10u64)
        .map(|k| k * 1_100)
        .take_while(|&step| step < 10_000)
        .map(|step| (step, Some(step as i64)))
        .collect();
    assert_eq!(builds, expected);
}

/// The interval is at least `factor` times the measured cost, and jitter
/// only lengthens it (up to a quarter).
#[test]
fn interval_is_factor_times_cost_plus_jitter() {
    let c = config(1);
    for (factor, jitter, expected) in [
        (10, 0, 2 * MS + 20 * MS),
        (10, 1000, 2 * MS + 25 * MS),
        (25, 0, 2 * MS + 50 * MS),
    ] {
        let mut s = Schedule::new(factor);
        s.offer(req(7, Some(1), &c));
        let t = take(&mut s, at(0));
        s.finish(&t, PUBLISHED, at(0), at(2 * MS), jitter);
        s.offer(req(7, Some(2), &c));
        assert_eq!(
            waits(&mut s, at(2 * MS)),
            Some(at(expected)),
            "{factor} {jitter}"
        );
        assert_eq!(take(&mut s, at(expected)).desired_tick(), Some(2));
    }
    // A factor below the floor is raised to it.
    let mut s = Schedule::new(3);
    s.offer(req(7, Some(1), &c));
    let t = take(&mut s, at(0));
    s.finish(&t, PUBLISHED, at(0), at(MS), 0);
    s.offer(req(7, Some(2), &c));
    assert_eq!(waits(&mut s, at(MS)), Some(at(11 * MS)));
}

// ---- Fairness ----

/// Three conversations, each asking again as soon as it is built, at no
/// cost (no interval): they are built in turn, A B C A B C, however often
/// any one of them asks.
#[test]
fn round_robin_across_conversations() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    for zid in [1, 2, 3] {
        s.offer(req(zid, Some(0), &c));
    }
    let mut order = vec![];
    for step in 1..=9i64 {
        let now = at(step as u64 * MS);
        let t = take(&mut s, now);
        order.push(t.zid());
        s.finish(&t, PUBLISHED, now, now, 0);
        // Conversation 1 asks at every step; the others once per build.
        s.offer(req(1, Some(step), &c));
        s.offer(req(t.zid(), Some(step), &c));
    }
    assert_eq!(order, [1, 2, 3, 1, 2, 3, 1, 2, 3]);
}

/// A conversation whose builds are expensive (and so rests long between
/// them) never holds back another: while it rests, the other is built.
#[test]
fn a_resting_conversation_does_not_hold_back_another() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    s.offer(req(1, Some(0), &c));
    let t = take(&mut s, at(0));
    s.finish(&t, PUBLISHED, at(0), at(S), 0);
    s.offer(req(1, Some(1), &c));
    s.offer(req(2, Some(1), &c));
    assert_eq!(take(&mut s, at(S)).zid(), 2);
    assert_eq!(waits(&mut s, at(S)), Some(at(11 * S)));
}

/// At most one build in flight per conversation: a second request while
/// the first is building waits for it to finish.
#[test]
fn one_build_in_flight_per_conversation() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    s.offer(req(1, Some(1), &c));
    let first = take(&mut s, at(0));
    s.offer(req(1, Some(2), &c));
    assert_eq!(waits(&mut s, at(0)), None, "in flight: no time to wait for");
    s.finish(&first, PUBLISHED, at(0), at(0), 0);
    assert_eq!(take(&mut s, at(0)).desired_tick(), Some(2));
}

// ---- Coalescing and the captured configuration ----

/// Requests for one conversation, environment and configuration fold into
/// one entry that keeps the newest tick; a request that saw no tick never
/// lowers it. Another configuration is its own entry.
#[test]
fn coalescing_keeps_newest() {
    let (c1, c2) = (config(1), config(2));
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    assert_eq!(s.offer(req(7, Some(5), &c1)), Offered::Queued);
    for tick in [Some(9), Some(7), None, Some(8)] {
        assert_eq!(s.offer(req(7, tick, &c1)), Offered::Coalesced);
    }
    assert_eq!(s.offer(req(7, Some(3), &c2)), Offered::Queued);
    assert_eq!(s.pending(), 2);
    let t = take(&mut s, at(0));
    assert_eq!((t.desired_tick(), t.job.config_digest), (Some(9), [1; 32]));
    assert_eq!(t.job.desired_tick, 9);
    s.finish(&t, PUBLISHED, at(0), at(0), 0);
    let t = take(&mut s, at(0));
    assert_eq!((t.desired_tick(), t.job.config_digest), (Some(3), [2; 32]));
}

/// The pending map is bounded: a request for a new entry when it is full
/// is dropped (and counted by the thread); one for an entry waiting still
/// coalesces.
#[test]
fn pending_map_bounded() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    for zid in 0..PENDING_ENTRIES as i32 {
        assert_eq!(s.offer(req(zid, Some(1), &c)), Offered::Queued);
    }
    assert_eq!(s.offer(req(-1, Some(1), &c)), Offered::Dropped);
    assert_eq!(s.offer(req(0, Some(2), &c)), Offered::Coalesced);
    assert_eq!(s.pending(), PENDING_ENTRIES);
}

// ---- Failures: the cache's backoff, and the refused source (review F2) ----

/// Failures that a newer tick does not help (the database is unavailable)
/// back off by the cache's own delay: doubling from 30 s, capped at 30
/// minutes, plus up to a quarter of jitter, which only lengthens it. A
/// success resets it.
#[test]
fn backoff_capped_and_jittered() {
    let c = config(1);
    for jitter in [0u16, 500, 1000] {
        let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
        let mut now = 0;
        let mut gaps = vec![];
        for failures in 1..=12u32 {
            s.offer(req(7, Some(i64::from(failures)), &c));
            let t = take(&mut s, at(now));
            s.finish(
                &t,
                BuildResult::Loaded(Outcome::DatabaseUnavailable),
                at(now),
                at(now),
                jitter,
            );
            s.offer(req(7, Some(i64::from(failures) + 100), &c));
            let until = waits(&mut s, at(now)).unwrap();
            assert_eq!(until.since(at(now)), retry_delay_ns(failures, jitter));
            assert!(waits(&mut s, at(until.nanos() - 1)).is_some(), "not before");
            gaps.push(until.since(at(now)));
            now = until.nanos();
        }
        assert!(gaps.windows(2).all(|g| g[0] <= g[1]), "{gaps:?}");
        assert_eq!(gaps[0], 30 * S + 30 * S / 4 * u64::from(jitter) / 1000);
        let cap = RETRY_CAP_NS + RETRY_CAP_NS / 4 * u64::from(jitter) / 1000;
        assert_eq!(*gaps.last().unwrap(), cap, "capped");
        // A success clears the backoff.
        let t = take(&mut s, at(now));
        s.finish(&t, PUBLISHED, at(now), at(now), jitter);
        s.offer(req(7, Some(999), &c));
        assert_eq!(take(&mut s, at(now)).desired_tick(), Some(999));
    }
}

/// Review F2: a stored result refused for its content is not read again for
/// the same tick (nor by a request that saw no tick) until the backoff
/// passes; the loader cannot tell before reading, so the scheduler holds
/// it. A newer tick is new content and is read as soon as the interval
/// allows. A failure a newer tick cannot help holds every tick.
#[test]
fn refused_source_not_reread_for_its_tick() {
    let c = config(1);
    for refused in [Outcome::SourceRefused, Outcome::BuildRefused] {
        let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
        s.offer(req(12, Some(4), &c));
        let t = take(&mut s, at(0));
        s.finish(&t, BuildResult::Loaded(refused), at(0), at(MS), 0);
        s.offer(req(12, Some(4), &c));
        s.offer(req(12, None, &c));
        let held = waits(&mut s, at(MS)).unwrap();
        assert_eq!(held.since(at(MS)), retry_delay_ns(1, 0));
        assert!(waits(&mut s, at(held.nanos() - 1)).is_some());
        // Paced, not forbidden: after the backoff it is read once more.
        let again = take(&mut s, held);
        assert_eq!(again.desired_tick(), Some(4));
        s.finish(&again, BuildResult::Loaded(refused), held, held, 0);
        // A newer tick: read after the interval (10 x 0), not the backoff.
        s.offer(req(12, Some(5), &c));
        assert_eq!(take(&mut s, held).desired_tick(), Some(5), "{refused:?}");
    }
    // The database unavailable: a newer tick waits for the backoff too.
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    s.offer(req(12, Some(4), &c));
    let t = take(&mut s, at(0));
    s.finish(
        &t,
        BuildResult::Loaded(Outcome::DatabaseUnavailable),
        at(0),
        at(0),
        0,
    );
    s.offer(req(12, Some(5), &c));
    assert_eq!(waits(&mut s, at(0)), Some(at(retry_delay_ns(1, 0))));
}

/// A plan discarded because another configuration became current is not a
/// failure: nothing backs off.
#[test]
fn discarded_is_not_a_failure() {
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    s.offer(req(7, Some(1), &c));
    let t = take(&mut s, at(0));
    let discarded = BuildResult::Loaded(Outcome::Refused(Rejection::Discarded));
    s.finish(&t, discarded, at(0), at(0), 0);
    s.offer(req(7, Some(1), &c));
    take(&mut s, at(0));
}

// ---- The threads ----

/// A clock stepped by hand, and a fixed jitter.
#[derive(Default)]
struct HandClock {
    nanos: AtomicU64,
    jitter: AtomicU16,
}

impl HandClock {
    fn advance(&self, nanos: u64) {
        self.nanos.fetch_add(nanos, Ordering::SeqCst);
    }
}

impl Clock for HandClock {
    fn now(&self) -> Monotonic {
        at(self.nanos.load(Ordering::SeqCst))
    }
    fn jitter_permille(&self) -> u16 {
        self.jitter.load(Ordering::SeqCst)
    }
}

type BuildFn = Box<dyn FnMut(&Arc<RoutingPlanCache>, &Job) -> Outcome + Send>;

struct Fake(BuildFn);

fn fake(f: impl FnMut(&Arc<RoutingPlanCache>, &Job) -> Outcome + Send + 'static) -> BuildFn {
    Box::new(f)
}

impl Build for Fake {
    fn build(&mut self, cache: &Arc<RoutingPlanCache>, job: &Job) -> Outcome {
        (self.0)(cache, job)
    }
}

/// A build that publishes a constructed plan for the job's conversation and
/// tick, under the job's own configuration digest, as the loader would.
fn publish_plan(cache: &Arc<RoutingPlanCache>, job: &Job) -> Outcome {
    let p = plan(
        job.zid,
        job.desired_tick,
        &job.rule,
        job.policy.as_deref(),
        job.config_digest,
    );
    let Ok(reservation) = cache.try_reserve(p.plan().charge() + 4096) else {
        return Outcome::NotAdmitted;
    };
    match reservation.publish(p) {
        Ok(()) => Outcome::Published,
        Err(rejected) => match rejected.reason {
            super::cache::PublishRefused::Rejected(r) => Outcome::Refused(r),
            super::cache::PublishRefused::Poisoned => Outcome::CachePoisoned,
        },
    }
}

/// A place a build parks at: it says which job entered, and goes on when the
/// test lets it.
struct Park {
    entered: SyncSender<i32>,
    go: Mutex<Receiver<()>>,
}

fn park() -> (Arc<Park>, Receiver<i32>, SyncSender<()>) {
    let (entered, entered_rx) = sync_channel(64);
    let (go_tx, go) = sync_channel(64);
    (
        Arc::new(Park {
            entered,
            go: Mutex::new(go),
        }),
        entered_rx,
        go_tx,
    )
}

impl Park {
    fn pass(&self, zid: i32) {
        self.entered.send(zid).unwrap();
        self.go.lock().unwrap().recv_timeout(PATIENCE).unwrap();
    }
}

fn settings_with(slots: usize) -> SchedulerSettings {
    SchedulerSettings {
        factor: MIN_INTERVAL_FACTOR,
        request_slots: slots,
        idle_wait: Duration::from_millis(1),
    }
}

fn start(
    cache: &Arc<RoutingPlanCache>,
    build: BuildFn,
    clock: &Arc<HandClock>,
    slots: usize,
) -> (Scheduler, Receiver<Finished>) {
    let (reports, finished) = sync_channel(1024);
    let scheduler = Scheduler::start(
        cache.clone(),
        vec![Box::new(Fake(build))],
        clock.clone(),
        settings_with(slots),
        Some(reports),
    )
    .unwrap();
    (scheduler, finished)
}

fn next_report(finished: &Receiver<Finished>) -> Finished {
    finished
        .recv_timeout(PATIENCE)
        .expect("a build that must finish did not")
}

fn uniform_cache() -> Arc<RoutingPlanCache> {
    RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some([1; 32])).unwrap()
}

/// The request side never waits: with the one builder parked inside a
/// build and the channel full, ten thousand more requests each return
/// `Dropped` at once, counted, while the builder is still parked.
#[test]
fn full_queue_drops_request_not_caller() {
    let cache = uniform_cache();
    let clock = Arc::new(HandClock::default());
    let (g, entered, go) = park();
    let park_in = g.clone();
    let (scheduler, finished) = start(
        &cache,
        fake(move |_, job| {
            park_in.pass(job.zid);
            Outcome::Published
        }),
        &clock,
        4,
    );
    let c = config(1);
    let requests = scheduler.requests();
    assert_eq!(requests.request(req(1, Some(1), &c)), Enqueued::Queued);
    assert_eq!(entered.recv_timeout(PATIENCE).unwrap(), 1, "parked");
    for zid in 2..6 {
        assert_eq!(requests.request(req(zid, Some(1), &c)), Enqueued::Queued);
    }
    let mut slowest = Duration::ZERO;
    for zid in 100..10_100 {
        let t = Instant::now();
        let enqueued = requests.request(req(zid, Some(1), &c));
        slowest = slowest.max(t.elapsed());
        assert_eq!(enqueued, Enqueued::Dropped);
    }
    // A bound far above a `try_send` (nanoseconds), far below any wait.
    assert!(slowest < Duration::from_millis(50), "slowest {slowest:?}");
    assert_eq!(scheduler.counts().dropped_full, 10_000);
    assert_eq!(scheduler.counts().builds, 0, "the builder is still parked");
    go.send(()).unwrap();
    assert_eq!(next_report(&finished).zid, 1);
    for _ in 2..6 {
        go.send(()).unwrap();
    }
    let mut built: Vec<i32> = (2..6).map(|_| next_report(&finished).zid).collect();
    built.sort_unstable();
    assert_eq!(built, [2, 3, 4, 5]);
    drop(g);
    scheduler.shutdown();
}

/// A request dropped because the channel was full leaves its conversation
/// retryable: its next request, once there is room, is built.
#[test]
fn dropped_request_retried_later() {
    let cache = uniform_cache();
    let clock = Arc::new(HandClock::default());
    let (g, entered, go) = park();
    let park_in = g.clone();
    let (scheduler, finished) = start(
        &cache,
        fake(move |_, job| {
            park_in.pass(job.zid);
            Outcome::Published
        }),
        &clock,
        1,
    );
    let c = config(1);
    let requests = scheduler.requests();
    requests.request(req(1, Some(1), &c));
    assert_eq!(entered.recv_timeout(PATIENCE).unwrap(), 1);
    assert_eq!(requests.request(req(2, Some(1), &c)), Enqueued::Queued);
    assert_eq!(requests.request(req(3, Some(7), &c)), Enqueued::Dropped);
    go.send(()).unwrap();
    assert_eq!(next_report(&finished).zid, 1);
    assert_eq!(entered.recv_timeout(PATIENCE).unwrap(), 2);
    go.send(()).unwrap();
    assert_eq!(next_report(&finished).zid, 2);
    // Room again: conversation 3's next request is built.
    assert_eq!(requests.request(req(3, Some(8), &c)), Enqueued::Queued);
    assert_eq!(entered.recv_timeout(PATIENCE).unwrap(), 3);
    go.send(()).unwrap();
    let report = next_report(&finished);
    assert_eq!((report.zid, report.desired_tick), (3, Some(8)));
    assert_eq!(scheduler.counts().dropped_full, 1);
    drop(g);
    scheduler.shutdown();
}

/// The configuration is the one captured when the request was made. With
/// the builder parked on another conversation, conversation 7 is requested
/// under configuration 1, then configuration 2 becomes current; the build
/// runs under configuration 1 and its plan is discarded at publication.
#[test]
fn config_captured_at_request() {
    let s1 = uniform_settings();
    let mut s2 = s1.clone();
    s2.conversations = vec![7, 8];
    assert_ne!(s1.digest(), s2.digest());
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s1.digest())).unwrap();
    let clock = Arc::new(HandClock::default());
    let (g, entered, go) = park();
    let park_in = g.clone();
    let digests = Arc::new(Mutex::new(vec![]));
    let seen = digests.clone();
    let (scheduler, finished) = start(
        &cache,
        fake(move |cache, job| {
            seen.lock().unwrap().push((job.zid, job.config_digest));
            if job.zid == 9 {
                park_in.pass(job.zid);
            }
            publish_plan(cache, job)
        }),
        &clock,
        8,
    );
    let requests = scheduler.requests();
    requests.request(req(9, Some(1), &BuildConfig::of(&s1)));
    assert_eq!(entered.recv_timeout(PATIENCE).unwrap(), 9);
    requests.request(req(7, Some(1), &BuildConfig::of(&s1)));
    cache.set_config(Some(s2.digest())).unwrap();
    go.send(()).unwrap();
    let first = next_report(&finished);
    assert_eq!(first.zid, 9);
    let report = next_report(&finished);
    assert_eq!(report.zid, 7);
    assert_eq!(report.config_digest, s1.digest(), "the captured digest");
    assert_eq!(
        report.result,
        BuildResult::Loaded(Outcome::Refused(Rejection::Discarded))
    );
    assert!(digests.lock().unwrap().contains(&(7, s1.digest())));
    // A request captured under configuration 2 publishes.
    requests.request(req(7, Some(1), &BuildConfig::of(&s2)));
    assert_eq!(
        next_report(&finished).result,
        BuildResult::Loaded(Outcome::Published)
    );
    drop(g);
    scheduler.shutdown();
}

/// Review F3: each report names the conversation, environment, tick and
/// configuration its build was for, so an outcome is matched to its job
/// whatever order builds end in and whether or not a report was dropped.
#[test]
fn outcomes_matched_to_their_jobs() {
    let cache = uniform_cache();
    let clock = Arc::new(HandClock::default());
    let outcome_of = |zid: i32| match zid {
        1 => Outcome::SourceRefused,
        2 => Outcome::NoRow,
        _ => Outcome::Published,
    };
    let (scheduler, finished) = start(&cache, fake(move |_, job| outcome_of(job.zid)), &clock, 8);
    let requests = scheduler.requests();
    for (zid, digest) in [(1, 1), (2, 2), (3, 3)] {
        requests.request(req(zid, Some(i64::from(zid) * 10), &config(digest)));
    }
    let mut reports: Vec<Finished> = (0..3).map(|_| next_report(&finished)).collect();
    reports.sort_by_key(|r| r.zid);
    for r in &reports {
        assert_eq!(&*r.env, ENV);
        assert_eq!(r.desired_tick, Some(i64::from(r.zid) * 10));
        assert_eq!(r.config_digest, [r.zid as u8; 32]);
        assert_eq!(r.result, BuildResult::Loaded(outcome_of(r.zid)));
    }
    scheduler.shutdown();

    // A full report channel drops reports, counted; builds go on.
    let (reports_tx, unread) = sync_channel(1);
    let scheduler = Scheduler::start(
        cache.clone(),
        vec![Box::new(Fake(fake(|_, _| Outcome::Published)))],
        clock.clone(),
        settings_with(8),
        Some(reports_tx),
    )
    .unwrap();
    let requests = scheduler.requests();
    for zid in 1..=3 {
        requests.request(req(zid, Some(1), &config(1)));
    }
    let deadline = Instant::now() + PATIENCE;
    // A build is counted before its report is sent: wait for both.
    while scheduler.counts().builds < 3 || scheduler.counts().reports_dropped < 2 {
        assert!(
            Instant::now() < deadline,
            "builds or their reports did not run"
        );
        std::thread::yield_now();
    }
    assert_eq!(scheduler.counts().reports_dropped, 2);
    assert_eq!(unread.try_recv().unwrap().zid, 1);
    scheduler.shutdown();
}

/// What a build reserves comes back on every way it ends: an error, a
/// panic, and a cancellation (shutdown while one build is in flight and
/// another is queued; the queued one never runs). The conversation's
/// permit comes back too: after each, the same conversation builds again.
#[test]
fn permits_and_reservations_released_on_error_cancel_and_panic() {
    let cache = uniform_cache();
    let before_start = cache.used_for_test();
    let clock = Arc::new(HandClock::default());
    let (g, entered, go) = park();
    let park_in = g.clone();
    let ran = Arc::new(Mutex::new(vec![]));
    let ran_in = ran.clone();
    let (scheduler, finished) = start(
        &cache,
        fake(move |cache, job| {
            ran_in.lock().unwrap().push(job.zid);
            let _held = cache.try_reserve(MS).unwrap();
            match job.zid {
                1 => Outcome::DatabaseUnavailable,
                2 => panic!("a build that panics (expected by this test)"),
                3 => {
                    park_in.pass(3);
                    Outcome::Published
                }
                _ => Outcome::Published,
            }
        }),
        &clock,
        8,
    );
    let baseline = cache.used_for_test();
    assert!(baseline > before_start, "the schedule's tables are charged");
    let c = config(1);
    let requests = scheduler.requests();
    for zid in [1, 2] {
        requests.request(req(zid, Some(1), &c));
        let report = next_report(&finished);
        assert_eq!(report.zid, zid);
        assert_eq!(cache.used_for_test(), baseline, "zid {zid}");
    }
    assert_eq!(scheduler.counts().panics, 1);
    // The permits came back: after the backoff, both build again.
    clock.advance(retry_delay_ns(1, 0));
    scheduler.nudge();
    for zid in [1, 2] {
        requests.request(req(zid, Some(2), &c));
        assert_eq!(next_report(&finished).zid, zid);
    }
    assert_eq!(cache.used_for_test(), baseline);
    // Cancellation: 3 in flight, 4 queued behind it, then shutdown.
    requests.request(req(3, Some(1), &c));
    assert_eq!(entered.recv_timeout(PATIENCE).unwrap(), 3);
    requests.request(req(4, Some(1), &c));
    let stopping = std::thread::spawn(move || scheduler.shutdown());
    // Shutdown has begun once requests are refused as closed (the stop is
    // set before the channel goes); only then is the parked build let go.
    let deadline = Instant::now() + PATIENCE;
    while requests.request(req(4, Some(2), &c)) != Enqueued::Closed {
        assert!(Instant::now() < deadline, "shutdown did not begin");
        std::thread::yield_now();
    }
    go.send(()).unwrap();
    stopping.join().unwrap();
    assert_eq!(cache.used_for_test(), before_start, "everything returned");
    assert!(!ran.lock().unwrap().contains(&4), "queued build dropped");
    drop(g);
}

/// A panic in a build is caught at the thread's top, counted, and the same
/// thread (there is one) goes on to build the next conversation.
#[test]
fn panic_in_build_counted_and_survived() {
    let cache = uniform_cache();
    let clock = Arc::new(HandClock::default());
    let threads = Arc::new(Mutex::new(vec![]));
    let threads_in = threads.clone();
    let (scheduler, finished) = start(
        &cache,
        fake(move |_, job| {
            threads_in.lock().unwrap().push(std::thread::current().id());
            if job.zid == 2 {
                panic!("a build that panics (expected by this test)");
            }
            Outcome::Published
        }),
        &clock,
        8,
    );
    let requests = scheduler.requests();
    let c = config(1);
    requests.request(req(2, Some(1), &c));
    let report = next_report(&finished);
    assert_eq!((report.zid, report.result), (2, BuildResult::Panicked));
    requests.request(req(5, Some(1), &c));
    let report = next_report(&finished);
    assert_eq!((report.zid, report.result), (5, PUBLISHED));
    assert_eq!(scheduler.counts().panics, 1);
    let threads = threads.lock().unwrap();
    assert_eq!(threads[0], threads[1], "the same thread survived");
    drop(threads);
    scheduler.shutdown();
}

/// The builders destroy retired plans between builds and while idle: a plan
/// replaced while a request borrows it stays retired and charged until the
/// borrow ends, then the idle builder reclaims it, with no new build.
#[test]
fn reclaims_retired_plans() {
    let s = settings(RuleConfig::parse(UNIFORM, None).unwrap(), None);
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    let clock = Arc::new(HandClock::default());
    let (scheduler, finished) = start(&cache, fake(publish_plan), &clock, 8);
    let requests = scheduler.requests();
    let c = BuildConfig::of(&s);
    requests.request(req(7, Some(1), &c));
    assert_eq!(next_report(&finished).result, PUBLISHED);
    let Lookup::Hit { plan: borrowed, .. } = cache.lookup(&s.capture(), 7, ENV, Some(1)) else {
        panic!("expected a hit");
    };
    let one_plan = cache.used_for_test();
    requests.request(req(7, Some(2), &c));
    assert_eq!(next_report(&finished).result, PUBLISHED);
    let reclaimed_before = scheduler.counts().reclaimed;
    assert!(
        cache.used_for_test() > one_plan,
        "the old plan is retired, charged"
    );
    drop(borrowed);
    let deadline = Instant::now() + PATIENCE;
    while scheduler.counts().reclaimed == reclaimed_before {
        assert!(
            Instant::now() < deadline,
            "the idle builder did not reclaim"
        );
        scheduler.nudge();
        std::thread::yield_now();
    }
    assert_eq!(cache.used_for_test(), one_plan);
    scheduler.shutdown();
}

/// The settings are checked: one to four builders, a factor of at least 10,
/// a channel of 1 to `MAX_REQUEST_SLOTS`; the schedule's charge fits well
/// within one share of the smallest budget's default.
#[test]
fn start_refuses_bad_settings() {
    let cache = uniform_cache();
    let clock: Arc<dyn Clock> = Arc::new(HandClock::default());
    let fakes = |n: usize| -> Vec<Box<dyn Build>> {
        (0..n)
            .map(|_| Box::new(Fake(fake(|_, _| Outcome::Published))) as Box<dyn Build>)
            .collect()
    };
    let ok = settings_with(8);
    let bad_factor = SchedulerSettings { factor: 9, ..ok };
    let no_slots = SchedulerSettings {
        request_slots: 0,
        ..ok
    };
    let too_many_slots = SchedulerSettings {
        request_slots: MAX_REQUEST_SLOTS + 1,
        ..ok
    };
    for (n, settings) in [
        (0, ok),
        (5, ok),
        (1, bad_factor),
        (1, no_slots),
        (1, too_many_slots),
    ] {
        assert!(
            Scheduler::start(cache.clone(), fakes(n), clock.clone(), settings, None).is_err(),
            "{n} {settings:?}"
        );
    }
    let s = Scheduler::start(cache.clone(), fakes(MAX_BUILDERS), clock, ok, None).unwrap();
    s.shutdown();
    assert!(Schedule::charge() < DEFAULT_CACHE_BYTES / MAX_SHARE_DIVISOR / 16);
    assert_eq!(SchedulerSettings::default().factor, MIN_INTERVAL_FACTOR);
    assert_eq!(DEFAULT_BUILDERS, 1);
}

/// The module's source: its own `std::thread`s, no tokio and no blocking
/// pool, no wall clock, and a request side that only `try_send`s.
#[test]
fn builders_are_own_threads_and_requests_only_try_send() {
    let text = include_str!("builder.rs");
    for word in [
        "tokio",
        "spawn_blocking",
        "SystemTime",
        "now_ms",
        "std::fs",
        "thread::sleep",
    ] {
        assert!(!text.contains(word), "builder.rs names {word}");
    }
    assert!(text.contains("std::thread::Builder::new()"));
    let request = text
        .split("pub(crate) fn request(&self")
        .nth(1)
        .and_then(|rest| rest.split("\n    }\n").next())
        .unwrap();
    assert!(request.contains(".try_send("));
    for word in [".lock(", ".send(", "recv", "wait", "Mutex"] {
        assert!(!request.contains(word), "the request side names {word}");
    }
    // No builder blocks receiving on the request channel, so a `try_send`
    // never has a receiver to wake.
    for word in [".recv(", ".recv_timeout(", "for request in"] {
        assert!(!text.contains(word), "builder.rs names {word}");
    }
}

/// The plan built for a test publishes, so the thread tests exercise the
/// real cache: a constructed plan under configuration 1 is a hit.
#[test]
fn publish_plan_publishes() {
    let cache = uniform_cache();
    let c = config(1);
    let mut s = Schedule::new(MIN_INTERVAL_FACTOR);
    s.offer(req(7, Some(3), &c));
    let t = take(&mut s, at(0));
    assert_eq!(publish_plan(&cache, &t.job), Outcome::Published);
}
