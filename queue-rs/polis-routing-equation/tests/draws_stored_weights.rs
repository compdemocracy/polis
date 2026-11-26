//! stored-weights/1 against the independent transliteration of Node's draw
//! (tests/fixtures/stored-weights-1, made by make_draws.py).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, DrawRefusal, MIN_TOTAL, StoredWeights, Unit, stored_weights_1,
};
use serde_json::Value;

const DRAWS: &str = include_str!("fixtures/stored-weights-1/draws.json");

#[test]
fn stored_weights_1_matches_the_node_transliteration_bit_for_bit() {
    let draws: Value = serde_json::from_str(DRAWS).unwrap();
    let cases = draws["cases"].as_array().unwrap();
    let (mut drawn, mut refused) = (0usize, 0usize);
    for case in cases {
        let map = match &case["priorities"] {
            Value::Null => None,
            v => Some(StoredWeights::from_json(support::src("math"), &v.to_string()).unwrap()),
        };
        let ids = case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| CommentId::new(u32::try_from(t.as_u64().unwrap()).unwrap()))
            .collect();
        let candidates = Candidates::new(ids).unwrap();
        let unit = Unit::new(case["unit"].as_f64().unwrap()).unwrap();
        let result = stored_weights_1(
            map.as_ref(),
            &candidates,
            unit,
            &support::src("participant"),
        );
        let total = case["total"].as_f64().unwrap();
        if total < MIN_TOTAL {
            // Below 2^-1021 the crate refuses where Node may or may not draw.
            assert_eq!(result, Err(DrawRefusal::TotalBelowNormal), "{case}");
            refused += 1;
            continue;
        }
        let r = result.unwrap_or_else(|e| panic!("{case}: {e}"));
        assert_eq!(r.index() as u64, case["index"].as_u64().unwrap(), "{case}");
        let random_n = case["random_n"].as_f64().unwrap();
        assert_eq!(r.random_n().to_bits(), random_n.to_bits(), "{case}");
        let chosen_key = r.comment().get().to_string();
        let mapped_weight = case["priorities"]
            .get(&chosen_key)
            .and_then(Value::as_f64)
            .filter(|w| *w != 0.0)
            .unwrap_or(1.0);
        assert_eq!(
            r.probability().to_bits(),
            (mapped_weight / total).to_bits(),
            "{case}"
        );
        assert_eq!(r.lanes()[0].contribution(), r.probability());
        drawn += 1;
    }
    println!(
        "stored-weights/1 against the Node transliteration: {drawn} draws equal, {refused} refused below 2^-1021"
    );
    assert!(drawn > 1000);
}
