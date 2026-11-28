#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use polis_routing_equation::*;

fn source(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

fn base(empty: bool) -> CorrectedWeights {
    let ids = if empty {
        vec![]
    } else {
        vec![CommentId::new(1), CommentId::new(2)]
    };
    let counts = HistoricalCountFrame::new(
        source("previous"),
        ids.iter().map(|id| (*id, Counts::new(1, 1, 0))),
    )
    .unwrap();
    let e = ExtremityFrame::new(
        source("current"),
        ids.iter().map(|id| (*id, Extremity::new(0.0).unwrap())),
    )
    .unwrap();
    CorrectedWeights::from_historical(
        &historical_1(
            &HistoricalParams::default(),
            &counts,
            &e,
            &MetaComments::none(),
        )
        .unwrap(),
    )
}

fn check(
    cells: &[(u32, u64, u64)],
    totals: (u64, u64),
    empty: bool,
) -> Result<Vec<(CommentId, f64)>, Refusal> {
    let comments = CommentMarks::new(
        source("marks"),
        source("cohort"),
        cells
            .iter()
            .map(|(id, m, n)| (CommentId::new(*id), Marks::new(*m, *n).unwrap())),
    )
    .unwrap();
    let totals = MarkTotals::new(
        source("marks"),
        source("cohort"),
        Marks::new(totals.0, totals.1).unwrap(),
    );
    importance_multipliers(
        &base(empty),
        &TermParams::ImportanceLift1(LiftParams::default()),
        &TermInputs::Marks {
            comments: Some(&comments),
            totals: Some(&totals),
        },
    )
}

#[test]
fn maximum_voter_counts_do_not_overflow() {
    let voter = Issue217Voter::new(u64::MAX, u64::MAX, true).unwrap();
    assert_eq!(issue217_voter_weight(voter, u64::MAX).unwrap(), 1.0);
}

#[test]
fn large_voter_counts_round_the_exact_rational_once() {
    // Exact rational rounded to binary64 (integer quotient/remainder oracle).
    let v = Issue217Voter::new(400_759_557_860_619_648, 94, true).unwrap();
    let actual = issue217_voter_weight(v, 4_888_555_856_486_844_931).unwrap();
    assert_eq!(actual.to_bits(), 0x3ff1_6538_3e41_fc69);
    for (votes, bits) in [(1, 1.0f64.to_bits()), (3, 1.0f64.to_bits() + 2)] {
        let voter = Issue217Voter::new(votes, 1, true).unwrap();
        assert_eq!(
            issue217_voter_weight(voter, 100 * (1 << 53))
                .unwrap()
                .to_bits(),
            bits
        );
    }
}

#[test]
fn term_refuses_combined_marks_above_total() {
    assert_eq!(
        check(&[(1, 4, 10), (2, 4, 10)], (6, 100), false).unwrap_err(),
        Refusal::MarksAboveTotal
    );
}

#[test]
fn term_refuses_combined_eligible_above_total() {
    assert_eq!(
        check(&[(1, 1, 60), (2, 1, 60)], (6, 100), false).unwrap_err(),
        Refusal::MarksAboveTotal
    );
}

#[test]
fn term_refuses_more_unmarked_votes_than_the_total_allows() {
    assert_eq!(
        check(&[(1, 1, 99)], (6, 100), false).unwrap_err(),
        Refusal::MarksAboveTotal
    );
}

#[test]
fn term_validates_even_without_scored_comments() {
    assert_eq!(
        check(&[(1, 4, 10), (2, 4, 10)], (6, 100), true).unwrap_err(),
        Refusal::MarksAboveTotal
    );
}

#[test]
fn empty_weights_do_not_hide_a_term_input_mismatch() {
    let frame = VoterWeightFrame::new(source("voters"), [], 0, 0.0).unwrap();
    assert_eq!(
        importance_multipliers(
            &base(true),
            &TermParams::ImportanceLift1(LiftParams::default()),
            &TermInputs::VoterWeights(&frame)
        )
        .unwrap_err(),
        Refusal::TermInputsMismatch
    );
}

#[test]
fn empty_eligibility_is_exactly_neutral_even_with_rounding_or_no_prior() {
    for k in [20.0, 0.0] {
        let c = CommentMarks::new(
            source("marks"),
            source("cohort"),
            [(CommentId::new(1), Marks::new(0, 0).unwrap())],
        )
        .unwrap();
        let t = MarkTotals::new(source("marks"), source("cohort"), Marks::new(1, 9).unwrap());
        let got = importance_multipliers(
            &base(false),
            &TermParams::ImportanceLift1(LiftParams::new(k, 3.0).unwrap()),
            &TermInputs::Marks {
                comments: Some(&c),
                totals: Some(&t),
            },
        )
        .unwrap();
        assert_eq!(got[0].1.to_bits(), 1.0f64.to_bits());
    }
}

#[test]
fn no_marks_preserve_each_weight_base_and_the_floor_draw_bits() {
    let ids = [CommentId::new(1), CommentId::new(2), CommentId::new(3)];
    let counts =
        HistoricalCountFrame::new(source("previous"), ids.map(|id| (id, Counts::new(3, 2, 1))))
            .unwrap();
    let e = ExtremityFrame::new(
        source("current"),
        ids[..2]
            .iter()
            .map(|id| (*id, Extremity::new(0.7).unwrap())),
    )
    .unwrap();
    let meta = MetaComments::new([ids[1]]).unwrap();
    let groups = CurrentGroupFrame::new(source("groups"), [], [], None).unwrap();
    let p = FloorParams::default();
    let h = historical_1(&HistoricalParams::default(), &counts, &e, &meta).unwrap();
    let bases = [
        CorrectedWeights::from_historical(&h),
        symmetric_1(p.base().base(), &counts, &e, &meta).unwrap(),
        symmetric_gic_1(p.base(), &counts, &e, &groups, &meta).unwrap(),
    ];
    let comments = CommentMarks::new(
        source("marks"),
        source("cohort"),
        ids.map(|id| (id, Marks::new(0, 1).unwrap())),
    )
    .unwrap();
    let totals = MarkTotals::new(source("marks"), source("cohort"), Marks::new(0, 3).unwrap());
    let voters =
        VoterWeightFrame::new(source("voters"), ids.map(|id| (id, 1, 1.0)), 3, 3.0).unwrap();
    let terms = [
        (
            TermParams::ImportanceLift1(LiftParams::default()),
            TermInputs::Marks {
                comments: Some(&comments),
                totals: Some(&totals),
            },
        ),
        (
            TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::default()),
            TermInputs::VoterWeights(&voters),
        ),
    ];
    for base in bases {
        for (term, inputs) in terms {
            let lifted = with_importance(base.clone(), term, inputs, source("term")).unwrap();
            for (id, s) in base.scored() {
                assert_eq!(
                    lifted.get(id).unwrap().weight().get().to_bits(),
                    s.weight().get().to_bits()
                );
            }
            assert_eq!(
                lifted.unscored().collect::<Vec<_>>(),
                base.unscored().collect::<Vec<_>>()
            );
            if matches!(base.params(), ParamSet::SymmetricGic1(_)) {
                let before = symmetric_gic_floor_1(&p, base.clone(), &meta).unwrap();
                let after = symmetric_gic_floor_1(&p, lifted, &meta).unwrap();
                for order in [ids.to_vec(), vec![ids[2], ids[0]]] {
                    let candidates = Candidates::new(order).unwrap();
                    for u in [0.0, 0.5, f64::from_bits(1.0f64.to_bits() - 1)] {
                        let a = before
                            .draw(
                                &candidates,
                                Unit::new(u).unwrap(),
                                &source("weights"),
                                &source("participant"),
                            )
                            .unwrap();
                        let b = after
                            .draw(
                                &candidates,
                                Unit::new(u).unwrap(),
                                &source("weights"),
                                &source("participant"),
                            )
                            .unwrap();
                        assert_eq!(a.index(), b.index());
                        assert_eq!(a.random_n().to_bits(), b.random_n().to_bits());
                        assert_eq!(a.probability().to_bits(), b.probability().to_bits());
                        assert_eq!(a.lanes(), b.lanes());
                        let text = b.to_plain();
                        assert_eq!(Drawn::from_plain(&text).unwrap().to_plain(), text);
                    }
                }
            }
        }
    }
}
