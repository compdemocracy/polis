//! The corrected rules: candidates for the next equation, none of them chosen.
//!
//! - `symmetric/1`: today's equation with agree and disagree weighed alike in
//!   the count term.
//! - `gic-mean/1` and `gic-geomean/1`: the group-informed consensus factor in
//!   two forms, read from the current tick's opinion groups.
//! - `symmetric-gic/1`: `symmetric/1` times that factor.
//! - `symmetric/2` and `symmetric-gic/2`: the same two formulas on the counts
//!   of the math update being read (`base-counts:lag-0`), summed from its
//!   group frame; the `/1` rules read the update before it
//!   (`base-counts:lag-1`).
//!
//! Each is a pure function of validated frames. Group values are reduced in
//! sorted order, so the order in which groups arrive, and their ids, cannot
//! change a bit of the result.

use crate::frames::CurrentGroupFrame;
use crate::historical::{HistoricalWeights, MetaComments, Scored};
use crate::importance::TermParams;
use crate::latest::{CountPolicy, LatestCountFrame};
use crate::registry::ParamSet;
use crate::types::{
    CommentId, Counts, Explanation, Extremity, ExtremityFrame, Factor, FactorName,
    HistoricalCountFrame, ParamError, Refusal, SourceId, Weight,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn within(
    name: &'static str,
    value: f64,
    lo: f64,
    hi: f64,
    allowed: &'static str,
) -> Result<(), ParamError> {
    if value.is_finite() && value >= lo && value <= hi {
        Ok(())
    } else {
        Err(ParamError {
            name,
            value: format!("{value:?}"),
            allowed,
        })
    }
}

/// What a corrected rule does with a meta comment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaPolicy {
    /// A scored meta comment weighs `meta_inner ^ exponent` (49 at the
    /// defaults), outside every other factor: today's behaviour.
    Fixed,
    /// A meta comment is scored like any other comment.
    Ordinary,
    /// A meta comment gets no weight and is listed as excluded; a draw must
    /// not be given it as a candidate.
    Exclude,
}

impl MetaPolicy {
    pub fn name(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Ordinary => "ordinary",
            Self::Exclude => "exclude",
        }
    }
    pub fn from_name(name: &str) -> Option<Self> {
        [Self::Fixed, Self::Ordinary, Self::Exclude]
            .into_iter()
            .find(|m| m.name() == name)
    }
}

/// The parameters of `symmetric/1`: those of `historical/1`, with one
/// `side_prior` in place of the agree and pass priors, and the meta policy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SymmetricParams {
    side_prior: f64,
    seen_prior: f64,
    extremity_offset: f64,
    novelty_amplitude: f64,
    novelty_halving_votes: f64,
    exponent: u8,
    meta_inner: f64,
    meta_policy: MetaPolicy,
}

impl Default for SymmetricParams {
    fn default() -> Self {
        Self {
            side_prior: 1.0,
            seen_prior: 2.0,
            extremity_offset: 1.0,
            novelty_amplitude: 8.0,
            novelty_halving_votes: 5.0,
            exponent: 2,
            meta_inner: 7.0,
            meta_policy: MetaPolicy::Fixed,
        }
    }
}

impl SymmetricParams {
    /// Validates every range and the coupled one, `side_prior <= seen_prior`,
    /// on which the side share is in (0, 1].
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        side_prior: f64,
        seen_prior: f64,
        extremity_offset: f64,
        novelty_amplitude: f64,
        novelty_halving_votes: f64,
        exponent: u8,
        meta_inner: f64,
        meta_policy: MetaPolicy,
    ) -> Result<Self, ParamError> {
        const SIDE: &str = "[1e-3, 1000], and seen_prior - side_prior >= 0";
        within("side_prior", side_prior, 1e-3, 1000.0, SIDE)?;
        within("seen_prior", seen_prior, 1e-3, 1000.0, "[1e-3, 1000]")?;
        within(
            "extremity_offset",
            extremity_offset,
            1e-3,
            100.0,
            "[1e-3, 100]",
        )?;
        within(
            "novelty_amplitude",
            novelty_amplitude,
            0.0,
            1000.0,
            "[0, 1000]",
        )?;
        within(
            "novelty_halving_votes",
            novelty_halving_votes,
            1e-3,
            1e6,
            "[1e-3, 1e6]",
        )?;
        within("meta_inner", meta_inner, 1e-3, 1e6, "[1e-3, 1e6]")?;
        if !(1..=4).contains(&exponent) {
            return Err(ParamError {
                name: "exponent",
                value: exponent.to_string(),
                allowed: "an integer from 1 to 4",
            });
        }
        if seen_prior - side_prior < 0.0 {
            return Err(ParamError {
                name: "side_prior",
                value: format!("{side_prior:?}"),
                allowed: SIDE,
            });
        }
        Ok(Self {
            side_prior,
            seen_prior,
            extremity_offset,
            // One representation of zero, as in `historical/1`.
            novelty_amplitude: if novelty_amplitude == 0.0 {
                0.0
            } else {
                novelty_amplitude
            },
            novelty_halving_votes,
            exponent,
            meta_inner,
            meta_policy,
        })
    }

    pub fn side_prior(&self) -> f64 {
        self.side_prior
    }
    pub fn seen_prior(&self) -> f64 {
        self.seen_prior
    }
    pub fn extremity_offset(&self) -> f64 {
        self.extremity_offset
    }
    pub fn novelty_amplitude(&self) -> f64 {
        self.novelty_amplitude
    }
    pub fn novelty_halving_votes(&self) -> f64 {
        self.novelty_halving_votes
    }
    pub fn exponent(&self) -> u8 {
        self.exponent
    }
    pub fn meta_inner(&self) -> f64 {
        self.meta_inner
    }
    pub fn meta_policy(&self) -> MetaPolicy {
        self.meta_policy
    }

    /// `(R * R * (E + offset) * novelty) ^ exponent`, with
    /// `R = (A + D + side_prior) / (S + seen_prior)`, in that order.
    fn ordinary(&self, counts: Counts, extremity: Extremity, outer: Vec<Factor>) -> Explanation {
        // Exact: a seen count is at most 3 x (2^32 - 1), far below 2^53, and
        // so is agreed + disagreed.
        let seen = counts.seen() as f64;
        let sides = f64::from(counts.agreed()) + f64::from(counts.disagreed());
        let r = (sides + self.side_prior) / (seen + self.seen_prior);
        let boost = extremity.get() + self.extremity_offset;
        let novelty = 1.0 + self.novelty_amplitude * 2f64.powf(-seen / self.novelty_halving_votes);
        Explanation::new(
            vec![
                Factor::new(FactorName::SideShare, r),
                Factor::new(FactorName::SideShare, r),
                Factor::new(FactorName::ExtremityBoost, boost),
                Factor::new(FactorName::Novelty, novelty),
            ],
            self.exponent,
            outer,
        )
    }

    fn meta(&self) -> Explanation {
        Explanation::new(
            vec![Factor::new(FactorName::Meta, self.meta_inner)],
            self.exponent,
            vec![],
        )
    }
}

/// Which form of the group-informed consensus factor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsensusForm {
    /// `gic-mean/1`: the report's form.
    GicMean1,
    /// `gic-geomean/1`: the geometric mean, passes included.
    GicGeomean1,
}

impl ConsensusForm {
    pub fn name(self) -> &'static str {
        match self {
            Self::GicMean1 => "gic-mean/1",
            Self::GicGeomean1 => "gic-geomean/1",
        }
    }
    pub fn from_name(name: &str) -> Option<Self> {
        [Self::GicMean1, Self::GicGeomean1]
            .into_iter()
            .find(|f| f.name() == name)
    }
}

/// The parameters of the group-informed consensus factor (both forms).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GicParams {
    offset: f64,
    min_groups: u8,
}

impl Default for GicParams {
    fn default() -> Self {
        Self {
            offset: 0.5,
            min_groups: 2,
        }
    }
}

impl GicParams {
    /// `gic_offset` in [1e-3, 100] (the factor is then always positive) and
    /// `gic_min_groups` an integer from 1 to 64.
    pub fn new(offset: f64, min_groups: u8) -> Result<Self, ParamError> {
        within("gic_offset", offset, 1e-3, 100.0, "[1e-3, 100]")?;
        if !(1..=64).contains(&min_groups) {
            return Err(ParamError {
                name: "gic_min_groups",
                value: min_groups.to_string(),
                allowed: "an integer from 1 to 64",
            });
        }
        Ok(Self { offset, min_groups })
    }
    pub fn offset(&self) -> f64 {
        self.offset
    }
    pub fn min_groups(&self) -> u8 {
        self.min_groups
    }
}

/// The factor for one comment: G (absent when too few groups exist for it to
/// apply) and the multiplier, `gic_offset + G`, or exactly 1 when it does
/// not apply.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Consensus {
    g: Option<f64>,
    factor: f64,
}

impl Consensus {
    pub fn g(self) -> Option<f64> {
        self.g
    }
    pub fn factor(self) -> f64 {
        self.factor
    }
}

/// Sums in ascending `total_cmp` order, so the result does not depend on the
/// order the values arrived in.
fn sorted_sum(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values.into_iter().fold(0.0, |s, v| s + v)
}

/// G for one comment under the given form, over the frame's member groups.
/// `None` when the frame has fewer than `gic_min_groups` groups.
pub fn consensus(
    form: ConsensusForm,
    params: &GicParams,
    groups: &CurrentGroupFrame,
    comment: CommentId,
) -> Consensus {
    if groups.group_count() < usize::from(params.min_groups) {
        return Consensus {
            g: None,
            factor: 1.0,
        };
    }
    let g = match form {
        ConsensusForm::GicMean1 => {
            // Only groups that have a cell; passes and members do not enter.
            let values: Vec<f64> = groups
                .cells_for(comment)
                .filter_map(|(_, cell)| cell)
                .map(|c| {
                    let a = f64::from(c.agreed());
                    (a + 1.0) / (a + f64::from(c.disagreed()) + 2.0)
                })
                .collect();
            if values.is_empty() {
                0.5
            } else {
                let n = values.len() as f64;
                sorted_sum(values) / n
            }
        }
        ConsensusForm::GicGeomean1 => {
            // Every member group; a group with no cell counts as no votes.
            let logs: Vec<f64> = groups
                .cells_for(comment)
                .map(|(_, cell)| {
                    let c = cell.unwrap_or_default();
                    ((f64::from(c.agreed()) + 1.0) / (c.seen() as f64 + 2.0)).ln()
                })
                .collect();
            let n = logs.len() as f64;
            (sorted_sum(logs) / n).exp()
        }
    };
    Consensus {
        g: Some(g),
        factor: params.offset + g,
    }
}

/// The parameters of `symmetric-gic/1`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SymmetricGicParams {
    base: SymmetricParams,
    form: ConsensusForm,
    gic: GicParams,
}

impl Default for SymmetricGicParams {
    fn default() -> Self {
        Self {
            base: SymmetricParams::default(),
            form: ConsensusForm::GicGeomean1,
            gic: GicParams::default(),
        }
    }
}

impl SymmetricGicParams {
    pub fn new(base: SymmetricParams, form: ConsensusForm, gic: GicParams) -> Self {
        Self { base, form, gic }
    }
    pub fn base(&self) -> &SymmetricParams {
        &self.base
    }
    pub fn form(&self) -> ConsensusForm {
        self.form
    }
    pub fn gic(&self) -> &GicParams {
        &self.gic
    }
}

/// Which counts a corrected rule's base count term read, and their source.
/// Set only by the function that computed the weights: a `/1` rule (and
/// `historical/1`) writes `Previous`, a `/2` rule writes `Latest`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BaseCounts {
    /// Summed over the opinion groups of the update before the one read
    /// (`base-counts:lag-1`).
    Previous(SourceId),
    /// Summed over the opinion groups of the update read
    /// (`base-counts:lag-0`); its source is the group frame's.
    Latest(SourceId),
}

impl BaseCounts {
    /// The policy these counts were read under.
    pub fn policy(&self) -> CountPolicy {
        match self {
            Self::Previous(_) => CountPolicy::Lag1,
            Self::Latest(_) => CountPolicy::Lag0,
        }
    }
    /// The source of the counts, whichever update they came from.
    pub fn source(&self) -> &SourceId {
        match self {
            Self::Previous(s) | Self::Latest(s) => s,
        }
    }
}

/// What a corrected rule gives for a conversation: the exact parameter set,
/// the sources it read, a weight and explanation per scored comment, the
/// comments it did not score, and the meta comments it excluded.
#[derive(Clone, Debug, PartialEq)]
pub struct CorrectedWeights {
    params: ParamSet,
    base_counts: BaseCounts,
    current_extremity: SourceId,
    current_groups: Option<SourceId>,
    scored: BTreeMap<CommentId, Scored>,
    unscored: BTreeSet<CommentId>,
    excluded: BTreeSet<CommentId>,
    terms: Vec<TermParams>,
    term_source: Option<SourceId>,
}

impl CorrectedWeights {
    /// `historical/1`'s weights in this form, so that a term can be composed
    /// with today's equation too. Nothing about them changes.
    pub fn from_historical(weights: &HistoricalWeights) -> Self {
        Self {
            params: ParamSet::Historical1(*weights.params()),
            base_counts: BaseCounts::Previous(weights.counts_source().clone()),
            current_extremity: weights.extremity_source().clone(),
            current_groups: None,
            scored: weights.scored().map(|(id, s)| (id, s.clone())).collect(),
            unscored: weights.unscored().collect(),
            excluded: BTreeSet::new(),
            terms: vec![],
            term_source: None,
        }
    }
    /// The terms composed with the base rule, in order (at most one today).
    pub fn terms(&self) -> &[TermParams] {
        &self.terms
    }
    /// The source of the terms' input frame.
    pub fn term_source(&self) -> Option<&SourceId> {
        self.term_source.as_ref()
    }
    pub(crate) fn with_term(
        mut self,
        term: TermParams,
        source: SourceId,
        rescored: Vec<(CommentId, Scored)>,
    ) -> Self {
        for (id, s) in rescored {
            self.scored.insert(id, s);
        }
        self.terms.push(term);
        self.term_source = Some(source);
        self
    }
    pub fn params(&self) -> &ParamSet {
        &self.params
    }
    /// The source of the counts the base count term read. Its name is the
    /// `/1` rules'; for a `/2` rule's weights it is the source of the latest
    /// counts. `base_counts()` says which policy they were read under.
    pub fn previous_counts(&self) -> &SourceId {
        self.base_counts.source()
    }
    /// The counts the base count term read, with their policy.
    pub fn base_counts(&self) -> &BaseCounts {
        &self.base_counts
    }
    /// The source of the latest counts, for a `/2` rule's weights only.
    pub fn latest_counts(&self) -> Option<&SourceId> {
        match &self.base_counts {
            BaseCounts::Latest(s) => Some(s),
            BaseCounts::Previous(_) => None,
        }
    }
    pub fn current_extremity(&self) -> &SourceId {
        &self.current_extremity
    }
    pub fn current_groups(&self) -> Option<&SourceId> {
        self.current_groups.as_ref()
    }
    pub fn get(&self, id: CommentId) -> Option<&Scored> {
        self.scored.get(&id)
    }
    pub fn scored(&self) -> impl Iterator<Item = (CommentId, &Scored)> + '_ {
        self.scored.iter().map(|(id, s)| (*id, s))
    }
    /// Comments in only one of the previous-count and extremity frames.
    pub fn unscored(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.unscored.iter().copied()
    }
    /// All declared meta comments under `meta_policy = exclude`, whether
    /// scoring inputs exist or not.
    pub fn excluded(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.excluded.iter().copied()
    }
    /// The scored comments, as the ordered map a draw looks each candidate up
    /// in (one lookup of O(log n) per candidate).
    pub(crate) fn scored_map(&self) -> &BTreeMap<CommentId, Scored> {
        &self.scored
    }
    /// The unscored comments, as the ordered set a draw looks them up in.
    pub(crate) fn unscored_set(&self) -> &BTreeSet<CommentId> {
        &self.unscored
    }
    /// The excluded comments, as the ordered set a draw looks them up in.
    pub(crate) fn excluded_set(&self) -> &BTreeSet<CommentId> {
        &self.excluded
    }
    /// Weights made directly from their parts, for the crate's own tests of
    /// the draw: a weight per scored comment, the unscored and the excluded
    /// comments. Each scored comment's explanation is a single factor
    /// holding its weight (the draw reads only the weight).
    #[cfg(test)]
    pub(crate) fn constructed(
        params: ParamSet,
        sources: [SourceId; 3],
        scored: impl IntoIterator<Item = (CommentId, Weight)>,
        unscored: impl IntoIterator<Item = CommentId>,
        excluded: impl IntoIterator<Item = CommentId>,
    ) -> Self {
        let [previous_counts, current_extremity, current_groups] = sources;
        let base_counts = match params.rule().count_policy() {
            Some(CountPolicy::Lag0) => BaseCounts::Latest(previous_counts),
            _ => BaseCounts::Previous(previous_counts),
        };
        Self {
            params,
            base_counts,
            current_extremity,
            current_groups: Some(current_groups),
            scored: scored
                .into_iter()
                .map(|(id, w)| {
                    let factor = Factor::new(FactorName::AgreeShare, w.get());
                    (
                        id,
                        Scored::new(w, Explanation::new(vec![factor], 1, vec![])),
                    )
                })
                .collect(),
            unscored: unscored.into_iter().collect(),
            excluded: excluded.into_iter().collect(),
            terms: vec![],
            term_source: None,
        }
    }
}

/// Scored, unscored and excluded comments.
type Weighed = (
    BTreeMap<CommentId, Scored>,
    BTreeSet<CommentId>,
    BTreeSet<CommentId>,
);

/// The base counts a weighing reads, under either policy. Private, so that
/// latest counts are never put into a `HistoricalCountFrame`.
trait CountLookup {
    fn ids(&self) -> impl Iterator<Item = CommentId> + '_;
    fn get(&self, id: CommentId) -> Option<Counts>;
}

impl CountLookup for HistoricalCountFrame {
    fn ids(&self) -> impl Iterator<Item = CommentId> + '_ {
        HistoricalCountFrame::ids(self)
    }
    fn get(&self, id: CommentId) -> Option<Counts> {
        HistoricalCountFrame::get(self, id)
    }
}

impl CountLookup for LatestCountFrame {
    fn ids(&self) -> impl Iterator<Item = CommentId> + '_ {
        LatestCountFrame::ids(self)
    }
    fn get(&self, id: CommentId) -> Option<Counts> {
        LatestCountFrame::get(self, id)
    }
}

fn weigh(
    base: &SymmetricParams,
    counts: &impl CountLookup,
    extremity: &ExtremityFrame,
    meta: &MetaComments,
    mut outer: impl FnMut(CommentId) -> Vec<Factor>,
) -> Result<Weighed, Refusal> {
    let mut scored = BTreeMap::new();
    let mut unscored = BTreeSet::new();
    let excluded: BTreeSet<_> = if base.meta_policy == MetaPolicy::Exclude {
        meta.ids().collect()
    } else {
        BTreeSet::new()
    };
    let ids: BTreeSet<CommentId> = counts.ids().chain(extremity.ids()).collect();
    for id in ids {
        if excluded.contains(&id) {
            continue;
        }
        let (Some(c), Some(e)) = (counts.get(id), extremity.get(id)) else {
            unscored.insert(id);
            continue;
        };
        let explanation = match (meta.contains(id), base.meta_policy) {
            (true, MetaPolicy::Fixed) => base.meta(),
            (true, MetaPolicy::Exclude) => {
                continue;
            }
            (true, MetaPolicy::Ordinary) | (false, _) => base.ordinary(c, e, outer(id)),
        };
        let value = explanation
            .evaluate_checked()
            .map_err(|(_, term)| Refusal::WeightOutOfRange { comment: id, term })?;
        let weight = Weight::checked(value).ok_or(Refusal::WeightOutOfRange {
            comment: id,
            term: "power",
        })?;
        scored.insert(id, Scored::new(weight, explanation));
    }
    Ok((scored, unscored, excluded))
}

/// `symmetric/1` over a conversation. Its decision table is `historical/1`'s:
/// exclusion is applied first; otherwise a comment absent from either frame
/// gets no weight (unscored); a scored
/// meta comment follows `meta_policy`; every other scored comment gets the
/// formula. A weight that would leave `[0, 1e150]` is `WeightOutOfRange`.
pub fn symmetric_1(
    params: &SymmetricParams,
    counts: &HistoricalCountFrame,
    extremity: &ExtremityFrame,
    meta: &MetaComments,
) -> Result<CorrectedWeights, Refusal> {
    let (scored, unscored, excluded) = weigh(params, counts, extremity, meta, |_| vec![])?;
    Ok(CorrectedWeights {
        params: ParamSet::Symmetric1(*params),
        base_counts: BaseCounts::Previous(counts.source().clone()),
        current_extremity: extremity.source().clone(),
        current_groups: None,
        scored,
        unscored,
        excluded,
        terms: vec![],
        term_source: None,
    })
}

/// `symmetric-gic/1`: `symmetric/1`'s weight times the group-informed
/// consensus factor, read from the current tick's groups. An unscored comment
/// stays unscored (a draw gives it 1, not multiplied by the factor); a fixed
/// meta comment is not multiplied either.
pub fn symmetric_gic_1(
    params: &SymmetricGicParams,
    counts: &HistoricalCountFrame,
    extremity: &ExtremityFrame,
    groups: &CurrentGroupFrame,
    meta: &MetaComments,
) -> Result<CorrectedWeights, Refusal> {
    let (scored, unscored, excluded) = weigh(&params.base, counts, extremity, meta, |id| {
        let c = consensus(params.form, &params.gic, groups, id);
        vec![Factor::new(FactorName::GroupConsensus, c.factor)]
    })?;
    Ok(CorrectedWeights {
        params: ParamSet::SymmetricGic1(*params),
        base_counts: BaseCounts::Previous(counts.source().clone()),
        current_extremity: extremity.source().clone(),
        current_groups: Some(groups.source().clone()),
        scored,
        unscored,
        excluded,
        terms: vec![],
        term_source: None,
    })
}

/// The latest counts of one update: refused (`PolicySourceMismatch`) unless
/// the group frame and the extremity frame name the same source, then built
/// from the group frame (`NoLatestCounts`, `CountOverflow`), in that order.
fn latest_counts(
    groups: &CurrentGroupFrame,
    extremity: &ExtremityFrame,
) -> Result<LatestCountFrame, Refusal> {
    if groups.source() != extremity.source() {
        return Err(Refusal::PolicySourceMismatch {
            policy: CountPolicy::Lag0,
            counts: groups.source().clone(),
            extremity: extremity.source().clone(),
        });
    }
    LatestCountFrame::from_groups(groups)
}

/// `symmetric/2`: `symmetric/1`'s formula, parameters and decision table on
/// `base-counts:lag-0`, the counts of the update being read, summed over its
/// opinion groups. The group frame and the extremity frame must carry the
/// same source (`PolicySourceMismatch`); a frame with no groups has no
/// latest counts (`NoLatestCounts`); a summed count above `u32::MAX`
/// anywhere in the frame is `CountOverflow`. Then, as `symmetric/1`:
/// exclusion first, a comment in only one of the counts and the extremity is
/// unscored, and the formula.
///
/// A count frame given on its own cannot be passed:
///
/// ```compile_fail,E0308
/// use polis_routing_equation::*;
/// let s = SourceId::new("u").unwrap();
/// let counts = HistoricalCountFrame::new(s.clone(), []).unwrap();
/// let extremity = ExtremityFrame::new(s, []).unwrap();
/// let meta = MetaComments::new([]).unwrap();
/// let _ = symmetric_2(&SymmetricParams::default(), &counts, &extremity, &meta);
/// ```
pub fn symmetric_2(
    params: &SymmetricParams,
    groups: &CurrentGroupFrame,
    extremity: &ExtremityFrame,
    meta: &MetaComments,
) -> Result<CorrectedWeights, Refusal> {
    let counts = latest_counts(groups, extremity)?;
    let (scored, unscored, excluded) = weigh(params, &counts, extremity, meta, |_| vec![])?;
    Ok(CorrectedWeights {
        params: ParamSet::Symmetric2(*params),
        base_counts: BaseCounts::Latest(counts.source().clone()),
        current_extremity: extremity.source().clone(),
        current_groups: Some(groups.source().clone()),
        scored,
        unscored,
        excluded,
        terms: vec![],
        term_source: None,
    })
}

/// `symmetric-gic/2`: `symmetric-gic/1` on `base-counts:lag-0`. The base
/// counts and the group-informed consensus factor both come from the one
/// group frame; refusals as `symmetric/2`.
pub fn symmetric_gic_2(
    params: &SymmetricGicParams,
    groups: &CurrentGroupFrame,
    extremity: &ExtremityFrame,
    meta: &MetaComments,
) -> Result<CorrectedWeights, Refusal> {
    let counts = latest_counts(groups, extremity)?;
    let (scored, unscored, excluded) = weigh(&params.base, &counts, extremity, meta, |id| {
        let c = consensus(params.form, &params.gic, groups, id);
        vec![Factor::new(FactorName::GroupConsensus, c.factor)]
    })?;
    Ok(CorrectedWeights {
        params: ParamSet::SymmetricGic2(*params),
        base_counts: BaseCounts::Latest(counts.source().clone()),
        current_extremity: extremity.source().clone(),
        current_groups: Some(groups.source().clone()),
        scored,
        unscored,
        excluded,
        terms: vec![],
        term_source: None,
    })
}
