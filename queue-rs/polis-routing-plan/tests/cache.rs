//! The byte-accounted cache of plans: keys and fencing, freshness, the two
//! proofs that the cache is only a cache, the byte bounds, eviction and
//! fairness, and retirement and reclamation. Constructed conversations only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_plan::{
    BundleKey, CachedPlan, ConfigCapture, DEFAULT_CACHE_BYTES, Failure, Freshness, KeyMismatch,
    Lookup, MissReason, Monotonic, Plan, PlanCache, PlanHandle, Projection, Published,
    RETIRED_ENTRIES, RETRY_BASE_NS, RETRY_CAP_NS, Recorded, Rejection, RuleConfig, SourceKey,
    SourceLimits, WantedKey, retry_delay_ns,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;
use support::*;

const A: [u8; 32] = [1; 32];
const B: [u8; 32] = [2; 32];
const BOUND: u64 = 1_000;

/// The caller's shared handle, as polis-api would hold it, with a record
/// of the thread each plan was destroyed on.
#[derive(Clone)]
struct H(Arc<Tracked>);

struct Tracked {
    cached: CachedPlan,
    dropped_on: Arc<Mutex<Vec<ThreadId>>>,
}

impl Drop for Tracked {
    fn drop(&mut self) {
        self.dropped_on
            .lock()
            .unwrap()
            .push(std::thread::current().id());
    }
}

impl PlanHandle for H {
    fn cached(&self) -> &CachedPlan {
        &self.0.cached
    }
    fn sole_owner(&self) -> bool {
        Arc::strong_count(&self.0) == 1
    }
}

fn t(n: u64) -> Monotonic {
    Monotonic::from_nanos(n)
}

fn cap(digest: [u8; 32]) -> ConfigCapture {
    ConfigCapture::new(digest, BOUND)
}

/// Comments 10 and 20, stored weights `[w10, w20]`.
fn source(w10: f64, w20: f64) -> Value {
    let mut v = tiny(&[]);
    let o = v.as_object_mut().unwrap();
    o.insert("tids".into(), json!([10, 20]));
    o.insert("pca".into(), json!({"comment-extremity": [0.5, 1.0]}));
    let cell = json!({"A": 2, "D": 1, "S": 4});
    o.insert(
        "group-votes".into(),
        json!({"0": {"id": 0, "n-members": 5, "votes": {"10": cell, "20": cell}},
               "1": {"id": 1, "n-members": 6, "votes": {"10": cell, "20": cell}}}),
    );
    o.insert("comment-priorities".into(), json!({"10": w10, "20": w20}));
    v
}

fn projection(zid: i32, env: &str, tick: i64, v: &Value) -> Projection {
    let mut r = row();
    r.zid = zid;
    r.math_env = env.into();
    r.math_tick = tick;
    Projection::parse(&bytes(v), r, &SourceLimits::default()).unwrap()
}

struct Maker {
    dropped_on: Arc<Mutex<Vec<ThreadId>>>,
}

impl Maker {
    fn new() -> Self {
        Self {
            dropped_on: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn plan(&self, zid: i32, env: &str, tick: i64, v: &Value, rule: &RuleConfig, d: [u8; 32]) -> H {
        let p = projection(zid, env, tick, v);
        let plan = Plan::build(&p.frames(rule.needs()).unwrap(), rule).unwrap();
        let cached = CachedPlan::new(BundleKey::of(&p, rule, None, d), plan, t(0)).unwrap();
        H(Arc::new(Tracked {
            cached,
            dropped_on: self.dropped_on.clone(),
        }))
    }
    fn uniform(&self, zid: i32, tick: i64, d: [u8; 32]) -> H {
        self.plan(zid, "example", tick, &source(9.0, 1.0), &uniform(), d)
    }
    fn drops(&self) -> Vec<ThreadId> {
        self.dropped_on.lock().unwrap().clone()
    }
}

fn cache(d: Option<[u8; 32]>) -> PlanCache<H> {
    PlanCache::new(DEFAULT_CACHE_BYTES, d).unwrap()
}

fn publish(c: &mut PlanCache<H>, h: H, now: u64) -> Result<(), Rejection> {
    let r = c.try_reserve(h.cached().charge() + 4096).unwrap();
    match c.publish(h, r, t(now)) {
        Published::Ready => Ok(()),
        Published::Rejected {
            handle,
            reservation,
            reason,
        } => {
            drop(handle);
            c.release(reservation);
            Err(reason)
        }
    }
}

fn hit(
    c: &mut PlanCache<H>,
    d: [u8; 32],
    zid: i32,
    seen: Option<i64>,
    now: u64,
) -> (i64, Freshness) {
    match c.lookup(&cap(d), zid, "example", seen, t(now)) {
        Lookup::Hit { plan, freshness } => (plan.cached().key().math_tick(), freshness),
        Lookup::Miss(r) => panic!("expected a hit, got {}", r.name()),
    }
}

fn miss(c: &mut PlanCache<H>, d: [u8; 32], zid: i32, seen: Option<i64>, now: u64) -> MissReason {
    match c.lookup(&cap(d), zid, "example", seen, t(now)) {
        Lookup::Hit { .. } => panic!("expected a miss"),
        Lookup::Miss(r) => r,
    }
}

fn drain(c: &mut PlanCache<H>) -> usize {
    let mut n = 0;
    while let Some(r) = c.reclaim_one() {
        c.credit(r.destroy());
        n += 1;
    }
    n
}

// ---- The two proofs ----

/// Same bytes, configuration, candidates and unit, rebuilt independently in
/// a new cache: identical receipts, bit for bit.
#[test]
fn same_bundle_rebuild_is_identical() {
    let v = source(3.0, 1.5);
    for rule in [stored(), uniform()] {
        let (m1, m2) = (Maker::new(), Maker::new());
        let mut c1 = cache(Some(A));
        let mut c2 = cache(Some(A));
        publish(&mut c1, m1.plan(7, "example", 41, &v, &rule, A), 0).unwrap();
        publish(&mut c2, m2.plan(7, "example", 41, &v, &rule, A), 0).unwrap();
        let get = |c: &mut PlanCache<H>| match c.lookup(&cap(A), 7, "example", Some(41), t(1)) {
            Lookup::Hit { plan, .. } => plan,
            Lookup::Miss(r) => panic!("{}", r.name()),
        };
        let (p1, p2) = (get(&mut c1), get(&mut c2));
        assert_eq!(p1.cached().key(), p2.cached().key());
        let mut rng = XorShift(0x5eed);
        for _ in 0..10_000 {
            let u = rng.unit();
            let a = p1.cached().plan().draw(&[10, 20], u).unwrap();
            let b = p2.cached().plan().draw(&[10, 20], u).unwrap();
            assert_eq!(a.tid(), b.tid());
            assert_eq!(a.drawn().to_plain(), b.drawn().to_plain());
        }
    }
}

/// Today's rule on the read route: running sums of the stored weights, the
/// first above `unit * total`.
fn todays_choice(tids: &[i32], weights: &[f64], unit: f64) -> i32 {
    let total: f64 = weights.iter().sum();
    let mut sum = 0.0;
    for (tid, w) in tids.iter().zip(weights) {
        sum += w;
        if sum > unit * total {
            return *tid;
        }
    }
    panic!("no weighted candidate")
}

/// The witness from review: candidates [10, 20], stored weights [9, 1],
/// unit 0.75. A `uniform/1` plan chooses 20; with the cache emptied, by a
/// clear, an eviction or a stale entry, the lookup misses at once with its
/// reason and today's rule chooses 10. The difference is the labelled
/// fallback, never an error and never a plan from another update.
#[test]
fn cache_loss_falls_back_without_waiting() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    let Lookup::Hit { plan, .. } = c.lookup(&cap(A), 7, "example", Some(41), t(1)) else {
        panic!()
    };
    assert_eq!(
        plan.cached().plan().draw(&[10, 20], 0.75).unwrap().tid(),
        20
    );
    drop(plan);
    assert_eq!(todays_choice(&[10, 20], &[9.0, 1.0], 0.75), 10);
    // The stored-weights plan, the library's form of today's rule, agrees.
    let today = m.plan(7, "example", 41, &source(9.0, 1.0), &stored(), A);
    assert_eq!(
        today.cached().plan().draw(&[10, 20], 0.75).unwrap().tid(),
        10
    );

    // Cleared and reclaimed: no plan, at once.
    assert_eq!(c.clear().retired, 1);
    assert_eq!(drain(&mut c), 1);
    assert_eq!(miss(&mut c, A, 7, Some(41), 2), MissReason::NoPlan);

    // Evicted: no plan.
    publish(&mut c, m.uniform(7, 41, A), 3).unwrap();
    assert_eq!(c.evict_lru(), Some(true));
    assert_eq!(miss(&mut c, A, 7, Some(41), 4), MissReason::NoPlan);

    // Stale: a newer tick seen for longer than the bound misses, and the
    // older plan is never served as current.
    publish(&mut c, m.uniform(7, 50, A), 5).unwrap();
    assert!(matches!(
        hit(&mut c, A, 7, Some(51), 10).1,
        Freshness::Lagging { .. }
    ));
    assert_eq!(
        miss(&mut c, A, 7, Some(51), 10 + BOUND),
        MissReason::HeadLag
    );
}

// ---- Keys and fencing ----

#[test]
fn plan_from_another_read_cannot_be_filed() {
    let a = projection(7, "example", 41, &source(9.0, 1.0));
    let b = projection(7, "example", 42, &source(9.0, 1.0));
    let plan_b = Plan::build(&b.frames(uniform().needs()).unwrap(), &uniform()).unwrap();
    let key_a = BundleKey::of(&a, &uniform(), None, A);
    assert_eq!(
        CachedPlan::new(key_a.clone(), plan_b, t(0)).unwrap_err(),
        KeyMismatch::Source
    );
    let stored_a = Plan::build(&a.frames(stored().needs()).unwrap(), &stored()).unwrap();
    assert_eq!(
        CachedPlan::new(key_a, stored_a, t(0)).unwrap_err(),
        KeyMismatch::Rule
    );
}

#[test]
fn key_carries_everything_built_from() {
    let p = projection(7, "example", 41, &source(9.0, 1.0));
    let k = BundleKey::of(&p, &uniform(), None, A);
    assert_eq!((k.zid(), k.math_env(), k.math_tick()), (7, "example", 41));
    assert_eq!(k.content(), p.content());
    assert_eq!(k.last_vote_timestamp(), p.row().last_vote_timestamp);
    assert_eq!(k.source(), p.source());
    assert_eq!(k.rule_canonical(), uniform().to_plain());
    assert_eq!(k.config_digest(), &A);
    assert_eq!(k.arm(), polis_routing_plan::Arm::Default);
    assert_ne!(k, BundleKey::of(&p, &uniform(), None, B));
    assert_ne!(k, BundleKey::of(&p, &stored(), None, A));
}

#[test]
fn pointer_moves_forward_only() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 45, A), 0).unwrap();
    // A late, older completion is refused and lowers nothing.
    assert_eq!(
        publish(&mut c, m.uniform(7, 43, A), 1),
        Err(Rejection::Superseded)
    );
    assert_eq!(hit(&mut c, A, 7, Some(45), 2), (45, Freshness::Current));
    publish(&mut c, m.uniform(7, 46, A), 3).unwrap();
    assert_eq!(hit(&mut c, A, 7, Some(46), 4), (46, Freshness::Current));
    // The same key again is not a second publication.
    assert_eq!(
        publish(&mut c, m.uniform(7, 46, A), 5),
        Err(Rejection::Superseded)
    );
}

#[test]
fn conflicting_identity_for_one_tick() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    let first = m.plan(7, "example", 41, &source(9.0, 1.0), &uniform(), A);
    let other = m.plan(7, "example", 41, &source(8.0, 1.0), &uniform(), A);
    let first_content = *first.cached().key().content();
    publish(&mut c, first, 0).unwrap();
    assert_eq!(
        publish(&mut c, other, 1),
        Err(Rejection::GenerationConflict)
    );
    assert_eq!(c.generation_conflicts(), 1);
    let Lookup::Hit { plan, .. } = c.lookup(&cap(A), 7, "example", Some(41), t(2)) else {
        panic!()
    };
    assert_eq!(plan.cached().key().content(), &first_content);
}

#[test]
fn disabled_revision_discarded() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    assert_eq!(
        publish(&mut c, m.uniform(7, 41, B), 0),
        Err(Rejection::Discarded)
    );
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    c.set_config(Some(B));
    assert_eq!(
        publish(&mut c, m.uniform(7, 42, A), 1),
        Err(Rejection::Discarded)
    );
    assert_eq!(
        c.resident_len(),
        0,
        "the old configuration's plan was retired"
    );
}

#[test]
fn disabled_configuration_misses() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    assert_eq!(miss(&mut c, B, 7, Some(41), 1), MissReason::ConfigDisabled);
    c.set_config(None);
    assert_eq!(miss(&mut c, A, 7, Some(41), 2), MissReason::ConfigDisabled);
    let mut off: PlanCache<H> = cache(None);
    assert_eq!(miss(&mut off, A, 7, None, 0), MissReason::ConfigDisabled);
}

#[test]
fn other_environment_and_conversation_miss() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    assert!(matches!(
        c.lookup(&cap(A), 7, "other", Some(41), t(1)),
        Lookup::Miss(MissReason::NoPlan)
    ));
    assert_eq!(miss(&mut c, A, 8, Some(41), 1), MissReason::NoPlan);
}

// ---- Freshness ----

#[test]
fn loader_generation_ahead_of_request() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 42, A), 0).unwrap();
    assert_eq!(
        hit(&mut c, A, 7, Some(41), 1),
        (42, Freshness::AheadOfRequest)
    );
}

#[test]
fn missing_request_tick_advances_nothing() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    // Many lookups with no tick, far apart: no clock starts, nothing lags.
    for now in [1, BOUND * 10, BOUND * 100] {
        assert_eq!(hit(&mut c, A, 7, None, now), (41, Freshness::Current));
    }
}

#[test]
fn head_lag_expiry_on_the_monotonic_clock() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    assert_eq!(
        hit(&mut c, A, 7, Some(42), 100).1,
        Freshness::Lagging { behind_ns: 0 }
    );
    assert_eq!(
        hit(&mut c, A, 7, Some(42), 100 + BOUND - 1).1,
        Freshness::Lagging {
            behind_ns: BOUND - 1
        }
    );
    assert_eq!(
        miss(&mut c, A, 7, Some(42), 100 + BOUND),
        MissReason::HeadLag
    );
    // Even a request that read the older tick misses once the newer one
    // has been seen for the bound.
    assert_eq!(
        miss(&mut c, A, 7, Some(41), 100 + BOUND),
        MissReason::HeadLag
    );
    // Full catch-up clears it.
    publish(&mut c, m.uniform(7, 42, A), 200 + BOUND).unwrap();
    assert_eq!(
        hit(&mut c, A, 7, Some(42), 300 + BOUND),
        (42, Freshness::Current)
    );
    // The module reads no clock of its own.
    let src = include_str!("../src/cache.rs");
    for word in ["SystemTime", "Instant", "clock::now_ms", "std::time"] {
        assert!(!src.contains(word), "{word}");
    }
}

#[test]
fn partial_catch_up_keeps_the_clock() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    hit(&mut c, A, 7, Some(44), 10); // the clock starts at 10
    publish(&mut c, m.uniform(7, 42, A), 20).unwrap(); // partial
    hit(&mut c, A, 7, Some(44), 30); // repeated: no reset
    assert_eq!(
        miss(&mut c, A, 7, Some(44), 10 + BOUND),
        MissReason::HeadLag
    );
    // The loader's sight of a tick counts like a request's.
    publish(&mut c, m.uniform(7, 44, A), 20 + BOUND).unwrap();
    c.note_seen(7, "example", 45, t(30 + BOUND));
    assert!(matches!(
        hit(&mut c, A, 7, None, 31 + BOUND).1,
        Freshness::Lagging { behind_ns: 1 }
    ));
}

#[test]
fn sustained_rapid_updates() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 100, A), 0).unwrap();
    // Every step a newer tick is seen and the build stays two behind: the
    // clock runs from the first sight and the plan stops being served.
    let mut served_until = 0;
    for step in 1..=20u64 {
        let now = step * (BOUND / 4);
        let seen = 100 + step as i64 + 1;
        if step > 1 {
            let _ = publish(&mut c, m.uniform(7, seen - 2, A), now);
        }
        if let Lookup::Hit { .. } = c.lookup(&cap(A), 7, "example", Some(seen), t(now)) {
            served_until = now;
        }
    }
    assert!(
        served_until < BOUND / 4 + BOUND,
        "served until {served_until}"
    );
}

// ---- Bytes ----

#[test]
fn budget_full_refuses_reservation() {
    let mut c: PlanCache<H> = PlanCache::new(1 << 20, Some(A)).unwrap();
    let share = c.max_share();
    assert!(c.try_reserve(share + 1).is_none(), "more than a share");
    let mut held = Vec::new();
    while let Some(r) = c.try_reserve(share) {
        held.push(r);
    }
    assert!(c.budget().used() <= c.budget().limit());
    assert!(c.try_reserve(c.budget().available() + 1).is_none());
    let used = c.budget().used();
    for r in held {
        c.release(r);
    }
    assert!(c.budget().used() < used);
}

#[test]
fn undercharged_publication_refused() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    let h = m.uniform(7, 41, A);
    let r = c.try_reserve(h.cached().charge()).unwrap(); // no room for the slot
    match c.publish(h, r, t(0)) {
        Published::Rejected {
            reason,
            reservation,
            ..
        } => {
            assert_eq!(reason, Rejection::Undercharged);
            c.release(reservation);
        }
        Published::Ready => panic!("published under its charge"),
    }
}

#[test]
fn large_source_refused_by_its_charge() {
    let mut c: PlanCache<H> = cache(Some(A));
    let limits = SourceLimits::default();
    let max = limits.max_bytes as usize;
    assert!(
        c.admit_build(max, &limits, 0).is_none(),
        "the 64 MiB limit is not admission"
    );
    let small = c.admit_build(1 << 20, &limits, 1 << 20).unwrap();
    assert!(small.bytes() >= Projection::parse_reservation(1 << 20, &limits).unwrap());
    c.release(small);
    let lower = SourceLimits {
        max_bytes: 1 << 20,
        ..limits
    };
    assert!(
        c.admit_build((1 << 20) + 1, &lower, 0).is_none(),
        "over a lower max_bytes"
    );
}

#[test]
fn charges_return_to_baseline() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    let baseline = c.budget().used();
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    publish(&mut c, m.uniform(7, 42, A), 1).unwrap();
    publish(&mut c, m.uniform(8, 41, A), 1).unwrap();
    let k = Failure::Source(SourceKey {
        zid: 9,
        math_env: "example".into(),
        math_tick: 3,
        content: *projection(9, "example", 3, &source(1.0, 1.0)).content(),
    });
    assert!(matches!(
        c.record_failure(k, t(0), 0),
        Recorded::Held { .. }
    ));
    assert!(c.budget().used() > baseline);
    c.set_config(None);
    drain(&mut c);
    c.note_newer_source(9, "example", 4);
    assert_eq!(c.budget().used(), baseline);
    assert_eq!(m.drops().len(), 3);
}

// ---- Eviction and fairness ----

#[test]
fn max_share_bounds_one_conversation() {
    let m = Maker::new();
    let one = m.uniform(7, 41, A).cached().charge() + polis_routing_plan::SLOT_OVERHEAD + 7;
    // A budget whose share holds two of conversation 7's plans, not three.
    let budget = (one * 2 + 100) * polis_routing_plan::MAX_SHARE_DIVISOR;
    let mut c: PlanCache<H> = PlanCache::new(budget, Some(A)).unwrap();
    let env = |n: usize| format!("e{n:06}");
    for n in 0..2 {
        let h = m.plan(7, &env(n), 41, &source(9.0, 1.0), &uniform(), A);
        publish(&mut c, h, 0).unwrap();
    }
    let third = m.plan(7, &env(2), 41, &source(9.0, 1.0), &uniform(), A);
    assert_eq!(publish(&mut c, third, 0), Err(Rejection::OverShare));
    // Another conversation still gets in.
    let other = m.plan(8, &env(0), 41, &source(9.0, 1.0), &uniform(), A);
    publish(&mut c, other, 0).unwrap();
}

#[test]
fn eviction_is_least_recently_looked_up() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    for zid in [1, 2, 3] {
        publish(&mut c, m.uniform(zid, 41, A), 0).unwrap();
    }
    hit(&mut c, A, 1, Some(41), 1);
    hit(&mut c, A, 3, Some(41), 2);
    assert_eq!(c.evict_lru(), Some(true));
    assert_eq!(miss(&mut c, A, 2, Some(41), 3), MissReason::NoPlan);
    hit(&mut c, A, 1, Some(41), 4);
    assert_eq!(c.evict_lru(), Some(true));
    assert_eq!(miss(&mut c, A, 3, Some(41), 5), MissReason::NoPlan);
    hit(&mut c, A, 1, Some(41), 6);
}

// ---- Retirement and reclamation ----

#[test]
fn request_never_drops_last_reference() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    let Lookup::Hit { plan: borrowed, .. } = c.lookup(&cap(A), 7, "example", Some(41), t(1)) else {
        panic!()
    };
    publish(&mut c, m.uniform(7, 42, A), 2).unwrap(); // replaced
    assert_eq!(c.retired_len(), 1);
    assert!(c.reclaim_one().is_none(), "a reader still holds it");
    // The request drops its reference on its own thread: not the last.
    std::thread::spawn(move || drop(borrowed)).join().unwrap();
    assert!(m.drops().is_empty());
    // Evicted while a reader holds the newer plan: the same.
    let Lookup::Hit { plan: borrowed, .. } = c.lookup(&cap(A), 7, "example", Some(42), t(3)) else {
        panic!()
    };
    assert_eq!(c.evict_lru(), Some(true));
    std::thread::spawn(move || drop(borrowed)).join().unwrap();
    assert!(m.drops().is_empty());
    // Only the builder's reclamation destroys, on the builder's thread.
    assert_eq!(drain(&mut c), 2);
    let me = std::thread::current().id();
    assert_eq!(m.drops(), vec![me, me]);
}

#[test]
fn retired_list_bounded_and_charged() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    let mut readers = Vec::new();
    publish(&mut c, m.uniform(7, 1, A), 0).unwrap();
    for tick in 2..=(RETIRED_ENTRIES as i64 + 1) {
        let Lookup::Hit { plan, .. } = c.lookup(&cap(A), 7, "example", None, t(0)) else {
            panic!()
        };
        readers.push(plan);
        publish(&mut c, m.uniform(7, tick, A), 0).unwrap();
    }
    assert_eq!(c.retired_len(), RETIRED_ENTRIES);
    let before = c.budget().used();
    assert!(c.retired_bytes() > 0 && c.retired_bytes() <= c.retired_max_bytes());
    // Full: a newer publication is refused and the existing plan stays.
    let last = RETIRED_ENTRIES as i64 + 1;
    assert_eq!(
        publish(&mut c, m.uniform(7, last + 1, A), 0),
        Err(Rejection::Busy)
    );
    assert_eq!(hit(&mut c, A, 7, None, 0).0, last);
    // Full-list eviction keeps the owner; a clear keeps it too.
    assert_eq!(c.evict_lru(), Some(false));
    assert_eq!(c.clear().kept, 1);
    assert_eq!(
        c.budget().used(),
        before,
        "nothing freed, nothing uncharged"
    );
    // Idle reclamation, with no build: once the readers are gone.
    assert!(c.reclaim_one().is_none());
    drop(readers);
    assert_eq!(drain(&mut c), RETIRED_ENTRIES);
    assert!(c.budget().used() < before);
}

#[test]
fn retired_bytes_bounded() {
    let m = Maker::new();
    let one = m.uniform(7, 1, A).cached().charge() + polis_routing_plan::SLOT_OVERHEAD + 7;
    // A retired bound in bytes of exactly eight entries, below the list's
    // sixty-four.
    let mut c: PlanCache<H> = PlanCache::new(one * 16, Some(A)).unwrap();
    assert_eq!(c.retired_max_bytes(), one * 8);
    for zid in 0..10 {
        publish(&mut c, m.uniform(zid, 1, A), 0).unwrap();
    }
    let mut moved = 0;
    while c.evict_lru() == Some(true) {
        moved += 1;
    }
    assert_eq!((moved, c.retired_len()), (8, 8));
    assert_eq!(c.retired_bytes(), one * 8);
    assert_eq!(c.resident_len(), 2);
}

#[test]
fn clear_disable_and_shutdown_with_a_borrower() {
    let m = Maker::new();
    let mut c = cache(Some(A));
    publish(&mut c, m.uniform(7, 41, A), 0).unwrap();
    publish(&mut c, m.uniform(8, 41, A), 0).unwrap();
    let Lookup::Hit { plan: borrowed, .. } = c.lookup(&cap(A), 7, "example", None, t(1)) else {
        panic!()
    };
    // Orderly shutdown: no new borrows, plans retired, the borrower's plan
    // waits for it.
    let moved = c.set_config(None);
    assert_eq!((moved.retired, moved.kept), (2, 0));
    assert_eq!(miss(&mut c, A, 7, None, 2), MissReason::ConfigDisabled);
    assert_eq!(drain(&mut c), 1);
    assert_eq!(m.drops().len(), 1);
    drop(borrowed);
    assert_eq!(drain(&mut c), 1);
    assert_eq!(m.drops().len(), 2);
}

// ---- The negative cache ----

#[test]
fn negative_cache_keys_and_bounds() {
    let mut c: PlanCache<H> = cache(Some(A));
    let content = *projection(7, "example", 41, &source(9.0, 1.0)).content();
    let sk = |tick| SourceKey {
        zid: 7,
        math_env: "example".into(),
        math_tick: tick,
        content,
    };
    // A source refusal is not keyed by configuration; a build refusal is.
    c.record_failure(Failure::Source(sk(41)), t(0), 0);
    c.record_failure(Failure::Build(sk(41), A), t(0), 0);
    c.record_failure(
        Failure::BeforeRead(WantedKey {
            zid: 7,
            math_env: "example".into(),
            desired_tick: 42,
        }),
        t(0),
        0,
    );
    assert_eq!(c.negative_counts(), (1, 1, 1));
    assert!(!c.retry_allowed(&Failure::Source(sk(41)), t(1)));
    assert!(c.retry_allowed(&Failure::Build(sk(41), B), t(1)));
    assert!(c.retry_allowed(&Failure::Source(sk(41)), t(RETRY_BASE_NS)));
    // The refusal names the miss when no plan exists.
    assert_eq!(miss(&mut c, A, 7, Some(41), 1), MissReason::RefusedSource);
    assert_eq!(miss(&mut c, A, 7, Some(40), 1), MissReason::NoPlan);
    // A new configuration forgets build refusals only.
    c.set_config(Some(B));
    assert_eq!(c.negative_counts(), (1, 0, 1));
    // A newer source forgets everything older.
    c.note_newer_source(7, "example", 43);
    assert_eq!(c.negative_counts(), (0, 0, 0));
    // Each map is bounded, oldest first.
    for tick in 0..(polis_routing_plan::NEGATIVE_ENTRIES as i64 + 10) {
        c.record_failure(Failure::Source(sk(1000 + tick)), t(0), 0);
    }
    assert_eq!(c.negative_counts().0, polis_routing_plan::NEGATIVE_ENTRIES);
    assert!(
        c.retry_allowed(&Failure::Source(sk(1000)), t(1)),
        "the oldest went"
    );
    assert!(!c.retry_allowed(&Failure::Source(sk(1100)), t(1)));
}

#[test]
fn retry_backoff_capped_with_jitter() {
    assert_eq!(retry_delay_ns(1, 0), RETRY_BASE_NS);
    assert_eq!(retry_delay_ns(2, 0), 2 * RETRY_BASE_NS);
    assert_eq!(retry_delay_ns(40, 0), RETRY_CAP_NS);
    assert_eq!(retry_delay_ns(1, 1000), RETRY_BASE_NS + RETRY_BASE_NS / 4);
    assert_eq!(retry_delay_ns(1, u16::MAX), retry_delay_ns(1, 1000));
    let mut c: PlanCache<H> = cache(Some(A));
    let k = Failure::BeforeRead(WantedKey {
        zid: 1,
        math_env: "example".into(),
        desired_tick: 1,
    });
    c.record_failure(k.clone(), t(0), 0);
    let Recorded::Held { retry_at } = c.record_failure(k, t(0), 0) else {
        panic!()
    };
    assert_eq!(retry_at, t(2 * RETRY_BASE_NS));
}
