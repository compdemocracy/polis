//! One stored math result's projection, checked, and the frames read from it.

use crate::decode;
use crate::identity::{ContentId, RowIdentity, source_id};
use crate::limits::{Limit, SourceLimits};
use crate::refusal::{Key, SourceRefusal};
use crate::reserve::{parse_reservation, reservation, retained_terms, sum_terms};
use crate::scan::{State, Tally, Walk};
use polis_routing_equation::{
    CommentId, Counts, CurrentGroupFrame, Extremity, ExtremityFrame, GroupId, MetaComments,
    Refusal, SourceId, StoredWeights,
};
use serde::Deserialize;
use serde::de::DeserializeSeed;
use serde_json::value::RawValue;
use std::collections::BTreeMap;

/// The keys this crate reads, each kept as its own text, decoded only when a
/// needed frame is made from it. Every other key (the legacy
/// `group_clusters` among them, and the `math_tick` inside the JSON) is
/// never read.
#[derive(Debug, Deserialize)]
struct Raw {
    #[serde(rename = "group-votes", default)]
    group_votes: Option<Box<RawValue>>,
    #[serde(default)]
    pca: Option<Box<RawValue>>,
    #[serde(default)]
    tids: Option<Box<RawValue>>,
    #[serde(rename = "meta-tids", default)]
    meta_tids: Option<Box<RawValue>>,
    #[serde(rename = "comment-priorities", default)]
    priorities: Option<Box<RawValue>>,
    #[serde(rename = "group-clusters", default)]
    clusters: Option<Box<RawValue>>,
    #[serde(rename = "base-clusters", default)]
    base_clusters: Option<Box<RawValue>>,
}

/// One projection of a `math_main` row: its bytes checked, its keys kept,
/// nothing expanded.
#[derive(Debug)]
pub struct Projection {
    row: RowIdentity,
    content: ContentId,
    source: SourceId,
    tally: Tally,
    limits: SourceLimits,
    raw: Raw,
}

/// Which frames the configured rule reads. A frame not needed is not
/// decoded, so a malformed key it would be made from cannot refuse the read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameNeeds {
    /// `comment-priorities`, for `stored-weights/1`.
    pub stored_weights: bool,
    /// `tids` and `pca.comment-extremity`.
    pub extremity: bool,
    /// `group-votes`, checked against `group-clusters` and `base-clusters`.
    pub groups: bool,
    /// `meta-tids`.
    pub meta: bool,
}

impl FrameNeeds {
    /// Every frame.
    pub fn all() -> Self {
        Self {
            stored_weights: true,
            extremity: true,
            groups: true,
            meta: true,
        }
    }
}

/// The frames of one read. Each frame is present only if it was needed;
/// every present frame carries `source`. They own all they hold and borrow
/// nothing from the projection, so the projection (and the buffer it was
/// parsed from) can be dropped before a plan is built from them.
#[derive(Clone, Debug, PartialEq)]
pub struct Frames {
    extremity: Option<ExtremityFrame>,
    groups: Option<CurrentGroupFrame>,
    meta: Option<MetaComments>,
    stored: Option<StoredWeights>,
    source: SourceId,
    needs: FrameNeeds,
    counts: FrameCounts,
}

/// The real lengths of one read's frames (0 for a frame not read), and the
/// two distinct counts of comment ids a build's bound is taken from. Counted
/// while the frames are made, with no allocation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameCounts {
    /// The stored map's entries.
    pub stored: u64,
    /// The extremity frame's entries (each a distinct comment).
    pub extremity: u64,
    /// The meta set's entries.
    pub meta: u64,
    /// The group frame's groups.
    pub groups: u64,
    /// The group frame's cells, every group's together.
    pub cells: u64,
    /// The distinct comment ids among the cells: the latest counts' keys.
    pub distinct: u64,
    /// The distinct comment ids among the cells and the extremity frame
    /// together: the ids the floor's build weighs.
    pub union: u64,
}

impl Frames {
    /// The needs these frames were read for. A plan build checks them, so
    /// that frames read without the stored weights are never taken for a
    /// conversation with no stored map.
    pub fn needs(&self) -> FrameNeeds {
        self.needs
    }
    /// How many entries the stored map holds (0 when there is none), which
    /// the map itself does not say; a plan's charge counts them.
    pub fn stored_entries(&self) -> usize {
        self.counts.stored as usize
    }
    /// How many meta comments the meta frame holds (0 when not read), which
    /// the set itself does not say; a plan's charge counts them.
    pub fn meta_entries(&self) -> usize {
        self.counts.meta as usize
    }
    /// The frames' real lengths and distinct counts.
    pub fn counts(&self) -> FrameCounts {
        self.counts
    }
    /// An upper bound, in bytes, on the heap the frames themselves hold
    /// from when `Projection::frames` returns until they are dropped: their
    /// ordered maps at their real lengths and their source ids. Allocation
    /// free; `None` on overflow or under an unreviewed toolchain.
    pub fn retained_bound(&self) -> Option<u64> {
        sum_terms(|term| retained_terms(&self.counts, term))
    }
    pub fn extremity(&self) -> Option<&ExtremityFrame> {
        self.extremity.as_ref()
    }
    pub fn groups(&self) -> Option<&CurrentGroupFrame> {
        self.groups.as_ref()
    }
    pub fn meta(&self) -> Option<&MetaComments> {
        self.meta.as_ref()
    }
    /// The stored weights. `None` when they were not needed, and also when
    /// they were needed and the row has no `comment-priorities` (absent or
    /// `null`): today's read route then weighs every candidate 1, and so
    /// does `stored-weights/1` given no map.
    pub fn stored(&self) -> Option<&StoredWeights> {
        self.stored.as_ref()
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
}

fn malformed(key: Key) -> impl Fn(serde_json::Error) -> SourceRefusal {
    move |_| SourceRefusal::Malformed { key }
}

/// The equation crate's refusals a frame constructor can give here, as this
/// crate's; none of them carries a comment id out.
fn library(key: Key) -> impl Fn(Refusal) -> SourceRefusal {
    move |r| match r {
        Refusal::SeenBelowVotes { .. } => SourceRefusal::SeenBelowVotes,
        Refusal::CountOverflow => SourceRefusal::CountOverflow,
        Refusal::DuplicateComment(_) => SourceRefusal::DuplicateComment { key },
        Refusal::InvalidExtremity => SourceRefusal::InvalidExtremity,
        Refusal::DuplicateGroup(_) | Refusal::DuplicateCell { .. } => {
            SourceRefusal::DuplicateKey { key }
        }
        Refusal::EmptyGroup(_) => SourceRefusal::EmptyGroup,
        Refusal::SeenAboveMembers { .. } => SourceRefusal::SeenAboveMembers,
        Refusal::MembersAboveParticipants => SourceRefusal::MembersMismatch,
        _ => SourceRefusal::Malformed { key },
    }
}

fn check(n: u64, max: u64, what: Limit) -> Result<(), SourceRefusal> {
    if n > max {
        return Err(SourceRefusal::TooLarge { what });
    }
    Ok(())
}

fn need(raw: &Option<Box<RawValue>>, key: Key) -> Result<&str, SourceRefusal> {
    raw.as_deref()
        .map(RawValue::get)
        .ok_or(SourceRefusal::Missing { key })
}

/// The comments limit counts the union of `tids` and `meta-tids`: checked
/// here, at parse, whatever frames are needed later and before any is made.
/// When the two counts together are within the limit there is nothing to
/// do; otherwise both arrays are read into one vector reserved for exactly
/// their elements, and the distinct ids counted. An array that is not one
/// of integers adds no id (its own frame is refused as malformed if it is
/// ever needed), so a malformed unused key cannot refuse another rule.
fn union_within(raw: &Raw, t: &Tally, limits: &SourceLimits) -> Result<(), SourceRefusal> {
    let sum = t
        .tids
        .checked_add(t.meta)
        .ok_or(SourceRefusal::CountOverflow)?;
    if sum <= limits.max_comments {
        return Ok(());
    }
    let room = SourceRefusal::TooLarge {
        what: Limit::Reservation,
    };
    let mut ids: Vec<i64> = Vec::new();
    ids.try_reserve_exact(usize::try_from(sum).map_err(|_| room)?)
        .map_err(|_| room)?;
    for text in [&raw.tids, &raw.meta_tids].into_iter().flatten() {
        let start = ids.len();
        let mut de = serde_json::Deserializer::from_str(text.get());
        let read = decode::IdsInto(&mut ids)
            .deserialize(&mut de)
            .and_then(|()| de.end());
        if read.is_err() {
            ids.truncate(start);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    check(ids.len() as u64, limits.max_comments, Limit::Comments)
}

/// The refusal for a decode that would need more room than the walk's
/// counts gave it, or room the allocator would not give exactly: the
/// reservation was made from those counts, so nothing past them is decoded.
fn room() -> SourceRefusal {
    SourceRefusal::TooLarge {
        what: Limit::Reservation,
    }
}

/// A vector of room for exactly `n` elements, allocated once (`Exact`).
fn exact<T>(n: u64) -> Result<decode::Exact<T>, SourceRefusal> {
    decode::Exact::new(n).ok_or_else(room)
}

/// Reads one key's text through `seed`, as `serde_json::from_str` would.
fn read<'de, S: DeserializeSeed<'de>>(text: &'de str, seed: S) -> serde_json::Result<S::Value> {
    let mut de = serde_json::Deserializer::from_str(text);
    let value = seed.deserialize(&mut de)?;
    de.end()?;
    Ok(value)
}

/// A decode's failure as a refusal: past the room its count gave, `room`;
/// anything else, `Malformed`.
fn decoded<T>(read: serde_json::Result<T>, over: bool, key: Key) -> Result<T, SourceRefusal> {
    read.map_err(|_| {
        if over {
            room()
        } else {
            SourceRefusal::Malformed { key }
        }
    })
}

fn tid(v: i64, key: Key) -> Result<CommentId, SourceRefusal> {
    CommentId::try_from(v).map_err(|_| SourceRefusal::Malformed { key })
}

/// The distinct comment ids among `cells`, sorted by comment, and their
/// union with the extremity frame's ids, counted in one merge with no
/// allocation: the extremity's ids come from its ordered map, ascending and
/// each once.
fn distinct_and_union(
    cells: &[(GroupId, CommentId, Counts)],
    extremity: Option<&ExtremityFrame>,
) -> (u64, u64) {
    let mut ext = extremity.into_iter().flat_map(ExtremityFrame::ids);
    let mut next = ext.next();
    let (mut distinct, mut union) = (0u64, 0u64);
    let mut last = None;
    for &(_, id, _) in cells {
        if last == Some(id) {
            continue;
        }
        last = Some(id);
        distinct = distinct.saturating_add(1);
        while next.is_some_and(|e| e < id) {
            union = union.saturating_add(1);
            next = ext.next();
        }
        if next == Some(id) {
            next = ext.next();
        }
        union = union.saturating_add(1);
    }
    while next.is_some() {
        union = union.saturating_add(1);
        next = ext.next();
    }
    (distinct, union)
}

impl Projection {
    /// Checks the bytes and keeps their keys; decodes no frame.
    ///
    /// Its additional heap payload is bounded by
    /// `Projection::parse_reservation(bytes.len(), limits)`, whether it then
    /// refuses or not. The caller separately accounts for the existing input
    /// buffer and row environment capacity. Once it returns, `held()` bounds
    /// retained heap payload, including the transferred row environment.
    ///
    /// In order: the length; then one walk over the original bytes that
    /// refuses anything that is not one JSON object, any depth over the
    /// limit and any key given twice in one object, and counts the entries
    /// every other limit is about; then every count against its limit. Only
    /// then are the keys this crate reads set apart, each as its own text.
    pub fn parse(
        bytes: &[u8],
        row: RowIdentity,
        limits: &SourceLimits,
    ) -> Result<Projection, SourceRefusal> {
        let len = u64::try_from(bytes.len())
            .map_err(|_| SourceRefusal::TooLarge { what: Limit::Bytes })?;
        check(len, limits.max_bytes, Limit::Bytes)?;
        if parse_reservation(len, limits).is_none() {
            return Err(SourceRefusal::TooLarge {
                what: Limit::Reservation,
            });
        }

        // The walk, in its own scope, so its reader's scratch is freed
        // before the next phase (`parse_reservation` counts on it).
        let t = {
            let mut state = State::new(limits);
            let mut de = serde_json::Deserializer::from_slice(bytes);
            let walked = Walk::root(&mut state)
                .deserialize(&mut de)
                .and_then(|()| de.end());
            if let Some(r) = state.refusal {
                return Err(r);
            }
            walked.map_err(malformed(Key::Projection))?;
            state.tally
        };
        check(t.tids, limits.max_comments, Limit::Comments)?;
        check(t.meta, limits.max_comments, Limit::Comments)?;
        check(t.extremity, limits.max_comments, Limit::Comments)?;
        check(t.priorities, limits.max_comments, Limit::Comments)?;
        check(t.groups, limits.max_groups, Limit::Groups)?;
        check(t.cells, limits.max_cells, Limit::Cells)?;
        check(t.memberships, limits.max_memberships, Limit::Memberships)?;
        if reservation(&t, len, FrameNeeds::all()).is_none() {
            return Err(SourceRefusal::TooLarge {
                what: Limit::Reservation,
            });
        }

        let raw: Raw = serde_json::from_slice(bytes).map_err(malformed(Key::Projection))?;
        union_within(&raw, &t, limits)?;
        let content = ContentId::of(bytes);
        let source = source_id(&row, &content)?;
        Ok(Projection {
            row,
            content,
            source,
            tally: t,
            limits: *limits,
            raw,
        })
    }

    pub fn row(&self) -> &RowIdentity {
        &self.row
    }
    pub fn content(&self) -> &ContentId {
        &self.content
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn tally(&self) -> &Tally {
        &self.tally
    }
    /// The limits it was checked under.
    pub fn limits(&self) -> &SourceLimits {
        &self.limits
    }

    /// An upper bound on the additional heap payload `parse` holds at once
    /// for a source of `len` bytes under `limits`, known before it is called.
    /// Existing input-buffer and row-environment capacities need separate
    /// charges. This excludes inline values, stack and allocator metadata.
    /// A length whose bound does not fit in 64 bits is refused, as `parse`
    /// refuses it.
    pub fn parse_reservation(len: usize, limits: &SourceLimits) -> Result<u64, SourceRefusal> {
        u64::try_from(len)
            .ok()
            .and_then(|len| parse_reservation(len, limits))
            .ok_or(SourceRefusal::TooLarge {
                what: Limit::Reservation,
            })
    }

    /// An upper bound on retained heap payload: the text of each key it
    /// read, the row's environment capacity and the source id. This excludes
    /// the inline Projection value, stack and allocator metadata; it includes
    /// the environment allocation transferred into parse by the caller.
    pub fn held(&self) -> u64 {
        self.raw_len()
            .saturating_add(self.row.math_env.capacity() as u64)
            .saturating_add(256)
    }

    /// The length of the text of the keys it read, kept for `frames`: at
    /// most the source's length.
    pub fn raw_len(&self) -> u64 {
        let r = &self.raw;
        let text: usize = [
            &r.group_votes,
            &r.pca,
            &r.tids,
            &r.meta_tids,
            &r.priorities,
            &r.clusters,
            &r.base_clusters,
        ]
        .into_iter()
        .flatten()
        .map(|v| v.get().len())
        .sum();
        text as u64
    }

    /// An upper bound, in bytes, on what `frames(needs)` allocates, from the
    /// walk's counts and the length of the keys' text it read.
    pub fn reservation(&self, needs: FrameNeeds) -> Result<u64, SourceRefusal> {
        reservation(&self.tally, self.raw_len(), needs).ok_or(SourceRefusal::TooLarge {
            what: Limit::Reservation,
        })
    }

    /// Reads the frames the rule needs, and only those.
    pub fn frames(&self, needs: FrameNeeds) -> Result<Frames, SourceRefusal> {
        let (stored, stored_entries) = match needs.stored_weights.then(|| self.stored()) {
            Some(read) => read?.map_or((None, 0), |(map, n)| (Some(map), n)),
            None => (None, 0),
        };
        let (extremity, extremity_entries) = if needs.extremity {
            let (frame, n) = self.extremity()?;
            (Some(frame), n)
        } else {
            (None, 0)
        };
        let (meta, meta_entries) = if needs.meta {
            let ids = self.meta_ids()?;
            let set = MetaComments::new(ids.iter().copied()).map_err(library(Key::MetaTids))?;
            (Some(set), ids.len())
        } else {
            (None, 0)
        };
        let mut counts = FrameCounts {
            stored: stored_entries as u64,
            extremity: extremity_entries as u64,
            meta: meta_entries as u64,
            // With no group frame, the ids weighed are the extremity's.
            union: extremity_entries as u64,
            ..FrameCounts::default()
        };
        let groups = if needs.groups {
            let (frame, g) = self.groups(extremity.as_ref())?;
            counts.groups = g.groups;
            counts.cells = g.cells;
            counts.distinct = g.distinct;
            counts.union = g.union;
            Some(frame)
        } else {
            None
        };
        Ok(Frames {
            extremity,
            groups,
            meta,
            stored,
            source: self.source.clone(),
            needs,
            counts,
        })
    }

    fn stored(&self) -> Result<Option<(StoredWeights, usize)>, SourceRefusal> {
        let key = Key::CommentPriorities;
        let Some(raw) = self.raw.priorities.as_deref() else {
            return Ok(None);
        };
        let text = raw.get();
        if text.trim_start().starts_with('[') {
            return Err(SourceRefusal::ArrayPriorities);
        }
        let mut entries = exact(self.tally.priorities)?;
        let read = read(text, decode::PrioritiesInto(&mut entries));
        decoded(read, entries.over(), key)?;
        let entries = entries.into_vec();
        let count = entries.len();
        let entries = entries.into_iter().map(|(tid, w)| (CommentId::new(tid), w));
        StoredWeights::new(self.source.clone(), entries)
            .map(|map| Some((map, count)))
            .map_err(library(key))
    }

    /// The extremity frame and its length (every pair it was made from:
    /// the frame refuses a comment given twice).
    fn extremity(&self) -> Result<(ExtremityFrame, usize), SourceRefusal> {
        let text = need(&self.raw.tids, Key::Tids)?;
        let mut tids = exact::<i64>(self.tally.tids)?;
        let read_tids = read(text, decode::Seq(&mut tids));
        decoded(read_tids, tids.over(), Key::Tids)?;
        let key = Key::CommentExtremity;
        let text = need(&self.raw.pca, key)?;
        let mut values = exact::<f64>(self.tally.extremity)?;
        let found = read(text, decode::PcaInto(&mut values));
        if !decoded(found, values.over(), key)? {
            return Err(SourceRefusal::Missing { key });
        }
        let (tids, values) = (tids.into_vec(), values.into_vec());
        if values.len() != tids.len() {
            return Err(SourceRefusal::ExtremityLengthMismatch);
        }
        let mut pairs = exact(tids.len() as u64)?;
        for (t, v) in tids.into_iter().zip(values) {
            // The stored value, as the engine wrote it; never recomputed.
            let e = Extremity::new(v).map_err(library(key))?;
            if !pairs.put((tid(t, Key::Tids)?, e)) {
                return Err(room());
            }
        }
        let pairs = pairs.into_vec();
        let n = pairs.len();
        let frame = ExtremityFrame::new(self.source.clone(), pairs).map_err(library(Key::Tids))?;
        Ok((frame, n))
    }

    fn meta_ids(&self) -> Result<Vec<CommentId>, SourceRefusal> {
        let key = Key::MetaTids;
        let text = need(&self.raw.meta_tids, key)?;
        let mut ids = exact::<i64>(self.tally.meta)?;
        let read_ids = read(text, decode::Seq(&mut ids));
        decoded(read_ids, ids.over(), key)?;
        let ids = ids.into_vec();
        let mut out = exact(ids.len() as u64)?;
        for v in ids {
            if !out.put(tid(v, key)?) {
                return Err(room());
            }
        }
        Ok(out.into_vec())
    }

    /// The group frame, with its lengths and distinct counts. The cells are
    /// sorted in place by (comment, group) before the frame is made, which
    /// allocates nothing (`sort_unstable`), so the distinct comments, and
    /// their union with the extremity frame's ids (ascending, as its map
    /// keeps them), are counted in one pass. The frame's checks are per
    /// group or per cell, so the order changes no frame and no acceptance;
    /// for a source with two faults it can change which is named first.
    fn groups(
        &self,
        extremity: Option<&ExtremityFrame>,
    ) -> Result<(CurrentGroupFrame, FrameCounts), SourceRefusal> {
        let key = Key::GroupVotes;
        let text = need(&self.raw.group_votes, key)?;
        let mut groups = exact(self.tally.groups)?;
        let mut cells = exact(self.tally.cells)?;
        let mut fault = None;
        let read_groups = read(
            text,
            decode::GroupVotesInto {
                groups: &mut groups,
                cells: &mut cells,
                fault: &mut fault,
            },
        );
        decoded(read_groups, groups.over() || cells.over(), key)?;
        let (groups, mut cells) = (groups.into_vec(), cells.into_vec());
        self.memberships(&groups)?;
        if let Some(r) = fault {
            return Err(library(key)(r));
        }
        cells.sort_unstable_by_key(|&(group, comment, _)| (comment, group));
        let (distinct, union) = distinct_and_union(&cells, extremity);
        let counts = FrameCounts {
            groups: groups.len() as u64,
            cells: cells.len() as u64,
            distinct,
            union,
            ..FrameCounts::default()
        };
        let members = groups.iter().map(|&(id, n)| (GroupId::new(id), n));
        let frame = CurrentGroupFrame::new(self.source.clone(), members, cells, None)
            .map_err(library(key))?;
        Ok((frame, counts))
    }

    /// The membership check: `group-clusters` members are base-cluster ids,
    /// joined to `base-clusters` to count each group's participants, which
    /// must be the group's `n-members`. Nothing about any participant is
    /// kept: the first policy makes every participant's group unknown.
    fn memberships(&self, groups: &[(u32, u32)]) -> Result<(), SourceRefusal> {
        let gk = Key::GroupClusters;
        let bk = Key::BaseClusters;
        let clusters: Vec<decode::Object<decode::GroupCluster>> =
            serde_json::from_str(need(&self.raw.clusters, gk)?).map_err(malformed(gk))?;
        let decode::Object(base): decode::Object<decode::BaseClusters> =
            serde_json::from_str(need(&self.raw.base_clusters, bk)?).map_err(malformed(bk))?;
        if base.id.len() != base.members.len() {
            return Err(SourceRefusal::Malformed { key: bk });
        }
        // base-cluster id -> (its participants, the group that names it)
        let mut bases: BTreeMap<u32, (u64, Option<u32>)> = BTreeMap::new();
        for (id, members) in base.id.iter().zip(&base.members) {
            let n = members.len() as u64;
            if bases.insert(*id, (n, None)).is_some() {
                return Err(SourceRefusal::Malformed { key: bk });
            }
        }
        let mut participants: BTreeMap<u32, u64> = BTreeMap::new();
        for decode::Object(g) in &clusters {
            let mut sum = 0u64;
            for b in &g.members {
                let entry = bases.get_mut(b).ok_or(SourceRefusal::UnknownBaseCluster)?;
                if entry.1.is_some() {
                    return Err(SourceRefusal::BaseClusterInTwoGroups);
                }
                entry.1 = Some(g.id);
                sum = sum
                    .checked_add(entry.0)
                    .ok_or(SourceRefusal::CountOverflow)?;
            }
            if participants.insert(g.id, sum).is_some() {
                return Err(SourceRefusal::Malformed { key: gk });
            }
        }
        for &(id, members) in groups {
            match participants.get(&id) {
                Some(&n) if n == u64::from(members) => {}
                _ => return Err(SourceRefusal::MembersMismatch),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source() -> Vec<u8> {
        let cell = json!({"A": 2, "D": 1, "S": 4});
        let votes = json!({"10": cell, "20": cell, "30": cell});
        let value = json!({
            "tids": [10, 20, 30],
            "pca": {"comment-extremity": [0.5, 1.0, 1.5]},
            "meta-tids": [20, 40],
            "comment-priorities": {"10": 1.5, "20": null, "30": false},
            "group-votes": {
                "0": {"id": 0, "n-members": 5, "votes": votes},
                "1": {"id": 1, "n-members": 6, "votes": votes}
            },
            "group-clusters": [
                {"id": 0, "members": [100]},
                {"id": 1, "members": [101]}
            ],
            "base-clusters": {
                "id": [100, 101],
                "members": [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]]
            }
        });
        serde_json::to_vec(&value).unwrap()
    }

    fn parsed() -> Projection {
        let row = RowIdentity {
            zid: 7,
            math_env: "example".into(),
            math_tick: 41,
            last_vote_timestamp: Some(1_700_000_000_000),
            db_now_ms: 1_700_000_100_000,
        };
        Projection::parse(&source(), row, &SourceLimits::default()).unwrap()
    }

    /// A decode that meets one element more than the walk counted, which
    /// would have grown its vector, refuses with the closed reason instead,
    /// for every counted key the decode fills a vector from; with the
    /// walk's own counts, it succeeds.
    #[test]
    fn decode_past_its_count_refuses() {
        let p = parsed();
        assert_eq!(p.tally.tids, 3);
        assert_eq!(p.tally.cells, 6);
        assert!(p.frames(FrameNeeds::all()).is_ok());
        type Slot = fn(&mut Tally) -> &mut u64;
        let slots: [(&str, Slot); 6] = [
            ("tids", |t| &mut t.tids),
            ("extremity", |t| &mut t.extremity),
            ("meta", |t| &mut t.meta),
            ("priorities", |t| &mut t.priorities),
            ("groups", |t| &mut t.groups),
            ("cells", |t| &mut t.cells),
        ];
        for (name, slot) in slots {
            let mut short = parsed();
            *slot(&mut short.tally) -= 1;
            assert_eq!(
                short.frames(FrameNeeds::all()).err(),
                Some(room()),
                "{name} one below its count"
            );
            // One more than counted is room to spare: never refused for it.
            let mut long = parsed();
            *slot(&mut long.tally) += 1;
            assert!(long.frames(FrameNeeds::all()).is_ok(), "{name} one above");
        }
    }

    /// The vector that would hold more than it was given never grows: put
    /// refuses at its room, and the room is exactly what was asked.
    #[test]
    fn exact_vector_refuses_past_its_room() {
        let mut v = decode::Exact::<u64>::new(2).unwrap();
        assert!(v.put(1) && v.put(2));
        assert!(!v.over());
        assert!(!v.put(3));
        assert!(v.over());
        let v = v.into_vec();
        assert_eq!((v.len(), v.capacity()), (2, 2));
        let none = decode::Exact::<u64>::new(0).unwrap().into_vec();
        assert_eq!(none.capacity(), 0);
        // Room the allocator cannot give is refused, not panicked on.
        assert!(decode::Exact::<u64>::new(u64::MAX).is_none());
    }
}
