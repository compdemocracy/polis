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
use crate::types::{DrawRefusal, MAX_CANDIDATES, ParamError, Refusal, SourceId};
use std::collections::{BTreeMap, BTreeSet};

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

/// Why a candidate did not resolve to a base weight.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Unresolved<K> {
    Excluded(K),
    NeedsBaseline(K),
}

/// The floor's resolution of candidates to base weights, in the candidates'
/// order: refused if in `meta` (given only under `meta_policy = exclude`) or
/// in `excluded`; else the scored weight; else 1 if unscored (counted); else
/// refused as needing a baseline. Every lookup is in an ordered map or set,
/// at most one in each per candidate, so the work is O(n log n) in the
/// candidates and the sets; nothing here depends on the sets' iteration
/// order. Generic over the key only so that the crate's own tests can count
/// the key comparisons it makes.
fn resolve_ids<K: Ord + Copy, V>(
    ids: &[K],
    meta: Option<&BTreeSet<K>>,
    excluded: &BTreeSet<K>,
    scored: &BTreeMap<K, V>,
    weight: impl Fn(&V) -> f64,
    unscored: &BTreeSet<K>,
) -> Result<(Vec<f64>, usize), Unresolved<K>> {
    let mut base = Vec::with_capacity(ids.len());
    let mut mapped = 0usize;
    for &id in ids {
        if meta.is_some_and(|m| m.contains(&id)) || excluded.contains(&id) {
            return Err(Unresolved::Excluded(id));
        }
        if let Some(v) = scored.get(&id) {
            base.push(weight(v));
        } else if unscored.contains(&id) {
            mapped += 1;
            base.push(1.0);
        } else {
            return Err(Unresolved::NeedsBaseline(id));
        }
    }
    Ok((base, mapped))
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
        resolve_ids(
            candidates.ids(),
            exclude.then(|| self.meta.set()),
            self.weights.excluded_set(),
            self.weights.scored_map(),
            |s| s.weight().get(),
            self.weights.unscored_set(),
        )
        .map_err(|u| match u {
            Unresolved::Excluded(id) => DrawRefusal::ExcludedCandidate(id),
            Unresolved::NeedsBaseline(id) => DrawRefusal::NeedsBaseline(id),
        })
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

#[cfg(test)]
// The counted key holds a shared counter; its order and equality read only
// the id, so the counter changing cannot move a key in a set.
#[allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::mutable_key_type
)]
mod tests {
    //! The floor's resolution against the previous implementation, kept below
    //! for comparison, on many seeded constructed cases; and a count of the
    //! key comparisons the resolution makes, which must grow no faster than
    //! n log n.
    use super::*;
    use crate::corrected::{ConsensusForm, GicParams, SymmetricParams};
    use crate::types::{CommentId, Weight};
    use std::cell::Cell;

    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }
        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    // ---- The previous implementation, kept for comparison. ----
    //
    // `resolve`, `probabilities` and `draw` exactly as they were before the
    // resolution looked candidates up in ordered sets: the excluded and the
    // unscored comments were collected into lists and every candidate was
    // looked up in them by a linear scan, so the work was quadratic.

    fn previous_resolve(
        plan: &FloorPlan,
        candidates: &Candidates,
    ) -> Result<(Vec<f64>, usize), DrawRefusal> {
        let exclude = plan.params.base.base().meta_policy() == MetaPolicy::Exclude;
        let excluded: Vec<CommentId> = plan.weights.excluded().collect();
        let unscored: Vec<CommentId> = plan.weights.unscored().collect();
        let mut base = Vec::with_capacity(candidates.len());
        let mut mapped = 0usize;
        for id in candidates.ids() {
            if (exclude && plan.meta.contains(*id)) || excluded.contains(id) {
                return Err(DrawRefusal::ExcludedCandidate(*id));
            }
            if let Some(s) = plan.weights.get(*id) {
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

    fn previous_probabilities(
        plan: &FloorPlan,
        candidates: &Candidates,
    ) -> Result<FloorMarginals, DrawRefusal> {
        let (base, _) = previous_resolve(plan, candidates)?;
        floor_marginals(plan.params.floor_share, &base)
    }

    fn previous_draw(
        plan: &FloorPlan,
        candidates: &Candidates,
        unit: Unit,
        weights_source: &SourceId,
        input_source: &SourceId,
    ) -> Result<Drawn, DrawRefusal> {
        let (base, mapped) = previous_resolve(plan, candidates)?;
        let m = floor_marginals(plan.params.floor_share, &base)?;
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
            rule: ParamSet::SymmetricGicFloor1(plan.params),
            draw_mode: DrawMode::StableCdf1,
            weights: WeightsUsed::Map {
                source: weights_source.clone(),
                provenance: WeightProvenance::Corrected(CorrectedProvenance::of(&plan.weights)),
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

    // ---- The comparison. ----

    fn bits(v: &[f64]) -> Vec<u64> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    type MarginalBits = (Vec<u64>, Vec<u64>, Vec<u64>, [u64; 4], Vec<String>);

    fn marginal_bits(m: &FloorMarginals) -> MarginalBits {
        (
            bits(&m.draw_weights),
            bits(&m.uniform),
            bits(&m.weighted),
            [
                m.uniform_share.to_bits(),
                m.weighted_share.to_bits(),
                m.uniform_normaliser.to_bits(),
                m.weighted_normaliser.to_bits(),
            ],
            m.donations.clone(),
        )
    }

    /// Everything a draw reports, every number by its bits, and its receipt
    /// text.
    fn drawn_bits(d: &Drawn) -> (Drawn, u64, u64, Vec<[u64; 3]>, String) {
        (
            d.clone(),
            d.random_n.to_bits(),
            d.probability.to_bits(),
            d.lanes
                .iter()
                .map(|l| {
                    [
                        l.share.to_bits(),
                        l.normaliser.to_bits(),
                        l.contribution.to_bits(),
                    ]
                })
                .collect(),
            d.to_plain(),
        )
    }

    fn src(s: &str) -> SourceId {
        SourceId::new(s).unwrap()
    }

    /// What each constructed comment is to the plan.
    #[derive(Clone, Copy)]
    enum Kind {
        Scored(f64),
        Unscored,
        Excluded,
        Stranger,
    }

    /// A constructed plan and its candidates (in a shuffled order), with a
    /// mix of scored (some at zero weight), unscored, excluded and unknown
    /// comments chosen by `mode`, and comments known to the plan that are not
    /// candidates.
    fn constructed_case(rng: &mut XorShift, n: usize, mode: u64) -> (FloorPlan, Vec<CommentId>) {
        let policy = match rng.below(3) {
            _ if mode == 6 => MetaPolicy::Exclude,
            0 => MetaPolicy::Exclude,
            1 => MetaPolicy::Fixed,
            _ => MetaPolicy::Ordinary,
        };
        let share = match rng.below(4) {
            0 => 0.0,
            1 => 0.1,
            2 => 0.5,
            _ => rng.unit(),
        };
        let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
        let params = FloorParams::new(
            SymmetricGicParams::new(base, ConsensusForm::GicGeomean1, GicParams::default()),
            share,
        )
        .unwrap();
        let weight = |rng: &mut XorShift| match rng.below(8) {
            0 => 0.0,
            1 => 1e6 * (1.0 + rng.unit()),
            _ => (rng.below(1000) + 1) as f64 / 7.0,
        };
        // Under mode 6 a large share of the comments that are not candidates
        // are excluded (a tenth, half or all of as many as the candidates).
        let excluded_share = [10, 50, 100][rng.below(3) as usize];
        let kind = |rng: &mut XorShift, candidate: bool| -> Kind {
            let r = rng.below(100);
            match mode {
                6 if candidate && r < 50 => Kind::Scored(weight(rng)),
                6 if candidate => Kind::Unscored,
                6 if r < excluded_share => Kind::Excluded,
                6 => Kind::Scored(weight(rng)),
                0 => Kind::Scored((rng.below(1000) + 1) as f64 / 7.0),
                1 => Kind::Unscored,
                2 => Kind::Scored(0.0),
                3 if r < 50 => Kind::Scored(weight(rng)),
                3 => Kind::Unscored,
                4 if r < 50 => Kind::Scored(0.0),
                4 => Kind::Unscored,
                // Rare excluded and unknown comments, so that some cases
                // resolve and some are refused part way through.
                _ if r < 1 => Kind::Excluded,
                _ if r < 2 => Kind::Stranger,
                _ if r < 60 => Kind::Scored(weight(rng)),
                _ => Kind::Unscored,
            }
        };
        // Sparse, distinct ids; a fifth more comments than candidates (as
        // many again under mode 6), in a shuffled order; the first n are the
        // candidates.
        let known = if mode == 6 { 2 * n } else { n + n / 5 };
        let mut ids: Vec<CommentId> = (0..known)
            .map(|i| CommentId::new((i as u32) * 3 + rng.below(3) as u32))
            .collect();
        for i in (1..ids.len()).rev() {
            let j = rng.below(i as u64 + 1) as usize;
            ids.swap(i, j);
        }
        let all: Vec<(CommentId, Kind)> = ids
            .into_iter()
            .enumerate()
            .map(|(i, id)| (id, kind(rng, i < n)))
            .collect();
        let mut scored = vec![];
        let mut unscored = vec![];
        let mut meta = vec![];
        for (id, k) in &all {
            match k {
                Kind::Scored(w) => {
                    scored.push((*id, Weight::checked(*w).unwrap()));
                    // Meta comments that are scored under the other policies.
                    if policy != MetaPolicy::Exclude && rng.below(20) == 0 {
                        meta.push(*id);
                    }
                }
                Kind::Unscored => unscored.push(*id),
                Kind::Excluded => meta.push(*id),
                Kind::Stranger => {}
            }
        }
        let excluded: Vec<CommentId> = if policy == MetaPolicy::Exclude {
            meta.clone()
        } else {
            vec![]
        };
        let weights = CorrectedWeights::constructed(
            ParamSet::SymmetricGic1(*params.base()),
            [src("previous"), src("current"), src("groups")],
            scored,
            unscored,
            excluded,
        );
        let plan = FloorPlan {
            params,
            weights,
            meta: MetaComments::new(meta).unwrap(),
        };
        let candidates = all.iter().take(n).map(|(id, _)| *id).collect();
        (plan, candidates)
    }

    #[test]
    fn the_resolution_matches_the_previous_implementation_bit_for_bit() {
        let mut rng = XorShift(0x9e37_79b9_7f4a_7c15);
        let (ws, input) = (src("weights"), src("participant"));
        let largest_below_one = 1.0 - f64::EPSILON / 2.0;
        let mut seen = [0usize; 8];
        let cases = 1400;
        for case in 0..cases {
            let n = match case {
                0 => 0,
                1 => 1,
                _ if case % 20 == 0 => rng.below(3001) as usize,
                _ => rng.below(300) as usize,
            };
            let mode = case as u64 % 7;
            let (plan, ids) = constructed_case(&mut rng, n, mode);
            let Ok(candidates) = Candidates::new(ids) else {
                assert_eq!(n, 0, "only an empty list is refused here");
                seen[0] += 1;
                continue;
            };
            let new = plan.resolve(&candidates);
            let old = previous_resolve(&plan, &candidates);
            assert_eq!(
                new.as_ref().map(|(b, m)| (bits(b), *m)),
                old.as_ref().map(|(b, m)| (bits(b), *m)),
                "case {case}: the resolution"
            );
            match &old {
                Err(DrawRefusal::ExcludedCandidate(_)) => seen[1] += 1,
                Err(DrawRefusal::NeedsBaseline(_)) => seen[2] += 1,
                Err(_) => {}
                Ok((b, mapped)) => {
                    seen[3] += 1;
                    if *mapped > 0 {
                        seen[4] += 1;
                    }
                    if b.iter().all(|w| *w == 0.0) {
                        seen[5] += 1;
                    }
                    if mode == 6 && plan.weights.excluded().count() >= n / 10 {
                        seen[7] += 1;
                    }
                }
            }
            assert_eq!(
                plan.probabilities(&candidates).as_ref().map(marginal_bits),
                previous_probabilities(&plan, &candidates)
                    .as_ref()
                    .map(marginal_bits),
                "case {case}: the probabilities"
            );
            let units = [0.0, largest_below_one, rng.unit(), rng.unit(), rng.unit()];
            for x in units {
                let u = Unit::new(x).unwrap();
                let new = plan.draw(&candidates, u, &ws, &input);
                let old = previous_draw(&plan, &candidates, u, &ws, &input);
                if old.is_ok() {
                    seen[6] += 1;
                }
                assert_eq!(
                    new.as_ref().map(drawn_bits),
                    old.as_ref().map(drawn_bits),
                    "case {case}: the draw at {x:?}"
                );
            }
        }
        // Every kind of case was met: an empty list, a refusal for an
        // excluded and for an unknown candidate, resolutions with unscored
        // candidates, with no mass in the weighted lane and beside a large
        // excluded set, and draws.
        assert!(seen.iter().all(|s| *s > 0), "coverage {seen:?}");
    }

    // ---- The count of key comparisons. ----

    /// A comment id that counts every comparison made with it.
    #[derive(Clone, Copy, Debug)]
    struct Counted<'a> {
        id: u32,
        comparisons: &'a Cell<u64>,
    }

    impl PartialEq for Counted<'_> {
        fn eq(&self, other: &Self) -> bool {
            self.comparisons.set(self.comparisons.get() + 1);
            self.id == other.id
        }
    }
    impl Eq for Counted<'_> {}
    impl PartialOrd for Counted<'_> {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(other))
        }
    }
    impl Ord for Counted<'_> {
        fn cmp(&self, other: &Self) -> std::cmp::Ordering {
            self.comparisons.set(self.comparisons.get() + 1);
            self.id.cmp(&other.id)
        }
    }

    /// The comparisons the resolution makes for n candidates: all unscored,
    /// or all scored with as many excluded comments that are not candidates.
    /// `previous` runs the previous implementation's linear scans instead.
    fn comparisons(n: u32, all_unscored: bool, previous: bool) -> u64 {
        let count = Cell::new(0u64);
        let key = |id: u32| Counted {
            id,
            comparisons: &count,
        };
        // Candidates in a scrambled order (multiplying by a number coprime
        // to n permutes 0..n).
        let ids: Vec<Counted> = (0..n)
            .map(|i| key(((u64::from(i) * 7919) % u64::from(n)) as u32 * 2))
            .collect();
        let others: BTreeSet<Counted> = (0..n).map(|i| key(i * 2 + 1)).collect();
        let (scored, unscored, excluded): (BTreeMap<Counted, f64>, BTreeSet<Counted>, _) =
            if all_unscored {
                (
                    BTreeMap::new(),
                    ids.iter().copied().collect(),
                    BTreeSet::new(),
                )
            } else {
                (
                    ids.iter().map(|k| (*k, 1.0)).collect(),
                    BTreeSet::new(),
                    others,
                )
            };
        let excluded_list: Vec<Counted> = excluded.iter().copied().collect();
        let unscored_list: Vec<Counted> = unscored.iter().copied().collect();
        count.set(0);
        let mapped = if previous {
            let mut mapped = 0;
            for id in &ids {
                assert!(!excluded_list.contains(id));
                if !scored.contains_key(id) {
                    assert!(unscored_list.contains(id));
                    mapped += 1;
                }
            }
            mapped
        } else {
            let (_, mapped) =
                resolve_ids(&ids, None, &excluded, &scored, |w| *w, &unscored).unwrap();
            mapped
        };
        assert_eq!(mapped, if all_unscored { n as usize } else { 0 });
        count.get()
    }

    #[test]
    fn the_resolution_makes_n_log_n_comparisons_not_n_squared() {
        // From n to 8n, n log n grows about 10.4 times at n = 1000 and n^2
        // 64 times; the bound is 16. Each candidate is also held to at most
        // 4 (log2 n + 2) comparisons per lookup, three lookups.
        let (small, large) = (1000u32, 8000u32);
        for all_unscored in [true, false] {
            let (a, b) = (
                comparisons(small, all_unscored, false),
                comparisons(large, all_unscored, false),
            );
            assert!(
                b <= 16 * a,
                "{a} -> {b} comparisons from {small} to {large}"
            );
            let per_lookup = |n: u32| 4 * (u64::from(n.ilog2()) + 2);
            assert!(b <= u64::from(large) * 3 * per_lookup(large), "{b}");
            // The previous implementation's scans fail the same bound, so
            // the test can see the quadratic shape.
            let (pa, pb) = (
                comparisons(small, all_unscored, true),
                comparisons(large, all_unscored, true),
            );
            assert!(pb > 16 * pa, "the previous shape: {pa} -> {pb}");
        }
    }
}
