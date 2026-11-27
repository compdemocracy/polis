//! The cache's memory, counted by a counting allocator (per thread, as in
//! `tests/allocation.rs`, with a moving reallocation counted as holding the
//! old and the new buffer): a lookup allocates and frees nothing, and
//! everything the cache holds is within what it charges.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_plan::{
    BundleKey, CACHE_FIXED, CachedPlan, ConfigCapture, Failure, Lookup, MissReason, Monotonic,
    Plan, PlanCache, PlanHandle, Projection, Published, RETIRED_ENTRIES, RuleConfig, SourceKey,
    SourceLimits,
};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;
use support::*;

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

/// Runs `f` with counting on; returns its result, allocations, frees and
/// the change in live bytes.
fn counted<T>(f: impl FnOnce() -> T) -> (T, u64, u64, i64) {
    ALLOCS.with(|a| a.set(0));
    FREES.with(|a| a.set(0));
    LIVE.with(|a| a.set(0));
    ON.with(|o| o.set(true));
    let out = f();
    ON.with(|o| o.set(false));
    (
        out,
        ALLOCS.with(Cell::get),
        FREES.with(Cell::get),
        LIVE.with(Cell::get),
    )
}

#[derive(Clone)]
struct H(Arc<CachedPlan>);

impl PlanHandle for H {
    fn cached(&self) -> &CachedPlan {
        &self.0
    }
    fn sole_owner(&self) -> bool {
        Arc::strong_count(&self.0) == 1
    }
}

const D: [u8; 32] = [3; 32];

fn handle(zid: i32, env: &str, tick: i64, n: usize, rule: &RuleConfig) -> H {
    let ids: Vec<i32> = (0..n as i32).collect();
    let prio: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|i| (i.to_string(), json!(1.5))).collect();
    let mut v = tiny(&[]);
    let o = v.as_object_mut().unwrap();
    o.insert("tids".into(), json!(ids));
    o.insert("pca".into(), json!({"comment-extremity": vec![0.5; n]}));
    o.remove("group-votes");
    o.insert("comment-priorities".into(), json!(prio));
    let mut r = row();
    r.zid = zid;
    r.math_env = env.into();
    r.math_tick = tick;
    let p = Projection::parse(&bytes(&v), r, &SourceLimits::default()).unwrap();
    let plan = Plan::build(&p.frames(rule.needs()).unwrap(), rule).unwrap();
    H(Arc::new(
        CachedPlan::new(
            BundleKey::of(&p, rule, None, D),
            plan,
            Monotonic::from_nanos(0),
        )
        .unwrap(),
    ))
}

fn publish(c: &mut PlanCache<H>, h: H) {
    let r = c.try_reserve(h.cached().charge() + 4096).unwrap();
    assert!(matches!(
        c.publish(h, r, Monotonic::from_nanos(0)),
        Published::Ready
    ));
}

/// A lookup allocates nothing and frees nothing, on every outcome: a hit,
/// a lagging hit, a head-lag miss, a miss with the negative cache scanned,
/// and a disabled configuration.
#[test]
fn no_alloc_or_drop_under_lookup() {
    let mut c: PlanCache<H> = PlanCache::new(64 << 20, Some(D)).unwrap();
    for zid in 0..50 {
        publish(&mut c, handle(zid, "example", 41, 8, &stored()));
    }
    let content = *handle(99, "example", 41, 2, &uniform())
        .cached()
        .key()
        .content();
    for tick in 0..1000 {
        c.record_failure(
            Failure::Source(SourceKey {
                zid: 99,
                math_env: "example".into(),
                math_tick: tick,
                content,
            }),
            Monotonic::from_nanos(0),
            0,
        );
    }
    let cap = ConfigCapture::new(D, 1_000);
    let other = ConfigCapture::new([4; 32], 1_000);
    let mut out: Vec<Option<MissReason>> = Vec::with_capacity(16);
    let ((), allocs, frees, _) = counted(|| {
        let mut run = |cap: &ConfigCapture, zid, seen, now| {
            let r = match c.lookup(cap, zid, "example", seen, Monotonic::from_nanos(now)) {
                Lookup::Hit { plan, .. } => {
                    drop(plan); // not the last reference
                    None
                }
                Lookup::Miss(r) => Some(r),
            };
            out.push(r);
        };
        run(&cap, 3, Some(41), 1);
        run(&cap, 3, None, 2);
        run(&cap, 4, Some(42), 3); // lagging
        run(&cap, 4, Some(42), 2_000); // head lag
        run(&cap, 99, Some(500), 4); // refused source, negative cache scanned
        run(&cap, 98, Some(500), 4); // no plan
        run(&other, 3, Some(41), 5); // disabled
    });
    assert_eq!((allocs, frees), (0, 0));
    assert_eq!(
        out,
        vec![
            None,
            None,
            None,
            Some(MissReason::HeadLag),
            Some(MissReason::RefusedSource),
            Some(MissReason::NoPlan),
            Some(MissReason::ConfigDisabled)
        ]
    );
}

/// What the cache holds, counted by the allocator, never exceeds what it
/// charges: its own fixed part, plans of three sizes across conversations
/// and environments (their keys, slots, map nodes and handles), and full
/// negative-cache maps.
#[test]
fn charge_covers_metadata() {
    let (made, _, _, live) = counted(|| PlanCache::<H>::new(256 << 20, Some(D)));
    let mut c = made.unwrap();
    let fixed = c.budget().used();
    assert!(live as u64 <= fixed, "made: {live} live, {fixed} charged");
    assert!(fixed >= CACHE_FIXED + (RETIRED_ENTRIES * 16) as u64);

    let ((), _, _, live) = counted(|| {
        for zid in 0..40 {
            for (e, env) in ["a", "a-much-longer-environment-name", "b"]
                .iter()
                .enumerate()
            {
                let rule = if (zid + e as i32) % 2 == 0 {
                    stored()
                } else {
                    uniform()
                };
                let n = [1, 64, 2_000][(zid as usize + e) % 3];
                publish(&mut c, handle(zid, env, 41, n, &rule));
            }
        }
    });
    let charged = c.budget().used() - fixed;
    assert!(
        live > 0 && live as u64 <= charged,
        "plans: {live} live, {charged} charged"
    );

    let before = c.budget().used();
    let content = *handle(1, "a", 1, 1, &uniform()).cached().key().content();
    let ((), _, _, live) = counted(|| {
        for tick in 0..1024 {
            let sk = SourceKey {
                zid: 1,
                math_env: "a-much-longer-environment-name".into(),
                math_tick: tick,
                content,
            };
            c.record_failure(Failure::Source(sk.clone()), Monotonic::from_nanos(0), 0);
            c.record_failure(Failure::Build(sk, D), Monotonic::from_nanos(0), 0);
        }
    });
    let charged = c.budget().used() - before;
    assert!(
        live as u64 <= charged,
        "negatives: {live} live, {charged} charged"
    );
}

/// A lookup that finds a fence and no plan takes the seen tick in place:
/// nothing allocated, nothing freed.
#[test]
fn no_alloc_or_drop_when_a_fence_has_no_plan() {
    let mut c: PlanCache<H> = PlanCache::new(64 << 20, Some(D)).unwrap();
    publish(&mut c, handle(3, "example", 41, 8, &stored()));
    assert_eq!(c.evict_lru(), Some(true));
    let cap = ConfigCapture::new(D, 1_000);
    let mut out: Vec<bool> = Vec::with_capacity(4);
    let ((), allocs, frees, _) = counted(|| {
        for (seen, now) in [(Some(42), 1), (Some(43), 2), (None, 3)] {
            let r = c.lookup(&cap, 3, "example", seen, Monotonic::from_nanos(now));
            out.push(matches!(r, Lookup::Miss(MissReason::NoPlan)));
        }
    });
    assert_eq!((allocs, frees), (0, 0));
    assert_eq!(out, vec![true; 3]);
}

/// A grow, accepted or refused, and a shrink after it allocate nothing and
/// free nothing: they are arithmetic on the reservation and the budget.
#[test]
fn grow_allocates_nothing() {
    let mut c: PlanCache<H> = PlanCache::new(64 << 20, Some(D)).unwrap();
    let share = c.max_share();
    let r = c.try_reserve(1 << 10).unwrap();
    let (r, allocs, frees, live) = counted(|| {
        let r = c.grow(r, share + 1).unwrap_err();
        let r = c.grow(r, 1 << 20).unwrap();
        let r = c.shrink(r, 1 << 12).unwrap();
        let r = c.grow(r, 1 << 12).unwrap();
        c.grow(r, 1 << 16).unwrap()
    });
    assert_eq!((allocs, frees, live), (0, 0, 0));
    assert_eq!(r.bytes(), 1 << 16);
    c.release(r);
}
