use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
};

fn call(dir: &std::path::Path, args: &[&str], input: Option<&str>, token: bool) -> (i32, Value) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("POLIS_CONFIG_DIR", dir)
        .args(args)
        .args(["--json", "--no-interactive"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if token {
        cmd.env("POLIS_TOKEN_LOCAL", "fixture-token");
    }
    let mut child = cmd.spawn().unwrap();
    if let Some(s) = input {
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    let o = child.wait_with_output().unwrap();
    assert!(!String::from_utf8_lossy(&o.stdout).contains("fixture-token"));
    (
        o.status.code().unwrap(),
        serde_json::from_slice(&o.stdout).unwrap(),
    )
}
fn server(
    dir: &std::path::Path,
    responses: Vec<(u16, &'static str, String)>,
) -> std::thread::JoinHandle<Vec<String>> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::fs::write(dir.join("profiles.json"),json!({"default":"local","sites":{"local":format!("http://{}",listener.local_addr().unwrap())}}).to_string()).unwrap();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, content_type, body) in responses {
            let start = std::time::Instant::now();
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(start.elapsed().as_secs() < 10, "missing request");
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 8192];
            loop {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
fn json_res(v: Value) -> (u16, &'static str, String) {
    (200, "application/json", v.to_string())
}
fn parsed_call(dir: &std::path::Path, args: &[&str]) -> (i32, Value) {
    call(dir, args, None, true)
}
fn page(rows: Value) -> Value {
    json!({"comments":rows,"pagination":{"total":3,"has_more":false}})
}
#[test]
fn public_statement_list_is_paginated_and_preserves_rows() {
    let t = tempfile::tempdir().unwrap();
    let body = page(json!([{"tid":7,"txt":" exact <untrusted> ","original_id":null}]));
    let s = server(t.path(), vec![json_res(body.clone())]);
    let (exit, v) = call(
        t.path(),
        &[
            "statement",
            "list",
            "--conversation",
            "convA",
            "--limit",
            "2",
            "--offset",
            "4",
        ],
        None,
        false,
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"], body);
    let req = s.join().unwrap();
    assert!(req[0].starts_with("GET /api/v3/comments?conversation_id=convA&limit=2&offset=4 "));
    assert!(!req[0].to_lowercase().contains("authorization:"));
    assert!(!req[0].contains("moderation="));
}
#[test]
fn statement_view_filters_exact_tid_and_returns_the_unchanged_row() {
    let t = tempfile::tempdir().unwrap();
    let row = json!({"tid":0,"txt":"fixture","is_meta":true});
    let s = server(t.path(), vec![json_res(page(json!([row.clone()])))]);
    let (exit, v) = parsed_call(
        t.path(),
        &["statement", "view", "0", "--conversation", "convA"],
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"], row);
    assert!(s.join().unwrap()[0]
        .starts_with("GET /api/v3/comments?conversation_id=convA&tids=0&limit=2&offset=0 "));
}
#[test]
fn empty_list_succeeds_but_hidden_or_missing_single_is_unavailable() {
    for (args, expected) in [
        (vec!["statement", "list", "--conversation", "convA"], 0),
        (vec!["statement", "view", "0", "--conversation", "convA"], 1),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(page(json!([])))]);
        let (exit, v) = parsed_call(t.path(), &args);
        assert_eq!(exit, expected);
        if exit != 0 {
            assert_eq!(v["error"]["code"], "statement_unavailable");
            assert!(v["error"]["action"]
                .as_str()
                .unwrap()
                .contains("moderate list"));
        }
        s.join().unwrap();
    }
}
#[test]
fn mismatched_duplicate_or_malformed_statement_rows_are_errors() {
    for body in [
        page(json!([{"tid":1,"txt":"wrong"}])),
        page(json!([{"tid":0,"txt":"a"},{"tid":0,"txt":"b"}])),
        page(json!([{"tid":0,"txt":null}])),
        page(json!([{"tid":-1,"txt":"bad"}])),
        json!({"comments":[]}),
        json!([]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = parsed_call(
            t.path(),
            &["statement", "view", "0", "--conversation", "convA"],
        );
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn collective_list_keeps_parsed_json_metadata_and_nulls() {
    for rows in [
        json!([]),
        json!([{"zid_topic_jobid":"opaque#key","statement_data":{"paragraphs":[]},"comments_data":null,"model":"fixture"}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let body =
            json!({"status":"success","statements":rows,"count":rows.as_array().unwrap().len()});
        let s = server(t.path(), vec![json_res(body.clone())]);
        let (exit, v) = call(
            t.path(),
            &["collective", "list", "--report", "rA"],
            None,
            false,
        );
        assert_eq!(exit, 0);
        assert_eq!(v["data"], body);
        let req = s.join().unwrap();
        assert!(req[0].starts_with("GET /api/v3/collectiveStatement?report_id=rA "));
        assert!(!req[0].to_lowercase().contains("authorization:"));
    }
}
#[test]
fn collective_view_encodes_opaque_key_and_preserves_stored_json_strings() {
    let t = tempfile::tempdir().unwrap();
    let id = "key#0#1?x=2&猫/%";
    let body = json!({"status":"success","statement":{"zid_topic_jobid":id,"statement_data":"{\"paragraphs\":[]}","comments_data":"[]"}});
    let s = server(t.path(), vec![json_res(body.clone())]);
    let (exit, v) = parsed_call(t.path(), &["collective", "view", id]);
    assert_eq!(exit, 0);
    assert_eq!(v["data"], body);
    let req = s.join().unwrap();
    let url = url::Url::parse(&format!(
        "http://localhost{}",
        req[0].split_whitespace().nth(1).unwrap()
    ))
    .unwrap();
    assert_eq!(url.path(), "/api/v3/collectiveStatement");
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("statement_id".into(), id.into())]
    );
}
#[test]
fn malformed_collective_list_shapes_are_rejected() {
    for body in [
        json!({}),
        json!({"status":"success","statements":[],"count":1}),
        json!({"status":"success","statements":[{}],"count":1}),
        json!({"status":"success","statements":[],"count":"0"}),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = parsed_call(t.path(), &["collective", "list", "--report", "rA"]);
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn collective_view_refuses_a_missing_or_different_returned_key() {
    for statement in [json!(null), json!({}), json!({"zid_topic_jobid":"wrong"})] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(json!({"status":"success","statement":statement}))],
        );
        let (exit, v) = parsed_call(t.path(), &["collective", "view", "opaque#key"]);
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn collective_missing_view_is_actionable_and_does_not_echo_details() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            404,
            "application/json",
            json!({"status":"error","message":"Statement not found","detail":"private-detail"})
                .to_string(),
        )],
    );
    let (exit, v) = parsed_call(t.path(), &["collective", "view", "opaque#key"]);
    assert_eq!(exit, 1);
    assert_eq!(v["error"]["code"], "collective_statement_unavailable");
    assert!(v["error"]["action"]
        .as_str()
        .unwrap()
        .contains("collective list"));
    assert_eq!(v["error"]["upstream"]["message"], "Statement not found");
    assert!(!v.to_string().contains("private-detail"));
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn read_failures_keep_status_and_suppress_upstream_prose_without_retry() {
    for status in [200, 500] {
        for args in [
            vec!["collective", "list", "--report", "rA"],
            vec!["statement", "list", "--conversation", "convA"],
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(
                t.path(),
                vec![(
                    status,
                    "application/json",
                    json!({"status":"error","message":"private-detail"}).to_string(),
                )],
            );
            let (exit, v) = parsed_call(t.path(), &args);
            assert_eq!(exit, if status == 200 { 1 } else { 6 });
            assert_eq!(
                v["error"]["code"],
                if args[0] == "collective" {
                    "collective_read_failed"
                } else {
                    "statements_read_failed"
                }
            );
            assert_eq!(v["error"]["upstream"]["status"], status);
            assert!(!v.to_string().contains("private-detail"));
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
}
#[test]
fn auth_permission_rate_and_redirect_errors_keep_their_meaning() {
    for (status, code, exit) in [
        (401, "auth_invalid", 3),
        (403, "forbidden", 4),
        (429, "rate_limited", 6),
        (302, "redirect_refused", 1),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(status, "application/json", "{}".into())]);
        let (got, v) = parsed_call(t.path(), &["collective", "view", "opaque#key"]);
        assert_eq!(got, exit);
        assert_eq!(v["error"]["code"], code);
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn invalid_parameters_are_refused_before_http() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for args in [
        vec!["statement", "view", "2147483648", "--conversation", "convA"],
        vec!["statement", "view", "-1", "--conversation", "convA"],
        vec!["statement", "list", "--conversation", "../x"],
        vec![
            "statement",
            "list",
            "--conversation",
            "convA",
            "--limit",
            "0",
        ],
        vec!["collective", "list", "--report", "r?x"],
        vec!["collective", "view", ""],
        vec!["collective", "view", "a\nb"],
    ] {
        assert_eq!(parsed_call(t.path(), &args).0, 2);
    }
    assert_eq!(
        parsed_call(t.path(), &["collective", "view", &"x".repeat(2049)]).0,
        2
    );
}
#[test]
fn manuals_and_schema_expose_the_stored_read_limits() {
    let t = tempfile::tempdir().unwrap();
    for (args, text) in [
        (vec!["help", "statement", "list"], "participant"),
        (vec!["help", "statement", "view"], "statement_unavailable"),
        (vec!["help", "collective", "list"], "deduplication"),
        (vec!["help", "collective", "view"], "JSON strings"),
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert!(v["data"]["help"].as_str().unwrap().contains(text));
    }
    for args in [
        vec!["schema", "statement", "view"],
        vec!["schema", "collective", "view"],
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["implemented"], true);
    }
    assert_eq!(
        call(t.path(), &["collective", "generate"], None, false).0,
        2
    );
}

fn human_call(dir: &std::path::Path, report: &str) -> (i32, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    let result = cmd
        .env("POLIS_CONFIG_DIR", dir)
        .args(["collective", "statements", report, "--no-interactive"])
        .output()
        .unwrap();
    (
        result.status.code().unwrap(),
        String::from_utf8(result.stdout).unwrap(),
    )
}

#[test]
fn collective_statements_prints_topic_paragraphs_and_citations() {
    let t = tempfile::tempdir().unwrap();
    let body = json!({"status":"success","count":2,"statements":[
        {"zid_topic_jobid":"first","topic_name":"Transit","statement_data":{"paragraphs":[
            {"title":"Access","sentences":[{"clauses":[
                {"text":"More frequent buses.","citations":[3,8]},
                {"text":"Safer stops.","citations":[]}
            ]}]},
            {"title":"Service","sentences":[{"clauses":[{"text":"Evening routes.","citations":["12"]}]}]}
        ]}},
        {"zid_topic_jobid":"second","topic_name":"Parks","statement_data":{"paragraphs":[
            {"sentences":[{"clauses":[{"text":"More shade.","citations":[21]}]}]}
        ]}}
    ]});
    let s = server(t.path(), vec![json_res(body)]);
    let (exit, text) = human_call(t.path(), "rFixture");
    assert_eq!(exit, 0);
    assert_eq!(text,"Transit\n\nAccess\nMore frequent buses. [3, 8] Safer stops.\n\nService\nEvening routes. [12]\n\nParks\n\nMore shade. [21]\n\n");
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/v3/collectiveStatement?report_id=rFixture "));
    assert!(!requests[0].to_lowercase().contains("authorization:"));
}

#[test]
fn collective_statements_json_preserves_complete_response() {
    let t = tempfile::tempdir().unwrap();
    let body = json!({"status":"success","count":1,"statements":[{"zid_topic_jobid":"opaque","topic_name":"Topic","statement_data":{"paragraphs":[]},"comments_data":null,"model":"fixture","extra":{"retained":true}}]});
    let s = server(t.path(), vec![json_res(body.clone())]);
    let (exit, v) = call(
        t.path(),
        &["collective", "statements", "rFixture"],
        None,
        false,
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"], body);
    assert_eq!(s.join().unwrap().len(), 1);
}

#[test]
fn collective_statements_empty_and_missing_text_are_explicit() {
    for (body, expected) in [
        (
            json!({"status":"success","statements":[],"count":0}),
            "No stored collective statements.\n",
        ),
        (
            json!({"status":"success","statements":[{"zid_topic_jobid":"opaque","topic_key":"0_1","statement_data":null}],"count":1}),
            "0_1\n\nNo stored statement text.\n\n",
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        assert_eq!(human_call(t.path(), "rFixture"), (0, expected.into()));
        s.join().unwrap();
    }
}

#[test]
fn collective_statements_terminal_controls_cannot_rewrite_output() {
    let t = tempfile::tempdir().unwrap();
    let body = json!({"status":"success","count":1,"statements":[{"zid_topic_jobid":"opaque","topic_name":"Topic\u{001b}[2J","statement_data":{"paragraphs":[{"sentences":[{"clauses":[{"text":"Safe\u{001b}]0;bad\u{0007}\u{202e} text","citations":[]}]}]}]}}]});
    let s = server(t.path(), vec![json_res(body)]);
    let (exit, text) = human_call(t.path(), "rFixture");
    assert_eq!(exit, 0);
    assert!(!text.contains(['\u{001b}', '\u{0007}', '\u{202e}']));
    assert!(text.contains("Safe"));
    s.join().unwrap();
}

#[test]
fn collective_statements_refuses_invalid_report_and_malformed_response() {
    let t = tempfile::tempdir().unwrap();
    let (exit, v) = call(
        t.path(),
        &["collective", "statements", "bad?report"],
        None,
        false,
    );
    assert_eq!(exit, 2);
    assert_eq!(v["error"]["code"], "invalid_input");
    let s = server(
        t.path(),
        vec![json_res(
            json!({"status":"success","statements":[],"count":1}),
        )],
    );
    let (exit, v) = call(
        t.path(),
        &["collective", "statements", "rFixture"],
        None,
        false,
    );
    assert_eq!(exit, 1);
    assert_eq!(v["error"]["code"], "invalid_response");
    s.join().unwrap();
}

#[test]
fn collective_statements_propagates_storage_failure_without_generating() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            500,
            "application/json",
            json!({"status":"error","message":"internal-detail"}).to_string(),
        )],
    );
    let (exit, v) = call(
        t.path(),
        &["collective", "statements", "rFixture"],
        None,
        false,
    );
    assert_eq!(exit, 6);
    assert_eq!(v["error"]["code"], "collective_read_failed");
    assert!(!v.to_string().contains("internal-detail"));
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET "));
}
