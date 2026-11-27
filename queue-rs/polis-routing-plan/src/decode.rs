//! Typed decoders for the keys a frame is made from. Each reads one key's
//! text, only when a needed frame is made from it. Ids are parsed from the
//! key text in place; nothing here keeps a string.

use polis_routing_equation::StoredWeight;
use serde::Deserialize;
use serde::de;
use serde::de::{Deserializer, MapAccess, Visitor};
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

pub(crate) struct Cell {
    pub(crate) tid: u32,
    pub(crate) counts: CellCounts,
}

pub(crate) struct Votes(pub(crate) Vec<Cell>);

impl<'de> Deserialize<'de> for Votes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Votes;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of comment ids")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Votes, A::Error> {
                let mut cells = Vec::new();
                while let Some(IdKey(tid)) = map.next_key()? {
                    let counts: CellCounts = map.next_value()?;
                    cells.push(Cell { tid, counts });
                }
                Ok(Votes(cells))
            }
        }
        d.deserialize_map(V)
    }
}

/// One entry of `group-votes`. Other keys (the engine also writes `id`) are
/// not read.
#[derive(Deserialize)]
pub(crate) struct GroupBody {
    #[serde(rename = "n-members")]
    pub(crate) members: u32,
    pub(crate) votes: Votes,
}

pub(crate) struct Group {
    pub(crate) id: u32,
    pub(crate) body: GroupBody,
}

pub(crate) struct GroupVotes(pub(crate) Vec<Group>);

impl<'de> Deserialize<'de> for GroupVotes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = GroupVotes;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of group ids")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<GroupVotes, A::Error> {
                let mut groups = Vec::new();
                while let Some(IdKey(id)) = map.next_key()? {
                    let body: GroupBody = map.next_value()?;
                    groups.push(Group { id, body });
                }
                Ok(GroupVotes(groups))
            }
        }
        d.deserialize_map(V)
    }
}

/// `pca`, of which only `comment-extremity` is read.
#[derive(Deserialize)]
pub(crate) struct Pca {
    #[serde(rename = "comment-extremity", default)]
    pub(crate) extremity: Option<Vec<f64>>,
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

/// `comment-priorities` as an object of comment ids.
pub(crate) struct Priorities(pub(crate) Vec<(u32, StoredWeight)>);

impl<'de> Deserialize<'de> for Priorities {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Priorities;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of comment ids")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Priorities, A::Error> {
                let mut out = Vec::new();
                while let Some(IdKey(tid)) = map.next_key()? {
                    let Weight(w) = map.next_value()?;
                    out.push((tid, w));
                }
                Ok(Priorities(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// The size of each element this module decodes into, for the reservation.
pub(crate) fn sizes() -> DecodedSizes {
    DecodedSizes {
        cell: std::mem::size_of::<Cell>() as u64,
        group: std::mem::size_of::<Group>() as u64,
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
