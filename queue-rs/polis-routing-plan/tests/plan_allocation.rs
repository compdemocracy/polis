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

use polis_routing_equation::{
    Candidates, CommentId, ConsensusForm, FloorParams, GicParams, MetaPolicy, ParamSet,
    SymmetricGicParams, SymmetricParams, Unit,
};
use polis_routing_plan::{
    Fallback, MAX_EXCLUDE_META_COMMENTS, MAX_PLAN_CANDIDATES, Plan, Projection, RuleConfig,
    SourceLimits,
};
use serde_json::{Value, json};
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

/// What a build allocates beyond its projection (the frames it reads and the
/// plan it returns) stays within `build_allowance`, known before the source
/// is read, at the largest admitted stored map, for uniform and for the
/// floor under every meta policy.
#[test]
fn build_within_allowance() {
    let limits = SourceLimits::default();
    for (name, config, c) in [
        (
            "stored 40000",
            stored(),
            conversation(12, 40_000, 1, 0, 0, Priorities::Absorbing),
        ),
        (
            "stored none",
            stored(),
            conversation(13, 100, 1, 0, 0, Priorities::Absent),
        ),
        (
            "uniform 40000",
            uniform(),
            conversation(14, 40_000, 1, 0, 0, Priorities::Absorbing),
        ),
        (
            "floor fixed 40000",
            floor(MetaPolicy::Fixed, 0.1),
            conversation(15, 40_000, 5, 10, 0, Priorities::Absent),
        ),
        (
            "floor exclude 10000",
            floor(MetaPolicy::Exclude, 0.1),
            conversation(16, 10_000, 5, 10, 0, Priorities::Absent),
        ),
    ] {
        let allowance = Plan::build_allowance(&config, &limits).unwrap();
        let projection = Projection::parse(&bytes(&c.value), row(), &limits).unwrap();
        let (plan, _, peak, _) = counted(|| {
            let f = projection.frames(config.needs()).unwrap();
            Plan::build(&f, &config).unwrap()
        });
        println!("{name}: peak {peak}, allowance {allowance}");
        assert!(
            peak >= 0 && peak as u64 <= allowance,
            "{name}: peak {peak} over {allowance}"
        );
        assert!(plan.charged_bytes() as u64 <= allowance, "{name}");
    }
}

fn floor_form(policy: MetaPolicy, form: ConsensusForm) -> RuleConfig {
    let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
    let params = FloorParams::new(
        SymmetricGicParams::new(base, form, GicParams::default()),
        0.1,
    )
    .unwrap();
    let plain = ParamSet::SymmetricGicFloor2(params).to_plain();
    RuleConfig::parse(&plain, Some("base-counts:lag-0")).unwrap()
}

/// The frames and the floor's build, measured together, never above
/// `build_bound` for the parsed tally, and the plan they leave never above
/// its `charged_bytes`: every meta policy, both forms of group-informed
/// consensus, the most groups the limits admit, many comments, many meta
/// comments, and meta comments in no other key.
#[test]
fn floor_build_within_its_bound() {
    let limits = SourceLimits::default();
    let shapes: [(&str, u64, usize, u32, usize, usize); 5] = [
        ("64 groups", 41, 600, 64, 7, 0),
        ("5 groups 10000", 42, 10_000, 5, 10, 0),
        ("all meta", 43, 3000, 3, 1, 0),
        ("meta only", 44, 2000, 2, 3, 5000),
        ("one group", 45, 5000, 1, 0, 0),
    ];
    for policy in [MetaPolicy::Fixed, MetaPolicy::Exclude, MetaPolicy::Ordinary] {
        for form in [ConsensusForm::GicMean1, ConsensusForm::GicGeomean1] {
            let config = floor_form(policy, form);
            for (name, seed, n, groups, every, only) in shapes {
                let c = conversation(seed, n, groups, every, only, Priorities::Absent);
                let projection = Projection::parse(&bytes(&c.value), row(), &limits).unwrap();
                let bound =
                    Plan::build_bound(&config, projection.tally(), projection.raw_len()).unwrap();
                let (built, _, peak, held) = counted(|| {
                    let f = projection.frames(config.needs()).unwrap();
                    Plan::build(&f, &config)
                });
                let label = format!("{name} {policy:?} {form:?}");
                assert!(
                    peak >= 0 && peak as u64 <= bound,
                    "{label}: peak {peak} over {bound}"
                );
                if let Ok(plan) = built {
                    let charge = plan.charged_bytes();
                    assert!(
                        held >= 0 && held as usize <= charge,
                        "{label}: held {held} over {charge}"
                    );
                    assert!(charge as u64 <= bound, "{label}");
                    println!("{label}: peak {peak}, bound {bound}, held {held}, charged {charge}");
                } else {
                    println!("{label}: refused {built:?}; peak {peak}, bound {bound}");
                }
            }
        }
    }
}

/// The four numbers at size, for constructed conversations of 10,000 and
/// 40,000 comments in five groups (the floor, meta policy fixed): the
/// projection's length; the parse's peak against its charge; the frames and
/// build's peak against `build_bound` and against `build_allowance` at a
/// byte limit of that length; the plan's held bytes against its charge;
/// and every term of the bound by name.
#[test]
fn witnesses_at_size() {
    let config = floor(MetaPolicy::Fixed, 0.1);
    for (n, seed) in [(10_000usize, 51u64), (40_000, 52)] {
        let c = conversation(seed, n, 5, 20, 0, Priorities::Absent);
        let source = bytes(&c.value);
        let len = source.len();
        let limits = SourceLimits {
            max_bytes: len as u64,
            ..SourceLimits::default()
        };
        let charge = Projection::parse_reservation(len, &limits).unwrap();
        let (parsed, _, parse_peak, _) = counted(|| Projection::parse(&source, row(), &limits));
        let projection = parsed.unwrap();
        let bound = Plan::build_bound(&config, projection.tally(), projection.raw_len()).unwrap();
        // Every term of the bound by name; they add up to it.
        let mut terms = Vec::new();
        Plan::build_bound_terms(
            &config,
            projection.tally(),
            projection.raw_len(),
            |name, bytes| terms.push((name, bytes)),
        )
        .unwrap();
        for (name, bytes) in &terms {
            println!("{n} comments: {name}: {bytes}");
        }
        assert_eq!(terms.iter().map(|t| t.1).sum::<u64>(), bound);
        let allowance = Plan::build_allowance(&config, &limits).unwrap();
        let (plan, _, build_peak, held) = counted(|| {
            let f = projection.frames(config.needs()).unwrap();
            Plan::build(&f, &config).unwrap()
        });
        let charged = plan.charged_bytes();
        println!(
            "{n} comments: projection {len} bytes; parse peak {parse_peak} of charge {charge}; \
             build peak {build_peak} of bound {bound} (allowance at {len} bytes: {allowance}); \
             plan held {held} of charged {charged}"
        );
        assert!(parse_peak >= 0 && parse_peak as u64 <= charge);
        assert!(build_peak >= 0 && build_peak as u64 <= bound);
        assert!(bound <= allowance);
        assert!(held >= 0 && held as usize <= charged);
    }
}

/// Every counted entry owns two bytes of a complete source, so all the
/// counts together are at most half its length (`build_allowance` caps the
/// counts so). The densest sources reach it: arrays of one-digit numbers,
/// lists of one-element lists, and objects of the shortest entries.
#[test]
fn counted_entries_within_half_the_source() {
    let n = 5000;
    let zeros = || vec![json!(0); n];
    let lists: Vec<Value> = (0..n).map(|_| json!([0])).collect();
    let short: serde_json::Map<String, Value> = (0..n)
        .map(|i| (format!("{}", i % 10_000), json!(0)))
        .collect();
    let sources = [
        json!({"tids": zeros(), "meta-tids": zeros(), "pca": {"comment-extremity": zeros()}}),
        json!({"base-clusters": {"id": zeros(), "members": lists}}),
        json!({"group-clusters": lists_of_lists(n)}),
        json!({"comment-priorities": short}),
        json!({"group-votes": {"0": {"votes": short_votes(n)}}}),
    ];
    let limits = SourceLimits {
        max_comments: 1_000_000,
        max_cells: 1_000_000,
        ..SourceLimits::default()
    };
    for v in sources {
        let b = bytes(&v);
        let p = Projection::parse(&b, row(), &limits).unwrap();
        let t = p.tally();
        let all = t.groups + t.cells + t.tids + t.meta + t.extremity + t.priorities + t.memberships;
        println!("{} bytes: {all} entries", b.len());
        assert!(
            2 * all <= b.len() as u64,
            "{all} entries in {} bytes",
            b.len()
        );
        assert!(all >= 1000);
    }
}

fn lists_of_lists(n: usize) -> Value {
    Value::Array((0..n).map(|_| json!({"members": [0]})).collect())
}

fn short_votes(n: usize) -> Value {
    Value::Object((0..n).map(|i| (i.to_string(), json!(0))).collect())
}

/// `build_allowance` fills the counts greedily, which finds the largest
/// bound only when the bound is a sum of terms linear in one count each:
/// for every rule, the bound at a sum of two tallies plus the bound at zero
/// is the sum of the bounds at each.
#[test]
fn build_bound_is_affine_in_the_counts() {
    use polis_routing_plan::Tally;
    let mut rng = XorShift(7);
    let tally = |rng: &mut XorShift| Tally {
        groups: rng.below(64),
        cells: rng.below(100_000),
        tids: rng.below(40_000),
        meta: rng.below(40_000),
        extremity: rng.below(40_000),
        priorities: rng.below(40_000),
        memberships: rng.below(1_000_000),
        longest_string: 0,
    };
    for config in [stored(), uniform(), floor(MetaPolicy::Fixed, 0.1)] {
        for _ in 0..50 {
            let (a, b) = (tally(&mut rng), tally(&mut rng));
            let sum = Tally {
                groups: a.groups + b.groups,
                cells: a.cells + b.cells,
                tids: a.tids + b.tids,
                meta: a.meta + b.meta,
                extremity: a.extremity + b.extremity,
                priorities: a.priorities + b.priorities,
                memberships: a.memberships + b.memberships,
                longest_string: 0,
            };
            let f = |t: &Tally| Plan::build_bound(&config, t, 1000).unwrap();
            assert_eq!(f(&sum) + f(&Tally::default()), f(&a) + f(&b));
        }
    }
}
