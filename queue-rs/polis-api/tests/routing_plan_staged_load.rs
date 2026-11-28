//! The source loader's steps after the read, under a counting allocator (per
//! thread; a moving reallocation counts as an allocation and a free): from
//! the bytes received to the plan ready to publish, what is alive never
//! exceeds what the build's one reservation holds, at any moment of any
//! step, and the receive buffer and the projection are gone before the
//! build. The read itself needs a database and is covered by the loader's
//! database tests; here the bytes are what the statement would send for a
//! constructed conversation, including the 10,000- and 40,000-comment
//! witnesses (five groups, every twentieth comment meta). The loader and
//! the wrapper are compiled here on their own. Constructed conversations
//! and made-up ids only.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

#[path = "../src/routing_plan/cache.rs"]
mod cache;
#[path = "../src/routing_plan/load.rs"]
mod load;

use cache::RoutingPlanCache;
use load::{Hooks, Job, Outcome, Stage, limits, stages};
use polis_routing_plan::{
    DEFAULT_CACHE_BYTES, MAX_SHARE_DIVISOR, Projection, RowIdentity, RuleConfig,
};
use serde_json::{Map, Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
        let live = LIVE.with(|l| {
            l.set(l.get() + size as i64);
            l.get()
        });
        PEAK.with(|p| p.set(p.get().max(live)));
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

const STORED: &str = r#"{"rule":"stored-weights/1","params":{},"terms":[]}"#;
const UNIFORM: &str = r#"{"rule":"uniform/1","params":{},"terms":[]}"#;
const FLOOR: &str = r#"{"rule":"symmetric-gic-floor/2","params":{"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0,"meta_policy":"exclude","consensus_form":"gic-geomean/1","gic_offset":0.5,"gic_min_groups":2,"floor_share":0.1},"terms":[]}"#;
/// The floor with meta comments weighed by a fixed factor: `exclude` is
/// refused past 10,000 comments by the rule itself.
const FLOOR_FIXED: &str = r#"{"rule":"symmetric-gic-floor/2","params":{"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0,"meta_policy":"fixed","consensus_form":"gic-geomean/1","gic_offset":0.5,"gic_min_groups":2,"floor_share":0.1},"terms":[]}"#;
const FLOOR_POLICY: &str = "base-counts:lag-0";
const DIGEST: [u8; 32] = [7; 32];
const ENV: &str = "example";

fn job(text: &str, policy: Option<&str>) -> Job {
    let rule = RuleConfig::parse(text, policy).unwrap();
    Job {
        zid: 7,
        math_env: ENV.into(),
        desired_tick: 41,
        rule_plain: rule.to_plain(),
        rule,
        policy: policy.map(Into::into),
        config_digest: DIGEST,
    }
}

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// `n` comments in `groups` groups, every `meta_every`-th comment meta, with
/// stored weights: the projection the statement sends, in its key order.
fn projection_bytes(seed: u64, n: usize, groups: u32, meta_every: usize) -> Vec<u8> {
    let mut rng = XorShift(seed | 1);
    let tids: Vec<i32> = (0..n)
        .map(|i| (5 * i + 1) as i32 + rng.below(4) as i32)
        .collect();
    let extremity: Vec<f64> = tids.iter().map(|_| 3.0 * rng.unit()).collect();
    let meta: Vec<i32> = tids
        .iter()
        .enumerate()
        .filter(|(i, _)| i % meta_every == 0)
        .map(|(_, t)| *t)
        .collect();
    let mut group_votes = Map::new();
    let mut group_clusters = vec![];
    let mut base_ids = vec![];
    let mut base_members = vec![];
    for g in 0..groups {
        let members = 30 + 7 * g;
        let mut votes = Map::new();
        for t in &tids {
            if rng.below(10) < 9 {
                let seen = rng.below(u64::from(members) + 1);
                let agreed = rng.below(seen + 1);
                let disagreed = rng.below(seen - agreed + 1);
                votes.insert(
                    t.to_string(),
                    json!({"A": agreed, "D": disagreed, "S": seen}),
                );
            }
        }
        group_votes.insert(
            g.to_string(),
            json!({"id": g, "n-members": members, "votes": votes}),
        );
        group_clusters.push(json!({"id": g, "members": [100 + g], "center": [0.0, 0.0]}));
        base_ids.push(100 + g);
        base_members.push((0..members).map(|k| g * 1000 + k).collect::<Vec<u32>>());
    }
    let priorities: Map<String, Value> = tids
        .iter()
        .map(|t| (t.to_string(), json!(10.0 * rng.unit() + 0.01)))
        .collect();
    let value = json!({
        "group-votes": group_votes,
        "pca": {"comment-extremity": extremity},
        "tids": tids,
        "meta-tids": meta,
        "comment-priorities": priorities,
        "group-clusters": group_clusters,
        "base-clusters": {
            "id": base_ids,
            "members": base_members,
            "count": vec![0; groups as usize],
            "x": vec![0.0; groups as usize],
            "y": vec![0.0; groups as usize]
        }
    });
    serde_json::to_vec(&value).unwrap()
}

/// At each stage: what the reservation holds, what is alive, and the most
/// alive since the stage before. Preallocated, so recording allocates
/// nothing.
struct Count(Vec<(Stage, u64, i64, i64)>);
impl Hooks for Count {
    fn reserved(&mut self, stage: Stage, bytes: u64) {
        let live = LIVE.with(Cell::get);
        let peak = PEAK.with(Cell::get);
        assert!(self.0.len() < self.0.capacity());
        self.0.push((stage, bytes, live, peak));
        PEAK.with(|p| p.set(live));
    }
}

/// One staged build of `bytes` under `j`, counted from the moment the
/// received bytes exist. Returns each stage's record and the outcome.
fn counted(c: &std::sync::Arc<RoutingPlanCache>, j: &Job, bytes: &[u8]) -> (Count, Outcome) {
    let l = limits(&j.rule);
    let mut hooks = Count(Vec::with_capacity(16));
    // The cache's lock is taken once before counting: on some platforms a
    // mutex allocates its system lock at its first use, once per cache,
    // which is the cache's and not the build's.
    let _ = c.budget().unwrap();
    LIVE.with(|v| v.set(0));
    PEAK.with(|v| v.set(0));
    ON.with(|o| o.set(true));
    // What the read hands over: the received bytes (exact, as the driver's
    // text is) and the row with its environment.
    let received = bytes.to_vec();
    let row = RowIdentity {
        zid: j.zid,
        math_env: ENV.into(),
        math_tick: 41,
        last_vote_timestamp: Some(1_700_000_000_000),
        db_now_ms: 1_700_000_100_000,
    };
    let reserved = c.admit_read(l.max_bytes, &l).unwrap().unwrap();
    let result = stages(c, reserved, received, row, j, &mut hooks);
    ON.with(|o| o.set(false));
    let outcome = match result {
        Ok((reserved, cached)) => match reserved.publish(cache::PlanRef::new(cached)) {
            Ok(()) => Outcome::Published,
            Err(_) => Outcome::KeyMismatch,
        },
        Err(o) => o,
    };
    (hooks, outcome)
}

/// Live never exceeds the reservation: at each stage boundary, and at the
/// most alive in between (the reservation in force between two stages is
/// the earlier one: a step grows before it allocates and frees before it
/// cuts down).
fn assert_within(label: &str, n: &Count) {
    let mut before = None;
    for &(stage, bytes, live, peak) in &n.0 {
        assert!(
            live >= 0 && live as u64 <= bytes,
            "{label}: {stage:?}: live {live} over reserved {bytes}"
        );
        if let Some(held) = before {
            assert!(
                peak as u64 <= held,
                "{label}: up to {stage:?}: peak {peak} over reserved {held}"
            );
        }
        before = Some(bytes);
    }
}

fn at(n: &Count, s: Stage) -> (u64, i64, i64) {
    let r = n.0.iter().find(|r| r.0 == s).unwrap();
    (r.1, r.2, r.3)
}

/// The order and the bound at each stage, on constructed conversations of
/// several shapes, for every rule.
#[test]
fn staged_build_never_holds_more_than_reserved() {
    for (n, groups) in [(3usize, 1u32), (300, 3), (2_000, 5), (1_000, 64)] {
        let bytes = projection_bytes(n as u64, n, groups, 20);
        for (text, policy) in [
            (STORED, None),
            (UNIFORM, None),
            (FLOOR, Some(FLOOR_POLICY)),
            (FLOOR_FIXED, Some(FLOOR_POLICY)),
        ] {
            let c = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(DIGEST)).unwrap();
            let j = job(text, policy);
            let (counts, outcome) = counted(&c, &j, &bytes);
            let label = format!("{n} comments, {groups} groups, {}", &text[9..30]);
            assert_eq!(outcome, Outcome::Published, "{label}");
            assert_eq!(counts.0.len(), 8, "{label}");
            assert_within(&label, &counts);
        }
    }
}

/// The receive buffer is gone before the frames stage, and the projection
/// before the build stage: what is alive falls by at least the buffer's
/// length, then by at least the projection's text (live within the
/// reservation alone would not see either kept: the build stage's slack is
/// larger than both).
#[test]
fn projection_and_buffer_dropped_before_build() {
    let bytes = projection_bytes(5, 2_000, 5, 20);
    let j = job(FLOOR, Some(FLOOR_POLICY));
    let c = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(DIGEST)).unwrap();
    let raw = {
        let l = limits(&j.rule);
        let row = RowIdentity {
            zid: 7,
            math_env: ENV.into(),
            math_tick: 41,
            last_vote_timestamp: None,
            db_now_ms: 0,
        };
        Projection::parse(&bytes, row, &l).unwrap().raw_len() as i64
    };
    let (counts, outcome) = counted(&c, &j, &bytes);
    assert_eq!(outcome, Outcome::Published);
    let (_, parsed, _) = at(&counts, Stage::Parsed);
    let (_, framing, _) = at(&counts, Stage::Framing);
    let (_, framed, _) = at(&counts, Stage::Framed);
    let (_, building, _) = at(&counts, Stage::Building);
    // The key is made between, so the fall is the buffer less the key.
    assert!(parsed - framing >= bytes.len() as i64 - 1024, "buffer kept");
    assert!(framed - building >= raw, "projection kept");
}

/// The 10,000- and 40,000-comment witnesses are admitted in one share
/// under every rule, every stage within its reservation; prints each
/// stage's reservation and, per witness, the bytes, the parse peak, the
/// build peak and the plan's charge.
#[test]
fn loader_admits_both_witnesses_in_one_share() {
    let share = DEFAULT_CACHE_BYTES / MAX_SHARE_DIVISOR;
    for (n, seed) in [(10_000usize, 51u64), (40_000, 52)] {
        let bytes = projection_bytes(seed, n, 5, 20);
        for (text, policy) in [
            (STORED, None),
            (UNIFORM, None),
            (FLOOR_FIXED, Some(FLOOR_POLICY)),
        ] {
            let c = RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(DIGEST)).unwrap();
            let j = job(text, policy);
            assert!((bytes.len() as u64) <= limits(&j.rule).max_bytes);
            let (counts, outcome) = counted(&c, &j, &bytes);
            let label = format!(
                "{n} comments, {}",
                &text[9..text.find("\",\"params").unwrap()]
            );
            assert_eq!(outcome, Outcome::Published, "{label}");
            assert_within(&label, &counts);
            let most = counts.0.iter().map(|r| r.1).max().unwrap();
            assert!(most <= share, "{label}");
            let stagewise: Vec<String> = counts
                .0
                .iter()
                .map(|(s, b, live, peak)| {
                    format!("{s:?} reserved {b} live {live} peak-before {peak}")
                })
                .collect();
            println!(
                "{label}: bytes {}; most reserved {most} of share {share}",
                bytes.len()
            );
            for line in stagewise {
                println!("{label}:   {line}");
            }
            println!(
                "{label}: parse peak {} of {}; build peak {} of {}; plan charged {}",
                at(&counts, Stage::Parsed).2,
                at(&counts, Stage::Parsing).0,
                at(&counts, Stage::Built).2,
                at(&counts, Stage::Building).0,
                at(&counts, Stage::BeforePublish).0
            );
        }
    }
}
