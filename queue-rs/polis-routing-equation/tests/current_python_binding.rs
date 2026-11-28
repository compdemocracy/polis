//! Moving the Python binding requires an implemented Rust rule that reproduces
//! the new grid. Keeping the old rule's parity tests green is not sufficient.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

mod support;

use polis_routing_equation::{Counts, HistoricalParams, RuleId, lookup};
use serde_json::Value;
use std::path::Path;

// Fixture I/O belongs to this integration test; the library source scan and
// its I/O lint remain unchanged. Read at runtime so binding moves are seen.
#[allow(clippy::disallowed_methods)]
#[test]
fn the_bound_python_rule_exists_and_reproduces_its_grid() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let binding = std::fs::read_to_string(root.join("CURRENT_PYTHON_RULE")).unwrap();
    let fields: Vec<_> = binding.split_whitespace().collect();
    assert_eq!(fields.len(), 3);
    let rule = lookup(fields[0]).unwrap();
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join(fields[1])).unwrap()).unwrap();
    assert_eq!(fixture["header"]["rule"], fields[0]);
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let count = |key: &str| u32::try_from(case[key].as_u64().unwrap()).unwrap();
        let counts = Counts::new(count("agreed"), count("disagreed"), count("passed"));
        assert_eq!(counts.seen(), case["seen"].as_u64().unwrap());
        let extremity = case["extremity"].as_f64().unwrap();
        let expected = case["weight"].as_f64().unwrap();
        assert!(extremity.is_finite() && expected.is_finite());
        // Exhaustive dispatch: every new rule requires an explicit parity
        // evaluator here. A registry entry alone does not prove agreement.
        let got = match rule {
            RuleId::Historical1 => support::weight_of(
                &HistoricalParams::default(),
                counts,
                extremity,
                case["meta"].as_bool().unwrap(),
            )
            .unwrap(),
            RuleId::Symmetric1 => {
                support::symmetric_weight_of(counts, extremity, case["meta"].as_bool().unwrap())
                    .unwrap()
            }
            RuleId::StoredWeights1
            | RuleId::GicMean1
            | RuleId::GicGeomean1
            | RuleId::Uniform1
            | RuleId::SymmetricGicFloor1 => {
                panic!("the Python binding must name a weight-producing rule")
            }
            RuleId::SymmetricGic1 => {
                panic!("symmetric-gic/1 reads group cells, which a grid case does not hold")
            }
        };
        if expected == 0.0 {
            assert_eq!(got.to_bits(), expected.to_bits());
        } else {
            assert!(
                ((got - expected) / expected).abs() <= 1e-12,
                "bound rule {} does not reproduce {case}: {got}",
                fields[0]
            );
        }
    }
}
