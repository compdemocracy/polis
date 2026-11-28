//! Boundary checks for latest-count rules and their receipt provenance.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]
use polis_routing_equation::*;

fn source(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

#[test]
fn latest_and_lagged_rules_match_on_arithmetic_refusals() {
    let id = CommentId::new(7);
    let counts = Counts::new(1, 0, 0);
    let groups = CurrentGroupFrame::new(
        source("update"),
        [(GroupId::new(0), 1)],
        [(GroupId::new(0), id, counts)],
        None,
    )
    .unwrap();
    let previous = HistoricalCountFrame::new(source("previous"), [(id, counts)]).unwrap();
    let meta = MetaComments::none();
    let p = SymmetricGicParams::default();
    // Both extrema are accepted by the frame. One exceeds the weight ceiling;
    // the other also overflows floating-point evaluation.
    for e in [1e100, f64::MAX] {
        let extremity =
            ExtremityFrame::new(source("update"), [(id, Extremity::new(e).unwrap())]).unwrap();
        let s1 = symmetric_1(p.base(), &previous, &extremity, &meta).unwrap_err();
        let s2 = symmetric_2(p.base(), &groups, &extremity, &meta).unwrap_err();
        let g1 = symmetric_gic_1(&p, &previous, &extremity, &groups, &meta).unwrap_err();
        let g2 = symmetric_gic_2(&p, &groups, &extremity, &meta).unwrap_err();
        assert!(matches!(s1, Refusal::WeightOutOfRange { comment, .. } if comment == id));
        assert!(matches!(g1, Refusal::WeightOutOfRange { comment, .. } if comment == id));
        assert_eq!(s1, s2);
        assert_eq!(g1, g2);
    }
}

fn latest_receipt() -> String {
    include_str!("golden/receipts-5.txt")
        .lines()
        .next()
        .unwrap()
        .to_string()
}

#[test]
fn cross_version_receipts_reach_the_pairing_check_with_valid_producers() {
    let latest = latest_receipt();
    // A structurally valid lagged receipt with the same drawing parameters.
    // Only provenance claims are tested here; reading does not recompute a draw.
    let lagged = latest
        .replace("/2\"", "/1\"")
        .replace("\"input_policy\":\"base-counts:lag-0\",", "")
        .replace("latest_counts", "previous_counts");
    for (receipt, right_floor, wrong_floor) in [
        (latest, "symmetric-gic-floor/2", "symmetric-gic-floor/1"),
        (lagged, "symmetric-gic-floor/1", "symmetric-gic-floor/2"),
    ] {
        Drawn::from_plain(&receipt).unwrap();
        let bad = receipt.replace(right_floor, wrong_floor);
        assert_ne!(bad, receipt);
        assert_eq!(
            Drawn::from_plain(&bad).unwrap_err(),
            Refusal::Plain(format!("inconsistent {wrong_floor} receipt"))
        );
    }
}

#[test]
fn a_group_only_source_mismatch_names_the_actual_disagreement() {
    let receipt = latest_receipt();
    let bad = receipt.replace(
        "\"current_groups\":\"tick-b\"",
        "\"current_groups\":\"another-update\"",
    );
    assert_ne!(bad, receipt);
    assert_eq!(
        Drawn::from_plain(&bad).unwrap_err(),
        Refusal::Plain("latest_counts and current_groups must name the same update".into())
    );
    let bad = receipt.replace(
        "\"current_extremity\":\"tick-b\"",
        "\"current_extremity\":\"another-update\"",
    );
    assert_ne!(bad, receipt);
    assert_eq!(
        Drawn::from_plain(&bad).unwrap_err(),
        Refusal::PolicySourceMismatch {
            policy: CountPolicy::Lag0,
            counts: source("tick-b"),
            extremity: source("another-update")
        }
    );
}
