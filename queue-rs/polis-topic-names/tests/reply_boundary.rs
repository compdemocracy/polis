//! What a provider sends back can end the naming only as an outcome, and only
//! the checked names and fixed words reach `names.json` and the log line.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_names::{RunCap, name_topics};
use std::process::Command;
use support::{
    Reply, Stub, fixture, fixture_path, hierarchy, message, namer, saved_topics, settings,
    topics_text,
};

const MARKER: &str = "PLANTED-MARKER-7F3A";
const VT_SONNET: &str = "replies/vtaiwan/sonnet-default-r1.json";

fn name_vtaiwan(reply: Reply) -> polis_topic_names::NamesFile {
    let stub = Stub::start(vec![reply]);
    let file = name_topics(
        &hierarchy("vtaiwan"),
        &namer("sonnet", "default"),
        Some("test-key"),
        RunCap::Usd(0.5),
        &settings(&stub.url),
    );
    stub.finish();
    file
}

/// The client's bound on a reply body, 4 MiB.
const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;

#[test]
fn an_oversize_body_is_bad_json_and_not_read() {
    let file = name_vtaiwan(Reply::ok(vec![b' '; MAX_REPLY_BYTES + 1]));
    assert_eq!(file.outcome, "bad_json");
    assert_eq!(
        file.reason.as_deref(),
        Some("the reply body is over 4194304 bytes")
    );
    assert_eq!(file.record.attempts, 1);
}

#[test]
fn invalid_utf8_is_bad_json() {
    let mut body = fixture(VT_SONNET).into_bytes();
    // Cut a three-byte character in half inside the reply's text.
    let at = body.windows(3).position(|w| w[0] >= 0xE0).unwrap();
    body.remove(at + 1);
    let file = name_vtaiwan(Reply::ok(body));
    assert_eq!(file.outcome, "bad_json");
    assert_eq!(file.reason.as_deref(), Some("the reply body is not JSON"));
}

#[test]
fn usage_of_the_wrong_type_is_bad_json() {
    for usage in [
        serde_json::json!({"input_tokens": 100, "output_tokens": "50"}),
        serde_json::json!({"input_tokens": -1, "output_tokens": 50}),
        serde_json::json!({"input_tokens": 1.5, "output_tokens": 50}),
        serde_json::json!({"input_tokens": 100, "output_tokens": u64::MAX, "cache_read_input_tokens": u64::MAX}),
        serde_json::json!(MARKER),
    ] {
        let mut reply: serde_json::Value = serde_json::from_str(&fixture(VT_SONNET)).unwrap();
        reply["usage"] = usage.clone();
        let file = name_vtaiwan(Reply::ok(reply.to_string()));
        assert_eq!(file.outcome, "bad_json", "{usage}");
        assert_eq!(
            file.reason.as_deref(),
            Some("the reply's usage counts are not valid")
        );
        assert!(!file.to_json().contains(MARKER));
        assert_eq!(file.record.tokens_in, None);
    }
}

#[test]
fn a_name_with_a_control_character_is_refused_and_not_copied() {
    for bad in [
        format!("{MARKER}\u{7}"),
        format!("\u{202E}{MARKER}"),
        format!("{MARKER}\u{200B}x"),
        format!("{MARKER}\u{E0041}"),
        format!("{MARKER}\u{9f}"),
    ] {
        let mut items = saved_topics(VT_SONNET);
        items[0].1 = bad.clone();
        let file = name_vtaiwan(Reply::ok(message(&topics_text(&items), "end_turn")));
        assert_eq!(file.outcome, "wrong_language", "{bad:?}");
        assert!(file.names.is_empty());
        assert!(!file.to_json().contains(MARKER), "{bad:?}");
    }
}

#[test]
fn joiners_inside_a_name_are_accepted() {
    let mut items = saved_topics(VT_SONNET);
    items[0].1 = format!("{}\u{200D}{}", items[0].1, "\u{200C}");
    let file = name_vtaiwan(Reply::ok(message(&topics_text(&items), "end_turn")));
    assert_eq!(file.outcome, "named");
}

#[test]
fn an_error_body_is_never_copied() {
    let body = format!(r#"{{"type":"error","error":{{"type":"{MARKER}","message":"{MARKER}"}}}}"#);
    let file = name_vtaiwan(Reply::Http {
        status: 400,
        headers: vec![("x-request-id".into(), MARKER.into())],
        body: body.into_bytes(),
    });
    assert_eq!(file.outcome, "http_400");
    assert!(!file.to_json().contains(MARKER));
}

#[test]
fn the_program_logs_no_provider_text() {
    let dir = std::env::temp_dir().join(format!(
        "polis-topic-names-test-{}-boundary",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("names.json");
    let mut reply: serde_json::Value = serde_json::from_str(&fixture(VT_SONNET)).unwrap();
    reply["stop_reason"] = serde_json::json!(format!("{MARKER}\u{1b}[31m"));
    reply["id"] = serde_json::json!(MARKER);
    let stub = Stub::start(vec![Reply::ok(reply.to_string())]);
    let output = Command::new(env!("CARGO_BIN_EXE_polis-topic-names"))
        .args(["name", "--in"])
        .arg(fixture_path("hierarchies/vtaiwan.json"))
        .arg("--out")
        .arg(&out)
        .arg("--namer")
        .arg(r#"{"model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#)
        .arg("--api-base")
        .arg(&stub.url)
        .env("DELPHI_NAMING_ANTHROPIC_API_KEY", "test-key")
        .env_remove("DELPHI_NAMING_RUN_MAX_USD")
        .output()
        .unwrap();
    stub.finish();
    assert!(output.status.success());
    let log = String::from_utf8_lossy(&output.stderr);
    let written = std::fs::read_to_string(&out).unwrap();
    assert!(
        log.contains("outcome bad_json (stop reason unknown)"),
        "{log}"
    );
    assert!(!log.contains(MARKER) && !log.contains('\u{1b}'), "{log}");
    assert!(!written.contains(MARKER), "{written}");
    assert!(written.contains(r#""stop_reason": "unknown""#), "{written}");
    let _ = std::fs::remove_dir_all(&dir);
}
