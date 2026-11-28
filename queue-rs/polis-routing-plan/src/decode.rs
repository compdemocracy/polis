//! Typed decoders for the keys a frame is made from. Each reads one key's
//! text, only when a needed frame is made from it. Ids are parsed from the
//! key text in place; nothing here keeps a string.

use polis_routing_equation::{CommentId, Counts, GroupId, Refusal, StoredWeight};
use serde::Deserialize;
use serde::de;
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::fmt;

/// A non-negative decimal id written as the math result writes one: no sign,
/// no leading zero, at most 2^32 - 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IdKey(pub(crate) u32);

fn canonical(v: &str) -> Option<u32> {
    let digits = !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    let leading_zero = v.len() > 1 && v.starts_with('0');
    if !digits || leading_zero {
        return None;
    }
    v.parse::<u32>().ok()
}

impl<'de> Deserialize<'de> for IdKey {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = IdKey;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a decimal id")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<IdKey, E> {
                canonical(v)
                    .map(IdKey)
                    .ok_or_else(|| E::custom("not a decimal id"))
            }
        }
        d.deserialize_str(V)
    }
}

/// One cell of `group-votes.<group>.votes.<tid>`: the engine's counts.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CellCounts {
    #[serde(rename = "A")]
    pub(crate) agreed: u32,
    #[serde(rename = "D")]
    pub(crate) disagreed: u32,
    #[serde(rename = "S")]
    pub(crate) seen: u64,
}

/// A vector given its room once, for exactly the number of elements the
/// walk counted, that never grows. `push` on a vector whose capacity is
/// above its length never reallocates (the standard library documents it:
/// "`push` and `insert` will never (re)allocate if the reported capacity is
/// sufficient"); an element past the room is refused instead, and marks
/// the decode as having met more than was counted.
pub(crate) struct Exact<T> {
    items: Vec<T>,
    over: bool,
}

impl<T> Exact<T> {
    /// Room for exactly `n` elements, or `None`: when the allocator
    /// refuses, or when it gives any capacity but `n`. Neither
    /// `with_capacity` nor `try_reserve_exact` is documented to give
    /// exactly what was asked ("the allocator may give the collection more
    /// space than it requests"), and the charge is `n` elements, so a
    /// vector with more room is refused here, before anything is put in it.
    pub(crate) fn new(n: u64) -> Option<Self> {
        let n = usize::try_from(n).ok()?;
        let mut items = Vec::new();
        items.try_reserve_exact(n).ok()?;
        (items.capacity() == n).then_some(Exact { items, over: false })
    }

    /// Puts `x` in the room left, or refuses it: `false`, and the vector
    /// is marked as having met more than its count.
    pub(crate) fn put(&mut self, x: T) -> bool {
        if self.items.len() == self.items.capacity() {
            self.over = true;
            return false;
        }
        self.items.push(x);
        true
    }

    fn push<E: de::Error>(&mut self, x: T) -> Result<(), E> {
        if self.put(x) {
            Ok(())
        } else {
            Err(E::custom("more entries than counted"))
        }
    }

    /// Whether an element was refused for want of room.
    pub(crate) fn over(&self) -> bool {
        self.over
    }

    pub(crate) fn into_vec(self) -> Vec<T> {
        self.items
    }
}

/// Appends the elements of an array to an `Exact` vector.
pub(crate) struct Seq<'a, T>(pub(crate) &'a mut Exact<T>);

impl<'de, T: Deserialize<'de>> DeserializeSeed<'de> for Seq<'_, T> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de, T: Deserialize<'de>> Visitor<'de> for Seq<'_, T> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(x) = seq.next_element::<T>()? {
            self.0.push(x)?;
        }
        Ok(())
    }
}

/// The names of an object's fields this module reads, and every other.
enum Field {
    Extremity,
    Members,
    Votes,
    Other,
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Field;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a field name")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Field, E> {
                Ok(match v {
                    "comment-extremity" => Field::Extremity,
                    "n-members" => Field::Members,
                    "votes" => Field::Votes,
                    _ => Field::Other,
                })
            }
        }
        d.deserialize_identifier(V)
    }
}

/// `pca`, of which only `comment-extremity` is read, into an `Exact`
/// vector. Its value is whether the key was there and not `null`; other
/// keys are skipped.
pub(crate) struct PcaInto<'a>(pub(crate) &'a mut Exact<f64>);

impl<'de> DeserializeSeed<'de> for PcaInto<'_> {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for PcaInto<'_> {
    type Value = bool;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        let mut found = None;
        while let Some(field) = map.next_key::<Field>()? {
            match field {
                Field::Extremity if found.is_some() => {
                    return Err(de::Error::duplicate_field("comment-extremity"));
                }
                Field::Extremity => found = Some(map.next_value_seed(Maybe(&mut *self.0))?),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(found.unwrap_or(false))
    }
}

/// An array or `null`: `true` when it was an array.
struct Maybe<'a, T>(&'a mut Exact<T>);

impl<'de, T: Deserialize<'de>> DeserializeSeed<'de> for Maybe<'_, T> {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_option(self)
    }
}

impl<'de, T: Deserialize<'de>> Visitor<'de> for Maybe<'_, T> {
    type Value = bool;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array or null")
    }
    fn visit_none<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        Seq(self.0).deserialize(d).map(|()| true)
    }
}

/// `group-votes`, straight into two `Exact` vectors: each group's id and
/// `n-members`, and every cell as the group frame takes it. A cell whose
/// counts the equation crate refuses is not kept; the first such refusal
/// is kept in `fault`, to be given after the membership check, as when the
/// cells were read after it.
pub(crate) struct GroupVotesInto<'a> {
    pub(crate) groups: &'a mut Exact<(u32, u32)>,
    pub(crate) cells: &'a mut Exact<(GroupId, CommentId, Counts)>,
    pub(crate) fault: &'a mut Option<Refusal>,
}

impl<'de> DeserializeSeed<'de> for GroupVotesInto<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for GroupVotesInto<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object of group ids")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(IdKey(id)) = map.next_key()? {
            let members = map.next_value_seed(BodyInto {
                group: GroupId::new(id),
                cells: &mut *self.cells,
                fault: &mut *self.fault,
            })?;
            self.groups.push((id, members))?;
        }
        Ok(())
    }
}

/// One entry of `group-votes`: its `n-members`, and its `votes` put in the
/// cells. Other keys (the engine also writes `id`) are not read.
struct BodyInto<'a> {
    group: GroupId,
    cells: &'a mut Exact<(GroupId, CommentId, Counts)>,
    fault: &'a mut Option<Refusal>,
}

impl<'de> DeserializeSeed<'de> for BodyInto<'_> {
    type Value = u32;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<u32, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for BodyInto<'_> {
    type Value = u32;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<u32, A::Error> {
        let mut members = None;
        let mut votes = false;
        while let Some(field) = map.next_key::<Field>()? {
            match field {
                Field::Members if members.is_some() => {
                    return Err(de::Error::duplicate_field("n-members"));
                }
                Field::Members => members = Some(map.next_value::<u32>()?),
                Field::Votes if votes => return Err(de::Error::duplicate_field("votes")),
                Field::Votes => {
                    votes = true;
                    map.next_value_seed(VotesInto {
                        group: self.group,
                        cells: &mut *self.cells,
                        fault: &mut *self.fault,
                    })?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        if !votes {
            return Err(de::Error::missing_field("votes"));
        }
        members.ok_or_else(|| de::Error::missing_field("n-members"))
    }
}

/// `group-votes.<group>.votes`: an object of comment ids, each a cell.
struct VotesInto<'a> {
    group: GroupId,
    cells: &'a mut Exact<(GroupId, CommentId, Counts)>,
    fault: &'a mut Option<Refusal>,
}

impl<'de> DeserializeSeed<'de> for VotesInto<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for VotesInto<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object of comment ids")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(IdKey(tid)) = map.next_key()? {
            let Object(c): Object<CellCounts> = map.next_value()?;
            match Counts::from_seen(c.agreed, c.disagreed, c.seen) {
                Ok(counts) => self.cells.push((self.group, CommentId::new(tid), counts))?,
                Err(r) => {
                    self.fault.get_or_insert(r);
                }
            }
        }
        Ok(())
    }
}

/// One entry of `group-clusters`: its members are base-cluster ids.
#[derive(Deserialize)]
pub(crate) struct GroupCluster {
    pub(crate) id: u32,
    pub(crate) members: Vec<u32>,
}

/// `base-clusters`, column by column: `id[i]` is the base cluster whose
/// participants are `members[i]`. The other columns are not read.
#[derive(Deserialize)]
pub(crate) struct BaseClusters {
    pub(crate) id: Vec<u32>,
    pub(crate) members: Vec<Vec<u32>>,
}

/// One stored weight, read as the equation crate reads it: a number, `null`
/// or `false`; anything else is refused.
struct Weight(StoredWeight);

impl<'de> Deserialize<'de> for Weight {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Weight;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a number, null or false")
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Weight, E> {
                Ok(Weight(StoredWeight::Number(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Weight, E> {
                Ok(Weight(StoredWeight::Number(v as f64)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Weight, E> {
                Ok(Weight(StoredWeight::Number(v as f64)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Weight, E> {
                Ok(Weight(StoredWeight::Null))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Weight, E> {
                if v {
                    Err(E::custom("true is not a weight"))
                } else {
                    Ok(Weight(StoredWeight::False))
                }
            }
        }
        d.deserialize_any(V)
    }
}

/// `comment-priorities`, an object of comment ids, into an `Exact` vector.
pub(crate) struct PrioritiesInto<'a>(pub(crate) &'a mut Exact<(u32, StoredWeight)>);

impl<'de> DeserializeSeed<'de> for PrioritiesInto<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for PrioritiesInto<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object of comment ids")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(IdKey(tid)) = map.next_key()? {
            let Weight(w) = map.next_value()?;
            self.0.push((tid, w))?;
        }
        Ok(())
    }
}

/// The size of each element this module decodes into, for the reservation.
pub(crate) fn sizes() -> DecodedSizes {
    DecodedSizes {
        cell: std::mem::size_of::<(GroupId, CommentId, Counts)>() as u64,
        group: std::mem::size_of::<(u32, u32)>() as u64,
        group_cluster: std::mem::size_of::<GroupCluster>() as u64,
        id: std::mem::size_of::<u32>() as u64,
        id_list: std::mem::size_of::<Vec<u32>>() as u64,
        tid: std::mem::size_of::<i64>() as u64,
        extremity: std::mem::size_of::<f64>() as u64,
        priority: std::mem::size_of::<(u32, StoredWeight)>() as u64,
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DecodedSizes {
    pub(crate) cell: u64,
    pub(crate) group: u64,
    pub(crate) group_cluster: u64,
    pub(crate) id: u64,
    pub(crate) id_list: u64,
    pub(crate) tid: u64,
    pub(crate) extremity: u64,
    pub(crate) priority: u64,
}

/// Serde's derived struct decoder also accepts positional sequences. These
/// stored records are objects: accepting a sequence would bypass the named
/// paths counted by the preflight walk and understate the reservation.
pub(crate) struct Object<T>(pub(crate) T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = Object<T>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }
        d.deserialize_map(V(std::marker::PhantomData))
    }
}

/// Appends an array of integers to a vector already given room for them,
/// and never grows it: more elements than its room is an error.
pub(crate) struct IdsInto<'a>(pub(crate) &'a mut Vec<i64>);

impl<'de> DeserializeSeed<'de> for IdsInto<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for IdsInto<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array of integers")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(id) = seq.next_element::<i64>()? {
            if self.0.len() == self.0.capacity() {
                return Err(serde::de::Error::custom("more ids than counted"));
            }
            self.0.push(id);
        }
        Ok(())
    }
}
