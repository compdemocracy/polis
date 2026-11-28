//! Importance: the helper from public issue #217 with its four worked
//! numbers exact, the bounded pooled lift and the normalized lift, and their
//! composition with a base rule.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, CommentMarks, CorrectedWeights, Counts, CurrentGroupFrame, Drawn,
    Extremity, ExtremityFrame, FloorParams, GroupId, HistoricalCountFrame, HistoricalParams,
    Issue217Voter, LiftParams, MarkTotals, Marks, MetaComments, NormalizedLiftParams, Refusal,
    TermInputs, TermParams, Unit, VoterWeightFrame, historical_1, importance_multipliers,
    issue217_voter_weight, symmetric_gic_1, symmetric_gic_floor_1, with_importance,
};
use support::src;

#[test]
fn the_issues_four_worked_numbers_come_out_exact() {
    // Issue #217: "(600 votes / 600 statements) * (100 / 2 prioritizations)
    // + 1 = 51", "(300 votes / 600 statements) * (100 / 2 prioritizations) +
    // 1 = 26", "(10 votes / 600 statements) * (100 / 2 prioritizations) + 1
    // = .0166 * 50 + 1 = 1.83" (exactly 11/6), and with 150 prioritizations
    // "(300 votes / 600 statements) * (100 / 150 prioritizations) + 1 = .5 *
    // .666 + 1 = 1.333" (exactly 4/3).
    let w = |v, u| issue217_voter_weight(Issue217Voter::new(v, u, true).unwrap(), 600).unwrap();
    assert_eq!(w(600, 2), 51.0);
    assert_eq!(w(300, 2), 26.0);
    assert_eq!(w(10, 2), 11.0 / 6.0);
    assert_eq!(w(300, 150), 4.0 / 3.0);
    // An unmarked vote is worth exactly 1.
    let unmarked = Issue217Voter::new(300, 2, false).unwrap();
    assert_eq!(issue217_voter_weight(unmarked, 600).unwrap(), 1.0);
    // The four refusals: a mark with no marks used; more marks than votes;
    // more votes than comments; no comments with a mark.
    assert_eq!(
        Issue217Voter::new(5, 0, true).unwrap_err(),
        Refusal::InvalidVoterMarks
    );
    assert_eq!(
        Issue217Voter::new(1, 2, true).unwrap_err(),
        Refusal::InvalidVoterMarks
    );
    let v = Issue217Voter::new(601, 2, true).unwrap();
    assert_eq!(
        issue217_voter_weight(v, 600).unwrap_err(),
        Refusal::InvalidVoterMarks
    );
    let v = Issue217Voter::new(0, 0, false).unwrap();
    assert_eq!(issue217_voter_weight(v, 0).unwrap(), 1.0);
    // marks_used 1 with no votes is refused at construction, so a mark on an
    // empty conversation cannot be built either.
    assert_eq!(
        Issue217Voter::new(0, 1, true).unwrap_err(),
        Refusal::InvalidVoterMarks
    );
}

const A: CommentId = CommentId::new(1);
const B: CommentId = CommentId::new(2);
const C: CommentId = CommentId::new(3);
const META: CommentId = CommentId::new(4);
const NEW: CommentId = CommentId::new(5);

fn base() -> CorrectedWeights {
    let counts = HistoricalCountFrame::new(
        src("previous"),
        [
            (A, Counts::new(3, 1, 0)),
            (B, Counts::new(0, 4, 2)),
            (C, Counts::new(2, 2, 2)),
            (META, Counts::new(1, 1, 0)),
            (NEW, Counts::new(0, 0, 0)),
        ],
    )
    .unwrap();
    let x = |e| Extremity::new(e).unwrap();
    let e = ExtremityFrame::new(
        src("current"),
        [(A, x(0.5)), (B, x(1.25)), (C, x(0.0)), (META, x(0.1))],
    )
    .unwrap();
    let groups = CurrentGroupFrame::new(
        src("groups"),
        [(GroupId::new(0), 10), (GroupId::new(2), 8)],
        [
            (GroupId::new(0), A, Counts::new(3, 0, 1)),
            (GroupId::new(2), B, Counts::new(0, 3, 0)),
        ],
        None,
    )
    .unwrap();
    let meta = MetaComments::new([META]).unwrap();
    symmetric_gic_1(FloorParams::default().base(), &counts, &e, &groups, &meta).unwrap()
}

fn marks(cells: &[(CommentId, u64, u64)], total: (u64, u64)) -> (CommentMarks, MarkTotals) {
    let c = CommentMarks::new(
        src("marks"),
        src("everyone"),
        cells
            .iter()
            .map(|(id, m, n)| (*id, Marks::new(*m, *n).unwrap())),
    )
    .unwrap();
    let t = MarkTotals::new(
        src("marks"),
        src("everyone"),
        Marks::new(total.0, total.1).unwrap(),
    );
    (c, t)
}

fn lift(
    w: &CorrectedWeights,
    c: &CommentMarks,
    t: &MarkTotals,
    p: LiftParams,
) -> Vec<(CommentId, f64)> {
    let inputs = TermInputs::Marks {
        comments: Some(c),
        totals: Some(t),
    };
    importance_multipliers(w, &TermParams::ImportanceLift1(p), &inputs).unwrap()
}

#[test]
fn the_bounded_lift_by_hand() {
    // rho = 6 / 100 = 0.06; k = 20; cap = 3.
    // A: 5 of 10 marked: r = (5 + 20 * 0.06) / (10 + 20) = 6.2 / 30;
    //    r / rho = 3.444..., capped at 3.
    // B: 1 of 10: r = 2.2 / 30; r / rho = 1.2222...
    // C: 0 of 10: r = 1.2 / 30 < rho, so exactly 1.
    // META's marks have no part here (a fixed meta comment is not lifted).
    // NEW has no marks: exactly 1.
    let w = base();
    let (c, t) = marks(&[(A, 5, 10), (B, 1, 10), (C, 0, 10)], (6, 100));
    let m: std::collections::BTreeMap<_, _> = lift(&w, &c, &t, LiftParams::default())
        .into_iter()
        .collect();
    assert_eq!(m[&A], 3.0);
    assert!((m[&B] - 2.2 / 30.0 / 0.06).abs() <= 1e-15);
    assert_eq!(m[&C], 1.0);
    assert!(!m.contains_key(&NEW), "an unscored comment is not lifted");
    // Uncapped (cap 1000): A's lift is 6.2 / 30 / 0.06 = 3.444...
    let big = LiftParams::new(20.0, 1000.0).unwrap();
    let m: std::collections::BTreeMap<_, _> = lift(&w, &c, &t, big).into_iter().collect();
    assert!((m[&A] - 6.2 / 30.0 / 0.06).abs() <= 1e-15);
    // I1: 1 <= m <= cap, and non-decreasing in the marks at fixed eligible.
    let mut last = 1.0;
    for marked in 0..=10 {
        let (c, t) = marks(&[(A, marked, 10)], (10, 100));
        let m = lift(&w, &c, &t, LiftParams::default())[0].1;
        assert!((1.0..=3.0).contains(&m));
        assert!(m >= last);
        last = m;
    }
    // A comment whose eligible votes are 0 gets exactly 1.
    let (c, t) = marks(&[(A, 0, 0)], (6, 100));
    assert_eq!(lift(&w, &c, &t, LiftParams::default())[0].1, 1.0);
}

#[test]
fn no_marks_anywhere_gives_the_base_rule_bit_for_bit() {
    let w = base();
    for (c, t) in [
        marks(&[(A, 0, 10), (B, 0, 3)], (0, 50)),
        marks(&[], (0, 0)),
        marks(&[(A, 0, 10)], (0, 10)),
    ] {
        let inputs = TermInputs::Marks {
            comments: Some(&c),
            totals: Some(&t),
        };
        let lifted = with_importance(
            w.clone(),
            TermParams::ImportanceLift1(LiftParams::default()),
            inputs,
            src("marks"),
        )
        .unwrap();
        for (id, s) in w.scored() {
            assert_eq!(
                lifted.get(id).unwrap().weight().get().to_bits(),
                s.weight().get().to_bits()
            );
        }
        assert_eq!(
            lifted.unscored().collect::<Vec<_>>(),
            w.unscored().collect::<Vec<_>>()
        );
    }
    // No totals at all: unavailable, never a zero; every factor 1.
    let (c, _) = marks(&[(A, 5, 10)], (6, 100));
    let inputs = TermInputs::Marks {
        comments: Some(&c),
        totals: None,
    };
    let m = importance_multipliers(
        &w,
        &TermParams::ImportanceLift1(LiftParams::default()),
        &inputs,
    )
    .unwrap();
    assert!(m.iter().all(|(_, f)| *f == 1.0));
}

#[test]
fn the_term_composes_outside_the_power_and_leaves_meta_and_unscored_alone() {
    let w = base();
    let (c, t) = marks(&[(A, 5, 10), (B, 1, 10), (META, 10, 10)], (16, 100));
    let inputs = TermInputs::Marks {
        comments: Some(&c),
        totals: Some(&t),
    };
    let term = TermParams::ImportanceLift1(LiftParams::default());
    let m: std::collections::BTreeMap<_, _> = importance_multipliers(&w, &term, &inputs)
        .unwrap()
        .into_iter()
        .collect();
    let lifted = with_importance(w.clone(), term, inputs, src("marks")).unwrap();
    for id in [A, B, C] {
        let before = w.get(id).unwrap().weight().get();
        let after = lifted.get(id).unwrap();
        assert_eq!(after.weight().get().to_bits(), (before * m[&id]).to_bits());
        assert_eq!(after.explanation().outer().last().unwrap().value(), m[&id]);
        assert_eq!(
            after.explanation().evaluate().to_bits(),
            after.weight().get().to_bits()
        );
    }
    // The fixed meta comment keeps 49, however marked.
    assert_eq!(lifted.get(META).unwrap().weight().get(), 49.0);
    assert!(lifted.get(NEW).is_none() || w.get(NEW).is_some());
    assert_eq!(lifted.terms(), [term]);
    // Composed twice: refused. The other term's inputs: refused.
    let again = TermInputs::Marks {
        comments: Some(&c),
        totals: Some(&t),
    };
    assert_eq!(
        with_importance(lifted, term, again, src("marks")).unwrap_err(),
        Refusal::RepeatedTerm
    );
    let vw = VoterWeightFrame::new(src("vw"), [(A, 2, 52.0)], 10, 70.0).unwrap();
    assert_eq!(
        importance_multipliers(&w, &term, &TermInputs::VoterWeights(&vw)).unwrap_err(),
        Refusal::TermInputsMismatch
    );
    // Validated at the term's own boundary: a source mismatch, and a comment
    // whose eligible votes exceed the totals' eligible.
    let other = MarkTotals::new(src("other"), src("everyone"), Marks::new(16, 100).unwrap());
    let bad = TermInputs::Marks {
        comments: Some(&c),
        totals: Some(&other),
    };
    assert_eq!(
        importance_multipliers(&w, &term, &bad).unwrap_err(),
        Refusal::MarksSourceMismatch
    );
    let (c2, t2) = marks(&[(A, 1, 200)], (16, 100));
    let bad = TermInputs::Marks {
        comments: Some(&c2),
        totals: Some(&t2),
    };
    assert_eq!(
        importance_multipliers(&w, &term, &bad).unwrap_err(),
        Refusal::MarksAboveTotal
    );
}

#[test]
fn the_normalized_lift_by_hand_and_with_todays_equation() {
    // A: 2 voters, weight sum 52 (51 + 1): I = 26. B: 3 voters, sum 3: I = 1.
    // Totals: 10 voters, sum 70: the conversation's mean is 7.
    // A: 26 / 7 = 3.714..., unbounded by default; B: max(1, 1/7) = 1.
    let vw = VoterWeightFrame::new(src("vw"), [(A, 2, 52.0), (B, 3, 3.0)], 10, 70.0).unwrap();
    let w = base();
    let unbounded = TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::default());
    let m: std::collections::BTreeMap<_, _> =
        importance_multipliers(&w, &unbounded, &TermInputs::VoterWeights(&vw))
            .unwrap()
            .into_iter()
            .collect();
    assert_eq!(m[&A], 26.0 / 7.0);
    assert_eq!(m[&B], 1.0);
    assert_eq!(m[&C], 1.0);
    let capped =
        TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::new(Some(3.0)).unwrap());
    let m = importance_multipliers(&w, &capped, &TermInputs::VoterWeights(&vw)).unwrap();
    assert_eq!(m.iter().find(|(id, _)| *id == A).unwrap().1, 3.0);
    // Any base rule: historical/1 with the term.
    let counts = HistoricalCountFrame::new(src("previous"), [(A, Counts::new(3, 1, 0))]).unwrap();
    let e = ExtremityFrame::new(src("current"), [(A, Extremity::new(0.5).unwrap())]).unwrap();
    let h = historical_1(
        &HistoricalParams::default(),
        &counts,
        &e,
        &MetaComments::none(),
    )
    .unwrap();
    let hw = CorrectedWeights::from_historical(&h);
    let lifted = with_importance(hw, unbounded, TermInputs::VoterWeights(&vw), src("vw")).unwrap();
    let before = h.get(A).unwrap().weight().get();
    assert_eq!(
        lifted.get(A).unwrap().weight().get().to_bits(),
        (before * (26.0 / 7.0)).to_bits()
    );
}

#[test]
fn the_floor_with_importance_names_its_term_in_the_receipt() {
    let p = FloorParams::default();
    let (c, t) = marks(&[(A, 5, 10)], (6, 100));
    let term = TermParams::ImportanceLift1(LiftParams::default());
    let inputs = TermInputs::Marks {
        comments: Some(&c),
        totals: Some(&t),
    };
    let lifted = with_importance(base(), term, inputs, src("marks")).unwrap();
    let meta = MetaComments::new([META]).unwrap();
    let plan = symmetric_gic_floor_1(&p, lifted, &meta).unwrap();
    let cands = Candidates::new(vec![A, B, C, NEW]).unwrap();
    let r = plan
        .draw(&cands, Unit::new(0.3).unwrap(), &src("w"), &src("p"))
        .unwrap();
    let text = r.to_plain();
    assert!(text.contains("\"terms\":[{\"term\":\"importance-lift/1\",\"params\":{\"prior_strength\":20.0,\"cap\":3.0}}]"));
    assert!(text.contains("\"importance\":\"marks\""));
    assert_eq!(Drawn::from_plain(&text).unwrap().to_plain(), text);
    // With no marks at all the floor draws exactly as over its base.
    let (c0, t0) = marks(&[], (0, 0));
    let none = TermInputs::Marks {
        comments: Some(&c0),
        totals: Some(&t0),
    };
    let flat = symmetric_gic_floor_1(
        &p,
        with_importance(base(), term, none, src("marks")).unwrap(),
        &meta,
    )
    .unwrap();
    let plain = symmetric_gic_floor_1(&p, base(), &meta).unwrap();
    let a = flat.probabilities(&cands).unwrap();
    let b = plain.probabilities(&cands).unwrap();
    for (x, y) in a.draw_weights().iter().zip(b.draw_weights()) {
        assert_eq!(x.to_bits(), y.to_bits());
    }
    // The uniform lane is never touched by the term.
    let lifted = symmetric_gic_floor_1(
        &p,
        with_importance(
            base(),
            term,
            TermInputs::Marks {
                comments: Some(&c),
                totals: Some(&t),
            },
            src("marks"),
        )
        .unwrap(),
        &meta,
    )
    .unwrap();
    assert_eq!(lifted.probabilities(&cands).unwrap().uniform(), b.uniform());
}
