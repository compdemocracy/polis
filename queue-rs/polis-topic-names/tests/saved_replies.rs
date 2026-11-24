//! Every whole-hierarchy reply the 2026-11-22 measurement saved, served by the
//! local stub: each parses and covers every topic, and each gives the outcome
//! the measurement's own reading of it predicts.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_names::check::{self, Parsed};
use polis_topic_names::{RunCap, name_topics};
use support::{Reply, Stub, fixture, hierarchy, namer, settings};

/// The outcome each saved reply should give.
fn expected(conv: &str, model: &str, setting: &str, rep: u32) -> &'static str {
    match (conv, model, setting, rep) {
        // Haiku named vTaiwan's Chinese comments in English every time.
        ("vtaiwan", "haiku", _, _) => "wrong_language",
        // Haiku's third default reply named Mobilität's German comments in English.
        ("mobilitaet", "haiku", "default", 3) => "wrong_language",
        _ => "named",
    }
}

#[test]
fn every_saved_reply_parses_covers_and_gives_its_outcome() {
    let mut seen = 0;
    for conv in ["bg2050", "mobilitaet", "vtaiwan"] {
        let h = hierarchy(conv);
        for model in ["haiku", "sonnet"] {
            for setting in ["default", "off"] {
                for rep in 1..=3 {
                    let rel = format!("replies/{conv}/{model}-{setting}-r{rep}.json");
                    let reply = fixture(&rel);

                    // Parses and names every topic exactly once.
                    let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
                    assert_eq!(v["stop_reason"], "end_turn", "{rel}");
                    let text: String = v["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|b| b["type"] == "text")
                        .map(|b| b["text"].as_str().unwrap())
                        .collect();
                    match check::parse_and_cover(&h, &text) {
                        Parsed::Covered(names) => assert_eq!(names.len(), h.len(), "{rel}"),
                        other => panic!("{rel}: {other:?}"),
                    }

                    // Through the stub, the whole program path.
                    let stub = Stub::start(vec![Reply::ok(reply.clone())]);
                    let file = name_topics(
                        &h,
                        &namer(model, setting),
                        Some("test-key"),
                        RunCap::Usd(0.5),
                        &settings(&stub.url),
                    );
                    assert_eq!(stub.finish().len(), 1, "{rel}");
                    let want = expected(conv, model, setting, rep);
                    assert_eq!(file.outcome, want, "{rel}: {:?}", file.reason);
                    assert_eq!(file.record.attempts, 1);
                    assert_eq!(
                        file.record.tokens_in,
                        v["usage"]["input_tokens"].as_u64(),
                        "{rel}"
                    );
                    assert_eq!(
                        file.record.tokens_out,
                        v["usage"]["output_tokens"].as_u64(),
                        "{rel}"
                    );
                    assert!(file.record.dollars.unwrap() > 0.0);
                    if want == "named" {
                        assert_eq!(file.names.len(), h.len(), "{rel}");
                        assert!(file.reason.is_none());
                        for t in h.topics() {
                            let n = &file.names[&t.id];
                            assert!(
                                !n.is_empty() && n.chars().count() <= 50,
                                "{rel} {}: {n}",
                                t.id
                            );
                        }
                    } else {
                        assert!(file.names.is_empty());
                        assert!(file.reason.is_some());
                    }
                    seen += 1;
                }
            }
        }
    }
    assert_eq!(seen, 36);
}

#[test]
fn the_mis_encoded_urdu_reply_is_wrong_language() {
    // Sonnet with thinking off, asked for Urdu in its own call, returned Urdu
    // written as UTF-8 and read as Windows-1251.
    let h = hierarchy("bg2050");
    let reply = fixture("replies/bg2050/sonnet-off-urdu-own-call.json");
    let stub = Stub::start(vec![Reply::ok(reply)]);
    let file = name_topics(
        &h,
        &namer("sonnet", "off"),
        Some("test-key"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    stub.finish();
    assert_eq!(file.outcome, "wrong_language", "{:?}", file.reason);
    assert!(file.reason.unwrap().contains("mis-encoded"));
    assert!(file.names.is_empty());
}
