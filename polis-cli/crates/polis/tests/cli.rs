use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output},
    thread,
};

fn run(config: &std::path::Path, args: &[&str]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("POLIS_CONFIG_DIR", config)
        .env("POLIS_KEYCHAIN", "off")
        .env("POLIS_TOKEN_LOCAL", "public-fixture-token")
        .args(args)
        .output()
        .unwrap()
}
fn parsed(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}
fn fixture(status: u16, kind: &str, body: &str, args: &[&str]) -> (Output, String) {
    let (out, mut requests, _) = sequence(&[(status, kind, body)], args);
    (out, requests.remove(0))
}
/// Serves one response per connection, in order, and returns the CLI output, the
/// requests as read, and the site origin the CLI was given.
fn sequence(responses: &[(u16, &str, &str)], args: &[&str]) -> (Output, Vec<String>, String) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let responses: Vec<String> = responses.iter().map(|(status, kind, body)| format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())).collect();
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let start = std::time::Instant::now();
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(start.elapsed().as_secs() < 10, "CLI never connected");
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|s| {
                            s.strip_prefix("content-length: ")
                                .and_then(|v| v.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            requests.push(String::from_utf8(bytes).unwrap());
        }
        requests
    });
    let tmp = tempfile::tempdir().unwrap();
    let origin = format!("http://{address}");
    std::fs::write(
        tmp.path().join("profiles.json"),
        json!({"default":"local","sites":{"local":origin}}).to_string(),
    )
    .unwrap();
    let out = run(tmp.path(), args);
    (out, server.join().unwrap(), origin)
}
fn owned_conversations() -> String {
    json!([
        {"conversation_id":"abc","topic":"Budget 2027","description":"Where should the city spend next year?","is_owner":true},
        {"conversation_id":"def","topic":"Parks","description":null,"is_owner":true},
        {"conversation_id":"ghi","topic":"Shared site row","is_owner":false}
    ])
    .to_string()
}
fn text(out: &Output) -> String {
    String::from_utf8(out.stdout.clone()).unwrap()
}
#[test]
fn list_prints_a_table_with_the_newest_report_of_each_conversation() {
    // PostgreSQL's BIGINT arrives as a string; a report without `created` never wins.
    let reports = json!([
        {"report_id":"r1older","conversation_id":"abc","created":"1700000000000"},
        {"report_id":"r0undated","conversation_id":"abc"},
        {"report_id":"r2newer","conversation_id":"abc","created":1800000000000u64},
        {"report_id":"r3other","conversation_id":"zzz","created":1900000000000u64}
    ])
    .to_string();
    let (o, requests, origin) = sequence(
        &[
            (200, "application/json", &owned_conversations()),
            (200, "application/json", &reports),
        ],
        &["conversation", "list"],
    );
    assert!(o.status.success());
    assert!(
        o.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(requests[0].starts_with("GET /api/v3/conversations?limit=100 "));
    assert!(
        requests[1].starts_with("GET /api/v3/reports "),
        "{}",
        requests[1]
    );
    assert!(requests[1]
        .to_ascii_lowercase()
        .contains("authorization: bearer public-fixture-token"));
    let stdout = text(&o);
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 3, "{stdout}");
    assert!(lines[0].starts_with("TOPIC        DESCRIPTION"), "{stdout}");
    assert!(
        lines[0].contains("  URL") && lines[0].ends_with("REPORT"),
        "{stdout}"
    );
    assert_eq!(
        lines[1],
        format!("Budget 2027  Where should the city spend next year?  {origin}/abc  {origin}/report/r2newer +2")
    );
    assert_eq!(
        lines[2].trim_end(),
        format!("Parks                                                {origin}/def")
    );
    assert!(!stdout.contains("Shared site row") && !stdout.contains("r3other"));
}
#[test]
fn list_table_survives_a_failed_or_missing_reports_read() {
    for (status, kind, body) in [
        (
            403,
            "application/json",
            r#"{"error":"polis_err_permissions"}"#,
        ),
        (200, "text/html", "<html>old server</html>"),
        (200, "application/json", r#"{"reports":[]}"#),
    ] {
        let (o, requests, origin) = sequence(
            &[
                (200, "application/json", &owned_conversations()),
                (status, kind, body),
            ],
            &["conversation", "list"],
        );
        assert_eq!(o.status.code(), Some(0), "{status} {kind}");
        assert_eq!(requests.len(), 2);
        let stdout = text(&o);
        assert!(stdout.starts_with("TOPIC        DESCRIPTION"), "{stdout}");
        assert!(stdout.contains(&format!("  {origin}/abc\n")), "{stdout}");
        assert!(stdout.contains(&format!("  {origin}/def\n")), "{stdout}");
        assert!(!stdout.contains("/report/"));
        let stderr = String::from_utf8_lossy(&o.stderr);
        assert_eq!(stderr.lines().count(), 1, "{stderr}");
        assert!(
            stderr.starts_with("polis: report links unavailable"),
            "{stderr}"
        );
        assert!(!stderr.contains("polis_err_permissions") && !stderr.contains("old server"));
    }
}
#[test]
fn list_table_cleans_and_truncates_text_but_never_links() {
    let long = "x".repeat(300);
    let body = json!([{
        "conversation_id":"abc",
        "topic":"Bud\u{7}get \u{1b}[31m2027\u{200e}\r\n\tnow",
        "description":long,
        "is_owner":true
    }])
    .to_string();
    let (o, _, origin) = sequence(
        &[
            (200, "application/json", &body),
            (200, "application/json", "[]"),
        ],
        &["conversation", "list"],
    );
    assert!(o.status.success());
    let stdout = text(&o);
    assert!(
        !stdout.contains('\u{7}') && !stdout.contains('\u{1b}') && !stdout.contains('\u{200e}')
    );
    let row = stdout.lines().nth(1).unwrap();
    assert!(row.starts_with("Budget [31m2027 now  "), "{row}");
    assert!(row.contains('…') && !row.contains(&"x".repeat(60)), "{row}");
    assert!(row.ends_with(&format!("…  {origin}/abc")), "{row}");
}
#[test]
fn list_without_conversations_reads_no_reports() {
    let (o, requests, _) = sequence(
        &[(200, "application/json", "[]")],
        &["conversation", "list", "--search", "nothing"],
    );
    assert!(o.status.success());
    assert_eq!(requests.len(), 1);
    assert_eq!(text(&o), "No conversations.\n");
    assert!(o.stderr.is_empty());
}
#[test]
fn list_json_envelope_is_unchanged_by_the_table() {
    let (o, requests, _) = sequence(
        &[(200, "application/json", &owned_conversations())],
        &["conversation", "list", "--json"],
    );
    assert!(o.status.success());
    assert!(o.stderr.is_empty());
    assert_eq!(requests.len(), 1);
    let v = parsed(&o);
    assert_eq!(v["schema"], "polis-cli/1");
    assert_eq!(
        v["data"].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["conversations", "pagination", "scope"]
    );
    let expected: Value = serde_json::from_str(&owned_conversations()).unwrap();
    assert_eq!(
        v["data"]["conversations"],
        json!([expected[0], expected[1]])
    );
    assert_eq!(v["warnings"], json!([]));
}
#[test]
fn all_help_and_schema_commands_are_reachable() {
    let tmp = tempfile::tempdir().unwrap();
    let schema = parsed(&run(tmp.path(), &["schema"]));
    fn walk(v: &Value, tmp: &std::path::Path, count: &mut usize) {
        let path = v["command"].as_str().unwrap();
        let mut args = path.split_whitespace().skip(1).collect::<Vec<_>>();
        args.extend(["--help", "--json"]);
        let out = run(tmp, &args);
        assert!(out.status.success(), "{path}");
        assert_eq!(parsed(&out)["ok"], true);
        assert!(!String::from_utf8_lossy(&out.stdout).contains("--site"));
        *count += 1;
        for child in v["commands"].as_array().unwrap() {
            walk(child, tmp, count);
        }
    }
    let mut count = 0;
    walk(&schema["data"], tmp.path(), &mut count);
    assert!(count > 175, "{count}");
}
#[test]
fn planned_command_is_explicit_and_offline() {
    let t = tempfile::tempdir().unwrap();
    let o = run(t.path(), &["node", "up", "--json"]);
    assert_eq!(o.status.code(), Some(8));
    assert_eq!(parsed(&o)["error"]["code"], "capability_unavailable");
}
#[test]
fn json_usage_errors_do_not_echo_argument_values() {
    let t = tempfile::tempdir().unwrap();
    let o = run(
        t.path(),
        &["auth", "login", "--token", "do-not-echo", "--json"],
    );
    assert_eq!(o.status.code(), Some(2));
    assert!(!String::from_utf8_lossy(&o.stdout).contains("do-not-echo"));
    assert!(o.stderr.is_empty());
}
#[test]
fn empty_list_is_success() {
    let (o, r) = fixture(
        200,
        "application/json",
        "[]",
        &["conversation", "list", "--json", "--limit", "2"],
    );
    assert!(o.status.success());
    // Only parameters the current API reads are sent; the bearer token goes in the header.
    assert!(r.starts_with("GET /api/v3/conversations?limit=2 "), "{r}");
    assert!(r
        .to_ascii_lowercase()
        .contains("authorization: bearer public-fixture-token"));
    let data = &parsed(&o)["data"];
    assert_eq!(data["scope"], "owner");
    assert_eq!(data["conversations"], json!([]));
    assert_eq!(
        data["pagination"],
        json!({"limit":2,"server_rows":0,"returned":0,"truncated":false})
    );
}
#[test]
fn list_keeps_owned_rows_and_reports_truncation() {
    // The API's array mixes owned rows with the site's shared rows (is_owner false).
    let (o, r) = fixture(
        200,
        "application/json",
        r#"[{"conversation_id":"abc","topic":"Budget 2027","is_owner":true,"is_mod":true},{"conversation_id":"def","topic":"Shared site row","is_owner":false,"is_mod":true}]"#,
        &[
            "conversation",
            "list",
            "--mine",
            "--recent",
            "--limit",
            "2",
            "--json",
        ],
    );
    assert!(o.status.success());
    assert!(r.starts_with("GET /api/v3/conversations?limit=2 "), "{r}");
    let data = &parsed(&o)["data"];
    assert_eq!(data["conversations"].as_array().unwrap().len(), 1);
    assert_eq!(data["conversations"][0]["conversation_id"], "abc");
    assert_eq!(data["conversations"][0]["is_mod"], true);
    assert_eq!(
        data["pagination"],
        json!({"limit":2,"server_rows":2,"returned":1,"truncated":true})
    );
}
#[test]
fn list_filters_are_sent_and_search_is_literal() {
    let (o, r) = fixture(
        200,
        "application/json",
        r#"[{"conversation_id":"a","topic":"50% OFF","is_owner":true},{"conversation_id":"b","topic":"500 ideas","is_owner":true}]"#,
        &[
            "conversation",
            "list",
            "--active",
            "false",
            "--draft",
            "true",
            "--search",
            "50% off",
            "--json",
        ],
    );
    assert!(o.status.success());
    assert!(
        r.starts_with("GET /api/v3/conversations?limit=100&is_active=false&is_draft=true "),
        "{r}"
    );
    let data = &parsed(&o)["data"];
    assert_eq!(data["conversations"].as_array().unwrap().len(), 1);
    assert_eq!(data["conversations"][0]["conversation_id"], "a");
    assert_eq!(
        data["pagination"],
        json!({"limit":100,"server_rows":2,"returned":1,"truncated":false})
    );
}
#[test]
fn list_refuses_an_unrecognized_shape() {
    for body in [r#"{"conversations":[]}"#, r#"[{"conversation_id":"x"}]"#] {
        let (o, _) = fixture(
            200,
            "application/json",
            body,
            &["conversation", "list", "--json"],
        );
        assert_eq!(o.status.code(), Some(1), "{body}");
        assert_eq!(parsed(&o)["error"]["code"], "invalid_response", "{body}");
    }
}
#[test]
fn offset_is_not_an_option() {
    let t = tempfile::tempdir().unwrap();
    let o = run(
        t.path(),
        &["conversation", "list", "--offset", "5", "--json"],
    );
    assert_eq!(o.status.code(), Some(2));
    assert_eq!(parsed(&o)["error"]["code"], "invalid_input");
}
#[test]
fn plural_conversations_is_an_alias() {
    let t = tempfile::tempdir().unwrap();
    let o = run(t.path(), &["conversations", "list", "--help", "--json"]);
    assert!(o.status.success());
    assert_eq!(parsed(&o)["ok"], true);
    let (o, r) = fixture(
        200,
        "application/json",
        "[]",
        &["conversations", "list", "--json"],
    );
    assert!(o.status.success());
    assert!(r.starts_with("GET /api/v3/conversations?limit=100 "), "{r}");
}
#[test]
fn public_id_and_token_are_sent_correctly() {
    let (o, r) = fixture(
        200,
        "application/json",
        r#"{"conversation_id":"generated"}"#,
        &["conversation", "view", "generated", "--json"],
    );
    assert!(o.status.success());
    assert!(r.contains("conversation_id=generated"));
    assert!(r
        .to_ascii_lowercase()
        .contains("authorization: bearer public-fixture-token"));
    assert!(!String::from_utf8_lossy(&o.stdout).contains("public-fixture-token"));
}
#[test]
fn create_uses_json_body() {
    let (o, r) = fixture(
        200,
        "application/json",
        r#"{"conversation_id":"generated"}"#,
        &[
            "conversation",
            "create",
            "--topic",
            "A topic",
            "--draft",
            "--json",
        ],
    );
    assert!(o.status.success());
    assert!(r.starts_with("POST /api/v3/conversations "));
    let body: Value = serde_json::from_str(r.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["topic"], "A topic");
    assert_eq!(body["is_draft"], true);
}
#[test]
fn seed_add_uses_moderator_bulk_route() {
    let (o, r) = fixture(
        200,
        "application/json",
        r#"{"results":[{"status":"success","tid":0}]}"#,
        &[
            "seed",
            "add",
            "--conversation",
            "generated",
            "--text",
            "Keep, exact text",
            "--json",
        ],
    );
    assert!(o.status.success());
    assert!(r.starts_with("POST /api/v3/comments-bulk "));
    let b: Value = serde_json::from_str(r.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(b["is_seed"], true);
    assert!(b["csv"].as_str().unwrap().contains("\"Keep, exact text\""));
}
#[test]
fn partial_import_preserves_receipt_and_fails() {
    let (o, _) = fixture(
        200,
        "application/json",
        r#"{"results":[{"status":"skipped","reason":"duplicate"}]}"#,
        &[
            "seed",
            "add",
            "--conversation",
            "generated",
            "--text",
            "Some text",
            "--json",
        ],
    );
    assert_eq!(o.status.code(), Some(1));
    let v = parsed(&o);
    assert_eq!(v["ok"], false);
    assert_eq!(v["data"]["receipt"]["results"][0]["reason"], "duplicate");
}
#[test]
fn http_200_error_is_not_success() {
    let (o, _) = fixture(
        200,
        "application/json",
        r#"{"error":"public-fixture-token"}"#,
        &["conversation", "list", "--json"],
    );
    assert_eq!(o.status.code(), Some(1));
    assert!(!String::from_utf8_lossy(&o.stdout).contains("public-fixture-token"));
}
#[test]
fn status_exit_classes() {
    for (status, exit) in [(401, 3), (403, 4), (409, 5), (429, 6), (503, 6)] {
        let (o, _) = fixture(
            status,
            "application/json",
            "{}",
            &["conversation", "list", "--json"],
        );
        assert_eq!(o.status.code(), Some(exit));
        assert_eq!(parsed(&o)["error"]["upstream"]["status"], status);
    }
}
#[test]
fn failed_write_has_unknown_outcome() {
    let (o, _) = fixture(
        500,
        "application/json",
        "{}",
        &["conversation", "create", "--topic", "Fixture", "--json"],
    );
    assert_eq!(o.status.code(), Some(7));
    assert_eq!(parsed(&o)["error"]["outcome"], "unknown");
}
#[test]
fn html_and_invalid_json_fail() {
    for (kind, body) in [
        ("text/html", "<html>login</html>"),
        ("application/json", "not json"),
    ] {
        let (o, _) = fixture(200, kind, body, &["conversation", "list", "--json"]);
        assert_eq!(o.status.code(), Some(1));
        assert_eq!(parsed(&o)["error"]["code"], "invalid_response");
    }
}
#[test]
fn redirect_and_304_are_distinct() {
    for (status, code) in [(302, "redirect_refused"), (304, "not_modified")] {
        let (o, _) = fixture(
            status,
            "application/json",
            "",
            &["conversation", "list", "--json"],
        );
        assert_eq!(parsed(&o)["error"]["code"], code);
    }
}
#[test]
fn no_content_is_explicit() {
    let (o, _) = fixture(
        204,
        "application/json",
        "",
        &["api", "/api/v3/example", "--json"],
    );
    assert!(o.status.success());
    assert_eq!(parsed(&o)["data"]["state"], "no_content");
}
#[test]
fn raw_api_rejects_origin_escape() {
    let t = tempfile::tempdir().unwrap();
    for p in [
        "https://evil.invalid/",
        "//evil.invalid/",
        "/api/v3/../../outside",
        "/api/v3/..%2f../outside#fragment",
    ] {
        let o = run(t.path(), &["api", p, "--json"]);
        assert_eq!(o.status.code(), Some(2), "{p}");
    }
}
#[test]
fn profiles_reject_credentials_and_remote_http() {
    let t = tempfile::tempdir().unwrap();
    for u in [
        "http://example.invalid",
        "https://user:secret@example.invalid",
        "https://example.invalid/path",
    ] {
        let config = json!({"default":"fixture","sites":{"fixture":u}}).to_string();
        std::fs::write(t.path().join("profiles.json"), &config).unwrap();
        let o = run(t.path(), &["conversation", "share", "FIXTURE", "--json"]);
        assert_eq!(o.status.code(), Some(2));
        assert_eq!(
            std::fs::read_to_string(t.path().join("profiles.json")).unwrap(),
            config
        );
    }
}
#[test]
fn profiles_preserve_configuration_and_require_origins() {
    let t = tempfile::tempdir().unwrap();
    let config =
        json!({"default":"fixture","sites":{"fixture":"https://example.invalid"}}).to_string();
    std::fs::write(t.path().join("profiles.json"), &config).unwrap();
    let o = run(t.path(), &["conversation", "share", "FIXTURE", "--json"]);
    assert!(o.status.success());
    assert!(parsed(&o)["data"]["participation_url"]
        .as_str()
        .unwrap()
        .starts_with("https://example.invalid/"));
    assert_eq!(
        std::fs::read_to_string(t.path().join("profiles.json")).unwrap(),
        config
    );
    std::fs::write(
        t.path().join("profiles.json"),
        json!({"default":"preprod","sites":{"preprod":""}}).to_string(),
    )
    .unwrap();
    let o = run(t.path(), &["conversation", "share", "FIXTURE", "--json"]);
    assert_eq!(parsed(&o)["error"]["code"], "site_unconfigured");
}
#[test]
fn site_selection_is_not_a_command_or_option() {
    let t = tempfile::tempdir().unwrap();
    let schema = parsed(&run(t.path(), &["schema"]));
    assert!(!schema["data"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["command"] == "polis site"));
    for args in [
        vec!["auth", "login", "--site", "prod", "--json"],
        vec!["site", "use", "prod", "--json"],
    ] {
        let o = run(t.path(), &args);
        assert_eq!(o.status.code(), Some(2));
        assert_eq!(parsed(&o)["error"]["code"], "invalid_input");
    }
    let plain = run(t.path(), &["auth", "login", "--site", "prod"]);
    assert_eq!(plain.status.code(), Some(2));
    assert!(!String::from_utf8_lossy(&plain.stderr).contains("--site"));
    for shell in ["bash", "zsh", "fish", "powershell", "elvish"] {
        let o = run(t.path(), &["completion", shell]);
        assert!(o.status.success());
        assert!(!String::from_utf8_lossy(&o.stdout).contains("--site"));
    }
}
#[test]
fn different_site_does_not_reuse_local_token() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        json!({"default":"other","sites":{"other":"http://localhost:1"}}).to_string(),
    )
    .unwrap();
    let o = run(t.path(), &["conversation", "list", "--json"]);
    assert_eq!(o.status.code(), Some(3));
}
#[test]
fn csv_validation_and_exact_preview() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("seeds.csv");
    std::fs::write(
        &p,
        "\u{feff}original_id,comment_text\n00000000-0000-4000-8000-000000000001,\"  Exact, text  \"\n",
    )
    .unwrap();
    let o = run(
        t.path(),
        &["seed", "csv", "preview", p.to_str().unwrap(), "--json"],
    );
    assert!(o.status.success());
    assert_eq!(
        parsed(&o)["data"]["rows"][0]["comment_text"],
        "  Exact, text  "
    );
}
#[test]
fn csv_refuses_invalid_batches_before_network() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("seeds.csv");
    for csv in [
        "text\nwrong\n",
        "comment_text,original_id\nfirst,00000000-0000-4000-8000-000000000001\nsecond,00000000-0000-4000-8000-000000000001\n",
        "comment_text,original_id\nsame,00000000-0000-4000-8000-000000000001\nsame,00000000-0000-4000-8000-000000000002\n",
        "comment_text,original_id\n  ,00000000-0000-4000-8000-000000000001\n",
        "comment_text,original_id\n",
        "comment_text,original_id\ntext,1,extra\n",
    ] {
        std::fs::write(&p, csv).unwrap();
        let o = run(
            t.path(),
            &[
                "seed",
                "import",
                p.to_str().unwrap(),
                "--conversation",
                "generated",
                "--json",
            ],
        );
        assert_eq!(o.status.code(), Some(2));
    }
}
#[test]
fn help_ignores_corrupt_configuration() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), "broken").unwrap();
    assert!(run(t.path(), &["--help"]).status.success());
    assert!(run(t.path(), &["help", "conversation"]).status.success());
    assert!(run(t.path(), &["schema"]).status.success());
}

#[test]
fn csv_rejects_blank_records_and_malformed_quotes() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("bad.csv");
    for csv in [
        "comment_text,original_id\n\ntext,00000000-0000-4000-8000-000000000001\n",
        "comment_text,original_id\n\"unclosed,1",
        "comment_text,original_id\n\"closed\"garbage,00000000-0000-4000-8000-000000000001\n",
        "comment_text,original_id\nquo\"te,00000000-0000-4000-8000-000000000001\n",
    ] {
        std::fs::write(&p, csv).unwrap();
        let o = run(
            t.path(),
            &["seed", "csv", "validate", p.to_str().unwrap(), "--json"],
        );
        assert_eq!(o.status.code(), Some(2), "{csv}");
    }
}
#[test]
fn csv_preserves_multiline_and_escaped_quotes() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("good.csv");
    std::fs::write(
        &p,
        "comment_text,original_id\r\n\"line one\nline \"\"two\"\"\",00000000-0000-4000-8000-000000000001\r\n",
    )
    .unwrap();
    let o = run(
        t.path(),
        &["seed", "csv", "preview", p.to_str().unwrap(), "--json"],
    );
    assert!(o.status.success());
    assert_eq!(
        parsed(&o)["data"]["rows"][0]["comment_text"],
        "line one\nline \"two\""
    );
}
#[test]
fn disconnected_write_is_unknown_and_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut b = [0; 8192];
        let _ = s.read(&mut b).unwrap();
    });
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        json!({"default":"local","sites":{"local":format!("http://{address}")}}).to_string(),
    )
    .unwrap();
    let o = run(
        t.path(),
        &["conversation", "create", "--topic", "Uncertain", "--json"],
    );
    server.join().unwrap();
    assert_eq!(o.status.code(), Some(7));
    assert_eq!(parsed(&o)["error"]["outcome"], "unknown");
}

#[test]
fn csv_accepts_external_original_id() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("bad.csv");
    std::fs::write(&p, "comment_text,original_id\nValid statement,not-a-uuid\n").unwrap();
    let o = run(
        t.path(),
        &["seed", "csv", "validate", p.to_str().unwrap(), "--json"],
    );
    assert!(o.status.success());
    assert_eq!(parsed(&o)["data"]["valid"], true);
}
#[test]
fn focused_help_and_schema_keep_command_path() {
    let t = tempfile::tempdir().unwrap();
    let o = run(t.path(), &["help", "conversation", "create"]);
    assert!(String::from_utf8_lossy(&o.stdout).contains("Usage: polis conversation create"));
    let o = run(t.path(), &["schema", "conversation", "create"]);
    let v = parsed(&o);
    assert_eq!(v["data"]["command"], "polis conversation create");
    assert_eq!(v["data"]["implemented"], true);
    assert!(v["data"]["arguments"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["long"] == "topic" && a["required"] == true));
}
#[test]
fn noninteractive_never_opens_keychain() {
    let t = tempfile::tempdir().unwrap();
    let o = run(t.path(), &["auth", "logout", "--no-interactive", "--json"]);
    assert!(o.status.success());
    assert_eq!(parsed(&o)["data"]["state"], "logged_out");
    let (o, _) = fixture(
        200,
        "application/json",
        "{}",
        &["auth", "status", "--no-interactive", "--json"],
    );
    assert!(o.status.success());
}

#[test]
fn second_pass_read_routes_and_query_contracts() {
    let wire_rows = json!([{ "tid":0, "vote":polis_contracts::votes::WIRE_AGREE },{ "tid":1, "vote":polis_contracts::votes::WIRE_DISAGREE },{ "tid":2, "vote":polis_contracts::votes::WIRE_PASS },{ "tid":3, "vote":null }]).to_string();
    for (args, body, request) in [
        (
            vec![
                "participant",
                "status",
                "--conversation",
                "generated",
                "--json",
            ],
            "null",
            "GET /api/v3/participants?conversation_id=generated ",
        ),
        (
            vec![
                "participant",
                "list",
                "--conversation",
                "generated",
                "--json",
            ],
            r#"{"pid":0}"#,
            "GET /api/v3/participants?conversation_id=generated ",
        ),
        (
            vec![
                "participant",
                "xid",
                "list",
                "--conversation",
                "generated",
                "--json",
            ],
            "[]",
            "GET /api/v3/xids?conversation_id=generated ",
        ),
        (
            vec![
                "vote",
                "list",
                "--conversation",
                "generated",
                "--pid",
                "0",
                "--json",
            ],
            wire_rows.as_str(),
            "GET /api/v3/votes?conversation_id=generated&pid=0 ",
        ),
        (
            vec!["report", "view", "rgenerated", "--json"],
            "[]",
            "GET /api/v3/reports?report_id=rgenerated ",
        ),
        (
            vec!["report", "list", "--conversation", "generated", "--json"],
            "[]",
            "GET /api/v3/reports?conversation_id=generated ",
        ),
        (
            vec![
                "delphi",
                "results",
                "--report",
                "rgenerated",
                "--job",
                "job-one",
                "--json",
            ],
            r#"{"reports":{}}"#,
            "GET /api/v3/delphi/reports?report_id=rgenerated&job_id=job-one ",
        ),
        (
            vec![
                "delphi",
                "narrative",
                "view",
                "--report",
                "rgenerated",
                "--json",
            ],
            r#"{"reports":{}}"#,
            "GET /api/v3/delphi/reports?report_id=rgenerated ",
        ),
        (vec!["plan", "view", "--json"], "{}", "GET /api/v3/users "),
    ] {
        let (o, r) = fixture(200, "application/json", body, &args);
        assert!(
            o.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stdout)
        );
        assert!(r.starts_with(request), "{r}");
        let v = parsed(&o);
        match args[0] {
            "vote" => {
                assert_eq!(
                    v["data"]["votes"],
                    serde_json::from_str::<Value>(body).unwrap()
                );
                assert_eq!(
                    v["data"]["convention"],
                    polis_contracts::votes::wire_values()
                );
            }
            "plan" => {
                assert_eq!(v["data"]["state"], "unavailable");
                assert_eq!(v["data"]["entitlements"], Value::Null);
            }
            _ => {}
        }
    }
}
#[test]
fn delphi_terminal_live_and_supersession_are_preserved() {
    let body = r#"{"jobs":[{"jobId":"root","status":"COMPLETED","workLive":true,"supersededBy":"successor"},{"jobId":"successor","status":"RUNNING","workLive":true}]}"#;
    let (o, r) = fixture(
        200,
        "application/json",
        body,
        &[
            "delphi",
            "status",
            "--report",
            "rgenerated",
            "--job",
            "root",
            "--json",
        ],
    );
    assert!(r.starts_with("GET /api/v3/delphi/visualizations?"));
    assert_eq!(parsed(&o)["data"]["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(parsed(&o)["data"]["jobs"][0]["workLive"], true);
    assert_eq!(parsed(&o)["data"]["jobs"][0]["supersededBy"], "successor");
}
#[test]
fn read_http_200_failures_are_not_empty_successes() {
    for args in [
        vec!["delphi", "results", "--report", "rgenerated", "--json"],
        vec!["delphi", "status", "--report", "rgenerated", "--json"],
        vec!["moderate", "list", "--conversation", "generated", "--json"],
    ] {
        let (o, _) = fixture(
            200,
            "application/json",
            r#"{"status":"error","message":"private-token"}"#,
            &args,
        );
        assert_eq!(o.status.code(), Some(1));
        assert!(!String::from_utf8_lossy(&o.stdout).contains("private-token"));
    }
}
#[test]
fn export_preserves_bytes_and_refuses_html() {
    for (kind, body, success) in [
        ("text/csv", "tid,vote\r\n0,1\r\n", true),
        ("text/html", "<html>login</html>", false),
        ("application/json", r#"{"error":"no"}"#, false),
    ] {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("export.csv");
        let (o, r) = fixture(
            200,
            kind,
            body,
            &[
                "report",
                "export",
                "rgenerated",
                "--type",
                "votes.csv",
                "--output",
                path.to_str().unwrap(),
                "--json",
            ],
        );
        assert!(r.starts_with("GET /api/v3/reportExport/rgenerated/votes.csv "));
        assert_eq!(o.status.success(), success);
        if success {
            assert_eq!(std::fs::read(&path).unwrap(), body.as_bytes());
        } else {
            assert!(!path.exists());
        }
    }
}
#[test]
fn export_never_overwrites_existing_files_or_symlinks() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("keep.csv");
    std::fs::write(&path, "keep").unwrap();
    let link = t.path().join("link.csv");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    for p in [&path, &link] {
        let o = run(
            t.path(),
            &[
                "report",
                "export",
                "rgenerated",
                "--type",
                "votes.csv",
                "--output",
                p.to_str().unwrap(),
                "--json",
            ],
        );
        assert_eq!(o.status.code(), Some(2));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");
    }
}

#[test]
fn moderation_listing_uses_rejected_filter() {
    let (out, request) = fixture(
        200,
        "application/json",
        r#"{"comments":[],"pagination":{"total":0}}"#,
        &[
            "moderate",
            "list",
            "--conversation",
            "generated",
            "--status",
            "rejected",
            "--limit",
            "7",
            "--offset",
            "3",
            "--json",
        ],
    );
    assert!(out.status.success());
    assert!(request.starts_with(
        "GET /api/v3/comments?conversation_id=generated&moderation=true&mod=-1&limit=7&offset=3 "
    ));
}

#[test]
fn dedicated_operations_require_confirmation_before_loading_files_or_network() {
    let declarations: Value =
        serde_json::from_str(include_str!("../../../admin-operations.json")).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("profiles.json"),
        json!({"default":"local","sites":{"local":"http://127.0.0.1:9"}}).to_string(),
    )
    .unwrap();
    let mut count = 0;
    for operation in declarations
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["effect"] == true)
    {
        let mut args: Vec<String> = operation["command"]
            .as_str()
            .unwrap()
            .split(' ')
            .map(str::to_owned)
            .collect();
        for p in operation["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["required"] == true)
        {
            args.push(format!("--{}", p["name"].as_str().unwrap()));
            args.push("private-value-or-nonexistent-file".into());
        }
        args.push("--json".into());
        let out = run(
            tmp.path(),
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        assert_eq!(out.status.code(), Some(2), "{}", operation["command"]);
        assert!(parsed(&out)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--yes"));
        assert!(!String::from_utf8_lossy(&out.stdout).contains("private-value"));
        count += 1;
    }
    assert!(count >= 25);
}

#[test]
fn admin_report_write_resolves_its_conversation_before_mutation() {
    let (out, requests, _) = sequence(
        &[
            (
                200,
                "application/json",
                r#"[{"report_id":"rabc","conversation_id":"abc"}]"#,
            ),
            (200, "application/json", "{}"),
        ],
        &[
            "report", "edit", "--report", "rabc", "--name", "New name", "--yes", "--json",
        ],
    );
    assert!(out.status.success());
    assert!(requests[0].starts_with("GET /api/v3/reports?report_id=rabc "));
    assert!(requests[1].starts_with("PUT /api/v3/reports "));
    let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"conversation_id":"abc","report_id":"rabc","report_name":"New name"})
    );
    assert_eq!(parsed(&out)["data"]["confirmed_by_readback"], false);
    let (out, requests, _) = sequence(
        &[(
            200,
            "application/json",
            r#"[{"report_id":"another","conversation_id":"abc"}]"#,
        )],
        &[
            "report", "edit", "--report", "rabc", "--name", "New name", "--yes", "--json",
        ],
    );
    assert!(!out.status.success());
    assert_eq!(requests.len(), 1);
}

#[test]
fn participant_admin_defaults_to_scoped_identity_and_account_is_explicit() {
    let args = [
        "statement",
        "star",
        "--conversation",
        "abc",
        "--statement",
        "3",
        "--state",
        "on",
        "--yes",
        "--json",
    ];
    let (out, request) = fixture(200, "application/json", "{}", &args);
    assert!(out.status.success());
    assert!(!request.to_lowercase().contains("authorization:"));
    let mut account = args.to_vec();
    account.push("--account");
    let (out, request) = fixture(200, "application/json", "{}", &account);
    assert!(out.status.success());
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer public-fixture-token"));
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body, json!({"conversation_id":"abc","tid":3,"starred":1}));
}

#[test]
fn signed_receipt_never_echoes_capability_or_html() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("signature");
    std::fs::write(&file, "private-generated-capability").unwrap();
    let (out, request) = fixture(
        200,
        "text/html",
        "<a href='private-return-capability'>Done</a>",
        &[
            "notification",
            "subscribe",
            "--conversation",
            "abc",
            "--email",
            "generated@example.invalid",
            "--signature-file",
            file.to_str().unwrap(),
            "--yes",
            "--json",
        ],
    );
    assert!(out.status.success());
    assert!(!request.to_lowercase().contains("authorization:"));
    assert!(request.contains("signature=private-generated-capability"));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("capability"));
    assert_eq!(
        parsed(&out)["data"],
        json!({"state":"response_received","confirmed_by_readback":false})
    );
    let (out, _) = fixture(
        500,
        "application/json",
        r#"{"error":"private-generated-capability"}"#,
        &[
            "notification",
            "subscribe",
            "--conversation",
            "abc",
            "--email",
            "generated@example.invalid",
            "--signature-file",
            file.to_str().unwrap(),
            "--yes",
            "--json",
        ],
    );
    assert_eq!(out.status.code(), Some(7));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("private-generated"));
}

#[test]
fn public_feed_download_is_private_and_sends_no_account_token() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("feed.xml");
    let (out, request) = fixture(
        200,
        "application/rss+xml",
        "<rss>Generated</rss>",
        &[
            "report",
            "feed",
            "topics",
            "--report",
            "rabc",
            "--output",
            dest.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(out.status.success());
    assert!(request.starts_with("GET /feeds/rabc/topics "));
    assert!(!request.to_lowercase().contains("authorization:"));
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        "<rss>Generated</rss>"
    );
    assert_eq!(
        std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let out = run(
        tmp.path(),
        &[
            "report",
            "feed",
            "topics",
            "--report",
            "rabc",
            "--output",
            dest.to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn admin_boolean_lists_and_negative_moderation_are_typed() {
    let (out, request) = fixture(
        200,
        "application/json",
        "{}",
        &[
            "topic",
            "moderate",
            "--conversation",
            "abc",
            "--action",
            "accept",
            "--statements",
            "2,3",
            "--yes",
            "--json",
        ],
    );
    assert!(out.status.success());
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["comment_ids"], json!([2, 3]));
    let (out, request) = fixture(
        200,
        "application/json",
        "{}",
        &[
            "participant",
            "highlight",
            "set",
            "--conversation",
            "abc",
            "--participant",
            "1",
            "--moderation",
            "-1",
            "--yes",
            "--json",
        ],
    );
    assert!(out.status.success());
    assert!(request.contains("\"mod\":-1"));
}

#[test]
fn admin_csv_refuses_html_and_leaves_no_output_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("ids.csv");
    let (out, _) = fixture(
        200,
        "text/html",
        "<html>not csv</html>",
        &[
            "participant",
            "allowlist",
            "export",
            "--conversation",
            "abc",
            "--output",
            dest.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(!out.status.success());
    assert!(!dest.exists());
}

#[test]
fn account_backed_agenda_receipts_strip_issued_authentication() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("selections.json");
    std::fs::write(&file, "[]").unwrap();
    let (out, _) = fixture(
        200,
        "application/json",
        r#"{"count":0,"auth":{"token":"private-generated-token"}}"#,
        &[
            "agenda",
            "add",
            "--conversation",
            "abc",
            "--from",
            file.to_str().unwrap(),
            "--account",
            "--yes",
            "--json",
        ],
    );
    assert!(out.status.success());
    assert_eq!(parsed(&out)["data"]["receipt"], json!({"count":0}));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("private-generated-token"));
}

#[test]
fn email_invitation_lookup_does_not_echo_the_supplied_capability() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("code");
    std::fs::write(&file, "private-invitation-capability").unwrap();
    let (out, request) = fixture(
        200,
        "application/json",
        r#"{"einvite":"private-invitation-capability","email":"generated@example.invalid","created":0}"#,
        &[
            "invite",
            "email",
            "lookup",
            "--code-file",
            file.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(out.status.success());
    assert!(request.contains("einvite=private-invitation-capability"));
    assert_eq!(
        parsed(&out)["data"],
        json!({"email":"generated@example.invalid","created":0})
    );
    assert!(!String::from_utf8_lossy(&out.stdout).contains("private-invitation-capability"));
}

#[test]
fn export_capability_is_saved_privately_never_followed_or_printed() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("link.json");
    let args = [
        "report",
        "export-results",
        "--conversation",
        "abc",
        "--filename",
        "polis-export-abc-1.zip",
        "--output",
        dest.to_str().unwrap(),
        "--json",
    ];
    let url = "https://127.0.0.1:9/generated?signature=private-generated-signature";
    let (out, request) = fixture(302, &format!("text/html\r\nLocation: {url}"), "", &args);
    assert!(out.status.success());
    assert!(request.starts_with("GET /api/v3/dataExport/results?"));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("signature"));
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&dest).unwrap()).unwrap(),
        json!({"url":url,"artifact_verified":false})
    );
    assert_eq!(
        std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::remove_file(&dest).unwrap();
    for location in [
        "http://example.invalid/export",
        "javascript:private-code",
        "https://user:secret@example.invalid/file",
    ] {
        let (out, _) = fixture(
            302,
            &format!("text/html\r\nLocation: {location}"),
            "",
            &args,
        );
        assert!(!out.status.success());
        assert!(!dest.exists());
        assert!(!String::from_utf8_lossy(&out.stdout).contains(location));
    }
}

#[test]
fn unsafe_legacy_participant_join_is_absent_from_parser_and_schema() {
    let tmp = tempfile::tempdir().unwrap();
    let out = run(tmp.path(), &["participant", "join", "--json"]);
    assert_eq!(out.status.code(), Some(2));
    let out = run(tmp.path(), &["schema", "participant", "--json"]);
    assert!(out.status.success());
    assert!(!parsed(&out)["data"]
        .to_string()
        .contains("participant join"));
}

#[test]
fn xid_map_download_sends_account_bearer_and_preserves_permission_refusal() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let key = tmp.path().join("key");
    let dest = tmp.path().join("map.csv");
    std::fs::write(&key, "00000000-0000-4000-8000-000000000027").unwrap();
    let args = [
        "participant",
        "xid",
        "capability-export",
        "--key-file",
        key.to_str().unwrap(),
        "--output",
        dest.to_str().unwrap(),
        "--json",
    ];
    let (out, request) = fixture(200, "text/csv", "participant,xid\n0,generated\n", &args);
    assert!(out.status.success());
    assert!(request.starts_with("GET /api/v3/xid/00000000-0000-4000-8000-000000000027-xid.csv "));
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer public-fixture-token"));
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        "participant,xid\n0,generated\n"
    );
    assert_eq!(
        std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!text(&out).contains("public-fixture-token"));
    std::fs::remove_file(&dest).unwrap();
    let (out, request) = fixture(
        403,
        "application/json",
        r#"{"error":"owner_or_moderator_required"}"#,
        &args,
    );
    assert_eq!(out.status.code(), Some(4));
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer public-fixture-token"));
    assert!(!dest.exists());
}

#[test]
fn xid_map_requires_account_sign_in_before_network_or_file_creation() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::fs::write(
        tmp.path().join("profiles.json"),
        json!({"default":"local","sites":{"local":origin}}).to_string(),
    )
    .unwrap();
    let key = tmp.path().join("key");
    let dest = tmp.path().join("map.csv");
    std::fs::write(&key, "00000000-0000-4000-8000-000000000027").unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_") {
            cmd.env_remove(key);
        }
    }
    let out = cmd
        .env("POLIS_CONFIG_DIR", tmp.path())
        .env("POLIS_KEYCHAIN", "off")
        .env(
            "POLIS_KEYCHAIN_SERVICE",
            format!(
                "org.pol.is.cli.test.{}",
                listener.local_addr().unwrap().port()
            ),
        )
        .args([
            "participant",
            "xid",
            "capability-export",
            "--key-file",
            key.to_str().unwrap(),
            "--output",
            dest.to_str().unwrap(),
            "--json",
            "--no-interactive",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3), "{}", text(&out));
    assert!(!dest.exists());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn raw_api_cannot_use_legacy_admission_or_seed_participant_comments() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::fs::write(
        tmp.path().join("profiles.json"),
        json!({"default":"local","sites":{"local":origin}}).to_string(),
    )
    .unwrap();
    for path in [
        "/api/v3/participants",
        "/api/v3/PARTICIPANTS/?conversation_id=abc",
        "/api/v3/joinWithInvite",
        "/api/v3/JOINWITHINVITE/",
        "/api/v3/unused/../joinWithInvite",
        "/api/v3/comments?is_seed=true",
    ] {
        let out = run(tmp.path(), &["api", "POST", path, "--json"]);
        assert_eq!(out.status.code(), Some(2), "{path}: {}", text(&out));
    }
    let input = tmp.path().join("comment.json");
    std::fs::write(
        &input,
        r#"{"conversation_id":"abc","txt":"Generated statement","is_seed":true}"#,
    )
    .unwrap();
    let out = run(
        tmp.path(),
        &[
            "api",
            "POST",
            "/api/v3/comments",
            "--input",
            input.to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
#[test]
fn input_is_validated_before_any_credential_is_read() {
    // A credential directory that is world-writable makes every credential read
    // refuse (exit 3) without touching the Keychain, so exit 2 proves the input
    // was refused first.
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let creds = tmp.path().join("credentials");
    std::fs::create_dir(&creds).unwrap();
    std::fs::set_permissions(&creds, std::fs::Permissions::from_mode(0o777)).unwrap();
    let existing = tmp.path().join("existing.csv");
    std::fs::write(&existing, "keep").unwrap();
    let polis = |args: &[&str]| -> i32 {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
        for (key, _) in std::env::vars() {
            if key.starts_with("POLIS_") {
                cmd.env_remove(key);
            }
        }
        cmd.env("POLIS_CONFIG_DIR", tmp.path())
            .env("POLIS_KEYCHAIN", "off")
            .args(args)
            .args(["--json", "--no-interactive"])
            .output()
            .unwrap()
            .status
            .code()
            .unwrap()
    };
    assert_eq!(
        polis(&["auth", "status"]),
        3,
        "control: the store is refused"
    );
    assert_eq!(polis(&["api", "/api/v3/../../outside"]), 2);
    assert_eq!(polis(&["api", "/elsewhere"]), 2);
    let out = tmp.path().join("new.csv");
    assert_eq!(
        polis(&[
            "participant",
            "export",
            "--conversation",
            "bad!",
            "--output",
            out.to_str().unwrap()
        ]),
        2
    );
    assert_eq!(
        polis(&[
            "participant",
            "export",
            "--conversation",
            "2demo",
            "--output",
            existing.to_str().unwrap()
        ]),
        2
    );
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "keep");
    assert_eq!(polis(&["conversation", "close", "bad!"]), 2);
    for args in [
        &["delphi", "status", "--report", "bad!"][..],
        &["delphi", "results", "--report", "2demo", "--job", "bad/job"],
        &["report", "view", "bad!"],
        &["moderate", "list", "--conversation", "bad!"],
        &["vote", "list", "--conversation", "bad!"],
    ] {
        assert_eq!(polis(args), 2, "{args:?}");
    }
    assert_eq!(
        polis(&[
            "report",
            "export",
            "2demo",
            "--type",
            "summary.csv",
            "--output",
            existing.to_str().unwrap()
        ]),
        2
    );
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "keep");
}
#[test]
fn a_site_cannot_write_escape_sequences_through_passed_through_help_text() {
    // Normal output prints a top-level "help" or "table" string as preformatted
    // text; when a command passes the site's JSON through, that text is the site's.
    let (o, _) = fixture(
        200,
        "application/json",
        r#"{"help":"\u001b[2J\u001b]52;c;Zm9v\u0007shown\u009b31m\u200b\u202e line\n\tnext"}"#,
        &["api", "/api/v3/example"],
    );
    let out = String::from_utf8(o.stdout).unwrap();
    assert!(out.contains("shown"), "{out}");
    assert!(out.contains("line\n\tnext"));
    for bad in ['\u{1b}', '\u{7}', '\u{9b}', '\u{200b}', '\u{202e}'] {
        assert!(!out.contains(bad), "{bad:?} reached the terminal");
    }
}

#[test]
fn structured_client_errors_keep_server_reason_and_exit_codes() {
    let body = json!({"status":"error","code":"INSUFFICIENT_CONSENSUS",
        "message":"Fewer than three comments meet the existing report consensus rule",
        "detail":"not-public","stack":"not-public"})
    .to_string();
    for (status, exit) in [
        (400, 1),
        (401, 3),
        (403, 4),
        (404, 1),
        (409, 5),
        (422, 1),
        (429, 6),
    ] {
        for method in ["GET", "POST"] {
            let (out, _) = fixture(
                status,
                "application/json",
                &body,
                &["api", "/api/v3/example", "--method", method, "--json"],
            );
            let v = parsed(&out);
            assert_eq!(out.status.code(), Some(exit), "{v}");
            assert_eq!(v["error"]["upstream"]["code"], "INSUFFICIENT_CONSENSUS");
            assert_eq!(
                v["error"]["upstream"]["message"],
                "Fewer than three comments meet the existing report consensus rule"
            );
            assert_eq!(v["error"]["outcome"], "rejected");
            assert_eq!(v["error"]["retryable"], false);
            assert!(!v.to_string().contains("not-public"));
        }
    }
}

#[test]
fn structured_conflict_is_visible_without_json() {
    let body = r#"{"code":"INSUFFICIENT_CONSENSUS","message":"Fewer than three comments qualify"}"#;
    let (out, _) = fixture(409, "application/json", body, &["api", "/api/v3/example"]);
    assert_eq!(out.status.code(), Some(5));
    let text = String::from_utf8(out.stderr).unwrap();
    assert!(text.contains("INSUFFICIENT_CONSENSUS"), "{text}");
    assert!(text.contains("Fewer than three comments qualify"), "{text}");
}

#[test]
fn structured_error_fields_are_bounded_and_do_not_echo_credentials_or_diagnostics() {
    let body=json!({"error":{"code":"MISSING_INPUT","message":"Token public-fixture-token: bad\u{1b}[2J\n\u{85}\u{202e} café", "detail":"private-detail"},"stack":"private-stack"}).to_string();
    for json_mode in [false, true] {
        let mut args = vec!["api", "/api/v3/example"];
        if json_mode {
            args.push("--json");
        }
        let (out, _) = fixture(422, "application/json", &body, &args);
        assert_eq!(out.status.code(), Some(1));
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        for forbidden in [
            "public-fixture-token",
            "private-detail",
            "private-stack",
            "\u{1b}",
            "\u{85}",
            "\u{202e}",
        ] {
            assert!(!text.contains(forbidden), "{text}");
        }
        assert!(text.contains("[redacted]"));
        assert!(text.contains("café"));
        if json_mode {
            let v = parsed(&out);
            assert_eq!(v["error"]["upstream"]["code"], "MISSING_INPUT");
            assert!(v["error"]["upstream"]["message"]
                .as_str()
                .unwrap()
                .contains("\\u{1b}"));
        }
    }
    for body in [
        json!({"code": "X".repeat(129),"message":"x".repeat(4097)}),
        json!({"code": "bad code","message":{"nested":"private-detail"}}),
        json!({"code": "public-fixture-token","message":""}),
    ] {
        let (out, _) = fixture(
            409,
            "application/json",
            &body.to_string(),
            &["api", "/api/v3/example", "--json"],
        );
        let v = parsed(&out);
        assert_eq!(out.status.code(), Some(5));
        assert!(v["error"]["upstream"].get("code").is_none());
        assert!(v["error"]["upstream"].get("message").is_none());
    }
}

#[test]
fn unstructured_and_server_errors_keep_the_existing_fallback() {
    for (status, kind, body, exit) in [
        (409, "text/html", "<html>private-details</html>", 5),
        (400, "application/json", "{invalid private-details", 1),
        (
            500,
            "application/json",
            r#"{"code":"PRIVATE_DETAILS","message":"private-details"}"#,
            7,
        ),
        (409, "application/json", r#"{"error":"private-details"}"#, 5),
    ] {
        let (out, _) = fixture(
            status,
            kind,
            body,
            &["api", "/api/v3/example", "--method", "POST", "--json"],
        );
        let v = parsed(&out);
        assert_eq!(out.status.code(), Some(exit), "{v}");
        assert!(v["error"]["upstream"].get("message").is_none());
        assert!(!v.to_string().contains("private-details"));
        assert_eq!(
            v["error"]["outcome"],
            if status >= 500 { "unknown" } else { "rejected" }
        );
    }
}

#[test]
fn printed_json_escapes_terminal_controls_without_changing_json_values() {
    let text = "visible\u{009b}2J\u{009d}52;c;data\u{009c}\u{202e}hidden\u{200b}\u{061c}\u{feff}";
    let body = json!({"text":text,"nested":{text:"value"}});
    for json_output in [false, true] {
        let mut args = vec!["conversation", "view", "fixture"];
        if json_output {
            args.push("--json");
        }
        let (out, _) = fixture(200, "application/json", &body.to_string(), &args);
        assert_eq!(out.status.code(), Some(0));
        let printed = String::from_utf8(out.stdout).unwrap();
        assert!(!printed.chars().any(|c| matches!(
            c,
            '\u{007f}'..='\u{009f}' | '\u{202e}' | '\u{200b}' | '\u{061c}' | '\u{feff}'
        )));
        let value: Value = serde_json::from_str(&printed).unwrap();
        assert_eq!(if json_output { &value["data"] } else { &value }, &body);
    }
}

#[test]
fn size_sort_uses_stats_counts_and_preserves_raw_counter() {
    let rows = json!([
        {"conversation_id":"abc","is_owner":true,"participant_count":99,"topic":"A"},
        {"conversation_id":"def","is_owner":true,"participant_count":1,"topic":"B"},
        {"conversation_id":"ghi","is_owner":false}
    ])
    .to_string();
    let a = json!({"firstVoteTimes":[1],"commentTimes":[1,2,3],"voteTimes":[1,2]}).to_string();
    let b = json!({"firstVoteTimes":[1,2],"commentTimes":[],"voteTimes":[1,2,3]}).to_string();
    for (sort, first) in [
        ("participants", "def"),
        ("statements", "abc"),
        ("votes", "def"),
    ] {
        let (o, req, _) = sequence(
            &[
                (200, "application/json", &rows),
                (200, "application/json", &a),
                (200, "application/json", &b),
            ],
            &["conversation", "list", "--sort", sort, "--json"],
        );
        assert!(o.status.success(), "{}", text(&o));
        let v = parsed(&o);
        assert_eq!(v["data"]["conversations"][0]["conversation_id"], first);
        let a = v["data"]["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["conversation_id"] == "abc")
            .unwrap();
        assert_eq!(a["participant_count"], 99);
        assert_eq!(
            a["size"],
            json!({"participants":1,"statements":3,"votes":2})
        );
        assert_eq!(v["data"]["size_scope"], "returned_owned_rows");
        assert_eq!(req.len(), 3);
        assert!(req[1].starts_with("GET /api/v3/conversationStats?conversation_id=abc HTTP/"));
        assert!(req[2].starts_with("GET /api/v3/conversationStats?conversation_id=def HTTP/"));
    }
}

#[test]
fn size_table_shows_zero_and_size_sort_is_stable_when_tied() {
    let rows = owned_conversations();
    let stats = r#"{"firstVoteTimes":[],"commentTimes":[],"voteTimes":[]}"#;
    let (o, req, _) = sequence(
        &[
            (200, "application/json", &rows),
            (200, "application/json", stats),
            (200, "application/json", stats),
            (200, "application/json", "[]"),
        ],
        &["conversation", "list", "--sort", "votes"],
    );
    assert!(o.status.success(), "{}", text(&o));
    let table = text(&o);
    assert!(table.contains("PARTICIPANTS  STATEMENTS  VOTES"), "{table}");
    assert!(table.find("Budget 2027").unwrap() < table.find("Parks").unwrap());
    assert_eq!(
        table
            .lines()
            .filter(|line| line.ends_with("0             0           0"))
            .count(),
        2,
        "{table}"
    );
    assert_eq!(req.len(), 4);
}

#[test]
fn sizes_refuse_partial_counts_and_keep_failed_reads_as_errors() {
    for (status, body) in [
        (200, r#"{"firstVoteTimes":[],"voteTimes":[]}"#),
        (
            200,
            r#"{"firstVoteTimes":["bad"],"commentTimes":[],"voteTimes":[]}"#,
        ),
        (403, "{}"),
        (500, "{}"),
    ] {
        let rows = r#"[{"conversation_id":"abc","is_owner":true}]"#;
        let (o, req, _) = sequence(
            &[
                (200, "application/json", rows),
                (status, "application/json", body),
            ],
            &["conversation", "list", "--sizes", "--json"],
        );
        assert!(!o.status.success());
        assert!(parsed(&o)["data"].is_null());
        assert_eq!(req.len(), 2);
    }
}

#[test]
fn size_options_reject_cursor_or_large_fanout_before_credentials() {
    for opts in [
        vec!["--sort", "votes", "--cursor", "x"],
        vec!["--sort", "participants", "--min-participants", "1"],
        vec!["--sizes", "--sort", "newest"],
        vec!["--sort", "statements", "--recent"],
        vec!["--sizes", "--limit", "501"],
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut args = vec!["conversation", "list", "--json"];
        args.extend(opts);
        let o = run(dir.path(), &args);
        assert_eq!(o.status.code(), Some(2), "{}", text(&o));
    }
}

#[test]
fn sizes_preserve_truncation_filter_candidates_and_warn_about_scope() {
    let rows = owned_conversations();
    let stats = r#"{"firstVoteTimes":[],"commentTimes":[],"voteTimes":[]}"#;
    let (o, req, _) = sequence(
        &[
            (200, "application/json", &rows),
            (200, "application/json", stats),
        ],
        &[
            "conversation",
            "list",
            "--sizes",
            "--search",
            "Parks",
            "--limit",
            "3",
            "--json",
        ],
    );
    assert!(o.status.success(), "{}", text(&o));
    let v = parsed(&o);
    assert_eq!(v["data"]["pagination"]["truncated"], true);
    assert_eq!(v["data"]["pagination"]["server_rows"], 3);
    assert_eq!(v["data"]["conversations"].as_array().unwrap().len(), 1);
    assert!(String::from_utf8_lossy(&o.stderr).contains("larger conversations may be absent"));
    assert_eq!(req.len(), 2);
    assert!(req[1].contains("conversation_id=def"));
}

#[test]
fn sizes_validate_all_ids_and_server_limit_before_stats_reads() {
    for (rows, limit) in [
        (
            r#"[{"conversation_id":"abc","is_owner":true},{"conversation_id":"../unsafe","is_owner":true}]"#,
            "3",
        ),
        (
            r#"[{"conversation_id":"abc","is_owner":true},{"conversation_id":"def","is_owner":true}]"#,
            "1",
        ),
    ] {
        let (o, req, _) = sequence(
            &[(200, "application/json", rows)],
            &[
                "conversation",
                "list",
                "--sizes",
                "--limit",
                limit,
                "--json",
            ],
        );
        assert!(!o.status.success());
        assert_eq!(req.len(), 1);
    }
}

#[test]
fn sizes_empty_list_needs_no_stats_or_report_reads() {
    let (o, req, _) = sequence(
        &[(200, "application/json", "[]")],
        &["conversation", "list", "--sort", "participants", "--json"],
    );
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(parsed(&o)["data"]["conversations"], json!([]));
    assert_eq!(req.len(), 1);
}
