//! `uniform/1`, the two-lane floor and the stable draw `stable-cdf/1`.
//!
//! The floor mixes two lanes: a stated share of the chance is spread evenly
//! over the candidates (the uniform lane) and the rest follows a base rule's
//! weights (the weighted lane). Each candidate's draw weight is its marginal
//! chance under that mixture,
//!
//! ```text
//! d_j = s_u / n + s_w * w_j / W,     W = sum of w over the candidates,
//! ```
//!
//! with effective shares `s_u = floor_share` and `s_w = 1 - floor_share`, or,
//! when the weighted lane has no mass (W = 0), its share donated to the
//! uniform lane: `s_u = 1`, `s_w = 0`. Mathematically the d_j add up to 1, so
//! d_j is the chance itself; the draw runs today's arithmetic over them and
//! reports `q_j = d_j / T`, T their computed sum. No lane is sampled.
//!
//! `stable-cdf/1` is that arithmetic with validation first: a plan in which a
//! positive draw weight is below 2^-40 of the total is refused
//! (`NumericDegeneracy`), so every candidate that has a chance has one of at
//! least 2^-40 - 2^-50. With fixed ordered candidates and unchanged donation
//! and acceptance branches, small changes in the normalised marginal scores
//! move interval boundaries only a little. Small absolute base-weight changes
//! need not do so near zero mass, and changing candidate membership or order
//! does not preserve a unit's choice.

use crate::corrected::{CorrectedWeights, MetaPolicy, SymmetricGicParams};
use crate::draw::{
    Candidates, Cdf, CorrectedProvenance, DrawFlags, DrawMode, Drawn, Lane, MIN_TOTAL, Unit,
    WeightProvenance, WeightsUsed, cdf,
};
use crate::historical::MetaComments;
use crate::registry::ParamSet;
use crate::types::WEIGHT_CEILING;
use crate::types::{CommentId, DrawRefusal, MAX_CANDIDATES, ParamError, Refusal, SourceId};

/// 2^-40: under `stable-cdf/1` a positive draw weight below this share of the
/// total is refused.
pub const DEGENERACY_RATIO: f64 = 1.0 / (1u64 << 40) as f64;

/// The one donation the floor makes, as its receipt writes it: the weighted
/// lane had no mass, so its share went to the uniform lane.
pub const ZERO_MASS_DONATION: &str = "weights->uniform:zero_mass";

fn checked_weights(d: &[f64]) -> Result<(), DrawRefusal> {
    if d.is_empty() {
        return Err(DrawRefusal::Empty);
    }
    if d.len() > MAX_CANDIDATES {
        return Err(DrawRefusal::TooManyCandidates(d.len()));
    }
    if let Some(bad) = d
        .iter()
        .position(|w| !(w.is_finite() && (0.0..=WEIGHT_CEILING).contains(w)))
    {
        return Err(DrawRefusal::InvalidDrawWeight(bad));
    }
    Ok(())
}

/// `stable-cdf/1`: the shared arithmetic (`legacy-cdf/1`, unchanged) after
/// three checks, in this order: every draw weight zero is `ZeroMass`; a total
/// below 2^-1021 is `TotalBelowNormal`; a draw weight with
/// `0 < d_j < 2^-40 * total` is `NumericDegeneracy` (its position). On what it
/// accepts no candidate is absorbed.
pub fn stable_cdf(draw_weights: &[f64], unit: Unit) -> Result<Cdf, DrawRefusal> {
    checked_weights(draw_weights)?;
    if draw_weights.iter().all(|d| *d == 0.0) {
        return Err(DrawRefusal::ZeroMass);
    }
    // The same running sum, in the same order, as the arithmetic.
    let total = draw_weights.iter().fold(0.0f64, |s, d| s + d);
    if total < MIN_TOTAL {
        return Err(DrawRefusal::TotalBelowNormal);
    }
    let threshold = total * DEGENERACY_RATIO;
    if let Some(i) = draw_weights.iter().position(|d| *d > 0.0 && *d < threshold) {
        return Err(DrawRefusal::NumericDegeneracy(i));
    }
    cdf(draw_weights, unit)
}

/// The two lanes' marginal chances for a list of base weights, in the
/// candidates' order: what a floor rule draws from and what its receipt
/// reports.
#[derive(Clone, Debug, PartialEq)]
pub struct FloorMarginals {
    draw_weights: Vec<f64>,
    uniform: Vec<f64>,
    weighted: Vec<f64>,
    uniform_share: f64,
    weighted_share: f64,
    uniform_normaliser: f64,
    weighted_normaliser: f64,
    donations: Vec<String>,
}

impl FloorMarginals {
    /// d_j for every candidate: the uniform part plus the weighted part.
    pub fn draw_weights(&self) -> &[f64] {
        &self.draw_weights
    }
    /// `s_u / n` for every candidate.
    pub fn uniform(&self) -> &[f64] {
        &self.uniform
    }
    /// `s_w * w_j / W` for every candidate (0 when the share was donated).
    pub fn weighted(&self) -> &[f64] {
        &self.weighted
    }
    /// The uniform lane's effective share, after donation.
    pub fn uniform_share(&self) -> f64 {
        self.uniform_share
    }
    /// The weighted lane's effective share, after donation.
    pub fn weighted_share(&self) -> f64 {
        self.weighted_share
    }
    /// n, the uniform lane's normaliser.
    pub fn uniform_normaliser(&self) -> f64 {
        self.uniform_normaliser
    }
    /// W, the weighted lane's normaliser: the base weights' sum over the
    /// candidates, in their order.
    pub fn weighted_normaliser(&self) -> f64 {
        self.weighted_normaliser
    }
    /// Empty, or `[ZERO_MASS_DONATION]`.
    pub fn donations(&self) -> &[String] {
        &self.donations
    }
}

fn share_error(value: f64) -> ParamError {
    ParamError {
        name: "floor_share",
        value: format!("{value:?}"),
        allowed: "[0, 1)",
    }
}

/// The floor over base weights given in the candidates' order. Refused: a
/// `floor_share` outside [0, 1) (`InvalidShare`), no weights, more than 2^24,
/// and a weight that is not finite or outside [0, 1e150]. A zero base weight
/// is allowed and keeps its floor chance `s_u / n`; when every base weight is
/// zero, the weighted lane's share is donated to the uniform lane.
pub fn floor_marginals(floor_share: f64, base: &[f64]) -> Result<FloorMarginals, DrawRefusal> {
    if !(floor_share.is_finite() && (0.0..1.0).contains(&floor_share)) {
        return Err(DrawRefusal::InvalidShare);
    }
    checked_weights(base)?;
    let n = base.len() as f64;
    let total = base.iter().fold(0.0f64, |s, w| s + w);
    let (uniform_share, weighted_share, donations) = if total == 0.0 {
        (1.0, 0.0, vec![ZERO_MASS_DONATION.to_string()])
    } else {
        (floor_share + 0.0, 1.0 - floor_share, vec![])
    };
    let u = uniform_share / n;
    let uniform = vec![u; base.len()];
    let weighted: Vec<f64> = if total == 0.0 {
        vec![0.0; base.len()]
    } else {
        base.iter().map(|w| weighted_share * (w / total)).collect()
    };
    let draw_weights = weighted.iter().map(|v| u + v).collect();
    Ok(FloorMarginals {
        draw_weights,
        uniform,
        weighted,
        uniform_share,
        weighted_share,
        uniform_normaliser: n,
        weighted_normaliser: total,
        donations,
    })
}

/// `uniform/1`: every candidate has the same chance, 1/n. No parameters and
/// no weights. Each draw weight is 1, so the total is n exactly and the
/// reported probability is `1/n` correctly rounded; the chosen index is the
/// floor of `unit * n`.
pub fn uniform_1(
    candidates: &Candidates,
    unit: Unit,
    input_source: &SourceId,
) -> Result<Drawn, DrawRefusal> {
    let d = vec![1.0; candidates.len()];
    let pick = stable_cdf(&d, unit)?;
    let comment = candidates
        .ids()
        .get(pick.index())
        .copied()
        .ok_or(DrawRefusal::NoInterval)?;
    Ok(Drawn {
        comment,
        index: pick.index(),
        random_n: pick.random_n(),
        probability: pick.probability(),
        rule: ParamSet::Uniform1,
        draw_mode: DrawMode::StableCdf1,
        weights: WeightsUsed::NotRead,
        lanes: vec![Lane {
            lane: "uniform",
            share: 1.0,
            normaliser: pick.total(),
            contribution: pick.probability(),
        }],
        sampled_lane: None,
        flags: DrawFlags::default(),
        candidate_count: candidates.len(),
        candidate_order_digest: candidates.order_digest(),
        input_source: input_source.clone(),
    })
}

/// The parameters of `symmetric-gic-floor/1`: `symmetric-gic/1`'s, and the
/// uniform lane's share.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FloorParams {
    base: SymmetricGicParams,
    floor_share: f64,
}

impl Default for FloorParams {
    fn default() -> Self {
        Self {
            base: SymmetricGicParams::default(),
            floor_share: 0.1,
        }
    }
}

impl FloorParams {
    /// `floor_share` in [0, 1); a negative zero is stored as +0.
    pub fn new(base: SymmetricGicParams, floor_share: f64) -> Result<Self, ParamError> {
        if !(floor_share.is_finite() && (0.0..1.0).contains(&floor_share)) {
            return Err(share_error(floor_share));
        }
        Ok(Self {
            base,
            floor_share: floor_share + 0.0,
        })
    }
    pub fn base(&self) -> &SymmetricGicParams {
        &self.base
    }
    pub fn floor_share(&self) -> f64 {
        self.floor_share
    }
}

/// A `symmetric-gic-floor/1` plan: the weights `symmetric-gic/1` gave with
/// the same base parameters, the floor's share, and the meta comments the
/// weights were computed with.
#[derive(Clone, Debug, PartialEq)]
pub struct FloorPlan {
    params: FloorParams,
    weights: CorrectedWeights,
    meta: MetaComments,
}

/// Builds a `symmetric-gic-floor/1` plan. Refused (`BaseMismatch`) unless the
/// weights were computed by `symmetric-gic/1` with exactly the floor's base
/// parameters. `meta` must be the set the weights were computed with (a
/// caller obligation the crate cannot check); under `meta_policy = exclude`
/// it is what decides exclusion at the draw.
pub fn symmetric_gic_floor_1(
    params: &FloorParams,
    weights: CorrectedWeights,
    meta: &MetaComments,
) -> Result<FloorPlan, Refusal> {
    if *weights.params() != ParamSet::SymmetricGic1(params.base) {
        return Err(Refusal::BaseMismatch);
    }
    Ok(FloorPlan {
        params: *params,
        weights,
        meta: meta.clone(),
    })
}

impl FloorPlan {
    pub fn params(&self) -> &FloorParams {
        &self.params
    }
    pub fn weights(&self) -> &CorrectedWeights {
        &self.weights
    }

    /// Each candidate's base weight, in order, and how many were unscored.
    ///
    /// Exclusion comes first and does not depend on scoring: under
    /// `meta_policy = exclude`, a candidate in the meta set is refused
    /// (`ExcludedCandidate`) whether or not it could have been scored, and so
    /// is any comment the weights list as excluded. Then a scored comment
    /// draws at its weight, an unscored one (in only one of the two frames)
    /// at 1, not multiplied by any factor; any other candidate is
    /// `NeedsBaseline`.
    fn resolve(&self, candidates: &Candidates) -> Result<(Vec<f64>, usize), DrawRefusal> {
        let exclude = self.params.base.base().meta_policy() == MetaPolicy::Exclude;
        let excluded: Vec<CommentId> = self.weights.excluded().collect();
        let unscored: Vec<CommentId> = self.weights.unscored().collect();
        let mut base = Vec::with_capacity(candidates.len());
        let mut mapped = 0usize;
        for id in candidates.ids() {
            if (exclude && self.meta.contains(*id)) || excluded.contains(id) {
                return Err(DrawRefusal::ExcludedCandidate(*id));
            }
            if let Some(s) = self.weights.get(*id) {
                base.push(s.weight().get());
            } else if unscored.contains(id) {
                mapped += 1;
                base.push(1.0);
            } else {
                return Err(DrawRefusal::NeedsBaseline(*id));
            }
        }
        Ok((base, mapped))
    }

    /// The full marginal vector for these candidates, with the effective
    /// shares and the normalisers.
    pub fn probabilities(&self, candidates: &Candidates) -> Result<FloorMarginals, DrawRefusal> {
        let (base, _) = self.resolve(candidates)?;
        floor_marginals(self.params.floor_share, &base)
    }

    /// Draws one candidate under `stable-cdf/1` and writes its receipt.
    /// `weights_source` names the materialized weights the draw read.
    pub fn draw(
        &self,
        candidates: &Candidates,
        unit: Unit,
        weights_source: &SourceId,
        input_source: &SourceId,
    ) -> Result<Drawn, DrawRefusal> {
        let (base, mapped) = self.resolve(candidates)?;
        let m = floor_marginals(self.params.floor_share, &base)?;
        let pick = stable_cdf(&m.draw_weights, unit)?;
        let i = pick.index();
        let comment = candidates
            .ids()
            .get(i)
            .copied()
            .ok_or(DrawRefusal::NoInterval)?;
        let (Some(u), Some(w)) = (m.uniform.get(i), m.weighted.get(i)) else {
            return Err(DrawRefusal::NoInterval);
        };
        Ok(Drawn {
            comment,
            index: i,
            random_n: pick.random_n(),
            probability: pick.probability(),
            rule: ParamSet::SymmetricGicFloor1(self.params),
            draw_mode: DrawMode::StableCdf1,
            weights: WeightsUsed::Map {
                source: weights_source.clone(),
                provenance: WeightProvenance::Corrected(CorrectedProvenance::of(&self.weights)),
            },
            lanes: vec![
                Lane {
                    lane: "uniform",
                    share: m.uniform_share,
                    normaliser: m.uniform_normaliser,
                    contribution: *u,
                },
                Lane {
                    lane: "weights",
                    share: m.weighted_share,
                    normaliser: m.weighted_normaliser,
                    contribution: *w,
                },
            ],
            sampled_lane: None,
            flags: DrawFlags {
                absent_mapped_to_one: mapped,
                donations: m.donations.clone(),
                ..DrawFlags::default()
            },
            candidate_count: candidates.len(),
            candidate_order_digest: candidates.order_digest(),
            input_source: input_source.clone(),
        })
    }
}
