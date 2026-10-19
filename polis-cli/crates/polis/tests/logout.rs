//! Logout uses only fixture file sessions and loopback HTTP servers, never Keychain.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

const ACCESS: &str = "fixture-access-secret";
const REFRESH: &str = "fixture-refresh/+&=secret";
const CLIENT: &str = "fixture-client/+&=";
const OVERRIDE: &str = "fixture-override-secret";
const ORIGIN: &str = "http://127.0.0.1:12345/";

fn command(dir: &Path, json_output: bool) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("POLIS_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_SITE", "local")
        .env("POLIS_URL_LOCAL", ORIGIN)
        // Default storage must not inspect even an invalid Keychain service.
        .env("POLIS_KEYCHAIN_SERVICE", "")
        .env("POLIS_TOKEN_LOCAL", OVERRIDE)
        .env("POLIS_AUTH_ISSUER_LOCAL", "https://changed.invalid/")
        .env("POLIS_AUTH_CLIENT_ID_LOCAL", "changed-client")
        .args(["auth", "logout", "--no-interactive", "--timeout", "1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if json_output {
        cmd.arg("--json");
    }
    cmd
}
fn run(dir: &Path) -> Output {
    command(dir, true).output().unwrap()
}
fn document(out: &Output, code: i32) -> Value {
    assert_eq!(out.status.code(), Some(code), "{out:?}");
    for output in [&out.stdout, &out.stderr] {
        let text = String::from_utf8_lossy(output);
        for secret in [ACCESS, REFRESH, OVERRIDE, "fixture-provider-secret"] {
            assert!(!text.contains(secret), "secret printed: {text}");
        }
    }
    serde_json::from_slice(&out.stdout).unwrap()
}
fn saved(dir: &Path, issuer: &str, refresh: Option<&str>) -> PathBuf {
    let credentials = dir.join("credentials");
    std::fs::create_dir_all(&credentials).unwrap();
    std::fs::set_permissions(&credentials, std::fs::Permissions::from_mode(0o700)).unwrap();
    let key = serde_json::to_vec(&("local", ORIGIN)).unwrap();
    let path = credentials.join(format!(
        "{}.json",
        uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, &key)
    ));
    let record = json!({"site":"local","origin":ORIGIN,"token":ACCESS,
        "session":{"issuer":issuer,"client_id":CLIENT,"audience":"users",
            "expires_at":1,"refresh_token":refresh}});
    std::fs::write(&path, record.to_string()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path
}
fn cleared(path: &Path) {
    let text = std::fs::read_to_string(path).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["token"], Value::Null);
    assert_eq!(v["session"], Value::Null);
    assert!(!text.contains("fixture-"));
    assert_ne!(v["keychain"], true);
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
fn request(socket: &mut TcpStream) -> String {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let n = socket.read(&mut buf).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buf[..n]);
        if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length: "))
                .unwrap_or("0")
                .parse()
                .unwrap();
            if bytes.len() >= end + 4 + len {
                break;
            }
        }
    }
    String::from_utf8(bytes).unwrap()
}
fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let start = Instant::now();
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                socket.set_nonblocking(false).unwrap();
                return socket;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    start.elapsed() < Duration::from_secs(10),
                    "missing revoke request"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("{e}"),
        }
    }
}
fn check_request(raw: &str) {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    assert!(
        head.starts_with("POST /session/end?realm=fixture HTTP/1.1\r\n"),
        "{head}"
    );
    let head = head.to_ascii_lowercase();
    assert!(head.contains("content-type: application/x-www-form-urlencoded"));
    assert!(!head.contains("authorization:"));
    assert!(!raw.contains(ACCESS) && !raw.contains(OVERRIDE));
    let fields: BTreeMap<_, _> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(
        fields,
        BTreeMap::from([
            ("client_id".into(), CLIENT.into()),
            ("token".into(), REFRESH.into())
        ])
    );
}

#[test]
fn revoke_precedes_cleanup_uses_saved_binding_and_holds_the_rotation_lock() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
    let path = saved(dir.path(), &issuer, Some(REFRESH));
    let mut child = command(dir.path(), true).spawn().unwrap();
    discover(&listener, &issuer);
    let mut socket = accept(&listener);
    check_request(&request(&mut socket));
    // Local credentials still exist until the issuer has acknowledged revocation.
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).unwrap()["session"]
            ["refresh_token"],
        REFRESH
    );
    assert_eq!(
        document(&run(dir.path()), 3)["error"]["code"],
        "credential_busy"
    );
    assert!(child.try_wait().unwrap().is_none());
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .unwrap();
    drop(socket);
    let result = document(&child.wait_with_output().unwrap(), 0);
    assert_eq!(result["data"]["refresh_token_revocation"], "acknowledged");
    assert_eq!(result["data"]["environment_override_present"], true);
    cleared(&path);
    assert_eq!(
        document(&run(dir.path()), 0)["data"]["refresh_token_revocation"],
        "not_available"
    );
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn issuer_failures_clear_locally_without_redirect_retry_or_secret_output() {
    for status in [302, 307, 400, 401, 429, 500, 503] {
        for json_output in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
            let path = saved(dir.path(), &issuer, Some(REFRESH));
            let child = command(dir.path(), json_output).spawn().unwrap();
            discover(&listener, &issuer);
            let mut socket = accept(&listener);
            check_request(&request(&mut socket));
            let body = format!("{ACCESS} {REFRESH} fixture-provider-secret");
            write!(socket, "HTTP/1.1 {status} Fixture\r\nLocation: {issuer}trap\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            drop(socket);
            let out = child.wait_with_output().unwrap();
            if json_output {
                let result = document(&out, 7);
                assert_eq!(result["error"]["code"], "oauth_revoke_failed");
                assert_eq!(result["error"]["outcome"], "unknown");
            } else {
                assert_eq!(out.status.code(), Some(7));
                let output = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                assert!(output.contains("local credentials were cleared"));
                for secret in [ACCESS, REFRESH, OVERRIDE, "fixture-provider-secret"] {
                    assert!(!output.contains(secret));
                }
            }
            cleared(&path);
            assert!(
                matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock)
            );
        }
    }
}

#[test]
fn stalled_revoke_times_out_and_still_clears_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
    let path = saved(dir.path(), &issuer, Some(REFRESH));
    let start = Instant::now();
    let child = command(dir.path(), true).spawn().unwrap();
    discover(&listener, &issuer);
    let mut socket = accept(&listener);
    check_request(&request(&mut socket));
    let out = child.wait_with_output().unwrap();
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(document(&out, 7)["error"]["code"], "oauth_revoke_failed");
    cleared(&path);
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn connection_failure_and_invalid_saved_configuration_still_clear_locally() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed = format!("http://{}/tenant/", listener.local_addr().unwrap());
    drop(listener);
    for issuer in [
        closed.as_str(),
        "http://insecure.invalid/",
        "https://issuer.invalid/?fixture-secret",
        "https://user:fixture-secret@issuer.invalid/",
        "https://issuer.invalid/#fixture-secret",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = saved(dir.path(), issuer, Some(REFRESH));
        assert_eq!(
            document(&run(dir.path()), 7)["error"]["code"],
            "oauth_revoke_failed"
        );
        cleared(&path);
    }
}

#[test]
fn absent_refresh_manual_token_and_keychain_pointer_need_no_network() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
    for kind in ["no_refresh", "manual", "pointer", "absent"] {
        let dir = tempfile::tempdir().unwrap();
        let path = saved(dir.path(), &issuer, None);
        if kind == "absent" {
            std::fs::remove_file(&path).unwrap();
        } else if kind != "no_refresh" {
            let v = json!({"site":"local","origin":ORIGIN,
                "token":if kind == "manual" {Some(ACCESS)} else {None},"keychain":kind=="pointer"});
            std::fs::write(&path, v.to_string()).unwrap();
        }
        assert_eq!(
            document(&run(dir.path()), 0)["data"]["refresh_token_revocation"],
            "not_available"
        );
        cleared(&path);
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}

#[test]
fn invalid_refresh_and_ca_configuration_are_reported_after_cleanup() {
    for bad_refresh in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = saved(
            dir.path(),
            "https://issuer.invalid/",
            Some(if bad_refresh {
                "invalid refresh"
            } else {
                REFRESH
            }),
        );
        let out = command(dir.path(), true)
            .env("POLIS_CA_FILE_LOCAL", dir.path().join("missing-ca"))
            .output()
            .unwrap();
        assert_eq!(document(&out, 7)["error"]["code"], "oauth_revoke_failed");
        cleared(&path);
    }
}

fn metadata_request(listener: &TcpListener) -> TcpStream {
    let mut socket = accept(listener);
    let raw = request(&mut socket);
    assert!(raw.starts_with("GET /tenant/.well-known/openid-configuration HTTP/1.1\r\n"));
    assert!(!raw.to_ascii_lowercase().contains("authorization:"));
    for secret in [ACCESS, REFRESH, OVERRIDE, CLIENT] {
        assert!(!raw.contains(secret));
    }
    socket
}
fn metadata_reply(socket: &mut TcpStream, value: &Value) {
    let body = value.to_string();
    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}
fn discover(listener: &TcpListener, issuer: &str) {
    let mut socket = metadata_request(listener);
    metadata_reply(
        &mut socket,
        &json!({"issuer":issuer,
        "revocation_endpoint":format!("http://{}/session/end?realm=fixture",listener.local_addr().unwrap())}),
    );
}

#[test]
fn missing_revocation_endpoint_succeeds_and_clears_without_post() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
    let path = saved(dir.path(), &issuer, Some(REFRESH));
    let child = command(dir.path(), true).spawn().unwrap();
    let mut socket = metadata_request(&listener);
    metadata_reply(&mut socket, &json!({"issuer":issuer}));
    drop(socket);
    assert_eq!(
        document(&child.wait_with_output().unwrap(), 0)["data"]["refresh_token_revocation"],
        "not_available"
    );
    cleared(&path);
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn discovered_endpoint_can_be_on_another_origin() {
    let dir = tempfile::tempdir().unwrap();
    let discovery = TcpListener::bind("127.0.0.1:0").unwrap();
    let revoke = TcpListener::bind("127.0.0.1:0").unwrap();
    let issuer = format!("http://{}/tenant/", discovery.local_addr().unwrap());
    let path = saved(dir.path(), &issuer, Some(REFRESH));
    let child = command(dir.path(), true).spawn().unwrap();
    let mut socket = metadata_request(&discovery);
    metadata_reply(
        &mut socket,
        &json!({"issuer":issuer,
        "revocation_endpoint":format!("http://{}/session/end?realm=fixture", revoke.local_addr().unwrap())}),
    );
    drop(socket);
    let mut socket = accept(&revoke);
    check_request(&request(&mut socket));
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .unwrap();
    drop(socket);
    assert_eq!(
        document(&child.wait_with_output().unwrap(), 0)["data"]["refresh_token_revocation"],
        "acknowledged"
    );
    cleared(&path);
    for listener in [&discovery, &revoke] {
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}

#[test]
fn mismatched_issuer_and_invalid_endpoint_clear_without_sending_secrets() {
    for kind in [
        "wrong_issuer",
        "missing_issuer",
        "wrong_issuer_no_endpoint",
        "null",
        "number",
        "relative",
        "insecure",
        "credentials",
        "fragment",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
        let path = saved(dir.path(), &issuer, Some(REFRESH));
        let child = command(dir.path(), true).spawn().unwrap();
        let mut socket = metadata_request(&listener);
        let mut metadata = json!({"issuer":issuer, "revocation_endpoint":format!("http://{}/trap", listener.local_addr().unwrap())});
        match kind {
            "wrong_issuer" | "wrong_issuer_no_endpoint" => {
                metadata["issuer"] = json!("https://wrong.invalid/")
            }
            "missing_issuer" => {
                metadata.as_object_mut().unwrap().remove("issuer");
            }
            "null" => metadata["revocation_endpoint"] = Value::Null,
            "number" => metadata["revocation_endpoint"] = json!(42),
            "relative" => metadata["revocation_endpoint"] = json!("/trap"),
            "insecure" => metadata["revocation_endpoint"] = json!("http://insecure.invalid/trap"),
            "credentials" => {
                metadata["revocation_endpoint"] =
                    json!("https://user:fixture-provider-secret@issuer.invalid/trap")
            }
            "fragment" => {
                metadata["revocation_endpoint"] =
                    json!("https://issuer.invalid/trap#fixture-provider-secret")
            }
            _ => unreachable!(),
        }
        if kind == "wrong_issuer_no_endpoint" {
            metadata
                .as_object_mut()
                .unwrap()
                .remove("revocation_endpoint");
        }
        metadata_reply(&mut socket, &metadata);
        drop(socket);
        assert_eq!(
            document(&child.wait_with_output().unwrap(), 7)["error"]["code"],
            "oauth_revoke_failed"
        );
        cleared(&path);
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}

#[test]
fn discovery_errors_are_redacted_clear_locally_and_never_redirect_or_retry() {
    for kind in [
        "redirect",
        "rejected",
        "invalid_json",
        "oversized",
        "timeout",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let issuer = format!("http://{}/tenant/", listener.local_addr().unwrap());
        let path = saved(dir.path(), &issuer, Some(REFRESH));
        let child = command(dir.path(), true).spawn().unwrap();
        let mut socket = metadata_request(&listener);
        if kind != "timeout" {
            let status = match kind {
                "redirect" => 302,
                "rejected" => 503,
                _ => 200,
            };
            let body = if kind == "oversized" {
                "x".repeat(131_073)
            } else if kind == "invalid_json" {
                "fixture-provider-secret".into()
            } else {
                json!({"error": "fixture-provider-secret"}).to_string()
            };
            write!(socket, "HTTP/1.1 {status} Fixture\r\nLocation: {issuer}trap\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert_eq!(document(&out, 7)["error"]["code"], "oauth_revoke_failed");
        cleared(&path);
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}
