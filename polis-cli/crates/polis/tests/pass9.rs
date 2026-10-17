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
    json!({"pmqid":7,"key":"Exact 🐈 text","alive":true})
}
fn args(context: bool) -> Vec<&'static str> {
    if context {
        vec!["context", "create", "--name", "Exact 🐈 text"]
    } else {
        vec![
            "metadata",
            "question",
            "add",
            "--conversation",
            "convA",
            "--key",
            "Exact 🐈 text",
        ]
    }
}
#[test]
fn creates_once_and_observes_exact_receipt() {
    for context in [false, true] {
        let t = tempfile::tempdir().unwrap();
        let receipt = if context { json!({}) } else { question() };
        let row = if context {
            json!({"name":"Exact 🐈 text"})
        } else {
            question()
        };
        let s = server(
            t.path(),
            vec![json_res(receipt.clone()), json_res(json!([row.clone()]))],
        );
        let (code, v) = parsed_call(t.path(), &args(context));
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["receipt"], receipt);
        assert_eq!(v["data"]["readback_state"], "observed");
        assert_eq!(v["data"]["observed"], row);
        let req = s.join().unwrap();
        assert_eq!(req.len(), 2);
        let route = if context {
            "/api/v3/contexts"
        } else {
            "/api/v3/metadata/questions"
        };
        assert!(req[0].starts_with(&format!("POST {route} ")));
        assert!(req[0]
            .to_lowercase()
            .contains("authorization: bearer fixture-token"));
        let body: Value = serde_json::from_str(req[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            if context {
                json!({"name":"Exact 🐈 text"})
            } else {
                json!({"conversation_id":"convA","key":"Exact 🐈 text"})
            }
        );
        assert!(req[1].starts_with(&format!(
            "GET {route}{} ",
            if context {
                ""
            } else {
                "?conversation_id=convA"
            }
        )));
    }
}
#[test]
fn accepted_receipt_survives_unavailable_or_malformed_readback() {
    for context in [false, true] {
        for response in [
            (503, "application/json", "{}".into()),
            json_res(json!({})),
            (200, "text/html", "<html>login</html>".into()),
        ] {
            let t = tempfile::tempdir().unwrap();
            let receipt = if context { json!({}) } else { question() };
            let s = server(t.path(), vec![json_res(receipt.clone()), response]);
            let (code, v) = parsed_call(t.path(), &args(context));
            assert_eq!(code, 0);
            assert_eq!(v["data"]["receipt"], receipt);
            assert_eq!(v["data"]["readback_state"], "unavailable");
            assert_eq!(s.join().unwrap().len(), 2);
        }
    }
}
#[test]
fn missing_wrong_or_duplicate_readbacks_are_not_confirmation() {
    for context in [false, true] {
        for body in [
            json!([]),
            json!([{"name":"other","pmqid":8,"key":"other"}]),
            if context {
                json!([{"name":"Exact 🐈 text"},{"name":"Exact 🐈 text"}])
            } else {
                json!([question(), question()])
            },
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(
                t.path(),
                vec![
                    json_res(if context { json!({}) } else { question() }),
                    json_res(body),
                ],
            );
            let (code, v) = parsed_call(t.path(), &args(context));
            assert_eq!(code, 0);
            assert_eq!(v["data"]["readback_state"], "not_confirmed");
            s.join().unwrap();
        }
    }
}
#[test]
fn malformed_successful_write_is_unknown_not_safe_to_repeat() {
    for context in [false, true] {
        for body in [
            json!(null),
            json!([]),
            json!({"name":"unexpected","pmqid":0,"key":"wrong"}),
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(t.path(), vec![json_res(body)]);
            let (code, v) = parsed_call(t.path(), &args(context));
            assert_eq!(code, 7);
            assert_eq!(v["error"]["outcome"], "unknown");
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
}
#[test]
fn auth_permission_duplicate_rate_redirect_and_unknown_errors_do_not_retry() {
    for context in [false, true] {
        for (status, exit, outcome) in [
            (401, 3, "rejected"),
            (403, 4, "rejected"),
            (422, 1, "rejected"),
            (429, 6, "rejected"),
            (302, 7, "unknown"),
            (500, 7, "unknown"),
            (200, 7, "unknown"),
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(
                t.path(),
                vec![(
                    status,
                    "application/json",
                    json!({"error":"private-detail"}).to_string(),
                )],
            );
            let (code, v) = parsed_call(t.path(), &args(context));
            assert_eq!(code, exit, "{v}");
            assert_eq!(v["error"]["outcome"], outcome);
            assert!(!v.to_string().contains("private-detail"));
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
}
#[test]
fn exact_input_and_auth_are_checked_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for context in [false, true] {
        let too_long = "🐈".repeat(if context { 151 } else { 500 });
        for text in ["", " leading", "trailing ", "a\nb", too_long.as_str()] {
            let mut a = args(context);
            *a.last_mut().unwrap() = text;
            let (code, v) = parsed_call(t.path(), &a);
            assert_eq!(code, 2, "{v}");
            assert_eq!(v["error"]["outcome"], "not_sent");
        }
        assert_eq!(call(t.path(), &args(context), None, false).0, 3);
    }
    assert_eq!(
        parsed_call(
            t.path(),
            &[
                "metadata",
                "question",
                "add",
                "--conversation",
                "../bad",
                "--key",
                "Valid"
            ]
        )
        .0,
        2
    );
}
#[test]
fn utf16_boundary_is_accepted_without_trimming() {
    for context in [false, true] {
        let text = if context {
            "🐈".repeat(150)
        } else {
            format!("{}a", "🐈".repeat(499))
        };
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(403, "application/json", "{}".into())]);
        let mut a = args(context);
        *a.last_mut().unwrap() = &text;
        assert_eq!(parsed_call(t.path(), &a).0, 4);
        s.join().unwrap();
    }
}
#[test]
fn help_and_schema_describe_new_commands_and_boundaries() {
    let t = tempfile::tempdir().unwrap();
    for (path, phrase) in [
        (
            vec!["metadata", "question", "add"],
            "exact conversation owner",
        ),
        (vec!["context", "create"], "PUBLIC context"),
        (vec!["delphi", "statement", "export"], "No model is called"),
        (vec!["delphi", "statement", "import"], "held TopicPage"),
    ] {
        let mut a = vec!["help"];
        a.extend(path.clone());
        let (code, v) = call(t.path(), &a, None, false);
        assert_eq!(code, 0);
        assert!(v["data"]["help"].as_str().unwrap().contains(phrase));
        let mut a = vec!["schema"];
        a.extend(path);
        let (code, v) = call(t.path(), &a, None, false);
        assert_eq!(code, 0);
        assert_eq!(v["data"]["implemented"], true);
    }
}
