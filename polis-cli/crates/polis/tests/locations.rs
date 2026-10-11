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
    vec![
        "participant",
        "locations",
        "--conversation",
        "convA",
        "--group",
        "0",
    ]
}
fn row(lat: f64, lng: f64) -> Value {
    json!({"lat":lat,"lng":lng,"n":1})
}
#[test]
fn public_read_preserves_zero_boundaries_duplicates_and_extensions() {
    for value in [
        json!([]),
        json!([row(0.0,0.0),row(90.0,-180.0),row(-90.0,180.0),row(0.0,0.0),{"lat":1,"lng":2,"n":1,"future":"  Untrusted 🐈  "}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(value.clone())]);
        let (code, v) = call(t.path(), &args(), None, false);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"], value);
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/v3/locations?conversation_id=convA&gid=0 "));
        assert!(!requests[0].to_lowercase().contains("authorization:"));
        assert!(!requests[0].to_lowercase().contains("if-none-match:"));
    }
}
#[test]
fn exact_group_and_optional_credentials_apply_once() {
    for group in ["0", "17", "2147483647"] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!([]))]);
        let mut a = args();
        a[5] = group;
        assert_eq!(call(t.path(), &a, None, true).0, 0);
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with(&format!(
            "GET /api/v3/locations?conversation_id=convA&gid={group} "
        )));
        assert!(requests[0]
            .to_lowercase()
            .contains("authorization: bearer fixture-token"));
    }
}
#[test]
fn invalid_arguments_never_reach_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for id in ["", "../bad", "bad id", "a?b", "🐈"] {
        let mut a = args();
        a[3] = id;
        assert_eq!(call(t.path(), &a, None, false).0, 2);
    }
    for group in ["-1", "2147483648", "1.5", "all"] {
        let mut a = args();
        a[5] = group;
        assert_eq!(call(t.path(), &a, None, false).0, 2);
    }
    assert_eq!(call(t.path(), &args()[..4], None, false).0, 2);
}
#[test]
fn malformed_coordinates_counts_and_rows_are_refused_without_dropping() {
    let mut cases = vec![json!({}), json!(null), json!([null]), json!([{}])];
    for (key, value) in [
        ("lat", json!(90.001)),
        ("lat", json!(-90.001)),
        ("lat", json!(null)),
        ("lat", json!("0")),
        ("lng", json!(180.001)),
        ("lng", json!(-180.001)),
        ("lng", json!(true)),
        ("n", json!(0)),
        ("n", json!(2)),
        ("n", json!(1.5)),
        ("n", json!(null)),
        ("n", json!("1")),
    ] {
        let mut v = row(0.0, 0.0);
        v[key] = value;
        cases.push(json!([row(1.0, 2.0), v]));
    }
    for value in cases {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(value)]);
        let (code, v) = call(t.path(), &args(), None, false);
        assert_eq!(code, 1, "{v}");
        assert_eq!(v["error"]["code"], "invalid_response");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn nonfinite_and_invalid_protocol_responses_are_refused() {
    for response in [
        (
            200,
            "application/json",
            r#"[{"lat":NaN,"lng":0,"n":1}]"#.into(),
        ),
        (
            200,
            "application/json",
            r#"[{"lat":1e999,"lng":0,"n":1}]"#.into(),
        ),
        (200, "text/html", "<html>login</html>".into()),
        (200, "application/json", "{".into()),
        (202, "application/json", "[]".into()),
        (204, "application/json", "".into()),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![response]);
        assert_eq!(call(t.path(), &args(), None, false).0, 1);
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn http_errors_are_actionable_private_and_not_retried() {
    for (status, exit, expected) in [
        (304, 1, "participant_locations_unavailable"),
        (401, 3, "auth_invalid"),
        (403, 4, "forbidden"),
        (404, 1, "operation_failed"),
        (429, 6, "rate_limited"),
        (302, 1, "redirect_refused"),
        (500, 6, "participant_locations_read_failed"),
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
    }
}
#[test]
fn named_legacy_database_error_gets_location_guidance() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            500,
            "application/json",
            r#"{"error":"polis_err_locations_01"}"#.into(),
        )],
    );
    let (code, v) = call(t.path(), &args(), None, false);
    assert_eq!(code, 6, "{v}");
    assert_eq!(v["error"]["code"], "participant_locations_read_failed");
    assert_eq!(v["error"]["upstream"]["code"], "polis_err_locations_01");
    assert_eq!(v["error"]["outcome"], "rejected");
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn oversized_body_is_refused() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(200, "application/json", " ".repeat(8388609))],
    );
    assert_eq!(call(t.path(), &args(), None, false).0, 1);
    s.join().unwrap();
}
#[test]
fn focused_help_and_schema_explain_the_route_limits() {
    let t = tempfile::tempdir().unwrap();
    let (code, v) = call(t.path(), &["help", "participant", "locations"], None, false);
    assert_eq!(code, 0);
    let help = v["data"]["help"].as_str().unwrap();
    for text in [
        "ARRAY INDEX",
        "absent math",
        "refused math",
        "8 MiB",
        "no generation",
        "never clipped",
    ] {
        assert!(help.contains(text), "{text}");
    }
    assert_eq!(
        call(
            t.path(),
            &["schema", "participant", "locations"],
            None,
            false
        )
        .1["data"]["implemented"],
        true
    );
    assert_eq!(call(t.path(), &["participant", "group"], None, false).0, 8);
}
