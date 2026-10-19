//! `polis delphi run` (POST /api/v3/delphi/jobs) when the sign-in lacks the
//! delphi_enabled claim: the site answers 403 with a stable code, which is a
//! clean refusal (exit 4, nothing queued), not an uncertain write (exit 7).
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
};

const REFUSAL: &str = "polis_err_delphi_jobs_delphi_disabled";

fn call(dir: &std::path::Path, args: &[&str]) -> (i32, Value) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    let o = cmd
        .env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_TOKEN_LOCAL", "fixture-token")
        .args(args)
        .args(["--json", "--no-interactive"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&o.stdout).contains("fixture-token"));
    (
        o.status.code().unwrap(),
        serde_json::from_slice(&o.stdout).unwrap(),
    )
}
fn server(
    dir: &std::path::Path,
    responses: Vec<(u16, String)>,
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
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
const RUN: &[&str] = &[
    "delphi",
    "run",
    "--report",
    "r2demo",
    "--type",
    "FULL_PIPELINE",
    "--yes",
];

#[test]
fn missing_delphi_claim_is_a_refusal_not_an_uncertain_write() {
    let t = tempfile::tempdir().unwrap();
    // The body Node's failJson writes for this refusal.
    let body = json!({"error":REFUSAL,"message":REFUSAL,"status":403}).to_string();
    let s = server(t.path(), vec![(403, body)]);
    let (exit, v) = call(t.path(), RUN);
    assert_eq!(exit, 4, "{v}");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "forbidden");
    assert_eq!(v["error"]["outcome"], "rejected");
    assert_eq!(v["error"]["upstream"]["status"], 403);
    assert_eq!(v["error"]["upstream"]["code"], REFUSAL);
    assert!(
        v["error"]["message"].as_str().unwrap().contains("Delphi"),
        "{v}"
    );
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1, "no retry");
    assert!(requests[0].starts_with("POST /api/v3/delphi/jobs "));
    assert!(requests[0].contains(r#""report_id":"r2demo""#));
}

#[test]
fn a_server_error_from_the_run_route_stays_uncertain() {
    // What the route answered for the same refusal before it was a 403: a 500
    // after a write was attempted can mean a job was queued, so it stays exit 7.
    let t = tempfile::tempdir().unwrap();
    let body = json!({"status":"error","error":"Unauthorized"}).to_string();
    let s = server(t.path(), vec![(500, body)]);
    let (exit, v) = call(t.path(), RUN);
    assert_eq!(exit, 7, "{v}");
    assert_eq!(v["error"]["code"], "server_error");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert!(!v.to_string().contains("Unauthorized"));
    assert_eq!(s.join().unwrap().len(), 1, "no retry");
}
