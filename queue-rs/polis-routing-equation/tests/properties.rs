//! The properties of historical/1 (H1 to H9) and of the draw (D1 to D9), each
//! re-derived from its formula before it was written. Real-number statements
//! are tested as non-strict in f64 over grids, with strict witnesses where the
//! values are well separated.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, Counts, DrawRefusal, Extremity, ExtremityFrame, FactorName,
    HistoricalCountFrame, HistoricalParams, MIN_TOTAL, MetaComments, Refusal, StoredWeight,
    StoredWeights, Unit, WEIGHT_CEILING, cdf, historical_1, stored_weights_1,
};
use support::{XorShift, src, w, weight_of};

const E_GRID: [f64; 6] = [0.0, 5e-324, 0.1, 1.0, 3.7, 400.0];
const U: f64 = 1.0 / 9007199254740992.0; // 2^-53

fn lower() -> HistoricalParams {
    HistoricalParams::new(1e-3, 1e-3, 2e-3, 1e-3, 0.0, 1e-3, 4, 1e-3).unwrap()
}
fn upper() -> HistoricalParams {
    HistoricalParams::new(1000.0, 999.0, 1000.0, 100.0, 1000.0, 1e6, 4, 1e6).unwrap()
}

#[test]
fn h1_a_weight_is_a_positive_normal_number_at_most_the_ceiling_or_refused() {
    let counts = [0u32, 1, 2, 7, 280, u32::MAX];
    for params in [HistoricalParams::default(), lower(), upper()] {
        for &a in &counts {
            for &d in &counts {
                for &p in &counts {
                    for e in [0.0, 1e-300, 0.5, 3.0, 1e70] {
                        match weight_of(&params, Counts::new(a, d, p), e, false) {
                            Ok(x) => {
                                assert!(x.is_normal() && x > 0.0 && x <= WEIGHT_CEILING, "{x:e}")
                            }
                            Err(Refusal::WeightOutOfRange { .. }) => {
                                assert!(!params.is_default(), "defaults refused at {a} {d} {p} {e}")
                            }
                            Err(other) => panic!("{other}"),
                        }
                    }
                }
            }
        }
    }
    // Two cases off the defaults, computed by hand. The upper set with no
    // votes and E = 1e70: (0.001 x (1e70 + 100) x 1 x 1001)^4, about 1e284,
    // is above the ceiling and refused. The lower set with no votes and
    // E = 3: (0.5 x 3.001 x 0.5 x 1)^4 = 0.75025^4.
    assert!(matches!(
        weight_of(&upper(), Counts::default(), 1e70, false),
        Err(Refusal::WeightOutOfRange { .. })
    ));
    let low = weight_of(&lower(), Counts::default(), 3.0, false).unwrap();
    assert!((low - 0.75025f64.powi(4)).abs() <= 1e-15, "{low:e}");
}

#[test]
fn h2_one_more_pass_lowers_the_weight() {
    for e in E_GRID {
        for a in 0..=12u32 {
            for d in 0..=12u32 {
                for p in 0..=40u32 {
                    let (now, next) = (w(a, d, p, e), w(a, d, p + 1, e));
                    if a + d + p < 20 {
                        assert!(next < now, "{a} {d} {p} {e}");
                    } else {
                        assert!(next <= now, "{a} {d} {p} {e}");
                    }
                }
            }
        }
    }
}

#[test]
fn h3_and_h4_turning_a_disagree_or_a_pass_into_an_agree_raises_the_weight() {
    for e in E_GRID {
        for a in 0..=15u32 {
            for d in 0..=15u32 {
                for p in 0..=15u32 {
                    let strict = a + d + p <= 20;
                    let check = |raised: f64, base: f64| {
                        if strict {
                            assert!(raised > base, "{a} {d} {p} {e}");
                        } else {
                            assert!(raised >= base, "{a} {d} {p} {e}");
                        }
                    };
                    if d > 0 {
                        check(w(a + 1, d - 1, p, e), w(a, d, p, e)); // H3
                    }
                    if p > 0 {
                        check(w(a + 1, d, p - 1, e), w(a, d, p, e)); // H4, pass to agree
                        check(w(a, d + 1, p - 1, e), w(a, d, p, e)); // H4, pass to disagree
                    }
                }
            }
        }
    }
}

#[test]
fn h5_one_more_agree_does_not_always_raise_the_weight() {
    let ratio = w(6, 0, 0, 0.0) / w(5, 0, 0, 0.0);
    assert!((ratio - 0.87269).abs() < 5e-6, "{ratio}");
}

#[test]
fn h6_no_votes_is_not_the_largest_weight() {
    assert_eq!(w(0, 0, 0, 0.0), 5.0625);
    assert!(((w(1, 0, 0, 0.0) - 12.529726250088045) / 12.529726250088045).abs() < 1e-12);
    let three = w(3, 0, 0, 0.0);
    assert!(((three - 16.143843865255583) / 16.143843865255583).abs() < 1e-12);
    for a in 0..=40u32 {
        assert!(w(a, 0, 0, 0.0) <= three, "{a}");
    }
    assert!((w(0, 1, 0, 0.0) - 3.1324).abs() < 5e-5);
    assert!((w(0, 0, 1, 0.0) - 0.7831).abs() < 5e-5);
}

#[test]
fn h7_the_weight_does_not_fall_as_extremity_rises() {
    let es = [0.0, 5e-324, 1e-300, 1e-9, 0.1, 1.0, 3.7, 50.0, 400.0, 1e70];
    for (a, d, p) in [(0, 0, 0), (3, 1, 0), (0, 5, 2), (40, 40, 40)] {
        for pair in es.windows(2) {
            assert!(w(a, d, p, pair[1]) >= w(a, d, p, pair[0]));
        }
        assert!(w(a, d, p, 1.0) > w(a, d, p, 0.1));
        assert_eq!(w(a, d, p, 0.0).to_bits(), w(a, d, p, 5e-324).to_bits());
    }
}

fn novelty(seen: u32) -> f64 {
    let id = CommentId::new(0);
    let counts = HistoricalCountFrame::new(src("c"), [(id, Counts::new(seen, 0, 0))]).unwrap();
    let e = ExtremityFrame::new(src("e"), [(id, Extremity::new(0.0).unwrap())]).unwrap();
    let out = historical_1(
        &HistoricalParams::default(),
        &counts,
        &e,
        &MetaComments::none(),
    )
    .unwrap();
    let f = out.get(id).unwrap().explanation().inner()[3];
    assert_eq!(f.name(), FactorName::Novelty);
    f.value()
}

#[test]
fn h8_novelty_is_in_one_to_nine_and_exactly_one_from_280_votes() {
    assert_eq!(novelty(0), 9.0);
    for s in 0..280 {
        let n = novelty(s);
        assert!(n > 1.0 && n <= 9.0, "{s}: {n}");
    }
    for s in [280, 281, 1000, 10000, u32::MAX] {
        assert_eq!(novelty(s), 1.0, "{s}");
    }
}

#[test]
fn h9_a_meta_comment_weighs_49_and_an_unscored_one_none() {
    for (a, d, p) in [(0, 0, 0), (9, 1, 3)] {
        for e in E_GRID {
            let x = weight_of(&HistoricalParams::default(), Counts::new(a, d, p), e, true).unwrap();
            assert_eq!(x.to_bits(), 49.0f64.to_bits());
        }
    }
    let id = CommentId::new(4);
    let counts = HistoricalCountFrame::new(src("c"), [(id, Counts::default())]).unwrap();
    let e = ExtremityFrame::new(src("e"), []).unwrap();
    let meta = MetaComments::new([id]).unwrap();
    let out = historical_1(&HistoricalParams::default(), &counts, &e, &meta).unwrap();
    assert!(
        out.get(id).is_none(),
        "an unscored meta comment has no weight here, and draws at 1"
    );
}

fn index_at(weights: &[f64], u: f64) -> usize {
    cdf(weights, Unit::new(u).unwrap()).unwrap().index()
}

/// The smallest unit (a double) that selects position `j` or a later one.
fn start(weights: &[f64], j: usize) -> f64 {
    if j == 0 {
        return 0.0;
    }
    let (mut lo, mut hi) = (0u64, 1.0f64.to_bits());
    if index_at(weights, 0.0) >= j {
        return 0.0;
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if index_at(weights, f64::from_bits(mid)) >= j {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    f64::from_bits(hi)
}

fn weight_lists() -> Vec<Vec<f64>> {
    let mut lists = vec![
        vec![1.0, 3.0],
        vec![0.0, 2.0, 2.0],
        vec![1.0, 5e-324],
        vec![1e150, 1.0, 1e-9],
        vec![1e-9, 1e6, 1e-9],
        vec![3.0, 3.0, 3.0],
        vec![MIN_TOTAL],
        vec![0.1, 0.2, 0.3, 0.4],
        vec![1e6, 1e-9, 0.0, 1e6, 5e-324, 1.0],
    ];
    let palette = [0.0, 1e-9, 0.5, 1.0, 2.5, 3.0, 1e6, 5e-324];
    let mut rng = XorShift::new(0x5DEECE66D);
    for _ in 0..300 {
        let n = 2 + rng.below(5) as usize;
        let list: Vec<f64> = (0..n)
            .map(|_| match rng.below(10) {
                8 | 9 => rng.unit() * 10.0,
                k => palette[k as usize],
            })
            .collect();
        if list.iter().sum::<f64>() >= MIN_TOTAL {
            lists.push(list);
        }
    }
    lists
}

#[test]
fn d1_d2_d6_the_receipt_is_the_probability_to_within_2_to_the_minus_50() {
    let mut worst = 0f64;
    for list in weight_lists() {
        let total = cdf(&list, Unit::new(0.0).unwrap()).unwrap().total();
        let n = list.len();
        let starts: Vec<f64> = (0..=n)
            .map(|j| if j == n { 1.0 } else { start(&list, j) })
            .collect();
        let mut sum_q = 0.0;
        for j in 0..n {
            let q = list[j] / total;
            sum_q += q;
            let measured = starts[j + 1] - starts[j];
            let gap = (measured - q).abs();
            worst = worst.max(gap);
            assert!(
                gap <= 2f64.powi(-50),
                "{list:?} position {j}: measured {measured:e}, q {q:e}"
            );
            if measured > 0.0 {
                let receipt = cdf(&list, Unit::new(starts[j]).unwrap()).unwrap();
                assert_eq!(receipt.index(), j);
                assert_eq!(receipt.probability().to_bits(), q.to_bits());
                assert!((receipt.probability() - measured).abs() <= 2f64.powi(-50));
            }
            if list[j] == 0.0 {
                assert_eq!(measured, 0.0, "D2: a zero weight is never chosen: {list:?}");
            }
        }
        assert!(
            (sum_q - 1.0).abs() <= 3.0 * n as f64 * U,
            "D6: {list:?} {sum_q}"
        );
    }
    println!("D1: worst |P - q| over the lists: {worst:e}");
}

#[test]
fn d3_no_failure_at_totals_from_2_to_the_minus_1021_and_refusal_below() {
    let below_one = f64::from_bits(1.0f64.to_bits() - 1);
    let mut rng = XorShift::new(77);
    for _ in 0..20000 {
        let t = MIN_TOTAL * (1.0 + rng.unit()) * 2f64.powi(rng.below(60) as i32);
        for u in [0.0, rng.unit(), below_one] {
            assert!(cdf(&[t], Unit::new(u).unwrap()).is_ok(), "{t:e} {u}");
            assert!(
                cdf(&[t / 2.0, t / 2.0], Unit::new(u).unwrap()).is_ok()
                    || t / 2.0 + t / 2.0 < MIN_TOTAL
            );
        }
    }
    for t in [f64::MIN_POSITIVE, 5e-324, MIN_TOTAL / 2.0, 0.0] {
        assert_eq!(
            cdf(&[t], Unit::new(below_one).unwrap()),
            Err(DrawRefusal::TotalBelowNormal)
        );
    }
}

#[test]
fn d4_a_single_positive_candidate_is_certain() {
    let below_one = f64::from_bits(1.0f64.to_bits() - 1);
    for x in [MIN_TOTAL, 1e-9, 1.0, 49.0, 1e150] {
        for u in [0.0, 0.5, below_one] {
            let r = cdf(&[x], Unit::new(u).unwrap()).unwrap();
            assert_eq!((r.index(), r.probability()), (0, 1.0));
        }
    }
}

#[test]
fn d5_scaling_by_a_power_of_two_changes_only_random_n_by_that_power() {
    let mut rng = XorShift::new(5);
    for list in weight_lists()
        .into_iter()
        .filter(|l| l.iter().all(|w| *w == 0.0 || (*w >= 1e-9 && *w <= 1e6)))
    {
        for k in [-900, -3, 1, 10, 400] {
            let s = 2f64.powi(k);
            let scaled: Vec<f64> = list.iter().map(|w| w * s).collect();
            let u = Unit::new(rng.unit()).unwrap();
            let (a, b) = (cdf(&list, u).unwrap(), cdf(&scaled, u).unwrap());
            assert_eq!(a.index(), b.index());
            assert_eq!(a.probability().to_bits(), b.probability().to_bits());
            assert_eq!((a.random_n() * s).to_bits(), b.random_n().to_bits());
        }
    }
}

#[test]
fn d7_absorbed_candidates_are_flagged() {
    let r = cdf(&[1.0, 5e-324], Unit::new(0.5).unwrap()).unwrap();
    assert_eq!(r.absorbed(), &[1]);
    let stored = StoredWeights::new(
        src("m"),
        [
            (CommentId::new(8), StoredWeight::Number(1.0)),
            (CommentId::new(9), StoredWeight::Number(5e-324)),
        ],
    )
    .unwrap();
    let c = Candidates::new(vec![CommentId::new(8), CommentId::new(9)]).unwrap();
    let d = stored_weights_1(Some(&stored), &c, Unit::new(0.5).unwrap(), &src("p")).unwrap();
    assert_eq!(d.flags().absorbed(), &[CommentId::new(9)]);
    // The legacy mapping, counted by reason: a 0, a null and a false, and a
    // candidate absent from the map, each read as 1, and a 3 read as itself.
    let ids: Vec<CommentId> = (0..5).map(CommentId::new).collect();
    let stored = StoredWeights::new(
        src("m"),
        [
            (ids[0], StoredWeight::Number(0.0)),
            (ids[1], StoredWeight::Null),
            (ids[2], StoredWeight::False),
            (ids[3], StoredWeight::Number(3.0)),
        ],
    )
    .unwrap();
    let c = Candidates::new(ids).unwrap();
    let d = stored_weights_1(Some(&stored), &c, Unit::new(0.0).unwrap(), &src("p")).unwrap();
    assert_eq!(d.flags().zero_mapped_to_one(), 1);
    assert_eq!(d.flags().null_or_false_mapped_to_one(), 2);
    assert_eq!(d.flags().absent_mapped_to_one(), 1);
    assert_eq!(d.lanes()[0].normaliser(), 7.0);
    assert_eq!(d.probability(), 1.0 / 7.0);
}

#[test]
fn d8_a_result_does_not_depend_on_the_order_facts_are_given_in() {
    let mut rng = XorShift::new(11);
    let mut facts: Vec<(CommentId, Counts, f64)> = (0..30)
        .map(|t| {
            let c = Counts::new(
                rng.below(9) as u32,
                rng.below(9) as u32,
                rng.below(9) as u32,
            );
            (CommentId::new(t), c, rng.unit() * 5.0)
        })
        .collect();
    let build = |f: &[(CommentId, Counts, f64)]| {
        let counts =
            HistoricalCountFrame::new(src("c"), f.iter().map(|(i, c, _)| (*i, *c))).unwrap();
        let e = ExtremityFrame::new(
            src("e"),
            f.iter().map(|(i, _, e)| (*i, Extremity::new(*e).unwrap())),
        )
        .unwrap();
        historical_1(
            &HistoricalParams::default(),
            &counts,
            &e,
            &MetaComments::new([CommentId::new(3)]).unwrap(),
        )
        .unwrap()
    };
    let first = build(&facts);
    facts.reverse();
    facts.swap(2, 17);
    assert_eq!(build(&facts), first);
}

#[test]
fn d9_the_explanation_evaluated_left_to_right_is_the_weight_bit_for_bit() {
    let mut rng = XorShift::new(13);
    for _ in 0..5000 {
        let id = CommentId::new(0);
        let (agreed, disagreed, passed) = (
            rng.below(50) as u32,
            rng.below(50) as u32,
            rng.below(50) as u32,
        );
        let c = Counts::new(agreed, disagreed, passed);
        let extremity = rng.unit() * 100.0;
        let counts = HistoricalCountFrame::new(src("c"), [(id, c)]).unwrap();
        let e = ExtremityFrame::new(src("e"), [(id, Extremity::new(extremity).unwrap())]).unwrap();
        let out = historical_1(
            &HistoricalParams::default(),
            &counts,
            &e,
            &MetaComments::none(),
        )
        .unwrap();
        let s = out.get(id).unwrap();
        let names: Vec<_> = s
            .explanation()
            .inner()
            .iter()
            .map(|f| f.name().as_str())
            .collect();
        assert_eq!(
            names,
            [
                "not_pass_share",
                "extremity_boost",
                "agree_share",
                "novelty"
            ]
        );
        assert_eq!(s.explanation().exponent(), 2);
        // Each factor against the Python expression written out again here,
        // `importance_metric` and `priority_metric` at their defaults.
        let seen = f64::from(agreed + disagreed + passed);
        let p = (f64::from(passed) + 1.0) / (seen + 2.0);
        let a = (f64::from(agreed) + 1.0) / (seen + 2.0);
        let expected = [
            1.0 - p,
            extremity + 1.0,
            a,
            1.0 + 8.0 * 2f64.powf(-seen / 5.0),
        ];
        for (f, x) in s.explanation().inner().iter().zip(expected) {
            assert_eq!(f.value().to_bits(), x.to_bits(), "{:?}", f.name());
        }
        let product = expected[0] * expected[1] * expected[2] * expected[3];
        assert_eq!(s.weight().get().to_bits(), (product * product).to_bits());
        assert_eq!(
            s.explanation().evaluate().to_bits(),
            s.weight().get().to_bits()
        );
    }
}
