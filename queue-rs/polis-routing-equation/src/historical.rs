//! `historical/1`: the weight the math engine gives each comment today.
//!
//! The code of record is `priority_metric` in
//! `delphi/polismath/conversation/conversation.py`, fed by the engine's
//! comment-priority loop in the same file. Its arithmetic is followed here to
//! the operation, in the same order.

use crate::types::{
    CommentId, Counts, Explanation, Extremity, ExtremityFrame, Factor, FactorName,
    HistoricalCountFrame, ParamError, Refusal, SourceId, Weight,
};
use std::collections::{BTreeMap, BTreeSet};

/// The parameters of `historical/1`. Every default is the constant in the
/// Python source; changing a default is a new rule version (`historical/2`),
/// while running another allowed set is a parameter set of this one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HistoricalParams {
    agree_prior: f64,
    pass_prior: f64,
    seen_prior: f64,
    extremity_offset: f64,
    novelty_amplitude: f64,
    novelty_halving_votes: f64,
    exponent: u8,
    meta_inner: f64,
}

impl Default for HistoricalParams {
    fn default() -> Self {
        Self {
            agree_prior: 1.0,
            pass_prior: 1.0,
            seen_prior: 2.0,
            extremity_offset: 1.0,
            novelty_amplitude: 8.0,
            novelty_halving_votes: 5.0,
            exponent: 2,
            meta_inner: 7.0,
        }
    }
}

fn within(
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

impl HistoricalParams {
    /// Validates every parameter against its allowed range, and the coupled
    /// ranges: `agree_prior <= seen_prior` and
    /// `seen_prior - pass_prior >= 1e-3`. On these ranges every factor of
    /// the weight has a positive lower bound.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        agree_prior: f64,
        pass_prior: f64,
        seen_prior: f64,
        extremity_offset: f64,
        novelty_amplitude: f64,
        novelty_halving_votes: f64,
        exponent: u8,
        meta_inner: f64,
    ) -> Result<Self, ParamError> {
        within(
            "agree_prior",
            agree_prior,
            1e-3,
            1000.0,
            "[1e-3, 1000], and <= seen_prior",
        )?;
        within(
            "pass_prior",
            pass_prior,
            1e-3,
            1000.0,
            "[1e-3, 1000], and seen_prior - pass_prior >= 1e-3",
        )?;
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
        if agree_prior > seen_prior {
            return Err(ParamError {
                name: "agree_prior",
                value: format!("{agree_prior:?}"),
                allowed: "[1e-3, 1000], and <= seen_prior",
            });
        }
        if seen_prior - pass_prior < 1e-3 {
            return Err(ParamError {
                name: "pass_prior",
                value: format!("{pass_prior:?}"),
                allowed: "[1e-3, 1000], and seen_prior - pass_prior >= 1e-3",
            });
        }
        Ok(Self {
            agree_prior,
            pass_prior,
            seen_prior,
            extremity_offset,
            // Signed zero has no mathematical distinction in this parameter.
            // Keep one representation for equal parameter sets and receipts.
            novelty_amplitude: if novelty_amplitude == 0.0 {
                0.0
            } else {
                novelty_amplitude
            },
            novelty_halving_votes,
            exponent,
            meta_inner,
        })
    }

    pub fn agree_prior(&self) -> f64 {
        self.agree_prior
    }
    pub fn pass_prior(&self) -> f64 {
        self.pass_prior
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
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    /// The explanation of an ordinary (not meta) scored comment, in Python's
    /// order: `(1 - p) * (E + offset) * a`, then times the novelty, then the
    /// power.
    fn ordinary(&self, counts: Counts, extremity: Extremity) -> Explanation {
        // Exact: a seen count is at most 3 x (2^32 - 1), far below 2^53.
        let seen = counts.seen() as f64;
        let p = (f64::from(counts.passed()) + self.pass_prior) / (seen + self.seen_prior);
        let a = (f64::from(counts.agreed()) + self.agree_prior) / (seen + self.seen_prior);
        let not_pass = 1.0 - p;
        let boost = extremity.get() + self.extremity_offset;
        let novelty = 1.0 + self.novelty_amplitude * 2f64.powf(-seen / self.novelty_halving_votes);
        Explanation::new(
            vec![
                Factor::new(FactorName::NotPassShare, not_pass),
                Factor::new(FactorName::ExtremityBoost, boost),
                Factor::new(FactorName::AgreeShare, a),
                Factor::new(FactorName::Novelty, novelty),
            ],
            self.exponent,
            vec![],
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

/// The comments the conversation marks as meta. A scored meta comment weighs
/// `meta_inner ^ exponent` (49 at the defaults).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MetaComments(BTreeSet<CommentId>);

impl MetaComments {
    pub fn new(ids: impl IntoIterator<Item = CommentId>) -> Result<Self, Refusal> {
        let mut set = BTreeSet::new();
        for id in ids {
            if !set.insert(id) {
                return Err(Refusal::DuplicateComment(id));
            }
        }
        Ok(Self(set))
    }
    pub fn none() -> Self {
        Self::default()
    }
    pub fn contains(&self, id: CommentId) -> bool {
        self.0.contains(&id)
    }
}

/// One scored comment: its weight and how it was made.
#[derive(Clone, Debug, PartialEq)]
pub struct Scored {
    weight: Weight,
    explanation: Explanation,
}

impl Scored {
    pub(crate) fn new(weight: Weight, explanation: Explanation) -> Self {
        Self {
            weight,
            explanation,
        }
    }
    pub fn weight(&self) -> Weight {
        self.weight
    }
    pub fn explanation(&self) -> &Explanation {
        &self.explanation
    }
}

/// What produced a set of `historical/1` weights: the exact parameter set and
/// the sources of the two frames it read. Computed weight maps receive this
/// only through `historical_1`; their provenance cannot be supplied by a caller.
/// Reading a receipt also restores its claimed provenance, without computing
/// weights or authenticating the claim. That receipt cannot construct a
/// computed weight map.
///
/// It comes from the weights:
///
/// ```
/// use polis_routing_equation::{
///     ExtremityFrame, HistoricalCountFrame, HistoricalParams, MetaComments, SourceId, historical_1,
/// };
/// let counts = HistoricalCountFrame::new(SourceId::new("previous").unwrap(), []).unwrap();
/// let e = ExtremityFrame::new(SourceId::new("current").unwrap(), []).unwrap();
/// let w = historical_1(&HistoricalParams::default(), &counts, &e, &MetaComments::none()).unwrap();
/// assert_eq!(w.provenance().previous_counts().as_str(), "previous");
/// ```
///
/// and cannot be made by a caller:
///
/// ```compile_fail,E0624
/// use polis_routing_equation::{HistoricalParams, HistoricalProvenance, SourceId};
/// let s = SourceId::new("previous").unwrap();
/// let p = HistoricalProvenance::new(HistoricalParams::default(), s.clone(), s);
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct HistoricalProvenance {
    params: HistoricalParams,
    previous_counts: SourceId,
    current_extremity: SourceId,
}

impl HistoricalProvenance {
    pub(crate) fn new(
        params: HistoricalParams,
        previous_counts: SourceId,
        current_extremity: SourceId,
    ) -> Self {
        Self {
            params,
            previous_counts,
            current_extremity,
        }
    }
    pub fn params(&self) -> &HistoricalParams {
        &self.params
    }
    /// The source of the previous tick's count frame.
    pub fn previous_counts(&self) -> &SourceId {
        &self.previous_counts
    }
    /// The source of the current tick's extremity frame.
    pub fn current_extremity(&self) -> &SourceId {
        &self.current_extremity
    }
}

/// What `historical/1` gives for a conversation: a weight and explanation for
/// every scored comment, the comments it did not score, and what produced
/// them.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoricalWeights {
    provenance: HistoricalProvenance,
    scored: BTreeMap<CommentId, Scored>,
    unscored: BTreeSet<CommentId>,
}

impl HistoricalWeights {
    pub fn provenance(&self) -> &HistoricalProvenance {
        &self.provenance
    }
    pub fn params(&self) -> &HistoricalParams {
        &self.provenance.params
    }
    pub fn counts_source(&self) -> &SourceId {
        &self.provenance.previous_counts
    }
    pub fn extremity_source(&self) -> &SourceId {
        &self.provenance.current_extremity
    }
    pub fn get(&self, id: CommentId) -> Option<&Scored> {
        self.scored.get(&id)
    }
    pub fn scored(&self) -> impl Iterator<Item = (CommentId, &Scored)> + '_ {
        self.scored.iter().map(|(id, s)| (*id, s))
    }
    /// Comments in only one of the two frames: they get no weight here, and a
    /// draw over stored weights gives them 1, as today.
    pub fn unscored(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.unscored.iter().copied()
    }
}

/// `historical/1` over a conversation. The decision table, in order:
/// 1. invalid inputs were already refused by their constructors;
/// 2. a comment absent from either frame gets no weight (unscored);
/// 3. a scored meta comment weighs `meta_inner ^ exponent`;
/// 4. every other scored comment gets the formula.
///
/// A weight that would leave `[0, 1e150]` is `Refusal::WeightOutOfRange`.
pub fn historical_1(
    params: &HistoricalParams,
    counts: &HistoricalCountFrame,
    extremity: &ExtremityFrame,
    meta: &MetaComments,
) -> Result<HistoricalWeights, Refusal> {
    let mut scored = BTreeMap::new();
    let mut unscored = BTreeSet::new();
    let ids: BTreeSet<CommentId> = counts.ids().chain(extremity.ids()).collect();
    for id in ids {
        let (Some(c), Some(e)) = (counts.get(id), extremity.get(id)) else {
            unscored.insert(id);
            continue;
        };
        let explanation = if meta.contains(id) {
            params.meta()
        } else {
            params.ordinary(c, e)
        };
        let value = explanation
            .evaluate_checked()
            .map_err(|(_, term)| Refusal::WeightOutOfRange { comment: id, term })?;
        let weight = Weight::checked(value).ok_or(Refusal::WeightOutOfRange {
            comment: id,
            term: "power",
        })?;
        scored.insert(
            id,
            Scored {
                weight,
                explanation,
            },
        );
    }
    Ok(HistoricalWeights {
        provenance: HistoricalProvenance::new(
            *params,
            counts.source().clone(),
            extremity.source().clone(),
        ),
        scored,
        unscored,
    })
}
