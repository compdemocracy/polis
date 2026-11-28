//! The request body is the 2026-11-22 measurement's saved body for the same
//! call, byte for byte, plus the one language sentence; and it is what reaches
//! the wire.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_names::prompt::{self, LANGUAGE_SENTENCE};
use polis_topic_names::{RunCap, name_topics};
use support::{Reply, Stub, fixture, hierarchy, message, namer, settings, topics_text};

const ANCHOR: &str = "No two topics may share a name.";

fn with_sentence(saved: &str) -> String {
    assert_eq!(saved.matches(ANCHOR).count(), 1);
    saved.replacen(ANCHOR, &format!("{ANCHOR} {LANGUAGE_SENTENCE}"), 1)
}

#[test]
fn bowling_green_haiku_default_is_the_saved_body_plus_the_sentence() {
    let h = hierarchy("bg2050");
    let n = namer("haiku", "default");
    let saved = fixture("requests/bg2050-haiku-default.json");
    let measured = prompt::body_with_instruction(&h, &n, &prompt::instruction_measured());
    assert_eq!(
        measured, saved,
        "the measured instruction gives the saved body exactly"
    );
    assert_eq!(prompt::body_v1(&h, &n), with_sentence(&saved));
}

#[test]
fn bowling_green_sonnet_off_is_the_saved_body_plus_the_sentence() {
    let h = hierarchy("bg2050");
    let n = namer("sonnet", "off");
    let saved = fixture("requests/bg2050-sonnet-off.json");
    let measured = prompt::body_with_instruction(&h, &n, &prompt::instruction_measured());
    assert_eq!(measured, saved);
    assert!(saved.contains(r#""thinking": {"type": "between_tools"}"#));
    assert_eq!(prompt::body_v1(&h, &n), with_sentence(&saved));
}

#[test]
fn the_wire_carries_the_body_and_only_the_named_headers() {
    let h = hierarchy("bg2050");
    let n = namer("haiku", "default");
    let reply = fixture("replies/bg2050/haiku-default-r1.json");
    let stub = Stub::start(vec![Reply::ok(reply)]);
    let file = name_topics(
        &h,
        &n,
        Some("test-key-not-real"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    let got = stub.finish();
    assert_eq!(file.outcome, "named", "{:?}", file.reason);
    assert_eq!(got.len(), 1);
    let r = &got[0];
    assert_eq!(r.request_line, "POST /v1/messages HTTP/1.1");
    assert_eq!(
        String::from_utf8(r.body.clone()).unwrap(),
        with_sentence(&fixture("requests/bg2050-haiku-default.json"))
    );
    let header = |k: &str| {
        r.headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(header("x-api-key"), Some("test-key-not-real"));
    assert_eq!(header("anthropic-version"), Some("2026-10-21"));
    assert_eq!(header("content-type"), Some("application/json"));
    for (k, v) in &r.headers {
        assert!(
            [
                "host",
                "content-type",
                "anthropic-version",
                "x-api-key",
                "content-length",
                "accept"
            ]
            .contains(&k.as_str()),
            "unexpected header {k}"
        );
        assert!(
            !v.to_ascii_lowercase().contains("polis"),
            "header {k} names the project"
        );
    }
    let body = String::from_utf8(r.body.clone()).unwrap();
    assert!(!body.to_ascii_lowercase().contains("polis"));
}

#[test]
fn only_five_keywords_and_three_samples_are_sent() {
    let mut topics = std::collections::BTreeMap::new();
    topics.insert(
        "0_0".to_string(),
        polis_topic_names::Topic {
            id: "0_0".into(),
            layer: 0,
            cluster: 0,
            size: 9,
            parent: None,
            keywords: (1..=8).map(|i| format!("kw{i}")).collect(),
            samples3: (1..=6).map(|i| format!("sample {i}")).collect(),
        },
    );
    let h = polis_topic_names::Hierarchy::from_topics(topics).unwrap();
    let text = prompt::hierarchy_text(&h);
    assert_eq!(
        text,
        "0_0 | layer 0 | parent: none | 9 comments | keywords: kw1, kw2, kw3, kw4, kw5\n   1. sample 1\n   2. sample 2\n   3. sample 3\n"
    );
    // A name for it, through the stub, to show the body is what is sent.
    let text = topics_text(&[("0_0".to_string(), "Samples".to_string())]);
    let stub = Stub::start(vec![Reply::ok(message(&text, "end_turn"))]);
    let file = name_topics(
        &h,
        &namer("haiku", "default"),
        Some("k"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    let got = stub.finish();
    assert_eq!(file.outcome, "named");
    let body = String::from_utf8(got[0].body.clone()).unwrap();
    assert!(!body.contains("kw6") && !body.contains("sample 4"));
}
