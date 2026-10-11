use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{symlink, PermissionsExt},
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
    responses: Vec<(u16, Value)>,
) -> std::thread::JoinHandle<Vec<String>> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::fs::write(dir.join("profiles.json"),json!({"default":"local","sites":{"local":format!("http://{}",listener.local_addr().unwrap())}}).to_string()).unwrap();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
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
            let body = body.to_string();
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
fn credential(dir: &std::path::Path) -> std::path::PathBuf {
    std::fs::read_dir(dir.join("credentials"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "json"))
        .unwrap()
}
#[test]
fn file_credentials_roundtrip_logout_and_permissions() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![(200, json!({})), (200, json!({}))]);
    let (exit, v) = call(
        t.path(),
        &["auth", "login", "--token-stdin"],
        Some("fixture-token\n"),
        false,
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["storage"], "owner-only file (0600)");
    let file = credential(t.path());
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(t.path().join("credentials"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(call(t.path(), &["auth", "status"], None, false).0, 0);
    assert_eq!(call(t.path(), &["auth", "logout"], None, false).0, 0);
    assert_eq!(call(t.path(), &["auth", "status"], None, false).0, 3);
    assert!(!std::fs::read_to_string(file)
        .unwrap()
        .contains("fixture-token"));
    assert_eq!(s.join().unwrap().len(), 2);
}
#[test]
fn unsafe_file_directory_and_origin_binding_are_refused() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![(200, json!({}))]);
    assert_eq!(
        call(
            t.path(),
            &["auth", "login", "--token-stdin"],
            Some("fixture-token"),
            false
        )
        .0,
        0
    );
    s.join().unwrap();
    let file = credential(t.path());
    let original = std::fs::read(&file).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        call(t.path(), &["auth", "status"], None, false).1["error"]["code"],
        "credential_file_unsafe"
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut value: Value = serde_json::from_slice(&original).unwrap();
    value["origin"] = json!("https://another.invalid/");
    std::fs::write(&file, value.to_string()).unwrap();
    assert_eq!(
        call(t.path(), &["auth", "status"], None, false).1["error"]["code"],
        "credential_file_unsafe"
    );
    std::fs::remove_file(&file).unwrap();
    let target = t.path().join("target");
    std::fs::write(&target, original).unwrap();
    symlink(&target, &file).unwrap();
    assert_eq!(
        call(t.path(), &["auth", "status"], None, false).1["error"]["code"],
        "credential_file_unsafe"
    );
    assert_eq!(call(t.path(), &["auth", "logout"], None, false).0, 3);
    std::fs::remove_file(&file).unwrap();
    std::fs::set_permissions(
        t.path().join("credentials"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert_eq!(
        call(t.path(), &["auth", "status"], None, false).1["error"]["code"],
        "credential_file_unsafe"
    );
}
#[test]
fn moderation_preserves_metadata_and_surfaces_uncertain_write() {
    for (operation, status, exit) in [("accept", 200, 0), ("reject", 200, 0), ("reject", 503, 7)] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![
                (
                    200,
                    json!([{"tid":8,"active":false,"is_meta":true,"velocity":0.25}]),
                ),
                (status, json!({})),
            ],
        );
        let (code, v) = call(
            t.path(),
            &[
                "moderate",
                operation,
                "--conversation",
                "generated",
                "--tid",
                "8",
            ],
            None,
            true,
        );
        assert_eq!(code, exit);
        if exit == 7 {
            assert_eq!(v["error"]["outcome"], "unknown");
        }
        let r = s.join().unwrap();
        assert_eq!(r.len(), 2);
        assert!(r[1].starts_with("PUT /api/v3/comments "));
        let b: Value = serde_json::from_str(r[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(b["is_meta"], true);
        assert_eq!(b["velocity"], 0.25);
        assert_eq!(b["active"], operation == "accept");
        assert_eq!(b["mod"], if operation == "accept" { 1 } else { -1 });
    }
}
#[test]
fn moderation_denied_or_missing_stops_before_put() {
    for (status, body, exit) in [
        (403, json!({}), 4),
        (200, json!([]), 1),
        (200, json!([{"tid":8}]), 1),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(status, body)]);
        assert_eq!(
            call(
                t.path(),
                &[
                    "moderate",
                    "accept",
                    "--conversation",
                    "generated",
                    "--tid",
                    "8"
                ],
                None,
                true
            )
            .0,
            exit
        );
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn implicit_vote_participant_zero_is_preserved() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            (200, json!({"pid":0})),
            (
                200,
                json!([{"tid":0,"vote":polis_contracts::votes::WIRE_AGREE}]),
            ),
        ],
    );
    let (exit, v) = call(
        t.path(),
        &["vote", "list", "--conversation", "generated"],
        None,
        true,
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["pid"], 0);
    assert!(s.join().unwrap()[1].starts_with("GET /api/v3/votes?conversation_id=generated&pid=0 "));
}

#[test]
fn with_token_always_uses_private_file_without_interactive_flag() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![(200, json!({"uid":1}))]);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    let mut child = cmd
        .env("POLIS_CONFIG_DIR", t.path())
        .args(["auth", "login", "--with-token", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"fixture-token\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("fixture-token"));
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["data"]["storage"], "owner-only file (0600)");
    assert_eq!(
        std::fs::metadata(credential(t.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(s.join().unwrap()[0].contains("Bearer fixture-token"));
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![(401, json!({"error":"denied"}))]);
    let (exit, _) = call(
        t.path(),
        &["auth", "login", "--with-token"],
        Some("fixture-token\n"),
        false,
    );
    assert_eq!(exit, 3);
    assert!(std::fs::read_dir(t.path().join("credentials"))
        .map(|mut i| i.next().is_none())
        .unwrap_or(true));
    s.join().unwrap();
}

#[test]
fn security_reflected_bearer_is_not_printed_in_json_or_text() {
    for (json_mode, reflected) in [
        (true, "Bearer fixture-token"),
        (true, "fixture-token"),
        (true, "trace:fixture-token"),
        (false, "Bearer fixture-token"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(t.path().join("profiles.json"), json!({"default":"local","sites":{"local":format!("http://{}",listener.local_addr().unwrap())}}).to_string()).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut b = [0; 8192];
            assert!(s.read(&mut b).unwrap() > 0);
            write!(s,"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nX-Request-Id: {reflected}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
        });
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
        cmd.env("POLIS_CONFIG_DIR", t.path())
            .env("POLIS_TOKEN_LOCAL", "fixture-token")
            .args(["auth", "status", "--no-interactive"]);
        if json_mode {
            cmd.arg("--json");
        }
        let o = cmd.output().unwrap();
        worker.join().unwrap();
        assert_eq!(o.status.code(), Some(4));
        assert!(!String::from_utf8_lossy(&o.stdout).contains("fixture-token"));
        assert!(!String::from_utf8_lossy(&o.stderr).contains("fixture-token"));
    }
}

#[test]
fn security_hardlinks_and_directory_symlinks_are_refused_without_reading_tokens() {
    for attack in ["hardlink", "directory_symlink"] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(200, json!({}))]);
        assert_eq!(
            call(
                t.path(),
                &["auth", "login", "--with-token"],
                Some("fixture-token"),
                false
            )
            .0,
            0
        );
        s.join().unwrap();
        if attack == "hardlink" {
            std::fs::hard_link(credential(t.path()), t.path().join("hardlink")).unwrap();
        } else {
            std::fs::rename(t.path().join("credentials"), t.path().join("moved")).unwrap();
            symlink(t.path().join("moved"), t.path().join("credentials")).unwrap();
        }
        assert_eq!(
            call(t.path(), &["auth", "status"], None, false).1["error"]["code"],
            "credential_file_unsafe"
        );
    }
}
