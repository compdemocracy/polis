//! A benchmark of the crate's real public calls: how long, and how many bytes,
//! it takes to build a conversation's weights under each built rule, and to
//! make one participant's draw (the candidate list built, the draw made, the
//! receipt written) over them.
//!
//! It is bench code, run by hand; `make check-polis-routing-equation` builds
//! and lints it (clippy `--all-targets`) but never runs it. Run it with
//!
//! ```text
//! cargo bench -p polis-routing-equation --bench routing_precompute -- --out <file>
//! ```
//!
//! Output is one JSON object per line (also written to `--out` when given).
//!
//! Data. By default every number comes from constructed data made here from a
//! fixed seed (the distribution is described in `constructed`). When the
//! environment variable `ROUTING_BENCH_MATH_RESULT` names a file, the bench
//! also reads a real conversation's math result from it at run time (the keys
//! `group-votes`, `pca.comment-extremity`, `tids` and, if present,
//! `meta-tids`) and measures that too. No conversation data is kept in this
//! file or in the repository.
//!
//! There is no vote anywhere in this bench: the inputs are named, unsigned
//! counts (agreed, disagreed, seen), so no vote convention is involved.
//!
//! What it is not: not a route benchmark (no SQL, pool, HTTP, deadline,
//! identity or translation), not a load test, and not production latency.
//! It runs on one thread. The counting allocator below adds two or three
//! atomic operations to every allocation, the same for every measurement.
//!
//! The bench's loader (`frames_from_value`) reads the projection into the
//! crate's frames through their public constructors. It is bench code and is
//! not the frames adapter.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_equation::{
    Candidates, CommentId, CommentMarks, ConsensusForm, CorrectedWeights, Counts,
    CurrentGroupFrame, Extremity, ExtremityFrame, FloorParams, FloorPlan, GicParams, GroupId,
    HistoricalCountFrame, HistoricalParams, LiftParams, MarkTotals, Marks, MetaComments,
    NormalizedLiftParams, SourceId, StoredWeights, SymmetricGicParams, SymmetricParams, TermInputs,
    TermParams, Unit, VoterWeightFrame, historical_1, stable_cdf, stored_weights_1, symmetric_1,
    symmetric_gic_1, symmetric_gic_floor_1, uniform_1, with_importance,
};
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::{BTreeMap, BTreeSet};
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// The counting allocator: bytes and allocations requested, live bytes, peak.

struct Counting;

static ALLOCATED: AtomicU64 = AtomicU64::new(0);
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);

fn on_alloc(size: usize) {
    let size = size as u64;
    ALLOCATED.fetch_add(size, Relaxed);
    ALLOCATIONS.fetch_add(1, Relaxed);
    let live = LIVE.fetch_add(size, Relaxed) + size;
    PEAK.fetch_max(live, Relaxed);
}

// SAFETY: every call is forwarded to the system allocator unchanged; the
// counters are atomics and never allocate.
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
        LIVE.fetch_sub(layout.size() as u64, Relaxed);
        // SAFETY: as above.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_sub(layout.size() as u64, Relaxed);
        on_alloc(new_size);
        // SAFETY: as above.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

// ---------------------------------------------------------------------------
// The clock, the environment and files: the only functions that reach them.

#[allow(clippy::disallowed_methods)]
fn now() -> Instant {
    Instant::now()
}

#[allow(clippy::disallowed_methods)]
fn real_math_result_path() -> Option<std::path::PathBuf> {
    std::env::var_os("ROUTING_BENCH_MATH_RESULT").map(std::path::PathBuf::from)
}

#[allow(clippy::disallowed_methods)]
fn read_file(path: &std::path::Path) -> Vec<u8> {
    std::fs::read(path).expect("the math result named by ROUTING_BENCH_MATH_RESULT")
}

#[allow(clippy::disallowed_methods)]
fn write_file(path: &str, text: &str) {
    std::fs::write(path, text).expect("the --out file");
}

// ---------------------------------------------------------------------------
// Statistics.

/// Warm-up runs before every measurement; then at least `MIN_ITERS`
/// measured runs, more while they fit in `BUDGET`, at most `MAX_ITERS`.
const WARMUP: usize = 5;
const MIN_ITERS: usize = 31;
const MAX_ITERS: usize = 2001;
const BUDGET: Duration = Duration::from_millis(1500);

struct Sample {
    nanos: Vec<u64>,
    allocated: Vec<u64>,
    allocations: Vec<u64>,
    peak: u64,
}

fn pct(sorted: &[u64], p: f64) -> u64 {
    // Nearest rank.
    let rank = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len());
    sorted[rank - 1]
}

/// Times `f` (setup outside the timed region is the caller's), recording per
/// run the wall time, the bytes and allocations requested, and the peak live
/// bytes above the level at the start of the run.
fn measure<T>(mut f: impl FnMut() -> T) -> Sample {
    for _ in 0..WARMUP {
        black_box(f());
    }
    let mut s = Sample {
        nanos: vec![],
        allocated: vec![],
        allocations: vec![],
        peak: 0,
    };
    let started = now();
    while s.nanos.len() < MAX_ITERS
        && (s.nanos.len() < MIN_ITERS || now().duration_since(started) < BUDGET)
    {
        let base_live = LIVE.load(Relaxed);
        PEAK.store(base_live, Relaxed);
        let a0 = ALLOCATED.load(Relaxed);
        let n0 = ALLOCATIONS.load(Relaxed);
        let t0 = now();
        let out = f();
        let dt = now().duration_since(t0);
        let a1 = ALLOCATED.load(Relaxed);
        let n1 = ALLOCATIONS.load(Relaxed);
        let peak = PEAK.load(Relaxed).saturating_sub(base_live);
        drop(black_box(out));
        s.nanos.push(dt.as_nanos() as u64);
        s.allocated.push(a1 - a0);
        s.allocations.push(n1 - n0);
        s.peak = s.peak.max(peak);
    }
    s
}

/// Live bytes retained by the value `f` builds, while it is held.
fn retained<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = LIVE.load(Relaxed);
    let v = f();
    let after = LIVE.load(Relaxed);
    (v, after.saturating_sub(before))
}

struct Out {
    lines: Vec<String>,
}

impl Out {
    fn emit(&mut self, mut tags: Value, s: &Sample) {
        let mut ns = s.nanos.clone();
        ns.sort_unstable();
        let mut al = s.allocated.clone();
        al.sort_unstable();
        let mut ac = s.allocations.clone();
        ac.sort_unstable();
        let us = |v: u64| v as f64 / 1000.0;
        let obj = tags.as_object_mut().unwrap();
        obj.insert("iters".into(), json!(ns.len()));
        obj.insert("min_us".into(), json!(us(ns[0])));
        obj.insert("p50_us".into(), json!(us(pct(&ns, 0.50))));
        obj.insert("p95_us".into(), json!(us(pct(&ns, 0.95))));
        obj.insert("p99_us".into(), json!(us(pct(&ns, 0.99))));
        obj.insert("max_us".into(), json!(us(ns[ns.len() - 1])));
        obj.insert(
            "mean_us".into(),
            json!(us(ns.iter().sum::<u64>() / ns.len() as u64)),
        );
        obj.insert("alloc_bytes_p50".into(), json!(pct(&al, 0.50)));
        obj.insert("alloc_bytes_max".into(), json!(al[al.len() - 1]));
        obj.insert("allocs_p50".into(), json!(pct(&ac, 0.50)));
        obj.insert("peak_bytes_max".into(), json!(s.peak));
        self.line(tags);
    }
    fn line(&mut self, v: Value) {
        let text = v.to_string();
        println!("{text}");
        self.lines.push(text);
    }
}

// ---------------------------------------------------------------------------
// A seeded generator (SplitMix64): the bench's own, never the crate's.

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform on the 53-bit grid of [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.unit() * n as f64) as usize
    }
}

// ---------------------------------------------------------------------------
// Data: one representation for constructed and real conversations.

#[derive(Clone)]
struct Comment {
    id: u32,
    extremity: f64,
    /// (group, agreed, disagreed, seen); a group with no entry has no cell.
    cells: Vec<(u32, u32, u32, u64)>,
}

#[derive(Clone)]
struct Conversation {
    label: String,
    groups: Vec<(u32, u32)>,
    comments: Vec<Comment>,
    meta: Vec<u32>,
}

/// Constructed data. Per comment and group, a cell is present with
/// probability 0.95; its seen count is floor(2000^u) - 1 for u uniform, a
/// heavy tail from 0 to 1,998 (about 9% of present cells are zero), split
/// into agrees, disagrees and passes by two uniform fractions. Extremity is
/// uniform in [0, 3). Every comment has at least one cell, so every comment
/// is scored. Ids are sparse (7i + 3). This is not a flattering choice for
/// time or bytes: almost every group has a cell for almost every comment, so
/// the group frame and every per-comment map are near their largest for n.
fn constructed(n: usize, groups: u32, seed: u64) -> Conversation {
    let mut rng = Rng(seed);
    let members = 2000u32;
    let mut comments = Vec::with_capacity(n);
    for i in 0..n {
        let mut cells = vec![];
        for g in 0..groups {
            if rng.unit() < 0.95 || (g + 1 == groups && cells.is_empty()) {
                let seen = (2000f64.powf(rng.unit()).floor() as u64).saturating_sub(1);
                let agreed = (seen as f64 * rng.unit()) as u64;
                let disagreed = ((seen - agreed) as f64 * rng.unit()) as u64;
                cells.push((g, agreed as u32, disagreed as u32, seen));
            }
        }
        comments.push(Comment {
            id: 7 * i as u32 + 3,
            extremity: 3.0 * rng.unit(),
            cells,
        });
    }
    Conversation {
        label: format!("constructed-{n}-g{groups}"),
        groups: (0..groups).map(|g| (g, members)).collect(),
        comments,
        meta: vec![],
    }
}

/// Resampled data: a real conversation's comments drawn with replacement to
/// n and renumbered, keeping its per-group cells and present-zero rate.
/// Made in memory at run time only when a real result was supplied.
fn resampled(real: &Conversation, n: usize, seed: u64) -> Conversation {
    let mut rng = Rng(seed);
    let comments = (0..n)
        .map(|i| {
            let mut c = real.comments[rng.below(real.comments.len())].clone();
            c.id = i as u32;
            c
        })
        .collect();
    Conversation {
        label: format!("resampled-real-{n}"),
        groups: real.groups.clone(),
        comments,
        meta: vec![],
    }
}

/// The projection a math result holds, as JSON bytes.
fn projection(c: &Conversation) -> Vec<u8> {
    let mut gv = serde_json::Map::new();
    for &(g, members) in &c.groups {
        let mut votes = serde_json::Map::new();
        for cm in &c.comments {
            for &(cg, a, d, s) in &cm.cells {
                if cg == g {
                    votes.insert(cm.id.to_string(), json!({"A": a, "D": d, "S": s}));
                }
            }
        }
        gv.insert(
            g.to_string(),
            json!({"n-members": members, "votes": Value::Object(votes)}),
        );
    }
    let tids: Vec<u32> = c.comments.iter().map(|cm| cm.id).collect();
    let ext: Vec<f64> = c.comments.iter().map(|cm| cm.extremity).collect();
    serde_json::to_vec(&json!({
        "group-votes": Value::Object(gv),
        "tids": tids,
        "pca": {"comment-extremity": ext},
        "meta-tids": c.meta,
    }))
    .unwrap()
}

/// A real math result's projection, read back into the bench's form.
fn conversation_from_value(label: &str, v: &Value) -> Conversation {
    let tids: Vec<u32> = v["tids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_u64().unwrap() as u32)
        .collect();
    let ext = v["pca"]["comment-extremity"].as_array().unwrap();
    assert_eq!(ext.len(), tids.len(), "tids and extremity differ in length");
    let mut comments: BTreeMap<u32, Comment> = tids
        .iter()
        .zip(ext)
        .map(|(&id, e)| {
            let c = Comment {
                id,
                extremity: e.as_f64().unwrap(),
                cells: vec![],
            };
            (id, c)
        })
        .collect();
    let mut groups = vec![];
    for (g, body) in v["group-votes"].as_object().unwrap() {
        let g: u32 = g.parse().unwrap();
        groups.push((g, body["n-members"].as_u64().unwrap() as u32));
        for (tid, cell) in body["votes"].as_object().unwrap() {
            let tid: u32 = tid.parse().unwrap();
            let c = comments.get_mut(&tid).expect("a counted tid in tids");
            c.cells.push((
                g,
                cell["A"].as_u64().unwrap() as u32,
                cell["D"].as_u64().unwrap() as u32,
                cell["S"].as_u64().unwrap(),
            ));
        }
    }
    let meta = v
        .get("meta-tids")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|t| t.as_u64().unwrap() as u32).collect())
        .unwrap_or_default();
    Conversation {
        label: label.into(),
        groups,
        comments: comments.into_values().collect(),
        meta,
    }
}

// ---------------------------------------------------------------------------
// Frames (M2): from the decoded projection, through the public constructors.

struct Frames {
    counts: HistoricalCountFrame,
    extremity: ExtremityFrame,
    groups: CurrentGroupFrame,
    meta: MetaComments,
}

fn sid(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

fn frames_from_value(v: &Value) -> Frames {
    let tids = v["tids"].as_array().unwrap();
    let ext = v["pca"]["comment-extremity"].as_array().unwrap();
    let extremity = ExtremityFrame::new(
        sid("bench:current-extremity"),
        tids.iter().zip(ext).map(|(t, e)| {
            (
                CommentId::new(t.as_u64().unwrap() as u32),
                Extremity::new(e.as_f64().unwrap()).unwrap(),
            )
        }),
    )
    .unwrap();
    let mut members = vec![];
    let mut cells = vec![];
    let mut summed: BTreeMap<u32, [u64; 3]> = BTreeMap::new();
    for (g, body) in v["group-votes"].as_object().unwrap() {
        let g = GroupId::new(g.parse().unwrap());
        members.push((g, body["n-members"].as_u64().unwrap() as u32));
        for (tid, cell) in body["votes"].as_object().unwrap() {
            let tid: u32 = tid.parse().unwrap();
            let (a, d, s) = (
                cell["A"].as_u64().unwrap(),
                cell["D"].as_u64().unwrap(),
                cell["S"].as_u64().unwrap(),
            );
            cells.push((
                g,
                CommentId::new(tid),
                Counts::from_seen(a as u32, d as u32, s).unwrap(),
            ));
            let e = summed.entry(tid).or_default();
            e[0] += a;
            e[1] += d;
            e[2] += s;
        }
    }
    // Summed over groups, the latest update's counts: `base-counts:lag-0`.
    let counts = HistoricalCountFrame::new(
        sid("bench:base-counts:lag-0"),
        summed.into_iter().map(|(tid, [a, d, s])| {
            (
                CommentId::new(tid),
                Counts::from_seen(a as u32, d as u32, s).unwrap(),
            )
        }),
    )
    .unwrap();
    let groups = CurrentGroupFrame::new(sid("bench:current-groups"), members, cells, None).unwrap();
    let meta_ids: Vec<CommentId> = v
        .get("meta-tids")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| CommentId::new(t.as_u64().unwrap() as u32))
                .collect()
        })
        .unwrap_or_default();
    Frames {
        counts,
        extremity,
        groups,
        meta: MetaComments::new(meta_ids).unwrap(),
    }
}

// ---------------------------------------------------------------------------
// Rules.

fn gic(form: ConsensusForm) -> SymmetricGicParams {
    SymmetricGicParams::new(SymmetricParams::default(), form, GicParams::default())
}

fn floor_params(form: ConsensusForm) -> FloorParams {
    FloorParams::new(gic(form), 0.1).unwrap()
}

fn floor_plan(f: &Frames, form: ConsensusForm) -> FloorPlan {
    let w = symmetric_gic_1(&gic(form), &f.counts, &f.extremity, &f.groups, &f.meta).unwrap();
    symmetric_gic_floor_1(&floor_params(form), w, &f.meta).unwrap()
}

fn stored(f: &Frames) -> StoredWeights {
    let h = historical_1(
        &HistoricalParams::default(),
        &f.counts,
        &f.extremity,
        &f.meta,
    )
    .unwrap();
    StoredWeights::from_historical(sid("bench:historical-1"), &h)
}

/// Constructed importance inputs over the frames' counts: per comment, the
/// seen votes are the eligible ones and about 6% of them carry a mark; the
/// totals are the sums. The 2019 voter weights: each voter weighs 1 to 1.5.
struct Importance {
    marks: CommentMarks,
    totals: MarkTotals,
    voters: VoterWeightFrame,
}

fn importance_inputs(f: &Frames, seed: u64) -> Importance {
    let mut rng = Rng(seed);
    let mut cells = vec![];
    let mut per = vec![];
    let (mut marked, mut eligible, mut voters) = (0u64, 0u64, 0u64);
    let mut sums = vec![];
    for id in f.counts.ids() {
        let seen = f.counts.get(id).unwrap().seen();
        let m = ((seen as f64) * 0.12 * rng.unit()) as u64;
        cells.push((id, Marks::new(m, seen).unwrap()));
        marked += m;
        eligible += seen;
        let w = if seen == 0 {
            0.0
        } else {
            seen as f64 * (1.0 + 0.5 * rng.unit())
        };
        per.push((id, seen, w));
        voters += seen;
        sums.push(w);
    }
    sums.sort_by(f64::total_cmp);
    let total_w: f64 = sums.into_iter().sum();
    Importance {
        marks: CommentMarks::new(sid("bench:marks"), sid("bench:cohort"), cells).unwrap(),
        totals: MarkTotals::new(
            sid("bench:marks"),
            sid("bench:cohort"),
            Marks::new(marked, eligible).unwrap(),
        ),
        voters: VoterWeightFrame::new(sid("bench:voter-weights"), per, voters, total_w).unwrap(),
    }
}

// ---------------------------------------------------------------------------
// The participant: a voted set by count (uniform at random) or by weight
// (drawn without replacement by the rule's own weights, heavy ones first).

fn voted_by_count(ids: &[CommentId], fraction: f64, rng: &mut Rng) -> BTreeSet<CommentId> {
    let k = (fraction * ids.len() as f64).round() as usize;
    let mut v: Vec<CommentId> = ids.to_vec();
    for i in 0..k.min(v.len()) {
        let j = i + rng.below(v.len() - i);
        v.swap(i, j);
    }
    v.truncate(k);
    v.into_iter().collect()
}

fn voted_by_weight(
    ids: &[CommentId],
    weight: impl Fn(CommentId) -> f64,
    fraction: f64,
    rng: &mut Rng,
) -> BTreeSet<CommentId> {
    let k = (fraction * ids.len() as f64).round() as usize;
    // Efraimidis-Spirakis: the k largest of ln(u) / w.
    let mut keyed: Vec<(f64, CommentId)> = ids
        .iter()
        .map(|&id| ((1.0 - rng.unit()).ln() / weight(id), id))
        .collect();
    keyed.sort_by(|a, b| b.0.total_cmp(&a.0));
    keyed.into_iter().take(k).map(|(_, id)| id).collect()
}

fn remaining(ids: &[CommentId], voted: &BTreeSet<CommentId>) -> Vec<CommentId> {
    ids.iter()
        .copied()
        .filter(|id| !voted.contains(id))
        .collect()
}

// ---------------------------------------------------------------------------
// Strategy C, as reference bench code (not crate code): one table of running
// sums over every comment's base weight; a draw picks a position by binary
// search and retries (cap 32) when the participant may not get it, then
// falls back to the exact pass over the eligible comments. It draws
// w_j / W_p, with no floor lane: it is a lower bound on what C would cost for
// the floor, whose law it does not have.

struct CTable {
    cum: Vec<f64>,
    weights: Vec<f64>,
    pos: BTreeMap<CommentId, usize>,
}

fn c_table(plan: &FloorPlan, ids: &[CommentId]) -> CTable {
    let mut cum = Vec::with_capacity(ids.len());
    let mut weights = Vec::with_capacity(ids.len());
    let mut total = 0.0;
    for id in ids {
        let w = plan.weights().get(*id).map_or(1.0, |s| s.weight().get());
        total += w;
        weights.push(w);
        cum.push(total);
    }
    let pos = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    CTable { cum, weights, pos }
}

/// (chosen position, tries, fell back)
fn c_draw(t: &CTable, voted: &[CommentId], rng: &mut Rng) -> (usize, u32, bool) {
    let mut eligible = vec![true; t.cum.len()];
    for id in voted {
        if let Some(&p) = t.pos.get(id) {
            eligible[p] = false;
        }
    }
    let total = t.cum[t.cum.len() - 1];
    for tries in 1..=32u32 {
        let r = rng.unit() * total;
        let i = t.cum.partition_point(|&c| c <= r).min(t.cum.len() - 1);
        if eligible[i] {
            return (i, tries, false);
        }
    }
    let wp: f64 = t
        .weights
        .iter()
        .zip(&eligible)
        .filter(|(_, e)| **e)
        .map(|(w, _)| *w)
        .sum();
    let r = rng.unit() * wp;
    let mut run = 0.0;
    let mut last = 0;
    for (i, (w, e)) in t.weights.iter().zip(&eligible).enumerate() {
        if *e {
            run += *w;
            last = i;
            if run > r {
                return (i, 32, true);
            }
        }
    }
    (last, 32, true)
}

// ---------------------------------------------------------------------------
// The measurements.

const FRACTIONS: [f64; 4] = [0.0, 0.5, 0.95, 0.999];

fn tag(m: &str, what: &str, data: &str, n: usize, groups: usize) -> Value {
    json!({"m": m, "what": what, "data": data, "n": n, "groups": groups})
}

fn with(mut v: Value, k: &str, x: Value) -> Value {
    v.as_object_mut().unwrap().insert(k.into(), x);
    v
}

/// M1 to M7 and M9 for one conversation.
fn bench_conversation(out: &mut Out, conv: &Conversation, bytes: &[u8], full: bool) {
    let n = conv.comments.len();
    let g = conv.groups.len();
    let d = conv.label.as_str();
    out.line(json!({"m": "data", "data": d, "n": n, "groups": g,
        "projection_bytes": bytes.len(), "meta": conv.meta.len()}));

    // M1 decode.
    let s = measure(|| serde_json::from_slice::<Value>(bytes).unwrap());
    out.emit(tag("M1", "decode", d, n, g), &s);
    let value: Value = serde_json::from_slice(bytes).unwrap();

    // M2 frames.
    let s = measure(|| frames_from_value(&value));
    out.emit(tag("M2", "frames", d, n, g), &s);
    let (frames, bytes_frames) = retained(|| frames_from_value(&value));
    out.line(with(
        tag("M7", "frames", d, n, g),
        "retained_bytes",
        json!(bytes_frames),
    ));
    let f = &frames;

    // M3 builds, M7 retained bytes.
    let hp = HistoricalParams::default();
    let sp = SymmetricParams::default();
    let imp = importance_inputs(f, 11);
    macro_rules! build {
        ($what:expr, $e:expr) => {{
            let s = measure(|| $e);
            out.emit(tag("M3", $what, d, n, g), &s);
            let (_v, b) = retained(|| $e);
            out.line(with(tag("M7", $what, d, n, g), "retained_bytes", json!(b)));
        }};
    }
    build!(
        "historical/1",
        historical_1(&hp, &f.counts, &f.extremity, &f.meta).unwrap()
    );
    build!(
        "stored-weights/1 map (historical/1 + StoredWeights)",
        stored(f)
    );
    build!(
        "symmetric/1",
        symmetric_1(&sp, &f.counts, &f.extremity, &f.meta).unwrap()
    );
    for form in [ConsensusForm::GicGeomean1, ConsensusForm::GicMean1] {
        build!(
            format!("symmetric-gic/1 {}", form.name()).as_str(),
            symmetric_gic_1(&gic(form), &f.counts, &f.extremity, &f.groups, &f.meta).unwrap()
        );
        build!(
            format!("symmetric-gic-floor/1 plan {}", form.name()).as_str(),
            floor_plan(f, form)
        );
    }
    let lift = |base: CorrectedWeights| {
        with_importance(
            base,
            TermParams::ImportanceLift1(LiftParams::default()),
            TermInputs::Marks {
                comments: Some(&imp.marks),
                totals: Some(&imp.totals),
            },
            sid("bench:marks"),
        )
        .unwrap()
    };
    let nlift = |base: CorrectedWeights| {
        with_importance(
            base,
            TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::new(None).unwrap()),
            TermInputs::VoterWeights(&imp.voters),
            sid("bench:voter-weights"),
        )
        .unwrap()
    };
    let gp = gic(ConsensusForm::GicGeomean1);
    build!(
        "symmetric-gic/1 + importance-lift/1",
        lift(symmetric_gic_1(&gp, &f.counts, &f.extremity, &f.groups, &f.meta).unwrap())
    );
    build!(
        "symmetric-gic/1 + importance-normalized-lift/1",
        nlift(symmetric_gic_1(&gp, &f.counts, &f.extremity, &f.groups, &f.meta).unwrap())
    );

    // M4 to M6: one participant's draw.
    let plan = floor_plan(f, ConsensusForm::GicGeomean1);
    let sw = stored(f);
    let ids: Vec<CommentId> = conv.comments.iter().map(|c| CommentId::new(c.id)).collect();
    let ids: Vec<CommentId> = ids.into_iter().filter(|id| !f.meta.contains(*id)).collect();
    let src = sid("bench:request");
    let wsrc = sid("bench:plan");
    let floor_w = |id: CommentId| plan.weights().get(id).map_or(1.0, |s| s.weight().get());
    let stored_w = |id: CommentId| match sw.get(id) {
        Some(polis_routing_equation::StoredWeight::Number(w)) if w > 0.0 => w,
        _ => 1.0,
    };
    let ctab = c_table(&plan, &ids);
    let mut rng = Rng(0x5EED_0000 + n as u64);
    for &frac in &FRACTIONS {
        for by in ["count", "weight"] {
            let voted_floor = if by == "count" {
                voted_by_count(&ids, frac, &mut rng)
            } else {
                voted_by_weight(&ids, floor_w, frac, &mut rng)
            };
            let voted_stored = if by == "count" {
                voted_floor.clone()
            } else {
                voted_by_weight(&ids, stored_w, frac, &mut rng)
            };
            let rest_floor = remaining(&ids, &voted_floor);
            let rest_stored = remaining(&ids, &voted_stored);
            if rest_floor.is_empty() || rest_stored.is_empty() {
                continue;
            }
            let base = with(
                with(tag("M5", "", d, n, g), "voted", json!(frac)),
                "by",
                json!(by),
            );
            let t = |what: &str| with(base.clone(), "what", json!(what));
            let units: Vec<Unit> = (0..64).map(|_| Unit::new(rng.unit()).unwrap()).collect();
            let mut k = 0usize;
            let mut unit = || {
                k = (k + 1) % units.len();
                units[k]
            };

            // M4: the candidate list alone.
            if by == "count" {
                let s = measure(|| Candidates::new(rest_floor.clone()).unwrap());
                out.emit(with(t("Candidates::new"), "m", json!("M4")), &s);
            }
            // M4 + M5 + M6, as a request would make them.
            let s = measure(|| {
                let c = Candidates::new(rest_floor.clone()).unwrap();
                plan.draw(&c, unit(), &wsrc, &src).unwrap().to_plain()
            });
            out.emit(t("floor draw: candidates + draw + receipt"), &s);
            let s = measure(|| {
                let c = Candidates::new(rest_stored.clone()).unwrap();
                stored_weights_1(Some(&sw), &c, unit(), &src)
                    .unwrap()
                    .to_plain()
            });
            out.emit(t("stored-weights/1: candidates + draw + receipt"), &s);
            if by == "count" {
                let s = measure(|| {
                    let c = Candidates::new(rest_floor.clone()).unwrap();
                    uniform_1(&c, unit(), &src).unwrap().to_plain()
                });
                out.emit(t("uniform/1: candidates + draw + receipt"), &s);
                // M6 alone.
                let c = Candidates::new(rest_floor.clone()).unwrap();
                let drawn = plan.draw(&c, unit(), &wsrc, &src).unwrap();
                let s = measure(|| drawn.to_plain());
                out.emit(with(t("Drawn::to_plain (floor)"), "m", json!("M6")), &s);
                // The floor's probabilities alone (resolve + marginals).
                let s = measure(|| plan.probabilities(&c).unwrap());
                out.emit(t("floor probabilities only"), &s);
            }
            // M10: single-vector C, cap 32, exact fallback.
            if full {
                let vf: Vec<CommentId> = voted_floor.iter().copied().collect();
                let mut tries = vec![];
                let mut fell = 0u32;
                let mut crng = Rng(77);
                for _ in 0..2000 {
                    let (_, tr, fb) = c_draw(&ctab, &vf, &mut crng);
                    tries.push(u64::from(tr));
                    fell += u32::from(fb);
                }
                tries.sort_unstable();
                let s = measure(|| c_draw(&ctab, &vf, &mut crng));
                let v = with(
                    with(
                        with(t("C: table, cap 32, exact fallback"), "m", json!("M10")),
                        "tries_p50",
                        json!(pct(&tries, 0.5)),
                    ),
                    "tries_p99",
                    json!(pct(&tries, 0.99)),
                );
                out.emit(
                    with(v, "fallback_rate", json!(f64::from(fell) / 2000.0)),
                    &s,
                );
            }
        }
    }

    // M9: E, everything one request would do, from the bytes.
    let voted_e = voted_by_count(&ids, 0.5, &mut rng);
    let rest_e = remaining(&ids, &voted_e);
    let u = Unit::new(0.37).unwrap();
    let s = measure(|| {
        let v: Value = serde_json::from_slice(bytes).unwrap();
        let fr = frames_from_value(&v);
        let p = floor_plan(&fr, ConsensusForm::GicGeomean1);
        let c = Candidates::new(rest_e.clone()).unwrap();
        p.draw(&c, u, &wsrc, &src).unwrap().to_plain()
    });
    out.emit(
        with(
            tag(
                "M9",
                "E: decode + frames + floor plan + draw + receipt",
                d,
                n,
                g,
            ),
            "voted",
            json!(0.5),
        ),
        &s,
    );
    let s = measure(|| {
        let v: Value = serde_json::from_slice(bytes).unwrap();
        let fr = frames_from_value(&v);
        let m = stored(&fr);
        let c = Candidates::new(rest_e.clone()).unwrap();
        stored_weights_1(Some(&m), &c, u, &src).unwrap().to_plain()
    });
    out.emit(
        with(
            tag(
                "M9",
                "E: decode + frames + stored-weights map + draw + receipt",
                d,
                n,
                g,
            ),
            "voted",
            json!(0.5),
        ),
        &s,
    );
}

/// M8: the floor's resolution with all, half or no candidates unscored. An
/// unscored comment here is one with an extremity and no counts.
fn bench_unscored(out: &mut Out, n: usize) {
    let conv = constructed(n, 5, 4040 + n as u64);
    let value: Value = serde_json::from_slice(&projection(&conv)).unwrap();
    let full = frames_from_value(&value);
    let ids: Vec<CommentId> = conv.comments.iter().map(|c| CommentId::new(c.id)).collect();
    for (label, keep) in [
        ("all scored", 1usize),
        ("half unscored", 2),
        ("all unscored", 0),
    ] {
        let counts = HistoricalCountFrame::new(
            sid("bench:base-counts:lag-0"),
            ids.iter().enumerate().filter_map(|(i, id)| {
                let scored = keep == 1 || (keep == 2 && i % 2 == 0);
                scored.then(|| (*id, full.counts.get(*id).unwrap()))
            }),
        )
        .unwrap();
        let f = Frames {
            counts,
            extremity: full.extremity.clone(),
            groups: full.groups.clone(),
            meta: MetaComments::none(),
        };
        let plan = floor_plan(&f, ConsensusForm::GicGeomean1);
        let c = Candidates::new(ids.clone()).unwrap();
        let src = sid("bench:request");
        let base = with(tag("M8", "", &conv.label, n, 5), "set", json!(label));
        let s = measure(|| plan.probabilities(&c).unwrap());
        out.emit(with(base.clone(), "what", json!("probabilities")), &s);
        let mut rng = Rng(9);
        let s = measure(|| {
            let u = Unit::new(rng.unit()).unwrap();
            plan.draw(&c, u, &src, &src).unwrap()
        });
        out.emit(with(base, "what", json!("draw")), &s);
    }
    // The same arithmetic with the resolution taken out: the stable draw over
    // n ones, to show what the rest of the draw costs.
    let ones = vec![1.0; n];
    let s = measure(|| stable_cdf(&ones, Unit::new(0.5).unwrap()).unwrap());
    out.emit(tag("M8", "stable_cdf over n ones", &conv.label, n, 5), &s);
}

fn main() {
    // `cargo bench` passes `--bench`; other arguments are ignored.
    let args: Vec<String> = std::env::args().collect();
    let out_path = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let only_quick = args.iter().any(|a| a == "--quick");
    let mut out = Out { lines: vec![] };
    out.line(json!({"m": "header",
        "note": "constructed data are counts only; no vote value is written anywhere and no vote convention is involved",
        "warmup": WARMUP, "min_iters": MIN_ITERS, "max_iters": MAX_ITERS,
        "budget_ms": BUDGET.as_millis() as u64,
        "threads": 1,
        "real_math_result": real_math_result_path().is_some()}));

    let sizes: &[usize] = if only_quick {
        &[1000]
    } else {
        &[1000, 10_000, 40_000]
    };
    for &n in sizes {
        let conv = constructed(n, 5, 1000 + n as u64);
        let bytes = projection(&conv);
        bench_conversation(&mut out, &conv, &bytes, true);
    }
    if !only_quick {
        // Group counts at 10,000: the builds only matter here.
        for groups in [2u32, 64] {
            let conv = constructed(10_000, groups, 2000 + u64::from(groups));
            let bytes = projection(&conv);
            bench_conversation(&mut out, &conv, &bytes, false);
        }
    }
    for &n in sizes {
        bench_unscored(&mut out, n);
    }
    if let Some(path) = real_math_result_path() {
        let bytes = read_file(&path);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let real = conversation_from_value("real", &value);
        bench_conversation(&mut out, &real, &bytes, true);
        if !only_quick {
            for n in [10_000, 40_000] {
                let conv = resampled(&real, n, 3000 + n as u64);
                let bytes = projection(&conv);
                bench_conversation(&mut out, &conv, &bytes, false);
            }
        }
    }
    if let Some(p) = out_path {
        let mut text = out.lines.join("\n");
        text.push('\n');
        write_file(&p, &text);
    }
}
