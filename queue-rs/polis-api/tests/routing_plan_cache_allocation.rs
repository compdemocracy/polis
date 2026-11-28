//! The plan cache's wrapper under a counting allocator (per thread; a moving
//! reallocation counts as an allocation and a free): nothing is allocated or
//! freed between taking and releasing the real lock, on every lookup
//! outcome; and the wrapper's own charges cover what it holds. The wrapper
//! names only `std`, `anyhow`, `polis-routing-plan`, `rand` and `sha2`, so it
//! is compiled here on its own. Constructed conversations only.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

#[path = "../src/routing_plan/cache.rs"]
mod cache;

use cache::{Mode, PlanRef, RoutingPlanCache, Settings, UNDER_LOCK};
use polis_routing_plan::{
    BundleKey, CachedPlan, DEFAULT_CACHE_BYTES, Failure, Lookup, MissReason, Monotonic, Plan,
    Projection, RowIdentity, RuleConfig, SourceKey, SourceLimits,
};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<u64> = const { Cell::new(0) };
    static FREES: Cell<u64> = const { Cell::new(0) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
        ALLOCS.with(|a| a.set(a.get() + 1));
        LIVE.with(|l| l.set(l.get() + size as i64));
    }
}

fn on_free(size: usize) {
    if ON.with(Cell::get) {
        FREES.with(|f| f.set(f.get() + 1));
        LIVE.with(|l| l.set(l.get() - size as i64));
    }
}

// SAFETY: allocation and deallocation use System with matching layouts;
// reallocation explicitly allocates, copies and frees. The counters are
// const-initialised thread locals and never allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        on_alloc(layout.size());
        // SAFETY: the caller's contract is passed through to System.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        on_alloc(layout.size());
        // SAFETY: as above.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        on_free(layout.size());
        // SAFETY: as above.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: GlobalAlloc guarantees a valid nonzero new size and the
        // original alignment remains valid for the replacement allocation.
        let next = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        // SAFETY: next is valid as above.
        let new_ptr = unsafe { self.alloc(next) };
        if !new_ptr.is_null() {
            // SAFETY: both blocks are valid for the smaller of the sizes.
            unsafe { std::ptr::copy_nonoverlapping(ptr, new_ptr, layout.size().min(new_size)) };
            // SAFETY: ptr was allocated with layout.
            unsafe { self.dealloc(ptr, layout) };
        }
        new_ptr
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn reset() {
    ALLOCS.with(|a| a.set(0));
    FREES.with(|a| a.set(0));
    LIVE.with(|a| a.set(0));
}

fn counts() -> (u64, u64) {
    (ALLOCS.with(Cell::get), FREES.with(Cell::get))
}

/// Counting on exactly while the wrapper holds the real lock on a lookup.
fn hook(on: bool) {
    ON.with(|o| o.set(on));
}

const UNIFORM: &str = r#"{"rule":"uniform/1","params":{},"terms":[]}"#;
const ENV: &str = "example";

fn uniform() -> Settings {
    Settings {
        mode: Mode::Serve,
        rule: RuleConfig::parse(UNIFORM, None).unwrap(),
        count_policy: None,
        conversations: vec![7],
        cache_bytes: DEFAULT_CACHE_BYTES,
        head_lag_bound_ns: 1_000_000_000,
    }
}

fn projection(zid: i32, tick: i64) -> Projection {
    let cell = json!({"A": 3, "D": 2, "S": 6});
    let votes = json!({"10": cell, "20": cell});
    let source = json!({
        "tids": [10, 20],
        "pca": {"comment-extremity": [0.5, 1.0]},
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
        "comment-priorities": {"10": 9.0, "20": 2.0}
    });
    let row = RowIdentity {
        zid,
        math_env: ENV.into(),
        math_tick: tick,
        last_vote_timestamp: Some(1_700_000_000_000),
        db_now_ms: 1_700_000_100_000,
    };
    Projection::parse(
        &serde_json::to_vec(&source).unwrap(),
        row,
        &SourceLimits::default(),
    )
    .unwrap()
}

fn plan(zid: i32, tick: i64, s: &Settings) -> PlanRef {
    let p = projection(zid, tick);
    let built = Plan::build(&p.frames(s.rule.needs()).unwrap(), &s.rule).unwrap();
    let key = BundleKey::of(&p, &s.rule, None, s.digest());
    PlanRef::new(CachedPlan::new(key, built, Monotonic::from_nanos(0)).unwrap())
}

/// Every lookup outcome that takes the lock: a current hit, a hit ahead of
/// the request, a lagging hit, `no_plan` with and without a fence,
/// `head_lag` and `refused_source`. Nothing is allocated or freed while the
/// lock is held; the lookups that never take it (`lock_busy`,
/// `lock_poisoned`, `config_disabled` at shutdown) cannot.
#[test]
fn no_alloc_or_drop_under_lock() {
    let s = uniform();
    let capture = s.capture();
    let mut lagless = s.clone();
    lagless.head_lag_bound_ns = 0;
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(s.digest())).unwrap();
    let strict = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(lagless.digest())).unwrap();
    let reserve = |c: &std::sync::Arc<RoutingPlanCache>, p: &PlanRef| {
        c.try_reserve(p.plan().charge() + 4096).unwrap()
    };
    let p = plan(7, 41, &s);
    reserve(&cache, &p).publish(p).unwrap();
    let p = plan(8, 41, &s);
    reserve(&cache, &p).publish(p).unwrap();
    cache.evict_lru().unwrap(); // conversation 7: a fence, no plan
    cache.reclaim().unwrap();
    let p = plan(9, 41, &lagless);
    reserve(&strict, &p).publish(p).unwrap();
    let failure = Failure::Source(SourceKey {
        zid: 10,
        math_env: ENV.into(),
        math_tick: 41,
        content: *projection(10, 41).content(),
    });
    cache.record_failure(failure).unwrap();

    UNDER_LOCK.with(|h| h.set(Some(hook)));
    let mut outcomes = Vec::new();
    for (name, c, cap, zid, seen) in [
        ("hit, current", &cache, capture, 8, Some(41)),
        ("hit, ahead of the request", &cache, capture, 8, Some(40)),
        ("hit, no request tick", &cache, capture, 8, None),
        ("hit, lagging", &cache, capture, 8, Some(42)),
        ("no_plan, fence kept", &cache, capture, 7, Some(41)),
        ("no_plan, unknown", &cache, capture, 99, Some(41)),
        ("refused_source", &cache, capture, 10, Some(41)),
        ("head_lag", &strict, lagless.capture(), 9, Some(42)),
    ] {
        reset();
        let found = c.lookup(&cap, zid, ENV, seen);
        let (allocs, frees) = counts();
        let outcome = match &found {
            Lookup::Hit { .. } => "hit",
            Lookup::Miss(reason) => reason.name(),
        };
        outcomes.push((name, outcome));
        drop(found);
        assert_eq!(
            (allocs, frees),
            (0, 0),
            "{name}: allocations and frees under the lock"
        );
    }
    UNDER_LOCK.with(|h| h.set(None));
    assert_eq!(
        outcomes.iter().map(|(_, o)| *o).collect::<Vec<_>>(),
        [
            "hit",
            "hit",
            "hit",
            "hit",
            MissReason::NoPlan.name(),
            MissReason::NoPlan.name(),
            MissReason::RefusedSource.name(),
            MissReason::HeadLag.name(),
        ],
        "{outcomes:?}"
    );
}

/// What constructing the wrapper allocates (the core's own state, the lock,
/// the return channel) stays within what the empty cache charges.
#[test]
fn wrapper_charges_cover_its_own_memory() {
    reset();
    ON.with(|o| o.set(true));
    let cache = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(uniform().digest())).unwrap();
    ON.with(|o| o.set(false));
    let live = LIVE.with(Cell::get);
    let (charged, _) = cache.budget().unwrap();
    assert!(
        u64::try_from(live).unwrap() <= charged,
        "the wrapper holds {live} bytes and is charged {charged}"
    );
}
