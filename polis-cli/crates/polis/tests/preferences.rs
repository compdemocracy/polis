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
fn args(value: &str) -> Vec<&str> {
    vec![
        "participant",
        "preferences",
        "--conversation",
        "convA",
        "--translations",
        value,
    ]
}
#[test]
fn sends_exact_boolean_once_and_acknowledges_without_persistence_claim() {
    for value in ["true", "false"] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!([]))]);
        let (code, v) = call(t.path(), &args(value), None, true);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["state"], "acknowledged");
        assert_eq!(v["data"]["persistence"], "unverified");
        assert!(v["data"]["affected_rows"].is_null());
        assert_eq!(v["data"]["receipt"], json!([]));
        assert_eq!(
            v["data"]["requested"]["show_translation_activated"],
            value == "true"
        );
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("PUT /api/v3/participants_extended HTTP/"));
        assert!(requests[0]
            .to_lowercase()
            .contains("authorization: bearer fixture-token"));
        let body: Value =
            serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"conversation_id":"convA","show_translation_activated":value == "true"})
        );
    }
}
#[test]
fn rejects_missing_ambiguous_booleans_and_other_account_targets_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for value in ["", "TRUE", "False", "1", "0", "yes", "null"] {
        assert_eq!(call(t.path(), &args(value), None, true).0, 2);
    }
    for id in ["", "../bad", "bad id", "a?b", "🐈"] {
        let mut a = args("true");
        a[3] = id;
        assert_eq!(call(t.path(), &a, None, true).0, 2);
    }
    assert_eq!(call(t.path(), &args("true")[..4], None, true).0, 2);
    for target in ["--pid", "--uid", "--xid"] {
        let mut a = args("true");
        a.extend([target, "7"]);
        assert_eq!(call(t.path(), &a, None, true).0, 2);
    }
}
#[test]
fn no_credentials_means_no_write() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let (code, v) = call(t.path(), &args("true"), None, false);
    assert_eq!(code, 3);
    assert_eq!(v["error"]["code"], "auth_required");
}
#[test]
fn incompatible_receipts_are_unknown_not_success_or_retryable() {
    for value in [
        json!({}),
        json!(null),
        json!([{}]),
        json!([{"show_translation_activated":true}]),
        json!(true),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(value)]);
        let (code, v) = call(t.path(), &args("true"), None, true);
        assert_eq!(code, 7, "{v}");
        assert_eq!(v["error"]["code"], "participant_preference_outcome_unknown");
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn malformed_protocol_and_oversized_body_are_unknown() {
    for response in [
        (200, "text/html", "<html>login</html>".into()),
        (200, "application/json", "{".into()),
        (202, "application/json", "[]".into()),
        (204, "application/json", "".into()),
        (200, "application/json", " ".repeat(8388609)),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![response]);
        let (code, v) = call(t.path(), &args("false"), None, true);
        assert_eq!(code, 7, "{v}");
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(v["error"]["code"], "participant_preference_outcome_unknown");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn authorization_and_unknown_write_failures_stay_private_and_never_retry() {
    for (status, exit, expected, outcome) in [
        (401, 3, "auth_invalid", "rejected"),
        (403, 4, "forbidden", "rejected"),
        (404, 1, "operation_failed", "rejected"),
        (429, 6, "rate_limited", "rejected"),
        (302, 1, "redirect_refused", "rejected"),
        (500, 7, "participant_preference_outcome_unknown", "unknown"),
        (200, 7, "participant_preference_outcome_unknown", "unknown"),
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
        let (code, v) = call(t.path(), &args("true"), None, true);
        assert_eq!(code, exit, "{v}");
        assert_eq!(v["error"]["code"], expected);
        assert_eq!(v["error"]["outcome"], outcome);
        assert!(!v.to_string().contains("private-detail"));
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn named_legacy_failure_has_preference_recovery() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            500,
            "application/json",
            r#"{"error":"polis_err_put_participants_extended"}"#.into(),
        )],
    );
    let (code, v) = call(t.path(), &args("true"), None, true);
    assert_eq!(code, 7, "{v}");
    assert_eq!(v["error"]["code"], "participant_preference_outcome_unknown");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert!(v["error"]["action"]
        .as_str()
        .unwrap()
        .contains("site operator"));
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn disconnected_response_is_unknown_without_retry() {
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(t.path().join("profiles.json"),json!({"default":"local","sites":{"local":format!("http://{}",listener.local_addr().unwrap())}}).to_string()).unwrap();
    let s = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut b = [0; 4096];
        assert!(stream.read(&mut b).unwrap() > 0);
    });
    let (code, v) = call(t.path(), &args("true"), None, true);
    assert_eq!(code, 7, "{v}");
    assert_eq!(v["error"]["code"], "participant_preference_outcome_unknown");
    assert_eq!(v["error"]["outcome"], "unknown");
    s.join().unwrap();
}
#[test]
fn focused_help_and_schema_explain_acknowledgement_limits() {
    let t = tempfile::tempdir().unwrap();
    let (code, v) = call(
        t.path(),
        &["help", "participant", "preferences"],
        None,
        false,
    );
    assert_eq!(code, 0);
    let help = v["data"]["help"].as_str().unwrap();
    for text in [
        "empty array",
        "affected_rows=null",
        "persistence=unverified",
        "no automatic retry",
        "no participant ID",
        "8 MiB",
    ] {
        assert!(help.contains(text), "{text}");
    }
    assert_eq!(
        call(
            t.path(),
            &["schema", "participant", "preferences"],
            None,
            false
        )
        .1["data"]["implemented"],
        true
    );
    assert_eq!(
        call(t.path(), &["participant", "highlight", "set"], None, false).0,
        2
    );
}
