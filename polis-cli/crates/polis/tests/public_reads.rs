//! Public reads use explicit or usable file tokens without refreshing a session.
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::Command,
    time::{Duration, Instant},
};

fn command(dir: &std::path::Path, origin: &str) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("POLIS_") {
            c.env_remove(k);
        }
    }
    c.env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_SITE", "local")
        .env("POLIS_URL_LOCAL", origin)
        .env("POLIS_KEYCHAIN", "off")
        .env("POLIS_AUTH_ISSUER_LOCAL", "https://issuer.invalid/")
        .env("POLIS_AUTH_CLIENT_ID_LOCAL", "fixture-client")
        .env("POLIS_AUTH_AUDIENCE_LOCAL", "users")
        .args(["--json", "--no-interactive", "--timeout", "1"]);
    c
}
fn saved(dir: &std::path::Path, origin: &str, expires: u64) -> std::path::PathBuf {
    let parent = dir.join("credentials");
    std::fs::create_dir_all(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let key = serde_json::to_vec(&("local", origin)).unwrap();
    let p = parent.join(format!(
        "{}.json",
        uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, &key)
    ));
    std::fs::write(&p,json!({"site":"local","origin":origin,"token":"fixture-access",
        "session":{"issuer":"https://issuer.invalid/","client_id":"fixture-client","audience":"users","expires_at":expires,"refresh_token":"fixture-refresh"}}).to_string()).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    p
}
fn read_case(expires: u64, lock: bool, expected: Option<&str>, kind: &str) {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let p = saved(dir.path(), &origin, expires);
    if kind == "keychain" {
        std::fs::write(
            &p,
            json!({"site":"local","origin":origin,"keychain":true}).to_string(),
        )
        .unwrap();
    }
    if kind == "missing" {
        std::fs::remove_file(&p).unwrap();
        std::fs::remove_dir(p.parent().unwrap()).unwrap();
    }
    let before = std::fs::read(&p).ok();
    let lockfile = if lock {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(p.with_extension("lock"))
            .unwrap();
        std::fs::set_permissions(
            p.with_extension("lock"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        use std::os::fd::AsRawFd;
        assert_eq!(
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        Some(f)
    } else {
        None
    };
    let mut cmd = command(dir.path(), &origin);
    if kind == "override" {
        cmd.env("POLIS_TOKEN_LOCAL", "fixture-override");
    }
    let mut child = cmd
        .args(["report", "view", "rfixture"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    let mut request = None;
    while start.elapsed() < Duration::from_secs(5) {
        if let Ok((mut socket, _)) = listener.accept() {
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = vec![0; 8192];
            let n = socket.read(&mut bytes).unwrap();
            request = Some(String::from_utf8(bytes[..n].to_vec()).unwrap());
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
            break;
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    if start.elapsed() >= Duration::from_secs(5) {
        child.kill().unwrap();
    }
    let out = child.wait_with_output().unwrap();
    drop(lockfile);
    assert_eq!(std::fs::read(&p).ok(), before, "read changed credentials");
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    if kind == "missing" {
        assert!(!p.parent().unwrap().exists());
    }
    let request = request
        .expect("public route was not reached")
        .to_ascii_lowercase();
    assert!(request.starts_with("get /api/v3/reports?report_id=rfixture "));
    match expected {
        Some(t) => assert!(request.contains(&format!("authorization: bearer {t}"))),
        None => assert!(!request.contains("authorization:")),
    }
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["ok"], true);
}
#[test]
fn expired_session_does_not_block_public_read_or_refresh() {
    read_case(1, false, None, "session");
}
#[test]
fn public_read_does_not_acquire_owner_credential_lock() {
    read_case(u64::MAX, true, Some("fixture-access"), "session");
}
#[test]
fn usable_file_session_still_authenticates_public_read() {
    read_case(u64::MAX, false, Some("fixture-access"), "session");
}

#[test]
fn public_read_does_not_create_credential_directory() {
    read_case(1, false, None, "missing");
}
#[test]
fn public_read_ignores_keychain_pointer() {
    read_case(1, false, None, "keychain");
}
#[test]
fn public_read_keeps_explicit_override() {
    read_case(1, false, Some("fixture-override"), "override");
}
