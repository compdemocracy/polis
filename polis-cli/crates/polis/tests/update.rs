use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

fn target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        _ => panic!("unsupported test platform"),
    }
}
fn digest(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
struct Server {
    base: String,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    handle: Option<thread::JoinHandle<()>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.take().unwrap().join().unwrap();
    }
}
fn server(mode: &str) -> (Server, Vec<u8>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let version = if mode == "old" {
        env!("CARGO_PKG_VERSION")
    } else {
        "999.0.0"
    };
    let commit = "a".repeat(40);
    let root = format!("polis-{version}-{}-{}", &commit[..12], target());
    let name = format!("{root}.tar.gz");
    // This executable must never be run during verification or installation.
    let binary = b"#!/bin/sh\nprintf 'replacement ran unexpectedly' >&2\nexit 99\n".to_vec();
    let manifest = json!({"schema":"polis-cli-release/1","version":version,"commit":commit,"target":if mode=="wrong_target" {"wrong"}else{target()},"source":if mode=="unverified" {"unverified-archive"}else{"clean-checkout"},"binary_sha256":if mode=="binary_hash" {"0".repeat(64)}else{digest(&binary)}});
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    let members = [
        ("polis", binary.clone()),
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("LICENSE", b"fixture license".to_vec()),
        ("README.txt", b"fixture readme".to_vec()),
    ];
    for (part, bytes) in &members {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, format!("{root}/{part}"), &bytes[..])
            .unwrap();
    }
    if mode == "duplicate" {
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, format!("{root}/polis"), &b"x"[..])
            .unwrap();
    }
    if mode == "symlink" {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_link_name("/tmp/outside").unwrap();
        header.set_cksum();
        tar.append_data(&mut header, format!("{root}/linked"), &b""[..])
            .unwrap();
    }
    let archive = tar.into_inner().unwrap().finish().unwrap();
    let checksum = format!(
        "{}  {name}\n",
        if mode == "mismatch" {
            "0".repeat(64)
        } else {
            digest(&archive)
        }
    );
    let assets = if mode == "missing" {
        json!([])
    } else {
        json!([
            {"name":name,"browser_download_url":format!("{origin}/archive")},
            {"name":format!("{name}.sha256"),"browser_download_url":format!("{origin}/checksum")}
        ])
    };
    let releases = json!([
        {"tag_name":"server-v9999.0.0","draft":false,"prerelease":false,"assets":[]},
        {"tag_name":"cli-v9999.0.0","draft":true,"prerelease":false,"assets":[]},
        {"tag_name":"cli-v9998.0.0","draft":false,"prerelease":true,"assets":[]},
        {"tag_name":format!("cli-v{version}"),"draft":false,"prerelease":false,"body":"New commands.\u{1b}[31m","assets":assets}
    ]);
    let releases = if mode == "empty" { json!([]) } else { releases };
    let not_found = mode == "not_found";
    let offline = mode == "offline";
    let routes = HashMap::from([
        ("/releases", serde_json::to_vec(&releases).unwrap()),
        ("/archive", archive),
        ("/checksum", checksum.into_bytes()),
    ]);
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let handle = thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut b = [0; 1];
                    while !request.ends_with(b"\r\n\r\n") {
                        assert!(request.len() < 16384);
                        if stream.read(&mut b).unwrap() == 0 {
                            break;
                        }
                        request.push(b[0]);
                    }
                    observed.fetch_add(1, Ordering::SeqCst);
                    // An unavailable distributor closes without an HTTP response.
                    if offline {
                        continue;
                    }
                    let request = String::from_utf8(request).unwrap();
                    assert!(!request.to_lowercase().contains("authorization:"));
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .split('?')
                        .next()
                        .unwrap();
                    let body = routes
                        .get(path)
                        .unwrap_or_else(|| panic!("unexpected path {path}"));
                    write!(
                        stream,
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        if not_found { "404 Not Found" } else { "200 OK" },
                        body.len()
                    )
                    .unwrap();
                    stream.write_all(body).unwrap();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(e) => panic!("{e}"),
            }
        }
    });
    (
        Server {
            base: format!("{origin}/releases"),
            stop,
            requests,
            handle: Some(handle),
        },
        binary,
    )
}
fn run(mode: &str, json_mode: bool, env_source: bool) {
    let (server, binary) = server(mode);
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("polis");
    fs::copy(env!("CARGO_BIN_EXE_polis"), &exe).unwrap();
    let original = fs::read(&exe).unwrap();
    let config = dir.path().join("config");
    fs::create_dir(&config).unwrap();
    fs::write(
        config.join("profiles.json"),
        b"invalid config; must not be read",
    )
    .unwrap();
    fs::write(dir.path().join("polis.prev"), b"older backup").unwrap();
    let mut cmd = Command::new(&exe);
    cmd.args(["update", "--timeout", "5"])
        .env("POLIS_CONFIG_DIR", &config)
        .env("POLIS_KEYCHAIN", "off")
        .env("POLIS_TOKEN", "unused-fixture-token");
    if env_source {
        cmd.env("POLIS_RELEASE_BASE_URL", &server.base);
    } else {
        cmd.args(["--release-base-url", &server.base])
            .env("POLIS_RELEASE_BASE_URL", "invalid");
    }
    if json_mode {
        cmd.arg("--json");
    }
    #[cfg(unix)]
    let original_permissions = {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(dir.path()).unwrap().permissions();
        if mode.starts_with("denied_") {
            assert_ne!(
                unsafe { libc::geteuid() },
                0,
                "permission tests require a non-root user"
            );
            if mode == "denied_staging" {
                fs::write(dir.path().join(".polis-update.lock"), b"").unwrap();
            }
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        }
        permissions
    };
    let output = cmd.output();
    #[cfg(unix)]
    fs::set_permissions(dir.path(), original_permissions).unwrap();
    let out = output.unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();
    let success = matches!(mode, "match" | "old");
    assert_eq!(out.status.success(), success, "{stdout}\n{stderr}");
    assert!(!stdout.contains('\u{1b}'));
    assert!(!stdout.contains("unused-fixture-token"));
    if json_mode {
        let data: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(data["ok"], success);
        let expected_message = match mode {
            "offline" => Some("Cannot download release data."),
            "not_found" => Some("Release server returned an unsuccessful status."),
            "empty" => Some("No published stable CLI release was found."),
            "denied_lock" => Some("Cannot open the update lock in the installation directory."),
            "denied_staging" => Some("Installation directory is not writable."),
            _ => None,
        };
        if let Some(message) = expected_message {
            assert_eq!(out.status.code(), Some(1));
            assert_eq!(data["error"]["code"], "update_failed");
            assert_eq!(data["error"]["message"], message);
            assert_eq!(data["error"]["outcome"], "not_sent");
            assert!(stderr.is_empty());
        }
        if mode == "match" {
            assert_eq!(data["data"]["to"]["version"], "999.0.0");
            assert_eq!(data["data"]["to"]["commit"], "a".repeat(40));
            assert_eq!(data["data"]["changes"], "New commands.\u{1b}[31m");
        }
        if mode == "old" {
            assert_eq!(data["data"]["state"], "up_to_date");
        }
    }
    if mode == "match" {
        assert_eq!(fs::read(&exe).unwrap(), binary);
        assert_eq!(fs::read(dir.path().join("polis.prev")).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    } else {
        assert_eq!(fs::read(&exe).unwrap(), original);
        assert_eq!(
            fs::read(dir.path().join("polis.prev")).unwrap(),
            b"older backup"
        );
    }
    assert_eq!(
        fs::read(config.join("profiles.json")).unwrap(),
        b"invalid config; must not be read"
    );
}
#[test]
fn checksum_match_atomically_installs_and_keeps_previous() {
    run("match", true, false);
}
#[test]
fn checksum_mismatch_keeps_installed_binary_and_backup() {
    run("mismatch", true, false);
}
#[test]
fn no_newer_version_does_not_replace() {
    run("old", true, false);
}
#[test]
fn platform_missing_does_not_replace() {
    run("missing", true, false);
}
#[test]
fn environment_source_and_human_output() {
    run("match", false, true);
}
#[test]
fn manifest_and_archive_rejections_preserve_installation() {
    for mode in [
        "wrong_target",
        "unverified",
        "binary_hash",
        "duplicate",
        "symlink",
    ] {
        run(mode, true, false);
    }
}
#[test]
fn invalid_release_url_fails_before_network_or_credentials() {
    for url in [
        "http://example.com/releases",
        "https://user:password@example.com/releases",
        "file:///tmp/release",
        "https://example.com/releases?token=secret",
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_polis"))
            .args(["update", "--release-base-url", url, "--json"])
            .env("POLIS_KEYCHAIN", "off")
            .output()
            .unwrap();
        assert!(!out.status.success());
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(!text.contains("password"));
        assert!(!text.contains("token=secret"));
    }
}

#[test]
fn offline_distributor_preserves_installation() {
    run("offline", true, false);
}
#[test]
fn missing_release_preserves_installation() {
    run("not_found", true, false);
    run("empty", true, false);
}
#[cfg(unix)]
#[test]
fn permission_denied_install_directory_preserves_installation() {
    run("denied_lock", true, false);
    run("denied_staging", true, false);
}
#[test]
fn version_plain_and_json_make_no_release_or_proxy_requests() {
    let (server, _) = server("match");
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().join("profiles.json");
    fs::write(&profile, b"invalid profile; must not be read").unwrap();
    for args in [vec!["--version"], vec!["--version", "--json"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_polis"))
            .args(&args)
            .env("POLIS_CONFIG_DIR", dir.path())
            .env("POLIS_KEYCHAIN", "off")
            .env("POLIS_SITE", "unconfigured-site")
            .env("POLIS_RELEASE_BASE_URL", &server.base)
            .env("HTTP_PROXY", &server.base)
            .env("HTTPS_PROXY", &server.base)
            .env("ALL_PROXY", &server.base)
            .env("NO_PROXY", "")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stderr.is_empty());
        let stdout = String::from_utf8(out.stdout).unwrap();
        let expected = format!(
            "polis {} (commit {}; {})",
            env!("CARGO_PKG_VERSION"),
            env!("POLIS_BUILD_COMMIT"),
            env!("POLIS_BUILD_SOURCE")
        );
        if args.contains(&"--json") {
            let data: Value = serde_json::from_str(&stdout).unwrap();
            assert_eq!(data["ok"], true);
            assert_eq!(data["data"]["help"].as_str().unwrap().trim(), expected);
        } else {
            assert_eq!(stdout.trim(), expected);
        }
        assert_eq!(server.requests.load(Ordering::SeqCst), 0);
        assert_eq!(
            fs::read(&profile).unwrap(),
            b"invalid profile; must not be read"
        );
    }
}
