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
fn args() -> Vec<&'static str> {
    vec!["conversation", "reserve"]
}
#[test]
fn allocation_is_one_post_with_no_creation_or_ownership_claim() {
    let t = tempfile::tempdir().unwrap();
    let receipt = json!({"conversation_id":"2abcdefghi", "extension":"kept"});
    let s = server(t.path(), vec![json_res(receipt.clone())]);
    let (code, v) = call(t.path(), &args(), None, true);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"]["state"], "allocated");
    assert_eq!(v["data"]["conversation_id"], "2abcdefghi");
    assert_eq!(v["data"]["receipt"], receipt);
    assert_eq!(v["data"]["conversation_created"], false);
    assert_eq!(v["data"]["owner_bound"], false);
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /api/v3/reserve_conversation_id HTTP/"));
    assert!(requests[0]
        .to_lowercase()
        .contains("authorization: bearer fixture-token"));
    let body: Value = serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body, json!({}));
}
#[test]
fn unknown_arguments_and_target_injection_rejected_before_network() {
    let t = tempfile::tempdir().unwrap();
    for flag in ["--conversation", "--uid", "--topic", "--short-url", "--id"] {
        let mut a = args();
        a.extend([flag, "anything"]);
        assert_eq!(call(t.path(), &a, None, true).0, 2);
    }
}
#[test]
fn no_credentials_means_no_allocation() {
    let t = tempfile::tempdir().unwrap();
    let (code, v) = call(t.path(), &args(), None, false);
    assert_eq!(code, 3, "{v}");
    assert_eq!(v["error"]["code"], "auth_required");
}
#[test]
fn invalid_receipt_cannot_claim_no_allocation() {
    let mut receipts = vec![
        json!({}),
        json!(null),
        json!([]),
        json!(true),
        json!({"conversation_id":17}),
    ];
    for id in [
        "",
        "2abcde",
        "2abcdefghij",
        "1abcdefghi",
        "2Abcdefghi",
        "2abc/efghi",
        "2abc efghi",
        "2abc?efghi",
        "2abcdéghi",
        "2abc\nefghi",
    ] {
        receipts.push(json!({"conversation_id":id}));
    }
    for receipt in receipts {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(receipt)]);
        let (code, v) = call(t.path(), &args(), None, true);
        assert_eq!(code, 7, "{v}");
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(
            v["error"]["code"],
            "conversation_reservation_outcome_unknown"
        );
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn malformed_protocol_and_oversize_are_unknown() {
    for response in [
        (200, "text/html", "<html>login</html>".into()),
        (200, "application/json", "{".into()),
        (
            202,
            "application/json",
            r#"{"conversation_id":"2abcdefghi"}"#.into(),
        ),
        (204, "application/json", "".into()),
        (200, "application/json", " ".repeat(8388609)),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![response]);
        let (code, v) = call(t.path(), &args(), None, true);
        assert_eq!(code, 7, "{v}");
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(
            v["error"]["code"],
            "conversation_reservation_outcome_unknown"
        );
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn server_rejections_and_uncertain_failure_remain_distinct_and_private() {
    for (status, exit, code, outcome) in [
        (401, 3, "auth_invalid", "rejected"),
        (403, 4, "forbidden", "rejected"),
        (404, 1, "operation_failed", "rejected"),
        (429, 6, "rate_limited", "rejected"),
        (302, 1, "redirect_refused", "rejected"),
        (
            500,
            7,
            "conversation_reservation_outcome_unknown",
            "unknown",
        ),
        (
            200,
            7,
            "conversation_reservation_outcome_unknown",
            "unknown",
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![(
                status,
                "application/json",
                r#"{"error":"private-detail"}"#.into(),
            )],
        );
        let (actual, v) = call(t.path(), &args(), None, true);
        assert_eq!(actual, exit, "{v}");
        assert_eq!(v["error"]["code"], code);
        assert_eq!(v["error"]["outcome"], outcome);
        assert!(!v.to_string().contains("private-detail"));
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn named_server_error_has_reservation_specific_recovery() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            500,
            "application/json",
            r#"{"error":"polis_err_reserve_conversation_id"}"#.into(),
        )],
    );
    let (code, v) = call(t.path(), &args(), None, true);
    assert_eq!(code, 7, "{v}");
    assert_eq!(
        v["error"]["code"],
        "conversation_reservation_outcome_unknown"
    );
    assert!(v["error"]["action"]
        .as_str()
        .unwrap()
        .contains("site operator"));
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn lost_reply_is_unknown_without_automatic_retry() {
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(t.path().join("profiles.json"),json!({"default":"local","sites":{"local":format!("http://{}",listener.local_addr().unwrap())}}).to_string()).unwrap();
    let s = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut b = [0; 4096];
        assert!(stream.read(&mut b).unwrap() > 0);
    });
    let (code, v) = call(t.path(), &args(), None, true);
    assert_eq!(code, 7, "{v}");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert_eq!(
        v["error"]["code"],
        "conversation_reservation_outcome_unknown"
    );
    s.join().unwrap();
}
#[test]
fn help_and_schema_state_allocation_limits() {
    let t = tempfile::tempdir().unwrap();
    let (code, v) = call(t.path(), &["help", "conversation", "reserve"], None, false);
    assert_eq!(code, 0);
    let help = v["data"]["help"].as_str().unwrap();
    for text in [
        "no owner is bound",
        "no automatic retry",
        "no conversation is created",
        "8 MiB",
        "idempotency",
        "does not yet accept",
    ] {
        assert!(help.contains(text), "{text}");
    }
    assert_eq!(
        call(
            t.path(),
            &["schema", "conversation", "reserve"],
            None,
            false
        )
        .1["data"]["implemented"],
        true
    );
}
