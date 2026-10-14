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
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
    let server = thread::spawn(move || {
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
        String::from_utf8(bytes).unwrap()
    });
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("profiles.json"),
        json!({"default":"local","sites":{"local":format!("http://{address}")}}).to_string(),
    )
    .unwrap();
    let out = run(tmp.path(), args);
    (out, server.join().unwrap())
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
    let o = run(t.path(), &["delphi", "run", "--json"]);
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
