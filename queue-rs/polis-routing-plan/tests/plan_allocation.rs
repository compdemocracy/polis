//! What a plan holds and what one draw allocates, counted by a counting
//! allocator (per thread, as in `tests/allocation.rs`, with a moving
//! reallocation counted as holding the old and the new buffer).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{Candidates, CommentId, MetaPolicy, Unit};
use polis_routing_plan::{
    Fallback, MAX_EXCLUDE_META_COMMENTS, MAX_PLAN_CANDIDATES, Plan, RuleConfig,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use support::*;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static REQUESTED: Cell<u64> = const { Cell::new(0) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
    static SIZE: Cell<usize> = const { Cell::new(0) };
    static HITS: Cell<u64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
        REQUESTED.with(|r| r.set(r.get() + size as u64));
        if SIZE.with(Cell::get) == size {
            HITS.with(|h| h.set(h.get() + 1));
        }
        LIVE.with(|l| {
            let live = l.get() + size as i64;
            l.set(live);
            PEAK.with(|p| p.set(p.get().max(live)));
        });
    }
}

fn on_free(size: usize) {
    if ON.with(Cell::get) {
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
        let next_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        // SAFETY: next_layout is valid as above.
        let next = unsafe { System.alloc(next_layout) };
        if !next.is_null() {
            on_alloc(new_size);
            // SAFETY: these distinct allocations hold at least this many
            // bytes; on success ownership moves and the original is freed.
            unsafe {
                std::ptr::copy_nonoverlapping(ptr, next, layout.size().min(new_size));
                System.dealloc(ptr, layout);
            }
            on_free(layout.size());
        }
        next
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Runs `f`: what it gives back, the bytes requested in all, the peak of
/// live bytes above the start, and the live bytes still held at the end.
fn counted<T>(f: impl FnOnce() -> T) -> (T, u64, i64, i64) {
    REQUESTED.with(|r| r.set(0));
    LIVE.with(|l| l.set(0));
    PEAK.with(|p| p.set(0));
    HITS.with(|h| h.set(0));
    ON.with(|o| o.set(true));
    let out = f();
    ON.with(|o| o.set(false));
    (
        out,
        REQUESTED.with(Cell::get),
        PEAK.with(Cell::get),
        LIVE.with(Cell::get),
    )
}

/// A list one above the bound allocates nothing.
#[test]
fn request_bound_before_copy() {
    let config = floor(MetaPolicy::Exclude, 0.1);
    let plan = Plan::build(&frames(&tiny(&[10]), &config), &config).unwrap();
    let long: Vec<i32> = (0..=MAX_EXCLUDE_META_COMMENTS as i32).collect();
    let (out, requested, _, _) = counted(|| plan.draw(&long, 0.5));
    assert_eq!(out, Err(Fallback::TooManyCandidates));
    assert_eq!(requested, 0);
    let plan = Plan::build(&frames(&tiny(&[]), &uniform()), &uniform()).unwrap();
    let long: Vec<i32> = (0..=MAX_PLAN_CANDIDATES as i32).collect();
    let (out, requested, _, _) = counted(|| plan.draw(&long, 0.5));
    assert_eq!(out, Err(Fallback::TooManyCandidates));
    assert_eq!(requested, 0);
    assert_eq!(plan.draw_reservation(long.len()), Some(0));
}

/// The plans the draw-scratch and charge tests use: each variant at its
/// largest admitted size, and smaller ones.
fn cases() -> Vec<(String, Plan, Vec<i32>)> {
    let mut out = vec![];
    for n in [2usize, 7, 1000, MAX_EXCLUDE_META_COMMENTS] {
        let c = conversation(n as u64, n, 3, 10, 0, Priorities::Absent);
        let config = floor(MetaPolicy::Exclude, 0.1);
        let plan = Plan::build(&frames(&c.value, &config), &config).unwrap();
        out.push((format!("floor exclude {n}"), plan, c.tids));
    }
    for n in [1usize, 1000, MAX_PLAN_CANDIDATES] {
        let c = conversation(n as u64 + 3, n, 3, 10, 0, Priorities::Absorbing);
        for (name, config) in [
            ("floor fixed", floor(MetaPolicy::Fixed, 0.1)),
            (
                "floor zero share",
                RuleConfig::SymmetricGicFloor2(floor_params(MetaPolicy::Ordinary, 0.0)),
            ),
            ("stored absorbing", stored()),
            ("uniform", uniform()),
        ] {
            let plan = Plan::build(&frames(&c.value, &config), &config).unwrap();
            out.push((format!("{name} {n}"), plan, c.tids.clone()));
        }
    }
    out
}

/// Everything one draw allocates, its receipt included, stays within the
/// reservation computed before it, at every admitted size up to the bound.
#[test]
fn draw_scratch_within_reservation() {
    for (name, plan, tids) in cases() {
        let reserved = plan.draw_reservation(tids.len()).unwrap();
        let (out, requested, peak, _) = counted(|| plan.draw(&tids, 0.37));
        assert!(out.is_ok(), "{name}: {out:?}");
        println!("{name}: reserved {reserved}, requested {requested}, peak {peak}");
        assert!(
            peak >= 0 && peak as u64 <= reserved,
            "{name}: peak {peak} over {reserved}"
        );
        assert!(
            requested <= reserved,
            "{name}: requested {requested} over {reserved}"
        );
        drop(out);
    }
}

/// What a built plan still holds is never above its charge, at the
/// benchmark's sizes and at constructed worst cases.
#[test]
fn charge_never_below_measured() {
    for (name, config, c) in [
        (
            "floor exclude 10000",
            floor(MetaPolicy::Exclude, 0.1),
            conversation(5, 10_000, 3, 10, 0, Priorities::Absent),
        ),
        (
            "floor fixed 10000",
            floor(MetaPolicy::Fixed, 0.1),
            conversation(6, 10_000, 3, 10, 0, Priorities::Absent),
        ),
        (
            "floor fixed 40000",
            floor(MetaPolicy::Fixed, 0.1),
            conversation(7, 40_000, 3, 10, 0, Priorities::Absent),
        ),
        (
            "floor ordinary meta only",
            floor(MetaPolicy::Ordinary, 0.1),
            conversation(8, 2000, 2, 3, 5000, Priorities::Absent),
        ),
        (
            "stored 40000",
            stored(),
            conversation(9, 40_000, 1, 0, 0, Priorities::Absorbing),
        ),
        (
            "stored none",
            stored(),
            conversation(10, 100, 1, 0, 0, Priorities::Absent),
        ),
        (
            "uniform",
            uniform(),
            conversation(11, 100, 1, 0, 0, Priorities::Absent),
        ),
    ] {
        let f = frames(&c.value, &config);
        let (plan, _, _, held) = counted(|| Plan::build(&f, &config).unwrap());
        let charge = plan.charged_bytes();
        println!("{name}: held {held}, charged {charge}");
        assert!(
            held >= 0 && held as usize <= charge,
            "{name}: held {held} over {charge}"
        );
        // The benchmark's retained figures for floor plans at these sizes.
        if name == "floor fixed 10000" || name == "floor exclude 10000" {
            assert!(charge >= 2_089_074, "{name}");
        }
        if name == "floor fixed 40000" {
            assert!(charge >= 8_356_762, "{name}");
        }
    }
}

/// The floor wrapper makes one library draw and nothing else of its size:
/// every vector of length n the library's draw makes is made the same number
/// of times as by a direct `FloorPlan::draw`; a `probabilities` call first
/// would add four.
#[test]
fn draw_is_one_call_never_probabilities() {
    let n = 1237;
    let c = conversation(31, n, 3, 0, 0, Priorities::Absent);
    let config = floor(MetaPolicy::Fixed, 0.1);
    let f = frames(&c.value, &config);
    let plan = Plan::build(&f, &config).unwrap();
    let ids: Vec<CommentId> = c.tids.iter().map(|t| CommentId::new(*t as u32)).collect();
    let cands = Candidates::new(ids).unwrap();
    let unit = Unit::new(0.61).unwrap();
    SIZE.with(|s| s.set(n * size_of::<f64>()));
    let (direct, _, _, _) = counted(|| {
        plan.floor()
            .unwrap()
            .draw(&cands, unit, f.source(), f.source())
    });
    let direct_hits = HITS.with(Cell::get);
    let (got, _, _, _) = counted(|| plan.draw(&c.tids, 0.61));
    let plan_hits = HITS.with(Cell::get);
    SIZE.with(|s| s.set(0));
    assert_eq!(got.unwrap().drawn().to_plain(), direct.unwrap().to_plain());
    assert!(direct_hits >= 5, "{direct_hits}");
    assert_eq!(plan_hits, direct_hits);
}
