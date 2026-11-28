#![allow(clippy::unwrap_used)]
mod support;
use polis_topic_names::{RunCap, name_topics, prompt};
use support::{Reply, Stub, hierarchy, namer, settings};

#[test]
fn a_retry_must_fit_the_run_budget_too() {
    let h = hierarchy("bg2050");
    let n = namer("sonnet", "default");
    let stub = Stub::start(vec![Reply::status(500, Some("0"))]);
    let file = name_topics(
        &h,
        &n,
        Some("test-key"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    assert_eq!(stub.finish().len(), 1);
    assert_eq!(file.record.attempts, 1);
    assert_eq!(file.outcome, "http_500");
    assert!(file.record.worst_case_usd <= 0.5);
    assert!(2.0 * file.record.worst_case_usd > 0.5);
}

#[test]
fn a_cap_of_two_estimates_still_sends_once() {
    // A cap that would afford two attempts no longer buys a second request:
    // the request is written at most once.
    let h = hierarchy("bg2050");
    let n = namer("sonnet", "default");
    let worst = n
        .model
        .worst_case_usd(prompt::body_v1(&h, &n).len() as u64, prompt::MAX_TOKENS);
    let stub = Stub::start(vec![
        Reply::status(500, Some("0")),
        Reply::status(500, Some("0")),
    ]);
    let file = name_topics(
        &h,
        &n,
        Some("test-key"),
        RunCap::Usd(2.0 * worst),
        &settings(&stub.url),
    );
    assert_eq!(stub.finish().len(), 1);
    assert_eq!(file.record.attempts, 1);
    assert!(file.record.request_sent);
    assert_eq!(file.outcome, "http_500");
}
