//! historical/1 against the grid recorded from the real Python
//! `priority_metric` (tests/fixtures/historical-1, made by make_grid.py in the
//! delphi image).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{Counts, HistoricalParams};
use serde_json::Value;

const GRID: &str = include_str!("fixtures/historical-1/grid.json");
const TOLERANCE: f64 = 1e-12;

#[test]
fn historical_1_reproduces_every_case_of_the_python_grid() {
    let grid: Value = serde_json::from_str(GRID).unwrap();
    let header = &grid["header"];
    assert_eq!(header["rule"], "historical/1");
    for key in [
        "source_commit",
        "priority_metric_source_sha256",
        "conversation_py_sha256",
        "image",
        "python",
        "numpy",
        "platform",
        "machine",
        "invocation",
        "generator_sha256",
    ] {
        assert!(
            header[key].is_string() || header[key].is_array(),
            "header lacks {key}"
        );
    }
    let cases = grid["cases"].as_array().unwrap();
    assert_eq!(cases.len() as u64, header["case_count"].as_u64().unwrap());
    let params = HistoricalParams::default();
    let (mut exact, mut zeros) = (0usize, 0usize);
    let (mut max_rel, mut max_abs, mut max_ulp) = (0f64, 0f64, 0u64);
    for case in cases {
        let n = |k: &str| u32::try_from(case[k].as_u64().unwrap()).unwrap();
        let (a, d, p) = (n("agreed"), n("disagreed"), n("passed"));
        assert_eq!(
            u64::from(a) + u64::from(d) + u64::from(p),
            case["seen"].as_u64().unwrap()
        );
        let e = case["extremity"].as_f64().unwrap();
        let expected = case["weight"].as_f64().unwrap();
        assert!(
            e.is_finite() && expected.is_finite(),
            "non-finite fixture value: {case}"
        );
        let got = support::weight_of(
            &params,
            Counts::new(a, d, p),
            e,
            case["meta"].as_bool().unwrap(),
        )
        .unwrap();
        if expected == 0.0 {
            assert_eq!(
                got.to_bits(),
                expected.to_bits(),
                "an exact zero must be exact: {case}"
            );
            zeros += 1;
        }
        if got.to_bits() == expected.to_bits() {
            exact += 1;
            continue;
        }
        let abs = (got - expected).abs();
        let rel = abs / expected.abs();
        let ulp = got.to_bits().abs_diff(expected.to_bits());
        assert!(
            rel <= TOLERANCE,
            "{case}: crate {got:e}, Python {expected:e}, relative {rel:e}"
        );
        max_rel = max_rel.max(rel);
        max_abs = max_abs.max(abs);
        max_ulp = max_ulp.max(ulp);
    }
    println!(
        "historical/1 grid: {} cases, {} bit-exact, {} exact zeros; max relative {:e}, max absolute {:e}, max ulp {}",
        cases.len(),
        exact,
        zeros,
        max_rel,
        max_abs,
        max_ulp
    );
}
