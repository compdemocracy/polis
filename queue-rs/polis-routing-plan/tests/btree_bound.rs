//! The ordered-map charge (`ordered_maps_charge`, a fifth of a node per entry
//! plus one node per map) against the standard library's B-tree as built,
//! counted by a counting allocator (per thread, as in `tests/allocation.rs`,
//! with a moving reallocation counted as holding the old and the new buffer).
//!
//! Every key and value shape the bounds charge a map for, built by every
//! operation the build path uses on one: insertion in ascending, descending,
//! random, middle-first and least-full order, `entry`, collect from sorted
//! and from unsorted input, and clone; checked after every insertion from 0
//! to 40,000 entries (200,000 for the random and least-full orders), so just
//! past every node split, and collect and clone at every size to 300, around
//! the bulk build's node boundaries to 5,000, and at 40,000 and 200,000.
//!
//! The bound rests on the B-tree's implementation (five entries at least in
//! every node but the root, and the node's layout), not on its
//! documentation. A toolchain whose nodes are less full or larger fails
//! here; the crate refuses every such bound under any rustc but
//! `REVIEWED_RUSTC` (the last two tests).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    CommentId, Counts, Extremity, GroupId, MetaPolicy, Scored, StoredWeight,
};
use polis_routing_plan::{
    Plan, Projection, REVIEWED_RUSTC, SourceLimits, Tally, ordered_maps_charge, std_bounds_reviewed,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::mem::{align_of, size_of};
use support::*;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
    static BLOCKS: Cell<i64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
        BLOCKS.with(|b| b.set(b.get() + 1));
        LIVE.with(|l| {
            let live = l.get() + size as i64;
            l.set(live);
            PEAK.with(|p| p.set(p.get().max(live)));
        });
    }
}

fn on_free(size: usize) {
    if ON.with(Cell::get) {
        BLOCKS.with(|b| b.set(b.get() - 1));
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

/// What one measured operation left and reached: blocks still held (for a
/// map, its nodes), bytes still held, and the peak of live bytes above the
/// start.
#[derive(Clone, Copy, Debug)]
struct Stat {
    blocks: i64,
    live: i64,
    peak: i64,
}

/// Runs `f` with the counters on, nested measurements allowed: the outer
/// peak is left as it was.
fn counted<T>(f: impl FnOnce() -> T) -> (T, Stat) {
    let was = ON.with(|o| o.replace(true));
    let (l0, b0, p0) = (
        LIVE.with(Cell::get),
        BLOCKS.with(Cell::get),
        PEAK.with(Cell::get),
    );
    PEAK.with(|p| p.set(l0));
    let out = f();
    let stat = Stat {
        blocks: BLOCKS.with(Cell::get) - b0,
        live: LIVE.with(Cell::get) - l0,
        peak: PEAK.with(Cell::get) - l0,
    };
    PEAK.with(|p| p.set(p0));
    ON.with(|o| o.set(was));
    (out, stat)
}

/// At most `n / 5 + 1` nodes: the occupancy invariant, as the design states
/// it. Kept apart from the crate's charge on purpose.
fn node_bound(n: usize) -> i64 {
    (n / 5 + 1) as i64
}

fn charge<V>(n: usize, count: usize) -> i64 {
    ordered_maps_charge(n as u64, count as u64, 4, size_of::<V>() as u64).unwrap() as i64
}

/// The keys of each insertion order, `n` of them, all distinct.
fn ascending(n: usize) -> Vec<u32> {
    (0..n as u32).map(|i| i * 2).collect()
}

fn descending(n: usize) -> Vec<u32> {
    (0..n as u32).rev().map(|i| i * 2).collect()
}

fn random(n: usize, seed: u64) -> Vec<u32> {
    let mut keys = ascending(n);
    let mut rng = XorShift(seed);
    for i in (1..keys.len()).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        keys.swap(i, j);
    }
    keys
}

/// The middle of the range first, then the middles of each half, breadth
/// first.
fn middle_first(n: usize) -> Vec<u32> {
    let mut out = Vec::with_capacity(n);
    let mut queue = std::collections::VecDeque::from([(0usize, n)]);
    while let Some((lo, hi)) = queue.pop_front() {
        if lo >= hi {
            continue;
        }
        let mid = lo + (hi - lo) / 2;
        out.push(mid as u32 * 2);
        queue.push_back((lo, mid));
        queue.push_back((mid + 1, hi));
    }
    out
}

/// The order that leaves the nodes least full (from review): fill the
/// rightmost leaf to eleven, then insert between its sixth and seventh keys,
/// so the split (at kv 5, the new key going right) leaves five in a left
/// leaf that is never touched again; refill the right leaf by appending,
/// and repeat. Appends are even and increase by two, so there is always an
/// odd key between two neighbours. The parents only ever take separators at
/// their right end.
fn least_full(n: usize) -> Vec<u32> {
    let mut out = Vec::with_capacity(n);
    let mut leaf: Vec<u32> = Vec::with_capacity(11);
    let mut next = 0u32;
    while out.len() < n {
        if leaf.len() < 11 {
            leaf.push(next);
            out.push(next);
            next += 2;
        } else {
            let between = leaf[5] + 1;
            out.push(between);
            let mut right = vec![between];
            right.extend_from_slice(&leaf[6..]);
            leaf = right;
        }
    }
    out
}

/// The sizes at which collect and clone are measured: every size to 300,
/// either side of the bulk build's leaf (12), second-level (144) and
/// third-level (1,728) boundaries, and the large sizes.
fn sample_sizes(max: usize) -> Vec<usize> {
    let mut s: Vec<usize> = (0..=300).collect();
    for (step, to) in [(12usize, 1200usize), (144, 5000), (1728, 5000)] {
        let mut m = step;
        while m <= to {
            s.extend([m - 1, m, m + 1]);
            m += step;
        }
    }
    s.extend([5000, 40_000, 200_000]);
    s.retain(|&n| n <= max);
    s.sort_unstable();
    s.dedup();
    s
}

struct Worst {
    nodes: (i64, i64, usize),
    bytes: (i64, i64, usize),
}

impl Worst {
    fn new() -> Self {
        Self {
            nodes: (0, 1, 0),
            bytes: (0, 1, 0),
        }
    }
    fn see(&mut self, nodes: i64, bytes: i64, n: usize, bound_bytes: i64) {
        if nodes * self.nodes.1 > self.nodes.0 * node_bound(n) {
            self.nodes = (nodes, node_bound(n), n);
        }
        if bytes * self.bytes.1 > self.bytes.0 * bound_bytes {
            self.bytes = (bytes, bound_bytes, n);
        }
    }
}

/// Builds a map by inserting `keys` in order (by `entry` when `by_entry`),
/// checking nodes and bytes after every insertion, and collect and clone at
/// the sample sizes. Returns the map at full size and the worst cases.
fn grow<V: Default + Clone>(
    label: &str,
    keys: &[u32],
    by_entry: bool,
    collect: bool,
    samples: &[usize],
) -> (BTreeMap<u32, V>, Worst) {
    let mut worst = Worst::new();
    let mut next_sample = samples.iter().peekable();
    let (map, _) = counted(|| {
        let mut m: BTreeMap<u32, V> = BTreeMap::new();
        let base = (LIVE.with(Cell::get), BLOCKS.with(Cell::get));
        for (i, &k) in keys.iter().enumerate() {
            if by_entry {
                let _ = m.entry(k).or_default();
            } else {
                m.insert(k, V::default());
            }
            let n = i + 1;
            let nodes = BLOCKS.with(Cell::get) - base.1;
            let bytes = LIVE.with(Cell::get) - base.0;
            let bound = charge::<V>(n, 1);
            assert!(
                nodes <= node_bound(n),
                "{label}: {nodes} nodes at {n} entries"
            );
            assert!(
                bytes <= bound,
                "{label}: {bytes} bytes at {n}, charge {bound}"
            );
            worst.see(nodes, bytes, n, bound);
            while next_sample.peek().is_some_and(|&&s| s < n) {
                next_sample.next();
            }
            if next_sample.peek().is_some_and(|&&s| s == n) {
                next_sample.next();
                // Clone copies node for node: as many nodes and bytes.
                let (copy, c) = counted(|| m.clone());
                assert!(c.blocks <= node_bound(n), "{label}: clone {c:?} at {n}");
                assert!(
                    c.peak <= bound,
                    "{label}: clone {c:?} at {n}, charge {bound}"
                );
                assert_eq!((c.blocks, c.live), (nodes, bytes), "{label}: clone at {n}");
                drop(copy);
                // Collect gathers a vector, sorts it (with scratch at most as
                // long) and bulk builds: the map's charge plus the gathered
                // vector and the sort's scratch, as `collected` in plan.rs
                // charges them (twice 4n + 16 elements).
                // A bulk build's shape depends on the count alone, so collect
                // is measured from the ascending order's keys (sorted input)
                // and the random order's (unsorted).
                let elem = size_of::<(u32, V)>() as i64;
                let scratch = 2 * (4 * n as i64 + 16) * elem;
                if collect {
                    let input = &keys[..n];
                    let from = label;
                    let (built, c) = counted(|| {
                        input
                            .iter()
                            .map(|&k| (k, V::default()))
                            .collect::<BTreeMap<u32, V>>()
                    });
                    let mut prefix = input.to_vec();
                    prefix.sort_unstable();
                    assert!(c.blocks <= node_bound(n), "collect {from} {c:?} at {n}");
                    assert!(
                        c.live <= bound,
                        "collect {from} {c:?} at {n}, charge {bound}"
                    );
                    assert!(c.peak <= bound + scratch, "collect {from} {c:?} at {n}");
                    assert!(built.keys().copied().eq(prefix.iter().copied()));
                    worst.see(c.blocks, c.live, n, bound);
                }
            }
        }
        m
    });
    (map, worst)
}

/// The one-entry map's single node: a leaf's size for this shape.
fn leaf_size<V: Default>() -> i64 {
    let (m, s) = counted(|| BTreeMap::from([(0u32, V::default())]));
    assert_eq!(s.blocks, 1);
    drop(m);
    s.live
}

/// Every order for one value shape; returns the least-full order's node
/// count and bytes at its largest size, and that size.
fn shape<V: Default + Clone>(name: &str) -> (i64, i64, usize) {
    let small = 40_000;
    let large = 200_000;
    let mut least = (0, 0, 0);
    for (order, keys, by_entry, collect) in [
        ("ascending", ascending(small), false, true),
        ("descending", descending(small), false, false),
        ("middle first", middle_first(small), false, false),
        ("random by entry", random(small, 3), true, false),
        ("random", random(large, 5), false, true),
        ("least full", least_full(large), false, false),
    ] {
        let label = format!("{name} {order}");
        let samples = sample_sizes(keys.len());
        let (m, worst) = grow::<V>(&label, &keys, by_entry, collect, &samples);
        assert_eq!(m.len(), keys.len(), "{label}: keys not distinct");
        let n = keys.len();
        let (nodes, bytes) = {
            let (copy, c) = counted(|| m.clone());
            drop(copy);
            (c.blocks, c.live)
        };
        println!(
            "{label}: at {n} entries {nodes} nodes of at most {}, {bytes} bytes of charge {}; \
             closest: nodes {:?}, bytes {:?}",
            node_bound(n),
            charge::<V>(n, 1),
            worst.nodes,
            worst.bytes
        );
        if order == "least full" {
            least = (nodes, bytes, n);
        }
    }
    least
}

/// The value shapes the bounds charge a map for, by size and alignment,
/// with the real types that have each one; keys are four bytes (comment ids,
/// group ids and the membership decode's ids).
#[test]
fn shapes_are_the_real_types() {
    let shape = |s: usize, a: usize| (s, a);
    assert_eq!(
        shape(size_of::<CommentId>(), align_of::<CommentId>()),
        (4, 4)
    );
    assert_eq!(shape(size_of::<GroupId>(), align_of::<GroupId>()), (4, 4));
    let standins = [
        ("()", size_of::<()>(), align_of::<()>()),
        ("u32", size_of::<u32>(), align_of::<u32>()),
        ("u64", size_of::<u64>(), align_of::<u64>()),
        ("[u32; 3]", size_of::<[u32; 3]>(), align_of::<[u32; 3]>()),
        (
            "(u64, Option<u32>)",
            size_of::<(u64, Option<u32>)>(),
            align_of::<(u64, Option<u32>)>(),
        ),
        ("[u64; 3]", size_of::<[u64; 3]>(), align_of::<[u64; 3]>()),
        ("[u64; 8]", size_of::<[u64; 8]>(), align_of::<[u64; 8]>()),
    ];
    let real = [
        ("Extremity", size_of::<Extremity>(), align_of::<Extremity>()),
        (
            "StoredWeight",
            size_of::<StoredWeight>(),
            align_of::<StoredWeight>(),
        ),
        ("Counts", size_of::<Counts>(), align_of::<Counts>()),
        ("Scored", size_of::<Scored>(), align_of::<Scored>()),
        (
            "BTreeMap<CommentId, Counts>",
            size_of::<BTreeMap<CommentId, Counts>>(),
            align_of::<BTreeMap<CommentId, Counts>>(),
        ),
    ];
    for (name, s, a) in real {
        let found = standins.iter().find(|x| x.1 == s && x.2 == a);
        println!("{name}: {s} bytes, aligned {a}: {:?}", found.map(|x| x.0));
        assert!(found.is_some(), "{name} ({s}, {a}) has no stand-in here");
    }
}

/// Nodes at most `n / 5 + 1`, and bytes at most the crate's charge, for every
/// shape, order and operation, at every size checked. The least-full order
/// reaches at least 80% of `n / 5 + 1` nodes at 200,000 entries, and its
/// bytes at least 80% of that many leaves; for the largest value (where a
/// leaf is nearly an internal node) at least 80% of the crate's charge, so a
/// loosened charge is noticed too (from review: the bytes of a small shape
/// cannot reach 80% of the charge, which prices every node as internal).
#[test]
fn btree_node_occupancy_bound() {
    let rows = [
        ("4+0", shape::<()>("4+0"), leaf_size::<()>()),
        ("4+4", shape::<u32>("4+4"), leaf_size::<u32>()),
        ("4+8", shape::<u64>("4+8"), leaf_size::<u64>()),
        ("4+12", shape::<[u32; 3]>("4+12"), leaf_size::<[u32; 3]>()),
        (
            "4+16",
            shape::<(u64, Option<u32>)>("4+16"),
            leaf_size::<(u64, Option<u32>)>(),
        ),
        ("4+24", shape::<[u64; 3]>("4+24"), leaf_size::<[u64; 3]>()),
        ("4+64", shape::<[u64; 8]>("4+64"), leaf_size::<[u64; 8]>()),
    ];
    for (name, (nodes, bytes, n), leaf) in rows {
        let count = node_bound(n);
        println!(
            "{name} least full at {n}: {nodes} nodes of {count} ({:.1}%); {bytes} bytes, \
             {:.1}% of {count} leaves of {leaf}",
            100.0 * nodes as f64 / count as f64,
            100.0 * bytes as f64 / (count * leaf) as f64
        );
        assert!(5 * nodes >= 4 * count, "{name}: {nodes} of {count}");
        assert!(5 * bytes >= 4 * count * leaf, "{name}: {bytes} bytes");
        if name == "4+64" {
            let c = charge::<[u64; 8]>(n, 1);
            println!(
                "{name}: {bytes} bytes, {:.1}% of the charge {c}",
                100.0 * bytes as f64 / c as f64
            );
            assert!(5 * bytes >= 4 * c, "{name}: {bytes} of {c}");
        }
    }
}

/// The group frame's cells: one inner map per group, built by `entry` and
/// `insert` in the frame's own way, with the outer map. Their nodes are at
/// most `cells / 5 + groups` plus the outer map's, and their bytes within
/// the crate's charge for them, after every cell.
#[test]
fn map_of_maps_within_its_charge() {
    for (groups, per_group, seed) in [(1u32, 20_000usize, 11u64), (5, 8000, 12), (64, 600, 13)] {
        let mut rng = XorShift(seed);
        let mut cells: Vec<(u32, u32)> = (0..groups)
            .flat_map(|g| (0..per_group as u32).map(move |c| (g, c)))
            .collect();
        for i in (1..cells.len()).rev() {
            let j = rng.below(i as u64 + 1) as usize;
            cells.swap(i, j);
        }
        let label = format!("{groups} groups x {per_group}");
        let (_, s) = counted(|| {
            let mut outer: BTreeMap<u32, BTreeMap<u32, [u32; 3]>> = BTreeMap::new();
            let base = (LIVE.with(Cell::get), BLOCKS.with(Cell::get));
            for (i, &(g, c)) in cells.iter().enumerate() {
                outer.entry(g).or_default().insert(c, [0; 3]);
                let n = i + 1;
                let made = outer.len();
                let nodes = BLOCKS.with(Cell::get) - base.1;
                let bytes = LIVE.with(Cell::get) - base.0;
                let node_cap = (n / 5 + made) as i64 + node_bound(made);
                let bound = charge::<[u32; 3]>(n, made) + charge::<[u64; 3]>(made, 1);
                assert!(nodes <= node_cap, "{label}: {nodes} nodes at {n}");
                assert!(bytes <= bound, "{label}: {bytes} at {n}, charge {bound}");
            }
            outer
        });
        let n = cells.len();
        let bound = charge::<[u32; 3]>(n, groups as usize) + charge::<[u64; 3]>(groups as usize, 1);
        println!(
            "{label}: {} nodes, {} bytes of charge {bound}",
            s.blocks, s.live
        );
    }
}

/// The cfg the build script sets and `REVIEWED_RUSTC` agree; when the rustc
/// is not the reviewed one (or the build was made with
/// `POLIS_ROUTING_PLAN_UNREVIEWED_STD`, which the crate's check script does
/// for this test alone), every bound that rests on the standard library's
/// implementation is refused: the map charge, the parse charge, the build
/// bound and the build allowance.
#[test]
fn toolchain_gate_matches_the_compiler() {
    let release = env!("POLIS_RUSTC_RELEASE");
    println!("compiled by rustc {release}; reviewed {REVIEWED_RUSTC}");
    assert_eq!(std_bounds_reviewed(), release == REVIEWED_RUSTC);
    let limits = SourceLimits::default();
    let config = floor(MetaPolicy::Fixed, 0.1);
    let tally = Tally::default();
    let refused = [
        ordered_maps_charge(10, 1, 4, 0).is_none(),
        Projection::parse_reservation(1000, &limits).is_err(),
        Plan::build_bound(&config, &tally, 0).is_none(),
        Plan::build_bound(&stored(), &tally, 0).is_none(),
        Plan::build_allowance(&config, &limits).is_none(),
    ];
    if std_bounds_reviewed() {
        assert_eq!(refused, [false; 5]);
    } else {
        assert_eq!(refused, [true; 5]);
    }
}

/// Every test of this crate runs at `queue-rs/rust-toolchain.toml`; this one
/// says so plainly when it does not, before the bounds' refusals make the
/// others fail.
#[test]
fn toolchain_is_the_reviewed_one() {
    assert!(
        std_bounds_reviewed(),
        "rustc {} is not the reviewed {REVIEWED_RUSTC}: run this file's \
         btree_node_occupancy_bound under it, read its B-tree and Vec source, \
         then change REVIEWED_RUSTC and its two cfg lines in src/reserve.rs",
        env!("POLIS_RUSTC_RELEASE")
    );
}
