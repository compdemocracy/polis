#![allow(clippy::unwrap_used)]
mod support;
use polis_topic_names::{RunCap, name_topics};
use support::{Reply, Stub, fixture, hierarchy, namer, settings};

#[test]
fn malformed_usage_is_an_outcome_not_a_panic() {
    let mut reply: serde_json::Value =
        serde_json::from_str(&fixture("replies/vtaiwan/sonnet-default-r1.json")).unwrap();
    reply["usage"]["input_tokens"] = serde_json::json!(u64::MAX);
    reply["usage"]["cache_creation_input_tokens"] = serde_json::json!(1);
    let stub = Stub::start(vec![Reply::ok(reply.to_string())]);
    let file = name_topics(
        &hierarchy("vtaiwan"),
        &namer("sonnet", "default"),
        Some("test-key"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    stub.finish();
    assert_eq!(file.outcome, "bad_json");
}

#[test]
fn unrecognized_stop_reason_is_not_persisted() {
    let marker = "invented-private-provider-echo";
    let mut reply: serde_json::Value =
        serde_json::from_str(&fixture("replies/vtaiwan/sonnet-default-r1.json")).unwrap();
    reply["stop_reason"] = serde_json::json!(marker);
    let stub = Stub::start(vec![Reply::ok(reply.to_string())]);
    let file = name_topics(
        &hierarchy("vtaiwan"),
        &namer("sonnet", "default"),
        Some(marker),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    stub.finish();
    assert_eq!(file.outcome, "bad_json");
    assert!(!file.to_json().contains(marker));
}

#[test]
fn multibyte_input_uses_a_byte_budget() {
    let h = hierarchy("vtaiwan");
    let n = namer("sonnet", "default");
    let body = polis_topic_names::prompt::body_v1(&h, &n);
    assert!(body.len() > body.chars().count());
    let scalar_cost = n.model.worst_case_usd(body.chars().count() as u64, 32_000);
    let byte_cost = n.model.worst_case_usd(body.len() as u64, 32_000);
    let file = name_topics(
        &h,
        &n,
        None,
        RunCap::Usd((scalar_cost + byte_cost) / 2.0),
        &settings("http://127.0.0.1:9/v1"),
    );
    assert_eq!(file.outcome, "over_run_cap");
    assert_eq!(file.record.attempts, 0);
}
