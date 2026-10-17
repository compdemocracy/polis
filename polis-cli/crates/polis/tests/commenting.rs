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
    cmd.env_remove("POLIS_TOKEN").env_remove("POLIS_SITE");
    if token {
        cmd.env("POLIS_TOKEN_LOCAL", "fixture-token");
    }
    let mut child = cmd.spawn().unwrap();
    if let Some(s) = input {
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    let o = child.wait_with_output().unwrap();
    assert!(!String::from_utf8_lossy(&o.stdout).contains(TEXT));
    assert!(!String::from_utf8_lossy(&o.stderr).contains(TEXT));
    assert!(!String::from_utf8_lossy(&o.stdout).contains("fixture-token"));
    assert!(!String::from_utf8_lossy(&o.stderr).contains("fixture-token"));
    (
        o.status.code().unwrap(),
        serde_json::from_slice(&o.stdout).unwrap(),
    )
}
fn server(
    dir: &std::path::Path,
    responses: Vec<(u16, &'static str, String)>,
) -> std::thread::JoinHandle<Vec<String>> {
    server_then(dir, responses, None)
}
fn server_then(
    dir: &std::path::Path,
    responses: Vec<(u16, &'static str, String)>,
    before_response: Option<Box<dyn Fn() + Send>>,
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
            if let Some(hook) = &before_response {
                hook();
            }
            if status == 0 {
                continue;
            }
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
fn json_res(v: Value) -> (u16, &'static str, String) {
    (200, "application/json", v.to_string())
}

const TOKEN: &str = "participant-secret-fixture";
const LOGIN: &str = "returning-secret-fixture";
fn receipt() -> Value {
    json!({"status":"ok","auth":{"token":TOKEN,"token_type":"Bearer"},"login_code":LOGIN})
}
fn private(dir: &std::path::Path) -> Vec<Value> {
    use std::os::unix::fs::PermissionsExt;
    let d = dir.join("credentials");
    assert_eq!(
        std::fs::metadata(&d).unwrap().permissions().mode() & 0o777,
        0o700
    );
    std::fs::read_dir(d)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            assert_eq!(
                std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
            (p.extension().unwrap() == "json")
                .then(|| serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap())
        })
        .collect()
}
const TEXT: &str = "private-submitted-text";
fn comment_receipt() -> Value {
    json!({"tid":0,"currentPid":0,"auth":{"token":TOKEN,"token_type":"Bearer"},"txt":TEXT})
}
#[test]
fn direct_comment_creates_identity_and_reuses_it_without_seed_or_vote() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![
            json_res(comment_receipt()),
            json_res(json!({"tid":1,"currentPid":0})),
        ],
    );
    for tid in [0, 1] {
        let (code, v) = call(d.path(), &["comment", "2demo", TEXT], None, true);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["state"], "submitted");
        assert_eq!(v["data"]["statement"], tid);
        assert_eq!(v["data"]["participant_id"], 0);
        assert!(!v.to_string().contains(TOKEN));
    }
    let rs = t.join().unwrap();
    assert!(!rs[0].to_lowercase().contains("authorization:"));
    assert!(rs[1].contains(TOKEN));
    for r in rs {
        assert!(r.starts_with("POST /api/v3/comments "));
        let body: Value = serde_json::from_str(r.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({"conversation_id":"2demo","txt":TEXT}));
    }
    assert_eq!(private(d.path())[0]["token"], TOKEN);
}
#[test]
fn invited_comment_preserves_identity_and_returning_login_secret() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![json_res(receipt()), json_res(comment_receipt())],
    );
    assert_eq!(
        call(
            d.path(),
            &["join", "2demo", "--invite", "invite"],
            None,
            false
        )
        .0,
        0
    );
    assert_eq!(
        call(d.path(), &["comment", "2demo", TEXT], None, false).0,
        0
    );
    assert!(t.join().unwrap()[1].contains(TOKEN));
    assert_eq!(private(d.path())[0]["participant_login"], LOGIN);
}
#[test]
fn malformed_comment_receipts_keep_valid_tokens_but_report_unknown() {
    for response in [
        json!({}),
        json!({"tid":0,"currentPid":0}),
        json!({"tid":TEXT,"currentPid":0,"auth":{"token":TOKEN,"token_type":"Bearer"}}),
        json!({"tid":0,"currentPid":2147483648u64,"auth":{"token":TOKEN,"token_type":"Bearer"}}),
        json!({"tid":0,"currentPid":0,"auth":{"token":TOKEN,"token_type":"Basic"}}),
    ] {
        let d = tempfile::tempdir().unwrap();
        let t = server(d.path(), vec![json_res(response.clone())]);
        let (code, v) = call(d.path(), &["comment", "2demo", TEXT], None, false);
        assert_eq!(code, 7);
        assert_eq!(v["error"]["outcome"], "unknown");
        assert!(!v.to_string().contains(TOKEN));
        assert_eq!(
            private(d.path()).len(),
            usize::from(response["auth"]["token_type"] == "Bearer")
        );
        assert_eq!(t.join().unwrap().len(), 1);
    }
}
#[test]
fn comment_errors_never_echo_body_or_correlation_header_or_retry() {
    for (status, exit) in [
        (0, 7),
        (500, 7),
        (403, 4),
        (401, 3),
        (409, 5),
        (400, 1),
        (302, 7),
    ] {
        let d = tempfile::tempdir().unwrap();
        let t = server(
            d.path(),
            vec![(
                status,
                "application/json\r\nX-Request-Id: private-submitted-text",
                json!({"error":TEXT}).to_string(),
            )],
        );
        let (code, v) = call(d.path(), &["comment", "2demo", TEXT], None, false);
        assert_eq!(code, exit, "{v}");
        assert_eq!(t.join().unwrap().len(), 1);
    }
}
#[test]
fn comment_save_failure_is_unknown_without_retry() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("credentials");
    let t = server_then(
        d.path(),
        vec![json_res(comment_receipt())],
        Some(Box::new(move || {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        })),
    );
    let (code, v) = call(d.path(), &["comment", "2demo", TEXT], None, false);
    assert_eq!(code, 7);
    assert_eq!(v["error"]["code"], "participant_credentials_not_saved");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert_eq!(t.join().unwrap().len(), 1);
}
#[test]
fn comment_unsafe_credentials_fail_before_submission() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    std::fs::write(
        d.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:1"}}"#,
    )
    .unwrap();
    let dir = d.path().join("credentials");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (code, v) = call(d.path(), &["comment", "2demo", TEXT], None, false);
    assert_eq!(code, 3);
    assert_eq!(v["error"]["code"], "credential_file_unsafe");
}
#[test]
fn human_argument_errors_do_not_echo_text() {
    let d = tempfile::tempdir().unwrap();
    for args in [
        vec!["comment", "2demo", TEXT, "extra"],
        vec!["comment", "2demo", TEXT, "--timeout", TEXT],
        vec!["comment", "2demo", TEXT, "--is-seed"],
        vec!["comment", TEXT],
        vec!["comment", "2demo", "   "],
    ] {
        for json_mode in [false, true] {
            let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
            cmd.env("POLIS_CONFIG_DIR", d.path()).args(&args);
            if json_mode {
                cmd.arg("--json");
            }
            let out = cmd.output().unwrap();
            assert_eq!(out.status.code(), Some(2));
            assert!(!String::from_utf8_lossy(&out.stdout).contains(TEXT));
            assert!(!String::from_utf8_lossy(&out.stderr).contains(TEXT));
        }
    }
}
#[test]
fn comment_discovery_and_human_receipt_omit_text() {
    let d = tempfile::tempdir().unwrap();
    let (code, v) = call(d.path(), &["schema", "comment"], None, false);
    assert_eq!(code, 0);
    assert_eq!(v["data"]["implemented"], true);
    let t = server(d.path(), vec![json_res(comment_receipt())]);
    let out = Command::new(env!("CARGO_BIN_EXE_polis"))
        .env("POLIS_CONFIG_DIR", d.path())
        .args(["comment", "2demo", TEXT])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("Submitted statement 0"));
    assert!(!text.contains(TEXT));
    assert!(!text.contains(TOKEN));
    t.join().unwrap();
}
