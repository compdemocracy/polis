//! The rules that read the latest counts: `symmetric/2`, `symmetric-gic/2`
//! and `symmetric-gic-floor/2`, on `base-counts:lag-0`.
//!
//! - LC1: on the domain both policies admit, a `/2` rule equals its `/1` rule
//!   given a count frame holding exactly the group frame's sums.
//! - LC2: with identical cells, weights and draws are bit-identical; the
//!   receipts differ only where the contract says they do.
//! - LC3: the independent statement (`vectors-5.json`) at 1e-12, its witness
//!   with `/1` and `/2` different.
//! - LC4: group order and group ids change no bit.
//! - The refusals, the receipt reader's forms, the policy lookup, and the
//!   boundaries of the new code.
//!
//! These are counts, never votes: the crate never sees a signed vote.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    BaseCounts, Candidates, CommentId, CommentMarks, ConsensusForm, CorrectedWeights, CountPolicy,
    Counts, CurrentGroupFrame, Drawn, Extremity, ExtremityFrame, FloorParams, GicParams, GroupId,
    HistoricalCountFrame, LiftParams, MarkTotals, Marks, MetaComments, MetaPolicy,
    NormalizedLiftParams, ParamSet, Refusal, RuleId, StoredWeights, SymmetricGicParams,
    SymmetricParams, TermInputs, TermParams, Unit, VoterWeightFrame, WeightProvenance, WeightsUsed,
    describe, resolve, stored_weights_1, symmetric_1, symmetric_2, symmetric_gic_1,
    symmetric_gic_2, symmetric_gic_floor_1, symmetric_gic_floor_2, with_importance,
};
use serde_json::Value;
use support::{XorShift, src};

const VECTORS: &str = include_str!("fixtures/crosscheck/vectors-5.json");
const RECEIPTS_5: &str = include_str!("golden/receipts-5.txt");

fn id(t: u32) -> CommentId {
    CommentId::new(t)
}

/// One update's frames: groups and extremity under one source.
fn frames(
    source: &str,
    members: &[(u32, u32)],
    cells: &[(u32, u32, u32, u32, u64)],
    extremity: &[(u32, f64)],
) -> (CurrentGroupFrame, ExtremityFrame) {
    let groups = CurrentGroupFrame::new(
        src(source),
        members.iter().map(|(g, n)| (GroupId::new(*g), *n)),
        cells.iter().map(|(g, t, a, d, s)| {
            (
                GroupId::new(*g),
                id(*t),
                Counts::from_seen(*a, *d, *s).unwrap(),
            )
        }),
        None,
    )
    .unwrap();
    let e = ExtremityFrame::new(
        src(source),
        extremity
            .iter()
            .map(|(t, x)| (id(*t), Extremity::new(*x).unwrap())),
    )
    .unwrap();
    (groups, e)
}

/// The witness of the contract: two groups, ids 0 and 2; comments 7 and 8.
fn witness() -> (CurrentGroupFrame, ExtremityFrame, HistoricalCountFrame) {
    let (g, e) = frames(
        "tick-b",
        &[(0, 4), (2, 3)],
        &[
            (0, 7, 3, 0, 4),
            (0, 8, 1, 1, 2),
            (2, 7, 0, 2, 2),
            (2, 8, 0, 1, 3),
        ],
        &[(7, 0.5), (8, 1.5)],
    );
    let previous = HistoricalCountFrame::new(
        src("tick-a"),
        [(id(7), Counts::new(1, 0, 0)), (id(8), Counts::new(0, 1, 0))],
    )
    .unwrap();
    (g, e, previous)
}

/// The exact sums of a group frame, computed here, as a lagged count frame
/// (a test-only stand-in for the comparison of LC1).
fn sums_as_previous(groups: &CurrentGroupFrame, label: &str) -> HistoricalCountFrame {
    let cells = groups.comment_ids().into_iter().map(|t| {
        let (mut a, mut d, mut p) = (0u64, 0u64, 0u64);
        for c in groups.cells_for(t).filter_map(|(_, c)| c) {
            a += u64::from(c.agreed());
            d += u64::from(c.disagreed());
            p += u64::from(c.passed());
        }
        (
            t,
            Counts::new(
                u32::try_from(a).unwrap(),
                u32::try_from(d).unwrap(),
                u32::try_from(p).unwrap(),
            ),
        )
    });
    HistoricalCountFrame::new(src(label), cells.collect::<Vec<_>>()).unwrap()
}

fn same_numbers(a: &CorrectedWeights, b: &CorrectedWeights) {
    let sa: Vec<_> = a.scored().collect();
    let sb: Vec<_> = b.scored().collect();
    assert_eq!(sa.len(), sb.len());
    for ((ia, xa), (ib, xb)) in sa.iter().zip(&sb) {
        assert_eq!(ia, ib);
        assert_eq!(xa.weight().get().to_bits(), xb.weight().get().to_bits());
        assert_eq!(xa.explanation(), xb.explanation());
    }
    assert_eq!(
        a.unscored().collect::<Vec<_>>(),
        b.unscored().collect::<Vec<_>>()
    );
    assert_eq!(
        a.excluded().collect::<Vec<_>>(),
        b.excluded().collect::<Vec<_>>()
    );
}

fn candidates(w: &CorrectedWeights) -> Vec<CommentId> {
    w.scored().map(|(t, _)| t).chain(w.unscored()).collect()
}

struct Case {
    members: Vec<(u32, u32)>,
    cells: Vec<(u32, u32, u32, u32, u64)>,
    meta: Vec<u32>,
    policy: MetaPolicy,
    params: SymmetricGicParams,
    share: f64,
}

fn random_case(rng: &mut XorShift) -> Case {
    let policy =
        [MetaPolicy::Fixed, MetaPolicy::Ordinary, MetaPolicy::Exclude][rng.below(3) as usize];
    let base = if rng.below(2) == 0 {
        SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap()
    } else {
        SymmetricParams::new(0.25, 3.5, 0.5, 2.0, 9.0, 3, 4.0, policy).unwrap()
    };
    let form = [ConsensusForm::GicMean1, ConsensusForm::GicGeomean1][rng.below(2) as usize];
    let gic = if rng.below(2) == 0 {
        GicParams::default()
    } else {
        GicParams::new(0.75, 3).unwrap()
    };
    let groups = 1 + rng.below(5) as u32;
    let members: Vec<(u32, u32)> = (0..groups).map(|g| (g * 3 + 1, 300)).collect();
    let mut cells = vec![];
    let mut meta = vec![];
    for t in 0..(1 + rng.below(25) as u32) {
        if rng.below(8) == 0 {
            meta.push(t);
        }
        for (g, _) in &members {
            if rng.below(10) < 7 {
                let s = rng.below(300);
                let a = rng.below(s + 1);
                let d = rng.below(s - a + 1);
                cells.push((*g, t, a as u32, d as u32, s));
            }
        }
    }
    meta.push(900);
    Case {
        members,
        cells,
        meta,
        policy,
        params: SymmetricGicParams::new(base, form, gic),
        share: [0.0, 0.1, 0.5][rng.below(3) as usize],
    }
}

#[test]
fn lc1_on_the_shared_domain_a_lag0_rule_is_its_lag1_rule_on_the_sums() {
    let mut rng = XorShift::new(0x1A7E_5701);
    let mut compared = 0usize;
    for _ in 0..400 {
        let c = random_case(&mut rng);
        // Extremity for most comments, some only in extremity, some without.
        let ids: Vec<u32> = c.cells.iter().map(|x| x.1).collect();
        let mut ext: Vec<(u32, f64)> = vec![];
        for t in 0..30u32 {
            if (ids.contains(&t) && rng.below(10) < 8) || rng.below(10) == 0 {
                ext.push((t, 3.0 * rng.unit()));
            }
        }
        let (groups, e) = frames("tick-u", &c.members, &c.cells, &ext);
        let sums = sums_as_previous(&groups, "the-same-sums");
        let meta = MetaComments::new(c.meta.iter().map(|t| id(*t))).unwrap();
        assert_eq!(c.policy, c.params.base().meta_policy());
        let s1 = symmetric_1(c.params.base(), &sums, &e, &meta);
        let s2 = symmetric_2(c.params.base(), &groups, &e, &meta);
        let g1 = symmetric_gic_1(&c.params, &sums, &e, &groups, &meta);
        let g2 = symmetric_gic_2(&c.params, &groups, &e, &meta);
        match (s1, s2) {
            (Ok(a), Ok(b)) => same_numbers(&a, &b),
            (Err(a), Err(b)) => assert_eq!(a, b),
            other => panic!("one policy refused: {other:?}"),
        }
        let (g1, g2) = match (g1, g2) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(a), Err(b)) => {
                assert_eq!(a, b);
                continue;
            }
            other => panic!("one policy refused: {other:?}"),
        };
        same_numbers(&g1, &g2);
        let fp = FloorParams::new(c.params, c.share).unwrap();
        let p1 = symmetric_gic_floor_1(&fp, g1.clone(), &meta).unwrap();
        let p2 = symmetric_gic_floor_2(&fp, g2.clone(), &meta).unwrap();
        let ids: Vec<_> = candidates(&g2)
            .into_iter()
            .filter(|t| !c.meta.contains(&t.get()))
            .collect();
        if let Ok(cands) = Candidates::new(ids) {
            match (p1.probabilities(&cands), p2.probabilities(&cands)) {
                (Ok(a), Ok(b)) => {
                    for (x, y) in a.draw_weights().iter().zip(b.draw_weights()) {
                        assert_eq!(x.to_bits(), y.to_bits());
                    }
                    compared += 1;
                }
                (Err(a), Err(b)) => assert_eq!(a, b),
                other => panic!("one floor refused: {other:?}"),
            }
        }
        // Rule identity and provenance deliberately differ.
        assert_eq!(g1.base_counts().policy(), CountPolicy::Lag1);
        assert_eq!(g2.base_counts(), &BaseCounts::Latest(src("tick-u")));
    }
    println!("lc1: {compared} floor marginals compared");
    assert!(compared > 200);
}

#[test]
fn lc2_identical_cells_give_identical_numbers_and_the_receipts_differ_as_stated() {
    let (g, e, _) = witness();
    // The lagged frame holds exactly the latest cells, under the update
    // before (its own source).
    let previous = sums_as_previous(&g, "tick-a");
    let meta = MetaComments::none();
    let fp = FloorParams::default();
    let w1 = symmetric_gic_1(fp.base(), &previous, &e, &g, &meta).unwrap();
    let w2 = symmetric_gic_2(fp.base(), &g, &e, &meta).unwrap();
    same_numbers(&w1, &w2);
    let p1 = symmetric_gic_floor_1(&fp, w1, &meta).unwrap();
    let p2 = symmetric_gic_floor_2(&fp, w2, &meta).unwrap();
    let c = Candidates::new(vec![id(7), id(8)]).unwrap();
    for u in [0.0, 0.25, 0.75, 1.0 - f64::EPSILON / 2.0] {
        let u = Unit::new(u).unwrap();
        let d1 = p1.draw(&c, u, &src("plan-a"), &src("participant")).unwrap();
        let d2 = p2.draw(&c, u, &src("plan-b"), &src("participant")).unwrap();
        assert_eq!(d1.comment(), d2.comment());
        assert_eq!(d1.random_n().to_bits(), d2.random_n().to_bits());
        assert_eq!(d1.probability().to_bits(), d2.probability().to_bits());
        let (r1, r2) = (d1.to_plain(), d2.to_plain());
        assert_eq!(Drawn::from_plain(&r1).unwrap(), d1);
        assert_eq!(Drawn::from_plain(&r2).unwrap(), d2);
        // The expected differences, each asserted.
        assert!(r1.contains("\"rule\":{\"rule\":\"symmetric-gic-floor/1\""));
        assert!(r2.contains("\"rule\":{\"rule\":\"symmetric-gic-floor/2\""));
        assert!(r1.contains(
            "\"produced_by\":{\"kind\":\"computed\",\"rule\":{\"rule\":\"symmetric-gic/1\""
        ));
        assert!(r2.contains(
            "\"produced_by\":{\"kind\":\"computed\",\"rule\":{\"rule\":\"symmetric-gic/2\""
        ));
        assert!(!r1.contains("input_policy") && !r1.contains("latest_counts"));
        assert!(r2.contains("\"input_policy\":\"base-counts:lag-0\""));
        assert!(!r2.contains("previous_counts"));
        assert!(r1.contains(
            "\"inputs\":{\"previous_counts\":\"tick-a\",\"current_extremity\":\"tick-b\",\"current_groups\":\"tick-b\"}"
        ));
        assert!(r2.contains(
            "\"inputs\":{\"latest_counts\":\"tick-b\",\"current_extremity\":\"tick-b\",\"current_groups\":\"tick-b\"}"
        ));
        assert!(r1.contains("\"source\":\"plan-a\"") && r2.contains("\"source\":\"plan-b\""));
    }
    // symmetric/2 records the groups, where symmetric/1 does not.
    let s1 = symmetric_1(fp.base().base(), &previous, &e, &meta).unwrap();
    let s2 = symmetric_2(fp.base().base(), &g, &e, &meta).unwrap();
    same_numbers(&s1, &s2);
    assert_eq!(s1.current_groups(), None);
    assert_eq!(s2.current_groups(), Some(&src("tick-b")));
    let m1 = StoredWeights::from_latest(src("map"), &s2).unwrap();
    let d = stored_weights_1(Some(&m1), &c, Unit::new(0.5).unwrap(), &src("p")).unwrap();
    let r = d.to_plain();
    assert!(r.contains("\"rule\":{\"rule\":\"stored-weights/1\""));
    assert!(r.contains("\"rule\":{\"rule\":\"symmetric/2\""));
    assert!(r.contains(
        "\"input_policy\":\"base-counts:lag-0\",\"inputs\":{\"latest_counts\":\"tick-b\",\"current_extremity\":\"tick-b\",\"current_groups\":\"tick-b\"}"
    ));
    assert_eq!(Drawn::from_plain(&r).unwrap(), d);
}

fn rel_eq(got: f64, want: f64, what: &str) {
    if want == 0.0 {
        assert_eq!(got.to_bits(), want.to_bits(), "{what}");
    } else {
        assert!(
            ((got - want) / want).abs() <= 1e-12,
            "{what}: {got} against {want}"
        );
    }
}

fn case_params(case: &Value) -> FloorParams {
    let p = &case["params"];
    let f = |k: &str, d: f64| p.get(k).and_then(Value::as_f64).unwrap_or(d);
    let i = |k: &str, d: u8| {
        p.get(k)
            .and_then(Value::as_u64)
            .map_or(d, |x| u8::try_from(x).unwrap())
    };
    let s = |k: &str, d: &'static str| p.get(k).and_then(Value::as_str).unwrap_or(d).to_string();
    let base = SymmetricParams::new(
        f("side_prior", 1.0),
        f("seen_prior", 2.0),
        f("extremity_offset", 1.0),
        f("novelty_amplitude", 8.0),
        f("novelty_halving_votes", 5.0),
        i("exponent", 2),
        f("meta_inner", 7.0),
        MetaPolicy::from_name(&s("meta_policy", "fixed")).unwrap(),
    )
    .unwrap();
    let form = ConsensusForm::from_name(&s("consensus_form", "gic-geomean/1")).unwrap();
    let gic = GicParams::new(f("gic_offset", 0.5), i("gic_min_groups", 2)).unwrap();
    FloorParams::new(
        SymmetricGicParams::new(base, form, gic),
        f("floor_share", 0.1),
    )
    .unwrap()
}

fn check_weights(w: &CorrectedWeights, want: &Value, what: &str) {
    let want = want.as_object().unwrap();
    for (key, v) in want {
        let t = id(key.parse().unwrap());
        match v {
            Value::Null => assert!(w.unscored().any(|x| x == t), "{what} {key} unscored"),
            Value::String(s) if s == "excluded" => {
                assert!(w.excluded().any(|x| x == t), "{what} {key} excluded");
            }
            v => rel_eq(
                w.get(t).unwrap().weight().get(),
                v.as_f64().unwrap(),
                &format!("{what} {key}"),
            ),
        }
    }
    let known = w.scored().count() + w.unscored().count() + w.excluded().count();
    assert_eq!(known, want.len(), "{what}: the same comments");
}

#[test]
fn lc3_the_independent_statement_at_1e_12_and_the_witness_differs() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(doc["header"]["tolerance"], 1e-12);
    let mut by_id = std::collections::BTreeMap::new();
    for case in doc["cases"].as_array().unwrap() {
        let name = case["id"].as_str().unwrap();
        let members: Vec<(u32, u32)> = case["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (m[0].as_u64().unwrap() as u32, m[1].as_u64().unwrap() as u32))
            .collect();
        let n = |v: &Value| v.as_u64().unwrap();
        let cells: Vec<_> = case["cells"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    n(&c[0]) as u32,
                    n(&c[1]) as u32,
                    n(&c[2]) as u32,
                    n(&c[3]) as u32,
                    n(&c[4]),
                )
            })
            .collect();
        let ext: Vec<(u32, f64)> = case["extremity"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (n(&x[0]) as u32, x[1].as_f64().unwrap()))
            .collect();
        let (g, e) = frames("tick-u", &members, &cells, &ext);
        let previous = HistoricalCountFrame::new(
            src("tick-before"),
            case["previous"].as_array().unwrap().iter().map(|x| {
                (
                    id(n(&x[0]) as u32),
                    Counts::new(n(&x[1]) as u32, n(&x[2]) as u32, n(&x[3]) as u32),
                )
            }),
        )
        .unwrap();
        let meta = MetaComments::new(
            case.get("meta")
                .and_then(Value::as_array)
                .map(|m| m.iter().map(|t| id(n(t) as u32)).collect::<Vec<_>>())
                .unwrap_or_default(),
        )
        .unwrap();
        let fp = case_params(case);
        let want = &case["expect"];
        let s1 = symmetric_1(fp.base().base(), &previous, &e, &meta).unwrap();
        let s2 = symmetric_2(fp.base().base(), &g, &e, &meta).unwrap();
        let g1 = symmetric_gic_1(fp.base(), &previous, &e, &g, &meta).unwrap();
        let g2 = symmetric_gic_2(fp.base(), &g, &e, &meta).unwrap();
        check_weights(&s1, &want["symmetric/1"], &format!("{name} symmetric/1"));
        check_weights(&s2, &want["symmetric/2"], &format!("{name} symmetric/2"));
        check_weights(
            &g1,
            &want["symmetric-gic/1"],
            &format!("{name} symmetric-gic/1"),
        );
        check_weights(
            &g2,
            &want["symmetric-gic/2"],
            &format!("{name} symmetric-gic/2"),
        );
        let c = Candidates::new(
            case["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| id(n(t) as u32))
                .collect(),
        )
        .unwrap();
        for (rule, plan) in [
            (
                "symmetric-gic-floor/1",
                symmetric_gic_floor_1(&fp, g1, &meta).unwrap(),
            ),
            (
                "symmetric-gic-floor/2",
                symmetric_gic_floor_2(&fp, g2.clone(), &meta).unwrap(),
            ),
        ] {
            let q = plan.probabilities(&c).unwrap();
            let want = want[rule].as_array().unwrap();
            assert_eq!(q.draw_weights().len(), want.len());
            for (got, w) in q.draw_weights().iter().zip(want) {
                rel_eq(*got, w.as_f64().unwrap(), &format!("{name} {rule}"));
            }
        }
        by_id.insert(name.to_string(), g2);
        if name == "witness" {
            // The contract's table, and /1 against /2.
            for (t, w1, w2) in [
                (7, 28.191884062698094, 14.302451075226209),
                (8, 78.3107890630503, 16.659725114535604),
            ] {
                rel_eq(s1.get(id(t)).unwrap().weight().get(), w1, "witness /1");
                rel_eq(s2.get(id(t)).unwrap().weight().get(), w2, "witness /2");
                assert_ne!(
                    s1.get(id(t)).unwrap().weight().get(),
                    s2.get(id(t)).unwrap().weight().get()
                );
            }
        }
    }
    assert_eq!(by_id.len(), 12);
    // LC4 on the statement: renamed and reordered groups, no bit changed.
    assert_eq!(by_id["sparse-groups"], by_id["sparse-groups-renamed"]);
}

#[test]
fn lc4_group_order_and_ids_change_no_bit() {
    let mut rng = XorShift::new(0x00DD_51D5);
    for _ in 0..200 {
        let c = random_case(&mut rng);
        let ext: Vec<(u32, f64)> = (0..30u32).map(|t| (t, 0.1 * f64::from(t % 7))).collect();
        let (g, e) = frames("tick-u", &c.members, &c.cells, &ext);
        // Rename every group by a reversed, spread map and reverse the order.
        let rename = |x: u32| 1000 - 7 * x;
        let members: Vec<_> = c
            .members
            .iter()
            .rev()
            .map(|(x, m)| (rename(*x), *m))
            .collect();
        let cells: Vec<_> = c
            .cells
            .iter()
            .rev()
            .map(|(x, t, a, d, s)| (rename(*x), *t, *a, *d, *s))
            .collect();
        let (h, _) = frames("tick-u", &members, &cells, &ext);
        let meta = MetaComments::new(c.meta.iter().map(|t| id(*t))).unwrap();
        assert_eq!(
            symmetric_2(c.params.base(), &g, &e, &meta),
            symmetric_2(c.params.base(), &h, &e, &meta)
        );
        assert_eq!(
            symmetric_gic_2(&c.params, &g, &e, &meta),
            symmetric_gic_2(&c.params, &h, &e, &meta)
        );
    }
}

#[test]
fn the_new_refusals() {
    let (g, e, previous) = witness();
    let meta = MetaComments::none();
    let fp = FloorParams::default();
    // Numerically identical frames under different ids.
    let (g_other, _) = frames(
        "tick-c",
        &[(0, 4), (2, 3)],
        &[
            (0, 7, 3, 0, 4),
            (0, 8, 1, 1, 2),
            (2, 7, 0, 2, 2),
            (2, 8, 0, 1, 3),
        ],
        &[],
    );
    let mismatch = Refusal::PolicySourceMismatch {
        policy: CountPolicy::Lag0,
        counts: src("tick-c"),
        extremity: src("tick-b"),
    };
    assert_eq!(
        symmetric_2(fp.base().base(), &g_other, &e, &meta).unwrap_err(),
        mismatch
    );
    assert_eq!(
        symmetric_gic_2(fp.base(), &g_other, &e, &meta).unwrap_err(),
        mismatch
    );
    // No groups.
    let none = CurrentGroupFrame::new(src("tick-b"), [], [], None).unwrap();
    assert_eq!(
        symmetric_2(fp.base().base(), &none, &e, &meta).unwrap_err(),
        Refusal::NoLatestCounts
    );
    assert_eq!(
        symmetric_gic_2(fp.base(), &none, &e, &meta).unwrap_err(),
        Refusal::NoLatestCounts
    );
    // The floor pairs by version, both ways, and by its base parameters.
    let w1 = symmetric_gic_1(fp.base(), &previous, &e, &g, &meta).unwrap();
    let w2 = symmetric_gic_2(fp.base(), &g, &e, &meta).unwrap();
    assert_eq!(
        symmetric_gic_floor_2(&fp, w1.clone(), &meta).unwrap_err(),
        Refusal::BaseMismatch
    );
    assert_eq!(
        symmetric_gic_floor_1(&fp, w2.clone(), &meta).unwrap_err(),
        Refusal::BaseMismatch
    );
    let other = FloorParams::new(
        SymmetricGicParams::new(
            *fp.base().base(),
            ConsensusForm::GicMean1,
            GicParams::default(),
        ),
        0.1,
    )
    .unwrap();
    assert_eq!(
        symmetric_gic_floor_2(&other, w2.clone(), &meta).unwrap_err(),
        Refusal::BaseMismatch
    );
    let s2 = symmetric_2(fp.base().base(), &g, &e, &meta).unwrap();
    assert_eq!(
        symmetric_gic_floor_2(&fp, s2, &meta).unwrap_err(),
        Refusal::BaseMismatch
    );
    // stored-weights/1 draws a /2 map only.
    assert_eq!(
        StoredWeights::from_latest(src("map"), &w1).unwrap_err(),
        Refusal::BaseMismatch
    );
    assert!(StoredWeights::from_latest(src("map"), &w2).is_ok());
    let ex = MetaComments::new([id(8)]).unwrap();
    let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Exclude).unwrap();
    let wx = symmetric_2(&base, &g, &e, &ex).unwrap();
    assert_eq!(wx.excluded().collect::<Vec<_>>(), vec![id(8)]);
    assert_eq!(
        StoredWeights::from_latest(src("map"), &wx).unwrap_err(),
        Refusal::BaseMismatch
    );
}

#[test]
fn the_policy_lookup_answers_only_the_pairs_a_rule_is_defined_for() {
    let lag0 = "base-counts:lag-0";
    let lag1 = "base-counts:lag-1";
    assert_eq!(resolve("symmetric/2", lag0).unwrap(), RuleId::Symmetric2);
    assert_eq!(
        resolve("symmetric-gic/2", lag0).unwrap(),
        RuleId::SymmetricGic2
    );
    assert_eq!(
        resolve("symmetric-gic-floor/2", lag0).unwrap(),
        RuleId::SymmetricGicFloor2
    );
    assert_eq!(
        resolve("symmetric-gic-floor/1", lag1).unwrap(),
        RuleId::SymmetricGicFloor1
    );
    assert_eq!(resolve("historical/1", lag1).unwrap(), RuleId::Historical1);
    for (rule, policy, p) in [
        ("symmetric-gic-floor/1", lag0, CountPolicy::Lag0),
        ("symmetric/2", lag1, CountPolicy::Lag1),
        ("stored-weights/1", lag0, CountPolicy::Lag0),
        ("stored-weights/1", lag1, CountPolicy::Lag1),
        ("uniform/1", lag0, CountPolicy::Lag0),
        ("uniform/1", lag1, CountPolicy::Lag1),
        ("gic-mean/1", lag0, CountPolicy::Lag0),
    ] {
        assert_eq!(
            resolve(rule, policy).unwrap_err(),
            Refusal::PolicyNotDefined { rule, policy: p }
        );
    }
    for policy in ["base-counts:lag-2", "lag-0", "", "BASE-COUNTS:LAG-0"] {
        assert_eq!(
            resolve("symmetric/2", policy).unwrap_err(),
            Refusal::UnknownPolicy {
                asked: policy.to_string()
            }
        );
    }
    assert!(matches!(
        resolve("symmetric/3", lag0),
        Err(Refusal::UnknownRule { .. })
    ));
    // Every rule's policy, exhaustively, and as describe() says it.
    for rule in RuleId::ALL {
        let want = match rule {
            RuleId::Historical1
            | RuleId::Symmetric1
            | RuleId::SymmetricGic1
            | RuleId::SymmetricGicFloor1 => Some(CountPolicy::Lag1),
            RuleId::Symmetric2 | RuleId::SymmetricGic2 | RuleId::SymmetricGicFloor2 => {
                Some(CountPolicy::Lag0)
            }
            RuleId::StoredWeights1 | RuleId::Uniform1 | RuleId::GicMean1 | RuleId::GicGeomean1 => {
                None
            }
        };
        assert_eq!(rule.count_policy(), want, "{}", rule.name());
        assert_eq!(
            describe(rule).count_policy(),
            want.map_or("reads no base counts", CountPolicy::name)
        );
    }
}

#[test]
fn every_new_rules_canonical_parameters_round_trip() {
    let base =
        SymmetricParams::new(0.25, 3.5, 0.5, 2.0, 9.0, 3, 4.0, MetaPolicy::Ordinary).unwrap();
    let gp = SymmetricGicParams::new(
        base,
        ConsensusForm::GicMean1,
        GicParams::new(0.75, 3).unwrap(),
    );
    for set in [
        ParamSet::default_for(RuleId::Symmetric2),
        ParamSet::default_for(RuleId::SymmetricGic2),
        ParamSet::default_for(RuleId::SymmetricGicFloor2),
        ParamSet::Symmetric2(base),
        ParamSet::SymmetricGic2(gp),
        ParamSet::SymmetricGicFloor2(FloorParams::new(gp, 0.3).unwrap()),
    ] {
        let plain = set.to_plain();
        assert_eq!(ParamSet::from_plain(&plain).unwrap(), set);
        // The /2 form is the /1 form with the new name.
        let one = plain.replacen("/2\"", "/1\"", 1);
        let read = ParamSet::from_plain(&one).unwrap();
        assert_eq!(read.to_plain().replacen("/1\"", "/2\"", 1), plain);
        assert_ne!(read, set);
    }
}

/// Two groups whose cells sum each component to `u32::MAX` or past it.
fn big(
    source: &str,
    a: (u32, u32),
    extremity: &[(u32, f64)],
) -> (CurrentGroupFrame, ExtremityFrame) {
    let m = u32::MAX;
    let cells = [
        (0, 1, a.0, 0, u64::from(a.0)),
        (1, 1, a.1, 0, u64::from(a.1)),
        (0, 2, 0, m, u64::from(m)),
        (1, 3, 0, 0, u64::from(m)),
        (2, 3, 0, 0, 0),
    ];
    frames(source, &[(0, m), (1, m), (2, m)], &cells, extremity)
}

#[test]
fn count_bounds_at_the_rules() {
    let meta = MetaComments::none();
    let p = SymmetricParams::default();
    let ext = [(1, 0.5), (2, 0.5), (3, 0.5)];
    // Each component reaching exactly u32::MAX is accepted; a seen count of
    // 3 x u32::MAX across components is accepted too.
    let (g, e) = big("u", (u32::MAX - 5, 5), &ext);
    let w = symmetric_2(&p, &g, &e, &meta).unwrap();
    assert_eq!(w.scored().count(), 3);
    let all = frames(
        "u",
        &[(0, u32::MAX), (1, u32::MAX), (2, u32::MAX)],
        &[
            (0, 4, u32::MAX, 0, u64::from(u32::MAX)),
            (1, 4, 0, u32::MAX, u64::from(u32::MAX)),
            (2, 4, 0, 0, u64::from(u32::MAX)),
        ],
        &[(4, 1.0)],
    );
    let w = symmetric_gic_2(&SymmetricGicParams::default(), &all.0, &all.1, &meta).unwrap();
    assert!(w.get(id(4)).unwrap().weight().get().is_finite());
    // u32::MAX + 1 in one component refuses the rule, whichever comment it
    // is on: scored, excluded, or without extremity.
    let (g, e) = big("u", (u32::MAX, 1), &ext);
    assert_eq!(
        symmetric_2(&p, &g, &e, &meta).unwrap_err(),
        Refusal::CountOverflow
    );
    let exclude =
        SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, MetaPolicy::Exclude).unwrap();
    let meta1 = MetaComments::new([id(1)]).unwrap();
    assert_eq!(
        symmetric_2(&exclude, &g, &e, &meta1).unwrap_err(),
        Refusal::CountOverflow
    );
    let (g, e) = big("u", (u32::MAX, 1), &[(2, 0.5), (3, 0.5)]);
    assert_eq!(
        symmetric_gic_2(&SymmetricGicParams::default(), &g, &e, &meta).unwrap_err(),
        Refusal::CountOverflow
    );
}

#[test]
fn presence_unknown_candidates_and_groups_without_cells() {
    let meta = MetaComments::none();
    let fp = FloorParams::default();
    // Groups with members and no cells: an empty count frame; comments known
    // only to extremity are unscored.
    let (g, e) = frames("u", &[(0, 3), (5, 2)], &[], &[(1, 0.5), (2, 1.0)]);
    let w = symmetric_gic_2(fp.base(), &g, &e, &meta).unwrap();
    assert_eq!(w.scored().count(), 0);
    assert_eq!(w.unscored().collect::<Vec<_>>(), vec![id(1), id(2)]);
    // One group; counts only (3), extremity only (4), present-zero (5).
    let (g, e) = frames(
        "u",
        &[(0, 4)],
        &[(0, 3, 1, 1, 2), (0, 5, 0, 0, 0), (0, 6, 2, 0, 2)],
        &[(4, 0.5), (5, 0.5), (6, 0.5)],
    );
    let w = symmetric_gic_2(fp.base(), &g, &e, &meta).unwrap();
    assert_eq!(w.unscored().collect::<Vec<_>>(), vec![id(3), id(4)]);
    assert!(w.get(id(5)).is_some() && w.get(id(6)).is_some());
    let plan = symmetric_gic_floor_2(&fp, w, &meta).unwrap();
    // A candidate in neither frame needs a baseline; an unscored one draws.
    let unknown = Candidates::new(vec![id(5), id(77)]).unwrap();
    assert!(plan.probabilities(&unknown).is_err());
    let known = Candidates::new(vec![id(3), id(5)]).unwrap();
    assert_eq!(plan.probabilities(&known).unwrap().draw_weights().len(), 2);
}

fn marks() -> (CommentMarks, MarkTotals) {
    let c = CommentMarks::new(
        src("marks"),
        src("everyone"),
        [
            (id(7), Marks::new(2, 6).unwrap()),
            (id(8), Marks::new(0, 5).unwrap()),
        ],
    )
    .unwrap();
    (
        c,
        MarkTotals::new(src("marks"), src("everyone"), Marks::new(3, 40).unwrap()),
    )
}

/// The recorded `/2` receipts: the witness's two floor draws, one with an
/// importance term, and two `/2` maps drawn by `stored-weights/1`.
fn receipts_5() -> Vec<String> {
    let (g, e, _) = witness();
    let meta = MetaComments::none();
    let fp = FloorParams::default();
    let c = Candidates::new(vec![id(7), id(8)]).unwrap();
    let w2 = symmetric_gic_2(fp.base(), &g, &e, &meta).unwrap();
    let plan = symmetric_gic_floor_2(&fp, w2.clone(), &meta).unwrap();
    let mut out = vec![];
    for u in [0.25, 0.75] {
        let d = plan
            .draw(
                &c,
                Unit::new(u).unwrap(),
                &src("plan:tick-b"),
                &src("participant-a"),
            )
            .unwrap();
        out.push(d.to_plain());
    }
    let (cm, tot) = marks();
    let inputs = TermInputs::Marks {
        comments: Some(&cm),
        totals: Some(&tot),
    };
    let lifted = with_importance(
        w2.clone(),
        TermParams::ImportanceLift1(LiftParams::default()),
        inputs,
        src("marks"),
    )
    .unwrap();
    let plan = symmetric_gic_floor_2(&fp, lifted, &meta).unwrap();
    let d = plan
        .draw(
            &c,
            Unit::new(0.5).unwrap(),
            &src("plan:tick-b:lift"),
            &src("participant-a"),
        )
        .unwrap();
    out.push(d.to_plain());
    let map = StoredWeights::from_latest(src("map:tick-b"), &w2).unwrap();
    let d = stored_weights_1(
        Some(&map),
        &c,
        Unit::new(0.5).unwrap(),
        &src("participant-b"),
    )
    .unwrap();
    out.push(d.to_plain());
    let vw = VoterWeightFrame::new(
        src("voter-weights"),
        [(id(7), 3, 4.5), (id(8), 2, 2.0)],
        10,
        12.0,
    )
    .unwrap();
    let s2 = symmetric_2(fp.base().base(), &g, &e, &meta).unwrap();
    let s2 = with_importance(
        s2,
        TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::default()),
        TermInputs::VoterWeights(&vw),
        src("voter-weights"),
    )
    .unwrap();
    let map = StoredWeights::from_latest(src("map:tick-b:normalized"), &s2).unwrap();
    let d = stored_weights_1(
        Some(&map),
        &c,
        Unit::new(0.9).unwrap(),
        &src("participant-b"),
    )
    .unwrap();
    out.push(d.to_plain());
    out
}

// Writing the recorded file is a deliberate act: only with the variable set.
#[allow(clippy::disallowed_methods)]
#[test]
fn the_recorded_lag0_receipts_are_reproduced_and_read_back() {
    let made = receipts_5();
    if let Ok(path) = std::env::var("WRITE_RECEIPTS_5") {
        std::fs::write(path, made.join("\n") + "\n").unwrap();
        return;
    }
    let recorded: Vec<&str> = RECEIPTS_5.lines().collect();
    assert_eq!(
        recorded,
        made.iter().map(String::as_str).collect::<Vec<_>>()
    );
    for line in &recorded {
        let d = Drawn::from_plain(line).unwrap();
        assert_eq!(d.to_plain(), *line);
        let WeightsUsed::Map {
            provenance: WeightProvenance::Corrected(c),
            ..
        } = d.weights()
        else {
            panic!("a /2 receipt draws a computed map");
        };
        assert_eq!(c.base_counts(), &BaseCounts::Latest(src("tick-b")));
        assert_eq!(c.latest_counts(), Some(&src("tick-b")));
        assert_eq!(c.previous_counts(), &src("tick-b"));
    }
    assert!(recorded[2].contains("\"importance\":\"marks\"}"));
    assert!(recorded[4].contains("\"importance\":\"voter-weights\"}"));
}

#[test]
fn the_reader_refuses_every_wrong_lag0_form() {
    let made = receipts_5();
    let floor = &made[0];
    let stored = &made[4];
    let lifted = &made[2];
    let refused = [
        // No policy on a lag-0 producer; a lag-1 policy; an unknown one.
        floor.replace("\"input_policy\":\"base-counts:lag-0\",", ""),
        floor.replace("base-counts:lag-0", "base-counts:lag-1"),
        floor.replace("base-counts:lag-0", "base-counts:lag-2"),
        floor.replace(
            "\"input_policy\":\"base-counts:lag-0\"",
            "\"input_policy\":0",
        ),
        // previous_counts under a lag-0 rule.
        floor.replace("\"latest_counts\"", "\"previous_counts\""),
        // Sources not all one update.
        floor.replace(
            "\"latest_counts\":\"tick-b\"",
            "\"latest_counts\":\"tick-a\"",
        ),
        floor.replace(
            "\"current_groups\":\"tick-b\"",
            "\"current_groups\":\"tick-a\"",
        ),
        floor.replace(
            "\"current_extremity\":\"tick-b\"",
            "\"current_extremity\":\"tick-c\"",
        ),
        // Missing, extra and duplicate keys.
        floor.replace(",\"current_groups\":\"tick-b\"", ""),
        floor.replace(
            "\"current_groups\":\"tick-b\"",
            "\"current_groups\":\"tick-b\",\"x\":\"tick-b\"",
        ),
        floor.replace(
            "\"current_groups\":\"tick-b\"",
            "\"current_groups\":\"tick-b\",\"current_groups\":\"tick-b\"",
        ),
        floor.replace(
            "\"input_policy\":\"base-counts:lag-0\"",
            "\"input_policy\":\"base-counts:lag-0\",\"input_policy\":\"base-counts:lag-0\"",
        ),
        lifted.replace(",\"importance\":\"marks\"", ""),
        // The floor and producer versions paired the wrong way.
        floor.replace(
            "\"rule\":\"symmetric-gic-floor/2\"",
            "\"rule\":\"symmetric-gic-floor/1\"",
        ),
        floor.replace(
            "\"rule\":\"symmetric-gic/2\"",
            "\"rule\":\"symmetric-gic/1\"",
        ),
        // A floor whose producer is not symmetric-gic/2.
        floor.replace("\"rule\":\"symmetric-gic/2\"", "\"rule\":\"symmetric/2\""),
        // Wrong base parameters.
        floor
            .replacen("\"gic_offset\":0.5", "\"gic_offset\":0.75", 2)
            .replacen("\"gic_offset\":0.75", "\"gic_offset\":0.5", 1),
        // A lag-0 policy on a lag-1 receipt.
        stored.replace("symmetric/2", "symmetric/1"),
        // The floor rule as a producer.
        stored.replace(
            "\"rule\":\"symmetric/2\"",
            "\"rule\":\"symmetric-gic-floor/2\"",
        ),
    ];
    for (i, bad) in refused.iter().enumerate() {
        assert_ne!(bad, floor, "mutation {i} changed nothing");
        assert!(
            Drawn::from_plain(bad).is_err(),
            "mutation {i} was read: {bad}"
        );
    }
    // A lag-1 receipt carrying a policy key is refused; one without stays read.
    let (g, e, previous) = witness();
    let fp = FloorParams::default();
    let meta = MetaComments::none();
    let w1 = symmetric_gic_1(fp.base(), &previous, &e, &g, &meta).unwrap();
    let plan = symmetric_gic_floor_1(&fp, w1, &meta).unwrap();
    let c = Candidates::new(vec![id(7), id(8)]).unwrap();
    let d = plan
        .draw(&c, Unit::new(0.25).unwrap(), &src("p"), &src("q"))
        .unwrap();
    let one = d.to_plain();
    assert!(Drawn::from_plain(&one).is_ok());
    let policy = one.replace(
        "\"rule\":{\"rule\":\"symmetric-gic/1\"",
        "\"input_policy\":\"base-counts:lag-1\",\"rule\":{\"rule\":\"symmetric-gic/1\"",
    );
    assert_ne!(policy, one);
    assert!(Drawn::from_plain(&policy).is_err());
    let latest_key = one.replace("\"previous_counts\"", "\"latest_counts\"");
    assert!(Drawn::from_plain(&latest_key).is_err());
}
