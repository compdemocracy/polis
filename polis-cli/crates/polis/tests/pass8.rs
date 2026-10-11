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
fn question() -> Value {
    json!({"pmqid":1,"key":" exact <untrusted> ","alive":true,"required":true})
}
fn answer() -> Value {
    json!({"pmqid":1,"pmaid":2,"value":"choice","alive":true,"is_exclusive":true})
}
#[test]
fn public_reads_use_exact_routes_and_preserve_rows_and_order() {
    for (args, route, body) in [
        (
            vec!["metadata", "question", "list", "--conversation", "convA"],
            "/api/v3/metadata/questions?conversation_id=convA",
            json!([question()]),
        ),
        (
            vec!["metadata", "answer", "list", "--conversation", "convA"],
            "/api/v3/metadata/answers?conversation_id=convA",
            json!([answer()]),
        ),
        (
            vec!["context", "list"],
            "/api/v3/contexts",
            json!([{"name":"z"},{"name":"a"}]),
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body.clone())]);
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert_eq!(v["data"], body);
        let req = s.join().unwrap();
        assert_eq!(req.len(), 1);
        assert!(req[0].starts_with(&format!("GET {route} ")));
        assert!(!req[0].to_lowercase().contains("authorization:"));
    }
}
#[test]
fn exact_question_filter_is_sent_and_verified() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![json_res(json!([answer()]))]);
    let (exit, v) = parsed_call(
        t.path(),
        &[
            "metadata",
            "answer",
            "list",
            "--conversation",
            "convA",
            "--question",
            "1",
        ],
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"][0], answer());
    assert!(s.join().unwrap()[0]
        .starts_with("GET /api/v3/metadata/answers?conversation_id=convA&pmqid=1 "));
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![json_res(json!([answer()]))]);
    let (exit, v) = parsed_call(
        t.path(),
        &[
            "metadata",
            "answer",
            "list",
            "--conversation",
            "convA",
            "--question",
            "3",
        ],
    );
    assert_eq!(exit, 1);
    assert_eq!(v["error"]["code"], "invalid_response");
    s.join().unwrap();
}
#[test]
fn empty_lists_succeed_for_all_three_commands() {
    for args in [
        vec!["metadata", "question", "list", "--conversation", "convA"],
        vec![
            "metadata",
            "answer",
            "list",
            "--conversation",
            "convA",
            "--question",
            "7",
        ],
        vec!["context", "list"],
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!([]))]);
        let (exit, v) = parsed_call(t.path(), &args);
        assert_eq!(exit, 0);
        assert_eq!(v["data"], json!([]));
        s.join().unwrap();
    }
}
#[test]
fn malformed_question_rows_and_duplicate_ids_are_refused() {
    let mut cases = vec![json!({}), json!(null), json!([question(), question()])];
    for (k, value) in [
        ("pmqid", json!(0)),
        ("pmqid", json!(2147483648_u64)),
        ("key", json!(null)),
        ("required", json!("true")),
        ("alive", json!(false)),
    ] {
        let mut row = question();
        row[k] = value;
        cases.push(json!([row]));
    }
    for body in cases {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = parsed_call(
            t.path(),
            &["metadata", "question", "list", "--conversation", "convA"],
        );
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn malformed_answer_rows_and_duplicate_ids_are_refused() {
    let mut cases = vec![json!({}), json!([answer(), answer()])];
    for (k, value) in [
        ("pmaid", json!(-1)),
        ("pmqid", json!(null)),
        ("value", json!(null)),
        ("is_exclusive", json!(null)),
        ("alive", json!(false)),
    ] {
        let mut row = answer();
        row[k] = value;
        cases.push(json!([row]));
    }
    for body in cases {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = parsed_call(
            t.path(),
            &["metadata", "answer", "list", "--conversation", "convA"],
        );
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn malformed_context_names_and_duplicates_are_refused() {
    for body in [
        json!({}),
        json!([{"name":null}]),
        json!([{"name":"a"},{"name":"a"}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = parsed_call(t.path(), &["context", "list"]);
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn upstream_failures_have_actionable_safe_errors_and_no_retries() {
    for status in [200, 500] {
        for (args, code) in [
            (
                vec!["metadata", "answer", "list", "--conversation", "convA"],
                "metadata_read_failed",
            ),
            (vec!["context", "list"], "contexts_read_failed"),
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
            assert_eq!(v["error"]["code"], code);
            assert_eq!(v["error"]["upstream"]["status"], status);
            assert!(!v.to_string().contains("private-detail"));
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
}
#[test]
fn auth_permission_rate_and_redirect_errors_are_preserved() {
    for (status, code, exit) in [
        (401, "auth_invalid", 3),
        (403, "forbidden", 4),
        (429, "rate_limited", 6),
        (302, "redirect_refused", 1),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(status, "application/json", "{}".into())]);
        let (got, v) = parsed_call(
            t.path(),
            &["metadata", "question", "list", "--conversation", "convA"],
        );
        assert_eq!(got, exit);
        assert_eq!(v["error"]["code"], code);
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn bad_parameters_stop_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for q in ["0", "-1", "2147483648", "1&x=2"] {
        assert_eq!(
            parsed_call(
                t.path(),
                &[
                    "metadata",
                    "answer",
                    "list",
                    "--conversation",
                    "convA",
                    "--question",
                    q
                ]
            )
            .0,
            2
        );
    }
    assert_eq!(
        parsed_call(
            t.path(),
            &["metadata", "question", "list", "--conversation", "../bad"]
        )
        .0,
        2
    );
}
#[test]
fn help_schema_and_unavailable_writes_are_clear() {
    let t = tempfile::tempdir().unwrap();
    for (args, phrase) in [
        (
            vec!["help", "metadata", "question", "list"],
            "required=true",
        ),
        (
            vec!["help", "metadata", "answer", "list"],
            "not participant responses",
        ),
        (
            vec!["help", "context", "list"],
            "Private contexts are excluded",
        ),
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert!(v["data"]["help"].as_str().unwrap().contains(phrase));
    }
    for args in [
        vec!["schema", "metadata", "question", "list"],
        vec!["schema", "metadata", "answer", "list"],
        vec!["schema", "context", "list"],
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["implemented"], true);
    }
    assert_eq!(
        call(t.path(), &["metadata", "answer", "add"], None, false).0,
        2
    );
    assert_eq!(
        call(t.path(), &["metadata", "question", "delete"], None, false).0,
        2
    );
}
