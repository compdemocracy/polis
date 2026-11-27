//! The corrected rules: candidates for the next equation, none of them chosen.
//!
//! - `symmetric/1`: today's equation with agree and disagree weighed alike in
//!   the count term.
//! - `gic-mean/1` and `gic-geomean/1`: the group-informed consensus factor in
//!   two forms, read from the current tick's opinion groups.
//! - `symmetric-gic/1`: `symmetric/1` times that factor.
//!
//! Each is a pure function of validated frames. Group values are reduced in
//! sorted order, so the order in which groups arrive, and their ids, cannot
//! change a bit of the result.

use crate::frames::CurrentGroupFrame;
use crate::historical::{MetaComments, Scored};
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

/// What a corrected rule gives for a conversation: the exact parameter set,
/// the sources it read, a weight and explanation per scored comment, the
/// comments it did not score, and the meta comments it excluded.
#[derive(Clone, Debug, PartialEq)]
pub struct CorrectedWeights {
    params: ParamSet,
    previous_counts: SourceId,
    current_extremity: SourceId,
    current_groups: Option<SourceId>,
    scored: BTreeMap<CommentId, Scored>,
    unscored: BTreeSet<CommentId>,
    excluded: BTreeSet<CommentId>,
}

impl CorrectedWeights {
    pub fn params(&self) -> &ParamSet {
        &self.params
    }
    pub fn previous_counts(&self) -> &SourceId {
        &self.previous_counts
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
    /// Scored meta comments under `meta_policy = exclude`.
    pub fn excluded(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.excluded.iter().copied()
    }
}

/// Scored, unscored and excluded comments.
type Weighed = (
    BTreeMap<CommentId, Scored>,
    BTreeSet<CommentId>,
    BTreeSet<CommentId>,
);

fn weigh(
    base: &SymmetricParams,
    counts: &HistoricalCountFrame,
    extremity: &ExtremityFrame,
    meta: &MetaComments,
    mut outer: impl FnMut(CommentId) -> Vec<Factor>,
) -> Result<Weighed, Refusal> {
    let mut scored = BTreeMap::new();
    let mut unscored = BTreeSet::new();
    let mut excluded = BTreeSet::new();
    let ids: BTreeSet<CommentId> = counts.ids().chain(extremity.ids()).collect();
    for id in ids {
        let (Some(c), Some(e)) = (counts.get(id), extremity.get(id)) else {
            unscored.insert(id);
            continue;
        };
        let explanation = match (meta.contains(id), base.meta_policy) {
            (true, MetaPolicy::Fixed) => base.meta(),
            (true, MetaPolicy::Exclude) => {
                excluded.insert(id);
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
/// a comment absent from either frame gets no weight (unscored); a scored
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
        previous_counts: counts.source().clone(),
        current_extremity: extremity.source().clone(),
        current_groups: None,
        scored,
        unscored,
        excluded,
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
        previous_counts: counts.source().clone(),
        current_extremity: extremity.source().clone(),
        current_groups: Some(groups.source().clone()),
        scored,
        unscored,
        excluded,
    })
}
