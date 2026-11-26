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
fn exactly_two_estimates_allow_one_retry() {
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
    assert_eq!(stub.finish().len(), 2);
    assert_eq!(file.record.attempts, 2);
    assert_eq!(file.outcome, "http_500");
}
