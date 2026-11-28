//! Aggregate contradictions detectable without participant identities.
#![allow(clippy::unwrap_used, clippy::panic)]
use polis_routing_equation::*;
fn source() -> SourceId {
    SourceId::new("current").unwrap()
}
fn c(n: u32) -> CommentId {
    CommentId::new(n)
}
fn group() -> GroupId {
    GroupId::new(7)
}
#[test]
fn current_counts_need_enough_ungrouped_participants() {
    for present in [false, true] {
        let cells = if present {
            vec![(group(), c(0), Counts::new(1, 0, 0))]
        } else {
            vec![]
        };
        let g = CurrentGroupFrame::new(source(), [(group(), 2)], cells, None).unwrap();
        let e = EveryoneFrame::new(
            source(),
            3,
            [(c(0), Counts::new(if present { 3 } else { 2 }, 0, 0))],
        )
        .unwrap();
        assert!(
            CurrentFrames::new(Some(g), Some(e)).is_err(),
            "two residual votes cannot belong to one ungrouped participant"
        );
    }
}
#[test]
fn declared_participant_totals_must_agree() {
    let g = CurrentGroupFrame::new(source(), [(group(), 2)], [], Some(3)).unwrap();
    let e = EveryoneFrame::new(source(), 4, []).unwrap();
    assert!(CurrentFrames::new(Some(g), Some(e)).is_err());
}
#[test]
fn marks_must_fit_both_marked_and_unmarked_totals() {
    for (marked, eligible, total_marked, total_eligible) in [(0, 11, 0, 10), (0, 10, 10, 10)] {
        let m = CommentMarks::new(
            source(),
            source(),
            [(c(0), Marks::new(marked, eligible).unwrap())],
        )
        .unwrap();
        let t = MarkTotals::new(
            source(),
            source(),
            Marks::new(total_marked, total_eligible).unwrap(),
        );
        assert!(ImportanceMarks::new(Some(m), Some(t), None, &CurrentFrames::default()).is_err());
    }
}
#[test]
fn voter_weights_need_feasible_residual_aggregates() {
    for (voters, weight, total_voters, total_weight) in [(1, 10.0, 2, 10.0), (1, 1.0, 1, 2.0)] {
        assert!(
            VoterWeightFrame::new(
                source(),
                [(c(0), voters, weight)],
                total_voters,
                total_weight
            )
            .is_err()
        );
    }
}
#[test]
fn excluded_meta_ids_survive_missing_scoring_inputs() {
    let p = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Exclude).unwrap();
    let counts = HistoricalCountFrame::new(source(), [(c(0), Counts::new(0, 0, 0))]).unwrap();
    let ext = ExtremityFrame::new(source(), []).unwrap();
    let meta = MetaComments::new([c(0), c(1)]).unwrap();
    let w = symmetric_1(&p, &counts, &ext, &meta).unwrap();
    assert_eq!(w.excluded().collect::<Vec<_>>(), vec![c(0), c(1)]);
    // An excluded id is decided before readiness, so it is never also
    // listed as unscored (which a draw would give weight 1).
    assert_eq!(w.unscored().count(), 0);
}
#[test]
fn group_marks_share_a_cohort_and_fit_pooled_marks() {
    let g = CurrentGroupFrame::new(source(), [(group(), 3)], [], None).unwrap();
    let current = CurrentFrames::new(Some(g), None).unwrap();
    let cases = [
        ("other", 1, 1, 1, 1),
        ("current", 2, 2, 1, 3),
        ("current", 0, 2, 2, 3),
    ];
    let outcomes: Vec<_> = cases
        .into_iter()
        .map(|(cohort, marked, eligible, pm, pe)| {
            let gm = GroupMarks::new(
                source(),
                SourceId::new(cohort).unwrap(),
                [(group(), c(0), Marks::new(marked, eligible).unwrap())],
            )
            .unwrap();
            let pooled =
                CommentMarks::new(source(), source(), [(c(0), Marks::new(pm, pe).unwrap())])
                    .unwrap();
            ImportanceMarks::new(Some(pooled), None, Some(gm), &current).is_err()
        })
        .collect();
    assert_eq!(outcomes, vec![true; 3]);
    let gm = GroupMarks::new(
        source(),
        source(),
        [(group(), c(0), Marks::new(2, 2).unwrap())],
    )
    .unwrap();
    let totals = MarkTotals::new(source(), source(), Marks::new(1, 3).unwrap());
    assert!(ImportanceMarks::new(None, Some(totals), Some(gm), &current).is_err());
}
#[test]
fn partial_pooled_and_group_marks_jointly_fit_the_same_total() {
    let frame = CurrentGroupFrame::new(source(), [(group(), 3)], [], None).unwrap();
    let current = CurrentFrames::new(Some(frame), None).unwrap();
    let gm = GroupMarks::new(
        source(),
        source(),
        [(group(), c(0), Marks::new(1, 1).unwrap())],
    )
    .unwrap();
    let pooled =
        CommentMarks::new(source(), source(), [(c(1), Marks::new(1, 1).unwrap())]).unwrap();
    let total = |n| MarkTotals::new(source(), source(), Marks::new(n, n).unwrap());
    assert!(
        ImportanceMarks::new(
            Some(pooled.clone()),
            Some(total(1)),
            Some(gm.clone()),
            &current
        )
        .is_err()
    );
    assert!(ImportanceMarks::new(Some(pooled), Some(total(2)), Some(gm), &current).is_ok());
}
#[test]
fn aggregate_boundaries_and_unavailable_inputs_stay_valid() {
    for cell in [None, Some(Counts::new(1, 0, 0))] {
        let g = CurrentGroupFrame::new(
            source(),
            [(group(), 2)],
            cell.into_iter().map(|n| (group(), c(0), n)),
            Some(3),
        )
        .unwrap();
        let e = EveryoneFrame::new(
            source(),
            3,
            [(c(0), Counts::new(if cell.is_some() { 2 } else { 1 }, 0, 0))],
        )
        .unwrap();
        assert!(CurrentFrames::new(Some(g), Some(e)).is_ok());
    }
    let marks = CommentMarks::new(source(), source(), [(c(0), Marks::new(2, 3).unwrap())]).unwrap();
    let totals = MarkTotals::new(source(), source(), Marks::new(3, 5).unwrap());
    assert!(
        ImportanceMarks::new(Some(marks), Some(totals), None, &CurrentFrames::default()).is_ok()
    );
    for (v, w, tv, tw) in [
        (1, 10.0, 2, 11.0),
        (1, 10.0, 1, 10.0),
        (0, 0.0, 0, 0.0),
        (1, f64::MAX, 1, f64::MAX),
    ] {
        assert!(VoterWeightFrame::new(source(), [(c(0), v, w)], tv, tw).is_ok());
    }
    let close = 1.0 + 0.5 * TOTAL_SLACK;
    assert!(VoterWeightFrame::new(source(), [(c(0), 1, 1.0)], 1, close).is_ok());
    let values = [(c(0), 1, 1e16), (c(1), 1, 1.0), (c(2), 1, 1.0)];
    let forward = VoterWeightFrame::new(source(), values, 3, 1e16 + 2.0);
    let reverse = VoterWeightFrame::new(source(), values.into_iter().rev(), 3, 1e16 + 2.0);
    assert_eq!(forward, reverse);
    assert!(forward.is_ok());
}
#[test]
fn nondefault_corrected_parameters_survive_forms_and_results() {
    for policy in [MetaPolicy::Fixed, MetaPolicy::Ordinary, MetaPolicy::Exclude] {
        let base = SymmetricParams::new(0.5, 3.0, 2.0, 7.0, 6.0, 3, 5.0, policy).unwrap();
        let counts = HistoricalCountFrame::new(source(), [(c(0), Counts::new(1, 2, 3))]).unwrap();
        let ext = ExtremityFrame::new(source(), [(c(0), Extremity::new(0.7).unwrap())]).unwrap();
        let plain = ParamSet::Symmetric1(base);
        assert_eq!(ParamSet::from_plain(&plain.to_plain()).unwrap(), plain);
        assert_eq!(
            symmetric_1(&base, &counts, &ext, &MetaComments::none())
                .unwrap()
                .params(),
            &plain
        );
        for form in [ConsensusForm::GicMean1, ConsensusForm::GicGeomean1] {
            let p = SymmetricGicParams::new(base, form, GicParams::new(0.7, 3).unwrap());
            let plain = ParamSet::SymmetricGic1(p);
            assert_eq!(ParamSet::from_plain(&plain.to_plain()).unwrap(), plain);
            let groups = CurrentGroupFrame::new(source(), [], [], None).unwrap();
            assert_eq!(
                symmetric_gic_1(&p, &counts, &ext, &groups, &MetaComments::none())
                    .unwrap()
                    .params(),
                &plain
            );
        }
    }
}
