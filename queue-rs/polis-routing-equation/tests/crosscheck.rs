//! The cross-check: the corrected rules against an independent statement of
//! their formulas in NumPy (`tests/fixtures/crosscheck/make_crosscheck.py`),
//! over constructed cases, at 1e-12.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    CommentId, ConsensusForm, CorrectedWeights, Counts, CurrentGroupFrame, Extremity,
    ExtremityFrame, GroupId, HistoricalCountFrame, MetaComments, ParamSet, consensus, symmetric_1,
    symmetric_gic_1,
};
use serde_json::Value;
use support::src;

const VECTORS: &str = include_str!("fixtures/crosscheck/vectors-3.json");
const TOL: f64 = 1e-12;

fn u(v: &Value) -> u32 {
    u32::try_from(v.as_u64().unwrap()).unwrap()
}

fn close(got: f64, want: f64, what: &str, worst: &mut f64) {
    let scale = want.abs().max(1.0);
    *worst = worst.max((got - want).abs() / scale);
    assert!(
        (got - want).abs() <= TOL * scale,
        "{what}: crate {got:e}, NumPy {want:e}"
    );
}

struct Inputs {
    previous: HistoricalCountFrame,
    extremity: ExtremityFrame,
    groups: CurrentGroupFrame,
    meta: MetaComments,
    candidates: Vec<CommentId>,
}

fn inputs(case: &Value) -> Inputs {
    let id = |k: &str| CommentId::new(k.parse().unwrap());
    let previous = case["previous"].as_object().unwrap().iter().map(|(k, v)| {
        let c = v.as_array().unwrap();
        (id(k), Counts::new(u(&c[0]), u(&c[1]), u(&c[2])))
    });
    let extremity = case["extremity"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (id(k), Extremity::new(v.as_f64().unwrap()).unwrap()));
    let members = case["groups"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (GroupId::new(u(&m[0])), u(&m[1])));
    let cells = case["groups"]["cells"].as_array().unwrap().iter().map(|c| {
        (
            GroupId::new(u(&c[0])),
            CommentId::new(u(&c[1])),
            Counts::new(u(&c[2]), u(&c[3]), u(&c[4])),
        )
    });
    Inputs {
        previous: HistoricalCountFrame::new(src("previous"), previous).unwrap(),
        extremity: ExtremityFrame::new(src("current"), extremity).unwrap(),
        groups: CurrentGroupFrame::new(src("groups"), members, cells, None).unwrap(),
        meta: MetaComments::new(
            case["meta"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| CommentId::new(u(m))),
        )
        .unwrap(),
        candidates: case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| CommentId::new(u(c)))
            .collect(),
    }
}

/// A draw's probability vector over the candidates: an unscored comment's
/// weight read as 1, each weight over the running total in candidate order.
fn probabilities(w: &CorrectedWeights, candidates: &[CommentId]) -> Vec<f64> {
    let mapped: Vec<f64> = candidates
        .iter()
        .map(|c| w.get(*c).map_or(1.0, |s| s.weight().get()))
        .collect();
    let total = mapped.iter().fold(0.0, |t, x| t + x);
    mapped.iter().map(|x| x / total).collect()
}

#[test]
fn the_corrected_rules_match_the_independent_numpy_statement() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(doc["header"]["tolerance"].as_f64(), Some(TOL));
    let mut compared = [0usize; 3];
    // The largest differences seen: factors, weights (relative), probabilities.
    let mut worst = [0.0f64; 3];
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = inputs(case);
        for result in case["results"].as_array().unwrap() {
            let params = ParamSet::from_plain(result["params"].as_str().unwrap()).unwrap();
            let label = format!("{name} / {}", result["rule"]);
            let (weights, form, gic) = match &params {
                ParamSet::Symmetric1(p) => (
                    Some(symmetric_1(p, &inp.previous, &inp.extremity, &inp.meta).unwrap()),
                    None,
                    None,
                ),
                ParamSet::SymmetricGic1(p) => (
                    Some(
                        symmetric_gic_1(p, &inp.previous, &inp.extremity, &inp.groups, &inp.meta)
                            .unwrap(),
                    ),
                    Some(p.form()),
                    Some(*p.gic()),
                ),
                ParamSet::GicMean1(g) => (None, Some(ConsensusForm::GicMean1), Some(*g)),
                ParamSet::GicGeomean1(g) => (None, Some(ConsensusForm::GicGeomean1), Some(*g)),
                other => panic!("no cross-check for {other:?}"),
            };
            for (tid, want) in result["comments"].as_object().unwrap() {
                let id = CommentId::new(tid.parse().unwrap());
                if let (Some(form), Some(gic)) = (form, gic) {
                    let c = consensus(form, &gic, &inp.groups, id);
                    match (c.g(), want["g"].as_f64()) {
                        (Some(g), Some(wg)) => {
                            close(g, wg, &format!("{label} G of {tid}"), &mut worst[0])
                        }
                        (None, None) => {}
                        other => panic!("{label} G of {tid}: {other:?}"),
                    }
                    close(
                        c.factor(),
                        want["factor"].as_f64().unwrap(),
                        &format!("{label} factor {tid}"),
                        &mut worst[0],
                    );
                    compared[0] += 1;
                }
                if let Some(w) = &weights {
                    match (w.get(id), want["weight"].as_f64()) {
                        (Some(s), Some(ww)) => {
                            let got = s.weight().get();
                            worst[1] = worst[1].max(((got - ww) / ww).abs());
                            assert!(
                                ((got - ww) / ww).abs() <= TOL,
                                "{label} weight {tid}: {got:e} against {ww:e}"
                            );
                        }
                        (None, None) => {}
                        other => panic!("{label} weight of {tid}: {other:?}"),
                    }
                    compared[1] += 1;
                }
            }
            if let Some(w) = &weights {
                let want = result["probabilities"].as_array().unwrap();
                let got = probabilities(w, &inp.candidates);
                assert_eq!(got.len(), want.len());
                for (g, x) in got.iter().zip(want) {
                    close(
                        *g,
                        x.as_f64().unwrap(),
                        &format!("{label} probability"),
                        &mut worst[2],
                    );
                    compared[2] += 1;
                }
            }
        }
    }
    // Every case and rule was read: the factors, weights and probabilities.
    assert!(compared.iter().all(|n| *n > 40), "{compared:?}");
    eprintln!("compared {compared:?}; largest differences {worst:?}");
}
