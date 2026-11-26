//! Invalid inputs must be refused, not merely handled without a panic.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]
use polis_routing_equation::*;
fn src(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}
#[test]
fn constructors_reject_invalid_values() {
    for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1., -5e-324] {
        assert!(Extremity::new(x).is_err());
    }
    for x in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        -1.,
        -5e-324,
        1.,
        f64::MAX,
    ] {
        assert!(Unit::new(x).is_err());
    }
    assert_eq!(Unit::new(-0.).unwrap().get().to_bits(), 0f64.to_bits());
    for s in ["", "\n", "é"] {
        assert!(SourceId::new(s).is_err());
    }
    assert!(SourceId::new("x".repeat(129)).is_err());
    assert!(CommentId::try_from(-1i32).is_err());
    assert!(CommentId::try_from(i64::MAX).is_err());
    assert!(Counts::from_seen(2, 3, 4).is_err());
    assert!(Counts::from_seen(0, 0, u64::MAX).is_err());
    assert_eq!(
        Counts::new(u32::MAX, u32::MAX, u32::MAX).seen(),
        3 * u64::from(u32::MAX)
    );
    for s in [
        r#"{"agreed":-1,"disagreed":0,"passed":0}"#,
        r#"{"agreed":1,"disagreed":0,"passed":0,"seen":0}"#,
        r#"{"agreed":1,"agreed":2,"disagreed":0,"passed":0}"#,
    ] {
        assert!(serde_json::from_str::<Counts>(s).is_err());
    }
    for i in 0..7 {
        for x in [f64::NAN, f64::INFINITY, -1., f64::MAX] {
            let mut p = [1., 1., 2., 1., 8., 5., 7.];
            p[i] = x;
            assert!(HistoricalParams::new(p[0], p[1], p[2], p[3], p[4], p[5], 2, p[6]).is_err());
        }
    }
    for exp in [0, 5, 255] {
        assert!(HistoricalParams::new(1., 1., 2., 1., 8., 5., exp, 7.).is_err());
    }
    let id = CommentId::new(0);
    assert!(Candidates::new(vec![]).is_err());
    assert!(Candidates::new(vec![id, id]).is_err());
    assert!(
        HistoricalCountFrame::new(src("x"), [(id, Counts::default()), (id, Counts::default())])
            .is_err()
    );
    assert!(
        ExtremityFrame::new(
            src("x"),
            [
                (id, Extremity::new(0.).unwrap()),
                (id, Extremity::new(1.).unwrap())
            ]
        )
        .is_err()
    );
    assert!(
        StoredWeights::new(
            src("x"),
            [(id, StoredWeight::Null), (id, StoredWeight::False)]
        )
        .is_err()
    );
    let candidates = Candidates::new(vec![id]).unwrap();
    for x in [-1., f64::NAN, f64::INFINITY, 1e151] {
        let m = StoredWeights::new(src("x"), [(id, StoredWeight::Number(x))]).unwrap();
        assert!(matches!(
            stored_weights_1(Some(&m), &candidates, Unit::new(0.).unwrap(), &src("p")),
            Err(DrawRefusal::UnsupportedLegacyWeight(_))
        ));
    }
}
