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
    json!({"pmqid":7,"key":"Exact question","alive":true,"required":true})
}
fn answer() -> Value {
    json!({"pmqid":7,"pmaid":9,"value":"Exact 🐈 option","alive":true,"is_exclusive":true})
}
fn args() -> Vec<&'static str> {
    vec![
        "metadata",
        "answer",
        "add",
        "--conversation",
        "convA",
        "--question",
        "7",
        "--value",
        "Exact 🐈 option",
        "--yes",
    ]
}
fn preflight() -> Vec<(u16, &'static str, String)> {
    vec![json_res(json!([question()])), json_res(json!([]))]
}
#[test]
fn exact_create_or_reactivate_has_one_post_and_bound_readback() {
    let t = tempfile::tempdir().unwrap();
    let mut r = preflight();
    let mut receipt = answer();
    receipt.as_object_mut().unwrap().remove("is_exclusive");
    r.extend([
        json_res(receipt.clone()),
        json_res(json!([question()])),
        json_res(json!([answer()])),
    ]);
    let s = server(t.path(), r);
    let (code, v) = parsed_call(t.path(), &args());
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"]["receipt"], receipt);
    assert_eq!(v["data"]["readback_state"], "observed");
    assert_eq!(v["data"]["observed"], answer());
    assert_eq!(v["data"]["preflight_question"], question());
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 5);
    assert!(requests[0].starts_with("GET /api/v3/metadata/questions?conversation_id=convA "));
    assert!(requests[1].starts_with("GET /api/v3/metadata/answers?conversation_id=convA "));
    assert!(requests[2].starts_with("POST /api/v3/metadata/answers "));
    let body: Value = serde_json::from_str(requests[2].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"conversation_id":"convA","pmqid":7,"value":"Exact 🐈 option"})
    );
    assert!(requests.iter().all(|r| r
        .to_lowercase()
        .contains("authorization: bearer fixture-token")));
    assert_eq!(
        requests.iter().filter(|r| r.starts_with("POST ")).count(),
        1
    );
}
#[test]
fn absent_or_other_conversation_question_sends_no_post() {
    for q in [
        json!([]),
        json!([{ "pmqid":8,"key":"Other","required":true,"alive":true}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(q)]);
        let (code, v) = parsed_call(t.path(), &args());
        assert_eq!(code, 5);
        assert_eq!(v["error"]["outcome"], "not_sent");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn active_exact_duplicate_refused_but_other_question_does_not_collide() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(json!([question()])), json_res(json!([answer()]))],
    );
    let (code, v) = parsed_call(t.path(), &args());
    assert_eq!(code, 5);
    assert_eq!(v["error"]["code"], "metadata_option_exists");
    assert_eq!(s.join().unwrap().len(), 2);
    let t = tempfile::tempdir().unwrap();
    let mut other = answer();
    other["pmqid"] = json!(8);
    let s = server(
        t.path(),
        vec![
            json_res(json!([question()])),
            json_res(json!([other])),
            json_res(answer()),
            json_res(json!([question()])),
            json_res(json!([answer()])),
        ],
    );
    assert_eq!(parsed_call(t.path(), &args()).0, 0);
    assert_eq!(s.join().unwrap().len(), 5);
}
#[test]
fn malformed_preflight_and_duplicate_ids_fail_closed() {
    for q in [
        json!({}),
        json!([question(), question()]),
        json!([{ "pmqid":7,"alive":false}]),
        json!([{ "pmqid":0}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(q)]);
        assert_eq!(parsed_call(t.path(), &args()).0, 1);
        assert_eq!(s.join().unwrap().len(), 1);
    }
    for a in [
        json!({}),
        json!([answer(), answer()]),
        json!([{ "pmqid":7,"pmaid":9,"alive":false}]),
        json!([{ "pmqid":7,"pmaid":0}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!([question()])), json_res(a)]);
        assert_eq!(parsed_call(t.path(), &args()).0, 1);
        assert_eq!(s.join().unwrap().len(), 2);
    }
}
#[test]
fn confirmation_auth_ids_and_text_checked_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let mut a = args();
    a.pop();
    assert_eq!(parsed_call(t.path(), &a).0, 2);
    assert_eq!(call(t.path(), &args(), None, false).0, 3);
    for id in ["0", "2147483648", "abc"] {
        let mut a = args();
        a[6] = id;
        assert_eq!(parsed_call(t.path(), &a).0, 2);
    }
    let mut a = args();
    a[4] = "../bad";
    assert_eq!(parsed_call(t.path(), &a).0, 2);
    for text in [
        "".to_string(),
        " x".into(),
        "x ".into(),
        "a\nb".into(),
        "a\tb".into(),
        "🐈".repeat(500),
    ] {
        let mut a = args();
        a[8] = &text;
        assert_eq!(parsed_call(t.path(), &a).0, 2);
    }
}
#[test]
fn exact_utf16_boundary_is_sent_without_trimming() {
    let t = tempfile::tempdir().unwrap();
    let text = format!("{}a", "🐈".repeat(499));
    let mut a = args();
    a[8] = &text;
    let mut row = answer();
    row["value"] = json!(text);
    let mut r = preflight();
    r.extend([
        json_res(row.clone()),
        json_res(json!([question()])),
        json_res(json!([row])),
    ]);
    let s = server(t.path(), r);
    assert_eq!(parsed_call(t.path(), &a).0, 0);
    let req = s.join().unwrap();
    let body: Value = serde_json::from_str(req[2].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["value"], text);
}
#[test]
fn malformed_or_mismatched_receipt_is_unknown() {
    let mut wrong_question = answer();
    wrong_question["pmqid"] = json!(8);
    let mut wrong_value = answer();
    wrong_value["value"] = json!("Other");
    let mut dead = answer();
    dead["alive"] = json!(false);
    let mut bad_id = answer();
    bad_id["pmaid"] = json!(0);
    for receipt in [
        json!(null),
        json!([]),
        json!({}),
        wrong_question,
        wrong_value,
        dead,
        bad_id,
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut r = preflight();
        r.push(json_res(receipt));
        let s = server(t.path(), r);
        let (code, v) = parsed_call(t.path(), &args());
        assert_eq!(code, 7);
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(s.join().unwrap().len(), 3);
    }
}
#[test]
fn accepted_receipt_survives_failed_or_malformed_readback() {
    for response in [
        (503, "application/json", "{}".into()),
        json_res(json!({})),
        (200, "text/html", "<html>login</html>".into()),
        json_res(json!([question(), question()])),
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut r = preflight();
        r.extend([json_res(answer()), response]);
        let s = server(t.path(), r);
        let (code, v) = parsed_call(t.path(), &args());
        assert_eq!(code, 0);
        assert_eq!(v["data"]["receipt"], answer());
        assert_eq!(v["data"]["readback_state"], "unavailable");
        assert_eq!(s.join().unwrap().len(), 4);
    }
    let t = tempfile::tempdir().unwrap();
    let mut r = preflight();
    r.extend([
        json_res(answer()),
        json_res(json!([question()])),
        json_res(json!([answer(), answer()])),
    ]);
    let s = server(t.path(), r);
    assert_eq!(
        parsed_call(t.path(), &args()).1["data"]["readback_state"],
        "unavailable"
    );
    assert_eq!(s.join().unwrap().len(), 5);
}
#[test]
fn concurrently_deleted_question_or_changed_option_is_not_confirmed() {
    for (q, a) in [
        (json!([]), json!([answer()])),
        (json!([question()]), json!([])),
        (
            json!([question()]),
            json!([{ "pmqid":8,"pmaid":9,"value":"Exact 🐈 option","alive":true,"is_exclusive":true}]),
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut r = preflight();
        r.extend([json_res(answer()), json_res(q), json_res(a)]);
        let s = server(t.path(), r);
        let (code, v) = parsed_call(t.path(), &args());
        assert_eq!(code, 0);
        assert_eq!(v["data"]["readback_state"], "not_confirmed");
        assert_eq!(v["data"]["observed"], Value::Null);
        assert_eq!(s.join().unwrap().len(), 5);
    }
}
#[test]
fn upstream_failures_keep_conservative_outcome_without_retry() {
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
        let (exit, v) = parsed_call(t.path(), &args());
        assert_eq!(exit, code, "{v}");
        assert_eq!(v["error"]["outcome"], outcome);
        assert!(!v.to_string().contains("private-detail"));
        assert_eq!(s.join().unwrap().len(), 3);
    }
}
#[test]
fn help_schema_describe_creation_reactivation_and_limits() {
    let t = tempfile::tempdir().unwrap();
    let (code, v) = call(
        t.path(),
        &["help", "metadata", "answer", "add"],
        None,
        false,
    );
    assert_eq!(code, 0);
    let h = v["data"]["help"].as_str().unwrap();
    for phrase in [
        "--yes",
        "reactivate",
        "exact conversation owner",
        "participant response",
        "not a server authorization boundary",
        "No automatic retry",
    ] {
        assert!(h.contains(phrase), "{phrase}");
    }
    assert_eq!(
        call(
            t.path(),
            &["schema", "metadata", "answer", "add"],
            None,
            false
        )
        .1["data"]["implemented"],
        true
    );
}
