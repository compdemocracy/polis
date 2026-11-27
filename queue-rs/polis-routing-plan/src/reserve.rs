//! The expanded-size reservation: an upper bound, in bytes, on everything
//! `Projection::frames` allocates, computed from the walk's counts and the
//! read keys' length before any of it is allocated; and the counts a source
//! of a given length can reach at most. It is meant to be charged, so it is
//! conservative on purpose; a tighter bound needs its own evidence.

use crate::decode::sizes;
use crate::limits::SourceLimits;
use crate::measure::Measure;
use crate::projection::{FrameCounts, FrameNeeds};
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
/// `parse_reservation`). The decode's exact vectors (`exact`) rest on a
/// run-time check of their capacity instead, and are gated with the rest.
/// Compiled by any other release, each of those returns `None`, so every reservation made from them is refused and the
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

/// A vector the decode gives its room once, for exactly the `n` elements
/// the walk counted, and never grows: `n` elements of `elem` bytes. It
/// rests on the decode's own code (`decode::Exact`): the room is taken with
/// `try_reserve_exact`, and the vector is refused unless its capacity is
/// then exactly `n`, since neither that nor `with_capacity` is documented
/// to be exact; an element past `n` is refused, never pushed. The
/// allocation of a vector of capacity `n` is `n * size_of::<T>()` bytes.
/// Gated by `REVIEWED_RUSTC` with the rest, so that every bound this module
/// gives was checked under one release.
pub(crate) fn exact(n: u64, elem: u64) -> Option<u64> {
    reviewed()?;
    n.checked_mul(elem)
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

/// What `frames` allocates, with the readers' scratch charged from the
/// longest token the measuring pass found (`Measure::token`) instead of
/// the keys' text. `raw` is the length, in bytes, of the text of the keys
/// `frames` may decode (at most the source's length: the keys are disjoint
/// parts of it).
pub(crate) fn measured_reservation(
    t: &Tally,
    raw: u64,
    token: u64,
    needs: FrameNeeds,
) -> Option<u64> {
    sum_terms(|term| frames_terms(t, raw, Some(token), needs, term))
}

/// What one serde_json reader's scratch (`Deserializer::scratch`, a
/// `Vec<u8>`) can hold at once for a source whose longest token is `t`
/// bytes: one decoded string (never longer than written), one long
/// number's digits (`parse_long_integer`, `parse_decimal_overflow`: the
/// digits written, and the zeros a fraction's exponent stands for, no more
/// than the token), or the open brackets of one skipped value (no more than
/// the depth). It is cleared for each, never shrunk, and grown by
/// `reserve`, so its room is at most twice `t` (or the eight bytes of a
/// first growth), and while it moves the old room is held too.
fn scratch(t: u64) -> Option<u64> {
    t.checked_mul(3)?.checked_add(64)
}

/// The most text an error message serde formats can hold beside its one
/// token: its fixed words, the visitor's expectation, and the longest
/// number `Display` writes (an `f64` never in exponent form: about 330
/// bytes).
const MESSAGE_WORDS: u64 = 512;

/// One error serde formats while a source of longest token `t` is read: a
/// type, value or field error writes at most one token into its message,
/// a string by `Debug`, at most six bytes for each byte decoded (`\u{7f}`
/// for the one byte 0x7f); the message is formatted into a `String` grown
/// by doubling and then boxed (`serde_json::Error::custom`, `make_error`),
/// so at most three times its length is held at once, plus the boxed
/// error. Only one error is alive at a time: each refuses the read it is
/// made in.
fn error_message(t: u64) -> Option<u64> {
    t.checked_mul(6)?
        .checked_add(MESSAGE_WORDS)?
        .checked_mul(3)?
        .checked_add(128)
}

/// The float-roundtrip conversion of a long number (serde_json's
/// `lexical::bhcomp`): it reads at most `MAX_DIGITS` (769) significant
/// digits into big integers of 64-bit limbs, scales them by powers of two,
/// five and ten within `f64`'s range, and frees them before the number is
/// returned: a few big integers of at most about 6,200 bits (under 800
/// bytes) each, with their growth. An allowance, not a count: it does not
/// grow with the source.
const NUMERIC: u64 = 16_384;

/// The measured parse charge: `parse_reservation`'s phases, term for term,
/// each from the measuring pass's counts instead of the length. Named
/// terms, in order; they sum to the charge.
pub(crate) fn measured_parse_terms(
    m: &Measure,
    limits: &SourceLimits,
    term: &mut dyn FnMut(&'static str, u64),
) -> Option<()> {
    reviewed()?;
    let t = m.token();
    let scratch = scratch(t)?;
    // The walk: its reader's scratch, the keys written with escapes (kept
    // decoded while their object is open), and the spill: each key in it
    // in 8 bytes of room, doubled to at most 16, plus 8 more for each
    // entry of the one spill being moved (`scan::Keys`).
    let walk = scratch
        .checked_add(m.escaped_keys())?
        .checked_add(m.spill().checked_mul(24)?)?;
    // Setting the read keys apart: a reader's scratch and their text.
    let split = scratch.checked_add(m.read_text())?;
    // The union, only when it runs: the read keys' text, one vector of
    // every entry of `tids` and `meta-tids`, and a reader's scratch.
    let ids = m.tids().checked_add(m.meta())?;
    let union = if ids > limits.max_comments {
        m.read_text()
            .checked_add(ids.checked_mul(8)?)?
            .checked_add(scratch)?
    } else {
        0
    };
    term("parse: largest phase", walk.max(split).max(union));
    term("parse: one error message", error_message(t)?);
    term("parse: numeric conversion", NUMERIC);
    term("parse: fixed", 1024);
    Some(())
}

/// `measured_parse_terms`, summed.
pub(crate) fn measured_parse_reservation(m: &Measure, limits: &SourceLimits) -> Option<u64> {
    sum_terms(|term| measured_parse_terms(m, limits, term))
}

/// Adds up the terms `each` hands to its sink: `None` if `each` refuses or
/// the sum overflows. Allocation free.
pub(crate) fn sum_terms(
    each: impl FnOnce(&mut dyn FnMut(&'static str, u64)) -> Option<()>,
) -> Option<u64> {
    let mut total = Some(0u64);
    each(&mut |_, x| total = total.and_then(|t| t.checked_add(x)))?;
    total
}

/// `reservation`, one named term at a time.
pub(crate) fn reservation_terms(
    t: &Tally,
    raw: u64,
    needs: FrameNeeds,
    term: &mut dyn FnMut(&'static str, u64),
) -> Option<()> {
    frames_terms(t, raw, None, needs, term)
}

/// `reservation_terms`, the readers' scratch from the keys' text (`token`
/// `None`) or from the measured longest token.
pub(crate) fn frames_terms(
    t: &Tally,
    raw: u64,
    token: Option<u64>,
    needs: FrameNeeds,
    term: &mut dyn FnMut(&'static str, u64),
) -> Option<()> {
    let d = sizes();
    let id = sz::<CommentId>();
    // Each key decoded has its own reader, whose scratch holds one decoded
    // string, one long numeric significand or one skipped value's brackets
    // from that key's own text, so never more than that text; grown by
    // doubling and counted while it moves, below four times it plus a
    // little. The readers' texts are disjoint, so all of them together are
    // below four times `raw`, plus a little per reader. The source ids are
    // cloned once per frame; a fixed allowance covers the rest.
    let readers = raw.checked_mul(4)?.checked_add(READERS.checked_mul(64)?)?;
    match token {
        None => {
            // From the keys' text: one error message can hold the
            // longest string in it, and one float conversion.
            term("frames: readers' scratch", readers);
            term("frames: one error message", error_message(raw)?);
            term("frames: numeric conversion", NUMERIC);
        }
        Some(t) => {
            // Measured: each reader's scratch from the longest token (see
            // `scratch`), however the readers' lives overlap, plus one
            // error message and one numeric conversion at a time.
            reviewed()?;
            term(
                "frames: readers' scratch",
                READERS.checked_mul(scratch(t)?)?,
            );
            term("frames: one error message", error_message(t)?);
            term("frames: numeric conversion", NUMERIC);
        }
    }
    term("frames: fixed", 4096);
    let mut add = |name: &'static str, x: Option<u64>| -> Option<()> {
        term(name, x?);
        Some(())
    };
    // The vectors the decode fills from a counted key are given exactly
    // their count (`exact`); the membership keys' vectors are read by
    // serde's own decoders, which grow them.
    if needs.stored_weights {
        add(
            "frames: priorities decoded",
            exact(t.priorities, d.priority),
        )?;
        add(
            "frames: stored weights map",
            map(t.priorities, id, sz::<StoredWeight>()),
        )?;
    }
    if needs.extremity {
        add("frames: tids decoded", exact(t.tids, d.tid))?;
        add("frames: extremity decoded", exact(t.extremity, d.extremity))?;
        add(
            "frames: extremity pairs",
            exact(t.tids, sz::<(CommentId, Extremity)>()),
        )?;
        add("frames: extremity map", map(t.tids, id, sz::<Extremity>()))?;
    }
    if needs.meta {
        add("frames: meta tids decoded", exact(t.meta, d.tid))?;
        add("frames: meta ids", exact(t.meta, id))?;
        add("frames: meta set", map(t.meta, id, 0))?;
    }
    if needs.groups {
        let g = sz::<GroupId>();
        add("frames: groups decoded", exact(t.groups, d.group))?;
        // `group-votes` is decoded straight into the one vector of cells
        // the group frame is made from.
        add("frames: cells decoded", exact(t.cells, d.cell))?;
        add("frames: group members map", map(t.groups, g, 4))?;
        add("frames: group cells outer map", map(t.groups, g, 24))?;
        // The cells: one inner map per group, `cells` entries in all.
        add(
            "frames: group cells inner maps",
            maps(t.cells, t.groups, id, sz::<Counts>()),
        )?;
        let m = t.memberships;
        add("frames: memberships decoded", vecs(m, 1, d.group_cluster))?;
        add("frames: membership member lists", vecs(m, m, d.id))?;
        add("frames: membership ids", vecs(m, 1, d.id))?;
        add("frames: membership id lists", vecs(m, 1, d.id_list))?;
        add("frames: base member lists", vecs(m, m, d.id))?;
        add("frames: bases map", map(m, 4, 16))?;
        add("frames: participants map", map(m, 4, 8))?;
    }
    Some(())
}

/// What the frames hold once `frames` has returned, from their real lengths:
/// the ordered maps each frame keeps (the stored map, the extremity map, the
/// meta set, the group frame's members and cells) and their source ids (the
/// same fixed allowance as the frames stage's). Everything else `frames`
/// allocated (the readers' scratch, every decoded vector, the membership
/// check's vectors and maps) is a local of the function that made it and is
/// freed before it returns; the extremity pairs and the cells are moved into
/// the library and freed when its frame is made.
pub(crate) fn retained_terms(
    c: &FrameCounts,
    term: &mut dyn FnMut(&'static str, u64),
) -> Option<()> {
    let id = sz::<CommentId>();
    let g = sz::<GroupId>();
    term("retained: fixed", 4096);
    let mut add = |name: &'static str, x: Option<u64>| -> Option<()> {
        term(name, x?);
        Some(())
    };
    add(
        "retained: stored weights map",
        map(c.stored, id, sz::<StoredWeight>()),
    )?;
    add(
        "retained: extremity map",
        map(c.extremity, id, sz::<Extremity>()),
    )?;
    add("retained: meta set", map(c.meta, id, 0))?;
    add("retained: group members map", map(c.groups, g, 4))?;
    add("retained: group cells outer map", map(c.groups, g, 24))?;
    add(
        "retained: group cells inner maps",
        maps(c.cells, c.groups, id, sz::<Counts>()),
    )?;
    Some(())
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
    // While an id array that is not one of integers is decoded, serde
    // formats one error message holding one of its strings (see
    // `error_message`); the walk and the split format none with a token in
    // it. And one float conversion at a time, in any phase.
    let union = raw
        .checked_add(ids.checked_mul(8)?)?
        .checked_add(scratch)?
        .checked_add(error_message(len)?)?;
    walk.max(split)
        .max(union)
        .checked_add(NUMERIC)?
        .checked_add(1024)
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
