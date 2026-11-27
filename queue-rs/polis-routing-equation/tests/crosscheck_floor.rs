//! The second cross-check: the floor rule and the importance terms against
//! an independent statement of their formulas in NumPy
//! (`tests/fixtures/crosscheck/make_crosscheck_4.py`), over constructed
//! cases, at 1e-12: each comment's weight and multiplier, and for the
//! candidates the draw weights and both lanes' parts, zero mass included.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, CommentMarks, ConsensusForm, Counts, CurrentGroupFrame, Extremity,
    ExtremityFrame, FloorParams, GicParams, GroupId, HistoricalCountFrame, LiftParams, MarkTotals,
    Marks, MetaComments, NormalizedLiftParams, SymmetricGicParams, SymmetricParams, TermInputs,
    TermParams, VoterWeightFrame, floor_marginals, importance_multipliers, symmetric_gic_1,
    symmetric_gic_floor_1, with_importance,
};
use serde_json::Value;
use support::src;

const VECTORS: &str = include_str!("fixtures/crosscheck/vectors-4.json");
const TOL: f64 = 1e-12;

fn u(v: &Value) -> u32 {
    u32::try_from(v.as_u64().unwrap()).unwrap()
}
fn c(v: &Value) -> CommentId {
    CommentId::new(u(v))
}
fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap()
}
fn floats(v: &Value) -> Vec<f64> {
    arr(v).iter().map(|x| x.as_f64().unwrap()).collect()
}

fn close(got: f64, want: f64, what: &str, worst: &mut f64) {
    let scale = want.abs().max(1.0);
    *worst = worst.max((got - want).abs() / scale);
    assert!(
        (got - want).abs() <= TOL * scale,
        "{what}: crate {got:e}, NumPy {want:e}"
    );
}

fn lanes_match(
    name: &str,
    m: &polis_routing_equation::FloorMarginals,
    e: &Value,
    worst: &mut f64,
) -> usize {
    let mut n = 0;
    for (key, got) in [
        ("d", m.draw_weights()),
        ("uniform", m.uniform()),
        ("weighted", m.weighted()),
    ] {
        let want = floats(&e[key]);
        assert_eq!(got.len(), want.len(), "{name}: {key} length");
        for (j, (g, w)) in got.iter().zip(&want).enumerate() {
            close(*g, *w, &format!("{name}: {key}[{j}]"), worst);
            n += 1;
        }
    }
    let donated = !m.donations().is_empty();
    assert_eq!(donated, e["donated"].as_bool().unwrap(), "{name}: donation");
    n
}

fn rule_case(case: &Value, worst: &mut f64) -> usize {
    let name = case["name"].as_str().unwrap();
    let previous = arr(&case["previous"])
        .iter()
        .map(|r| (c(&r[0]), Counts::new(u(&r[1]), u(&r[2]), u(&r[3]))));
    let extremity = arr(&case["extremity"])
        .iter()
        .map(|r| (c(&r[0]), Extremity::new(r[1].as_f64().unwrap()).unwrap()));
    let members = arr(&case["groups"]["members"])
        .iter()
        .map(|m| (GroupId::new(u(&m[0])), u(&m[1])));
    let cells = arr(&case["groups"]["cells"]).iter().map(|r| {
        (
            GroupId::new(u(&r[0])),
            c(&r[1]),
            Counts::new(u(&r[2]), u(&r[3]), u(&r[4])),
        )
    });
    let previous = HistoricalCountFrame::new(src("previous"), previous).unwrap();
    let extremity = ExtremityFrame::new(src("current"), extremity).unwrap();
    let groups = CurrentGroupFrame::new(src("groups"), members, cells, None).unwrap();
    let meta = MetaComments::new(arr(&case["meta"]).iter().map(c)).unwrap();
    let form = match case["form"].as_str().unwrap() {
        "gic-mean/1" => ConsensusForm::GicMean1,
        _ => ConsensusForm::GicGeomean1,
    };
    let params = SymmetricGicParams::new(SymmetricParams::default(), form, GicParams::default());
    let base = symmetric_gic_1(&params, &previous, &extremity, &groups, &meta).unwrap();
    let term = &case["term"];
    let marks;
    let totals;
    let voters;
    let (weights, inputs_term) = if term.is_null() {
        (base, None)
    } else if term["term"] == "importance-lift/1" {
        marks = CommentMarks::new(
            src("marks"),
            src("cohort"),
            arr(&term["marks"]).iter().map(|r| {
                (
                    c(&r[0]),
                    Marks::new(r[1].as_u64().unwrap(), r[2].as_u64().unwrap()).unwrap(),
                )
            }),
        )
        .unwrap();
        totals = term["totals"].as_array().map(|t| {
            MarkTotals::new(
                src("marks"),
                src("cohort"),
                Marks::new(t[0].as_u64().unwrap(), t[1].as_u64().unwrap()).unwrap(),
            )
        });
        let inputs = TermInputs::Marks {
            comments: Some(&marks),
            totals: totals.as_ref(),
        };
        let t = TermParams::ImportanceLift1(LiftParams::default());
        (
            with_importance(base.clone(), t, inputs, src("marks")).unwrap(),
            Some((base, t, inputs)),
        )
    } else {
        voters = VoterWeightFrame::new(
            src("voters"),
            arr(&term["voters"])
                .iter()
                .map(|r| (c(&r[0]), r[1].as_u64().unwrap(), r[2].as_f64().unwrap())),
            term["total_voters"].as_u64().unwrap(),
            term["total_weight"].as_f64().unwrap(),
        )
        .unwrap();
        let inputs = TermInputs::VoterWeights(&voters);
        let t = TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::default());
        (
            with_importance(base.clone(), t, inputs, src("voters")).unwrap(),
            Some((base, t, inputs)),
        )
    };
    let e = &case["expect"];
    let mut n = 0;
    for r in arr(&e["weights"]) {
        let id = c(&r[0]);
        match (weights.get(id), r[1].as_f64()) {
            (Some(s), Some(want)) => {
                close(
                    s.weight().get(),
                    want,
                    &format!("{name}: weight of {id}"),
                    worst,
                );
                n += 1;
            }
            (None, None) => assert!(weights.unscored().any(|x| x == id), "{name}: {id}"),
            (got, want) => panic!("{name}: comment {id}: crate {got:?}, NumPy {want:?}"),
        }
    }
    if let Some((base, t, inputs)) = inputs_term {
        let got: std::collections::BTreeMap<_, _> = importance_multipliers(&base, &t, &inputs)
            .unwrap()
            .into_iter()
            .collect();
        for r in arr(&e["multipliers"]) {
            let id = c(&r[0]);
            close(
                got[&id],
                r[1].as_f64().unwrap(),
                &format!("{name}: multiplier of {id}"),
                worst,
            );
            n += 1;
        }
    }
    let floor = FloorParams::new(params, case["floor_share"].as_f64().unwrap()).unwrap();
    let plan = symmetric_gic_floor_1(&floor, weights, &meta).unwrap();
    let candidates = Candidates::new(arr(&case["candidates"]).iter().map(c).collect()).unwrap();
    n + lanes_match(name, &plan.probabilities(&candidates).unwrap(), e, worst)
}

#[test]
fn the_floor_and_importance_match_an_independent_statement() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(doc["header"]["generator"], "make_crosscheck_4.py");
    let (mut rules, mut lanes, mut numbers, mut worst) = (0, 0, 0, 0.0f64);
    for case in arr(&doc["cases"]) {
        if case["kind"] == "lanes" {
            let m = floor_marginals(
                case["floor_share"].as_f64().unwrap(),
                &floats(&case["base"]),
            )
            .unwrap();
            numbers += lanes_match(
                case["name"].as_str().unwrap(),
                &m,
                &case["expect"],
                &mut worst,
            );
            lanes += 1;
        } else {
            numbers += rule_case(case, &mut worst);
            rules += 1;
        }
    }
    assert_eq!((rules, lanes), (11, 7));
    println!(
        "floor and importance cross-check: {rules} rule cases, {lanes} lane cases, {numbers} numbers within 1e-12; largest difference {worst:e}"
    );
}
