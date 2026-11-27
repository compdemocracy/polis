//! The golden files, the defaults manifest, the registry and the canonical
//! plain form.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, Counts, DrawRefusal, Drawn, Extremity, ExtremityFrame,
    HistoricalCountFrame, HistoricalParams, MetaComments, ParamSet, Refusal, RuleId, StoredWeights,
    Unit, WeightProvenance, WeightsUsed, describe, historical_1, lookup, params_table,
    stored_weights_1,
};
use serde_json::Value;

const STORED: &str = include_str!("golden/stored-weights-1.json");
const HISTORICAL: &str = include_str!("golden/historical-1.json");
const MANIFEST: &str = include_str!("golden/defaults-manifest.json");
/// The defaults of the rules added after the first manifest was published;
/// the first one is a golden file and is never edited.
const MANIFEST_3: &str = include_str!("golden/defaults-manifest-3.json");
const README: &str = include_str!("../README.md");

fn ids(v: &Value) -> Vec<CommentId> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|t| CommentId::new(u32::try_from(t.as_u64().unwrap()).unwrap()))
        .collect()
}

#[test]
fn stored_weights_1_goldens_with_their_receipts() {
    let golden: Value = serde_json::from_str(STORED).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let map = match &case["priorities"] {
            Value::Null => None,
            v => Some(StoredWeights::from_json(support::src("math 7"), &v.to_string()).unwrap()),
        };
        let candidates = Candidates::new(ids(&case["candidates"])).unwrap();
        let unit = Unit::new(case["unit"].as_f64().unwrap()).unwrap();
        let input = support::src("participant 3");
        let result = stored_weights_1(map.as_ref(), &candidates, unit, &input);
        match case["refusal"].as_str() {
            Some("TotalBelowNormal") => {
                assert_eq!(result, Err(DrawRefusal::TotalBelowNormal), "{case}");
                continue;
            }
            Some("UnsupportedLegacyWeight") => {
                assert!(
                    matches!(result, Err(DrawRefusal::UnsupportedLegacyWeight(_))),
                    "{case}"
                );
                continue;
            }
            Some(other) => panic!("unknown refusal {other}"),
            None => {}
        }
        let r = result.unwrap();
        assert_eq!(r.index() as u64, case["index"].as_u64().unwrap(), "{case}");
        assert_eq!(
            r.random_n().to_bits(),
            case["random_n"].as_f64().unwrap().to_bits(),
            "{case}"
        );
        assert_eq!(
            r.probability().to_bits(),
            case["probability"].as_f64().unwrap().to_bits(),
            "{case}"
        );
        assert_eq!(
            r.flags().zero_mapped_to_one() as u64,
            case["zero_mapped_to_one"].as_u64().unwrap()
        );
        assert_eq!(
            r.flags().absent_mapped_to_one() as u64,
            case["absent_mapped_to_one"].as_u64().unwrap()
        );
        assert_eq!(
            r.flags().absorbed(),
            ids(&case["absorbed"]).as_slice(),
            "{case}"
        );
        assert_eq!(r.rule(), RuleId::StoredWeights1);
        assert_eq!(r.draw_mode().name(), "legacy-cdf/1");
        assert_eq!(r.sampled_lane(), None);
        assert_eq!(r.candidate_count(), candidates.len());
        assert_eq!(r.candidate_order_digest(), candidates.order_digest());
        assert_eq!(r.input_source(), &input);
        let expected_weights = match map {
            Some(_) => WeightsUsed::Map {
                source: support::src("math 7"),
                provenance: WeightProvenance::MathEngineStored,
            },
            None => WeightsUsed::NoMap,
        };
        assert_eq!(r.weights(), &expected_weights);
        assert_eq!(r.lanes().len(), 1);
        assert_eq!(
            r.lanes()[0].contribution().to_bits(),
            r.probability().to_bits()
        );
        assert_eq!(r.params(), ParamSet::StoredWeights1.to_plain());
        let plain = r.to_plain();
        let receipt: Value = serde_json::from_str(&plain).unwrap();
        assert_eq!(receipt["rule"]["rule"], "stored-weights/1");
        assert_eq!(receipt["draw_mode"], "legacy-cdf/1");
        assert_eq!(receipt["probability"], case["probability"]);
        assert_eq!(Drawn::from_plain(&plain).unwrap(), r);
    }
}

#[test]
fn historical_1_goldens() {
    let golden: Value = serde_json::from_str(HISTORICAL).unwrap();
    let params = HistoricalParams::default();
    for case in golden["cases"].as_array().unwrap() {
        let n = |k: &str| u32::try_from(case[k].as_u64().unwrap()).unwrap();
        let got = support::weight_of(
            &params,
            Counts::new(n("agreed"), n("disagreed"), n("passed")),
            case["extremity"].as_f64().unwrap(),
            case["meta"].as_bool().unwrap(),
        )
        .unwrap();
        let expected = case["weight"].as_f64().unwrap();
        assert!(
            ((got - expected) / expected).abs() <= 1e-12,
            "{case}: {got:e}"
        );
    }
    // Unscored: in only one of the two frames, no weight; drawn at 1.
    let u = &golden["unscored"];
    let only_counts = CommentId::new(u32::try_from(u["counts_only"].as_u64().unwrap()).unwrap());
    let only_e = CommentId::new(u32::try_from(u["extremity_only"].as_u64().unwrap()).unwrap());
    let scored = CommentId::new(0);
    let counts = HistoricalCountFrame::new(
        support::src("tick 4"),
        [
            (scored, Counts::default()),
            (only_counts, Counts::new(2, 0, 0)),
        ],
    )
    .unwrap();
    let e = ExtremityFrame::new(
        support::src("tick 5"),
        [
            (scored, Extremity::new(0.0).unwrap()),
            (only_e, Extremity::new(1.0).unwrap()),
        ],
    )
    .unwrap();
    let w = historical_1(&params, &counts, &e, &MetaComments::none()).unwrap();
    assert!(w.get(only_counts).is_none() && w.get(only_e).is_none());
    assert_eq!(w.unscored().collect::<Vec<_>>(), vec![only_counts, only_e]);
    let stored = StoredWeights::from_historical(support::src("tick 5"), &w);
    let all = Candidates::new(vec![scored, only_counts, only_e]).unwrap();
    let r = stored_weights_1(
        Some(&stored),
        &all,
        Unit::new(0.0).unwrap(),
        &support::src("p"),
    )
    .unwrap();
    assert_eq!(r.flags().absent_mapped_to_one(), 2);
    assert_eq!(r.lanes()[0].normaliser(), 5.0625 + 2.0);
    match r.weights() {
        WeightsUsed::Map {
            source,
            provenance: WeightProvenance::Historical1(h),
        } => {
            assert_eq!(source.as_str(), "tick 5");
            assert!(h.params().is_default());
            assert_eq!(h.previous_counts().as_str(), "tick 4");
            assert_eq!(h.current_extremity().as_str(), "tick 5");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_defaults_manifest_holds_every_rules_published_defaults() {
    let first: Value = serde_json::from_str(MANIFEST).unwrap();
    let third: Value = serde_json::from_str(MANIFEST_3).unwrap();
    let (first, third) = (first.as_object().unwrap(), third.as_object().unwrap());
    // Every rule is listed exactly once across the two files.
    assert_eq!(first.len() + third.len(), RuleId::ALL.len());
    assert!(first.keys().all(|k| !third.contains_key(k)));
    assert!(first.contains_key("historical/1") && first.contains_key("stored-weights/1"));
    for rule in RuleId::ALL {
        let plain = first
            .get(rule.name())
            .or_else(|| third.get(rule.name()))
            .unwrap()
            .as_str()
            .unwrap();
        let defaults = ParamSet::default_for(rule);
        assert_eq!(defaults.to_plain(), plain, "{}", rule.name());
        let read = ParamSet::from_plain(plain).unwrap();
        assert!(read.is_default());
        assert_eq!(read, defaults);
        assert_eq!(read.to_plain(), plain);
    }
}

#[test]
fn the_registry_answers_by_name_and_version_and_refuses_the_rest() {
    assert_eq!(lookup("historical/1").unwrap(), RuleId::Historical1);
    assert_eq!(lookup("stored-weights/1").unwrap(), RuleId::StoredWeights1);
    assert_eq!(lookup("symmetric/1").unwrap(), RuleId::Symmetric1);
    assert_eq!(lookup("symmetric-gic/1").unwrap(), RuleId::SymmetricGic1);
    for asked in [
        "historical/2",
        "historical",
        "Historical/1",
        "",
        "symmetric/2",
        "gic-mean/0",
        "historical/1 ",
    ] {
        match lookup(asked) {
            Err(Refusal::UnknownRule { asked: a, known }) => {
                assert_eq!(a, asked);
                assert_eq!(
                    known,
                    vec![
                        "historical/1",
                        "stored-weights/1",
                        "symmetric/1",
                        "gic-mean/1",
                        "gic-geomean/1",
                        "symmetric-gic/1"
                    ]
                );
            }
            other => panic!("{asked:?} gave {other:?}"),
        }
    }
    for rule in RuleId::ALL {
        let doc = describe(rule);
        assert_eq!(doc.rule, rule);
        assert!(
            README.contains(&params_table(rule)),
            "the README's table for {} is not the registry's:\n{}",
            rule.name(),
            params_table(rule)
        );
    }
}

#[test]
fn the_plain_form_refuses_what_is_not_canonical_and_valid() {
    let good = ParamSet::default_for(RuleId::Historical1).to_plain();
    // Keys in another order are read; to_plain writes the canonical order back.
    let reordered = r#"{"terms":[],"params":{"meta_inner":7,"exponent":2,"novelty_halving_votes":5,"novelty_amplitude":8,"extremity_offset":1,"seen_prior":2,"pass_prior":1,"agree_prior":1},"rule":"historical/1"}"#;
    assert_eq!(ParamSet::from_plain(reordered).unwrap().to_plain(), good);
    let refused = [
        good.replace("\"terms\":[]", "\"terms\":[],\"terms\":[]"),
        good.replace("\"exponent\":2", "\"exponent\":2,\"exponent\":3"),
        good.replace("\"exponent\":2", "\"exponent\":2.0"),
        good.replace("\"exponent\":2", "\"exponent\":5"),
        good.replace("\"exponent\":2,", ""),
        good.replace("\"meta_inner\":7.0", "\"meta_inner\":7.0,\"extra\":1"),
        good.replace("historical/1", "historical/2"),
        good.replace("\"terms\":[]", "\"terms\":[\"importance-lift/1\"]"),
        good.replace("\"pass_prior\":1.0", "\"pass_prior\":2.0"),
        good.replace("\"agree_prior\":1.0", "\"agree_prior\":3.0"),
        good.replace("\"extremity_offset\":1.0", "\"extremity_offset\":0.0"),
        good.replace("\"rule\":\"historical/1\",", ""),
        "[]".to_string(),
        "{".to_string(),
    ];
    for plain in refused {
        assert!(ParamSet::from_plain(&plain).is_err(), "accepted {plain}");
    }
    let set = ParamSet::Historical1(
        HistoricalParams::new(0.5, 0.25, 3.0, 0.125, 0.0, 1e6, 4, 1e-3).unwrap(),
    );
    assert!(!set.is_default());
    assert_eq!(ParamSet::from_plain(&set.to_plain()).unwrap(), set);
}
