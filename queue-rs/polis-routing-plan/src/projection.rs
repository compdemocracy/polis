//! One stored math result's projection, checked, and the frames read from it.

use crate::decode;
use crate::identity::{ContentId, RowIdentity, source_id};
use crate::limits::{Limit, SourceLimits};
use crate::refusal::{Key, SourceRefusal};
use crate::reserve::{parse_reservation, reservation};
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
/// every present frame carries `source`.
#[derive(Clone, Debug, PartialEq)]
pub struct Frames {
    extremity: Option<ExtremityFrame>,
    groups: Option<CurrentGroupFrame>,
    meta: Option<MetaComments>,
    stored: Option<StoredWeights>,
    source: SourceId,
}

impl Frames {
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

fn tid(v: i64, key: Key) -> Result<CommentId, SourceRefusal> {
    CommentId::try_from(v).map_err(|_| SourceRefusal::Malformed { key })
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
        if reservation(&t, FrameNeeds::all()).is_none() {
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
        (text as u64)
            .saturating_add(self.row.math_env.capacity() as u64)
            .saturating_add(256)
    }

    /// An upper bound, in bytes, on what `frames(needs)` allocates, from the
    /// walk's counts alone.
    pub fn reservation(&self, needs: FrameNeeds) -> Result<u64, SourceRefusal> {
        reservation(&self.tally, needs).ok_or(SourceRefusal::TooLarge {
            what: Limit::Reservation,
        })
    }

    /// Reads the frames the rule needs, and only those.
    pub fn frames(&self, needs: FrameNeeds) -> Result<Frames, SourceRefusal> {
        let stored = if needs.stored_weights {
            self.stored()?
        } else {
            None
        };
        let extremity = if needs.extremity {
            Some(self.extremity()?)
        } else {
            None
        };
        let meta = if needs.meta {
            let ids = self.meta_ids()?;
            Some(MetaComments::new(ids.iter().copied()).map_err(library(Key::MetaTids))?)
        } else {
            None
        };
        let groups = if needs.groups {
            Some(self.groups()?)
        } else {
            None
        };
        Ok(Frames {
            extremity,
            groups,
            meta,
            stored,
            source: self.source.clone(),
        })
    }

    fn stored(&self) -> Result<Option<StoredWeights>, SourceRefusal> {
        let key = Key::CommentPriorities;
        let Some(raw) = self.raw.priorities.as_deref() else {
            return Ok(None);
        };
        let text = raw.get();
        if text.trim_start().starts_with('[') {
            return Err(SourceRefusal::ArrayPriorities);
        }
        let decode::Priorities(entries) = serde_json::from_str(text).map_err(malformed(key))?;
        let entries = entries.into_iter().map(|(tid, w)| (CommentId::new(tid), w));
        StoredWeights::new(self.source.clone(), entries)
            .map(Some)
            .map_err(library(key))
    }

    fn extremity(&self) -> Result<ExtremityFrame, SourceRefusal> {
        let tids: Vec<i64> =
            serde_json::from_str(need(&self.raw.tids, Key::Tids)?).map_err(malformed(Key::Tids))?;
        let key = Key::CommentExtremity;
        let decode::Object(pca): decode::Object<decode::Pca> =
            serde_json::from_str(need(&self.raw.pca, key)?).map_err(malformed(key))?;
        let values = pca.extremity.ok_or(SourceRefusal::Missing { key })?;
        if values.len() != tids.len() {
            return Err(SourceRefusal::ExtremityLengthMismatch);
        }
        let mut pairs = Vec::with_capacity(tids.len());
        for (t, v) in tids.into_iter().zip(values) {
            // The stored value, as the engine wrote it; never recomputed.
            let e = Extremity::new(v).map_err(library(key))?;
            pairs.push((tid(t, Key::Tids)?, e));
        }
        ExtremityFrame::new(self.source.clone(), pairs).map_err(library(Key::Tids))
    }

    fn meta_ids(&self) -> Result<Vec<CommentId>, SourceRefusal> {
        let key = Key::MetaTids;
        let ids: Vec<i64> =
            serde_json::from_str(need(&self.raw.meta_tids, key)?).map_err(malformed(key))?;
        let mut out = Vec::with_capacity(ids.len());
        for v in ids {
            out.push(tid(v, key)?);
        }
        Ok(out)
    }

    fn groups(&self) -> Result<CurrentGroupFrame, SourceRefusal> {
        let key = Key::GroupVotes;
        let decode::GroupVotes(groups) =
            serde_json::from_str(need(&self.raw.group_votes, key)?).map_err(malformed(key))?;
        self.memberships(&groups)?;
        let total: usize = groups.iter().map(|g| g.body.votes.0.len()).sum();
        let mut cells = Vec::with_capacity(total);
        for g in &groups {
            for c in &g.body.votes.0 {
                let counts = Counts::from_seen(c.counts.agreed, c.counts.disagreed, c.counts.seen)
                    .map_err(library(key))?;
                cells.push((GroupId::new(g.id), CommentId::new(c.tid), counts));
            }
        }
        let members = groups.iter().map(|g| (GroupId::new(g.id), g.body.members));
        CurrentGroupFrame::new(self.source.clone(), members, cells, None).map_err(library(key))
    }

    /// The membership check: `group-clusters` members are base-cluster ids,
    /// joined to `base-clusters` to count each group's participants, which
    /// must be the group's `n-members`. Nothing about any participant is
    /// kept: the first policy makes every participant's group unknown.
    fn memberships(&self, groups: &[decode::Group]) -> Result<(), SourceRefusal> {
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
        for g in groups {
            match participants.get(&g.id) {
                Some(&n) if n == u64::from(g.body.members) => {}
                _ => return Err(SourceRefusal::MembersMismatch),
            }
        }
        Ok(())
    }
}
