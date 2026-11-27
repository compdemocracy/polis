//! The walk over the original bytes, before anything is decoded: depth,
//! repeated keys, and the counts every limit and the reservation are made
//! from. It builds no value; it keeps only the keys of the objects it is
//! inside, to find a repeated one.

use crate::limits::{Limit, SourceLimits};
use crate::measure::Measure;
use crate::refusal::{Key, SourceRefusal};
use serde::de;
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::fmt;

/// What the walk counted. Each count is of entries, whatever their type, so
/// a malformed entry is still counted and still bounded.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// Entries of `group-votes`.
    pub groups: u64,
    /// Entries of every `group-votes.<group>.votes`, summed.
    pub cells: u64,
    /// Elements of `tids`.
    pub tids: u64,
    /// Elements of `meta-tids`.
    pub meta: u64,
    /// Elements of `pca.comment-extremity`.
    pub extremity: u64,
    /// Entries of `comment-priorities`.
    pub priorities: u64,
    /// Elements of `group-clusters`, of each group's `members`, of
    /// `base-clusters.id`, of `base-clusters.members` and of each of its
    /// member lists, summed.
    pub memberships: u64,
    /// The longest string or key, in bytes as written.
    pub longest_string: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Top {
    Root,
    Is(Key),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    None,
    Votes,
    Members,
    Id,
    Extremity,
    Element,
    Other,
}

impl Step {
    fn of_key(k: &str) -> Step {
        match k {
            "votes" => Step::Votes,
            "members" => Step::Members,
            "id" => Step::Id,
            "comment-extremity" => Step::Extremity,
            _ => Step::Other,
        }
    }
}

fn top_key(k: &str) -> Key {
    match k {
        "group-votes" => Key::GroupVotes,
        "pca" => Key::CommentExtremity,
        "tids" => Key::Tids,
        "meta-tids" => Key::MetaTids,
        "comment-priorities" => Key::CommentPriorities,
        "group-clusters" => Key::GroupClusters,
        "base-clusters" => Key::BaseClusters,
        _ => Key::Projection,
    }
}

/// Where a value sits: its depth from the outer object, which top-level key
/// it is under, its depth below that key's value, and the last two steps.
#[derive(Clone, Copy)]
struct Ctx {
    depth: u32,
    top: Top,
    rel: u32,
    parent: Step,
    grand: Step,
}

#[derive(Clone, Copy)]
enum Counter {
    Groups,
    Cells,
    Tids,
    Meta,
    Extremity,
    Priorities,
    Memberships,
}

fn counter(c: &Ctx) -> Option<Counter> {
    let Top::Is(top) = c.top else { return None };
    match (top, c.rel, c.parent, c.grand) {
        (Key::GroupVotes, 0, _, _) => Some(Counter::Groups),
        (Key::GroupVotes, 2, Step::Votes, _) => Some(Counter::Cells),
        (Key::Tids, 0, _, _) => Some(Counter::Tids),
        (Key::MetaTids, 0, _, _) => Some(Counter::Meta),
        (Key::CommentPriorities, 0, _, _) => Some(Counter::Priorities),
        (Key::CommentExtremity, 1, Step::Extremity, _) => Some(Counter::Extremity),
        (Key::GroupClusters, 0, _, _) => Some(Counter::Memberships),
        (Key::GroupClusters, 2, Step::Members, _) => Some(Counter::Memberships),
        (Key::BaseClusters, 1, Step::Id | Step::Members, _) => Some(Counter::Memberships),
        (Key::BaseClusters, 2, Step::Element, Step::Members) => Some(Counter::Memberships),
        _ => None,
    }
}

pub(crate) struct State {
    pub(crate) tally: Tally,
    limits: SourceLimits,
    pub(crate) refusal: Option<SourceRefusal>,
    /// The measuring pass's counts, when the walk runs on measured bytes:
    /// the walk refuses where it would meet more than they say, before the
    /// spill is given room past them.
    measured: Option<Measure>,
    /// The keys held in open objects' spills, and the bytes of the escaped
    /// keys decoded so far.
    spill_live: u64,
    escaped_keys: u64,
}

impl State {
    pub(crate) fn new(limits: &SourceLimits) -> Self {
        Self {
            tally: Tally::default(),
            limits: *limits,
            refusal: None,
            measured: None,
            spill_live: 0,
            escaped_keys: 0,
        }
    }

    /// The walk over bytes `m` measured.
    pub(crate) fn measured(limits: &SourceLimits, m: &Measure) -> Self {
        Self {
            measured: Some(*m),
            ..Self::new(limits)
        }
    }

    fn disagrees<E: de::Error>(&mut self) -> E {
        self.refuse(SourceRefusal::TooLarge {
            what: Limit::Reservation,
        })
    }

    /// An object key decoded with an escape, of `len` bytes.
    fn escaped_key<E: de::Error>(&mut self, len: usize) -> Result<(), E> {
        self.escaped_keys = self.escaped_keys.saturating_add(len as u64);
        match self.measured {
            Some(m) if self.escaped_keys > m.escaped_keys() => Err(self.disagrees()),
            _ => Ok(()),
        }
    }

    /// The object whose keys number `before` is about to keep one more:
    /// past `SMALL`, every key of it is in its spill.
    fn spill_one<E: de::Error>(&mut self, before: usize) -> Result<(), E> {
        let after = before.saturating_add(1);
        if after == SMALL + 1 {
            self.spill_live = self.spill_live.saturating_add(after as u64);
        } else if after > SMALL + 1 {
            self.spill_live = self.spill_live.saturating_add(1);
        }
        match self.measured {
            Some(m) if self.spill_live > m.spill() => Err(self.disagrees()),
            _ => Ok(()),
        }
    }

    /// The object whose keys number `len` closed.
    fn spill_closed(&mut self, len: usize) {
        if len > SMALL {
            self.spill_live = self.spill_live.saturating_sub(len as u64);
        }
    }

    fn refuse<E: de::Error>(&mut self, r: SourceRefusal) -> E {
        if self.refusal.is_none() {
            self.refusal = Some(r);
        }
        E::custom("refused")
    }

    fn string<E: de::Error>(&mut self, len: usize) -> Result<(), E> {
        let len = u64::try_from(len).map_err(|_| self.refuse(SourceRefusal::CountOverflow))?;
        self.tally.longest_string = self.tally.longest_string.max(len);
        match self.measured {
            Some(m) if len > m.longest_string() => Err(self.disagrees()),
            _ => Ok(()),
        }
    }

    /// Counts one entry, and refuses at the first entry over its limit, so
    /// a source with too many entries is not walked further.
    fn one<E: de::Error>(&mut self, which: Option<Counter>) -> Result<(), E> {
        let Some(which) = which else { return Ok(()) };
        let (t, l) = (&mut self.tally, &self.limits);
        let (slot, max, what) = match which {
            Counter::Groups => (&mut t.groups, l.max_groups, Limit::Groups),
            Counter::Cells => (&mut t.cells, l.max_cells, Limit::Cells),
            Counter::Tids => (&mut t.tids, l.max_comments, Limit::Comments),
            Counter::Meta => (&mut t.meta, l.max_comments, Limit::Comments),
            Counter::Extremity => (&mut t.extremity, l.max_comments, Limit::Comments),
            Counter::Priorities => (&mut t.priorities, l.max_comments, Limit::Comments),
            Counter::Memberships => (&mut t.memberships, l.max_memberships, Limit::Memberships),
        };
        *slot = slot.saturating_add(1);
        if *slot > max {
            return Err(self.refuse(SourceRefusal::TooLarge { what }));
        }
        Ok(())
    }
}

/// Walks the outer value. The outer value must be an object.
pub(crate) struct Walk<'t> {
    st: &'t mut State,
    ctx: Ctx,
}

impl<'t> Walk<'t> {
    pub(crate) fn root(st: &'t mut State) -> Self {
        Self {
            st,
            ctx: Ctx {
                depth: 0,
                top: Top::Root,
                rel: 0,
                parent: Step::None,
                grand: Step::None,
            },
        }
    }
}

fn enter<E: de::Error>(st: &mut State, ctx: &Ctx) -> Result<u32, E> {
    let depth = ctx.depth.saturating_add(1);
    if depth > st.limits.max_depth {
        return Err(st.refuse(SourceRefusal::TooLarge { what: Limit::Depth }));
    }
    if let Some(m) = st.measured
        && u64::from(depth) > m.depth()
    {
        return Err(st.disagrees());
    }
    Ok(depth)
}

fn scalar<E: de::Error>(st: &mut State, ctx: &Ctx) -> Result<(), E> {
    if ctx.top == Top::Root {
        return Err(st.refuse(SourceRefusal::Malformed {
            key: Key::Projection,
        }));
    }
    Ok(())
}

impl<'de> DeserializeSeed<'de> for Walk<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Walk<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        scalar(self.st, &self.ctx)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        scalar(self.st, &self.ctx)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        scalar(self.st, &self.ctx)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        scalar(self.st, &self.ctx)
    }
    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        scalar(self.st, &self.ctx)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<(), E> {
        scalar(self.st, &self.ctx)?;
        self.st.string(v.len())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let Walk { st, ctx } = self;
        scalar(st, &ctx)?;
        let depth = enter(st, &ctx)?;
        let child = Ctx {
            depth,
            top: ctx.top,
            rel: ctx.rel.saturating_add(1),
            parent: Step::Element,
            grand: ctx.parent,
        };
        let which = counter(&ctx);
        while seq
            .next_element_seed(Walk {
                st: &mut *st,
                ctx: child,
            })?
            .is_some()
        {
            st.one(which)?;
        }
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let Walk { st, ctx } = self;
        let depth = enter(st, &ctx)?;
        let which = counter(&ctx);
        let mut keys = Keys::new();
        while let Some(k) = map.next_key_seed(KeySeed)? {
            st.string(k.len())?;
            if let Cow::Owned(owned) = &k {
                st.escaped_key(owned.len())?;
            }
            let child = if ctx.top == Top::Root {
                Ctx {
                    depth,
                    top: Top::Is(top_key(&k)),
                    rel: 0,
                    parent: Step::None,
                    grand: Step::None,
                }
            } else {
                Ctx {
                    depth,
                    top: ctx.top,
                    rel: ctx.rel.saturating_add(1),
                    parent: Step::of_key(&k),
                    grand: ctx.parent,
                }
            };
            map.next_value_seed(Walk {
                st: &mut *st,
                ctx: child,
            })?;
            st.one(which)?;
            st.spill_one(keys.len)?;
            match keys.insert(k) {
                Some(true) => {}
                Some(false) => {
                    let key = match ctx.top {
                        Top::Root => keys.last_top,
                        Top::Is(k) => k,
                    };
                    return Err(st.refuse(SourceRefusal::DuplicateKey { key }));
                }
                None => {
                    return Err(st.refuse(SourceRefusal::TooLarge {
                        what: Limit::Reservation,
                    }));
                }
            }
        }
        if keys.spilled_duplicate() {
            let key = match ctx.top {
                Top::Root => Key::Projection,
                Top::Is(k) => k,
            };
            return Err(st.refuse(SourceRefusal::DuplicateKey { key }));
        }
        st.spill_closed(keys.len);
        Ok(())
    }
}

/// How many keys of one open object are kept as written before the rest
/// spill: the one constant the walk and the measuring pass share.
pub(crate) const SMALL: usize = 8;

/// The keys of one open object. The first eight are kept as written (on the
/// stack, borrowed from the bytes when they have no escapes), so the objects
/// that make up most of a math result (each cell, each group) allocate
/// nothing. Past eight, every key is kept as one 64-bit value: a decimal id
/// as itself, any other key as its FNV-1a hash with the top bit set. Two
/// equal values refuse the object as repeating a key; two different keys
/// whose hashes collide are refused too, which is safe (the read is refused,
/// never misread).
///
/// The spill is grown by exact doubling from sixteen entries, so it never
/// holds room for more than twice the keys in it; `parse_reservation`
/// counts on that.
struct Keys<'de> {
    small: [Option<Cow<'de, str>>; SMALL],
    len: usize,
    spill: Vec<u64>,
    last_top: Key,
}

fn key_value(k: &str) -> u64 {
    let digits = !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit());
    if digits
        && (k.len() == 1 || !k.starts_with('0'))
        && let Ok(n) = k.parse::<u32>()
    {
        return u64::from(n);
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in k.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h | (1 << 63)
}

impl<'de> Keys<'de> {
    fn new() -> Self {
        Self {
            small: Default::default(),
            len: 0,
            spill: Vec::new(),
            last_top: Key::Projection,
        }
    }

    /// False when the key repeats one already seen among the first eight;
    /// `None` when the spill could not be given room.
    fn insert(&mut self, k: Cow<'de, str>) -> Option<bool> {
        self.last_top = top_key(&k);
        if self.small.iter().flatten().any(|s| *s == k) {
            return Some(false);
        }
        if self.len < SMALL {
            if let Some(slot) = self.small.get_mut(self.len) {
                *slot = Some(k);
            }
        } else {
            if self.spill.capacity() == 0 {
                self.spill.try_reserve_exact(2 * SMALL).ok()?;
                for s in self.small.iter().flatten() {
                    self.spill.push(key_value(s));
                }
            } else if self.spill.len() == self.spill.capacity() {
                self.spill.try_reserve_exact(self.spill.len()).ok()?;
            }
            self.spill.push(key_value(&k));
        }
        self.len += 1;
        Some(true)
    }

    /// True when the keys past the first eight repeat a value.
    fn spilled_duplicate(&mut self) -> bool {
        self.spill.sort_unstable();
        self.spill
            .iter()
            .zip(self.spill.iter().skip(1))
            .any(|(a, b)| a == b)
    }
}

/// An object key, borrowed from the bytes when it has no escapes.
struct KeySeed;

impl<'de> DeserializeSeed<'de> for KeySeed {
    type Value = Cow<'de, str>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Cow<'de, str>, D::Error> {
        d.deserialize_str(KeyVisitor)
    }
}

struct KeyVisitor;

impl<'de> Visitor<'de> for KeyVisitor {
    type Value = Cow<'de, str>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object key")
    }
    fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Cow<'de, str>, E> {
        Ok(Cow::Borrowed(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Cow<'de, str>, E> {
        Ok(Cow::Owned(v.to_owned()))
    }
}
