//! `uniform/1`, the two-lane floor with its zero-mass donation, the stable
//! draw `stable-cdf/1` and `symmetric-gic-floor/1`.
//!
//! Every reported probability is checked three ways: against a hand
//! computation written out below in plain arithmetic; against the measure of
//! the units that actually select the comment, found by bisection over the
//! doubles in [0, 1); and against the frequencies of many draws from a
//! seeded source.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::needless_range_loop
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, ConsensusForm, Counts, CurrentGroupFrame, DEGENERACY_RATIO, DrawMode,
    DrawRefusal, Drawn, Extremity, ExtremityFrame, FloorParams, GicParams, GroupId,
    HistoricalCountFrame, MIN_TOTAL, MetaComments, MetaPolicy, ParamSet, Refusal, RuleId,
    SymmetricGicParams, SymmetricParams, Unit, WeightProvenance, WeightsUsed, ZERO_MASS_DONATION,
    cdf, floor_marginals, lookup, stable_cdf, symmetric_1, symmetric_gic_1, symmetric_gic_floor_1,
    uniform_1,
};
use support::{XorShift, src};

/// The receipt bound of section 3.2(c): |P_j - q_j| <= 2^-50.
const BOUND: f64 = 1.0 / (1u64 << 50) as f64;
const U: f64 = f64::EPSILON / 2.0;

fn unit(x: f64) -> Unit {
    Unit::new(x).unwrap()
}

fn cands(ids: &[u32]) -> Candidates {
    Candidates::new(ids.iter().map(|i| CommentId::new(*i)).collect()).unwrap()
}

/// The index the arithmetic chooses for a unit given as raw bits.
fn index_at(d: &[f64], bits: u64) -> usize {
    stable_cdf(d, unit(f64::from_bits(bits))).unwrap().index()
}

/// The smallest double unit in [0, 1) whose chosen index is at least k (1.0
/// when none is): the index is non-decreasing in the unit, and the bit
/// patterns of non-negative doubles are ordered as the doubles are.
fn first_unit_at_least(d: &[f64], k: usize) -> f64 {
    if index_at(d, 0) >= k {
        return 0.0;
    }
    let (mut lo, mut hi) = (0u64, 1.0f64.to_bits());
    // index_at(lo) < k; hi is 1.0, past every unit.
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if index_at(d, mid) >= k {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    f64::from_bits(hi)
}

/// P_j for every candidate: the length of the units that select it.
fn measured(d: &[f64]) -> Vec<f64> {
    (0..d.len())
        .map(|j| first_unit_at_least(d, j + 1) - first_unit_at_least(d, j))
        .collect()
}

/// q_j as the draw reports it, for every candidate: a draw at a unit inside
/// the candidate's interval reports exactly fl(d_j / T).
fn reported(d: &[f64]) -> Vec<f64> {
    let total = d.iter().fold(0.0, |s, x| s + x);
    d.iter().map(|x| x / total).collect()
}

fn close(got: f64, want: f64, what: &str) {
    assert!((got - want).abs() <= BOUND, "{what}: {got} against {want}");
}

#[test]
fn two_comments_weights_one_and_three_at_a_tenth() {
    // By hand: n = 2, floor share 0.1, W = 1 + 3 = 4.
    // uniform part 0.1 / 2 = 0.05 each; weighted 0.9 * 1/4 = 0.225 and
    // 0.9 * 3/4 = 0.675; d = 0.275 and 0.725, which add up to 1.
    let m = floor_marginals(0.1, &[1.0, 3.0]).unwrap();
    close(m.uniform()[0], 0.05, "uniform part");
    close(m.weighted()[0], 0.225, "weighted part of 0");
    close(m.weighted()[1], 0.675, "weighted part of 1");
    close(m.draw_weights()[0], 0.275, "d0");
    close(m.draw_weights()[1], 0.725, "d1");
    assert_eq!(m.uniform_share(), 0.1);
    assert_eq!(m.weighted_share(), 1.0 - 0.1);
    assert_eq!(m.uniform_normaliser(), 2.0);
    assert_eq!(m.weighted_normaliser(), 4.0);
    assert!(m.donations().is_empty());
    let d = m.draw_weights();
    for (j, (p, q)) in measured(d).iter().zip(reported(d)).enumerate() {
        close(*p, q, &format!("measured against reported, {j}"));
    }
    close(measured(d)[0], 0.275, "measured 0");
    let at = stable_cdf(d, unit(0.2)).unwrap();
    assert_eq!(at.index(), 0);
    close(at.probability(), 0.275, "receipt 0");
    let at = stable_cdf(d, unit(0.5)).unwrap();
    assert_eq!(at.index(), 1);
    close(at.probability(), 0.725, "receipt 1");
}

#[test]
fn a_comment_with_zero_weight_keeps_its_floor_chance() {
    // [0, 2] at 0.1: d = 0.05 + 0.9 * 0 = 0.05 and 0.05 + 0.9 * 1 = 0.95.
    let m = floor_marginals(0.1, &[0.0, 2.0]).unwrap();
    assert_eq!(m.draw_weights()[0], 0.1 / 2.0);
    assert_eq!(m.weighted()[0], 0.0);
    close(m.draw_weights()[1], 0.95, "d1");
    let d = m.draw_weights();
    let p = measured(d);
    close(
        p[0],
        0.05,
        "the zero-weight comment is reachable at its floor",
    );
    close(reported(d)[0], 0.05, "reported");
    let at = stable_cdf(d, unit(0.01)).unwrap();
    assert_eq!(at.index(), 0);
    close(at.probability(), 0.05, "receipt");
    // A weight below rounding: d2 = 0.05 + 0.9 * 5e-324 / 1 = 0.05.
    let m = floor_marginals(0.1, &[1.0, 5e-324]).unwrap();
    assert_eq!(m.draw_weights()[1], 0.05);
    close(
        measured(m.draw_weights())[1],
        0.05,
        "tiny weight still has its floor",
    );
}

#[test]
fn a_lane_with_no_mass_donates_its_share_to_the_uniform_lane() {
    // [0, 0]: W = 0, so the weighted lane is unavailable; shares 1 and 0,
    // d = 1/2 each, q = 0.5 each, one donation.
    let m = floor_marginals(0.1, &[0.0, 0.0]).unwrap();
    assert_eq!(m.uniform_share(), 1.0);
    assert_eq!(m.weighted_share(), 0.0);
    assert_eq!(m.weighted_normaliser(), 0.0);
    assert_eq!(m.donations(), [ZERO_MASS_DONATION.to_string()]);
    assert_eq!(m.draw_weights(), [0.5, 0.5]);
    assert_eq!(measured(m.draw_weights()), [0.5, 0.5]);
    // Three comments, floor 0.25, no mass: 1/3 each.
    let m = floor_marginals(0.25, &[0.0, 0.0, 0.0]).unwrap();
    for (p, q) in measured(m.draw_weights())
        .iter()
        .zip(reported(m.draw_weights()))
    {
        close(*p, 1.0 / 3.0, "measured");
        close(q, 1.0 / 3.0, "reported");
    }
    // A zero floor share and no mass: the donation still leaves a chance.
    let m = floor_marginals(0.0, &[0.0, 0.0]).unwrap();
    assert_eq!(m.draw_weights(), [0.5, 0.5]);
}

#[test]
fn three_comments_by_hand() {
    // Weights [2, 0, 6] at floor 0.25. n = 3, W = 8.
    // uniform part 0.25 / 3 = 1/12 = 4/48 each;
    // weighted 0.75 * 2/8 = 9/48, 0, 0.75 * 6/8 = 27/48;
    // d = 13/48, 4/48, 31/48, which add up to 48/48.
    let m = floor_marginals(0.25, &[2.0, 0.0, 6.0]).unwrap();
    let want = [13.0 / 48.0, 4.0 / 48.0, 31.0 / 48.0];
    let d = m.draw_weights();
    let p = measured(d);
    let q = reported(d);
    for j in 0..3 {
        close(d[j], want[j], "d");
        close(p[j], want[j], "measured");
        close(q[j], want[j], "reported");
        // F1: at least the floor, floor_share / n, up to rounding.
        assert!(q[j] >= 0.25 / 3.0 * (1.0 - 4.0 * U));
    }
    // F1: the uniform lane's contributions add up to the floor share.
    let u: f64 = m.uniform().iter().sum();
    assert!((u - 0.25).abs() <= 3.0 * U);
}

#[test]
fn a_single_candidate_has_probability_one_for_every_unit() {
    let m = floor_marginals(0.1, &[5.0]).unwrap();
    for x in [0.0, 0.5, f64::from_bits(1.0f64.to_bits() - 1)] {
        let at = stable_cdf(m.draw_weights(), unit(x)).unwrap();
        assert_eq!(at.index(), 0);
        assert_eq!(at.probability(), 1.0);
    }
    let m = floor_marginals(0.1, &[0.0]).unwrap();
    assert_eq!(m.donations().len(), 1);
    assert_eq!(
        stable_cdf(m.draw_weights(), unit(0.9))
            .unwrap()
            .probability(),
        1.0
    );
}

#[test]
fn the_stable_draw_refuses_what_it_cannot_promise() {
    assert_eq!(
        stable_cdf(&[0.0, 0.0], unit(0.1)).unwrap_err(),
        DrawRefusal::ZeroMass
    );
    assert_eq!(
        stable_cdf(&[5e-324], unit(0.1)).unwrap_err(),
        DrawRefusal::TotalBelowNormal
    );
    // A positive weight below 2^-40 of the total is refused; exactly at it
    // is accepted.
    // At exactly 2^-1021 it draws (D3), with q = 1.
    let at = stable_cdf(&[MIN_TOTAL], unit(f64::from_bits(1.0f64.to_bits() - 1))).unwrap();
    assert_eq!((at.index(), at.probability()), (0, 1.0));
    // 2^40, written out, so a change of the constant is seen.
    let t = 1_099_511_627_776.0;
    assert_eq!(DEGENERACY_RATIO, 1.0 / t);
    assert_eq!(
        stable_cdf(&[t, 0.99], unit(0.1)).unwrap_err(),
        DrawRefusal::NumericDegeneracy(1)
    );
    assert!(stable_cdf(&[t - 1.0, 1.0], unit(0.1)).is_ok());
    // D7: the legacy arithmetic flags an absorbed candidate; the stable draw
    // refuses the same list.
    assert_eq!(cdf(&[1.0, 5e-324], unit(0.1)).unwrap().absorbed(), [1]);
    assert_eq!(
        stable_cdf(&[1.0, 5e-324], unit(0.1)).unwrap_err(),
        DrawRefusal::NumericDegeneracy(1)
    );
    // With no floor, a tiny weighted share is degenerate and refused.
    let m = floor_marginals(0.0, &[1.0, 1e-20]).unwrap();
    assert_eq!(
        stable_cdf(m.draw_weights(), unit(0.1)).unwrap_err(),
        DrawRefusal::NumericDegeneracy(1)
    );
    // A zero draw weight is never chosen (D2) and is not degenerate.
    let m = floor_marginals(0.0, &[0.0, 2.0]).unwrap();
    assert_eq!(measured(m.draw_weights()), [0.0, 1.0]);
    for share in [-0.1, 1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(
            floor_marginals(share, &[1.0]).unwrap_err(),
            DrawRefusal::InvalidShare
        );
    }
    assert_eq!(floor_marginals(0.1, &[]).unwrap_err(), DrawRefusal::Empty);
    assert_eq!(
        floor_marginals(0.1, &[1.0, -1.0]).unwrap_err(),
        DrawRefusal::InvalidDrawWeight(1)
    );
}

/// N draws from a seeded source: each observed frequency is within five
/// standard errors, sqrt(q (1 - q) / N), of the reported probability, plus
/// the receipt bound. The source is fixed, so the outcome is fixed.
fn frequencies_match(d: &[f64], seed: u64) {
    const N: usize = 400_000;
    let mut rng = XorShift::new(seed);
    let mut hits = vec![0usize; d.len()];
    let probabilities = reported(d);
    for _ in 0..N {
        let at = stable_cdf(d, unit(rng.unit())).unwrap();
        assert_eq!(
            at.probability().to_bits(),
            probabilities[at.index()].to_bits()
        );
        hits[at.index()] += 1;
    }
    for (j, q) in probabilities.iter().enumerate() {
        let observed = hits[j] as f64 / N as f64;
        let bound = 5.0 * (q * (1.0 - q) / N as f64).sqrt() + BOUND;
        assert!(
            (observed - q).abs() <= bound,
            "comment {j}: observed {observed}, reported {q}, bound {bound}"
        );
    }
}

#[test]
fn the_computed_floor_includes_the_marginal_total_rounding() {
    let mut base = vec![0.0; 1000];
    base[999] = 1.0;
    let m = floor_marginals(0.1, &base).unwrap();
    let total = m.draw_weights().iter().fold(0.0, |s, d| s + d);
    let r = stable_cdf(m.draw_weights(), unit(0.0)).unwrap();
    assert_eq!(r.index(), 0);
    assert_eq!(
        r.probability().to_bits(),
        (m.uniform()[0] / total).to_bits()
    );
    // Normalising a rounded running sum can move the floor by more than
    // four unit roundoffs. This is not a loss of the uniform lane's share.
    assert!(r.probability() < (0.1 / 1000.0) * (1.0 - 4.0 * U));
    close(
        first_unit_at_least(m.draw_weights(), 1),
        r.probability(),
        "floor interval",
    );
}

#[test]
fn zero_mass_donation_is_a_branch_not_a_continuity_promise() {
    let empty = floor_marginals(0.1, &[0.0, 0.0]).unwrap();
    let tiny = floor_marginals(0.1, &[0.0, f64::from_bits(1)]).unwrap();
    assert_eq!(empty.draw_weights(), [0.5, 0.5]);
    close(tiny.draw_weights()[0], 0.05, "tiny base uniform part");
    close(tiny.draw_weights()[1], 0.95, "tiny base weighted part");
    assert_eq!(
        stable_cdf(empty.draw_weights(), unit(0.3)).unwrap().index(),
        0
    );
    assert_eq!(
        stable_cdf(tiny.draw_weights(), unit(0.3)).unwrap().index(),
        1
    );
}

#[test]
fn many_seeded_draws_land_as_the_receipts_say() {
    frequencies_match(
        floor_marginals(0.25, &[2.0, 0.0, 6.0])
            .unwrap()
            .draw_weights(),
        7,
    );
    frequencies_match(
        floor_marginals(0.1, &[1.0, 3.0]).unwrap().draw_weights(),
        11,
    );
    frequencies_match(
        floor_marginals(0.1, &[0.0, 0.0, 0.0])
            .unwrap()
            .draw_weights(),
        13,
    );
    frequencies_match(
        floor_marginals(0.1, &[0.0, 1e6, 1.0, 3.5])
            .unwrap()
            .draw_weights(),
        17,
    );
}

#[test]
fn uniform_one_gives_every_candidate_one_nth() {
    assert_eq!(lookup("uniform/1").unwrap(), RuleId::Uniform1);
    let c = cands(&[3, 5, 9]);
    let input = src("participant");
    for (x, want) in [(0.0, 0), (0.34, 1), (0.99, 2)] {
        let r = uniform_1(&c, unit(x), &input).unwrap();
        assert_eq!(r.index(), want);
        assert_eq!(r.probability(), 1.0 / 3.0);
        assert_eq!(r.draw_mode(), DrawMode::StableCdf1);
        assert_eq!(r.weights(), &WeightsUsed::NotRead);
        assert_eq!(r.lanes().len(), 1);
        assert_eq!(r.lanes()[0].lane(), "uniform");
        let back = Drawn::from_plain(&r.to_plain()).unwrap();
        assert_eq!(back, r);
    }
    for p in measured(&[1.0, 1.0, 1.0]) {
        close(p, 1.0 / 3.0, "measured uniform");
    }
    let one = uniform_1(&cands(&[4]), unit(0.7), &input).unwrap();
    assert_eq!(one.probability(), 1.0);
    let mut rng = XorShift::new(3);
    let mut hits = [0usize; 3];
    for _ in 0..300_000 {
        hits[uniform_1(&c, unit(rng.unit()), &input).unwrap().index()] += 1;
    }
    for h in hits {
        let f = h as f64 / 300_000.0;
        assert!((f - 1.0 / 3.0).abs() <= 5.0 * (2.0 / 9.0 / 300_000.0f64).sqrt());
    }
}

// --- symmetric-gic-floor/1 over real weights -------------------------------

const A: CommentId = CommentId::new(1);
const B: CommentId = CommentId::new(2);
const ONLY_COUNTS: CommentId = CommentId::new(3);
const META: CommentId = CommentId::new(4);
const META_UNSCORED: CommentId = CommentId::new(5);
const META_NOWHERE: CommentId = CommentId::new(6);
const STRANGER: CommentId = CommentId::new(7);

fn params(policy: MetaPolicy, floor: f64) -> FloorParams {
    let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
    FloorParams::new(
        SymmetricGicParams::new(base, ConsensusForm::GicGeomean1, GicParams::default()),
        floor,
    )
    .unwrap()
}

fn plan(p: &FloorParams) -> polis_routing_equation::FloorPlan {
    let counts = HistoricalCountFrame::new(
        src("previous"),
        [
            (A, Counts::new(3, 1, 0)),
            (B, Counts::new(0, 4, 2)),
            (ONLY_COUNTS, Counts::new(1, 1, 1)),
            (META, Counts::new(2, 2, 0)),
            (META_UNSCORED, Counts::new(1, 0, 0)),
        ],
    )
    .unwrap();
    let x = |e: f64| Extremity::new(e).unwrap();
    let extremity =
        ExtremityFrame::new(src("current"), [(A, x(0.5)), (B, x(1.25)), (META, x(0.0))]).unwrap();
    let g = |i| GroupId::new(i);
    let groups = CurrentGroupFrame::new(
        src("groups"),
        [(g(0), 10), (g(2), 8)],
        [
            (g(0), A, Counts::new(3, 0, 1)),
            (g(2), A, Counts::new(2, 1, 0)),
            (g(0), B, Counts::new(0, 3, 0)),
        ],
        None,
    )
    .unwrap();
    let meta = MetaComments::new([META, META_UNSCORED, META_NOWHERE]).unwrap();
    let weights = symmetric_gic_1(p.base(), &counts, &extremity, &groups, &meta).unwrap();
    symmetric_gic_floor_1(p, weights, &meta).unwrap()
}

#[test]
fn the_floor_rule_reports_the_true_marginal_and_reads_back() {
    assert_eq!(
        lookup("symmetric-gic-floor/1").unwrap(),
        RuleId::SymmetricGicFloor1
    );
    let p = FloorParams::default();
    assert_eq!(
        ParamSet::default_for(RuleId::SymmetricGicFloor1),
        ParamSet::SymmetricGicFloor1(p)
    );
    let plan = plan(&p);
    let c = cands(&[A, B, ONLY_COUNTS, META].map(|i| i.get()));
    let w = |id| plan.weights().get(id).unwrap().weight().get();
    // The base lane: the two scored weights, the unscored comment at 1, the
    // fixed meta comment at 49.
    let base = [w(A), w(B), 1.0, 49.0];
    assert_eq!(w(META), 49.0);
    let total: f64 = base.iter().fold(0.0, |s, x| s + x);
    let m = plan.probabilities(&c).unwrap();
    for j in 0..4 {
        // q_j = 0.1 / 4 + 0.9 * w_j / W, written out.
        let hand = 0.1 / 4.0 + 0.9 * base[j] / total;
        close(m.draw_weights()[j], hand, "marginal");
    }
    let d = m.draw_weights().to_vec();
    let p_measured = measured(&d);
    let input = src("participant");
    let mut rng = XorShift::new(99);
    for _ in 0..200 {
        let x = rng.unit();
        let r = plan.draw(&c, unit(x), &src("weights-map"), &input).unwrap();
        let j = r.index();
        close(
            r.probability(),
            p_measured[j],
            "receipt against the measured units",
        );
        assert!(r.probability() >= 0.1 / 4.0 * (1.0 - 4.0 * U));
        let [u, wl] = r.lanes() else { panic!() };
        assert_eq!((u.lane(), wl.lane()), ("uniform", "weights"));
        close(
            u.contribution() + wl.contribution(),
            r.probability(),
            "lanes add up",
        );
        assert_eq!(r.flags().absent_mapped_to_one(), 1);
        assert!(r.flags().donations().is_empty());
        assert_eq!(r.rule_params(), &ParamSet::SymmetricGicFloor1(p));
        match r.weights() {
            WeightsUsed::Map {
                provenance: WeightProvenance::Corrected(c),
                ..
            } => {
                assert_eq!(c.params(), &ParamSet::SymmetricGic1(*p.base()));
                assert_eq!(c.current_groups().unwrap().as_str(), "groups");
            }
            other => panic!("{other:?}"),
        }
        let text = r.to_plain();
        assert_eq!(Drawn::from_plain(&text).unwrap().to_plain(), text);
    }
    frequencies_match(&d, 23);
}

#[test]
fn exclusion_is_decided_before_scoring_and_holds_in_every_lane() {
    let p = params(MetaPolicy::Exclude, 0.1);
    let plan = plan(&p);
    let input = src("participant");
    // A scored meta comment, a meta comment in only one frame, and a meta
    // comment in neither frame: each is refused, never given a floor chance.
    for id in [META, META_UNSCORED, META_NOWHERE] {
        let c = cands(&[A.get(), id.get()]);
        assert_eq!(
            plan.draw(&c, unit(0.0), &src("w"), &input).unwrap_err(),
            DrawRefusal::ExcludedCandidate(id)
        );
        assert_eq!(
            plan.probabilities(&c).unwrap_err(),
            DrawRefusal::ExcludedCandidate(id)
        );
    }
    // A comment in neither frame that is not meta has no facts.
    assert_eq!(
        plan.draw(
            &cands(&[A.get(), STRANGER.get()]),
            unit(0.0),
            &src("w"),
            &input
        )
        .unwrap_err(),
        DrawRefusal::NeedsBaseline(STRANGER)
    );
    // Under the fixed policy the same meta comment in neither frame is not
    // excluded: it has no facts.
    let fixed = plan_fixed();
    assert_eq!(
        fixed
            .draw(&cands(&[META_NOWHERE.get()]), unit(0.0), &src("w"), &input)
            .unwrap_err(),
        DrawRefusal::NeedsBaseline(META_NOWHERE)
    );
}

fn plan_fixed() -> polis_routing_equation::FloorPlan {
    plan(&FloorParams::default())
}

#[test]
fn a_floor_plan_refuses_weights_its_base_did_not_compute() {
    let p = FloorParams::default();
    let counts = HistoricalCountFrame::new(src("previous"), [(A, Counts::new(1, 0, 0))]).unwrap();
    let e = ExtremityFrame::new(src("current"), [(A, Extremity::new(0.0).unwrap())]).unwrap();
    let groups = CurrentGroupFrame::new(src("groups"), [], [], None).unwrap();
    let meta = MetaComments::none();
    let other = params(MetaPolicy::Ordinary, 0.1);
    let w = symmetric_gic_1(other.base(), &counts, &e, &groups, &meta).unwrap();
    assert_eq!(
        symmetric_gic_floor_1(&p, w, &meta).unwrap_err(),
        Refusal::BaseMismatch
    );
    let w = symmetric_1(p.base().base(), &counts, &e, &meta).unwrap();
    assert_eq!(
        symmetric_gic_floor_1(&p, w, &meta).unwrap_err(),
        Refusal::BaseMismatch
    );
    let w = symmetric_gic_1(p.base(), &counts, &e, &groups, &meta).unwrap();
    assert!(symmetric_gic_floor_1(&p, w, &meta).is_ok());
    for bad in [-0.01, 1.0, f64::NAN] {
        assert!(FloorParams::new(*p.base(), bad).is_err());
    }
    assert_eq!(
        FloorParams::new(*p.base(), -0.0)
            .unwrap()
            .floor_share()
            .to_bits(),
        0
    );
}

#[test]
fn the_receipt_reader_refuses_inconsistent_floor_and_uniform_receipts() {
    let plan = plan_fixed();
    let c = cands(&[A.get(), B.get(), ONLY_COUNTS.get()]);
    let r = plan.draw(&c, unit(0.3), &src("w"), &src("p")).unwrap();
    let good = r.to_plain();
    let tampered = [
        good.replacen(
            "\"draw_mode\":\"stable-cdf/1\"",
            "\"draw_mode\":\"legacy-cdf/1\"",
            1,
        ),
        good.replacen(
            "\"donations\":[]",
            "\"donations\":[\"weights->uniform:zero_mass\"]",
            1,
        ),
        good.replacen("\"donations\":[]", "\"donations\":[\"something\"]", 1),
        good.replacen(
            "\"absent_mapped_to_one\":1",
            "\"absent_mapped_to_one\":4",
            1,
        ),
        good.replacen("\"lane\":\"uniform\"", "\"lane\":\"weights\"", 1),
        good.replacen("\"floor_share\":0.1", "\"floor_share\":0.2", 1),
        good.replacen(
            &format!(
                "\"probability\":{}",
                serde_json::to_string(&r.probability()).unwrap()
            ),
            &format!(
                "\"probability\":{}",
                serde_json::to_string(&(r.probability() * 1.001)).unwrap()
            ),
            1,
        ),
    ];
    for t in tampered {
        assert_ne!(t, good);
        assert!(Drawn::from_plain(&t).is_err(), "accepted {t}");
    }
    // A receipt whose shares were all altered consistently (share, its part,
    // the probability) is still refused: the share must be the rule's.
    let n = 3.0f64;
    let num = |x: f64| serde_json::to_string(&x).unwrap();
    let [lu, lw] = r.lanes() else { panic!() };
    let shifted = good
        .replacen(
            &format!("\"lane\":\"uniform\",\"share\":{}", num(lu.share())),
            &format!("\"lane\":\"uniform\",\"share\":{}", num(0.2)),
            1,
        )
        .replacen(
            &format!("\"contribution\":{}", num(lu.contribution())),
            &format!("\"contribution\":{}", num(0.2 / n)),
            1,
        )
        .replacen(
            &format!("\"probability\":{}", num(r.probability())),
            &format!("\"probability\":{}", num(0.2 / n + lw.contribution())),
            1,
        );
    assert_ne!(shifted, good);
    assert!(Drawn::from_plain(&shifted).is_err(), "accepted {shifted}");
    // The donated shape, written by hand for three candidates: shares 1 and
    // 0, W = 0, parts 1/3 and 0, probability 1/3. The reader accepts it with
    // the zero-mass donation and refuses it with any other donation.
    let lanes_at = good.find("\"lanes\":[").unwrap();
    let lanes_end = lanes_at + good[lanes_at..].find(']').unwrap() + 1;
    let third = num(1.0 / 3.0);
    let donated = format!(
        "{}\"lanes\":[{{\"lane\":\"uniform\",\"share\":1.0,\"normaliser\":3.0,\"contribution\":{third}}},{{\"lane\":\"weights\",\"share\":0.0,\"normaliser\":0.0,\"contribution\":0.0}}]{}",
        &good[..lanes_at],
        &good[lanes_end..]
    )
    .replacen(
        &format!("\"probability\":{}", num(r.probability())),
        &format!("\"probability\":{third}"),
        1,
    );
    let ok = donated.replacen(
        "\"donations\":[]",
        "\"donations\":[\"weights->uniform:zero_mass\"]",
        1,
    );
    let back = Drawn::from_plain(&ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
    assert_eq!(back.flags().donations(), [ZERO_MASS_DONATION.to_string()]);
    for bad in [
        donated.clone(),
        donated.replacen(
            "\"donations\":[]",
            "\"donations\":[\"weights->uniform:other\"]",
            1,
        ),
    ] {
        assert!(Drawn::from_plain(&bad).is_err(), "accepted {bad}");
    }
    // A stored-weights/1 receipt must name the legacy arithmetic.
    let stored = polis_routing_equation::stored_weights_1(None, &c, unit(0.5), &src("p"))
        .unwrap()
        .to_plain();
    let restyled = stored.replacen("\"legacy-cdf/1\"", "\"stable-cdf/1\"", 1);
    assert_ne!(restyled, stored);
    assert!(Drawn::from_plain(&restyled).is_err());
    let u = uniform_1(&c, unit(0.5), &src("p")).unwrap().to_plain();
    for t in [
        u.replacen("\"index\":1", "\"index\":2", 1),
        u.replacen("{\"kind\":\"not-read\"}", "{\"kind\":\"no-map\"}", 1),
        u.replacen("\"rule\":\"uniform/1\"", "\"rule\":\"stored-weights/1\"", 1),
    ] {
        assert_ne!(t, u);
        assert!(Drawn::from_plain(&t).is_err(), "accepted {t}");
    }
}
