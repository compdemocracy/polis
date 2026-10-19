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
fn page() -> Value {
    json!({"scope":"owner","sort":"newest","conversations":[{"conversation_id":"first","topic":"Alpha","description":null,"created":100,"modified":100,"participant_count":20,"is_active":true,"is_draft":false}],"pagination":{"limit":1,"has_more":true,"next_cursor":"next-page"}})
}
#[test]
fn owner_options_are_sent_to_server_and_cursor_is_preserved() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![json_res(page())]);
    let (exit, v) = call(
        t.path(),
        &[
            "conversation",
            "list",
            "--sort",
            "newest",
            "--min-participants",
            "10",
            "--search",
            "Alpha %_",
            "--limit",
            "1",
            "--cursor",
            "previous-page",
            "--active",
            "true",
            "--draft",
            "false",
        ],
        None,
        true,
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["pagination"]["next_cursor"], "next-page");
    assert_eq!(v["data"]["conversations"].as_array().unwrap().len(), 1);
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/v3/owner/conversations?sort=newest&limit=1&min_participants=10&search=Alpha+%25_&is_active=true&is_draft=false&cursor=previous-page HTTP/"),"{}",requests[0]);
}
#[test]
fn incompatible_or_failed_route_never_becomes_unfiltered_success() {
    for response in [
        json_res(json!([])),
        json_res(json!({"conversations":[]})),
        (404, "text/plain", "unavailable".into()),
        (
            403,
            "application/json",
            json!({"error":"private-detail"}).to_string(),
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![response]);
        let (exit, v) = call(
            t.path(),
            &["conversation", "list", "--min-participants", "5"],
            None,
            true,
        );
        assert_ne!(exit, 0, "{v}");
        assert!(v["data"].is_null());
        assert!(!v.to_string().contains("private-detail"));
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn conflicting_pagination_and_invalid_options_fail_before_http() {
    for args in [
        vec!["--sort", "oldest", "--recent"],
        vec!["--sort", "newest", "--offset", "1"],
        vec!["--sort", "newest", "--limit", "501"],
        vec!["--min-participants", "-1"],
        vec!["--sort", "participants"],
        vec!["--cursor", ""],
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut command = vec!["conversation", "list"];
        command.extend(args);
        assert_eq!(call(t.path(), &command, None, true).0, 2);
    }
}

#[test]
fn missing_owner_capability_has_documented_exit_and_plain_message() {
    for status in [404, 502] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![(status, "text/plain", "private-detail".into())],
        );
        let (exit, value) = call(
            t.path(),
            &["conversation", "list", "--sort", "newest"],
            None,
            true,
        );
        assert_eq!(exit, 8);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "capability_unavailable");
        assert_eq!(
            value["error"]["message"],
            "This site does not serve the owner-list feature."
        );
        assert_eq!(value["error"]["upstream"]["status"], status);
        assert_eq!(value["error"]["outcome"], "rejected");
        assert!(value["data"].is_null());
        assert!(!value.to_string().contains("private-detail"));
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn auth_and_server_errors_are_not_missing_capabilities() {
    for (status, exit) in [(401, 3), (403, 4), (500, 6), (503, 6)] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![(status, "text/plain", "private-detail".into())],
        );
        let (actual, value) = call(
            t.path(),
            &["conversation", "list", "--sort", "newest"],
            None,
            true,
        );
        assert_eq!(actual, exit);
        assert_ne!(value["error"]["code"], "capability_unavailable");
        assert!(value["data"].is_null());
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
