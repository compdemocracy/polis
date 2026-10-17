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
    json!({"pmqid":7,"key":"Keep exact 🐈 text","alive":true,"required":true})
}
fn answer() -> Value {
    json!({"pmqid":7,"pmaid":9,"value":"Exact option","alive":true,"is_exclusive":true})
}
fn args(option: bool) -> Vec<&'static str> {
    let mut a = vec![
        "metadata",
        if option { "answer" } else { "question" },
        "delete",
        "--conversation",
        "convA",
        "--question",
        "7",
        "--yes",
    ];
    if option {
        a.extend(["--answer", "9"]);
    }
    a
}
fn preflight() -> Vec<(u16, &'static str, String)> {
    vec![json_res(json!([question()])), json_res(json!([answer()]))]
}
#[test]
fn exact_target_deleted_once_and_absence_observed() {
    for option in [false, true] {
        let t = tempfile::tempdir().unwrap();
        let mut responses = preflight();
        responses.push(json_res(json!({"success":true})));
        if !option {
            responses.push(json_res(json!([])));
        }
        responses.push(json_res(json!([])));
        let s = server(t.path(), responses);
        let (code, v) = parsed_call(t.path(), &args(option));
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["state"], "accepted");
        assert_eq!(v["data"]["readback_state"], "observed");
        assert_eq!(
            v["data"]["preflight_target"],
            if option { answer() } else { question() }
        );
        assert_eq!(v["data"]["preflight_answer_options"], json!([answer()]));
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), if option { 4 } else { 5 });
        assert!(requests[0].starts_with("GET /api/v3/metadata/questions?conversation_id=convA "));
        assert!(requests[1].starts_with("GET /api/v3/metadata/answers?conversation_id=convA "));
        assert!(requests[2].starts_with(if option {
            "DELETE /api/v3/metadata/answers/9 "
        } else {
            "DELETE /api/v3/metadata/questions/7 "
        }));
        assert_eq!(
            requests.iter().filter(|r| r.starts_with("DELETE ")).count(),
            1
        );
        assert!(requests.iter().all(|r| r
            .to_lowercase()
            .contains("authorization: bearer fixture-token")));
    }
}
#[test]
fn missing_or_cross_conversation_question_sends_no_delete() {
    for option in [false, true] {
        for body in [
            json!([]),
            json!([{ "pmqid":8,"key":"Other","alive":true,"required":true}]),
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(t.path(), vec![json_res(body)]);
            let (code, v) = parsed_call(t.path(), &args(option));
            assert_eq!(code, 5, "{v}");
            assert_eq!(v["error"]["outcome"], "not_sent");
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
}
#[test]
fn missing_or_wrong_question_option_sends_no_delete() {
    for body in [
        json!([]),
        json!([{"pmqid":8,"pmaid":9,"value":"other","alive":true,"is_exclusive":true}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(json!([question()])), json_res(body)],
        );
        assert_eq!(parsed_call(t.path(), &args(true)).0, 5);
        assert_eq!(s.join().unwrap().len(), 2);
    }
}
#[test]
fn malformed_duplicate_or_inactive_preflight_sends_no_delete() {
    for option in [false, true] {
        for bad in [
            json!({}),
            json!([question(), question()]),
            json!([{"pmqid":7,"alive":false}]),
            json!([{"pmqid":0}]),
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(t.path(), vec![json_res(bad)]);
            assert_eq!(parsed_call(t.path(), &args(option)).0, 1);
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
    for bad in [
        json!({}),
        json!([answer(), answer()]),
        json!([{"pmqid":7,"pmaid":9,"alive":false}]),
        json!([{"pmqid":7,"pmaid":0}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!([question()])), json_res(bad)]);
        assert_eq!(parsed_call(t.path(), &args(true)).0, 1);
        assert_eq!(s.join().unwrap().len(), 2);
    }
}
#[test]
fn confirmation_identifiers_and_auth_checked_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for option in [false, true] {
        let mut a = args(option);
        a.retain(|x| *x != "--yes");
        assert_eq!(parsed_call(t.path(), &a).0, 2);
        assert_eq!(call(t.path(), &args(option), None, false).0, 3);
        for id in ["0", "2147483648", "abc"] {
            let mut a = args(option);
            a[6] = id;
            assert_eq!(parsed_call(t.path(), &a).0, 2);
        }
        let mut a = args(option);
        a[4] = "../bad";
        assert_eq!(parsed_call(t.path(), &a).0, 2);
    }
}
#[test]
fn accepted_receipt_survives_readback_errors_and_malformed_rows() {
    for option in [false, true] {
        for response in [
            (503, "application/json", "{}".into()),
            json_res(json!({})),
            (200, "text/html", "<html>login</html>".into()),
            json_res(json!([answer(), answer()])),
        ] {
            let t = tempfile::tempdir().unwrap();
            let mut r = preflight();
            r.push(json_res(json!({"success":true})));
            r.push(response);
            let s = server(t.path(), r);
            let (code, v) = parsed_call(t.path(), &args(option));
            assert_eq!(code, 0, "{v}");
            assert_eq!(v["data"]["receipt"], json!({"success":true}));
            assert_eq!(v["data"]["readback_state"], "unavailable");
            assert_eq!(s.join().unwrap().len(), 4);
        }
    }
}
#[test]
fn concurrent_or_partial_cascade_is_not_confirmation() {
    for option in [false, true] {
        let t = tempfile::tempdir().unwrap();
        let mut r = preflight();
        r.push(json_res(json!({"success":true})));
        if !option {
            r.push(json_res(json!([])));
        }
        r.push(json_res(json!([answer()])));
        let s = server(t.path(), r);
        let (code, v) = parsed_call(t.path(), &args(option));
        assert_eq!(code, 0);
        assert_eq!(v["data"]["readback_state"], "not_confirmed");
        s.join().unwrap();
    }
    let t = tempfile::tempdir().unwrap();
    let mut r = preflight();
    r.extend([
        json_res(json!({"success":true})),
        json_res(json!([question()])),
        json_res(json!([])),
    ]);
    let s = server(t.path(), r);
    assert_eq!(
        parsed_call(t.path(), &args(false)).1["data"]["readback_state"],
        "not_confirmed"
    );
    s.join().unwrap();
}
#[test]
fn malformed_delete_success_is_unknown_and_never_retried() {
    for option in [false, true] {
        for body in [
            json!(null),
            json!([]),
            json!({}),
            json!({"success":false}),
            json!({"success":"true"}),
        ] {
            let t = tempfile::tempdir().unwrap();
            let mut r = preflight();
            r.push(json_res(body));
            let s = server(t.path(), r);
            let (code, v) = parsed_call(t.path(), &args(option));
            assert_eq!(code, 7);
            assert_eq!(v["error"]["outcome"], "unknown");
            assert_eq!(s.join().unwrap().len(), 3);
        }
    }
}
#[test]
fn upstream_write_errors_preserve_outcome_and_never_retry() {
    for option in [false, true] {
        for (status, code, outcome) in [
            (401, 3, "rejected"),
            (403, 4, "rejected"),
            (422, 1, "rejected"),
            (429, 6, "rejected"),
            (302, 7, "unknown"),
            (500, 7, "unknown"),
            (200, 7, "unknown"),
        ] {
            let t = tempfile::tempdir().unwrap();
            let mut r = preflight();
            r.push((
                status,
                "application/json",
                json!({"error":"private-detail"}).to_string(),
            ));
            let s = server(t.path(), r);
            let (exit, v) = parsed_call(t.path(), &args(option));
            assert_eq!(exit, code, "{v}");
            assert_eq!(v["error"]["outcome"], outcome);
            assert!(!v.to_string().contains("private-detail"));
            assert_eq!(s.join().unwrap().len(), 3);
        }
    }
}
#[test]
fn help_schema_and_root_show_cleanup_and_limits() {
    let t = tempfile::tempdir().unwrap();
    for kind in ["question", "answer"] {
        let (code, v) = call(t.path(), &["help", "metadata", kind, "delete"], None, false);
        assert_eq!(code, 0);
        let h = v["data"]["help"].as_str().unwrap();
        for phrase in [
            "--yes",
            "non-atomic",
            "No compare-and-set",
            "participant responses",
            "exact conversation owner",
        ] {
            assert!(h.contains(phrase), "{phrase}");
        }
        assert_eq!(
            call(
                t.path(),
                &["schema", "metadata", kind, "delete"],
                None,
                false
            )
            .1["data"]["implemented"],
            true
        );
    }
}
