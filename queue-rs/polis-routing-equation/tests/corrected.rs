//! The corrected rules `symmetric/1`, `gic-mean/1`, `gic-geomean/1` and
//! `symmetric-gic/1`: their numbers, their properties (S1, S2, G1 to G5) and
//! the counterexamples kept as tests.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    CommentId, ConsensusForm, Counts, CurrentGroupFrame, Extremity, ExtremityFrame, FactorName,
    GicParams, GroupId, HistoricalCountFrame, MetaComments, MetaPolicy, ParamSet, Refusal, RuleId,
    SymmetricGicParams, SymmetricParams, consensus, symmetric_1, symmetric_gic_1,
};
use support::{XorShift, src};

const C: CommentId = CommentId::new(0);

fn one(counts: Counts, e: f64) -> (HistoricalCountFrame, ExtremityFrame) {
    (
        HistoricalCountFrame::new(src("previous"), [(C, counts)]).unwrap(),
        ExtremityFrame::new(src("current"), [(C, Extremity::new(e).unwrap())]).unwrap(),
    )
}

fn sym(params: &SymmetricParams, a: u32, d: u32, p: u32, e: f64) -> f64 {
    let (f, x) = one(Counts::new(a, d, p), e);
    let w = symmetric_1(params, &f, &x, &MetaComments::none()).unwrap();
    w.get(C).unwrap().weight().get()
}

fn s(a: u32, d: u32, p: u32, e: f64) -> f64 {
    sym(&SymmetricParams::default(), a, d, p, e)
}

/// One group: its id, members and its cell for comment 0, if any.
type Spec = (u32, u32, Option<(u32, u32, u32)>);

/// A group frame from (group id, members, [(agreed, disagreed, passed)] for
/// comment 0, or None for no cell).
fn groups(spec: &[Spec]) -> CurrentGroupFrame {
    let members = spec.iter().map(|(g, m, _)| (GroupId::new(*g), *m));
    let cells = spec
        .iter()
        .filter_map(|(g, _, c)| c.map(|(a, d, p)| (GroupId::new(*g), C, Counts::new(a, d, p))));
    CurrentGroupFrame::new(src("groups"), members, cells, None).unwrap()
}

fn g(form: ConsensusForm, spec: &[Spec]) -> f64 {
    consensus(form, &GicParams::default(), &groups(spec), C)
        .g()
        .unwrap()
}

const MEAN: ConsensusForm = ConsensusForm::GicMean1;
const GEO: ConsensusForm = ConsensusForm::GicGeomean1;

#[test]
fn symmetric_weighs_agree_and_disagree_alike_and_keeps_the_documented_numbers() {
    // No votes, the first tick: (1/2 * 1/2 * (1 + E) * 9)^2 = 81/16 (1 + E)^2,
    // the same as historical/1.
    assert_eq!(s(0, 0, 0, 0.0), 5.0625);
    assert_eq!(s(0, 0, 0, 1.0), 81.0 / 16.0 * 4.0);
    assert_eq!(s(0, 0, 0, 0.0), support::w(0, 0, 0, 0.0));
    // One agree and one disagree weigh the same (historical/1: 12.53 and 3.13).
    assert_eq!(s(1, 0, 0, 0.0), 12.529726250088041);
    assert_eq!(s(0, 1, 0, 0.0), 12.529726250088041);
    assert!((support::w(0, 1, 0, 0.0) - 3.1324).abs() < 1e-4);
    assert_eq!(s(0, 0, 1, 0.0), 0.7831078906305026);
    // The largest weight over agrees alone is at three (as historical/1).
    let best = (0..60).max_by(|a, b| s(*a, 0, 0, 0.0).total_cmp(&s(*b, 0, 0, 0.0)));
    assert_eq!(best, Some(3));
    assert_eq!(s(3, 0, 0, 0.0), 16.143843865255583);
    // One more agree can lower it: 5 to 6 agrees multiplies it by 0.87269.
    assert!((s(6, 0, 0, 0.0) / s(5, 0, 0, 0.0) - 0.8726945445828371).abs() < 1e-15);
}

#[test]
fn s1_swapping_agrees_and_disagrees_leaves_the_weight_bit_identical() {
    let mut rng = XorShift::new(41);
    for _ in 0..3000 {
        let a = rng.below(300) as u32;
        let d = rng.below(300) as u32;
        let p = rng.below(300) as u32;
        let e = [0.0, 0.3, 1.0, 7.5, 1e10][rng.below(5) as usize];
        assert_eq!(s(a, d, p, e).to_bits(), s(d, a, p, e).to_bits());
    }
    // Under historical/1 it is not so.
    assert!(support::w(3, 1, 0, 0.0) > support::w(1, 3, 0, 0.0));
}

#[test]
fn s2_one_more_pass_lowers_and_extremity_does_not() {
    for a in 0..12 {
        for d in 0..12 {
            for p in 0..12 {
                let here = s(a, d, p, 0.5);
                let more = s(a, d, p + 1, 0.5);
                assert!(more <= here, "{a} {d} {p}");
                if a + d + p <= 20 {
                    assert!(more < here, "strict at {a} {d} {p}");
                }
            }
        }
    }
    let es = [0.0, 5e-324, 1e-300, 0.1, 1.0, 3.7, 50.0, 400.0, 1e70];
    for pair in es.windows(2) {
        assert!(s(2, 1, 1, pair[0]) <= s(2, 1, 1, pair[1]));
    }
    assert_eq!(s(2, 1, 1, 0.0), s(2, 1, 1, 5e-324));
    assert!(s(2, 1, 1, 0.1) < s(2, 1, 1, 1.0));
}

#[test]
fn symmetric_side_prior_may_equal_seen_prior_and_not_exceed_it() {
    let at = SymmetricParams::new(2.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Fixed).unwrap();
    // R = 1 with no passes.
    assert_eq!(sym(&at, 0, 0, 0, 0.0), 81.0);
    match SymmetricParams::new(2.5, 2.0, 1.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Fixed) {
        Err(e) => assert_eq!(e.name, "side_prior"),
        other => panic!("{other:?}"),
    }
    for bad in [0.0, 1e-4, 1001.0, f64::NAN, f64::INFINITY] {
        assert!(SymmetricParams::new(bad, 2.0, 1.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Fixed).is_err());
    }
    assert!(SymmetricParams::new(1.0, 2.0, 0.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Fixed).is_err());
    assert!(SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 0, 7.0, MetaPolicy::Fixed).is_err());
    assert!(SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 5, 7.0, MetaPolicy::Fixed).is_err());
}

#[test]
fn the_explanation_names_its_factors_and_reproduces_the_weight() {
    let (f, x) = one(Counts::new(4, 2, 1), 0.75);
    let gf = groups(&[(0, 9, Some((3, 1, 0))), (5, 9, Some((1, 1, 1)))]);
    let w = symmetric_gic_1(
        &SymmetricGicParams::default(),
        &f,
        &x,
        &gf,
        &MetaComments::none(),
    )
    .unwrap();
    let scored = w.get(C).unwrap();
    let e = scored.explanation();
    let names: Vec<_> = e.inner().iter().map(|f| f.name()).collect();
    assert_eq!(
        names,
        [
            FactorName::SideShare,
            FactorName::SideShare,
            FactorName::ExtremityBoost,
            FactorName::Novelty
        ]
    );
    assert_eq!(e.outer()[0].name(), FactorName::GroupConsensus);
    assert_eq!(e.evaluate().to_bits(), scored.weight().get().to_bits());
    // The symmetric weight times the factor, bit for bit.
    let factor = consensus(GEO, &GicParams::default(), &gf, C).factor();
    assert_eq!(
        scored.weight().get().to_bits(),
        (s(4, 2, 1, 0.75) * factor).to_bits()
    );
    assert_eq!(w.current_groups().unwrap().as_str(), "groups");
    assert_eq!(w.previous_counts().as_str(), "previous");
}

#[test]
fn meta_follows_the_policy_and_unscored_comments_are_not_multiplied() {
    let meta = CommentId::new(1);
    let only_counts = CommentId::new(2);
    let counts = HistoricalCountFrame::new(
        src("previous"),
        [
            (C, Counts::new(1, 0, 0)),
            (meta, Counts::new(5, 5, 0)),
            (only_counts, Counts::new(1, 1, 1)),
        ],
    )
    .unwrap();
    let e = ExtremityFrame::new(
        src("current"),
        [
            (C, Extremity::new(0.0).unwrap()),
            (meta, Extremity::new(2.0).unwrap()),
        ],
    )
    .unwrap();
    let gf = CurrentGroupFrame::new(
        src("groups"),
        [(GroupId::new(0), 10), (GroupId::new(1), 10)],
        [
            (GroupId::new(0), meta, Counts::new(9, 0, 0)),
            (GroupId::new(1), meta, Counts::new(9, 0, 0)),
            (GroupId::new(0), only_counts, Counts::new(9, 0, 0)),
        ],
        None,
    )
    .unwrap();
    let metas = MetaComments::new([meta]).unwrap();
    let with = |policy| {
        let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
        let p = SymmetricGicParams::new(base, GEO, GicParams::default());
        symmetric_gic_1(&p, &counts, &e, &gf, &metas).unwrap()
    };
    let fixed = with(MetaPolicy::Fixed);
    assert_eq!(fixed.get(meta).unwrap().weight().get(), 49.0);
    assert!(fixed.get(meta).unwrap().explanation().outer().is_empty());
    assert_eq!(fixed.unscored().collect::<Vec<_>>(), vec![only_counts]);
    assert!(fixed.get(only_counts).is_none());
    let ordinary = with(MetaPolicy::Ordinary);
    let factor = consensus(GEO, &GicParams::default(), &gf, meta).factor();
    assert_eq!(
        ordinary.get(meta).unwrap().weight().get(),
        s(5, 5, 0, 2.0) * factor
    );
    let excluded = with(MetaPolicy::Exclude);
    assert!(excluded.get(meta).is_none());
    assert_eq!(excluded.excluded().collect::<Vec<_>>(), vec![meta]);
    // symmetric/1 alone: the fixed meta is 49 as today.
    let alone = symmetric_1(&SymmetricParams::default(), &counts, &e, &metas).unwrap();
    assert_eq!(alone.get(meta).unwrap().weight().get(), 49.0);
}

#[test]
fn g5_the_missing_cell_examples() {
    let present = |a, d| Some((a, d, 0));
    assert_eq!(
        g(MEAN, &[(0, 20, present(9, 1)), (1, 20, None)]),
        10.0 / 12.0
    );
    assert!((g(MEAN, &[(0, 20, present(9, 1)), (1, 20, None)]) - 0.833333).abs() < 1e-6);
    assert!((g(MEAN, &[(0, 20, present(9, 1)), (1, 20, present(0, 0))]) - 0.666667).abs() < 1e-6);
    assert!((g(GEO, &[(0, 20, present(9, 1)), (1, 20, None)]) - 0.645497).abs() < 1e-6);
    // A zero cell and an absent cell are the same for the geometric mean.
    assert_eq!(
        g(GEO, &[(0, 20, present(9, 1)), (1, 20, None)]),
        g(GEO, &[(0, 20, present(9, 1)), (1, 20, present(0, 0))])
    );
    // No cell anywhere: 0.5 under the mean; the geometric mean of 0.5s.
    assert_eq!(g(MEAN, &[(0, 20, None), (1, 20, None)]), 0.5);
    assert!((g(GEO, &[(0, 20, None), (1, 20, None)]) - 0.5).abs() < 1e-15);
}

#[test]
fn fewer_than_the_minimum_groups_gives_exactly_one() {
    for spec in [vec![], vec![(3, 7, Some((5, 0, 0)))]] {
        for form in [MEAN, GEO] {
            let c = consensus(form, &GicParams::default(), &groups(&spec), C);
            assert_eq!(c.g(), None);
            assert_eq!(c.factor().to_bits(), 1.0f64.to_bits());
        }
    }
    // With the minimum at one, one group counts.
    let one_group = GicParams::new(0.5, 1).unwrap();
    let c = consensus(MEAN, &one_group, &groups(&[(3, 7, Some((5, 0, 0)))]), C);
    assert_eq!(c.g(), Some(6.0 / 7.0));
    assert_eq!(c.factor(), 0.5 + 6.0 / 7.0);
    for bad in [
        (0.0, 2),
        (1e-4, 2),
        (101.0, 2),
        (f64::NAN, 2),
        (0.5, 0),
        (0.5, 65),
    ] {
        assert!(GicParams::new(bad.0, bad.1).is_err(), "{bad:?}");
    }
    assert!(GicParams::new(1e-3, 64).is_ok() && GicParams::new(100.0, 1).is_ok());
}

fn random_spec(rng: &mut XorShift, k: usize) -> Vec<Spec> {
    (0..k)
        .map(|i| {
            let m = 1 + rng.below(500) as u32;
            let cell = if rng.below(4) == 0 {
                None
            } else {
                let a = rng.below(u64::from(m) + 1) as u32;
                let d = rng.below(u64::from(m - a) + 1) as u32;
                let p = rng.below(u64::from(m - a - d) + 1) as u32;
                Some((a, d, p))
            };
            (i as u32 * 3 + 1, m, cell)
        })
        .collect()
}

#[test]
fn g1_and_g2_range_and_renaming() {
    let mut rng = XorShift::new(7);
    for _ in 0..2000 {
        let k = 2 + rng.below(9) as usize;
        let spec = random_spec(&mut rng, k);
        for form in [MEAN, GEO] {
            let c = consensus(form, &GicParams::default(), &groups(&spec), C);
            let gv = c.g().unwrap();
            assert!((0.0..=1.0).contains(&gv), "{gv}");
            assert!((0.5..=1.5).contains(&c.factor()));
            // Rename: reverse the ids and rotate the order given.
            let mut renamed: Vec<_> = spec
                .iter()
                .enumerate()
                .map(|(i, (_, m, cell))| (1000 - i as u32 * 7, *m, *cell))
                .collect();
            renamed.rotate_left(1 + rng.below(k as u64) as usize);
            assert_eq!(
                gv.to_bits(),
                g(form, &renamed).to_bits(),
                "{form:?} {spec:?}"
            );
        }
    }
}

#[test]
fn g3_and_g4_monotone_in_agrees_mean_ignores_passes_geomean_falls_with_them() {
    for a in 0..30 {
        for d in 0..10 {
            for form in [MEAN, GEO] {
                let here = g(
                    form,
                    &[(0, 100, Some((a, d, 0))), (1, 100, Some((2, 2, 1)))],
                );
                let more = g(
                    form,
                    &[(0, 100, Some((a + 1, d, 0))), (1, 100, Some((2, 2, 1)))],
                );
                assert!(more >= here);
                if a < 20 {
                    assert!(more > here, "{form:?} strict at {a} {d}");
                }
            }
            let mean_p0 = g(
                MEAN,
                &[(0, 100, Some((a, d, 0))), (1, 100, Some((2, 2, 1)))],
            );
            let mean_p9 = g(MEAN, &[(0, 900, Some((a, d, 9))), (1, 5, Some((2, 2, 1)))]);
            assert_eq!(mean_p0.to_bits(), mean_p9.to_bits());
            let geo_p0 = g(GEO, &[(0, 100, Some((a, d, 0))), (1, 100, Some((2, 2, 1)))]);
            let geo_p1 = g(GEO, &[(0, 100, Some((a, d, 1))), (1, 100, Some((2, 2, 1)))]);
            assert!(geo_p1 < geo_p0);
        }
    }
}

#[test]
fn one_dissenting_group_of_five_counts_more_under_the_geometric_mean() {
    // Four groups at 0.9 and one at 0.1 (A + 1 over A + D + 2, no passes).
    let mut spec: Vec<_> = (0..4).map(|i| (i, 100, Some((8, 0, 0)))).collect();
    spec.push((4, 100, Some((0, 8, 0))));
    assert!((g(MEAN, &spec) - 0.74).abs() < 1e-12);
    assert!((g(GEO, &spec) - 0.5799546134795289).abs() < 1e-12);
    // Two groups: each is half the mean when both have cells.
    let two = [(0, 100, Some((8, 0, 0))), (1, 100, Some((0, 8, 0)))];
    assert!((g(MEAN, &two) - 0.5).abs() < 1e-15);
    assert!((g(GEO, &two) - 0.3).abs() < 1e-15);
}

#[test]
fn counterexample_swapping_every_agree_and_disagree_changes_symmetric_gic() {
    // The count term is symmetric, the consensus factor is not: it measures
    // agreement across groups. Swapping every agree and disagree, in both
    // frames, turns a consensus comment into a rejected one.
    let (f, x) = one(Counts::new(18, 2, 0), 0.5);
    let (f_sw, _) = one(Counts::new(2, 18, 0), 0.5);
    let agreeing = groups(&[(0, 10, Some((9, 1, 0))), (1, 10, Some((9, 1, 0)))]);
    let swapped = groups(&[(0, 10, Some((1, 9, 0))), (1, 10, Some((1, 9, 0)))]);
    let p = SymmetricGicParams::default();
    let none = MetaComments::none();
    let w = symmetric_gic_1(&p, &f, &x, &agreeing, &none).unwrap();
    let w_sw = symmetric_gic_1(&p, &f_sw, &x, &swapped, &none).unwrap();
    let (a, b) = (
        w.get(C).unwrap().weight().get(),
        w_sw.get(C).unwrap().weight().get(),
    );
    assert!(a > 1.5 * b, "{a} {b}");
}

#[test]
fn the_plain_forms_read_back_and_refuse_what_is_not_valid() {
    for rule in [
        RuleId::Symmetric1,
        RuleId::GicMean1,
        RuleId::GicGeomean1,
        RuleId::SymmetricGic1,
    ] {
        let d = ParamSet::default_for(rule);
        assert_eq!(ParamSet::from_plain(&d.to_plain()).unwrap(), d);
        assert!(d.is_default());
    }
    let good = ParamSet::default_for(RuleId::SymmetricGic1).to_plain();
    assert_eq!(
        good,
        "{\"rule\":\"symmetric-gic/1\",\"params\":{\"side_prior\":1.0,\"seen_prior\":2.0,\"extremity_offset\":1.0,\"novelty_amplitude\":8.0,\"novelty_halving_votes\":5.0,\"exponent\":2,\"meta_inner\":7.0,\"meta_policy\":\"fixed\",\"consensus_form\":\"gic-geomean/1\",\"gic_offset\":0.5,\"gic_min_groups\":2},\"terms\":[]}"
    );
    let mean = good.replace("gic-geomean/1", "gic-mean/1");
    let read = ParamSet::from_plain(&mean).unwrap();
    assert!(!read.is_default());
    assert_eq!(read.to_plain(), mean);
    let ordinary = good.replace("\"fixed\"", "\"ordinary\"");
    assert_eq!(
        ParamSet::from_plain(&ordinary).unwrap().to_plain(),
        ordinary
    );
    let refused = [
        good.replace("gic-geomean/1", "gic-median/1"),
        good.replace("\"fixed\"", "\"Fixed\""),
        good.replace("\"gic_min_groups\":2", "\"gic_min_groups\":0"),
        good.replace("\"gic_min_groups\":2", "\"gic_min_groups\":2.0"),
        good.replace("\"gic_offset\":0.5", "\"gic_offset\":0.0"),
        good.replace("\"side_prior\":1.0", "\"side_prior\":2.5"),
        good.replace(",\"gic_offset\":0.5", ""),
        good.replace(
            "\"gic_offset\":0.5",
            "\"gic_offset\":0.5,\"gic_offset\":0.5",
        ),
        good.replace("symmetric-gic/1", "symmetric-gic/3"),
        good.replace("\"terms\":[]", "\"terms\":[\"importance-lift/1\"]"),
        ParamSet::default_for(RuleId::GicMean1)
            .to_plain()
            .replace("}", ",\"x\":1}"),
    ];
    for plain in refused {
        assert!(ParamSet::from_plain(&plain).is_err(), "accepted {plain}");
    }
    match ParamSet::from_plain(&good.replace("\"side_prior\":1.0", "\"side_prior\":2.5")) {
        Err(Refusal::Param(e)) => assert_eq!(e.name, "side_prior"),
        other => panic!("{other:?}"),
    }
}
