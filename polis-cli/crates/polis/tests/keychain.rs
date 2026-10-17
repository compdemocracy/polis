//! Credential backend selection and the token override names.
//! Keychain cases use a throwaway Keychain service per test (POLIS_KEYCHAIN_SERVICE)
//! and remove it afterwards; they never read or write the CLI's real service.
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::{Command, Stdio},
};

fn serve(
    listener: TcpListener,
    responses: Vec<(u16, Value)>,
) -> std::thread::JoinHandle<Vec<String>> {
    listener.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let start = std::time::Instant::now();
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(start.elapsed().as_secs() < 20, "missing request");
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
            write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    })
}

fn polis(dir: &Path, env: &[(&str, String)], args: &[&str]) -> (i32, Value) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_") {
            cmd.env_remove(key);
        }
    }
    // Only a case with its own throwaway Keychain service may reach the Keychain.
    if !env.iter().any(|(k, _)| *k == "POLIS_KEYCHAIN_SERVICE") {
        cmd.env("POLIS_KEYCHAIN", "off");
    }
    cmd.env("POLIS_CONFIG_DIR", dir)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .args(args)
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let o = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&o.stdout);
    assert!(!stdout.contains("fixture-refresh"), "{stdout}");
    (
        o.status.code().unwrap(),
        serde_json::from_slice(&o.stdout).unwrap(),
    )
}

fn credential_file(dir: &Path) -> String {
    let path = std::fs::read_dir(dir.join("credentials"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "json"))
        .unwrap();
    std::fs::read_to_string(path).unwrap()
}

#[test]
fn pol_is_profile_uses_plain_token_variable_and_keeps_the_old_name() {
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let s = serve(listener, vec![(200, json!({})); 4]);
    let url = ("POLIS_URL_PROD", origin.clone());
    let (exit, v) = polis(
        t.path(),
        &[url.clone(), ("POLIS_TOKEN", "fixture-plain".into())],
        &["auth", "status", "--no-interactive"],
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["token_environment"], "POLIS_TOKEN");
    let (exit, v) = polis(
        t.path(),
        &[url.clone(), ("POLIS_TOKEN_PROD", "fixture-legacy".into())],
        &["auth", "status", "--no-interactive"],
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["token_environment"], "POLIS_TOKEN");
    let (exit, _) = polis(
        t.path(),
        &[
            url.clone(),
            ("POLIS_TOKEN", "fixture-plain".into()),
            ("POLIS_TOKEN_PROD", "fixture-legacy".into()),
        ],
        &["auth", "status", "--no-interactive"],
    );
    assert_eq!(exit, 0);
    let (exit, v) = polis(
        t.path(),
        &[url.clone(), ("POLIS_TOKEN", "fixture-plain".into())],
        &["auth", "logout", "--no-interactive"],
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["environment_override_present"], true);
    assert!(v["data"]["note"]
        .as_str()
        .unwrap()
        .contains("Unset POLIS_TOKEN "));
    // The plain variable belongs to the pol.is profile only.
    let (exit, v) = polis(
        t.path(),
        &[
            ("POLIS_SITE", "local".into()),
            ("POLIS_URL_LOCAL", origin.clone()),
            ("POLIS_TOKEN", "fixture-plain".into()),
        ],
        &["auth", "status", "--no-interactive"],
    );
    assert_eq!(exit, 3);
    assert_eq!(v["error"]["code"], "auth_required");
    let (exit, v) = polis(
        t.path(),
        &[
            ("POLIS_SITE", "local".into()),
            ("POLIS_URL_LOCAL", origin),
            ("POLIS_TOKEN_LOCAL", "fixture-profile".into()),
        ],
        &["auth", "status", "--no-interactive"],
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["token_environment"], "POLIS_TOKEN_LOCAL");
    let requests = s.join().unwrap();
    assert!(requests[0].contains("Bearer fixture-plain"));
    assert!(requests[1].contains("Bearer fixture-legacy"));
    assert!(requests[2].contains("Bearer fixture-plain"));
    assert!(requests[3].contains("Bearer fixture-profile"));
}

/// A throwaway Keychain service, or None when this session has no usable login
/// Keychain (for example a locked headless runner).
struct Service(String);
impl Service {
    fn new() -> Option<Self> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        // Real-Keychain cases touch the login Keychain, which can show dialogs on a
        // person's machine; they run only when asked for.
        if std::env::var("POLIS_TEST_KEYCHAIN").as_deref() != Ok("1") {
            eprintln!("skipping: set POLIS_TEST_KEYCHAIN=1 to run the real-Keychain cases");
            return None;
        }
        let name = format!("org.pol.is.cli.test.{}", uuid::Uuid::new_v4().simple());
        let ok = Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-s",
                &name,
                "-a",
                "probe",
                "-w",
                "probe",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            eprintln!("skipping: login Keychain unavailable in this session");
            return None;
        }
        let service = Self(name);
        service.delete("probe");
        Some(service)
    }
    fn delete(&self, account: &str) {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", &self.0, "-a", account])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    fn has_item(&self) -> bool {
        Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", &self.0])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        // Remove anything a failed test left behind in the throwaway service.
        for _ in 0..8 {
            if !self.has_item() {
                break;
            }
            let _ = Command::new("/usr/bin/security")
                .args(["delete-generic-password", "-s", &self.0])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn issuer_env(origin: &str, service: &Service) -> Vec<(&'static str, String)> {
    vec![
        ("POLIS_SITE", "local".into()),
        ("POLIS_URL_LOCAL", origin.into()),
        ("POLIS_AUTH_ISSUER_LOCAL", format!("{origin}/")),
        ("POLIS_AUTH_CLIENT_ID_LOCAL", "fixture-client".into()),
        ("POLIS_AUTH_AUDIENCE_LOCAL", "users".into()),
        ("POLIS_KEYCHAIN_SERVICE", service.0.clone()),
    ]
}
fn discovery(origin: &str) -> Value {
    json!({"issuer":format!("{origin}/"),"authorization_endpoint":format!("{origin}/authorize"),
        "token_endpoint":format!("{origin}/oauth/token"),
        "device_authorization_endpoint":format!("{origin}/oauth/device/code"),
        "code_challenge_methods_supported":["S256"]})
}
fn device_login(origin: &str, access: &str, refresh: &str, lifetime: u64) -> Vec<(u16, Value)> {
    vec![
        (200, discovery(origin)),
        (
            200,
            json!({"device_code":"fixture-device","user_code":"ABCD-EFGH",
            "verification_uri":format!("{origin}/activate"),"expires_in":60,"interval":1}),
        ),
        (
            200,
            json!({"token_type":"Bearer","access_token":access,"expires_in":lifetime,"refresh_token":refresh}),
        ),
        (200, json!({"uid":1})),
    ]
}

#[test]
fn interactive_sign_in_is_saved_in_keychain_and_readable_without_prompts() {
    let Some(service) = Service::new() else {
        return;
    };
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut responses = device_login(&origin, "fixture-access-1", "fixture-refresh-1", 1);
    // Refresh rotation under --no-interactive, then a status read of the rotated token.
    responses.push((200, discovery(&origin)));
    responses.push((200, json!({"token_type":"Bearer","access_token":"fixture-access-2","expires_in":3600,"refresh_token":"fixture-refresh-2"})));
    responses.push((200, json!({"uid":1})));
    let s = serve(listener, responses);
    let env = issuer_env(&origin, &service);

    let (exit, v) = polis(t.path(), &env, &["auth", "login", "--device"]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["storage"], "macOS Keychain");
    assert!(service.has_item());
    let file = credential_file(t.path());
    assert!(
        !file.contains("fixture-access") && !file.contains("fixture-refresh"),
        "{file}"
    );
    assert!(file.contains("\"keychain\":true"), "{file}");

    // The access token expired; --no-interactive refreshes and rotates it in the Keychain.
    let (exit, v) = polis(t.path(), &env, &["auth", "token", "--no-interactive"]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["access_token"], "fixture-access-2");
    let (exit, v) = polis(t.path(), &env, &["auth", "status", "--no-interactive"]);
    assert_eq!(exit, 0, "{v}");
    assert!(!credential_file(t.path()).contains("fixture-"));

    let (exit, v) = polis(t.path(), &env, &["auth", "logout"]);
    assert_eq!(exit, 0, "{v}");
    assert!(!service.has_item());
    let (exit, _) = polis(t.path(), &env, &["auth", "status", "--no-interactive"]);
    assert_eq!(exit, 3);
    let requests = s.join().unwrap();
    assert!(requests[5].contains("grant_type=refresh_token"));
    assert!(requests[5].contains("refresh_token=fixture-refresh-1"));
    assert!(requests[6].contains("Bearer fixture-access-2"));
}

#[test]
fn noninteractive_sign_in_keeps_the_file_backend_and_a_later_sign_in_moves_it() {
    let Some(service) = Service::new() else {
        return;
    };
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut responses = device_login(&origin, "fixture-access-1", "fixture-refresh-1", 3600);
    responses.extend(device_login(
        &origin,
        "fixture-access-2",
        "fixture-refresh-2",
        3600,
    ));
    let s = serve(listener, responses);
    let env = issuer_env(&origin, &service);

    let (exit, v) = polis(
        t.path(),
        &env,
        &["auth", "login", "--device", "--no-interactive"],
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["storage"], "owner-only file (0600)");
    assert!(!service.has_item());
    assert!(credential_file(t.path()).contains("fixture-refresh-1"));

    // An interactive sign-in moves the session into the Keychain and erases the file copy.
    let (exit, v) = polis(t.path(), &env, &["auth", "login", "--device"]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["storage"], "macOS Keychain");
    assert!(service.has_item());
    assert!(!credential_file(t.path()).contains("fixture-"));

    // Logout in a headless session still removes the Keychain copy it points to.
    let (exit, _) = polis(t.path(), &env, &["auth", "logout", "--no-interactive"]);
    assert_eq!(exit, 0);
    assert!(!service.has_item());
    s.join().unwrap();
}

#[test]
fn manual_token_after_logout_uses_keychain() {
    let Some(service) = Service::new() else {
        return;
    };
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let s = serve(
        listener,
        vec![(200, json!({"uid":1})), (200, json!({"uid":1}))],
    );
    let env = vec![
        ("POLIS_SITE", "local".into()),
        ("POLIS_URL_LOCAL", origin),
        ("POLIS_KEYCHAIN_SERVICE", service.0.clone()),
    ];
    // A logout tombstone used to pin later manual tokens to the file backend.
    assert_eq!(polis(t.path(), &env, &["auth", "logout"]).0, 0);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_") {
            cmd.env_remove(key);
        }
    }
    let mut child = cmd
        .env("POLIS_CONFIG_DIR", t.path())
        .envs(env.iter().map(|(k, v)| (k, v)))
        .args(["auth", "login", "--token-stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"fixture-manual\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["data"]["storage"], "macOS Keychain");
    assert!(!credential_file(t.path()).contains("fixture-manual"));
    let (exit, v) = polis(t.path(), &env, &["auth", "status", "--no-interactive"]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(polis(t.path(), &env, &["auth", "logout"]).0, 0);
    assert!(!service.has_item());
    let requests = s.join().unwrap();
    assert!(requests[1].contains("Bearer fixture-manual"));
}
