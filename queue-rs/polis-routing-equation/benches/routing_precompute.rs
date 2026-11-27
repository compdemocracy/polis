//! A benchmark of the crate's real public calls under the precomputation
//! strategy the design recommends (the engine publishes inputs; a builder
//! turns one conversation's inputs into a floor plan once per math update;
//! each request makes one participant's draw over the plan).
//!
//! What it times, each as ONE operation:
//!
//! - the whole build: projection bytes decoded, frames validated, the floor
//!   plan built, and the decoded JSON and the frames released, inside the
//!   timer; out comes the plan and the meta set a request needs beside it;
//! - the caller's sequence for one request, in two candidate forms:
//!   `P` (the design's: candidates, the probabilities preflight, the draw,
//!   the receipt) and `S` (candidates, the draw, the receipt: the draw's
//!   refusals are decided before the unit is read, so `S` refuses exactly
//!   where `P` does and draws the same comment; the bench checks that on
//!   every case before timing it). Under `meta_policy = exclude` both start
//!   with the caller removing the meta comments from the candidate query's
//!   rows, because the plan refuses a meta candidate;
//! - the edge and refusal cases a caller can hit; strategy E (everything per
//!   request) across small sizes; the floor's resolution kernels; and, at
//!   the one point the design's T4 names, a reference strategy C draw.
//!
//! It is bench code, run by hand. `make check-polis-routing-equation` runs it
//! once in its smoke mode (`-- --smoke`: a few dozen comments, one iteration
//! per case, no timing assertion), which checks that every case still runs,
//! that every draw is of an eligible candidate with a receipt that reads
//! back, and that each edge case ends as it should. Run it with
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
//! file or in the repository; the smoke mode never reads the variable.
//!
//! There is no vote anywhere in this bench: the inputs are named, unsigned
//! counts (agreed, disagreed, seen), so no vote convention is involved.
//!
//! What it is not: not a route benchmark (no SQL, pool, HTTP, deadline,
//! identity, translation, cache lookup or entropy source), not a load test,
//! and not production latency. It runs on one thread. The counting allocator
//! below makes four atomic updates per allocation, so its cost grows with the
//! number of allocations a measurement makes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_equation::{
    Candidates, CommentId, ConsensusForm, Counts, CurrentGroupFrame, DrawRefusal, Drawn, Extremity,
    ExtremityFrame, FloorParams, FloorPlan, GicParams, GroupId, HistoricalCountFrame,
    HistoricalParams, MetaComments, MetaPolicy, SourceId, StoredWeights, SymmetricGicParams,
    SymmetricParams, Unit, floor_marginals, historical_1, stable_cdf, stored_weights_1,
    symmetric_gic_1, symmetric_gic_floor_1, uniform_1,
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

/// How many runs a measurement makes: `warmup` unrecorded, then at least
/// `min` recorded, more while they fit in `budget`, at most `max`.
#[derive(Clone, Copy)]
struct Iters {
    warmup: usize,
    min: usize,
    max: usize,
    budget: Duration,
}

/// Rows a threshold is judged on that state a 95th or 99th percentile: at
/// least 1,000 recorded runs, so the 99th percentile has ten runs above it.
const THRESHOLD: Iters = Iters {
    warmup: 5,
    min: 1000,
    max: 5000,
    budget: Duration::from_millis(3000),
};
/// Other per-request rows: at least 300 (a 95th percentile has 15 above it).
const ROW: Iters = Iters {
    warmup: 5,
    min: 300,
    max: 3000,
    budget: Duration::from_millis(1000),
};
/// Builds, judged on their median: at least 31.
const BUILD: Iters = Iters {
    warmup: 3,
    min: 31,
    max: 1000,
    budget: Duration::from_millis(3000),
};
/// The smoke mode: one run, no warm-up.
const SMOKE: Iters = Iters {
    warmup: 0,
    min: 1,
    max: 1,
    budget: Duration::ZERO,
};

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
/// bytes above the level at the start of the run. What `f` returns is
/// released after the timer stops.
fn measure<T>(it: Iters, mut f: impl FnMut() -> T) -> Sample {
    for _ in 0..it.warmup {
        black_box(f());
    }
    let mut s = Sample {
        nanos: vec![],
        allocated: vec![],
        allocations: vec![],
        peak: 0,
    };
    let started = now();
    while s.nanos.len() < it.max
        && (s.nanos.len() < it.min || now().duration_since(started) < it.budget)
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

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Full,
    Smoke,
}

struct Bench {
    mode: Mode,
    lines: Vec<String>,
    /// Every `m|what` emitted, for the smoke mode's coverage check.
    kinds: BTreeSet<String>,
    /// The group counts the whole build was measured at.
    build_groups: BTreeSet<u64>,
    measured: usize,
}

impl Bench {
    fn smoke(&self) -> bool {
        self.mode == Mode::Smoke
    }
    fn line(&mut self, v: Value) {
        let text = v.to_string();
        println!("{text}");
        self.lines.push(text);
    }
    fn time<T>(&mut self, it: Iters, tags: Value, f: impl FnMut() -> T) {
        let it = if self.smoke() { SMOKE } else { it };
        let s = measure(it, f);
        self.emit(tags, &s);
    }
    fn emit(&mut self, mut tags: Value, s: &Sample) {
        let field = |k: &str| match &tags[k] {
            Value::Null => String::new(),
            Value::String(x) => x.clone(),
            v => v.to_string(),
        };
        let kind = format!("{}|{}", field("m"), field("what"));
        let case = ["m", "data", "what", "policy", "voted", "by"]
            .iter()
            .map(|k| field(k))
            .collect::<Vec<_>>()
            .join("|");
        let mut ns = s.nanos.clone();
        ns.sort_unstable();
        let mut al = s.allocated.clone();
        al.sort_unstable();
        let mut ac = s.allocations.clone();
        ac.sort_unstable();
        assert!(!ns.is_empty() && ns[0] <= ns[ns.len() - 1]);
        let us = |v: u64| v as f64 / 1000.0;
        let obj = tags.as_object_mut().unwrap();
        obj.insert("case".into(), json!(case));
        obj.insert("iters".into(), json!(ns.len()));
        obj.insert("min_us".into(), json!(us(ns[0])));
        obj.insert("p50_us".into(), json!(us(pct(&ns, 0.50))));
        obj.insert("p90_us".into(), json!(us(pct(&ns, 0.90))));
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
        if kind == "build|whole build (floor plan)" {
            self.build_groups.insert(tags["groups"].as_u64().unwrap());
        }
        self.kinds.insert(kind);
        self.measured += 1;
        self.line(tags);
    }
}

fn tag(m: &str, what: &str, data: &str, n: usize, groups: usize) -> Value {
    json!({"m": m, "what": what, "data": data, "n": n, "groups": groups})
}

fn with(mut v: Value, k: &str, x: Value) -> Value {
    v.as_object_mut().unwrap().insert(k.into(), x);
    v
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
    fn units(&mut self) -> Vec<Unit> {
        (0..64).map(|_| Unit::new(self.unit()).unwrap()).collect()
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
/// uniform in [0, 3). With at least one group every comment has at least one
/// cell, so every comment is scored; with no group no comment is. Ids are
/// sparse (7i + 3), in creation order.
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

/// The same conversation with one comment in `every` declared meta (the
/// first, then every `every`-th, in creation order). Meta comments keep their
/// votes; under `meta_policy = exclude` the weights list them as excluded.
fn with_meta(mut c: Conversation, every: usize) -> Conversation {
    c.meta = c.comments.iter().step_by(every).map(|cm| cm.id).collect();
    c.label = format!("{}-meta{}pct", c.label, 100 / every);
    c
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
// Frames: from the decoded projection, through the public constructors. This
// loader is bench code; it is not the frames adapter.

struct Frames {
    counts: HistoricalCountFrame,
    extremity: ExtremityFrame,
    groups: CurrentGroupFrame,
    meta: MetaComments,
}

fn sid(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

fn dbg(e: impl std::fmt::Debug) -> String {
    format!("{e:?}")
}

fn frames_from_value(v: &Value) -> Result<Frames, String> {
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
    .map_err(dbg)?;
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
                Counts::from_seen(a as u32, d as u32, s).map_err(dbg)?,
            ));
            let e = summed.entry(tid).or_default();
            e[0] += a;
            e[1] += d;
            e[2] += s;
        }
    }
    // Summed over groups, the latest update's counts: `base-counts:lag-0`.
    let mut summed_counts = vec![];
    for (tid, [a, d, s]) in summed {
        summed_counts.push((
            CommentId::new(tid),
            Counts::from_seen(a as u32, d as u32, s).map_err(dbg)?,
        ));
    }
    let counts =
        HistoricalCountFrame::new(sid("bench:base-counts:lag-0"), summed_counts).map_err(dbg)?;
    let groups =
        CurrentGroupFrame::new(sid("bench:current-groups"), members, cells, None).map_err(dbg)?;
    let meta_ids: Vec<CommentId> = v
        .get("meta-tids")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| CommentId::new(t.as_u64().unwrap() as u32))
                .collect()
        })
        .unwrap_or_default();
    Ok(Frames {
        counts,
        extremity,
        groups,
        meta: MetaComments::new(meta_ids).map_err(dbg)?,
    })
}

// ---------------------------------------------------------------------------
// Rules and the build.

fn symmetric(policy: MetaPolicy) -> SymmetricParams {
    SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap()
}

fn floor_params(base: SymmetricParams) -> FloorParams {
    let gic = SymmetricGicParams::new(base, ConsensusForm::GicGeomean1, GicParams::default());
    FloorParams::new(gic, 0.1).unwrap()
}

fn plan_from_frames(f: &Frames, p: &FloorParams) -> Result<FloorPlan, String> {
    let w = symmetric_gic_1(p.base(), &f.counts, &f.extremity, &f.groups, &f.meta).map_err(dbg)?;
    symmetric_gic_floor_1(p, w, &f.meta).map_err(dbg)
}

/// What a request has in hand under strategy B: the plan, and the meta set
/// the build read with it (the plan keeps its own copy and does not expose
/// it, so a caller that must filter meta comments keeps this one).
struct Built {
    plan: FloorPlan,
    meta: MetaComments,
    exclude: bool,
}

/// The whole build, as one operation: bytes decoded, frames validated, the
/// floor plan built, and the decoded value and every frame but the meta set
/// released before it returns.
fn whole_build(bytes: &[u8], p: &FloorParams) -> Result<Built, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(dbg)?;
    let frames = frames_from_value(&value)?;
    drop(value);
    let plan = plan_from_frames(&frames, p)?;
    let Frames {
        counts,
        extremity,
        groups,
        meta,
    } = frames;
    drop((counts, extremity, groups));
    Ok(Built {
        plan,
        meta,
        exclude: p.base().base().meta_policy() == MetaPolicy::Exclude,
    })
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

// ---------------------------------------------------------------------------
// The caller's sequences.

struct Src {
    weights: SourceId,
    request: SourceId,
}

#[derive(Clone, Copy)]
enum Seq {
    /// The design's sequence (section 8): the probabilities preflight, then
    /// the draw.
    Preflight,
    /// One draw call; its refusals are the preflight's.
    Single,
}

impl Seq {
    fn what(self) -> &'static str {
        match self {
            Seq::Preflight => "P: candidates + probabilities + draw + receipt",
            Seq::Single => "S: candidates + draw + receipt",
        }
    }
}

/// The rows the candidate query returns, less the meta comments when the
/// plan's policy excludes them (the caller's step; `filter = false` is the
/// caller that forgets it).
fn eligible(b: &Built, rows: &[CommentId], filter: bool) -> Vec<CommentId> {
    if filter && b.exclude {
        rows.iter()
            .copied()
            .filter(|id| !b.meta.contains(*id))
            .collect()
    } else {
        rows.to_vec()
    }
}

/// One request's work from the candidate query's ordered rows to the
/// receipt's canonical text. A refusal means today's path serves.
fn run_seq(
    seq: Seq,
    b: &Built,
    rows: &[CommentId],
    filter: bool,
    unit: Unit,
    src: &Src,
) -> Result<String, DrawRefusal> {
    let c = Candidates::new(eligible(b, rows, filter))?;
    if matches!(seq, Seq::Preflight) {
        b.plan.probabilities(&c)?;
    }
    Ok(b.plan
        .draw(&c, unit, &src.weights, &src.request)?
        .to_plain())
}

/// Checks one result: a receipt reads back to the same text and names an
/// eligible candidate with a chance in (0, 1] among exactly these
/// candidates. Returns the outcome's name.
fn outcome(r: &Result<String, DrawRefusal>, eligible: &[CommentId]) -> String {
    match r {
        Ok(text) => {
            let d = Drawn::from_plain(text).expect("the receipt reads back");
            assert_eq!(&d.to_plain(), text, "the receipt's text is canonical");
            assert!(eligible.contains(&d.comment()), "an eligible comment");
            assert_eq!(d.candidate_count(), eligible.len());
            assert!(d.probability() > 0.0 && d.probability() <= 1.0);
            "ok".into()
        }
        Err(e) => format!("refused: {e:?}"),
    }
}

/// Both sequences over the same rows: checked to give the same outcome and
/// the same receipt for the same unit, then each timed. Returns the outcome.
fn seq_pair(
    bench: &mut Bench,
    b: &Built,
    rows: &[CommentId],
    filter: bool,
    tags: &Value,
    it: Iters,
    rng: &mut Rng,
) -> String {
    let src = Src {
        weights: sid("bench:plan"),
        request: sid("bench:request"),
    };
    let units = rng.units();
    let el = eligible(b, rows, filter);
    let p = run_seq(Seq::Preflight, b, rows, filter, units[0], &src);
    let s = run_seq(Seq::Single, b, rows, filter, units[0], &src);
    let o = outcome(&p, &el);
    assert_eq!(o, outcome(&s, &el), "the two sequences end alike");
    assert_eq!(p.as_ref().ok(), s.as_ref().ok(), "the same receipt");
    for seq in [Seq::Preflight, Seq::Single] {
        let mut k = 0usize;
        let t = with(
            with(tags.clone(), "what", json!(seq.what())),
            "outcome",
            json!(o),
        );
        bench.time(it, t, || {
            k = (k + 1) % units.len();
            run_seq(seq, b, rows, filter, units[k], &src)
        });
    }
    o
}

// ---------------------------------------------------------------------------
// The participant: a voted set by count (uniform at random) or by weight
// (drawn without replacement by the plan's own weights, heavy ones first).

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

fn plan_weight(plan: &FloorPlan, id: CommentId) -> f64 {
    plan.weights().get(id).map_or(1.0, |s| s.weight().get())
}

// ---------------------------------------------------------------------------
// Strategy C, as reference bench code (not crate code), measured only at the
// point T4 names: one table of running sums over every comment's base weight;
// a draw picks a position by binary search and retries (cap 32) when the
// participant may not get it, then falls back to the exact pass over the
// eligible comments. Its law is w_j / W_p with no floor lane, it writes no
// receipt, and its time includes making the eligibility mask from the voted
// list. One simple implementation, not a bound on every C.

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
        let w = plan_weight(plan, *id);
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

fn bench_c(
    bench: &mut Bench,
    b: &Built,
    ids: &[CommentId],
    voted: &BTreeSet<CommentId>,
    base: &Value,
) {
    let ctab = c_table(&b.plan, ids);
    let vf: Vec<CommentId> = voted.iter().copied().collect();
    let total: f64 = ids.iter().map(|id| plan_weight(&b.plan, *id)).sum();
    let gone: f64 = vf.iter().map(|id| plan_weight(&b.plan, *id)).sum();
    let mut tries = vec![];
    let mut fell = 0u32;
    let mut crng = Rng(77);
    for _ in 0..2000 {
        let (_, tr, fb) = c_draw(&ctab, &vf, &mut crng);
        tries.push(u64::from(tr));
        fell += u32::from(fb);
    }
    tries.sort_unstable();
    let mut v = with(
        base.clone(),
        "what",
        json!("C reference: table, cap 32, exact fallback"),
    );
    v = with(v, "m", json!("C"));
    v = with(v, "tries_p50", json!(pct(&tries, 0.5)));
    v = with(v, "tries_p99", json!(pct(&tries, 0.99)));
    v = with(v, "fallback_rate", json!(f64::from(fell) / 2000.0));
    v = with(v, "mass_removed", json!(gone / total));
    v = with(v, "remaining", json!(ids.len() - vf.len()));
    bench.time(ROW, v, || c_draw(&ctab, &vf, &mut crng));
}

// ---------------------------------------------------------------------------
// The cases.

#[derive(Clone, Copy, PartialEq)]
enum Detail {
    /// The thresholds' own case: components, every voted fraction, today's
    /// draw and uniform/1 beside the floor.
    Full,
    /// Another shape at the same size: the whole build and both sequences at
    /// 0 and 50 percent voted.
    Light,
}

/// The whole build, its retained and peak bytes; then the requests.
fn bench_conversation(
    bench: &mut Bench,
    conv: &Conversation,
    bytes: &[u8],
    detail: Detail,
    policy: MetaPolicy,
    c_point: bool,
) {
    let n = conv.comments.len();
    let g = conv.groups.len();
    let d = conv.label.as_str();
    let pname = format!("{policy:?}");
    let p = floor_params(symmetric(policy));
    bench.line(
        json!({"m": "data", "data": d, "n": n, "groups": g, "policy": pname,
        "projection_bytes": bytes.len(), "meta": conv.meta.len()}),
    );
    let tg = |m: &str, what: &str| with(tag(m, what, d, n, g), "policy", json!(pname));

    // The whole build, timed as one operation.
    let first = whole_build(bytes, &p);
    let build_outcome = match &first {
        Ok(_) => "ok".to_string(),
        Err(e) => format!("refused: {e}"),
    };
    drop(first);
    bench.time(
        BUILD,
        with(
            tg("build", "whole build (floor plan)"),
            "outcome",
            json!(build_outcome),
        ),
        || whole_build(bytes, &p),
    );
    let (built, kept) = retained(|| whole_build(bytes, &p));
    bench.line(with(
        tg("bytes", "retained by the built plan and meta set"),
        "retained_bytes",
        json!(kept),
    ));
    let Ok(b) = built else {
        return;
    };

    // Components, for comparison with the first measurement only.
    if detail == Detail::Full {
        bench.time(BUILD, tg("build", "component: decode"), || {
            serde_json::from_slice::<Value>(bytes).unwrap()
        });
        let value: Value = serde_json::from_slice(bytes).unwrap();
        bench.time(BUILD, tg("build", "component: frames"), || {
            frames_from_value(&value).unwrap()
        });
        let frames = frames_from_value(&value).unwrap();
        bench.time(
            BUILD,
            tg("build", "component: floor plan from frames"),
            || plan_from_frames(&frames, &p).unwrap(),
        );
    }

    let ids: Vec<CommentId> = conv.comments.iter().map(|c| CommentId::new(c.id)).collect();
    let mut rng = Rng(0x5EED_0000 + n as u64);
    let fractions: &[(f64, &str)] = match detail {
        Detail::Full => &[
            (0.0, "count"),
            (0.5, "count"),
            (0.95, "count"),
            (0.999, "count"),
            (0.0, "weight"),
            (0.95, "weight"),
        ],
        Detail::Light => &[(0.0, "count"), (0.5, "count")],
    };
    let seq_iters = if detail == Detail::Full {
        THRESHOLD
    } else {
        ROW
    };
    let sw = (detail == Detail::Full).then(|| {
        let value: Value = serde_json::from_slice(bytes).unwrap();
        stored(&frames_from_value(&value).unwrap())
    });
    for &(frac, by) in fractions {
        let voted = if by == "count" {
            voted_by_count(&ids, frac, &mut rng)
        } else {
            voted_by_weight(&ids, |id| plan_weight(&b.plan, id), frac, &mut rng)
        };
        let rows = remaining(&ids, &voted);
        if rows.is_empty() {
            continue;
        }
        let base = with(with(tg("seq", ""), "voted", json!(frac)), "by", json!(by));
        let o = seq_pair(bench, &b, &rows, true, &base, seq_iters, &mut rng);
        assert_eq!(o, "ok", "an ordinary request draws");
        if b.exclude {
            bench.time(
                ROW,
                with(base.clone(), "what", json!("caller filter")),
                || eligible(&b, &rows, true),
            );
        }
        if let (Some(sw), "count") = (&sw, by) {
            let src = sid("bench:request");
            let units = rng.units();
            let mut k = 0usize;
            bench.time(
                ROW,
                with(
                    base.clone(),
                    "what",
                    json!("stored-weights/1: candidates + draw + receipt"),
                ),
                || {
                    k = (k + 1) % units.len();
                    let c = Candidates::new(rows.clone()).unwrap();
                    stored_weights_1(Some(sw), &c, units[k], &src)
                        .unwrap()
                        .to_plain()
                },
            );
            bench.time(
                ROW,
                with(
                    base.clone(),
                    "what",
                    json!("uniform/1: candidates + draw + receipt"),
                ),
                || {
                    k = (k + 1) % units.len();
                    let c = Candidates::new(rows.clone()).unwrap();
                    uniform_1(&c, units[k], &src).unwrap().to_plain()
                },
            );
            if frac == 0.0 {
                bench.time(
                    ROW,
                    with(base.clone(), "what", json!("component: Candidates::new")),
                    || Candidates::new(rows.clone()).unwrap(),
                );
                let c = Candidates::new(rows.clone()).unwrap();
                bench.time(
                    ROW,
                    with(base.clone(), "what", json!("component: probabilities")),
                    || b.plan.probabilities(&c).unwrap(),
                );
            }
        }
        if c_point && frac == 0.95 && by == "weight" {
            bench_c(bench, &b, &ids, &voted, &base);
        }
    }
}

/// The meta and excluded sets: one comment in ten, and one in two, declared
/// meta, under `exclude` (the caller filters) and under today's `fixed`.
fn bench_meta(bench: &mut Bench, n: usize) {
    for every in [10usize, 2] {
        let conv = with_meta(constructed(n, 5, 1000 + n as u64), every);
        let bytes = projection(&conv);
        bench_conversation(
            bench,
            &conv,
            &bytes,
            Detail::Light,
            MetaPolicy::Exclude,
            false,
        );
        bench_conversation(
            bench,
            &conv,
            &bytes,
            Detail::Light,
            MetaPolicy::Fixed,
            false,
        );
    }
}

/// The edge and refusal cases a caller can hit, at size n, 5 groups, nothing
/// voted. Each ends as asserted, in every mode.
fn bench_edges(bench: &mut Bench, n: usize) {
    let conv = constructed(n, 5, 1000 + n as u64);
    let d = conv.label.clone();
    let bytes = projection(&conv);
    let p = floor_params(symmetric(MetaPolicy::Fixed));
    let b = whole_build(&bytes, &p).unwrap();
    let ids: Vec<CommentId> = conv.comments.iter().map(|c| CommentId::new(c.id)).collect();
    let mut rng = Rng(0xED6E);
    let base = |what: &str| {
        with(
            with(tag("edge", "", &d, n, 5), "voted", json!(0.0)),
            "by",
            json!(what),
        )
    };
    let o = seq_pair(
        bench,
        &b,
        &[],
        true,
        &base("no candidates left"),
        ROW,
        &mut rng,
    );
    assert_eq!(o, "refused: Empty");
    let o = seq_pair(
        bench,
        &b,
        &ids[..1],
        true,
        &base("one candidate"),
        ROW,
        &mut rng,
    );
    assert_eq!(o, "ok");
    let mut unknown = ids.clone();
    unknown.push(CommentId::new(u32::MAX - 1));
    let o = seq_pair(
        bench,
        &b,
        &unknown,
        true,
        &base("a candidate the plan does not know, last"),
        ROW,
        &mut rng,
    );
    assert!(o.starts_with("refused: NeedsBaseline"), "{o}");

    // A caller that forgets to filter meta comments under `exclude`.
    let mconv = with_meta(conv.clone(), 10);
    let pe = floor_params(symmetric(MetaPolicy::Exclude));
    let be = whole_build(&projection(&mconv), &pe).unwrap();
    let o = seq_pair(
        bench,
        &be,
        &ids,
        false,
        &base("an excluded meta candidate, not filtered"),
        ROW,
        &mut rng,
    );
    assert!(o.starts_with("refused: ExcludedCandidate"), "{o}");

    // Every candidate unscored: no group, so no counts at all.
    let uconv = constructed(n, 0, 1000 + n as u64);
    let bu = whole_build(&projection(&uconv), &p).unwrap();
    let uids: Vec<CommentId> = uconv
        .comments
        .iter()
        .map(|c| CommentId::new(c.id))
        .collect();
    let o = seq_pair(
        bench,
        &bu,
        &uids,
        true,
        &base("every candidate unscored"),
        ROW,
        &mut rng,
    );
    assert_eq!(o, "ok");

    // Every base weight zero cannot come from a built plan (the extremity
    // offset is refused below 1e-3, so every scored weight is positive); the
    // floor's arithmetic for it (the weighted share donated to the uniform
    // lane) is timed alone, without resolution or receipt.
    let zeros = vec![0.0; ids.len()];
    let zt = with(
        base("every base weight zero"),
        "what",
        json!("floor arithmetic only: floor_marginals + stable_cdf"),
    );
    bench.time(ROW, zt, || {
        let m = floor_marginals(0.1, &zeros).unwrap();
        assert_eq!(m.donations().len(), 1);
        stable_cdf(m.draw_weights(), Unit::new(0.5).unwrap()).unwrap()
    });

    // Every stored weight zero: today's draw through the crate.
    let json_map: serde_json::Map<String, Value> = conv
        .comments
        .iter()
        .map(|c| (c.id.to_string(), json!(0)))
        .collect();
    let zsw =
        StoredWeights::from_json(sid("bench:zeros"), &Value::Object(json_map).to_string()).unwrap();
    let src = sid("bench:request");
    let units = rng.units();
    let first =
        Candidates::new(ids.clone()).and_then(|c| stored_weights_1(Some(&zsw), &c, units[0], &src));
    let zo = match &first {
        Ok(drawn) => outcome(&Ok(drawn.to_plain()), &ids),
        Err(e) => format!("refused: {e:?}"),
    };
    let mut k = 0usize;
    let zt = with(base("every stored weight zero"), "outcome", json!(zo));
    bench.time(
        ROW,
        with(
            zt,
            "what",
            json!("every stored weight zero (stored-weights/1)"),
        ),
        || {
            k = (k + 1) % units.len();
            Candidates::new(ids.clone())
                .and_then(|c| stored_weights_1(Some(&zsw), &c, units[k], &src))
                .map(|x| x.to_plain())
        },
    );
}

/// Strategy E: everything per request, from the bytes: the whole build and
/// the design's sequence.
fn bench_e(bench: &mut Bench, conv: &Conversation, bytes: &[u8], frac: f64, it: Iters) {
    let n = conv.comments.len();
    let p = floor_params(symmetric(MetaPolicy::Fixed));
    let ids: Vec<CommentId> = conv.comments.iter().map(|c| CommentId::new(c.id)).collect();
    let mut rng = Rng(0xE000 + n as u64);
    let rows = remaining(&ids, &voted_by_count(&ids, frac, &mut rng));
    let src = Src {
        weights: sid("bench:plan"),
        request: sid("bench:request"),
    };
    let u = Unit::new(0.37).unwrap();
    let b = whole_build(bytes, &p).unwrap();
    let o = outcome(
        &run_seq(Seq::Preflight, &b, &rows, true, u, &src),
        &eligible(&b, &rows, true),
    );
    assert_eq!(o, "ok", "an ordinary request draws");
    drop(b);
    let t = with(
        with(
            tag(
                "E",
                "E: bytes + whole build + P",
                &conv.label,
                n,
                conv.groups.len(),
            ),
            "voted",
            json!(frac),
        ),
        "outcome",
        json!(o),
    );
    bench.time(it, t, || {
        let b = whole_build(bytes, &p).unwrap();
        run_seq(Seq::Preflight, &b, &rows, true, u, &src)
    });
}

/// The floor's resolution kernels (T5): the draw alone over a prebuilt
/// candidate list, all, half or no candidates unscored, and with large
/// excluded sets that are not candidates.
fn bench_kernels(bench: &mut Bench, n: usize) {
    let conv = constructed(n, 5, 4040 + n as u64);
    let value: Value = serde_json::from_slice(&projection(&conv)).unwrap();
    let full = frames_from_value(&value).unwrap();
    let ids: Vec<CommentId> = conv.comments.iter().map(|c| CommentId::new(c.id)).collect();
    let c = Candidates::new(ids.clone()).unwrap();
    let src = sid("bench:request");
    let fixed = floor_params(symmetric(MetaPolicy::Fixed));
    let exclude = floor_params(symmetric(MetaPolicy::Exclude));
    let mut plans: Vec<(&str, FloorPlan)> = vec![];
    // Every `step`-th comment keeps its counts; `None` keeps none.
    for (label, keep) in [
        ("all scored", Some(1usize)),
        ("half unscored", Some(2)),
        ("all unscored", None),
    ] {
        let mut counts = vec![];
        for (i, id) in ids.iter().enumerate() {
            if keep.is_some_and(|step| i % step == 0) {
                counts.push((*id, full.counts.get(*id).unwrap()));
            }
        }
        let f = Frames {
            counts: HistoricalCountFrame::new(sid("bench:base-counts:lag-0"), counts).unwrap(),
            extremity: full.extremity.clone(),
            groups: full.groups.clone(),
            meta: MetaComments::none(),
        };
        plans.push((label, plan_from_frames(&f, &fixed).unwrap()));
    }
    for (label, tenths) in [
        ("all scored, excluded 10%", 1usize),
        ("all scored, excluded 50%", 5),
    ] {
        let meta =
            MetaComments::new((0..n * tenths / 10).map(|i| CommentId::new(7 * i as u32 + 5)))
                .unwrap();
        let all: Vec<_> = ids
            .iter()
            .map(|id| (*id, full.counts.get(*id).unwrap()))
            .collect();
        let f = Frames {
            counts: HistoricalCountFrame::new(sid("bench:base-counts:lag-0"), all).unwrap(),
            extremity: full.extremity.clone(),
            groups: full.groups.clone(),
            meta,
        };
        plans.push((label, plan_from_frames(&f, &exclude).unwrap()));
    }
    for (label, plan) in &plans {
        let base = with(tag("M8", "", &conv.label, n, 5), "set", json!(label));
        let base = with(base, "by", json!(label));
        bench.time(
            ROW,
            with(base.clone(), "what", json!("probabilities")),
            || plan.probabilities(&c).unwrap(),
        );
        let mut rng = Rng(9);
        bench.time(ROW, with(base, "what", json!("draw")), || {
            let u = Unit::new(rng.unit()).unwrap();
            plan.draw(&c, u, &src, &src).unwrap()
        });
    }
    let ones = vec![1.0; n];
    bench.time(
        ROW,
        tag("M8", "stable_cdf over n ones", &conv.label, n, 5),
        || stable_cdf(&ones, Unit::new(0.5).unwrap()).unwrap(),
    );
}

/// Every `m|what` the suite must emit; the smoke mode checks the list.
const REQUIRED: &[&str] = &[
    "build|whole build (floor plan)",
    "build|component: decode",
    "build|component: frames",
    "build|component: floor plan from frames",
    "seq|P: candidates + probabilities + draw + receipt",
    "seq|S: candidates + draw + receipt",
    "seq|caller filter",
    "seq|stored-weights/1: candidates + draw + receipt",
    "seq|uniform/1: candidates + draw + receipt",
    "seq|component: Candidates::new",
    "seq|component: probabilities",
    "edge|P: candidates + probabilities + draw + receipt",
    "edge|S: candidates + draw + receipt",
    "edge|every stored weight zero (stored-weights/1)",
    "edge|floor arithmetic only: floor_marginals + stable_cdf",
    "E|E: bytes + whole build + P",
    "M8|probabilities",
    "M8|draw",
    "M8|stable_cdf over n ones",
    "C|C reference: table, cap 32, exact fallback",
];

fn suite(bench: &mut Bench) {
    let smoke = bench.smoke();
    let big: &[usize] = if smoke { &[40, 60] } else { &[10_000, 40_000] };
    let e_sizes: &[usize] = if smoke {
        &[20, 30]
    } else {
        &[125, 250, 500, 1000, 2000]
    };
    let kernels: &[usize] = if smoke {
        &[20, 40]
    } else {
        &[1000, 10_000, 40_000]
    };

    // The design maximum and the stress size, at every group count.
    for &n in big {
        for g in [5u32, 0, 1, 2, 64] {
            let conv = constructed(n, g, 1000 + n as u64);
            let bytes = projection(&conv);
            let detail = if g == 5 { Detail::Full } else { Detail::Light };
            let c_point = g == 5 && n == big[big.len() - 1];
            bench_conversation(bench, &conv, &bytes, detail, MetaPolicy::Fixed, c_point);
        }
        bench_meta(bench, n);
    }
    bench_edges(bench, big[0]);
    for &n in e_sizes {
        for g in [2u32, 5] {
            let conv = constructed(n, g, 5000 + n as u64);
            let bytes = projection(&conv);
            for frac in [0.0, 0.5] {
                bench_e(bench, &conv, &bytes, frac, THRESHOLD);
            }
        }
    }
    let e_ref = constructed(big[0], 5, 1000 + big[0] as u64);
    bench_e(bench, &e_ref, &projection(&e_ref), 0.5, BUILD);
    for &n in kernels {
        bench_kernels(bench, n);
    }

    // A real math result (never in the smoke mode, which builds a small
    // real-shaped one instead so the loader runs).
    let real_bytes = if smoke {
        Some(projection(&constructed(30, 4, 31)))
    } else {
        real_math_result_path().map(|p| read_file(&p))
    };
    if let Some(bytes) = real_bytes {
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let real = conversation_from_value("real", &value);
        bench_conversation(bench, &real, &bytes, Detail::Full, MetaPolicy::Fixed, false);
        for frac in [0.0, 0.5] {
            bench_e(bench, &real, &bytes, frac, ROW);
        }
        for &n in big {
            let conv = resampled(&real, n, 3000 + n as u64);
            let bytes = projection(&conv);
            bench_conversation(
                bench,
                &conv,
                &bytes,
                Detail::Light,
                MetaPolicy::Fixed,
                false,
            );
        }
    }
}

fn main() {
    // `cargo bench` passes `--bench`; other arguments are ignored.
    let args: Vec<String> = std::env::args().collect();
    let out_path = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let mode = if args.iter().any(|a| a == "--smoke") {
        Mode::Smoke
    } else {
        Mode::Full
    };
    let mut bench = Bench {
        mode,
        lines: vec![],
        kinds: BTreeSet::new(),
        build_groups: BTreeSet::new(),
        measured: 0,
    };
    let iters = |i: Iters| json!({"warmup": i.warmup, "min": i.min, "max": i.max, "budget_ms": i.budget.as_millis() as u64});
    bench.line(json!({"m": "header",
        "mode": if mode == Mode::Smoke { "smoke" } else { "full" },
        "note": "constructed data are counts only; no vote value is written anywhere and no vote convention is involved",
        "iters": {"threshold": iters(THRESHOLD), "row": iters(ROW), "build": iters(BUILD)},
        "threads": 1,
        "not_measured": ["D not compared: not implemented", "the lottery: not implemented",
            "concurrency (M11): one thread only", "SQL, pools, HTTP, cache lookup, entropy"],
        "real_math_result": mode == Mode::Full && real_math_result_path().is_some()}));

    suite(&mut bench);

    if bench.smoke() {
        let missing: Vec<&&str> = REQUIRED
            .iter()
            .filter(|k| !bench.kinds.contains(**k))
            .collect();
        assert!(missing.is_empty(), "cases not run: {missing:?}");
        for g in [0u64, 1, 2, 5, 64] {
            assert!(
                bench.build_groups.contains(&g),
                "no whole build at {g} groups"
            );
        }
        println!(
            "smoke: ok, {} measured cases, {} kinds, every draw checked",
            bench.measured,
            bench.kinds.len()
        );
    }
    if let Some(p) = out_path {
        let mut text = bench.lines.join("\n");
        text.push('\n');
        write_file(&p, &text);
    }
}
