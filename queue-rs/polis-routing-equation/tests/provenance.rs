//! What produced the weights a draw read is in its receipt, typed, and the
//! receipt's canonical plain form reads back to the same receipt.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, Counts, Drawn, Extremity, ExtremityFrame, HistoricalCountFrame,
    HistoricalParams, MetaComments, ParamSet, RuleId, StoredWeight, StoredWeights, Unit,
    WeightProvenance, WeightsUsed, historical_1, stored_weights_1,
};
use support::src;

fn novelty(amplitude: f64) -> HistoricalParams {
    HistoricalParams::new(1.0, 1.0, 2.0, 1.0, amplitude, 5.0, 2, 7.0).unwrap()
}

/// `historical/1` over two comments with the given counts, E = 0 and E = 1,
/// materialized as a map and drawn at unit 0.5.
fn historical_draw(params: HistoricalParams, counts: Counts) -> Drawn {
    let (c0, c1) = (CommentId::new(0), CommentId::new(1));
    let frame = HistoricalCountFrame::new(src("previous"), [(c0, counts), (c1, counts)]).unwrap();
    let e = ExtremityFrame::new(
        src("current"),
        [
            (c0, Extremity::new(0.0).unwrap()),
            (c1, Extremity::new(1.0).unwrap()),
        ],
    )
    .unwrap();
    let w = historical_1(&params, &frame, &e, &MetaComments::none()).unwrap();
    let map = StoredWeights::from_historical(src("materialized"), &w);
    stored_weights_1(
        Some(&map),
        &Candidates::new(vec![c0, c1]).unwrap(),
        Unit::new(0.5).unwrap(),
        &src("participant 3"),
    )
    .unwrap()
}

/// The receipt for novelty amplitude 7 at the first tick, written out by
/// hand. With no votes, p = a = 1/2 and the novelty is 1 + 7 = 8, so the
/// weights are (1/2 x 1 x 1/2 x 8)^2 = 4 and (1/2 x 2 x 1/2 x 8)^2 = 16: total
/// 20, random_n = 0.5 x 20 = 10, the second comment (running sum 20 > 10),
/// q = 16 / 20. The digest is FNV-1a 64 over the ids 0 and 1, computed
/// separately.
const NOVELTY_7_RECEIPT: &str = concat!(
    r#"{"comment":1,"index":1,"random_n":10.0,"probability":0.8,"#,
    r#""rule":{"rule":"stored-weights/1","params":{},"terms":[]},"#,
    r#""draw_mode":"legacy-cdf/1","#,
    r#""weights":{"kind":"map","source":"materialized","produced_by":{"kind":"computed","#,
    r#""rule":{"rule":"historical/1","params":{"agree_prior":1.0,"pass_prior":1.0,"seen_prior":2.0,"#,
    r#""extremity_offset":1.0,"novelty_amplitude":7.0,"novelty_halving_votes":5.0,"exponent":2,"#,
    r#""meta_inner":7.0},"terms":[]},"#,
    r#""inputs":{"previous_counts":"previous","current_extremity":"current"}}},"#,
    r#""lanes":[{"lane":"weights","share":1.0,"normaliser":20.0,"contribution":0.8}],"#,
    r#""sampled_lane":null,"#,
    r#""flags":{"zero_mapped_to_one":0,"null_or_false_mapped_to_one":0,"absent_mapped_to_one":0,"#,
    r#""absorbed":[],"donations":[]},"#,
    r#""candidate_count":2,"candidate_order_digest":"08cd4c29d1e47d34","#,
    r#""input_source":"participant 3"}"#
);

#[test]
fn a_non_default_parameter_set_and_its_frames_are_in_the_receipt() {
    let first_tick = Counts::default();
    let seven = historical_draw(novelty(7.0), first_tick);
    assert_eq!(seven.to_plain(), NOVELTY_7_RECEIPT);
    let eight = historical_draw(novelty(8.0), first_tick);
    assert_ne!(seven.to_plain(), eight.to_plain());
    assert_ne!(seven, eight);
    match seven.weights() {
        WeightsUsed::Map {
            source,
            provenance: WeightProvenance::Historical1(h),
        } => {
            assert_eq!(source.as_str(), "materialized");
            assert_eq!(h.params(), &novelty(7.0));
            assert_eq!(h.previous_counts().as_str(), "previous");
            assert_eq!(h.current_extremity().as_str(), "current");
        }
        other => panic!("{other:?}"),
    }
    // The draw is still stored-weights/1: the producing rule is beside it,
    // not in its place.
    assert_eq!(seven.rule(), RuleId::StoredWeights1);
    assert_eq!(seven.params(), ParamSet::StoredWeights1.to_plain());
}

#[test]
fn identical_weights_from_different_parameter_sets_give_different_receipts() {
    // From 280 votes seen the novelty is exactly 1 for amplitude 7 and 8
    // alike, so the weights, the draw and its numbers are bit for bit the
    // same; only what produced them differs, and the receipt must say so.
    let many = Counts::new(100, 90, 90);
    let seven = historical_draw(novelty(7.0), many);
    let eight = historical_draw(novelty(8.0), many);
    assert_eq!(seven.random_n().to_bits(), eight.random_n().to_bits());
    assert_eq!(seven.probability().to_bits(), eight.probability().to_bits());
    assert_eq!(seven.index(), eight.index());
    assert_ne!(seven.to_plain(), eight.to_plain());
    assert_eq!(
        seven
            .to_plain()
            .replace("\"novelty_amplitude\":7.0", "\"novelty_amplitude\":8.0"),
        eight.to_plain()
    );
    // And different frames, with the same numbers, differ too.
    let (c0, c1) = (CommentId::new(0), CommentId::new(1));
    let e = |name: &str| {
        ExtremityFrame::new(
            src(name),
            [
                (c0, Extremity::new(0.0).unwrap()),
                (c1, Extremity::new(1.0).unwrap()),
            ],
        )
        .unwrap()
    };
    let frame = HistoricalCountFrame::new(src("previous"), [(c0, many), (c1, many)]).unwrap();
    let a = historical_1(&novelty(8.0), &frame, &e("tick 4"), &MetaComments::none()).unwrap();
    let b = historical_1(&novelty(8.0), &frame, &e("tick 5"), &MetaComments::none()).unwrap();
    assert_ne!(
        StoredWeights::from_historical(src("m"), &a).provenance(),
        StoredWeights::from_historical(src("m"), &b).provenance()
    );
}

#[test]
fn every_constructor_of_a_weight_map_sets_its_provenance() {
    let id = CommentId::new(0);
    let made = StoredWeights::new(src("math 7"), [(id, StoredWeight::Number(2.0))]).unwrap();
    assert_eq!(made.provenance(), &WeightProvenance::MathEngineStored);
    let read = StoredWeights::from_json(src("math 7"), r#"{"0": 2}"#).unwrap();
    assert_eq!(read.provenance(), &WeightProvenance::MathEngineStored);
    assert_eq!(
        WeightProvenance::MathEngineStored.to_plain(),
        r#"{"kind":"math-engine-stored"}"#
    );
    let frame = HistoricalCountFrame::new(src("previous"), [(id, Counts::default())]).unwrap();
    let e = ExtremityFrame::new(src("current"), [(id, Extremity::new(0.0).unwrap())]).unwrap();
    let w = historical_1(&novelty(7.0), &frame, &e, &MetaComments::none()).unwrap();
    let computed = StoredWeights::from_historical(src("materialized"), &w);
    assert_eq!(
        computed.provenance(),
        &WeightProvenance::Historical1(w.provenance().clone())
    );
    assert_eq!(computed.source().as_str(), "materialized");
    // A math-engine map's receipt says so; with no map, the receipt says
    // that, never an empty provenance.
    let candidates = Candidates::new(vec![id]).unwrap();
    let unit = Unit::new(0.0).unwrap();
    let r = stored_weights_1(Some(&made), &candidates, unit, &src("p")).unwrap();
    assert_eq!(
        r.weights(),
        &WeightsUsed::Map {
            source: src("math 7"),
            provenance: WeightProvenance::MathEngineStored,
        }
    );
    assert!(r.to_plain().contains(
        r#""weights":{"kind":"map","source":"math 7","produced_by":{"kind":"math-engine-stored"}}"#
    ));
    let none = stored_weights_1(None, &candidates, unit, &src("p")).unwrap();
    assert_eq!(none.weights(), &WeightsUsed::NoMap);
    assert!(none.to_plain().contains(r#""weights":{"kind":"no-map"}"#));
}

fn receipts() -> Vec<Drawn> {
    let ids: Vec<CommentId> = (0..4).map(CommentId::new).collect();
    let candidates = Candidates::new(ids.clone()).unwrap();
    let odd = src(r#"a "quoted" \ source"#);
    let stored = StoredWeights::new(
        odd.clone(),
        [
            (ids[0], StoredWeight::Number(1.0)),
            (ids[1], StoredWeight::Number(5e-324)),
            (ids[2], StoredWeight::Null),
            (ids[3], StoredWeight::Number(0.0)),
        ],
    )
    .unwrap();
    let mut out = vec![
        historical_draw(novelty(7.0), Counts::default()),
        historical_draw(HistoricalParams::default(), Counts::new(3, 1, 0)),
        historical_draw(
            HistoricalParams::new(0.5, 0.25, 3.0, 0.125, 0.0, 1e6, 4, 1e-3).unwrap(),
            Counts::new(u32::MAX, 0, 7),
        ),
    ];
    for u in [0.0, 0.3, 0.9999999999999999] {
        let unit = Unit::new(u).unwrap();
        out.push(stored_weights_1(Some(&stored), &candidates, unit, &odd).unwrap());
        out.push(stored_weights_1(None, &candidates, unit, &src("~")).unwrap());
    }
    out
}

#[test]
fn the_canonical_form_reads_back_to_the_same_receipt() {
    let all = receipts();
    assert!(all.iter().any(|r| !r.flags().absorbed().is_empty()));
    for r in &all {
        let plain = r.to_plain();
        let back = Drawn::from_plain(&plain).unwrap_or_else(|e| panic!("{plain}: {e}"));
        assert_eq!(&back, r, "{plain}");
        assert_eq!(back.to_plain(), plain);
    }
    assert_eq!(
        Drawn::from_plain(NOVELTY_7_RECEIPT).unwrap(),
        historical_draw(novelty(7.0), Counts::default())
    );
}

#[test]
fn the_canonical_form_refuses_any_other_spelling() {
    let good = NOVELTY_7_RECEIPT;
    let refused = [
        good.replacen('{', "{ ", 1),
        good.replace("\"share\":1.0", "\"share\":1"),
        good.replace("\"random_n\":10.0", "\"random_n\":1e1"),
        good.replace(
            "{\"comment\":1,\"index\":1,",
            "{\"index\":1,\"comment\":1,",
        ),
        good.replace("\"comment\":1,", "\"comment\":1,\"comment\":1,"),
        good.replace("\"comment\":1,", "\"comment\":-1,"),
        good.replace("\"comment\":1,", ""),
        good.replace("\"sampled_lane\":null,", "\"sampled_lane\":null,\"extra\":0,"),
        good.replace("\"kind\":\"computed\"", "\"kind\":\"guessed\""),
        good.replace("\"kind\":\"map\"", "\"kind\":\"none\""),
        good.replace("\"previous_counts\":\"previous\",", ""),
        good.replace("\"previous_counts\":\"previous\"", "\"previous_counts\":\"\""),
        good.replace("\"novelty_amplitude\":7.0", "\"novelty_amplitude\":-7.0"),
        good.replacen("\"rule\":\"historical/1\"", "\"rule\":\"historical/2\"", 1),
        good.replace("legacy-cdf/1", "legacy-cdf/2"),
        good.replace("\"lane\":\"weights\"", "\"lane\":\"uniform\""),
        good.replace("08cd4c29d1e47d34", "08CD4C29D1E47D34"),
        good.replace("08cd4c29d1e47d34", "8cd4c29d1e47d34"),
        good.replace("08cd4c29d1e47d34", "not hex"),
        good.replace("\"absorbed\":[]", "\"absorbed\":[1.5]"),
        good.replace("\"donations\":[]", "\"donations\":[1]"),
        // A computed provenance whose rule computes nothing.
        good.replace(
            "\"rule\":{\"rule\":\"historical/1\",\"params\":{\"agree_prior\":1.0,\"pass_prior\":1.0,\"seen_prior\":2.0,\"extremity_offset\":1.0,\"novelty_amplitude\":7.0,\"novelty_halving_votes\":5.0,\"exponent\":2,\"meta_inner\":7.0},\"terms\":[]}",
            "\"rule\":{\"rule\":\"stored-weights/1\",\"params\":{},\"terms\":[]}",
        ),
        format!("{good} "),
        "[]".to_string(),
        "{".to_string(),
    ];
    for plain in refused {
        assert_ne!(plain, good, "a refused spelling did not change the text");
        assert!(Drawn::from_plain(&plain).is_err(), "accepted {plain}");
    }
    assert!(Drawn::from_plain(good).is_ok());
}
