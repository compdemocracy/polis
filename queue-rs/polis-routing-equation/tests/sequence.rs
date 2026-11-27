//! The caller's sequence for `symmetric-gic-floor/1`: one `FloorPlan::draw`
//! call, with no `probabilities` preflight. These tests pin what makes that
//! sound for this rule and this API version, and nothing more:
//!
//! - every refusal of the draw depends on the plan and the candidates, never
//!   on the unit: across endpoint, boundary and random units a list is
//!   refused alike or drawn;
//! - the branches after the unit is read (`NoInterval` in the CDF and the
//!   index checks after it) are unreachable for every admitted unit: shown
//!   over every binade of admitted totals and by properties of accepted
//!   weight vectors;
//! - the sequence with the preflight (P) and without it (S) refuse alike and
//!   choose the same comment, with the same receipt, for the same unit, on a
//!   large seeded sample of constructed plans and candidate lists.
//!
//! Constructed data only: named, unsigned counts; no vote value anywhere.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_equation::{
    Candidates, CommentId, ConsensusForm, Counts, CurrentGroupFrame, DrawRefusal, Drawn, Extremity,
    ExtremityFrame, FloorParams, FloorPlan, GicParams, GroupId, HistoricalCountFrame, MIN_TOTAL,
    MetaComments, MetaPolicy, SourceId, SymmetricGicParams, SymmetricParams, Unit, cdf,
    floor_marginals, stable_cdf, symmetric_gic_1, symmetric_gic_floor_1,
};

/// The largest unit below 1: 1 - 2^-53.
const LARGEST_BELOW_ONE: f64 = 1.0 - f64::EPSILON / 2.0;

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
        self.next() % n
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn src(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

/// The units every list is drawn at: both ends of the admitted range, the
/// smallest positive and normal values, a half, and random units.
fn units(rng: &mut XorShift) -> Vec<Unit> {
    let mut u = vec![
        0.0,
        f64::from_bits(1),
        f64::MIN_POSITIVE,
        0.5,
        LARGEST_BELOW_ONE,
        f64::from_bits(LARGEST_BELOW_ONE.to_bits() - 1),
    ];
    u.extend((0..6).map(|_| rng.unit()));
    u.into_iter().map(|x| Unit::new(x).unwrap()).collect()
}

/// A constructed plan through the public constructors, and its comments:
/// scored ones (in both frames, with cells in some groups), unscored ones
/// (extremity only), declared meta comments (some scored, some in neither
/// frame), in creation order.
struct Built {
    plan: FloorPlan,
    known: Vec<CommentId>,
    meta: Vec<CommentId>,
}

fn constructed(rng: &mut XorShift, n: usize) -> Built {
    let policy = match rng.below(3) {
        0 => MetaPolicy::Exclude,
        1 => MetaPolicy::Fixed,
        _ => MetaPolicy::Ordinary,
    };
    let groups = [0u32, 1, 2, 5][rng.below(4) as usize];
    let share = [0.0, 0.1, 0.5, 0.9][rng.below(4) as usize];
    let mut counts = vec![];
    let mut extremity = vec![];
    let mut cells = vec![];
    let mut known = vec![];
    let mut meta = vec![];
    for i in 0..n {
        let id = CommentId::new(5 * i as u32 + 1 + rng.below(4) as u32);
        let r = rng.below(10);
        if r == 0 {
            // Declared meta and in neither frame.
            meta.push(id);
            continue;
        }
        known.push(id);
        extremity.push((id, Extremity::new(3.0 * rng.unit()).unwrap()));
        if r == 1 {
            continue; // unscored: no counts
        }
        let (mut a, mut d, mut s) = (0u64, 0u64, 0u64);
        for g in 0..groups {
            if rng.below(10) < 9 {
                let seen = rng.below(300);
                let agreed = rng.below(seen + 1);
                let disagreed = rng.below(seen - agreed + 1);
                cells.push((
                    GroupId::new(g),
                    id,
                    Counts::from_seen(agreed as u32, disagreed as u32, seen).unwrap(),
                ));
                a += agreed;
                d += disagreed;
                s += seen;
            }
        }
        counts.push((id, Counts::from_seen(a as u32, d as u32, s).unwrap()));
        if r == 2 {
            meta.push(id);
        }
    }
    let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
    let params = FloorParams::new(
        SymmetricGicParams::new(base, ConsensusForm::GicGeomean1, GicParams::default()),
        share,
    )
    .unwrap();
    let counts = HistoricalCountFrame::new(src("constructed:counts"), counts).unwrap();
    let extremity = ExtremityFrame::new(src("constructed:extremity"), extremity).unwrap();
    let members: Vec<(GroupId, u32)> = (0..groups).map(|g| (GroupId::new(g), 400)).collect();
    let groups = CurrentGroupFrame::new(src("constructed:groups"), members, cells, None).unwrap();
    let meta_set = MetaComments::new(meta.clone()).unwrap();
    let w = symmetric_gic_1(params.base(), &counts, &extremity, &groups, &meta_set).unwrap();
    Built {
        plan: symmetric_gic_floor_1(&params, w, &meta_set).unwrap(),
        known,
        meta,
    }
}

/// Candidate lists of several classes over one plan: a shuffled subset of
/// the known comments, all of them in creation order, one, one with an id
/// the plan does not know, one with a declared meta comment.
fn lists(rng: &mut XorShift, b: &Built) -> Vec<Vec<CommentId>> {
    let mut subset: Vec<CommentId> = b
        .known
        .iter()
        .copied()
        .filter(|_| rng.below(3) > 0)
        .collect();
    for i in (1..subset.len()).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        subset.swap(i, j);
    }
    let mut out = vec![subset.clone(), b.known.clone()];
    if let Some(first) = b.known.first() {
        out.push(vec![*first]);
    }
    let mut unknown = subset.clone();
    unknown.insert(
        rng.below(unknown.len() as u64 + 1) as usize,
        CommentId::new(u32::MAX - 7),
    );
    out.push(unknown);
    if !b.meta.is_empty() {
        let mut with_meta = subset;
        let m = b.meta[rng.below(b.meta.len() as u64) as usize];
        with_meta.insert(rng.below(with_meta.len() as u64 + 1) as usize, m);
        out.push(with_meta);
    }
    out
}

#[test]
fn the_draws_refusals_do_not_depend_on_the_unit_and_both_sequences_agree() {
    let mut rng = XorShift(0x2545_f491_4f6c_dd1d);
    let (ws, input) = (src("plan"), src("participant"));
    // ok, excluded, needs a baseline, empty after Candidates::new.
    let mut seen = [0usize; 4];
    let mut draws = 0usize;
    for case in 0..500 {
        let n = if case % 50 == 0 {
            rng.below(1500) as usize + 1
        } else {
            rng.below(120) as usize + 1
        };
        let b = constructed(&mut rng, n);
        for ids in lists(&mut rng, &b) {
            let Ok(c) = Candidates::new(ids) else {
                seen[3] += 1;
                continue;
            };
            let units = units(&mut rng);
            let first = b.plan.draw(&c, units[0], &ws, &input);
            for u in &units {
                let s: Result<Drawn, DrawRefusal> = b.plan.draw(&c, *u, &ws, &input);
                let p = b
                    .plan
                    .probabilities(&c)
                    .and_then(|_| b.plan.draw(&c, *u, &ws, &input));
                draws += 1;
                assert_eq!(p, s, "case {case}: P and S at {u:?}");
                match (&s, &first) {
                    (Err(e), Err(f)) => assert_eq!(e, f, "case {case}: the refusal at {u:?}"),
                    (Ok(d), Ok(_)) => {
                        assert!(d.index() < c.len());
                        assert_eq!(c.ids()[d.index()], d.comment());
                        assert_eq!(Drawn::from_plain(&d.to_plain()).unwrap(), *d);
                    }
                    _ => panic!("case {case}: refused at one unit and drawn at another"),
                }
                if let Err(e) = &s {
                    assert_ne!(*e, DrawRefusal::NoInterval, "case {case}");
                }
            }
            match first {
                Ok(_) => seen[0] += 1,
                Err(DrawRefusal::ExcludedCandidate(_)) => seen[1] += 1,
                Err(DrawRefusal::NeedsBaseline(_)) => seen[2] += 1,
                Err(e) => panic!("case {case}: an unexpected refusal {e:?}"),
            }
        }
    }
    println!("sequence: {draws} draws compared, classes {seen:?}");
    assert!(seen[..3].iter().all(|s| *s > 0), "coverage {seen:?}");
    assert!(draws > 20_000);
}

#[test]
fn the_numerical_refusals_do_not_depend_on_the_unit() {
    let mut rng = XorShift(0x9e37_79b9_7f4a_7c15);
    let tiny = f64::from_bits(1); // the smallest positive double
    let classes: Vec<(Vec<f64>, DrawRefusal)> = vec![
        (vec![], DrawRefusal::Empty),
        (vec![0.0; 7], DrawRefusal::ZeroMass),
        (vec![tiny; 3], DrawRefusal::TotalBelowNormal),
        (vec![MIN_TOTAL / 4.0; 3], DrawRefusal::TotalBelowNormal),
        (vec![1.0, 1e-13, 2.0], DrawRefusal::NumericDegeneracy(1)),
        (vec![1.0, f64::NAN], DrawRefusal::InvalidDrawWeight(1)),
        (vec![1e151, 1.0], DrawRefusal::InvalidDrawWeight(0)),
        (vec![1.0, -1.0], DrawRefusal::InvalidDrawWeight(1)),
    ];
    for (weights, refusal) in &classes {
        for u in units(&mut rng) {
            assert_eq!(
                stable_cdf(weights, u).err(),
                Some(refusal.clone()),
                "{weights:?} at {u:?}"
            );
        }
    }
    // Through the floor's marginals: a share of 0 keeps a degenerate base
    // degenerate, at every unit.
    let m = floor_marginals(0.0, &[1.0, 1e-13]).unwrap();
    for u in units(&mut rng) {
        assert_eq!(
            stable_cdf(m.draw_weights(), u).err(),
            Some(DrawRefusal::NumericDegeneracy(1))
        );
    }
}

/// For every binade of admitted totals T (from 2^-1021, the smallest total
/// the CDF accepts, to the largest finite double), at its first and last 256
/// significands and 256 random ones: the largest unit times T rounds
/// strictly below T. Rounding is monotone, so every admitted unit's product
/// is below T, so the final cumulative entry (T itself) lies above it and an
/// interval exists.
#[test]
fn every_admitted_unit_times_every_admitted_total_stays_below_the_total() {
    let mut rng = XorShift(0x1234_5678_9abc_def1);
    assert_eq!(
        MIN_TOTAL,
        f64::from_bits(2u64 << 52),
        "2^-1021 is the second binade"
    );
    let mut checked = 0u64;
    for exponent in 2u64..=2046 {
        let mut significands: Vec<u64> = (0..256).chain((1u64 << 52) - 256..1u64 << 52).collect();
        significands.extend((0..256).map(|_| rng.next() & ((1u64 << 52) - 1)));
        for m in significands {
            let t = f64::from_bits((exponent << 52) | m);
            assert!(t.is_finite() && t >= MIN_TOTAL);
            assert!(LARGEST_BELOW_ONE * t < t, "{t:e}");
            checked += 1;
        }
    }
    println!("sequence: {checked} admitted totals checked");
}

/// A weight vector that the CDF accepts: zeros, values over a wide range of
/// magnitudes and exact powers of two, scaled by a power of two.
fn accepted_weights(rng: &mut XorShift) -> Vec<f64> {
    let len = rng.below(64) as usize + 1;
    let scale = 2f64.powi(rng.below(1200) as i32 - 700);
    (0..len)
        .map(|_| match rng.below(5) {
            0 => 0.0,
            1 => 2f64.powi(rng.below(40) as i32 - 20) * scale,
            _ => (1.0 + rng.unit()) * 2f64.powi(rng.below(30) as i32 - 15) * scale,
        })
        .collect()
}

#[test]
fn no_admitted_unit_reaches_the_branches_after_the_unit_is_read() {
    let mut rng = XorShift(0xdead_beef_cafe_f00d);
    let mut accepted = 0usize;
    let mut drawn = 0usize;
    for _ in 0..20_000 {
        let w = accepted_weights(&mut rng);
        if w.iter().any(|x| *x > 1e150) {
            continue;
        }
        let Ok(probe) = stable_cdf(&w, Unit::new(0.5).unwrap()) else {
            continue;
        };
        accepted += 1;
        let total = probe.total();
        // Units at every cumulative boundary (just below, at, and just
        // above each entry's share of the total), both ends and random ones.
        let mut us = vec![0.0, LARGEST_BELOW_ONE];
        let mut run = 0.0f64;
        for x in &w {
            run += x;
            let b = run / total;
            for c in [
                f64::from_bits(b.to_bits().saturating_sub(1)),
                b,
                f64::from_bits(b.to_bits() + 1),
            ] {
                if (0.0..1.0).contains(&c) {
                    us.push(c);
                }
            }
        }
        us.extend((0..4).map(|_| rng.unit()));
        for x in us {
            let u = Unit::new(x).unwrap();
            for r in [stable_cdf(&w, u), cdf(&w, u)] {
                let pick = r.unwrap_or_else(|e| panic!("{e:?} at {x:?} over {w:?}"));
                assert!(pick.index() < w.len());
                assert!(w[pick.index()] > 0.0, "a zero weight was chosen");
                drawn += 1;
            }
        }
    }
    println!(
        "sequence: {accepted} accepted weight vectors, {drawn} draws, none without an interval"
    );
    assert!(accepted > 5_000);
}
