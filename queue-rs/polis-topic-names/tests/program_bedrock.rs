//! The program with a Bedrock namer, as the naming step would run it: the
//! region from `AWS_REGION`, credentials from the default AWS credential
//! chain (here the environment, with made-up values), no key read, and
//! `names.json` written with exit status 0 whatever the outcome.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use support::{Reply, Stub, fixture, fixture_path};

const SONNET_BEDROCK: &str = r#"{"by":"model","provider":"bedrock","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#;

/// Every variable the default AWS credential and region chain reads.
const AWS_VARS: [&str; 14] = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_BEARER_TOKEN_BEDROCK",
];

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "polis-topic-names-bedrock-test-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The program with every AWS setting removed, the profile files pointed at
/// files that do not exist, and the instance metadata service switched off,
/// so nothing outside the test can supply a credential.
fn program(dir: &Path, input: &Path, out: &Path, api_base: &str) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_polis-topic-names"));
    c.arg("name")
        .arg("--in")
        .arg(input)
        .arg("--out")
        .arg(out)
        .arg("--namer")
        .arg(SONNET_BEDROCK)
        .arg("--api-base")
        .arg(api_base);
    for v in AWS_VARS {
        c.env_remove(v);
    }
    c.env_remove("DELPHI_NAMING_RUN_MAX_USD")
        .env("HOME", dir)
        .env("AWS_CONFIG_FILE", dir.join("no-such-config"))
        .env(
            "AWS_SHARED_CREDENTIALS_FILE",
            dir.join("no-such-credentials"),
        )
        .env("AWS_EC2_METADATA_DISABLED", "true")
        // A key in the environment is never read for a Bedrock namer.
        .env(
            "DELPHI_NAMING_ANTHROPIC_API_KEY",
            "test-key-must-not-be-sent",
        );
    c
}

fn read(out: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(out).unwrap()).unwrap()
}

#[test]
fn credentials_from_the_environment_sign_the_call_and_no_key_is_sent() {
    let dir = scratch("env-creds");
    let out = dir.join("names.json");
    let stub = Stub::start(vec![Reply::ok(fixture(
        "replies/vtaiwan/sonnet-default-r1.json",
    ))]);
    let base = stub.url.replace("/v1", "/anthropic/v1");
    let status = program(&dir, &fixture_path("hierarchies/vtaiwan.json"), &out, &base)
        .env("AWS_REGION", "us-east-1")
        .env("AWS_ACCESS_KEY_ID", "AKIDEXAMPLENOTREAL02")
        .env("AWS_SECRET_ACCESS_KEY", "made-up-secret")
        .env("AWS_SESSION_TOKEN", "made-up-token")
        .status()
        .unwrap();
    let got = stub.finish();
    assert_eq!(status.code(), Some(0));
    let v = read(&out);
    assert_eq!(v["outcome"], "named", "{v}");
    assert_eq!(v["record"]["provider"], "bedrock");
    assert_eq!(v["record"]["model"], "claude-sonnet-5-5");
    assert_eq!(v["record"]["namer"], "bedrock.claude-sonnet-5-5.p1.default");
    assert_eq!(got.len(), 1);
    let r = &got[0];
    assert_eq!(r.request_line, "POST /anthropic/v1/messages HTTP/1.1");
    let header = |k: &str| {
        r.headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(header("x-api-key"), None);
    let auth = header("authorization").unwrap();
    assert!(
        auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLENOTREAL02/"),
        "{auth}"
    );
    assert!(
        auth.contains("/us-east-1/bedrock-mantle/aws4_request,"),
        "{auth}"
    );
    assert_eq!(
        header("x-amz-security-token").as_deref(),
        Some("made-up-token")
    );
    let body = String::from_utf8(r.body.clone()).unwrap();
    assert!(body.starts_with(r#"{"model": "anthropic.claude-sonnet-5-5", "max_tokens": 32000"#));
    // Nothing secret reaches the file.
    let text = std::fs::read_to_string(&out).unwrap();
    for secret in [
        "made-up-secret",
        "made-up-token",
        "test-key-must-not-be-sent",
    ] {
        assert!(!text.contains(secret));
    }
}

#[test]
fn with_no_credentials_in_the_chain_it_writes_no_credentials_and_exits_zero() {
    let dir = scratch("no-creds");
    let out = dir.join("names.json");
    let stub = Stub::start(vec![]);
    let base = stub.url.replace("/v1", "/anthropic/v1");
    let status = program(&dir, &fixture_path("hierarchies/vtaiwan.json"), &out, &base)
        .env("AWS_REGION", "us-east-1")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(stub.finish().is_empty());
    let v = read(&out);
    assert_eq!(v["outcome"], "no_credentials", "{v}");
    assert_eq!(v["names"], serde_json::json!({}));
    assert_eq!(v["record"]["attempts"], 0);
    assert!(v["record"]["dollars"].is_null());
}

#[test]
fn with_no_region_it_writes_no_region_and_exits_zero() {
    let dir = scratch("no-region");
    let out = dir.join("names.json");
    let stub = Stub::start(vec![]);
    let base = stub.url.replace("/v1", "/anthropic/v1");
    let status = program(&dir, &fixture_path("hierarchies/vtaiwan.json"), &out, &base)
        .env("AWS_ACCESS_KEY_ID", "AKIDEXAMPLENOTREAL03")
        .env("AWS_SECRET_ACCESS_KEY", "made-up-secret")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(stub.finish().is_empty());
    assert_eq!(read(&out)["outcome"], "no_region");
}

#[test]
fn an_unknown_provider_is_a_usage_error() {
    let dir = scratch("bad-provider");
    let out = dir.join("names.json");
    let status = Command::new(env!("CARGO_BIN_EXE_polis-topic-names"))
        .arg("name")
        .arg("--in")
        .arg(fixture_path("hierarchies/vtaiwan.json"))
        .arg("--out")
        .arg(&out)
        .arg("--namer")
        .arg(r#"{"provider":"vertex","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
    assert!(!out.exists());
}
