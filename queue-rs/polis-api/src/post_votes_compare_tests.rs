//! The routing comparison's own tests, with no database: its key, its bands,
//! its refusal names and its keys on the line. The draw's equivalence with
//! today's selector is tested beside the selector (`writer_priorities`); the
//! copies through the shadow are tested with a database
//! (`post_votes_compare_db_tests.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

fn on(raw: &str) -> Box<Compare> {
    Compare::new(raw).unwrap().expect("listed")
}

#[test]
fn compare_key_reads_codes_as_the_benchmark_list_does() {
    for off in ["", " ", "\n\t"] {
        assert!(Compare::new(off).unwrap().is_none(), "{off:?}");
    }
    let compare = on("2example00, 3example00\n2example00 4example00");
    assert_eq!(compare.codes, ["2example00", "3example00", "4example00"]);
    assert!(compare.lists("3example00"));
    assert!(!compare.lists("3EXAMPLE00"), "exact match only");
    assert!(!compare.lists("5example00"));
    assert_eq!(compare.config.len(), 16);
    assert!(
        compare
            .config
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    // The digest is over the sorted list: the order the key names them in
    // does not change it.
    assert_eq!(
        on("4example00,3example00,2example00").config,
        compare.config
    );
    assert_ne!(on("2example00").config, compare.config);
    let fifty_one: Vec<String> = (0..MAX_CONVERSATIONS).map(|i| format!("c{i}")).collect();
    assert!(Compare::new(&fifty_one.join(",")).unwrap().is_some());
    let mut fifty_two = fifty_one.clone();
    fifty_two.push("c99".into());
    for (bad, expect) in [
        (fifty_two.join(","), "lists more than 51 conversations"),
        (",,".into(), "lists no conversation"),
        (
            "2example00,secret-code".into(),
            "entry 2 is not a conversation code",
        ),
        ("a".repeat(65), "entry 1 is not a conversation code"),
        (
            "2example00;3example00".into(),
            "entry 1 is not a conversation code",
        ),
    ] {
        let error = format!("{:#}", Compare::new(&bad).err().expect(&bad));
        assert!(error.contains(SWITCH) && error.contains(expect), "{error}");
        assert!(
            !error.contains("secret") && !error.contains("example"),
            "{error}"
        );
    }
}

#[test]
fn compare_bands_are_closed() {
    assert_eq!(
        [0, 1, 2, 9, 10, 99, 100, 999, 1000, 9999, 10_000, 20_001].map(candidates_band),
        [
            "0",
            "1",
            "2_9",
            "2_9",
            "10_99",
            "10_99",
            "100_999",
            "100_999",
            "1000_9999",
            "1000_9999",
            "ge_10000",
            "ge_10000"
        ]
    );
    assert_eq!(
        [
            0.0, 0.000_99, 0.001, 0.009, 0.01, 0.099, 0.1, 0.49, 0.5, 1.0
        ]
        .map(p_band),
        [
            "lt_0.001",
            "lt_0.001",
            "0.001_0.01",
            "0.001_0.01",
            "0.01_0.1",
            "0.01_0.1",
            "0.1_0.5",
            "0.1_0.5",
            "ge_0.5",
            "ge_0.5"
        ]
    );
}

#[test]
fn refusal_names_carry_no_payload() {
    let id = CommentId::new(900_001);
    for (refusal, name) in [
        (
            DrawRefusal::UnsupportedLegacyWeight(id),
            "unsupported_legacy_weight",
        ),
        (DrawRefusal::DuplicateCandidate(id), "duplicate_candidate"),
        (DrawRefusal::ExcludedCandidate(id), "excluded_candidate"),
        (DrawRefusal::NeedsBaseline(id), "needs_baseline"),
        (
            DrawRefusal::TooManyCandidates(900_001),
            "too_many_candidates",
        ),
        (DrawRefusal::TotalBelowNormal, "total_below_normal"),
    ] {
        assert_eq!(refusal_name(&refusal), name);
        assert!(!refusal_name(&refusal).contains("900001"));
    }
}

/// The routing keys are exactly the closed list, in order, after whatever
/// the line already has, and no value of theirs is a number: no comment id,
/// unit or weight can be one of them.
#[test]
fn compare_line_never_writes_identifiers() {
    let compare = on("2example00");
    let outcomes = [
        Outcome::Compared {
            agrees: true,
            p_band: "0.1_0.5",
        },
        Outcome::Refused("unsupported_legacy_weight"),
        Outcome::NoSelection,
        Outcome::TooManyCandidates,
        Outcome::Shed,
        Outcome::TimedOut,
    ];
    for outcome in outcomes {
        let routing = compare.ended(outcome, Some("2_9"));
        let mut line = js::Obj::new();
        line.set("node_vote", Js::Str("same".into()));
        routing.print_keys(&mut line);
        let keys: Vec<&str> = line.iter().map(|(k, _)| k.as_str()).collect();
        let mut expected = vec!["node_vote"];
        expected.extend(ROUTING_KEYS);
        assert_eq!(keys, expected);
        for (key, value) in line.iter() {
            assert!(!matches!(value, Js::Num(_)), "{key} is a number");
        }
        let printed = js::stringify(&Js::Obj(line));
        assert!(
            printed.contains("\"routing_rule\":\"stored-weights/1\""),
            "{printed}"
        );
        let generation = matches!(outcome, Outcome::Compared { .. } | Outcome::Refused(_));
        assert_eq!(
            printed.contains("\"routing_generation\":\"same\""),
            generation,
            "{printed}"
        );
    }
    let health = js::stringify(&compare.health());
    for (key, n) in [
        ("compared", 1),
        ("agreed", 1),
        ("differed", 0),
        ("refused", 1),
        ("noSelection", 1),
        ("tooManyCandidates", 1),
        ("shed", 1),
        ("timedOut", 1),
        ("conversations", 1),
    ] {
        assert!(
            health.contains(&format!("\"{key}\":{n}")),
            "{key}: {health}"
        );
    }
    assert!(!health.contains("example"), "{health}");
}

/// A comparison already running sheds the next before anything is copied;
/// one past the bound is timed out, keeps its permit until its draw ends, and
/// the one after it sheds. Too many candidates copy nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_sheds_first() {
    let compare = on("2example00");
    let mut selection = Selection::new(2);
    selection.candidates = vec![4, 6, 7, 9];
    selection.next_tid = Some(6);
    *compare.hold.lock().unwrap() = Some(COMPARE_BOUND * 3);
    let first = compare.run(Some(&mut selection), 0.5).await;
    assert_eq!(first.outcome, Outcome::TimedOut);
    *compare.hold.lock().unwrap() = None;
    let second = compare.run(Some(&mut selection), 0.5).await;
    assert_eq!(second.outcome, Outcome::Shed);
    tokio::time::sleep(COMPARE_BOUND * 3).await;
    let third = compare.run(Some(&mut selection), 0.0).await;
    assert!(
        matches!(third.outcome, Outcome::Compared { .. }),
        "{third:?}"
    );
    selection.candidates = (0..=MAX_COMPARE_CANDIDATES as i32).collect();
    let many = compare.run(Some(&mut selection), 0.5).await;
    assert_eq!(many.outcome, Outcome::TooManyCandidates);
    assert_eq!(many.candidates_band, Some("ge_10000"));
    let mut empty = Selection::new(2);
    assert_eq!(
        compare.run(Some(&mut empty), 0.5).await.outcome,
        Outcome::NoSelection
    );
    assert_eq!(compare.run(None, 0.5).await.outcome, Outcome::NoSelection);
    assert_eq!(compare.entered.load(Ordering::Relaxed), 6);
}
