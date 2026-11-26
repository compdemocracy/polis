//! The Amazon Bedrock provider, offline: every call goes to the local stub on
//! 127.0.0.1, signed with made-up credentials. The request is the saved
//! study body with only the model id changed; it carries a Signature Version 4
//! signature for `bedrock-mantle` in the given region, checked here
//! independently of the signer; it never carries `x-api-key`; and every way the
//! call can fail is an outcome that keeps the keyword names.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use hmac::{Hmac, Mac};
use polis_topic_names::client::{AwsCredentials, Settings};
use polis_topic_names::prompt::{self, LANGUAGE_SENTENCE};
use polis_topic_names::{
    Access, GivenPrice, Hierarchy, Model, Namer, NamesFile, PriceSetting, RunCap, name_topics_with,
};
use sha2::{Digest, Sha256};
use std::time::Duration;
use support::{Received, Reply, Stub, fixture, hierarchy, message, saved_topics, topics_text};

const AKID: &str = "AKIDEXAMPLENOTREAL01";
const SECRET: &str = "made-up-secret-for-the-offline-tests-only";
const TOKEN: &str = "made-up-session-token";
const REGION: &str = "us-east-1";
const VT_SONNET: &str = "replies/vtaiwan/sonnet-default-r1.json";

fn bedrock(model: &str, thinking: &str) -> Namer {
    Namer::from_json(&format!(
        r#"{{"by":"model","provider":"bedrock","model":"claude-{model}-5-5","prompt":"polis-topic-names/1","thinking":"{thinking}"}}"#
    ))
    .unwrap()
}

fn given() -> AwsCredentials {
    AwsCredentials::Given {
        access_key_id: AKID.into(),
        secret_access_key: SECRET.into(),
        session_token: Some(TOKEN.into()),
    }
}

/// A made-up test price per million tokens, the Claude API's row plus a
/// tenth, so these tests' arithmetic is easy to follow.
const TEST_SOURCE: &str = "made-up test price";

fn test_price(n: &Namer) -> PriceSetting {
    let (input, output) = match n.model {
        Model::Haiku => ("0.11", "0.55"),
        Model::Sonnet => ("2.2", "11"),
    };
    GivenPrice::from_settings(Some(input), Some(output), Some(TEST_SOURCE))
}

/// Settings pointing at the stub, at the Bedrock path.
fn stub_settings(stub: &Stub) -> Settings {
    let mut s = support::settings(&stub.url);
    s.api_base = stub.url.replace("/v1", "/anthropic/v1");
    s
}

fn run(
    h: &Hierarchy,
    n: &Namer,
    region: Option<&str>,
    creds: &AwsCredentials,
    replies: Vec<Reply>,
    cap: f64,
) -> (NamesFile, Vec<Received>) {
    run_priced(h, n, region, creds, replies, cap, &test_price(n))
}

fn run_priced(
    h: &Hierarchy,
    n: &Namer,
    region: Option<&str>,
    creds: &AwsCredentials,
    replies: Vec<Reply>,
    cap: f64,
    price: &PriceSetting,
) -> (NamesFile, Vec<Received>) {
    let stub = Stub::start(replies);
    let s = stub_settings(&stub);
    let file = name_topics_with(
        h,
        n,
        Access::Bedrock {
            region,
            credentials: creds,
            price,
        },
        RunCap::Usd(cap),
        &s,
    );
    (file, stub.finish())
}

fn header<'a>(r: &'a Received, k: &str) -> Option<&'a str> {
    r.headers
        .iter()
        .find(|(n, _)| n == k)
        .map(|(_, v)| v.as_str())
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).unwrap();
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// Recomputes the request's Signature Version 4 from what the stub received
/// and asserts it equals the one sent, with the credential scope naming the
/// expected service and region.
fn assert_signed(r: &Received, region: &str) {
    let auth = header(r, "authorization").expect("an authorization header");
    let rest = auth
        .strip_prefix("AWS4-HMAC-SHA256 ")
        .expect("a SigV4 authorization");
    let mut credential = None;
    let mut signed_headers = None;
    let mut signature = None;
    for part in rest.split(", ") {
        let (k, v) = part.split_once('=').unwrap();
        match k {
            "Credential" => credential = Some(v),
            "SignedHeaders" => signed_headers = Some(v),
            "Signature" => signature = Some(v),
            other => panic!("unexpected field {other}"),
        }
    }
    let (credential, signed_headers, signature) = (
        credential.unwrap(),
        signed_headers.unwrap(),
        signature.unwrap(),
    );
    let amz_date = header(r, "x-amz-date").expect("x-amz-date");
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/bedrock-mantle/aws4_request");
    assert_eq!(credential, format!("{AKID}/{scope}"));
    assert_eq!(signature.len(), 64);
    let names: Vec<&str> = signed_headers.split(';').collect();
    for required in [
        "anthropic-version",
        "content-type",
        "host",
        "x-amz-date",
        "x-amz-security-token",
    ] {
        assert!(
            names.contains(&required),
            "{required} not signed: {names:?}"
        );
    }
    let (method, rest) = r.request_line.split_once(' ').unwrap();
    let path = rest.split(' ').next().unwrap();
    let mut canonical = format!("{method}\n{path}\n\n");
    for n in &names {
        canonical.push_str(&format!("{n}:{}\n", header(r, n).unwrap().trim()));
    }
    canonical.push_str(&format!(
        "\n{signed_headers}\n{}",
        hex::encode(Sha256::digest(&r.body))
    ));
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let k = hmac(format!("AWS4{SECRET}").as_bytes(), date);
    let k = hmac(&k, region);
    let k = hmac(&k, "bedrock-mantle");
    let k = hmac(&k, "aws4_request");
    assert_eq!(hex::encode(hmac(&k, &to_sign)), signature);
}

fn assert_bedrock_headers(r: &Received) {
    assert_eq!(r.request_line, "POST /anthropic/v1/messages HTTP/1.1");
    assert_eq!(header(r, "x-api-key"), None, "no x-api-key to Bedrock");
    assert_eq!(header(r, "anthropic-version"), Some("2026-10-21"));
    assert_eq!(header(r, "content-type"), Some("application/json"));
    assert_eq!(header(r, "x-amz-security-token"), Some(TOKEN));
    for (k, v) in &r.headers {
        assert!(
            [
                "host",
                "content-type",
                "anthropic-version",
                "content-length",
                "accept",
                "authorization",
                "x-amz-date",
                "x-amz-security-token",
            ]
            .contains(&k.as_str()),
            "unexpected header {k}"
        );
        assert!(!v.to_ascii_lowercase().contains("polis"), "{k}");
    }
}

#[test]
fn the_body_is_the_saved_study_body_with_only_the_model_id_mapped() {
    let h = hierarchy("bg2050");
    let saved = fixture("requests/bg2050-sonnet-off.json");
    let anchor = "No two topics may share a name.";
    let v1 = saved.replacen(anchor, &format!("{anchor} {LANGUAGE_SENTENCE}"), 1);
    assert_eq!(v1.matches(r#""model": "claude-sonnet-5-5""#).count(), 1);
    let expected = v1.replacen(
        r#""model": "claude-sonnet-5-5""#,
        r#""model": "anthropic.claude-sonnet-5-5""#,
        1,
    );
    let n = bedrock("sonnet", "off");
    // The measured instruction gives the saved body, model id aside.
    assert_eq!(
        prompt::body_with_instruction(&h, &n, &prompt::instruction_measured()),
        saved.replacen(
            r#""model": "claude-sonnet-5-5""#,
            r#""model": "anthropic.claude-sonnet-5-5""#,
            1
        )
    );
    assert_eq!(prompt::body_v1(&h, &n), expected);

    // And that is what reaches the wire, signed. Bowling Green's worst case
    // at the test price is $0.5072, so this run raises the cap to $1.
    let reply = fixture("replies/bg2050/sonnet-off-r1.json");
    let (file, got) = run(&h, &n, Some(REGION), &given(), vec![Reply::ok(reply)], 1.0);
    assert_eq!(file.outcome, "named", "{:?}", file.reason);
    assert_eq!(got.len(), 1);
    assert_eq!(String::from_utf8(got[0].body.clone()).unwrap(), expected);
    assert_bedrock_headers(&got[0]);
    assert_signed(&got[0], REGION);
    assert_eq!(file.record.provider, Some("bedrock"));
    assert_eq!(file.record.model, "claude-sonnet-5-5");
    assert_eq!(file.record.namer, "bedrock.claude-sonnet-5-5.p1.off");
    assert!(file.record.dollars.unwrap() > 0.0);
}

#[test]
fn haiku_through_bedrock_is_mapped_by_the_same_table() {
    let h = hierarchy("bg2050");
    let saved = fixture("requests/bg2050-haiku-default.json");
    let body = prompt::body_with_instruction(
        &h,
        &bedrock("haiku", "default"),
        &prompt::instruction_measured(),
    );
    assert_eq!(
        body,
        saved.replacen(
            r#""model": "claude-haiku-5-5""#,
            r#""model": "anthropic.claude-haiku-5-5""#,
            1
        )
    );
}

#[test]
fn the_signature_names_the_region_it_was_given() {
    let h = hierarchy("vtaiwan");
    let reply = fixture(VT_SONNET);
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some("eu-west-1"),
        &given(),
        vec![Reply::ok(reply)],
        0.5,
    );
    assert_eq!(file.outcome, "named", "{:?}", file.reason);
    assert_signed(&got[0], "eu-west-1");
}

#[test]
fn credentials_without_a_session_token_send_none() {
    let h = hierarchy("vtaiwan");
    let creds = AwsCredentials::Given {
        access_key_id: AKID.into(),
        secret_access_key: SECRET.into(),
        session_token: None,
    };
    let reply = fixture(VT_SONNET);
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &creds,
        vec![Reply::ok(reply)],
        0.5,
    );
    assert_eq!(file.outcome, "named", "{:?}", file.reason);
    assert_eq!(header(&got[0], "x-amz-security-token"), None);
    assert!(header(&got[0], "authorization").is_some());
}

#[test]
fn http_403_is_an_outcome_with_its_reason_and_no_retry() {
    let h = hierarchy("vtaiwan");
    let forbidden = Reply::Http {
        status: 403,
        headers: vec![],
        body: br#"{"message":"You don't have access to the model with the specified model ID. PLANTED-MARKER"}"#
            .to_vec(),
    };
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &given(),
        vec![forbidden],
        5.0,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("http_403", 1));
    assert_eq!(file.record.http_status, Some(403));
    // The body carries no error type, only a message, which is never kept;
    // the reason claims no cause it cannot know.
    let reason = file.reason.unwrap();
    assert_eq!(
        reason,
        "Amazon Bedrock answered HTTP 403, with no error type"
    );
    assert!(file.names.is_empty());
}

#[test]
fn a_403_reason_names_the_response_error_type_and_nothing_else() {
    let h = hierarchy("vtaiwan");
    let n = bedrock("sonnet", "default");
    let header = Reply::Http {
        status: 403,
        headers: vec![(
            "x-amzn-ErrorType".into(),
            "AccessDeniedException:http://internal.example/PLANTED-MARKER".into(),
        )],
        body: br#"{"message":"PLANTED-MARKER"}"#.to_vec(),
    };
    let (file, got) = run(&h, &n, Some(REGION), &given(), vec![header], 5.0);
    assert_eq!((file.outcome.as_str(), got.len()), ("http_403", 1));
    assert_eq!(
        file.reason.as_deref(),
        Some("Amazon Bedrock answered HTTP 403, error type AccessDeniedException")
    );
    let body = Reply::Http {
        status: 403,
        headers: vec![],
        body: br#"{"type":"error","error":{"type":"permission_error","message":"PLANTED-MARKER"}}"#
            .to_vec(),
    };
    let (file, _) = run(&h, &n, Some(REGION), &given(), vec![body], 5.0);
    assert_eq!(
        file.reason.as_deref(),
        Some("Amazon Bedrock answered HTTP 403, error type permission_error")
    );
    // A type that is not a bare identifier is dropped, not quoted.
    let odd = Reply::Http {
        status: 403,
        headers: vec![],
        body: br#"{"error":{"type":"PLANTED MARKER with spaces"}}"#.to_vec(),
    };
    let (file, _) = run(&h, &n, Some(REGION), &given(), vec![odd], 5.0);
    assert_eq!(
        file.reason.as_deref(),
        Some("Amazon Bedrock answered HTTP 403, with no error type")
    );
    assert!(!file.to_json().contains("PLANTED"));
}

#[test]
fn a_429_then_200_is_one_retry_and_each_attempt_is_signed() {
    let h = hierarchy("vtaiwan");
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &given(),
        vec![Reply::status(429, Some("0")), Reply::ok(fixture(VT_SONNET))],
        5.0,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("named", 2));
    assert_eq!(file.record.attempts, 2);
    for r in &got {
        assert_bedrock_headers(r);
        assert_signed(r, REGION);
    }
}

#[test]
fn a_429_twice_is_http_429_after_one_retry() {
    let h = hierarchy("vtaiwan");
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &given(),
        vec![Reply::status(429, Some("0")), Reply::status(429, Some("0"))],
        5.0,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("http_429", 2));
    assert_eq!(file.record.dollars, None);
}

#[test]
fn a_429_under_the_default_cap_is_not_retried() {
    // Sonnet's 32,000-token output allowance alone is $0.352 through Bedrock,
    // so the default cap does not reserve a second attempt.
    let h = hierarchy("vtaiwan");
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &given(),
        vec![Reply::status(429, Some("0"))],
        0.5,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("http_429", 1));
}

#[test]
fn a_reply_that_never_comes_is_timeout() {
    let h = hierarchy("vtaiwan");
    let stub = Stub::start(vec![Reply::Hang(Duration::from_secs(2))]);
    let mut s = stub_settings(&stub);
    s.timeout = Duration::from_millis(300);
    let creds = given();
    let n = bedrock("sonnet", "default");
    let file = name_topics_with(
        &h,
        &n,
        Access::Bedrock {
            region: Some(REGION),
            credentials: &creds,
            price: &test_price(&n),
        },
        RunCap::Usd(5.0),
        &s,
    );
    assert_eq!(file.outcome, "timeout");
    assert_eq!(stub.finish().len(), 1);
}

#[test]
fn a_refusal_is_refused() {
    let h = hierarchy("vtaiwan");
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &given(),
        vec![Reply::ok(message("", "refusal"))],
        0.5,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("refused", 1));
}

#[test]
fn the_reply_is_checked_as_the_claude_api_reply_is() {
    let h = hierarchy("vtaiwan");
    let mut items = saved_topics(VT_SONNET);
    items.pop();
    let (file, _) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &given(),
        vec![Reply::ok(message(&topics_text(&items), "end_turn"))],
        0.5,
    );
    assert_eq!(file.outcome, "bad_cover");
}

#[test]
fn no_region_or_a_bad_region_is_no_region_with_no_call() {
    let h = hierarchy("vtaiwan");
    for region in [
        None,
        Some(""),
        Some("  "),
        Some("us-east-1.evil.example"),
        Some("US-EAST-1"),
        Some("us-east-1/x"),
    ] {
        let (file, got) = run(
            &h,
            &bedrock("sonnet", "default"),
            region,
            &given(),
            vec![],
            0.5,
        );
        assert_eq!(
            (file.outcome.as_str(), got.len()),
            ("no_region", 0),
            "{region:?}"
        );
        assert!(file.reason.unwrap().contains("AWS_REGION"));
    }
}

#[test]
fn credentials_that_cannot_sign_are_no_credentials_with_no_call() {
    let h = hierarchy("vtaiwan");
    let creds = AwsCredentials::Given {
        access_key_id: AKID.into(),
        secret_access_key: SECRET.into(),
        session_token: Some("bad\ntoken".into()),
    };
    let (file, got) = run(
        &h,
        &bedrock("sonnet", "default"),
        Some(REGION),
        &creds,
        vec![],
        0.5,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("no_credentials", 0));
}

#[test]
fn the_cap_is_checked_at_the_given_price_before_any_credential_is_read() {
    // Bowling Green's version 1 body: a worst case under $0.50 on the Claude
    // API and over it at the test price. At the $0.50 default only the Claude
    // API run is affordable. The chain is never read: no credential exists.
    let h = hierarchy("bg2050");
    let n = bedrock("sonnet", "default");
    let counted = prompt::body_v1(&h, &n).len() as u64;
    let claude_api = support::namer("sonnet", "default")
        .model
        .worst_case_usd(counted, 32_000);
    assert!(claude_api < 0.5, "{claude_api}");
    let (file, got) = run(
        &h,
        &n,
        Some(REGION),
        &AwsCredentials::DefaultChain,
        vec![],
        0.5,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("over_run_cap", 0));
    let w = file.record.worst_case_usd;
    assert!(w > 0.5 && (w - 1.1 * claude_api).abs() < 1e-9, "{w}");
    // The record shows the price the refusal was computed from.
    let price = file.record.price.unwrap();
    assert_eq!(
        (price.input_usd_per_mtok, price.output_usd_per_mtok),
        (2.2, 11.0)
    );
    assert_eq!(price.source, TEST_SOURCE);
}

/// No usable price: `no_price`, no credential read (the chain has none, and
/// the outcome would otherwise be `no_credentials`), no request, keyword
/// names kept.
///
/// Here and below the stub serves nothing, so a request would end
/// `connect_error` with an attempt counted; `no_price` with zero attempts is
/// the proof that none was sent.
#[test]
fn without_a_usable_price_it_is_no_price_with_no_call() {
    let h = hierarchy("vtaiwan");
    let n = bedrock("sonnet", "default");
    let cases: [(Option<&str>, Option<&str>, Option<&str>); 12] = [
        (None, None, None),
        (None, Some("11"), Some("s")),
        (Some("2.2"), None, Some("s")),
        (Some("2.2"), Some("11"), None),
        (Some(""), Some("11"), Some("s")),
        (Some("2.2"), Some("11"), Some("  ")),
        (Some("two"), Some("11"), Some("s")),
        (Some("0"), Some("11"), Some("s")),
        (Some("2.2"), Some("-11"), Some("s")),
        (Some("NaN"), Some("11"), Some("s")),
        (Some("2.2"), Some("1100"), Some("s")),
        (Some("2200"), Some("11"), Some("s")),
    ];
    for (i, o, src) in cases {
        let price = GivenPrice::from_settings(i, o, src);
        let (file, got) = run_priced(
            &h,
            &n,
            Some(REGION),
            &AwsCredentials::DefaultChain,
            vec![],
            5.0,
            &price,
        );
        let case = format!("{i:?} {o:?} {src:?}");
        assert_eq!(file.outcome, "no_price", "{case}");
        assert_eq!(got.len(), 0, "{case}");
        assert_eq!(file.record.attempts, 0, "{case}");
        assert!(file.names.is_empty(), "{case}");
        assert!(
            file.reason
                .as_deref()
                .is_some_and(|r| r.contains("DELPHI_NAMING_BEDROCK_"))
        );
        assert_eq!(file.record.price, None);
        assert!(file.record.dollars.is_none());
        let v: serde_json::Value = serde_json::from_str(&file.to_json()).unwrap();
        assert!(v["record"]["worst_case_usd"].is_null(), "{case}");
        assert!(v["record"].get("price").is_none(), "{case}");
    }
}

#[test]
fn a_good_price_is_one_signed_call_recorded_with_its_price_and_source() {
    let h = hierarchy("vtaiwan");
    let n = bedrock("sonnet", "default");
    let source = "Bedrock pricing page, us-east-1, read 2026-11-26 (a made-up test source)";
    let price = GivenPrice::from_settings(Some("3"), Some("15"), Some(source));
    let (file, got) = run_priced(
        &h,
        &n,
        Some(REGION),
        &given(),
        vec![Reply::ok(fixture(VT_SONNET))],
        5.0,
        &price,
    );
    assert_eq!(file.outcome, "named", "{:?}", file.reason);
    assert_eq!(got.len(), 1);
    assert_signed(&got[0], REGION);
    let counted = got[0].body.len() as f64;
    let w = file.record.worst_case_usd;
    assert!(
        (w - (counted * 3e-6 + 32_000.0 * 15e-6)).abs() < 1e-12,
        "{w}"
    );
    let v: serde_json::Value = serde_json::from_str(&file.to_json()).unwrap();
    assert_eq!(v["record"]["price"]["input_usd_per_mtok"], 3.0);
    assert_eq!(v["record"]["price"]["output_usd_per_mtok"], 15.0);
    assert_eq!(v["record"]["price"]["source"], source);
    let u = (
        v["record"]["tokens_in"].as_f64().unwrap(),
        v["record"]["tokens_out"].as_f64().unwrap(),
    );
    let d = file.record.dollars.unwrap();
    assert!(d >= u.0 * 3e-6 + u.1 * 15e-6 - 1e-12, "{d}");
}

#[test]
fn a_given_price_that_puts_the_worst_case_over_the_cap_makes_no_call() {
    let h = hierarchy("vtaiwan");
    let n = bedrock("sonnet", "default");
    // $40 per million output tokens: 32,000 output tokens alone are $1.28.
    let price = GivenPrice::from_settings(Some("8"), Some("40"), Some("s"));
    let (file, got) = run_priced(
        &h,
        &n,
        Some(REGION),
        &AwsCredentials::DefaultChain,
        vec![],
        0.5,
        &price,
    );
    assert_eq!((file.outcome.as_str(), got.len()), ("over_run_cap", 0));
    assert_eq!(file.record.attempts, 0);
    assert!(file.names.is_empty());
    assert!(file.record.worst_case_usd > 1.28);
    assert_eq!(file.record.price.unwrap().output_usd_per_mtok, 40.0);
}

#[test]
fn a_provider_and_the_wrong_kind_of_access_make_no_call() {
    let h = hierarchy("vtaiwan");
    let s = support::settings("http://127.0.0.1:9/v1");
    let file = name_topics_with(
        &h,
        &bedrock("sonnet", "default"),
        Access::Key(Some("test-key")),
        RunCap::Usd(0.5),
        &s,
    );
    assert_eq!(file.outcome, "no_credentials");
    let creds = given();
    let n = support::namer("sonnet", "default");
    let file = name_topics_with(
        &h,
        &n,
        Access::Bedrock {
            region: Some(REGION),
            credentials: &creds,
            price: &test_price(&n),
        },
        RunCap::Usd(0.5),
        &s,
    );
    assert_eq!(file.outcome, "no_key");
    assert_eq!(file.record.provider, None);
}
