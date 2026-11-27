//! The plan cache's wrapper: the lock that never waits, the reservation
//! bound to its one cache, the budget read once at startup, the
//! configuration digest over the rule and its parameters, and how long the
//! builder side holds the lock. Constructed conversations only; no vote
//! value anywhere (the counts below are the math result's tallies).
use super::cache::*;
use polis_routing_plan::{
    BundleKey, CachedPlan, DEFAULT_CACHE_BYTES, Failure, Lookup, MissReason, Monotonic, Plan,
    Projection, Rejection, RowIdentity, RuleConfig, SourceKey, SourceLimits,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

const UNIFORM: &str = r#"{"rule":"uniform/1","params":{},"terms":[]}"#;
const STORED: &str = r#"{"rule":"stored-weights/1","params":{},"terms":[]}"#;
const FLOOR_POLICY: &str = "base-counts:lag-0";
const ENV: &str = "example";

/// Runs `probe` on its own thread while the caller holds the lock, and fails
/// the test, rather than hanging it, if the probe has not finished within
/// `limit`: a probe that waits on the lock never finishes while it is held.
fn finishes_within<T: Send + 'static>(
    limit: Duration,
    probe: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(probe());
    });
    match finished.recv_timeout(limit) {
        Ok(value) => value,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("the probe waited on the held lock for more than {limit:?}")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("the probe panicked"),
    }
}

fn floor_text(share: f64) -> String {
    format!(
        r#"{{"rule":"symmetric-gic-floor/2","params":{{"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0,"meta_policy":"exclude","consensus_form":"gic-geomean/1","gic_offset":0.5,"gic_min_groups":2,"floor_share":{share}}},"terms":[]}}"#
    )
}

fn rule(text: &str, policy: Option<&str>) -> RuleConfig {
    RuleConfig::parse(text, policy).unwrap()
}

/// Three comments in two groups, with stored weights.
fn source() -> Value {
    let cell = json!({"A": 3, "D": 2, "S": 6});
    let votes = json!({"10": cell, "20": cell, "30": cell});
    json!({
        "tids": [10, 20, 30],
        "pca": {"comment-extremity": [0.5, 1.0, 1.5]},
        "meta-tids": [],
        "group-votes": {
            "0": {"id": 0, "n-members": 5, "votes": votes},
            "1": {"id": 1, "n-members": 6, "votes": votes}
        },
        "group-clusters": [
            {"id": 0, "members": [100], "center": [0.0, 0.0]},
            {"id": 1, "members": [101], "center": [1.0, 1.0]}
        ],
        "base-clusters": {
            "id": [100, 101],
            "members": [[2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]],
            "count": [5, 6],
            "x": [0.0, 0.0],
            "y": [0.0, 0.0]
        },
        "comment-priorities": {"10": 9.0, "20": 2.0, "30": 2.0}
    })
}

fn projection(zid: i32, tick: i64) -> Projection {
    let row = RowIdentity {
        zid,
        math_env: ENV.into(),
        math_tick: tick,
        last_vote_timestamp: Some(1_700_000_000_000 + tick),
        db_now_ms: 1_700_000_100_000,
    };
    let bytes = serde_json::to_vec(&source()).unwrap();
    Projection::parse(&bytes, row, &SourceLimits::default()).unwrap()
}

fn plan(zid: i32, tick: i64, rule: &RuleConfig, policy: Option<&str>, d: [u8; 32]) -> PlanRef {
    let p = projection(zid, tick);
    let built = Plan::build(&p.frames(rule.needs()).unwrap(), rule).unwrap();
    let key = BundleKey::of(&p, rule, policy, d);
    PlanRef::new(CachedPlan::new(key, built, Monotonic::from_nanos(0)).unwrap())
}

fn settings(rule: RuleConfig, policy: Option<&str>) -> Settings {
    Settings {
        mode: Mode::Serve,
        rule,
        count_policy: policy.map(str::to_owned),
        conversations: vec![7],
        cache_bytes: DEFAULT_CACHE_BYTES,
        head_lag_bound_ns: 1_000_000_000,
    }
}

fn uniform_settings() -> Settings {
    settings(rule(UNIFORM, None), None)
}

/// Publishes under a reservation of the plan's charge and room for its
/// fence; the reason, when refused.
fn publish(cache: &Arc<RoutingPlanCache>, plan: PlanRef) -> Result<(), PublishRefused> {
    let reservation = cache.try_reserve(plan.plan().charge() + 4096).unwrap();
    reservation
        .publish(plan)
        .map_err(|rejected| rejected.reason)
}

fn served_rule(cache: &RoutingPlanCache, s: &Settings, zid: i32, seen: Option<i64>) -> String {
    match cache.lookup(&s.capture(), zid, ENV, seen) {
        Lookup::Hit { plan, .. } => plan.plan().key().rule_canonical().to_owned(),
        Lookup::Miss(reason) => panic!("expected a hit, got {}", reason.name()),
    }
}

fn missed(cache: &RoutingPlanCache, s: &Settings, zid: i32, seen: Option<i64>) -> MissReason {
    match cache.lookup(&s.capture(), zid, ENV, seen) {
        Lookup::Hit { .. } => panic!("expected a miss"),
        Lookup::Miss(reason) => reason,
    }
}

// ---- The lock that never waits ----

/// While another thread holds the lock, 10,000 lookups each miss with
/// `lock_busy` within a bound measured against 10,000 uncontended lookups in
/// the same run. A lookup that waited would wait for the whole loop.
#[test]
fn lookup_never_waits() {
    let s = uniform_settings();
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    publish(&cache, plan(7, 41, &s.rule, None, s.digest())).unwrap();
    let capture = s.capture();
    let mut baseline = Duration::ZERO;
    for _ in 0..10_000 {
        let started = Instant::now();
        let found = cache.lookup(&capture, 7, ENV, Some(41));
        baseline = baseline.max(started.elapsed());
        assert!(matches!(found, Lookup::Hit { .. }));
    }
    let bound = (baseline * 10).max(Duration::from_millis(10));
    let held = cache.hold_lock_for_test();
    let worst = finishes_within(Duration::from_secs(10), {
        let cache = cache.clone();
        let capture = s.capture();
        move || {
            let mut worst = Duration::ZERO;
            for _ in 0..10_000 {
                let started = Instant::now();
                let found = cache.lookup(&capture, 7, ENV, Some(41));
                worst = worst.max(started.elapsed());
                assert!(matches!(found, Lookup::Miss(MissReason::LockBusy)));
            }
            worst
        }
    });
    drop(held);
    eprintln!(
        "routing plan lookup: uncontended worst {baseline:?}, contended worst {worst:?}, bound {bound:?}"
    );
    assert!(
        worst < bound,
        "a lookup waited: {worst:?} against {bound:?}"
    );
    // The same holds for a request's reservation.
    let held = cache.hold_lock_for_test();
    let refused = finishes_within(Duration::from_secs(10), {
        let cache = cache.clone();
        move || cache.try_reserve(64).map(|_| ())
    });
    drop(held);
    assert_eq!(refused, Err(NotReserved::LockBusy));
}

/// A poisoned lock is a miss with its reason on every lookup, never a
/// panic; builder-side calls refuse; a reservation dropped afterwards still gives
/// its bytes back.
#[test]
fn lookup_misses_on_poison() {
    let s = uniform_settings();
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    publish(&cache, plan(7, 41, &s.rule, None, s.digest())).unwrap();
    let before = cache.used_for_test();
    let reservation = cache.try_reserve(1000).unwrap();
    let poisoner = cache.clone();
    let poisoned = std::thread::spawn(move || {
        let _held = poisoner.hold_lock_for_test();
        panic!("constructed panic while the lock is held");
    })
    .join();
    assert!(poisoned.is_err());
    for seen in [None, Some(41), Some(42)] {
        assert_eq!(missed(&cache, &s, 7, seen), MissReason::LockPoisoned);
    }
    assert_eq!(
        cache.try_reserve(64).map(|_| ()),
        Err(NotReserved::LockPoisoned)
    );
    assert_eq!(cache.budget(), Err(Poisoned));
    assert_eq!(cache.evict_lru(), Err(Poisoned));
    drop(reservation);
    assert_eq!(cache.used_for_test(), before);
}

// ---- The reservation ----

/// A reservation gives its bytes back when it is dropped: on an early error
/// return, while unwinding, from another thread while the lock is held
/// (through the return channel, drained by the next builder-side call), and
/// after a shrink, which keeps what it was cut down to.
#[test]
fn reservation_released_on_error_and_unwind() {
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, None).unwrap();
    let base = cache.used_for_test();

    fn fails(cache: &Arc<RoutingPlanCache>) -> Result<(), &'static str> {
        let _reservation = cache.try_reserve(1000).map_err(|_| "no room")?;
        Err("constructed failure after reserving")
    }
    assert!(fails(&cache).is_err());
    assert_eq!(cache.used_for_test(), base);

    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _reservation = cache.try_reserve(1000).unwrap();
        panic!("constructed panic while reserved");
    }));
    assert!(unwound.is_err());
    assert_eq!(cache.used_for_test(), base);

    let reservation = cache.try_reserve(1000).unwrap();
    let held = cache.hold_lock_for_test();
    let took = finishes_within(Duration::from_secs(10), move || {
        let started = Instant::now();
        drop(reservation);
        started.elapsed()
    });
    drop(held);
    assert!(took < Duration::from_millis(100), "a drop waited: {took:?}");
    assert_eq!(
        cache.used_for_test(),
        base + 1000,
        "handed over, not yet given back"
    );
    assert_eq!(
        cache.budget().unwrap().0,
        base,
        "the next builder-side call drains it"
    );
    assert_eq!(cache.returns_lost(), 0);

    let mut reservation = cache.try_reserve(5000).unwrap();
    assert_eq!(reservation.shrink(1000), Ok(true));
    assert_eq!(reservation.bytes(), 1000);
    assert_eq!(cache.used_for_test(), base + 1000);
    assert_eq!(
        reservation.shrink(2000),
        Ok(false),
        "a shrink that would grow it is refused, and says so"
    );
    assert_eq!(reservation.bytes(), 1000, "a shrink cannot grow it");
    drop(reservation);
    assert_eq!(cache.used_for_test(), base);
}

/// A reservation dropped while the lock is held and the return channel is
/// full is lost: it is counted, and its bytes stay charged (an over-charge of
/// exactly its size, never an under-charge). The drop still does not wait,
/// and the channel takes returns again once a builder-side call drains it.
#[test]
fn a_lost_return_is_counted_and_stays_charged() {
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, None).unwrap();
    let base = cache.used_for_test();
    let reservations: Vec<Reserved> = (0..=RETURN_SLOTS)
        .map(|_| cache.try_reserve(1).unwrap())
        .collect();
    assert_eq!(cache.used_for_test(), base + RETURN_SLOTS as u64 + 1);
    let held = cache.hold_lock_for_test();
    finishes_within(Duration::from_secs(10), move || drop(reservations));
    drop(held);
    assert_eq!(cache.returns_lost(), 1);
    assert_eq!(
        cache.budget().unwrap().0,
        base + 1,
        "the lost byte stays charged"
    );

    let reservation = cache.try_reserve(1).unwrap();
    let held = cache.hold_lock_for_test();
    finishes_within(Duration::from_secs(10), move || drop(reservation));
    drop(held);
    assert_eq!(cache.returns_lost(), 1, "drained, the channel takes it");
    assert_eq!(cache.budget().unwrap().0, base + 1);
}

/// A reservation holds the one cache it came from: its bytes go back there and
/// nowhere else, and a publication through it lands there. No call takes a
/// reservation together with a cache, and the core's token is never handed out,
/// so the review's witness (a token from one cache released into another)
/// cannot be written.
#[test]
fn reservation_cannot_cross_caches() {
    let s = uniform_settings();
    let first = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    let second = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    let (first_base, second_base) = (first.used_for_test(), second.used_for_test());
    let reservation = first.try_reserve(first_base).unwrap();
    assert_eq!(first.used_for_test(), 2 * first_base);
    assert_eq!(second.used_for_test(), second_base);
    drop(reservation);
    assert_eq!(first.used_for_test(), first_base);
    assert_eq!(second.used_for_test(), second_base);

    publish(&first, plan(7, 41, &s.rule, None, s.digest())).unwrap();
    assert_eq!(served_rule(&first, &s, 7, Some(41)), UNIFORM);
    assert_eq!(missed(&second, &s, 7, Some(41)), MissReason::NoPlan);
    assert_eq!(second.used_for_test(), second_base);
}

// ---- The budget, read once at startup ----

#[test]
fn budget_read_once_at_startup() {
    assert_eq!(cache_bytes_from(None).unwrap(), DEFAULT_CACHE_BYTES);
    assert_eq!(cache_bytes_from(Some("")).unwrap(), DEFAULT_CACHE_BYTES);
    assert_eq!(cache_bytes_from(Some("1048576")).unwrap(), MIN_CACHE_BYTES);
    assert_eq!(cache_bytes_from(Some("67108864")).unwrap(), 64 << 20);
    assert_eq!(
        cache_bytes_from(Some("268435456")).unwrap(),
        MAX_CACHE_BYTES
    );
    for refused in [
        "0",
        "1048575",
        "268435457",
        "18446744073709551616",
        "abc",
        "64MiB",
        "-1",
        "+1048576",
        " 1048576",
        "1048576 ",
        "1048576.0",
    ] {
        assert!(cache_bytes_from(Some(refused)).is_err(), "{refused:?}");
    }
    // Every budget accepted makes a cache.
    for bytes in [MIN_CACHE_BYTES, DEFAULT_CACHE_BYTES] {
        assert!(RoutingPlanCache::new(bytes, None).is_some());
    }
    // Read in one place: the module names the environment once, in the
    // startup reader, and a lookup takes the budget from the cache.
    let source = include_str!("cache.rs");
    assert_eq!(source.matches("std::env").count(), 1);
    let reader = source.find("fn cache_bytes_from_env").unwrap();
    let read = source.find("std::env").unwrap();
    let next_fn = source[reader + 1..].find("\nfn ").map(|at| at + reader + 1);
    assert!(read > reader && next_fn.is_none_or(|end| read < end));
    // The clock is monotonic, nothing touches a file, and no plan has a weak
    // reference that could bring it back.
    for absent in ["SystemTime", "now_ms", "std::fs", "downgrade("] {
        assert!(!source.contains(absent), "{absent}");
    }
}

// ---- The configuration digest ----

/// Two rules, and two parameter sets of one rule, give two digests; so does
/// any other setting; the conversation allowlist is a set. And the review's
/// witness: under one digest a stored-weights plan at a newer tick replaced
/// a uniform one and the lookup could not tell. With the rule in the digest
/// the stored-weights plan is a configuration that is not current, and the
/// uniform plan is what a request under the uniform configuration is served.
#[test]
fn digest_covers_rule_and_parameters() {
    let uniform = uniform_settings();
    let stored = settings(rule(STORED, None), None);
    let floor_a = settings(
        rule(&floor_text(0.1), Some(FLOOR_POLICY)),
        Some(FLOOR_POLICY),
    );
    let floor_b = settings(
        rule(&floor_text(0.2), Some(FLOOR_POLICY)),
        Some(FLOOR_POLICY),
    );
    let digests = [&uniform, &stored, &floor_a, &floor_b].map(Settings::digest);
    for (i, a) in digests.iter().enumerate() {
        for b in &digests[i + 1..] {
            assert_ne!(a, b);
        }
    }
    assert_eq!(uniform.digest(), uniform_settings().digest(), "stable");

    let mut same = uniform_settings();
    same.conversations = vec![9, 7, 9];
    let mut sorted = uniform_settings();
    sorted.conversations = vec![7, 9];
    assert_eq!(same.digest(), sorted.digest());
    let changed: [fn(&mut Settings); 5] = [
        |s| s.mode = Mode::Observe,
        |s| s.count_policy = Some("constructed".into()),
        |s| s.conversations.push(8),
        |s| s.cache_bytes = MIN_CACHE_BYTES,
        |s| s.head_lag_bound_ns += 1,
    ];
    for change in changed {
        let mut other = uniform_settings();
        change(&mut other);
        assert_ne!(other.digest(), uniform.digest(), "{}", other.canonical());
    }

    // The witness.
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(uniform.digest())).unwrap();
    publish(&cache, plan(7, 41, &uniform.rule, None, uniform.digest())).unwrap();
    assert_eq!(
        publish(&cache, plan(7, 42, &stored.rule, None, stored.digest())),
        Err(PublishRefused::Rejected(Rejection::Discarded))
    );
    assert_eq!(served_rule(&cache, &uniform, 7, Some(41)), UNIFORM);
    assert_eq!(
        missed(&cache, &stored, 7, Some(42)),
        MissReason::ConfigDisabled
    );
    // Moving to the stored-weights configuration serves it, and no longer
    // the uniform one.
    cache.set_config(Some(stored.digest())).unwrap();
    publish(&cache, plan(7, 42, &stored.rule, None, stored.digest())).unwrap();
    assert_eq!(served_rule(&cache, &stored, 7, Some(42)), STORED);
    assert_eq!(
        missed(&cache, &uniform, 7, Some(42)),
        MissReason::ConfigDisabled
    );
}

// ---- The builder side's lock hold ----

/// With the fence table full (4,096 conversations, each with a plan) and the
/// negative cache full (1,024 failures), each builder-side call, and the
/// request's slowest lookup (a refused source, which scans the negative
/// cache), holds the lock briefly. Measured and printed; the bound only
/// catches a call that is not bounded.
#[test]
fn builder_side_calls_hold_the_lock_briefly() {
    let s = uniform_settings();
    let d = s.digest();
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(d)).unwrap();
    for zid in 0..4096 {
        publish(&cache, plan(zid, 41, &s.rule, None, d)).unwrap();
    }
    let content = *projection(1, 41).content();
    for tick in 0..1024 {
        let failure = Failure::Source(SourceKey {
            zid: 5000,
            math_env: ENV.into(),
            math_tick: tick,
            content,
        });
        cache.record_failure(failure).unwrap();
    }
    let bound = Duration::from_millis(250);
    let mut measured = Vec::new();
    let mut time = |name: &'static str, call: &mut dyn FnMut()| {
        let started = Instant::now();
        call();
        let took = started.elapsed();
        measured.push((name, took));
        assert!(took < bound, "{name} held the lock for {took:?}");
    };
    let newcomer = plan(4096, 41, &s.rule, None, d);
    let mut reservation = Some(cache.try_reserve(newcomer.plan().charge() + 4096).unwrap());
    let mut fence_full = None;
    time("publish, fence table full", &mut || {
        let reservation = reservation.take().unwrap();
        fence_full = reservation
            .publish(newcomer.clone())
            .err()
            .map(|r| r.reason);
    });
    assert_eq!(
        fence_full,
        Some(PublishRefused::Rejected(Rejection::FenceFull))
    );
    time("lookup, refused source", &mut || {
        let _ = cache.lookup(&s.capture(), 5000, ENV, Some(1023));
    });
    time("note_seen", &mut || cache.note_seen(0, ENV, 42).unwrap());
    time("fenced", &mut || assert!(cache.fenced(0, ENV).unwrap()));
    let extra = Failure::Source(SourceKey {
        zid: 5001,
        math_env: ENV.into(),
        math_tick: 0,
        content,
    });
    time("record_failure, map full", &mut || {
        cache.record_failure(extra.clone()).unwrap();
    });
    time("retry_allowed", &mut || {
        let _ = cache.retry_allowed(&extra).unwrap();
    });
    time("evict_lru", &mut || {
        cache.evict_lru().unwrap();
    });
    time("reclaim", &mut || {
        cache.reclaim().unwrap();
    });
    time("clear", &mut || {
        cache.clear().unwrap();
    });
    time("set_config, new digest", &mut || {
        cache.set_config(Some([9; 32])).unwrap();
    });
    time("set_config, disable", &mut || {
        cache.set_config(None).unwrap();
    });
    for (name, took) in &measured {
        eprintln!("routing plan lock hold: {name}: {took:?}");
    }
}

/// Shutdown stops lookups at once, disables the configuration and destroys
/// every plan nothing borrows; a borrowed plan is destroyed by a later
/// reclamation, after its borrower lets go, and the budget returns to what
/// the empty cache charged.
#[test]
fn shutdown_stops_lookups_and_reclaims() {
    let s = uniform_settings();
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    let empty = cache.used_for_test();
    publish(&cache, plan(7, 41, &s.rule, None, s.digest())).unwrap();
    publish(&cache, plan(8, 41, &s.rule, None, s.digest())).unwrap();
    let Lookup::Hit { plan: borrowed, .. } = cache.lookup(&s.capture(), 7, ENV, Some(41)) else {
        panic!("expected a hit");
    };
    assert_eq!(cache.shutdown().unwrap(), 1);
    assert_eq!(missed(&cache, &s, 8, Some(41)), MissReason::ConfigDisabled);
    assert!(cache.used_for_test() > empty);
    drop(borrowed);
    assert_eq!(cache.reclaim().unwrap(), 1);
    assert_eq!(cache.used_for_test(), empty);
}

// ---- Growing a reservation ----

/// The wrapper's grow keeps when the reservation was taken: a build whose
/// first stage was taken before the cache forgot conversation 7's fence,
/// grown to its plan's stage and cut to the plan's charge, is
/// `FenceForgotten`; a fresh build, grown the same way, publishes.
#[test]
fn reserved_grow_keeps_taking() {
    let s = uniform_settings();
    let d = s.digest();
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(d)).unwrap();
    publish(&cache, plan(7, 41, &s.rule, None, d)).unwrap();
    assert_eq!(cache.evict_lru(), Ok(Some(true)));
    cache.reclaim().unwrap();
    assert!(cache.fenced(7, ENV).unwrap());
    let mut first = cache.try_reserve(1 << 10).unwrap();
    cache.set_config(None).unwrap();
    cache.set_config(Some(d)).unwrap();
    assert!(!cache.fenced(7, ENV).unwrap());
    let older = plan(7, 40, &s.rule, None, d);
    let need = older.plan().charge() + 4096;
    assert_eq!(first.grow(need + (1 << 20)), Ok(true));
    assert_eq!(first.bytes(), need + (1 << 20));
    assert_eq!(first.shrink(need), Ok(true));
    let refused = first.publish(older).unwrap_err();
    assert_eq!(
        refused.reason,
        PublishRefused::Rejected(Rejection::FenceForgotten)
    );
    drop(refused);
    assert_eq!(missed(&cache, &s, 7, None), MissReason::NoPlan);
    let newer = plan(7, 41, &s.rule, None, d);
    let mut fresh = cache.try_reserve(1 << 10).unwrap();
    assert_eq!(fresh.grow(newer.plan().charge() + 4096), Ok(true));
    assert!(fresh.publish(newer).is_ok());
    assert_eq!(served_rule(&cache, &s, 7, None), UNIFORM);
}

/// A refused grow fails at once and leaves the reservation and the charge
/// exactly as they were; a grow, a shrink after it and a drop after it are
/// charged exactly, in the reservation's own cache only, and a drop after a
/// grow returns every byte, also while the lock is held.
#[test]
fn reserved_grow_refused_unchanged_and_drop_returns_all() {
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, None).unwrap();
    let other = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, None).unwrap();
    let (base, other_base) = (cache.used_for_test(), other.used_for_test());
    let share = DEFAULT_CACHE_BYTES / polis_routing_plan::MAX_SHARE_DIVISOR;
    let mut r = cache.try_reserve(1000).unwrap();
    for refused in [share + 1, u64::MAX, 999] {
        let started = Instant::now();
        assert_eq!(r.grow(refused), Ok(false), "{refused}");
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!((r.bytes(), cache.used_for_test()), (1000, base + 1000));
    }
    assert_eq!(r.grow(5000), Ok(true));
    assert_eq!((r.bytes(), cache.used_for_test()), (5000, base + 5000));
    assert_eq!(r.shrink(2000), Ok(true));
    assert_eq!(cache.used_for_test(), base + 2000);
    assert_eq!(r.grow(share), Ok(true));
    assert_eq!(cache.used_for_test(), base + share);
    assert_eq!(other.used_for_test(), other_base);
    drop(r);
    assert_eq!(cache.used_for_test(), base);

    let mut r = cache.try_reserve(1000).unwrap();
    assert_eq!(r.grow(1 << 20), Ok(true));
    let held = cache.hold_lock_for_test();
    finishes_within(Duration::from_secs(10), move || drop(r));
    drop(held);
    assert_eq!(cache.budget().unwrap().0, base);
    assert_eq!(cache.returns_lost(), 0);
    assert_eq!(other.used_for_test(), other_base);
}

/// Two builds that each hold a first stage, with room for one second stage
/// only, are both refused at once, neither waiting for the other; once one
/// is dropped, the other grows.
#[test]
fn two_first_stages_never_wait_for_a_second() {
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, None).unwrap();
    let share = DEFAULT_CACHE_BYTES / polis_routing_plan::MAX_SHARE_DIVISOR;
    let (first, second) = (1u64 << 20, 8u64 << 20);
    let mut fill = Vec::new();
    loop {
        let (used, limit) = cache.budget().unwrap();
        let room = limit - used;
        if room == first + second - 1 {
            break;
        }
        fill.push(
            cache
                .try_reserve((room - (first + second - 1)).min(share))
                .unwrap(),
        );
    }
    let a = cache.try_reserve(first).unwrap();
    let b = cache.try_reserve(first).unwrap();
    let (a, b) = finishes_within(Duration::from_secs(10), move || {
        let (mut a, mut b) = (a, b);
        assert_eq!(a.grow(second), Ok(false));
        assert_eq!(b.grow(second), Ok(false));
        (a, b)
    });
    assert_eq!((a.bytes(), b.bytes()), (first, first));
    drop(b);
    let mut a = a;
    assert_eq!(a.grow(second), Ok(true));
    drop(a);
    drop(fill);
}

/// Builder side only: the request side's calls (`lookup`, `try_reserve`)
/// never grow, the wrapper's grow takes the builder's lock, and no route or
/// participation-path handler names it (or the plan cache at all).
#[test]
fn grow_is_builder_side_only() {
    let wrapper = include_str!("cache.rs");
    let body = |start: &str| {
        let at = wrapper.find(start).unwrap();
        let end = wrapper[at..].find("\n    }\n").unwrap();
        &wrapper[at..at + end]
    };
    for request_side in ["pub(crate) fn lookup(", "pub(crate) fn try_reserve("] {
        assert!(!body(request_side).contains("grow"), "{request_side}");
    }
    let grow = body("pub(crate) fn grow(");
    assert!(grow.contains("self.cache.locked()?"));
    assert!(!grow.contains("try_lock"));
    for (name, text) in [
        ("main.rs", include_str!("../main.rs")),
        ("next_comment.rs", include_str!("../next_comment.rs")),
        ("next_priorities.rs", include_str!("../next_priorities.rs")),
        ("post_votes.rs", include_str!("../post_votes.rs")),
        ("votes_read.rs", include_str!("../votes_read.rs")),
        ("post_comments.rs", include_str!("../post_comments.rs")),
        ("comments.rs", include_str!("../comments.rs")),
    ] {
        assert!(!text.contains(".grow("), "{name} grows a reservation");
        let mentions = text.matches("routing_plan").count();
        let allowed = usize::from(name == "main.rs");
        assert_eq!(mentions, allowed, "{name} names the plan cache");
    }
}
