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
    // The shared arithmetic refuses what it is given directly, by position.
    let unit = Unit::new(0.5).unwrap();
    for (bad, at) in [
        (vec![1.0, f64::NAN], 1),
        (vec![-1.0], 0),
        (vec![1.0, 2.0, 1e151], 2),
        (vec![f64::INFINITY], 0),
    ] {
        assert_eq!(cdf(&bad, unit), Err(DrawRefusal::InvalidDrawWeight(at)));
    }
    assert_eq!(cdf(&[], unit), Err(DrawRefusal::Empty));
    assert!(cdf(&[1e150], unit).is_ok());
    // At most 2^24 candidates (the contract's number, written here rather
    // than read from the crate's constant): one more is refused for its length before
    // anything else; exactly 2^24 is not refused for its length.
    // The contract's number, written here rather than read from the crate.
    const LIMIT: usize = 1 << 24;
    assert_eq!(MAX_CANDIDATES, LIMIT);
    let at_limit = vec![id; LIMIT];
    assert_eq!(
        Candidates::new(at_limit),
        Err(DrawRefusal::DuplicateCandidate(id))
    );
    let over = vec![id; LIMIT + 1];
    assert_eq!(
        Candidates::new(over),
        Err(DrawRefusal::TooManyCandidates(LIMIT + 1))
    );
    // The stored JSON: only an object of canonical decimal ids to a number,
    // null or false.
    for json in [
        "[1, 2]",
        "3",
        r#"{"01": 1}"#,
        r#"{"-1": 1}"#,
        r#"{"a": 1}"#,
        r#"{"4294967296": 1}"#,
        r#"{"0": true}"#,
        r#"{"0": "1"}"#,
        r#"{"0": [1]}"#,
        r#"{"0": 1, "0": 2}"#,
        "{",
    ] {
        assert!(StoredWeights::from_json(src("m"), json).is_err(), "{json}");
    }
    let read =
        StoredWeights::from_json(src("m"), r#"{"0": null, "1": false, "2": 3, "3": -2}"#).unwrap();
    assert_eq!(read.get(CommentId::new(0)), Some(StoredWeight::Null));
    assert_eq!(read.get(CommentId::new(1)), Some(StoredWeight::False));
    assert_eq!(read.get(CommentId::new(2)), Some(StoredWeight::Number(3.0)));
    assert_eq!(
        read.get(CommentId::new(3)),
        Some(StoredWeight::Number(-2.0))
    );
    assert_eq!(read.get(CommentId::new(4)), None);
    // A weight that leaves the range is refused at the step where it left,
    // by name. At the defaults with no votes and E = 1e150, the running
    // product is 0.5, then 0.5 x (1e150 + 1) = 5e149, then x 0.5 = 2.5e149,
    // then x the novelty 9 = 2.25e150, above 1e150: refused at the novelty.
    let counts = HistoricalCountFrame::new(src("c"), [(id, Counts::default())]).unwrap();
    let e = ExtremityFrame::new(src("e"), [(id, Extremity::new(1e150).unwrap())]).unwrap();
    assert_eq!(
        historical_1(
            &HistoricalParams::default(),
            &counts,
            &e,
            &MetaComments::none()
        ),
        Err(Refusal::WeightOutOfRange {
            comment: id,
            term: "novelty"
        })
    );
}
