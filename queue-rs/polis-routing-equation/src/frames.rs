//! The current tick's frames that the corrected rules read: each opinion
//! group's counts, everyone's counts, and the importance inputs, with the
//! checks that hold across records.
//!
//! Every count is unsigned and named (agreed, disagreed, passed; marked,
//! eligible); no vote value enters. Group ids may be sparse. Each frame
//! carries a caller-supplied `SourceId`; what the crate cannot prove from
//! counts alone (that group memberships do not overlap, that a source id
//! names its source, that two frames said to be one tick are one tick) is the
//! caller's to certify, and the source ids carry it into every result.

use crate::types::{CommentId, Counts, GroupId, Refusal, SourceId};
use std::collections::{BTreeMap, BTreeSet};

/// The current tick's counts per opinion group.
///
/// Refused at construction: a group given twice or with no members; a cell
/// whose group is not a member group; a cell seen by more of the group than
/// it has members; a (group, comment) cell given twice; members adding up to
/// more than the declared participants, when those are given.
///
/// Defined cases: a frame with no groups at all; a group with members and no
/// cells (none of its members has voted on anything); a group with no cell
/// for a comment (that group has not seen it). An absent cell is not a zero
/// cell: each rule says how it treats the two.
#[derive(Clone, Debug, PartialEq)]
pub struct CurrentGroupFrame {
    source: SourceId,
    participants: Option<u64>,
    members: BTreeMap<GroupId, u32>,
    cells: BTreeMap<GroupId, BTreeMap<CommentId, Counts>>,
}

impl CurrentGroupFrame {
    pub fn new(
        source: SourceId,
        members: impl IntoIterator<Item = (GroupId, u32)>,
        cells: impl IntoIterator<Item = (GroupId, CommentId, Counts)>,
        participants: Option<u64>,
    ) -> Result<Self, Refusal> {
        let mut member_map = BTreeMap::new();
        let mut total = 0u64;
        for (group, n) in members {
            if member_map.contains_key(&group) {
                return Err(Refusal::DuplicateGroup(group));
            }
            if n == 0 {
                return Err(Refusal::EmptyGroup(group));
            }
            total = total
                .checked_add(u64::from(n))
                .ok_or(Refusal::CountOverflow)?;
            member_map.insert(group, n);
        }
        if participants.is_some_and(|p| total > p) {
            return Err(Refusal::MembersAboveParticipants);
        }
        let mut cell_map: BTreeMap<GroupId, BTreeMap<CommentId, Counts>> = BTreeMap::new();
        for (group, comment, counts) in cells {
            let Some(&n) = member_map.get(&group) else {
                return Err(Refusal::UnknownGroup { group, comment });
            };
            if counts.seen() > u64::from(n) {
                return Err(Refusal::SeenAboveMembers { group, comment });
            }
            let row = cell_map.entry(group).or_default();
            if row.contains_key(&comment) {
                return Err(Refusal::DuplicateCell { group, comment });
            }
            row.insert(comment, counts);
        }
        Ok(Self {
            source,
            participants,
            members: member_map,
            cells: cell_map,
        })
    }

    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn participants(&self) -> Option<u64> {
        self.participants
    }
    /// How many groups the frame has (with at least one member each).
    pub fn group_count(&self) -> usize {
        self.members.len()
    }
    /// Every group and its members, in id order.
    pub fn groups(&self) -> impl Iterator<Item = (GroupId, u32)> + '_ {
        self.members.iter().map(|(g, n)| (*g, *n))
    }
    pub fn members(&self, group: GroupId) -> Option<u32> {
        self.members.get(&group).copied()
    }
    /// The sum of every group's members (exact: checked at construction).
    pub fn total_members(&self) -> u64 {
        self.members.values().map(|n| u64::from(*n)).sum()
    }
    pub fn cell(&self, group: GroupId, comment: CommentId) -> Option<Counts> {
        self.cells.get(&group)?.get(&comment).copied()
    }
    /// For one comment, every member group in id order with its cell, `None`
    /// where the group has no cell for it.
    pub fn cells_for(
        &self,
        comment: CommentId,
    ) -> impl Iterator<Item = (GroupId, Option<Counts>)> + '_ {
        self.members
            .keys()
            .map(move |g| (*g, self.cell(*g, comment)))
    }
    /// Every comment that has a cell in some group.
    pub fn comment_ids(&self) -> BTreeSet<CommentId> {
        self.cells
            .values()
            .flat_map(|row| row.keys().copied())
            .collect()
    }
    /// The groups' counts for one comment summed over groups, each field in
    /// `u64` (exact: the seen counts are bounded by the members).
    pub fn summed(&self, comment: CommentId) -> [u64; 3] {
        let mut sum = [0u64; 3];
        for row in self.cells.values() {
            if let Some(c) = row.get(&comment) {
                sum[0] += u64::from(c.agreed());
                sum[1] += u64::from(c.disagreed());
                sum[2] += u64::from(c.passed());
            }
        }
        sum
    }
}

/// Every participant's current latest votes, grouped or not, per comment.
/// Refused: a comment given twice, or seen by more than `participants`.
#[derive(Clone, Debug, PartialEq)]
pub struct EveryoneFrame {
    source: SourceId,
    participants: u64,
    cells: BTreeMap<CommentId, Counts>,
}

impl EveryoneFrame {
    pub fn new(
        source: SourceId,
        participants: u64,
        cells: impl IntoIterator<Item = (CommentId, Counts)>,
    ) -> Result<Self, Refusal> {
        let mut map = BTreeMap::new();
        for (comment, counts) in cells {
            if map.contains_key(&comment) {
                return Err(Refusal::DuplicateComment(comment));
            }
            if counts.seen() > participants {
                return Err(Refusal::SeenAboveParticipants(comment));
            }
            map.insert(comment, counts);
        }
        Ok(Self {
            source,
            participants,
            cells: map,
        })
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn participants(&self) -> u64 {
        self.participants
    }
    /// A comment's counts; a comment nobody has voted on reads as zero
    /// counts, since this frame is everyone's.
    pub fn get(&self, comment: CommentId) -> Counts {
        self.cells.get(&comment).copied().unwrap_or_default()
    }
    pub fn ids(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.cells.keys().copied()
    }
}

/// The current tick's count frames, validated together. Either may be
/// absent. When both are given: the groups' members add up to at most
/// everyone's participants, and for every comment the groups' agreed,
/// disagreed and passed, each summed over groups, are at most everyone's
/// (group members are a subset of all participants), or the pair is refused
/// with `FrameInconsistent` naming the comment and the field. Coverage also
/// holds for non-voters; declared participant totals must agree.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct CurrentFrames {
    groups: Option<CurrentGroupFrame>,
    everyone: Option<EveryoneFrame>,
}

impl CurrentFrames {
    pub fn new(
        groups: Option<CurrentGroupFrame>,
        everyone: Option<EveryoneFrame>,
    ) -> Result<Self, Refusal> {
        if let (Some(g), Some(e)) = (&groups, &everyone) {
            if g.total_members() > e.participants() {
                return Err(Refusal::MembersAboveParticipants);
            }
            if g.participants().is_some_and(|n| n != e.participants()) {
                return Err(Refusal::ParticipantsMismatch);
            }
            let ungrouped = e.participants() - g.total_members();
            let ids: BTreeSet<_> = g.comment_ids().into_iter().chain(e.ids()).collect();
            for &comment in &ids {
                let sum = g.summed(comment);
                let all = e.get(comment);
                let fields = [
                    ("agreed", all.agreed()),
                    ("disagreed", all.disagreed()),
                    ("passed", all.passed()),
                ];
                for (s, (field, a)) in sum.iter().zip(fields) {
                    if *s > u64::from(a) {
                        return Err(Refusal::FrameInconsistent { comment, field });
                    }
                }
            }
            for comment in ids {
                let sum = g.summed(comment);
                let all = e.get(comment);
                // Coverage also applies to non-voters: residual votes must
                // belong to the participants outside the group partition.
                let grouped_seen: u64 = sum.iter().sum();
                if all.seen() - grouped_seen > ungrouped {
                    return Err(Refusal::FrameInconsistent {
                        comment,
                        field: "not_seen",
                    });
                }
            }
        }
        Ok(Self { groups, everyone })
    }
    pub fn groups(&self) -> Option<&CurrentGroupFrame> {
        self.groups.as_ref()
    }
    pub fn everyone(&self) -> Option<&EveryoneFrame> {
        self.everyone.as_ref()
    }
}

/// Importance marks: of `eligible` votes that could carry a mark, `marked`
/// did. Refused unless `marked <= eligible`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marks {
    marked: u64,
    eligible: u64,
}

impl Marks {
    pub fn new(marked: u64, eligible: u64) -> Result<Self, Refusal> {
        if marked > eligible {
            return Err(Refusal::MarksAboveEligible);
        }
        Ok(Self { marked, eligible })
    }
    pub fn marked(self) -> u64 {
        self.marked
    }
    pub fn eligible(self) -> u64 {
        self.eligible
    }
}

/// A frame of marks, keyed by `K` (a comment, or a group and a comment, or
/// nothing for the conversation's totals), with its source and the cohort
/// whose votes were counted (both caller-declared and opaque).
#[derive(Clone, Debug, PartialEq)]
pub struct MarksFrame<K: Ord> {
    source: SourceId,
    cohort: SourceId,
    cells: BTreeMap<K, Marks>,
}

impl<K: Ord + Copy> MarksFrame<K> {
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn cohort(&self) -> &SourceId {
        &self.cohort
    }
    pub fn get(&self, key: K) -> Option<Marks> {
        self.cells.get(&key).copied()
    }
    pub fn iter(&self) -> impl Iterator<Item = (K, Marks)> + '_ {
        self.cells.iter().map(|(k, m)| (*k, *m))
    }
}

/// Marks per comment. A comment given twice is refused.
pub type CommentMarks = MarksFrame<CommentId>;
/// Marks per (group, comment). A cell given twice is refused.
pub type GroupMarks = MarksFrame<(GroupId, CommentId)>;

impl CommentMarks {
    pub fn new(
        source: SourceId,
        cohort: SourceId,
        cells: impl IntoIterator<Item = (CommentId, Marks)>,
    ) -> Result<Self, Refusal> {
        let mut map = BTreeMap::new();
        for (comment, marks) in cells {
            if map.contains_key(&comment) {
                return Err(Refusal::DuplicateComment(comment));
            }
            map.insert(comment, marks);
        }
        Ok(Self {
            source,
            cohort,
            cells: map,
        })
    }
}

impl GroupMarks {
    pub fn new(
        source: SourceId,
        cohort: SourceId,
        cells: impl IntoIterator<Item = (GroupId, CommentId, Marks)>,
    ) -> Result<Self, Refusal> {
        let mut map = BTreeMap::new();
        for (group, comment, marks) in cells {
            if map.contains_key(&(group, comment)) {
                return Err(Refusal::DuplicateCell { group, comment });
            }
            map.insert((group, comment), marks);
        }
        Ok(Self {
            source,
            cohort,
            cells: map,
        })
    }
}

/// The conversation's marks over every comment, with its source and cohort.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkTotals {
    source: SourceId,
    cohort: SourceId,
    totals: Marks,
}

impl MarkTotals {
    pub fn new(source: SourceId, cohort: SourceId, totals: Marks) -> Self {
        Self {
            source,
            cohort,
            totals,
        }
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn cohort(&self) -> &SourceId {
        &self.cohort
    }
    pub fn totals(&self) -> Marks {
        self.totals
    }
}

// A subset must fit both complementary populations, not just its marks.
fn marks_covered(values: impl IntoIterator<Item = Marks>, total: Marks) -> Result<(), Refusal> {
    let (mut marked, mut unmarked) = (0u64, 0u64);
    for m in values {
        marked = marked
            .checked_add(m.marked())
            .ok_or(Refusal::CountOverflow)?;
        unmarked = unmarked
            .checked_add(m.eligible() - m.marked())
            .ok_or(Refusal::CountOverflow)?;
    }
    if marked > total.marked() || unmarked > total.eligible() - total.marked() {
        return Err(Refusal::MarksAboveTotal);
    }
    Ok(())
}

/// The importance-mark inputs, validated together and against the current
/// frames. Any part may be unavailable (`None`), which is never a zero.
///
/// When per-comment marks and totals are both given they come from one frame
/// (equal source and cohort) and the comments' marks add up to at most the
/// total marked, and likewise for eligible-but-unmarked votes. Group marks
/// need the same cohort as other supplied marks, and are covered by available
/// per-comment marks and conversation totals in both categories. They are
/// accepted only with a current group frame of the same source; each cell's
/// group must be one of its member groups, and its eligible votes at most
/// that group's members. Source labels for group and pooled frames may differ;
/// as for count frames, the caller certifies that they describe the same tick.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ImportanceMarks {
    comments: Option<CommentMarks>,
    totals: Option<MarkTotals>,
    groups: Option<GroupMarks>,
}

impl ImportanceMarks {
    pub fn new(
        comments: Option<CommentMarks>,
        totals: Option<MarkTotals>,
        groups: Option<GroupMarks>,
        current: &CurrentFrames,
    ) -> Result<Self, Refusal> {
        if let (Some(c), Some(t)) = (&comments, &totals) {
            if c.source() != t.source() || c.cohort() != t.cohort() {
                return Err(Refusal::MarksSourceMismatch);
            }
            marks_covered(c.iter().map(|(_, m)| m), t.totals())?;
        }
        if let Some(gm) = &groups {
            let Some(frame) = current.groups() else {
                return Err(Refusal::GroupMarksWithoutGroups);
            };
            if frame.source() != gm.source() {
                return Err(Refusal::GroupMarksWithoutGroups);
            }
            if comments.as_ref().is_some_and(|c| c.cohort() != gm.cohort())
                || totals.as_ref().is_some_and(|t| t.cohort() != gm.cohort())
            {
                return Err(Refusal::MarksSourceMismatch);
            }
            if let Some(t) = &totals {
                marks_covered(gm.iter().map(|(_, m)| m), t.totals())?;
            }
            let mut by_comment: BTreeMap<CommentId, Vec<Marks>> = BTreeMap::new();
            for ((group, comment), marks) in gm.iter() {
                let Some(n) = frame.members(group) else {
                    return Err(Refusal::UnknownGroup { group, comment });
                };
                if marks.eligible() > u64::from(n) {
                    return Err(Refusal::MarksAboveMembers { group, comment });
                }
                by_comment.entry(comment).or_default().push(marks);
            }
            if let Some(c) = &comments {
                for (&comment, marks) in &by_comment {
                    // Missing marks are unavailable, not fabricated zeroes.
                    if let Some(all) = c.get(comment) {
                        marks_covered(marks.iter().copied(), all)?;
                    }
                }
            }
            if let Some(t) = &totals {
                // Pooled records cover their groups. For comments without a
                // pooled record, the group records still constrain the same
                // total. Check the union without counting any record twice.
                let pooled = comments.iter().flat_map(|c| c.iter().map(|(_, m)| m));
                let remaining_groups = by_comment
                    .iter()
                    .filter(|(id, _)| comments.as_ref().and_then(|c| c.get(**id)).is_none())
                    .flat_map(|(_, marks)| marks.iter().copied());
                marks_covered(pooled.chain(remaining_groups), t.totals())?;
            }
        }
        Ok(Self {
            comments,
            totals,
            groups,
        })
    }
    pub fn comments(&self) -> Option<&CommentMarks> {
        self.comments.as_ref()
    }
    pub fn totals(&self) -> Option<&MarkTotals> {
        self.totals.as_ref()
    }
    pub fn groups(&self) -> Option<&GroupMarks> {
        self.groups.as_ref()
    }
}

/// One comment's aggregate of the 2019 per-voter weights: how many voters
/// voted on it and the sum of their weights. Every weight is at least 1, so
/// `weight_sum >= voters`; with no voters the sum is 0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoterWeightSum {
    voters: u64,
    weight_sum: f64,
}

impl VoterWeightSum {
    fn checked(voters: u64, weight_sum: f64, at: Option<CommentId>) -> Result<Self, Refusal> {
        // u64 to f64 rounds to nearest; a sum of `voters` weights each >= 1
        // is >= fl(voters) as computed, so the comparison is in f64.
        let ok = weight_sum.is_finite()
            && weight_sum >= voters as f64
            && (voters != 0 || weight_sum == 0.0);
        if !ok {
            return Err(Refusal::InvalidVoterWeight(at));
        }
        // A zero sum is stored as +0, so equal inputs have one form.
        Ok(Self {
            voters,
            weight_sum: weight_sum + 0.0,
        })
    }
    pub fn voters(self) -> u64 {
        self.voters
    }
    pub fn weight_sum(self) -> f64 {
        self.weight_sum
    }
}

/// The 2019 per-voter weights aggregated per comment, with the
/// whole-conversation totals from the same population (every comment, also
/// ones this participant has voted on or cannot see). The conversation mean
/// is never recomputed over a participant's candidates.
///
/// Refused: an invalid aggregate (see `VoterWeightSum`); a comment given
/// twice; per-comment voters adding up to more than the total voters; or
/// per-comment weight sums adding up to more than the total weight sum by
/// more than a relative 2^-40 (the two sums are rounded separately). The
/// residual weight must also cover each omitted voter with at least one;
/// no omitted voters means no residual weight, within the same slack.
#[derive(Clone, Debug, PartialEq)]
pub struct VoterWeightFrame {
    source: SourceId,
    per_comment: BTreeMap<CommentId, VoterWeightSum>,
    totals: VoterWeightSum,
}

impl VoterWeightFrame {
    pub fn new(
        source: SourceId,
        per_comment: impl IntoIterator<Item = (CommentId, u64, f64)>,
        total_voters: u64,
        total_weight_sum: f64,
    ) -> Result<Self, Refusal> {
        let totals = VoterWeightSum::checked(total_voters, total_weight_sum, None)?;
        let mut map = BTreeMap::new();
        let mut voters = 0u64;
        let mut sums = Vec::new();
        for (comment, v, s) in per_comment {
            if map.contains_key(&comment) {
                return Err(Refusal::DuplicateComment(comment));
            }
            let agg = VoterWeightSum::checked(v, s, Some(comment))?;
            voters = voters.checked_add(v).ok_or(Refusal::CountOverflow)?;
            sums.push(s);
            map.insert(comment, agg);
        }
        // Make validation independent of input order and comment ids too.
        sums.sort_by(f64::total_cmp);
        let sum: f64 = sums.into_iter().sum();
        if voters > totals.voters || !sum.is_finite() {
            return Err(Refusal::VoterWeightAboveTotal);
        }
        let remaining = totals.voters - voters;
        let scale = totals.weight_sum.max(sum);
        let slack = scale * TOTAL_SLACK;
        // Every omitted voter contributes at least one. With no omitted
        // voters, no unexplained weight may remain. Compare differences to
        // avoid overflowing a near-MAX total multiplied by (1 + slack).
        if sum - totals.weight_sum > slack
            || (remaining == 0 && totals.weight_sum - sum > slack)
            || (remaining != 0 && (remaining as f64) - (totals.weight_sum - sum) > slack)
        {
            return Err(Refusal::VoterWeightAboveTotal);
        }
        Ok(Self {
            source,
            per_comment: map,
            totals,
        })
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn get(&self, comment: CommentId) -> Option<VoterWeightSum> {
        self.per_comment.get(&comment).copied()
    }
    pub fn totals(&self) -> VoterWeightSum {
        self.totals
    }
}

/// The relative slack allowed between the per-comment weight sums, added up,
/// and the separately rounded total: 2^-40.
pub const TOTAL_SLACK: f64 = 1.0 / (1u64 << 40) as f64;
