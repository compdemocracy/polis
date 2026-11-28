//! The build charged by stage, from exact distinct counts: the frames stage
//! (everything `Projection::frames` allocates) and the build stage (the
//! frames' own maps, the build's scratch and the plan), each measured by a
//! counting allocator (per thread, a moving reallocation counted as holding
//! the old and the new buffer) on constructed conversations, the adversarial
//! shapes among them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    ConsensusForm, FloorParams, GicParams, LatestCountFrame, MetaPolicy, ParamSet,
    SymmetricGicParams, SymmetricParams,
};
use polis_routing_plan::{
    DEFAULT_CACHE_BYTES, FrameCounts, MAX_SHARE_DIVISOR, Plan, Projection, RuleConfig,
    SourceLimits, Tally,
};
use serde_json::{Map, Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeSet;
use support::*;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
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
// reallocation explicitly allocates, copies and frees, so a move is counted
// in full. The counters are const-initialised thread locals and never
// allocate.
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

fn share() -> u64 {
    DEFAULT_CACHE_BYTES / MAX_SHARE_DIVISOR
}

/// One build measured by stage, from a parsed projection: the peak while
/// the frames are read; the live bytes the frames hold once read; the peak
/// from then until the plan is built (the frames still held); the plan's
/// held bytes after the frames are dropped, and its charge.
struct Measured {
    frames_peak: i64,
    retained: i64,
    build_peak: i64,
    held: i64,
    charged: Option<usize>,
    counts: FrameCounts,
    retained_bound: u64,
}

fn measure(projection: &Projection, config: &RuleConfig) -> Measured {
    LIVE.with(|l| l.set(0));
    PEAK.with(|p| p.set(0));
    ON.with(|o| o.set(true));
    let frames = projection.frames(config.needs()).unwrap();
    let frames_peak = PEAK.with(Cell::get);
    let retained = LIVE.with(Cell::get);
    PEAK.with(|p| p.set(retained));
    let built = Plan::build(&frames, config);
    let build_peak = PEAK.with(Cell::get);
    // What the build left beside the frames: the plan it returned.
    let held = LIVE.with(Cell::get) - retained;
    ON.with(|o| o.set(false));
    let charged = built.as_ref().ok().map(Plan::charged_bytes);
    Measured {
        frames_peak,
        retained,
        build_peak,
        held,
        charged,
        counts: frames.counts(),
        retained_bound: frames.retained_bound().unwrap(),
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

/// `peak <= bound`, named; the fraction reached is printed so that a later
/// loosening is noticed.
fn within(label: &str, what: &str, peak: i64, bound: u64) {
    assert!(
        peak >= 0 && peak as u64 <= bound,
        "{label}: {what}: measured {peak}, bound {bound}"
    );
}

fn check(label: &str, projection: &Projection, config: &RuleConfig) -> (Measured, u64, u64) {
    let t = projection.tally();
    let pm = projection.measured();
    let frames_bound =
        Plan::measured_frames_stage_bound(config, t, projection.raw_len(), pm).unwrap();
    assert_eq!(
        Some(frames_bound),
        projection.reservation(config.needs()).ok(),
        "{label}: the frames stage is the projection's reservation"
    );
    let unmeasured_frames = Plan::frames_stage_bound(config, t, projection.raw_len()).unwrap();
    let m = measure(projection, config);
    let build_bound = Plan::build_stage_bound(config, &m.counts).unwrap();
    within(label, "frames stage", m.frames_peak, frames_bound);
    within(label, "frames retained", m.retained, m.retained_bound);
    within(label, "build stage", m.build_peak, build_bound);
    if let Some(charged) = m.charged {
        within(label, "plan held", m.held, charged as u64);
        assert!(
            charged as u64 <= build_bound,
            "{label}: charge over the build stage"
        );
    }
    let staged =
        Plan::measured_staged_build_bound(config, t, projection.raw_len(), pm, &m.counts).unwrap();
    assert_eq!(staged, frames_bound.max(build_bound));
    // The frames stage from the keys' text is a bound too, and the staged
    // bound from it never above the summed form, which needs no distinct
    // count.
    within(
        label,
        "frames stage, unmeasured",
        m.frames_peak,
        unmeasured_frames,
    );
    let unmeasured = Plan::staged_build_bound(config, t, projection.raw_len(), &m.counts).unwrap();
    assert_eq!(unmeasured, unmeasured_frames.max(build_bound));
    assert!(unmeasured <= Plan::build_bound(config, t, projection.raw_len()).unwrap());
    (m, frames_bound, build_bound)
}

/// A constructed conversation from its parts: `tids` with extremity values,
/// each group's voted comments (in the order given), the meta comments, and
/// each group's base clusters (`bases` of them, `per_base` participants
/// each).
fn shaped(tids: &[u32], groups: &[Vec<u32>], meta: &[u32], bases: u32, per_base: u32) -> Value {
    let mut group_votes = Map::new();
    let mut clusters = vec![];
    let (mut base_ids, mut base_members) = (vec![], vec![]);
    for (g, voted) in groups.iter().enumerate() {
        let g = g as u32;
        let mut votes = Map::new();
        for t in voted {
            votes.insert(t.to_string(), json!({"A": 1, "D": 0, "S": 2}));
        }
        group_votes.insert(
            g.to_string(),
            json!({"id": g, "n-members": bases * per_base, "votes": votes}),
        );
        let ids: Vec<u32> = (0..bases).map(|j| 1_000_000 + g * bases + j).collect();
        for &b in &ids {
            base_ids.push(b);
            base_members.push(
                (0..per_base)
                    .map(|k| b * per_base + k)
                    .collect::<Vec<u32>>(),
            );
        }
        clusters.push(json!({"id": g, "members": ids, "center": [0.0, 0.0]}));
    }
    let n = base_ids.len();
    json!({
        "tids": tids,
        "pca": {"comment-extremity": tids.iter().map(|t| f64::from(t % 7) * 0.4).collect::<Vec<_>>()},
        "meta-tids": meta,
        "group-votes": group_votes,
        "group-clusters": clusters,
        "base-clusters": {
            "id": base_ids, "members": base_members,
            "count": vec![0; n], "x": vec![0.0; n], "y": vec![0.0; n]
        }
    })
}

fn parse(v: &Value) -> Projection {
    let b = bytes(v);
    let limits = SourceLimits {
        max_bytes: b.len() as u64,
        ..SourceLimits::default()
    };
    Projection::parse(&b, row(), &limits).unwrap()
}

/// The shapes for the distinct counts and the stage bounds, the adversarial
/// ones among them: ids that never repeat (each group votes on its own
/// comments, none in `tids`, so u = cells + extremity), ids that repeat in
/// every frame, nested sets, many distinct ids then compact repeats, and
/// the most groups.
fn shapes() -> Vec<(String, Value)> {
    let range = |a: u32, n: u32| (a..a + n).collect::<Vec<u32>>();
    let mut out = vec![];
    for g in [1u32, 2, 5, 64] {
        let n = if g == 64 { 300 } else { 3000 };
        let tids = range(1, n);
        let groups: Vec<Vec<u32>> = (0..g).map(|i| range(100_000 + i * n, n)).collect();
        out.push((
            format!("disjoint {g}"),
            shaped(&tids, &groups, &[1, 2], 1, 40),
        ));
        let every: Vec<Vec<u32>> = (0..g).map(|_| tids.clone()).collect();
        out.push((
            format!("every frame {g}"),
            shaped(&tids, &every, &tids[..50], 1, 40),
        ));
        let nested: Vec<Vec<u32>> = (0..g).map(|i| range(1, n * (i + 1) / g)).collect();
        out.push((format!("nested {g}"), shaped(&tids, &nested, &[], 1, 40)));
        let mut repeats: Vec<Vec<u32>> = vec![range(200_000, 2 * n)];
        repeats.extend((1..g).map(|_| range(200_000, 8)));
        out.push((
            format!("distinct then repeats {g}"),
            shaped(&tids, &repeats, &[], 1, 40),
        ));
    }
    let c = conversation(41, 600, 64, 7, 0, Priorities::Absent);
    out.push(("overlapping 64".into(), c.value));
    out
}

/// d and u equal the library's own: the latest counts' length, and the
/// union of its ids with the extremity frame's.
#[test]
fn distinct_counts_exact() {
    let config = floor(MetaPolicy::Fixed, 0.1);
    for (label, v) in shapes() {
        let f = frames(&v, &config);
        let latest = LatestCountFrame::from_groups(f.groups().unwrap()).unwrap();
        let ids: BTreeSet<_> = latest.ids().collect();
        let union: BTreeSet<_> = ids
            .iter()
            .copied()
            .chain(f.extremity().unwrap().ids())
            .collect();
        let c = f.counts();
        assert_eq!(c.distinct, ids.len() as u64, "{label}");
        assert_eq!(c.union, union.len() as u64, "{label}");
        let p = parse(&v);
        assert_eq!(c.cells, p.tally().cells, "{label}");
        assert_eq!(c.extremity, p.tally().tids, "{label}");
        println!(
            "{label}: cells {}, d {}, u {}",
            c.cells, c.distinct, c.union
        );
    }
}

/// Each stage within its bound, and the frames' live bytes once read within
/// what they retain, on every shape, every meta policy and both forms of
/// group-informed consensus; the frames read for every rule.
#[test]
fn build_stage_within_its_bound() {
    let mut all: Vec<(String, Value)> = [
        ("64 groups", 41, 600, 64, 7, 0),
        ("5 groups 10000", 42, 10_000, 5, 10, 0),
        ("all meta", 43, 3000, 3, 1, 0),
        ("meta only", 44, 2000, 2, 3, 5000),
        ("one group", 45, 5000, 1, 0, 0),
    ]
    .into_iter()
    .map(|(name, seed, n, g, every, only)| {
        let c = conversation(seed, n, g, every, only, Priorities::Absent);
        (name.to_string(), c.value)
    })
    .collect();
    all.extend(shapes());
    for (name, v) in &all {
        let projection = parse(v);
        for policy in [MetaPolicy::Fixed, MetaPolicy::Exclude, MetaPolicy::Ordinary] {
            for form in [ConsensusForm::GicMean1, ConsensusForm::GicGeomean1] {
                let config = floor_form(policy, form);
                let label = format!("{name} {policy:?} {form:?}");
                let (m, fb, bb) = check(&label, &projection, &config);
                println!(
                    "{label}: frames {} of {fb}; retained {} of {}; build {} of {bb}",
                    m.frames_peak, m.retained, m.retained_bound, m.build_peak
                );
            }
        }
        for config in [uniform(), stored()] {
            check(
                &format!("{name} {}", config.to_plain()),
                &projection,
                &config,
            );
        }
    }
    let c = conversation(12, 5000, 1, 0, 0, Priorities::Mixed);
    check("stored mixed", &parse(&c.value), &stored());
}

/// The frames borrow nothing from the projection: dropped before the
/// build, the projection's text is freed, and the plan built after is the
/// one built with it kept.
#[test]
fn frames_outlive_their_projection() {
    let config = floor(MetaPolicy::Fixed, 0.1);
    let c = conversation(51, 2000, 5, 20, 0, Priorities::Absent);
    let kept = parse(&c.value);
    let with = Plan::build(&kept.frames(config.needs()).unwrap(), &config).unwrap();
    let projection = parse(&c.value);
    let raw = projection.raw_len() as i64;
    let frames = projection.frames(config.needs()).unwrap();
    LIVE.with(|l| l.set(0));
    ON.with(|o| o.set(true));
    drop(projection);
    let freed = -LIVE.with(Cell::get);
    ON.with(|o| o.set(false));
    assert!(freed >= raw, "freed {freed}, text {raw}");
    let without = Plan::build(&frames, &config).unwrap();
    assert_eq!(format!("{with:?}"), format!("{without:?}"));
}

/// The two witnesses at size (5 groups, 10,000 and 40,000 comments, meta
/// every 20th, the floor with meta fixed): the four numbers, each asserted,
/// and each stage against one conversation's share.
#[test]
fn witnesses_staged_at_size() {
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
        let measure = Projection::measure(&source, &limits).unwrap();
        let measured_charge = Projection::measured_parse_reservation(&measure, &limits).unwrap();
        LIVE.with(|l| l.set(0));
        PEAK.with(|p| p.set(0));
        ON.with(|o| o.set(true));
        let projection = Projection::parse_measured(&source, row(), &limits, &measure).unwrap();
        ON.with(|o| o.set(false));
        let parse_peak = PEAK.with(Cell::get);
        within("witness", "parse", parse_peak, measured_charge);
        within("witness", "parse, unmeasured", parse_peak, charge);
        let label = format!("{n} comments");
        let (m, fb, bb) = check(&label, &projection, &config);
        let staged = fb.max(bb);
        let summed = Plan::build_bound(&config, projection.tally(), projection.raw_len()).unwrap();
        let mut terms = vec![];
        Plan::build_stage_terms(&config, &m.counts, |name, b| terms.push((name, b))).unwrap();
        for (name, b) in &terms {
            println!("{label}: build stage: {name}: {b}");
        }
        assert_eq!(terms.iter().map(|t| t.1).sum::<u64>(), bb);
        let charged = m.charged.unwrap();
        println!(
            "{label}: projection {len} bytes; parse peak {parse_peak} of charge {charge}; \
             build peak {} of bound {staged} (frames stage {} of {fb}, build stage {} of {bb}; \
             summed bound {summed}); plan held {} of charged {charged}; d {}, u {}",
            m.frames_peak.max(m.build_peak),
            m.frames_peak,
            m.build_peak,
            m.held,
            m.counts.distinct,
            m.counts.union
        );
        println!(
            "{label}: share {}: frames stage fits {}, build stage fits {}, \
             read and parse ({}) fits {}",
            share(),
            fb <= share(),
            bb <= share(),
            len as u64 + charge,
            len as u64 + charge <= share()
        );
        let unmeasured_frames =
            Plan::frames_stage_bound(&config, projection.tally(), projection.raw_len()).unwrap();
        println!(
            "{label}: measured: longest string {}, longest number {}, depth {}, escaped keys {}, \
             spill {}, tids {}, meta {}, read text {}; parse charge {measured_charge} \
             (unmeasured {charge}); frames stage {fb} (unmeasured {unmeasured_frames}); \
             read and parse {} of share {}: fits {}",
            measure.longest_string(),
            measure.longest_number(),
            measure.depth(),
            measure.escaped_keys(),
            measure.spill(),
            measure.tids(),
            measure.meta(),
            measure.read_text(),
            len as u64 + measured_charge,
            share(),
            len as u64 + measured_charge <= share()
        );
        // The staged bound, and the read and parse stage, fit one share at
        // both sizes.
        assert!(staged <= share(), "{label}: {staged}");
        assert!(
            len as u64 + measured_charge <= share(),
            "{label}: read and parse {}",
            len as u64 + measured_charge
        );
    }
}

/// Counts between two instances of one family of shapes, at `x` (0 is the
/// first, 1 the second), each rounded up.
fn between(a: u64, b: u64, x: f64) -> u64 {
    (a as f64 + (b as f64 - a as f64) * x).ceil().max(0.0) as u64
}

/// Where a family's staged bound crosses one share: the largest point
/// between (or past) two instances whose bound at the interpolated counts
/// fits. The bounds are affine in the counts, so each stage is too.
fn line(config: &RuleConfig, a: &(Tally, u64, FrameCounts), b: &(Tally, u64, FrameCounts)) -> f64 {
    let at = |x: f64| {
        let t = Tally {
            groups: between(a.0.groups, b.0.groups, x),
            cells: between(a.0.cells, b.0.cells, x),
            tids: between(a.0.tids, b.0.tids, x),
            meta: between(a.0.meta, b.0.meta, x),
            extremity: between(a.0.extremity, b.0.extremity, x),
            priorities: between(a.0.priorities, b.0.priorities, x),
            memberships: between(a.0.memberships, b.0.memberships, x),
            longest_string: 0,
        };
        let c = FrameCounts {
            stored: between(a.2.stored, b.2.stored, x),
            extremity: between(a.2.extremity, b.2.extremity, x),
            meta: between(a.2.meta, b.2.meta, x),
            groups: between(a.2.groups, b.2.groups, x),
            cells: between(a.2.cells, b.2.cells, x),
            distinct: between(a.2.distinct, b.2.distinct, x),
            union: between(a.2.union, b.2.union, x),
        };
        Plan::staged_build_bound(config, &t, between(a.1, b.1, x), &c).unwrap()
    };
    let (mut lo, mut hi) = (0.0f64, 64.0f64);
    assert!(at(lo) <= share() && at(hi) > share());
    for _ in 0..60 {
        let mid = (lo + hi) / 2.0;
        if at(mid) <= share() {
            lo = mid
        } else {
            hi = mid
        }
    }
    lo
}

fn instance(v: &Value, config: &RuleConfig) -> (Tally, u64, FrameCounts) {
    let p = parse(v);
    let f = p.frames(config.needs()).unwrap();
    (*p.tally(), p.raw_len(), f.counts())
}

/// The shapes the design leaves inadmissible are refused: their staged
/// bound is over one conversation's share, which the cache's `try_reserve`
/// refuses at once, so the caller keeps today's draw. Each is measured
/// within its bounds all the same, and where its family's line falls is
/// printed, with the witnesses' family beside them.
#[test]
fn inadmissible_shapes_refused() {
    let config = floor(MetaPolicy::Fixed, 0.1);
    let range = |a: u32, n: u32| (a..a + n).collect::<Vec<u32>>();
    // Many groups at many comments: 64 groups, every one voting on every
    // comment.
    let many = |n: u32| {
        let tids = range(1, n);
        let groups: Vec<Vec<u32>> = (0..64).map(|_| tids.clone()).collect();
        shaped(&tids, &groups, &[], 1, 40)
    };
    // Membership-dense: 5 groups over 10,000 comments, each group's
    // participants each in a base cluster of their own.
    let dense = |bases: u32| {
        let tids = range(1, 10_000);
        let groups: Vec<Vec<u32>> = (0..5).map(|_| tids.clone()).collect();
        shaped(&tids, &groups, &[], bases, 1)
    };
    for (family, small, large, unit) in [
        (
            "many groups (64, fully voted)",
            many(1000),
            many(11_000),
            "comments",
        ),
        (
            "membership-dense (5 groups, 10,000 comments)",
            dense(40),
            dense(20_000),
            "base clusters per group",
        ),
    ] {
        let projection = parse(&large);
        let (m, fb, bb) = check(family, &projection, &config);
        let staged = fb.max(bb);
        println!(
            "{family}: tally {:?}; frames stage {} of {fb}; build stage {} of {bb}; share {}",
            projection.tally(),
            m.frames_peak,
            m.build_peak,
            share()
        );
        assert!(staged > share(), "{family}: {staged} fits");
        let (a, b) = (instance(&small, &config), instance(&large, &config));
        let x = line(&config, &a, &b);
        let at = |s: u64, l: u64| between(s, l, x);
        println!(
            "{family}: the line falls at about {} cells, {} comments, {} memberships ({unit}: {} to {})",
            at(a.0.cells, b.0.cells),
            at(a.0.tids, b.0.tids),
            at(a.0.memberships, b.0.memberships),
            if unit == "comments" { 1000 } else { 40 },
            if unit == "comments" { 6000 } else { 20_000 },
        );
    }
    let w = |n| conversation(51, n, 5, 20, 0, Priorities::Absent).value;
    let (a, b) = (instance(&w(10_000), &config), instance(&w(40_000), &config));
    let x = line(&config, &a, &b);
    println!(
        "witnesses (5 groups): the line falls at about {} comments, {} cells",
        between(a.0.tids, b.0.tids, x),
        between(a.0.cells, b.0.cells, x)
    );
}
