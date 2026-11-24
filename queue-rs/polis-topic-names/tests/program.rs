//! The program as the naming step runs it: argv, environment, files and exit
//! status.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use support::{Reply, Stub, fixture, fixture_path};

const HAIKU: &str =
    r#"{"model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "polis-topic-names-test-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn program(input: &Path, out: &Path, namer: &str) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_polis-topic-names"));
    c.arg("name")
        .arg("--in")
        .arg(input)
        .arg("--out")
        .arg(out)
        .arg("--namer")
        .arg(namer);
    c.env_remove("DELPHI_NAMING_ANTHROPIC_API_KEY")
        .env_remove("DELPHI_NAMING_RUN_MAX_USD");
    c
}

fn read(out: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(out).unwrap()).unwrap()
}

#[test]
fn with_no_key_it_writes_no_key_and_exits_zero() {
    let dir = scratch("nokey");
    let out = dir.join("names.json");
    let status = program(&fixture_path("hierarchies/vtaiwan.json"), &out, HAIKU)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
    let v = read(&out);
    assert_eq!(v["schema"], "polis-topic-names.names/1");
    assert_eq!(v["outcome"], "no_key");
    assert_eq!(v["names"], serde_json::json!({}));
    assert_eq!(v["record"]["model"], "claude-haiku-5-5");
    assert_eq!(v["record"]["prompt"], "polis-topic-names/1");
    assert_eq!(v["record"]["thinking"], "default");
    assert_eq!(v["record"]["namer"], "claude-haiku-5-5.p1.default");
    assert!(v["record"]["tokens_in"].is_null() && v["record"]["dollars"].is_null());
    assert_eq!(v["record"]["run_max_usd"], 0.5);
}

#[test]
fn with_a_key_it_names_through_the_stub() {
    let dir = scratch("named");
    let out = dir.join("names.json");
    let stub = Stub::start(vec![Reply::ok(fixture(
        "replies/vtaiwan/sonnet-default-r1.json",
    ))]);
    let namer = r#"{"by":"model","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#;
    let status = program(&fixture_path("hierarchies/vtaiwan.json"), &out, namer)
        .arg("--api-base")
        .arg(&stub.url)
        .env("DELPHI_NAMING_ANTHROPIC_API_KEY", "test-key")
        .env("DELPHI_NAMING_RUN_MAX_USD", "0.40")
        .status()
        .unwrap();
    assert_eq!(stub.finish().len(), 1);
    assert_eq!(status.code(), Some(0));
    let v = read(&out);
    assert_eq!(v["outcome"], "named");
    assert!(v["reason"].is_null());
    assert_eq!(v["names"].as_object().unwrap().len(), 16);
    assert_eq!(v["record"]["tokens_in"], 4403);
    assert_eq!(v["record"]["run_max_usd"], 0.4);
    assert!(!dir.join("names.json.tmp").exists());
}

#[test]
fn an_unknown_namer_or_flag_is_exit_two_and_writes_nothing() {
    let dir = scratch("usage");
    let out = dir.join("names.json");
    let input = fixture_path("hierarchies/vtaiwan.json");
    let bad = r#"{"model":"claude-opus-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#;
    assert_eq!(program(&input, &out, bad).status().unwrap().code(), Some(2));
    assert_eq!(
        program(&input, &out, HAIKU)
            .arg("--extra")
            .arg("x")
            .status()
            .unwrap()
            .code(),
        Some(2)
    );
    let status = Command::new(env!("CARGO_BIN_EXE_polis-topic-names"))
        .arg("names")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
    assert!(!out.exists());
}

#[test]
fn a_bad_hierarchy_is_exit_one_and_writes_nothing() {
    let dir = scratch("badinput");
    let out = dir.join("names.json");
    let input = dir.join("hierarchy.json");
    for text in [
        "not json",
        r#"{"schema":"other/1","topics":{}}"#,
        r#"{"schema":"polis-topic-names.hierarchy/1","topics":{}}"#,
        r#"{"schema":"polis-topic-names.hierarchy/1","topics":{"0_1":{"id":"0_1","layer":0,"cluster":2,"size":1}}}"#,
        r#"{"schema":"polis-topic-names.hierarchy/1","topics":{"0_1":{"id":"0_1","layer":0,"cluster":1,"size":1,"parent":"2_0"}}}"#,
    ] {
        std::fs::write(&input, text).unwrap();
        assert_eq!(
            program(&input, &out, HAIKU).status().unwrap().code(),
            Some(1),
            "{text}"
        );
        assert!(!out.exists());
    }
    assert_eq!(
        program(&dir.join("missing.json"), &out, HAIKU)
            .status()
            .unwrap()
            .code(),
        Some(1)
    );
}
