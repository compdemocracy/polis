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
        .env("POLIS_SITE", "local")
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
#[test]
fn narrative_import_json_flag_and_file_do_not_collide() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("input.json");
    std::fs::write(
        &file,
        json!({"conversation_id":"demo","report_id":"rdemo"}).to_string(),
    )
    .unwrap();
    let handle = server(
        dir.path(),
        vec![(200, json!({"status":"success","job_id":"external_demo"}))],
    );
    let (code, v) = call(
        dir.path(),
        &[
            "delphi",
            "narrative",
            "import",
            "demo",
            file.to_str().unwrap(),
            "--report",
            "rdemo",
        ],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    let requests = handle.join().unwrap();
    assert!(requests[0].starts_with("POST /api/v3/delphi/narrative/results"));
}
#[test]
fn narrative_import_cannot_retarget_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("input.json");
    std::fs::write(
        &file,
        json!({"conversation_id":"other","report_id":"rdemo"}).to_string(),
    )
    .unwrap();
    let (code, v) = call(
        dir.path(),
        &[
            "delphi",
            "narrative",
            "import",
            "demo",
            file.to_str().unwrap(),
            "--report",
            "rdemo",
        ],
        None,
        true,
    );
    assert_eq!(code, 2);
    assert_eq!(v["error"]["outcome"], "not_sent");
}
#[test]
fn narrative_export_uses_numbered_private_paths() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("export");
    let handle = server(
        dir.path(),
        vec![(
            200,
            json!({"status":"success","conversation_id":"demo","report_id":"rdemo","result_schema":{},"sections":[{"section":"../../untrusted","request":{"system":"system","messages":[{"content":"prompt"}]},"comments_xml":"<comments/>","comments_csv":"comment\n"}]}),
        )],
    );
    let (code, v) = call(
        dir.path(),
        &[
            "delphi",
            "narrative",
            "export",
            "demo",
            "--report",
            "rdemo",
            "--output",
            out.to_str().unwrap(),
        ],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    handle.join().unwrap();
    assert_eq!(
        std::fs::metadata(&out).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::read_to_string(out.join("sections/000/prompt.txt")).unwrap(),
        "prompt"
    );
    assert!(!dir.path().join("untrusted").exists());
    let (code, _) = call(
        dir.path(),
        &[
            "delphi",
            "narrative",
            "export",
            "demo",
            "--report",
            "rdemo",
            "--output",
            out.to_str().unwrap(),
        ],
        None,
        true,
    );
    assert_eq!(code, 2);
}
#[test]
fn narrative_export_refuses_existing_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("out");
    symlink(dir.path().join("missing"), &output).unwrap();
    let (code, _) = call(
        dir.path(),
        &[
            "delphi",
            "narrative",
            "export",
            "demo",
            "--report",
            "rdemo",
            "--output",
            output.to_str().unwrap(),
        ],
        None,
        true,
    );
    assert_eq!(code, 2);
    assert!(output.symlink_metadata().unwrap().file_type().is_symlink());
}
