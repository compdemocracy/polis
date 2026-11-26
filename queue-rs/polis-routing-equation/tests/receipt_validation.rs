#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]
use polis_routing_equation::*;
fn src(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}
fn basic() -> Drawn {
    stored_weights_1(
        None,
        &Candidates::new(vec![CommentId::new(0), CommentId::new(1)]).unwrap(),
        Unit::new(0.5).unwrap(),
        &src("participant"),
    )
    .unwrap()
}
#[test]
fn impossible_receipts_are_refused() {
    let good = basic().to_plain();
    let lane = r#""lanes":[{"lane":"weights","share":1.0,"normaliser":2.0,"contribution":0.5}]"#;
    let cases = [
        (
            "negative probability",
            good.replace(r#""probability":0.5"#, r#""probability":-1.0"#),
        ),
        (
            "probability above one",
            good.replace(r#""probability":0.5"#, r#""probability":2.0"#),
        ),
        (
            "negative random_n",
            good.replace(r#""random_n":1.0"#, r#""random_n":-1.0"#),
        ),
        (
            "random_n equals total",
            good.replace(r#""random_n":1.0"#, r#""random_n":2.0"#),
        ),
        (
            "zero candidates",
            good.replace(r#""candidate_count":2"#, r#""candidate_count":0"#),
        ),
        (
            "too many candidates",
            good.replace(r#""candidate_count":2"#, r#""candidate_count":16777217"#),
        ),
        (
            "index out of bounds",
            good.replace(r#""index":1"#, r#""index":2"#),
        ),
        (
            "negative normaliser",
            good.replace(r#""normaliser":2.0"#, r#""normaliser":-2.0"#),
        ),
        (
            "wrong single lane share",
            good.replace(r#""share":1.0"#, r#""share":0.5"#),
        ),
        (
            "wrong contribution",
            good.replace(r#""contribution":0.5"#, r#""contribution":0.25"#),
        ),
        ("no lane", good.replace(lane, r#""lanes":[]"#)),
        (
            "fictional sampled lane",
            good.replace(r#""sampled_lane":null"#, r#""sampled_lane":"fiction""#),
        ),
        (
            "impossible mapped count",
            good.replace(r#""absent_mapped_to_one":2"#, r#""absent_mapped_to_one":3"#),
        ),
        (
            "selected comment absorbed",
            good.replace(r#""absorbed":[]"#, r#""absorbed":[1]"#),
        ),
        (
            "fictional donation",
            good.replace(r#""donations":[]"#, r#""donations":["fiction"]"#),
        ),
        (
            "wrong drawing rule",
            good.replace(
                &ParamSet::StoredWeights1.to_plain(),
                &ParamSet::Historical1(HistoricalParams::default()).to_plain(),
            ),
        ),
    ];
    let mut accepted = vec![];
    for (name, bad) in cases {
        assert_ne!(bad, good);
        if Drawn::from_plain(&bad).is_ok() {
            accepted.push(name);
        }
    }
    println!("accepted impossible receipts: {accepted:?}");
    assert!(accepted.is_empty());
}
fn historical(params: HistoricalParams) -> Drawn {
    let id = CommentId::new(0);
    let c = HistoricalCountFrame::new(src("counts"), [(id, Counts::new(100, 90, 90))]).unwrap();
    let e = ExtremityFrame::new(src("extremity"), [(id, Extremity::new(0.0).unwrap())]).unwrap();
    let w = historical_1(&params, &c, &e, &MetaComments::none()).unwrap();
    let map = StoredWeights::from_historical(src("materialized"), &w);
    stored_weights_1(
        Some(&map),
        &Candidates::new(vec![id]).unwrap(),
        Unit::new(0.5).unwrap(),
        &src("participant"),
    )
    .unwrap()
}
#[test]
fn equal_zero_parameter_sets_have_one_canonical_receipt() {
    let p = |a| HistoricalParams::new(1., 1., 2., 1., a, 5., 2, 7.).unwrap();
    let a = historical(p(0.));
    let b = historical(p(-0.));
    assert_eq!(a, b);
    println!(
        "equal receipts with +0/-0 parameter; equal text = {}",
        a.to_plain() == b.to_plain()
    );
    assert_eq!(a.to_plain(), b.to_plain());
}
#[test]
fn canonical_receipts_are_not_authentication() {
    let genuine = historical(HistoricalParams::default()).to_plain();
    let altered = genuine.replace(
        r#""previous_counts":"counts""#,
        r#""previous_counts":"claimed-other-counts""#,
    );
    let claimed = Drawn::from_plain(&altered).unwrap();
    assert_eq!(claimed.to_plain(), altered);
    assert_ne!(claimed.to_plain(), genuine);
    // There is no public conversion of this claimed provenance into a computed weight map.
}
#[test]
fn generated_receipts_roundtrip_and_clones_keep_provenance() {
    let mut state = 123456789u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for i in 0..2000 {
        let a = (next() >> 11) as f64 / ((1u64 << 53) as f64);
        let p = HistoricalParams::new(
            1.,
            1.,
            2.,
            1.,
            a * 1000.,
            0.001 + a * 999999.,
            1 + (i % 4) as u8,
            0.001 + a * 999999.,
        )
        .unwrap();
        let r = historical(p);
        match r.weights() {
            WeightsUsed::Map {
                provenance: WeightProvenance::Historical1(h),
                ..
            } => assert_eq!(h.params(), &p),
            other => panic!("{other:?}"),
        }
        let plain = r.to_plain();
        assert_eq!(Drawn::from_plain(&plain).unwrap(), r);
        assert_eq!(r.clone().to_plain(), plain);
    }
    println!("2000 generated historical receipts roundtrip exactly");
}

#[test]
fn every_historical_parameter_survives_production_and_readback() {
    let defaults = [1., 1., 2., 1., 8., 5., 7.];
    let alternatives = [0.5, 0.25, 3., 0.125, 7., 1e6, 0.001];
    for i in 0..8 {
        let mut p = defaults;
        if i < 7 {
            p[i] = alternatives[i];
        }
        let params = HistoricalParams::new(
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            p[5],
            if i == 7 { 4 } else { 2 },
            p[6],
        )
        .unwrap();
        let r = historical(params);
        for result in [r.clone(), Drawn::from_plain(&r.to_plain()).unwrap()] {
            match result.weights() {
                WeightsUsed::Map {
                    provenance: WeightProvenance::Historical1(h),
                    ..
                } => {
                    assert_eq!(h.params(), &params);
                    assert_eq!(h.previous_counts().as_str(), "counts");
                    assert_eq!(h.current_extremity().as_str(), "extremity");
                }
                other => panic!("{other:?}"),
            }
        }
    }
}

#[test]
fn valid_extreme_draws_still_roundtrip() {
    let ids = (0..4).map(CommentId::new).collect::<Vec<_>>();
    let candidates = Candidates::new(ids.clone()).unwrap();
    let max_unit = f64::from_bits(1f64.to_bits() - 1);
    let mut accepted = 0;
    for scale in [5e-324, 1e-300, 1e-100, 1.0, 1e100, 1e150] {
        let map = StoredWeights::new(
            src("math"),
            [
                (ids[0], StoredWeight::Number(5e-324)),
                (ids[1], StoredWeight::Number(scale)),
                (ids[2], StoredWeight::False),
                (ids[3], StoredWeight::Number(0.)),
            ],
        )
        .unwrap();
        for unit in [0., 0.5, max_unit] {
            let r = stored_weights_1(
                Some(&map),
                &candidates,
                Unit::new(unit).unwrap(),
                &src("participant"),
            )
            .unwrap();
            assert_eq!(Drawn::from_plain(&r.to_plain()).unwrap(), r);
            accepted += 1;
        }
    }
    println!(
        "{accepted} extreme draws roundtrip, including a reachable underflowed zero propensity"
    );
}

#[test]
fn impossible_mapped_totals_and_single_candidate_digests_are_refused() {
    let ids = [CommentId::new(0), CommentId::new(1)];
    let all_null = StoredWeights::new(
        src("math"),
        [(ids[0], StoredWeight::Null), (ids[1], StoredWeight::Null)],
    )
    .unwrap();
    let two = stored_weights_1(
        Some(&all_null),
        &Candidates::new(ids.to_vec()).unwrap(),
        Unit::new(0.5).unwrap(),
        &src("participant"),
    )
    .unwrap()
    .to_plain();
    assert!(Drawn::from_plain(&two).is_ok());
    let heavy = StoredWeights::new(src("math"), [(ids[0], StoredWeight::Number(3.0))]).unwrap();
    let one = stored_weights_1(
        Some(&heavy),
        &Candidates::new(vec![ids[0]]).unwrap(),
        Unit::new(0.5).unwrap(),
        &src("participant"),
    )
    .unwrap()
    .to_plain();
    assert!(Drawn::from_plain(&one).is_ok());
    let huge = serde_json::Number::from_f64(1e300).unwrap().to_string();
    let half_null = StoredWeights::new(
        src("math"),
        [
            (ids[0], StoredWeight::Null),
            (ids[1], StoredWeight::Number(3.0)),
        ],
    )
    .unwrap();
    let mixed = stored_weights_1(
        Some(&half_null),
        &Candidates::new(ids.to_vec()).unwrap(),
        Unit::new(0.0).unwrap(),
        &src("participant"),
    )
    .unwrap()
    .to_plain();
    assert!(Drawn::from_plain(&mixed).is_ok());
    assert!(mixed.contains(r#""normaliser":4.0"#));
    assert!(one.contains(r#""normaliser":3.0"#));
    let digest = |s: &str| {
        let at = s.find("\"candidate_order_digest\":\"").unwrap() + 26;
        s[at..at + 16].to_string()
    };
    let cases = [
        (
            "every candidate mapped to 1, total not the count",
            two.replace(r#""normaliser":2.0"#, r#""normaliser":5.0"#)
                .replace(r#""random_n":1.0"#, r#""random_n":2.5"#),
        ),
        (
            "every candidate mapped to 1, probability not 1/n",
            two.replace(r#""probability":0.5"#, r#""probability":0.75"#)
                .replace(r#""contribution":0.5"#, r#""contribution":0.75"#),
        ),
        (
            "total above n times the ceiling",
            one.replace(r#""normaliser":3.0"#, &format!(r#""normaliser":{huge}"#)),
        ),
        (
            "total below the mapped count",
            mixed.replace(r#""normaliser":4.0"#, r#""normaliser":0.5"#),
        ),
        (
            "one candidate, digest of another list",
            one.replace(&digest(&one), &digest(&two)),
        ),
    ];
    let mut accepted = vec![];
    for (name, bad) in cases {
        assert_ne!(bad, one);
        assert_ne!(bad, two);
        assert_ne!(bad, mixed);
        if Drawn::from_plain(&bad).is_ok() {
            accepted.push(name);
        }
    }
    println!("accepted impossible receipts (mapped totals, digests): {accepted:?}");
    assert!(accepted.is_empty());
}
