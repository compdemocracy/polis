//! The expanded-size reservation: an upper bound, in bytes, on everything
//! `Projection::frames` allocates, computed from the walk's counts and the
//! read keys' length before any of it is allocated; and the counts a source
//! of a given length can reach at most. It is meant to be charged, so it is
//! conservative on purpose; a tighter bound needs its own evidence.

use crate::decode::sizes;
use crate::limits::SourceLimits;
use crate::projection::FrameNeeds;
use crate::scan::Tally;
use polis_routing_equation::{CommentId, Counts, Extremity, GroupId, StoredWeight};
use std::mem::size_of;

/// The Rust release whose standard library the bounds of this module were
/// checked against: by reading its source (`alloc/src/collections/btree`,
/// `alloc/src/vec`) and by running `tests/btree_bound.rs` under it. Three of
/// them rest on that library's implementation, not on its documentation: an
/// ordered map's nodes hold at least five entries each but the root, and a
/// node is laid out as `node` says (`map`, `maps`); a vector grown one push
/// at a time doubles its capacity (`vecs`, and the reader scratch of
/// `parse_reservation`). Compiled by any other release, each of those
/// returns `None`, so every reservation made from them is refused and the
/// caller keeps today's draw: never a smaller charge.
///
/// To move to another release: run `cargo test -p polis-routing-plan --test
/// btree_bound` under it (it fails at once if the nodes are less full or
/// larger); read its B-tree's `node.rs` and `map.rs` and `Vec`'s growth for
/// the constants quoted at `map`; then change this constant and the two
/// `cfg` lines below it to the new release, together.
pub const REVIEWED_RUSTC: &str = "1.98.1";

// The build script names the compiling rustc's release as this cfg.
#[cfg(polis_rustc_release = "1.98.1")]
const COMPILED_BY_REVIEWED_RUSTC: bool = true;
#[cfg(not(polis_rustc_release = "1.98.1"))]
const COMPILED_BY_REVIEWED_RUSTC: bool = false;

/// Whether this crate was compiled by `REVIEWED_RUSTC`. When it was not,
/// every bound that rests on the standard library's implementation is
/// `None`.
pub fn std_bounds_reviewed() -> bool {
    COMPILED_BY_REVIEWED_RUSTC
}

fn reviewed() -> Option<()> {
    COMPILED_BY_REVIEWED_RUSTC.then_some(())
}

/// A vector grown one push at a time from nothing doubles its capacity, so
/// everything it ever asked for is below four times its length plus a
/// little; `k` vectors holding `n` elements in all, below `4n + 16k`.
/// Doubling is the standard library's implementation, not its promise
/// (`REVIEWED_RUSTC`).
pub(crate) fn vecs(n: u64, k: u64, elem: u64) -> Option<u64> {
    reviewed()?;
    n.checked_mul(4)?
        .checked_add(k.checked_mul(16)?)?
        .checked_mul(elem)
}

/// One node of an ordered map, internal or leaf, with room for padding: a
/// parent pointer, two small integers, eleven keys and values, twelve edges.
fn node(k: u64, v: u64) -> Option<u64> {
    let slots = k.checked_add(v)?.checked_mul(11)?;
    slots.checked_add(8 + 4 + 12 * 8 + 24)
}

/// The fewest entries a node of the standard library's ordered map holds,
/// but the root: `MIN_LEN`.
const MIN_ENTRIES_PER_NODE: u64 = 5;

/// `count` ordered maps (`BTreeMap`, or `BTreeSet`, which is one with an
/// empty value) holding `n` entries in all, built by the operations the
/// build path uses: insertion (`insert`, `entry`), `collect` (a bulk build)
/// and `clone`. Never `remove`, `retain`, `append` or `split_off`: the
/// first two rebalance and keep the same invariant, but nothing here has
/// been checked against them.
///
/// The standard library's documentation says only that a node holds "B-1 to
/// 2B-1 elements", B not given. Its 1.98.1 source gives it
/// (`alloc/src/collections/btree/node.rs`): `const B: usize = 6;`,
/// `CAPACITY: usize = 2 * B - 1`, `MIN_LEN_AFTER_SPLIT: usize = B - 1`; and
/// `map.rs`: "Every non-root node contains at least MIN_LEN elements", with
/// `MIN_LEN = node::MIN_LEN_AFTER_SPLIT`. A split (`splitpoint`) leaves at
/// least five entries on each side; a bulk build fills its nodes and then
/// stocks up the right border (`fix_right_border_of_plentiful`); a clone
/// copies the tree node for node; none of the three frees a node. So a map
/// of `m` entries has at most `m / 5 + 1` nodes, a node is never larger than
/// `node` (a leaf is `parent`, `parent_idx`, `len`, eleven keys and eleven
/// values; an internal node, `#[repr(C)]`, that leaf and twelve edges), and
/// `count` maps of `n` entries in all have at most `n / 5 + count` nodes.
///
/// The charge is `n * ceil(node / 5) + count * node`, at least that many
/// nodes' bytes, and affine in `n` and `count` (which `worst_tally` needs).
/// It rests on the library's implementation (`REVIEWED_RUSTC`).
pub(crate) fn maps(n: u64, count: u64, k: u64, v: u64) -> Option<u64> {
    reviewed()?;
    let node = node(k, v)?;
    let per_entry = node.div_ceil(MIN_ENTRIES_PER_NODE);
    n.checked_mul(per_entry)?
        .checked_add(count.checked_mul(node)?)
}

/// One ordered map of `n` entries (see `maps`).
pub(crate) fn map(n: u64, k: u64, v: u64) -> Option<u64> {
    maps(n, 1, k, v)
}

/// The bytes charged for `count` ordered maps holding `entries` entries in
/// all, each entry a key of `key` bytes and a value of `value` bytes (`0` for
/// a set), built by insertion, `entry`, `collect` or `clone`: the charge
/// every bound of this crate makes for an ordered map. `None` on overflow,
/// or when the crate was not compiled by `REVIEWED_RUSTC`.
pub fn ordered_maps_charge(entries: u64, count: u64, key: u64, value: u64) -> Option<u64> {
    maps(entries, count, key, value)
}

fn sz<T>() -> u64 {
    size_of::<T>() as u64
}

/// The most readers `frames` opens: one per key it decodes (comment
/// priorities; tids and the projection's `pca`; meta tids; group votes,
/// group clusters and base clusters), with one to spare.
const READERS: u64 = 8;

/// `raw` is the length, in bytes, of the text of the keys `frames` may
/// decode (at most the source's length: the keys are disjoint parts of it).
pub(crate) fn reservation(t: &Tally, raw: u64, needs: FrameNeeds) -> Option<u64> {
    let d = sizes();
    let id = sz::<CommentId>();
    // Each key decoded has its own reader, whose scratch holds one decoded
    // string, one long numeric significand or one skipped value's brackets
    // from that key's own text, so never more than that text; grown by
    // doubling and counted while it moves, below four times it plus a
    // little. The readers' texts are disjoint, so all of them together are
    // below four times `raw`, plus a little per reader. The source ids are
    // cloned once per frame; a fixed allowance covers the rest.
    let mut total = raw.checked_mul(4)?.checked_add(READERS.checked_mul(64)?)?;
    total = total.checked_add(4096)?;
    let mut add = |x: Option<u64>| -> Option<()> {
        total = total.checked_add(x?)?;
        Some(())
    };
    if needs.stored_weights {
        add(vecs(t.priorities, 1, d.priority))?;
        add(map(t.priorities, id, sz::<StoredWeight>()))?;
    }
    if needs.extremity {
        add(vecs(t.tids, 1, d.tid))?;
        add(vecs(t.extremity, 1, d.extremity))?;
        add(vecs(
            t.tids,
            1,
            id.checked_add(sz::<Extremity>())?.checked_add(8)?,
        ))?;
        add(map(t.tids, id, sz::<Extremity>()))?;
    }
    if needs.meta {
        add(vecs(t.meta, 1, d.tid))?;
        add(vecs(t.meta, 1, id))?;
        add(map(t.meta, id, 0))?;
    }
    if needs.groups {
        let g = sz::<GroupId>();
        add(vecs(t.groups, 1, d.group))?;
        add(vecs(t.cells, t.groups, d.cell))?;
        add(vecs(
            t.cells,
            1,
            g.checked_add(id)?
                .checked_add(sz::<Counts>())?
                .checked_add(8)?,
        ))?;
        add(map(t.groups, g, 4))?;
        add(map(t.groups, g, 24))?;
        // The cells: one inner map per group, `cells` entries in all.
        add(maps(t.cells, t.groups, id, sz::<Counts>()))?;
        let m = t.memberships;
        add(vecs(m, 1, d.group_cluster))?;
        add(vecs(m, m, d.id))?;
        add(vecs(m, 1, d.id))?;
        add(vecs(m, 1, d.id_list))?;
        add(vecs(m, m, d.id))?;
        add(map(m, 4, 16))?;
        add(map(m, 4, 8))?;
    }
    Some(total)
}

/// An upper bound on the additional heap payload `Projection::parse` holds
/// at once for a source of `len` bytes, known before it reads a byte, so that a
/// caller can charge it first and a source that is then refused has held no
/// more than was charged. It counts on the lengths alone (no count is known
/// yet), so it is loose on purpose. A reallocation is counted as holding the
/// old and the new room at once. Existing caller-owned input buffers and
/// row environment capacity are charged separately; inline values, stack
/// and allocator metadata are outside this heap-payload bound.
///
/// `parse` runs in three phases, each freeing what it used before the next:
/// the walk; setting apart the keys this crate reads; the union of comment
/// ids. The bound is the largest phase, plus what the read keys' text keeps
/// across the last two, plus a fixed allowance for the source id. The
/// scratch's doubling is the standard library's implementation
/// (`REVIEWED_RUSTC`).
pub(crate) fn parse_reservation(len: u64, limits: &SourceLimits) -> Option<u64> {
    reviewed()?;
    // One reader's scratch (serde_json's): it holds one decoded string,
    // a long numeric significand, or the open brackets of a skipped value,
    // so never more than the
    // source; grown by doubling, it has room for at most twice that, and
    // while it moves it holds the old room too.
    let scratch = len.checked_mul(3)?.checked_add(64)?;
    // Object keys written with escapes, kept decoded while their object is
    // open: none is longer decoded than written, and no two share a byte.
    let keys = len;
    // The walk's spill (see `scan::Keys`): only pairs already read are in a
    // spill, each pair takes at least four bytes (`"":0`), so at most len / 4
    // are held at once; each in 8 bytes of room doubled to at most 16, plus 8
    // more for each entry of the one spill being moved.
    let spill = (len / 4).checked_mul(24)?;
    let walk = scratch.checked_add(keys)?.checked_add(spill)?;
    // The read keys' text, each kept as its own copy: no longer than the
    // source together.
    let raw = len;
    let split = scratch.checked_add(raw)?;
    // The union: one reserved vector of every element of `tids` and
    // `meta-tids`, only when they could exceed the limit; each is at most
    // `max_comments` (already checked), and each element takes at least two
    // bytes (`1,`).
    let ids = (len / 2 + 1).min(limits.max_comments.saturating_mul(2));
    let union = raw.checked_add(ids.checked_mul(8)?)?.checked_add(scratch)?;
    walk.max(split).max(union).checked_add(1024)
}

/// The bytes a counted entry takes in the source, at least. Every entry the
/// walk counts is a value inside an array or an object, and owns two bytes
/// no other counted entry owns: its first byte (a digit, a sign, a quote or
/// a bracket), and the byte that ends it (the next `,`, `]` or `}`). Two
/// values that end before the same byte end at the same byte, so they are
/// the same value; a byte that ends a value never starts one. So the
/// entries of a complete source of `len` bytes, all counters together, are
/// at most `len / 2`. (An object entry also owns its key and colon; that is
/// not used, because the walk counts entries whatever their container.)
pub(crate) const ENTRY_BYTES: u64 = 2;

/// The tally that makes `bound` largest among every tally a complete source
/// of `len` bytes can have under `limits`, or above it: for a `bound` that
/// is affine in the counts (each a sum of terms linear in one count), the
/// counts are filled greedily from the one that adds most per entry, each
/// up to its limit, and the last one filled is rounded up, so the result is
/// at least the fractional optimum of the knapsack, which is at least any
/// real tally's. Each count also stays within its own limit, which the walk
/// refuses past. `longest_string` is `len`.
pub(crate) fn worst_tally(
    len: u64,
    limits: &SourceLimits,
    bound: impl Fn(&Tally) -> Option<u64>,
) -> Option<Tally> {
    let zero = Tally::default();
    let base = bound(&zero)?;
    type Slot = fn(&mut Tally) -> &mut u64;
    let slots: [(Slot, u64); 7] = [
        (|t| &mut t.groups, limits.max_groups),
        (|t| &mut t.cells, limits.max_cells),
        (|t| &mut t.tids, limits.max_comments),
        (|t| &mut t.meta, limits.max_comments),
        (|t| &mut t.extremity, limits.max_comments),
        (|t| &mut t.priorities, limits.max_comments),
        (|t| &mut t.memberships, limits.max_memberships),
    ];
    let mut gains = Vec::new();
    for (i, (slot, _)) in slots.iter().enumerate() {
        let mut one = Tally::default();
        *slot(&mut one) = 1;
        gains.push((bound(&one)?.checked_sub(base)?, i));
    }
    gains.sort_unstable_by(|a, b| b.cmp(a));
    let mut left = len;
    let mut worst = Tally {
        longest_string: len,
        ..Tally::default()
    };
    for (gain, i) in gains {
        let &(slot, limit) = slots.get(i)?;
        if gain == 0 || left == 0 {
            continue;
        }
        let n = left.div_ceil(ENTRY_BYTES).min(limit);
        *slot(&mut worst) = n;
        left = left.saturating_sub(n.checked_mul(ENTRY_BYTES)?);
    }
    Some(worst)
}
