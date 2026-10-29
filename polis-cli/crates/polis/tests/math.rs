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
    vec!["math", "view", "--conversation", "convA"]
}
#[test]
fn whole_public_read_preserves_presentation_and_sends_no_conditionals() {
    let t = tempfile::tempdir().unwrap();
    let value =
        json!({"math_tick":0,"pca":{"center":[0.125,-0.25]},"future":{"opaque":true},"tids":[0,2]});
    let s = server(t.path(), vec![json_res(value.clone())]);
    let (code, v) = call(t.path(), &args(), None, false);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"], value);
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/v3/math/pca2?conversation_id=convA "));
    for forbidden in ["authorization:", "if-none-match:", "math_tick=", "POST "] {
        assert!(!requests[0]
            .to_ascii_lowercase()
            .contains(&forbidden.to_ascii_lowercase()));
    }
}
#[test]
fn selected_keys_are_encoded_and_unknown_keys_may_be_absent() {
    for value in [json!({"math_tick":42,"pca":{"comps":[]}}), json!({})] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(value.clone())]);
        let mut a = args();
        a.extend(["--key", "math_tick", "--key", "pca", "--key", "missing-key"]);
        let (code, v) = call(t.path(), &a, None, true);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"], value);
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with(
            "GET /api/v3/math/pca2?conversation_id=convA&keys=math_tick%2Cpca%2Cmissing-key "
        ));
        assert!(requests[0]
            .to_lowercase()
            .contains("authorization: bearer fixture-token"));
    }
}
#[test]
fn malformed_whole_math_and_unsafe_ticks_are_rejected() {
    for value in [
        json!([]),
        json!(null),
        json!({}),
        json!({"math_tick":-2}),
        json!({"math_tick":0.5}),
        json!({"math_tick":"0"}),
        json!({"math_tick":9007199254740992_u64}),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(value)]);
        let (code, v) = call(t.path(), &args(), None, false);
        assert_eq!(code, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn subsets_must_only_contain_requested_fields_and_valid_ticks() {
    for value in [
        json!({"extra":true}),
        json!({"pca":{},"math_tick":3}),
        json!([]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(value)]);
        let mut a = args();
        a.extend(["--key", "pca"]);
        assert_eq!(call(t.path(), &a, None, false).0, 1);
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn invalid_ids_keys_duplicates_and_excess_keys_never_reach_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for key in ["", "pca,tids", "pca.center", "bad key", "a\nb", "🐈"] {
        let mut a = args();
        a.extend(["--key", key]);
        assert_eq!(call(t.path(), &a, None, false).0, 2);
    }
    let long = "x".repeat(101);
    let mut a = args();
    a.extend(["--key", &long]);
    assert_eq!(call(t.path(), &a, None, false).0, 2);
    let mut a = args();
    a[3] = "../bad";
    assert_eq!(call(t.path(), &a, None, false).0, 2);
    let mut a = args();
    a.extend(["--key", "pca", "--key", "pca"]);
    assert_eq!(call(t.path(), &a, None, false).0, 2);
    let keys: Vec<_> = (0..33).map(|n| format!("key{n}")).collect();
    let mut a = args();
    for k in &keys {
        a.extend(["--key", k]);
    }
    assert_eq!(call(t.path(), &a, None, false).0, 2);
}
#[test]
fn key_count_and_length_boundaries_succeed() {
    let keys: Vec<_> = (0..32)
        .map(|n| format!("k{n}_{}", "a".repeat(if n < 10 { 97 } else { 96 })))
        .collect();
    assert!(keys.iter().all(|k| k.len() == 100));
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![json_res(json!({}))]);
    let mut a = args();
    for k in &keys {
        a.extend(["--key", k]);
    }
    assert_eq!(call(t.path(), &a, None, false).0, 0);
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn read_errors_are_actionable_and_never_retried() {
    for (status, exit, expected) in [
        (304, 1, "math_unavailable"),
        (403, 4, "forbidden"),
        (404, 1, "operation_failed"),
        (429, 6, "rate_limited"),
        (302, 1, "redirect_refused"),
        (500, 6, "math_read_failed"),
        (200, 1, "operation_failed"),
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
        let (code, v) = call(t.path(), &args(), None, false);
        assert_eq!(code, exit, "{v}");
        assert_eq!(v["error"]["code"], expected);
        assert!(!v.to_string().contains("private-detail"));
        assert_eq!(s.join().unwrap().len(), 1);
        if status == 304 {
            assert!(v["error"]["action"]
                .as_str()
                .unwrap()
                .contains("No conditional request"));
        }
    }
}
#[test]
fn non_json_and_non_200_success_are_rejected() {
    for response in [
        (200, "text/html", "<html>login</html>".into()),
        (200, "application/json", "{".into()),
        (202, "application/json", r#"{"math_tick":0}"#.into()),
        (204, "application/json", "".into()),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![response]);
        assert_eq!(call(t.path(), &args(), None, false).0, 1);
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn help_and_schema_explain_presentation_limits_and_no_work() {
    let t = tempfile::tempdir().unwrap();
    let (code, v) = call(t.path(), &["help", "math", "view"], None, false);
    assert_eq!(code, 0);
    let h = v["data"]["help"].as_str().unwrap();
    for word in [
        "Public read",
        "synthesize",
        "8 MiB",
        "304",
        "float roundoff",
        "No automatic retry",
        "--key",
    ] {
        assert!(h.contains(word), "{word}");
    }
    assert_eq!(
        call(t.path(), &["schema", "math", "view"], None, false).1["data"]["implemented"],
        true
    );
}
