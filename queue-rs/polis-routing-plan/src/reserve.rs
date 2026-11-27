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

/// A vector grown one push at a time from nothing doubles its capacity, so
/// everything it ever asked for is below four times its length plus a
/// little; `k` vectors holding `n` elements in all, below `4n + 16k`.
pub(crate) fn vecs(n: u64, k: u64, elem: u64) -> Option<u64> {
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

/// An ordered map built by insertion never frees a node, and every node
/// holds at least one entry: at most `n + 1` nodes.
pub(crate) fn map(n: u64, k: u64, v: u64) -> Option<u64> {
    n.checked_add(1)?.checked_mul(node(k, v)?)
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
        add(map(t.cells.checked_add(t.groups)?, id, sz::<Counts>()))?;
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
/// across the last two, plus a fixed allowance for the source id.
pub(crate) fn parse_reservation(len: u64, limits: &SourceLimits) -> Option<u64> {
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
