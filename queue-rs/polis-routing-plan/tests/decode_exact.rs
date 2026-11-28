//! The decode's own vectors (`Projection::frames`): each one filled from a
//! counted key is given its room once, for exactly the walk's count, and
//! never grows; so each is charged its exact size. Checked with a counting
//! allocator (per thread, as in `tests/allocation.rs`, a moving reallocation
//! counted as holding the old and the new buffer), which also logs the size
//! and alignment of every block allocated.
//!
//! For each constructed input: no block but a byte buffer (serde_json's
//! reader scratch, charged as the readers' scratch) is ever reallocated
//! while the frames are decoded; each charged vector's block is found, and
//! its size, which is its peak since it never moves, is within its term of
//! the bound and reaches all of it. The frames equal those of a reference
//! decode written independently over `serde_json::Value`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    CommentId, Counts, CurrentGroupFrame, Extremity, ExtremityFrame, GroupId, MetaComments,
    MetaPolicy, SourceId, StoredWeight, StoredWeights,
};
use polis_routing_plan::{FrameNeeds, Frames, Plan, Projection, SourceLimits, Tally};
use serde_json::Value;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeSet;
use std::mem::{align_of, size_of};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use support::*;

struct Logging;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
    static MOVES: Cell<u64> = const { Cell::new(0) };
    static BYTE_MOVES: Cell<u64> = const { Cell::new(0) };
}

/// Every block allocated while logging, as `size << 8 | log2(align)`; only
/// the one logging thread writes it.
const ROOM: usize = 1 << 18;
static LOG: [AtomicU64; ROOM] = [const { AtomicU64::new(0) }; ROOM];
static LOGGED: AtomicUsize = AtomicUsize::new(0);

/// Marks a logged block as one a reallocation moved away from.
const MOVED: u64 = 0x80;

fn note(layout: Layout, mark: u64) {
    let i = LOGGED.fetch_add(1, Ordering::Relaxed);
    if let Some(slot) = LOG.get(i) {
        let entry =
            ((layout.size() as u64) << 8) | u64::from(layout.align().trailing_zeros()) | mark;
        slot.store(entry, Ordering::Relaxed);
    }
}

fn on_alloc(layout: Layout) {
    if ON.with(Cell::get) {
        note(layout, 0);
        LIVE.with(|l| {
            let live = l.get() + layout.size() as i64;
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
// the bookkeeping allocates nothing.
unsafe impl GlobalAlloc for Logging {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        on_alloc(layout);
        // SAFETY: the caller's contract is passed through to System.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        on_alloc(layout);
        // SAFETY: as above.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        on_free(layout.size());
        // SAFETY: as above.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if ON.with(Cell::get) {
            if layout.align() > 1 {
                MOVES.with(|m| m.set(m.get() + 1));
            } else {
                BYTE_MOVES.with(|m| m.set(m.get() + 1));
            }
            note(layout, MOVED);
        }
        // Counted in full: the new block, then the old one freed.
        on_alloc(Layout::from_size_align(new_size, layout.align()).unwrap());
        on_free(layout.size());
        // SAFETY: as above.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Logging = Logging;

struct Logged {
    blocks: Vec<(u64, u64)>,
    moves: u64,
    byte_moves: u64,
    peak: i64,
}

fn logged<T>(f: impl FnOnce() -> T) -> (T, Logged) {
    LOGGED.store(0, Ordering::Relaxed);
    MOVES.with(|m| m.set(0));
    BYTE_MOVES.with(|m| m.set(0));
    LIVE.with(|l| l.set(0));
    PEAK.with(|p| p.set(0));
    ON.with(|o| o.set(true));
    let out = f();
    ON.with(|o| o.set(false));
    let n = LOGGED.load(Ordering::Relaxed);
    assert!(n <= ROOM, "the log holds {ROOM} blocks; {n} were allocated");
    let entry = |e: u64| (e >> 8, 1u64 << (e & 0x7f));
    let all: Vec<u64> = LOG[..n].iter().map(|e| e.load(Ordering::Relaxed)).collect();
    let blocks = all
        .iter()
        .filter(|e| *e & MOVED == 0)
        .map(|e| entry(*e))
        .collect();
    let log = Logged {
        blocks,
        moves: MOVES.with(Cell::get),
        byte_moves: BYTE_MOVES.with(Cell::get),
        peak: PEAK.with(Cell::get),
    };
    (out, log)
}

/// The membership keys as serde's own decoders read them in the adapter:
/// `group-clusters` as objects of an id and a list of base-cluster ids,
/// `base-clusters` by its `id` and `members` columns.
#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct GroupClusterShape {
    id: u32,
    members: Vec<u32>,
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct BaseClustersShape {
    id: Vec<u32>,
    members: Vec<Vec<u32>>,
}

/// The vectors moved reading the two membership keys alone.
fn membership_moves(v: &Value) -> u64 {
    let clusters = serde_json::to_string(&v["group-clusters"]).unwrap();
    let bases = serde_json::to_string(&v["base-clusters"]).unwrap();
    let (_, log) = logged(|| {
        let c: Vec<GroupClusterShape> = serde_json::from_str(&clusters).unwrap();
        let b: BaseClustersShape = serde_json::from_str(&bases).unwrap();
        (c, b)
    });
    log.moves
}

struct Case {
    name: &'static str,
    value: Value,
    needs: FrameNeeds,
}

fn cases() -> Vec<Case> {
    let all = FrameNeeds::all();
    let no_weights = FrameNeeds {
        stored_weights: false,
        ..all
    };
    vec![
        Case {
            name: "10,000 comments, 5 groups, mixed weights",
            value: conversation(51, 10_000, 5, 20, 0, Priorities::Mixed).value,
            needs: all,
        },
        Case {
            name: "40,000 comments, 5 groups (the larger witness)",
            value: conversation(52, 40_000, 5, 20, 0, Priorities::Absent).value,
            needs: no_weights,
        },
        Case {
            name: "600 comments, 64 groups, every comment meta and 50 more",
            value: conversation(61, 600, 64, 1, 50, Priorities::Absorbing).value,
            needs: all,
        },
        Case {
            name: "2,000 comments, one group",
            value: conversation(62, 2_000, 1, 7, 3, Priorities::Mixed).value,
            needs: all,
        },
        Case {
            name: "three comments, two groups",
            value: tiny(&[20, 99]),
            needs: no_weights,
        },
        Case {
            name: "three comments, two groups, no meta",
            value: tiny(&[]),
            needs: no_weights,
        },
    ]
}

/// Parses `value` under limits set to its own counts: every count at its
/// limit.
fn at_its_limits(value: &Value) -> Projection {
    let source = bytes(value);
    let loose = Projection::parse(&source, row(), &SourceLimits::default()).unwrap();
    let t = loose.tally();
    let ids = |key: &str| -> Vec<i64> {
        value[key]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_i64().unwrap()).collect())
            .unwrap_or_default()
    };
    let union: BTreeSet<i64> = ids("tids").into_iter().chain(ids("meta-tids")).collect();
    let limits = SourceLimits {
        max_bytes: source.len() as u64,
        max_comments: (union.len() as u64)
            .max(t.tids)
            .max(t.meta)
            .max(t.extremity)
            .max(t.priorities),
        max_groups: t.groups,
        max_cells: t.cells,
        max_memberships: t.memberships,
        ..SourceLimits::default()
    };
    Projection::parse(&source, row(), &limits).unwrap()
}

/// The bound's terms for these needs, by name: the floor's (extremity, meta,
/// groups) and stored weights' (priorities).
fn terms(p: &Projection) -> Vec<(&'static str, u64)> {
    let mut out = Vec::new();
    for config in [floor(MetaPolicy::Fixed, 0.1), stored()] {
        Plan::build_bound_terms(&config, p.tally(), p.raw_len(), |name, bytes| {
            if name.starts_with("frames: ") && !out.iter().any(|(n, _)| *n == name) {
                out.push((name, bytes));
            }
        })
        .unwrap();
    }
    out
}

/// Each vector the decode gives exact room: its term's name, the count it is
/// given room for, and its element's size and alignment.
fn exact_vectors(t: &Tally, needs: FrameNeeds) -> Vec<(&'static str, u64, u64, u64)> {
    fn of<T>() -> (u64, u64) {
        (size_of::<T>() as u64, align_of::<T>() as u64)
    }
    let mut v = Vec::new();
    let mut add = |name, n, (size, align): (u64, u64)| v.push((name, n, size, align));
    if needs.stored_weights {
        add(
            "frames: priorities decoded",
            t.priorities,
            of::<(u32, StoredWeight)>(),
        );
    }
    if needs.extremity {
        add("frames: tids decoded", t.tids, of::<i64>());
        add("frames: extremity decoded", t.extremity, of::<f64>());
        add(
            "frames: extremity pairs",
            t.tids,
            of::<(CommentId, Extremity)>(),
        );
    }
    if needs.meta {
        add("frames: meta tids decoded", t.meta, of::<i64>());
        add("frames: meta ids", t.meta, of::<CommentId>());
    }
    if needs.groups {
        add("frames: groups decoded", t.groups, of::<(u32, u32)>());
        add(
            "frames: cells decoded",
            t.cells,
            of::<(GroupId, CommentId, Counts)>(),
        );
    }
    v
}

/// On every constructed input, with every count at its limit: none of the
/// decode's exact vectors is ever reallocated, and each is one block of
/// exactly its term of the bound; without the group frame (whose membership
/// keys are still read by serde's own growing vectors) no block but a byte
/// buffer moves at all.
#[test]
fn decode_never_reallocates() {
    let mut failures = Vec::new();
    for case in cases() {
        let p = at_its_limits(&case.value);
        let (frames, log) = logged(|| p.frames(case.needs));
        frames.unwrap();
        let reservation = p.reservation(case.needs).unwrap();
        println!(
            "{}: {} blocks, {} moved (byte buffers: {}); peak {} of reservation {}",
            case.name,
            log.blocks.len(),
            log.moves,
            log.byte_moves,
            log.peak,
            reservation
        );
        // Without the group frame, nothing but a byte buffer moves at all.
        // With it, the membership keys' vectors, which serde's own decoders
        // read and grow (charged by doubling, `vecs`), may; none of the
        // decode's exact vectors does (below).
        let no_groups = FrameNeeds {
            groups: false,
            ..case.needs
        };
        let (_, alone) = logged(|| p.frames(no_groups).unwrap());
        assert_eq!(alone.moves, 0, "{}: a vector was reallocated", case.name);
        // With it, every move is one of those: exactly as many as serde's
        // own decoders make reading the two membership keys alone.
        let expected = membership_moves(&case.value);
        assert_eq!(
            log.moves, expected,
            "{}: a vector other than the membership keys' moved",
            case.name
        );
        assert!(
            log.peak >= 0 && log.peak as u64 <= reservation,
            "{}",
            case.name
        );
        let terms = terms(&p);
        let vectors = exact_vectors(p.tally(), case.needs);
        for &(name, n, size, align) in &vectors {
            let bound = terms
                .iter()
                .find(|(t, _)| *t == name)
                .map(|t| t.1)
                .unwrap_or_else(|| panic!("no term named {name}"));
            let want = n * size;
            // As many blocks of exactly this size and alignment as vectors
            // that should have made one.
            let sharing = vectors
                .iter()
                .filter(|v| v.1 * v.2 == want && v.3 == align)
                .count();
            let found = log.blocks.iter().filter(|b| **b == (want, align)).count();
            let measured = if n == 0 {
                0
            } else if found >= sharing {
                want
            } else {
                failures.push(format!(
                    "{}: {name}: {found} blocks of {want} bytes, want {sharing}",
                    case.name
                ));
                continue;
            };
            println!(
                "{}: {name}: {n} elements, measured {measured}, bound {bound}",
                case.name
            );
            // Within its term, and reaching all of it: a later loosening of
            // the term is noticed here.
            if measured != bound {
                failures.push(format!(
                    "{}: {name}: measured {measured}, bound {bound}",
                    case.name
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn reference(v: &Value, source: &SourceId, needs: FrameNeeds) -> Reference {
    let id = |s: &str| s.parse::<u32>().unwrap();
    let ints = |v: &Value| -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_i64().unwrap())
            .collect()
    };
    let extremity = needs.extremity.then(|| {
        let values = v["pca"]["comment-extremity"].as_array().unwrap();
        let pairs = ints(&v["tids"]).into_iter().zip(values).map(|(t, e)| {
            let e = Extremity::new(e.as_f64().unwrap()).unwrap();
            (CommentId::try_from(t).unwrap(), e)
        });
        ExtremityFrame::new(source.clone(), pairs).unwrap()
    });
    let meta = needs.meta.then(|| {
        let ids = ints(&v["meta-tids"]);
        let n = ids.len();
        let set = MetaComments::new(ids.into_iter().map(|t| CommentId::try_from(t).unwrap()));
        (set.unwrap(), n)
    });
    let groups = needs.groups.then(|| {
        let groups = v["group-votes"].as_object().unwrap();
        let members = groups.iter().map(|(g, body)| {
            let n = u32::try_from(body["n-members"].as_u64().unwrap()).unwrap();
            (GroupId::new(id(g)), n)
        });
        let mut cells = Vec::new();
        for (g, body) in groups {
            for (t, c) in body["votes"].as_object().unwrap() {
                let n = |k: &str| c[k].as_u64().unwrap();
                let counts = Counts::from_seen(
                    u32::try_from(n("A")).unwrap(),
                    u32::try_from(n("D")).unwrap(),
                    n("S"),
                )
                .unwrap();
                cells.push((GroupId::new(id(g)), CommentId::new(id(t)), counts));
            }
        }
        CurrentGroupFrame::new(source.clone(), members, cells, None).unwrap()
    });
    let stored = needs.stored_weights.then(|| {
        let entries = v["comment-priorities"].as_object().unwrap();
        let n = entries.len();
        let entries = entries.iter().map(|(t, w)| {
            let w = match w {
                Value::Null => StoredWeight::Null,
                Value::Bool(false) => StoredWeight::False,
                w => StoredWeight::Number(w.as_f64().unwrap()),
            };
            (CommentId::new(id(t)), w)
        });
        (StoredWeights::new(source.clone(), entries).unwrap(), n)
    });
    Reference {
        extremity,
        groups,
        meta,
        stored,
    }
}

struct Reference {
    extremity: Option<ExtremityFrame>,
    groups: Option<CurrentGroupFrame>,
    meta: Option<(MetaComments, usize)>,
    stored: Option<(StoredWeights, usize)>,
}

fn same(f: &Frames, r: &Reference) -> bool {
    f.extremity() == r.extremity.as_ref()
        && f.groups() == r.groups.as_ref()
        && f.meta() == r.meta.as_ref().map(|m| &m.0)
        && f.meta_entries() == r.meta.as_ref().map_or(0, |m| m.1)
        && f.stored() == r.stored.as_ref().map(|s| &s.0)
        && f.stored_entries() == r.stored.as_ref().map_or(0, |s| s.1)
}

/// The frames the exact decode makes equal a reference decode written
/// independently, over `serde_json::Value`, on every constructed input.
#[test]
fn frames_identical_after_exact_decode() {
    for case in cases() {
        let source = bytes(&case.value);
        let p = Projection::parse(&source, row(), &SourceLimits::default()).unwrap();
        let f = p.frames(case.needs).unwrap();
        let r = reference(&case.value, f.source(), case.needs);
        assert!(same(&f, &r), "{}: the frames differ", case.name);
        assert!(
            f.extremity().is_some() && f.groups().is_some(),
            "{}",
            case.name
        );
    }
}

/// The floor's build allowance at the loader's byte bound for it (54 KiB),
/// per byte of the projection, for each meta policy.
#[test]
fn floor_allowance_per_byte_at_the_loader_length() {
    let len = 54 * 1024;
    let limits = SourceLimits {
        max_bytes: len,
        ..SourceLimits::default()
    };
    let mut per = Vec::new();
    for policy in [MetaPolicy::Fixed, MetaPolicy::Ordinary, MetaPolicy::Exclude] {
        let allowance = Plan::build_allowance(&floor(policy, 0.1), &limits).unwrap();
        let per_byte = allowance / len;
        println!("floor {policy:?}: allowance {allowance} at {len} bytes, {per_byte} per byte");
        per.push(per_byte);
    }
    // About 310 times the length at this head: the readers' term from the
    // keys' text carries one error message (18 bytes for each byte), since
    // a string of 0x7f bytes where a number is expected showed it is needed.
    assert!(per.iter().all(|p| (250..=330).contains(p)), "{per:?}");
}
