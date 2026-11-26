//! Every way a naming can fail is an outcome, with the number of calls the
//! plan allows: none before the call is affordable and keyed, one retry at
//! most after a busy or unreachable provider.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_names::{Hierarchy, RunCap, Topic, name_topics};
use std::collections::BTreeMap;
use std::time::Duration;
use support::{Reply, Stub, hierarchy, message, namer, saved_topics, settings, topics_text};

const VT_SONNET: &str = "replies/vtaiwan/sonnet-default-r1.json";

fn run(h: &Hierarchy, replies: Vec<Reply>) -> (polis_topic_names::NamesFile, usize) {
    run_with_cap(h, replies, 0.5)
}

fn run_with_cap(
    h: &Hierarchy,
    replies: Vec<Reply>,
    cap: f64,
) -> (polis_topic_names::NamesFile, usize) {
    let stub = Stub::start(replies);
    let file = name_topics(
        h,
        &namer("sonnet", "default"),
        Some("test-key"),
        RunCap::Usd(cap),
        &settings(&stub.url),
    );
    (file, stub.finish().len())
}

fn vtaiwan_text_with(edit: impl FnOnce(&mut Vec<(String, String)>)) -> String {
    let mut items = saved_topics(VT_SONNET);
    edit(&mut items);
    topics_text(&items)
}

#[test]
fn a_max_tokens_stop_is_truncated() {
    let h = hierarchy("vtaiwan");
    let (file, calls) = run(&h, vec![Reply::ok(message("{\"topics\": [", "max_tokens"))]);
    assert_eq!((file.outcome.as_str(), calls), ("truncated", 1));
    assert_eq!(file.record.stop_reason.as_deref(), Some("max_tokens"));
    assert_eq!(file.record.tokens_out, Some(50));
}

#[test]
fn a_refusal_is_refused() {
    let h = hierarchy("vtaiwan");
    let (file, calls) = run(&h, vec![Reply::ok(message("", "refusal"))]);
    assert_eq!((file.outcome.as_str(), calls), ("refused", 1));
}

#[test]
fn a_429_then_200_is_one_retry() {
    let h = hierarchy("vtaiwan");
    let ok = support::fixture(VT_SONNET);
    let (file, calls) = run_with_cap(&h, vec![Reply::status(429, Some("0")), Reply::ok(ok)], 1.0);
    assert_eq!((file.outcome.as_str(), calls), ("named", 2));
    assert_eq!(file.record.attempts, 2);
}

#[test]
fn a_429_twice_is_http_429_after_one_retry() {
    let h = hierarchy("vtaiwan");
    let (file, calls) = run_with_cap(
        &h,
        vec![Reply::status(429, Some("0")), Reply::status(429, Some("0"))],
        1.0,
    );
    assert_eq!((file.outcome.as_str(), calls), ("http_429", 2));
    assert_eq!(file.record.http_status, Some(429));
    assert_eq!(file.record.tokens_in, None);
    assert_eq!(file.record.dollars, None);
}

#[test]
fn a_529_then_503_is_http_503() {
    let h = hierarchy("vtaiwan");
    let (file, calls) = run_with_cap(
        &h,
        vec![Reply::status(529, None), Reply::status(503, None)],
        1.0,
    );
    assert_eq!((file.outcome.as_str(), calls), ("http_503", 2));
}

#[test]
fn a_400_is_not_retried() {
    let h = hierarchy("vtaiwan");
    let (file, calls) = run(&h, vec![Reply::status(400, None)]);
    assert_eq!((file.outcome.as_str(), calls), ("http_400", 1));
    assert_eq!(file.record.attempts, 1);
}

#[test]
fn a_reply_that_never_comes_is_timeout_and_not_retried() {
    let h = hierarchy("vtaiwan");
    let stub = Stub::start(vec![Reply::Hang(Duration::from_secs(2))]);
    let mut s = settings(&stub.url);
    s.timeout = Duration::from_millis(300);
    let file = name_topics(
        &h,
        &namer("haiku", "default"),
        Some("test-key"),
        RunCap::Usd(0.5),
        &s,
    );
    assert_eq!(file.outcome, "timeout");
    assert_eq!(file.record.attempts, 1);
    assert_eq!(stub.finish().len(), 1);
}

#[test]
fn no_listener_is_connect_error_after_one_retry() {
    let h = hierarchy("vtaiwan");
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let s = settings(&format!("http://127.0.0.1:{port}/v1"));
    let file = name_topics(
        &h,
        &namer("haiku", "default"),
        Some("test-key"),
        RunCap::Usd(0.5),
        &s,
    );
    assert_eq!(file.outcome, "connect_error");
    assert_eq!(file.record.attempts, 2);
    assert_eq!(file.record.tokens_in, None);
}

#[test]
fn a_missing_unknown_or_repeated_id_is_bad_cover() {
    let h = hierarchy("vtaiwan");
    for text in [
        vtaiwan_text_with(|i| {
            i.pop();
        }),
        vtaiwan_text_with(|i| i.push(("9_9".into(), "Elsewhere".into()))),
        vtaiwan_text_with(|i| {
            let first = i[0].clone();
            i.push(first);
        }),
    ] {
        let (file, calls) = run(&h, vec![Reply::ok(message(&text, "end_turn"))]);
        assert_eq!(
            (file.outcome.as_str(), calls),
            ("bad_cover", 1),
            "{:?}",
            file.reason
        );
        assert!(file.names.is_empty());
    }
}

#[test]
fn text_that_is_not_the_schema_is_bad_json() {
    let h = hierarchy("vtaiwan");
    for text in [
        "Here are your names: ...",
        "{\"names\": []}",
        "{\"topics\": [{\"id\": 1}]}",
    ] {
        let (file, _) = run(&h, vec![Reply::ok(message(text, "end_turn"))]);
        assert_eq!(file.outcome, "bad_json", "{text}");
    }
    let (file, _) = run(&h, vec![Reply::ok("not json at all")]);
    assert_eq!(file.outcome, "bad_json");
    let (file, _) = run(&h, vec![Reply::ok(message("{}", "pause_turn"))]);
    assert_eq!(file.outcome, "bad_json");
    assert!(file.reason.unwrap().contains("pause_turn"));
}

#[test]
fn two_names_alike_in_one_layer_are_repeated_names() {
    let h = hierarchy("vtaiwan");
    let layer0: Vec<String> = h
        .topics()
        .iter()
        .filter(|t| t.layer == 0)
        .map(|t| t.id.clone())
        .collect();
    let text = vtaiwan_text_with(|items| {
        let name = items
            .iter()
            .find(|(id, _)| *id == layer0[0])
            .unwrap()
            .1
            .clone();
        for (id, n) in items.iter_mut() {
            if *id == layer0[1] {
                *n = format!(" {} ", name.to_uppercase());
            }
        }
    });
    let (file, _) = run(&h, vec![Reply::ok(message(&text, "end_turn"))]);
    assert_eq!(file.outcome, "repeated_names", "{:?}", file.reason);
}

#[test]
fn a_name_over_fifty_characters_or_empty_is_bad_length() {
    let h = hierarchy("vtaiwan");
    for long in ["計".repeat(51), "**".to_string()] {
        let text = vtaiwan_text_with(|items| items[0].1 = long.clone());
        let (file, _) = run(&h, vec![Reply::ok(message(&text, "end_turn"))]);
        assert_eq!(file.outcome, "bad_length", "{:?}", file.reason);
    }
}

#[test]
fn over_the_run_cap_makes_no_call() {
    let h = hierarchy("bg2050");
    let stub = Stub::start(vec![]);
    // Sonnet's worst case for Bowling Green is about $0.46.
    let file = name_topics(
        &h,
        &namer("sonnet", "default"),
        Some("test-key"),
        RunCap::Usd(0.40),
        &settings(&stub.url),
    );
    assert_eq!(file.outcome, "over_run_cap");
    assert!(file.record.worst_case_usd > 0.40);
    assert_eq!(file.record.run_max_usd, Some(0.40));
    let file = name_topics(
        &h,
        &namer("sonnet", "default"),
        Some("test-key"),
        RunCap::Unreadable,
        &settings(&stub.url),
    );
    assert_eq!(file.outcome, "over_run_cap");
    assert_eq!(stub.finish().len(), 0);
}

#[test]
fn no_key_makes_no_call() {
    let h = hierarchy("vtaiwan");
    let stub = Stub::start(vec![]);
    for key in [None, Some("")] {
        let file = name_topics(
            &h,
            &namer("haiku", "default"),
            key,
            RunCap::Usd(0.5),
            &settings(&stub.url),
        );
        assert_eq!(file.outcome, "no_key");
        assert_eq!(file.record.attempts, 0);
        assert_eq!(file.record.tokens_in, None);
    }
    assert_eq!(stub.finish().len(), 0);
}

#[test]
fn more_than_four_hundred_topics_is_too_large_with_no_call() {
    let mut topics = BTreeMap::new();
    for c in 0..401u32 {
        let id = format!("0_{c}");
        topics.insert(
            id.clone(),
            Topic {
                id,
                layer: 0,
                cluster: c,
                size: 3,
                parent: None,
                keywords: vec!["a".into()],
                samples3: vec!["one".into()],
            },
        );
    }
    let h = Hierarchy::from_topics(topics).unwrap();
    let stub = Stub::start(vec![]);
    let file = name_topics(
        &h,
        &namer("haiku", "default"),
        Some("test-key"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    assert_eq!(file.outcome, "too_large");
    assert_eq!(stub.finish().len(), 0);
}

#[test]
fn more_than_the_counted_input_limit_is_too_large_with_no_call() {
    let mut topics = BTreeMap::new();
    for c in 0..50u32 {
        let id = format!("0_{c}");
        topics.insert(
            id.clone(),
            Topic {
                id,
                layer: 0,
                cluster: c,
                size: 3,
                parent: None,
                keywords: vec!["a".into()],
                samples3: vec!["x".repeat(1_000); 3],
            },
        );
    }
    let h = Hierarchy::from_topics(topics).unwrap();
    let stub = Stub::start(vec![]);
    let file = name_topics(
        &h,
        &namer("haiku", "default"),
        Some("test-key"),
        RunCap::Usd(50.0),
        &settings(&stub.url),
    );
    assert_eq!(file.outcome, "too_large");
    assert_eq!(stub.finish().len(), 0);
}
