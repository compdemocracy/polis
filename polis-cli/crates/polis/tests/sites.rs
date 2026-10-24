use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::{Command, Stdio},
};

fn call(dir: &Path, args: &[&str], env: &[(&str, &str)], input: Option<&str>) -> (i32, Value) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("POLIS_") {
            c.env_remove(key);
        }
    }
    c.env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_KEYCHAIN", "off")
        .envs(env.iter().copied())
        .args(args)
        .args(["--json", "--no-interactive"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(!text.contains("fixture-secret"));
    (
        out.status.code().unwrap(),
        serde_json::from_str(&text).unwrap_or_else(|_| panic!("{text}")),
    )
}
fn ok(dir: &Path, args: &[&str]) -> Value {
    let (code, v) = call(dir, args, &[], None);
    assert_eq!(code, 0, "{v}");
    v["data"].clone()
}
fn stored(dir: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("profiles.json")).unwrap()).unwrap()
}

#[test]
fn fresh_install_lists_pol_is_without_creating_configuration_or_credentials() {
    let t = tempfile::tempdir().unwrap();
    let v = ok(t.path(), &["site", "list"]);
    assert_eq!(v["selected"], "prod");
    assert!(v["sites"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["name"] == "prod" && r["url"] == "https://pol.is"));
    assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 0);
}

#[test]
fn add_use_remove_and_auth_settings_preserve_default_and_private_file() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempfile::tempdir().unwrap();
    ok(
        t.path(),
        &[
            "site",
            "add",
            "eu",
            "https://eu.example.org",
            "--issuer",
            "https://login.example.org/tenant/",
            "--client-id",
            "public-client",
            "--audience",
            "users",
        ],
    );
    let v = stored(t.path());
    assert_eq!(v["default"], "prod");
    assert_eq!(v["sites"]["eu"], "https://eu.example.org/");
    assert_eq!(
        v["auth"]["eu"]["issuer"],
        "https://login.example.org/tenant/"
    );
    assert_eq!(v["auth"]["eu"]["client_id"], "public-client");
    assert_eq!(
        std::fs::metadata(t.path().join("profiles.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    ok(t.path(), &["site", "use", "eu"]);
    assert_eq!(ok(t.path(), &["site", "list"])["selected"], "eu");
    ok(t.path(), &["site", "remove", "eu"]);
    assert_eq!(stored(t.path())["default"], "prod");
    assert!(stored(t.path())["sites"].get("eu").is_none());
    assert!(stored(t.path())["auth"].get("eu").is_none());
    assert!(!t.path().join("credentials").exists());
}

#[test]
fn cli_site_wins_over_environment_and_environment_is_not_persisted() {
    let t = tempfile::tempdir().unwrap();
    ok(t.path(), &["site", "add", "eu", "https://eu.example.org"]);
    let env = [
        ("POLIS_SITE", "eu"),
        ("POLIS_URL_EU", "https://override.example.org"),
        (
            "POLIS_AUTH_ISSUER_EU",
            "https://override-login.example.org/",
        ),
    ];
    let (code, v) = call(t.path(), &["site", "use", "local"], &env, None);
    assert_eq!(code, 0, "{v}");
    assert_eq!(stored(t.path())["default"], "local");
    assert_eq!(stored(t.path())["sites"]["eu"], "https://eu.example.org/");
    assert_eq!(stored(t.path())["auth"]["eu"]["issuer"], "");
    assert_eq!(
        call(t.path(), &["site", "list"], &env, None).1["data"]["selected"],
        "eu"
    );
    for args in [
        vec!["--site", "prod", "site", "list"],
        vec!["site", "list", "--site", "prod"],
    ] {
        let (code, v) = call(t.path(), &args, &env, None);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["selected"], "prod");
    }
    assert_eq!(
        call(
            t.path(),
            &["site", "list", "--site", "prod"],
            &[("POLIS_SITE", "INVALID!")],
            None
        )
        .0,
        0
    );
}

#[test]
fn invalid_additions_do_not_write_configuration() {
    for args in [
        vec!["site", "add", "BAD", "https://example.org"],
        vec!["site", "add", "eu", "http://example.org"],
        vec![
            "site",
            "add",
            "eu",
            "https://user:fixture-secret@example.org",
        ],
        vec!["site", "add", "eu", "https://example.org/path"],
        vec!["site", "add", "eu", "https://example.org/?x=1"],
        vec!["site", "add", "eu", "https://example.org/#x"],
        vec![
            "site",
            "add",
            "eu",
            "https://example.org",
            "--issuer",
            "http://issuer.example.org",
            "--client-id",
            "client",
        ],
        vec![
            "site",
            "add",
            "eu",
            "https://example.org",
            "--issuer",
            "https://issuer.example.org/",
        ],
    ] {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(call(t.path(), &args, &[], None).0, 2, "{args:?}");
        assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 0);
    }
}

#[test]
fn duplicates_unknown_sites_and_removing_prod_fail_without_changing_config() {
    let t = tempfile::tempdir().unwrap();
    ok(t.path(), &["site", "add", "dev", "http://127.0.0.1:5000"]);
    let before = std::fs::read(t.path().join("profiles.json")).unwrap();
    for args in [
        vec!["site", "add", "dev", "https://different.example.org"],
        vec!["site", "remove", "prod"],
        vec!["site", "remove", "missing"],
        vec!["site", "use", "missing"],
        vec!["site", "use", "preprod"],
    ] {
        assert_eq!(call(t.path(), &args, &[], None).0, 2, "{args:?}");
        assert_eq!(
            std::fs::read(t.path().join("profiles.json")).unwrap(),
            before
        );
    }
}

#[test]
fn updates_preserve_unknown_config_and_auth_fields() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), json!({"default":"custom","sites":{"custom":"https://example.org"},"future":{"opaque":true},"auth":{"custom":{"issuer":"","future_auth":5}}}).to_string()).unwrap();
    ok(t.path(), &["site", "add", "eu", "https://eu.example.org"]);
    ok(t.path(), &["site", "remove", "custom"]);
    let v = stored(t.path());
    assert_eq!(v["future"]["opaque"], true);
    assert_eq!(v["default"], "prod");
    assert_eq!(v["sites"]["prod"], "https://pol.is");
    assert!(v["auth"]["prod"]["client_id"].is_string());
    ok(
        t.path(),
        &["site", "add", "other", "https://other.example.org"],
    );
    let mut v = stored(t.path());
    v["auth"]["other"]["future_auth"] = json!(5);
    std::fs::write(t.path().join("profiles.json"), v.to_string()).unwrap();
    ok(t.path(), &["site", "use", "eu"]);
    assert_eq!(stored(t.path())["auth"]["other"]["future_auth"], 5);
}

#[test]
fn symlinks_hardlinks_and_shared_write_permissions_are_refused() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for kind in ["symlink", "hardlink", "writable"] {
        let t = tempfile::tempdir().unwrap();
        let original = t.path().join("original.json");
        let bytes = json!({"default":"prod","sites":{"prod":"https://pol.is"}}).to_string();
        std::fs::write(&original, &bytes).unwrap();
        let config = t.path().join("profiles.json");
        match kind {
            "symlink" => symlink(&original, &config).unwrap(),
            "hardlink" => std::fs::hard_link(&original, &config).unwrap(),
            _ => {
                std::fs::copy(&original, &config).unwrap();
                std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o666)).unwrap();
            }
        }
        assert_eq!(
            call(
                t.path(),
                &["site", "add", "eu", "https://eu.example.org"],
                &[],
                None
            )
            .0,
            2
        );
        assert_eq!(std::fs::read_to_string(&original).unwrap(), bytes);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), bytes);
    }
}

#[test]
fn site_commands_do_not_read_credential_store() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("credentials"), "unreadable-as-a-directory").unwrap();
    ok(t.path(), &["site", "add", "eu", "https://eu.example.org"]);
    ok(t.path(), &["site", "use", "eu"]);
    ok(t.path(), &["site", "list"]);
    ok(t.path(), &["site", "remove", "eu"]);
}

#[test]
fn listing_rejects_credential_bearing_urls_without_echoing_them() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), json!({
        "default":"prod", "sites":{"prod":"https://pol.is","unsafe":"https://user:fixture-secret@example.org"}
    }).to_string()).unwrap();
    assert_eq!(call(t.path(), &["site", "list"], &[], None).0, 2);
}

#[test]
fn concurrent_configuration_writer_is_refused_without_lost_updates() {
    use std::os::fd::AsRawFd;
    let t = tempfile::tempdir().unwrap();
    ok(t.path(), &["site", "add", "one", "https://one.example.org"]);
    let before = std::fs::read(t.path().join("profiles.json")).unwrap();
    let lock = std::fs::File::open(t.path().join("profiles.lock")).unwrap();
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let (code, v) = call(
        t.path(),
        &["site", "add", "two", "https://two.example.org"],
        &[],
        None,
    );
    assert_eq!(code, 2, "{v}");
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Another polis command"));
    assert_eq!(
        std::fs::read(t.path().join("profiles.json")).unwrap(),
        before
    );
    drop(lock);
    ok(t.path(), &["site", "add", "two", "https://two.example.org"]);
    assert_eq!(stored(t.path())["sites"]["one"], "https://one.example.org/");
    assert_eq!(stored(t.path())["sites"]["two"], "https://two.example.org/");
}

#[test]
fn account_signins_are_separate_even_for_aliases_on_the_same_origin() {
    let t = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..4 {
            let start = std::time::Instant::now();
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(start.elapsed().as_secs() < 10);
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                let mut buf = [0; 1024];
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            requests.push(String::from_utf8(bytes).unwrap());
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        }
        requests
    });
    for name in ["one", "two"] {
        ok(t.path(), &["site", "add", name, &origin]);
    }
    assert_eq!(
        call(
            t.path(),
            &["--site", "one", "auth", "login", "--with-token"],
            &[],
            Some("fixture-secret-one\n")
        )
        .0,
        0
    );
    assert_eq!(
        call(t.path(), &["--site", "two", "auth", "status"], &[], None).0,
        3
    );
    assert_eq!(
        call(
            t.path(),
            &["--site", "one", "auth", "status"],
            &[("POLIS_URL_ONE", "http://127.0.0.1:1")],
            None
        )
        .0,
        3
    );
    assert_eq!(
        call(
            t.path(),
            &["--site", "two", "auth", "login", "--with-token"],
            &[],
            Some("fixture-secret-two\n")
        )
        .0,
        0
    );
    ok(t.path(), &["--site", "one", "auth", "status"]);
    ok(t.path(), &["--site", "two", "auth", "status"]);
    let requests = server.join().unwrap();
    for (r, token) in requests.iter().zip(["one", "two", "one", "two"]) {
        assert!(r
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer fixture-secret-{token}")));
    }
    // Removing configuration neither reads nor changes the credentials.
    let credentials: Vec<_> = std::fs::read_dir(t.path().join("credentials"))
        .unwrap()
        .map(|p| {
            let p = p.unwrap().path();
            (p.clone(), std::fs::read(p).unwrap())
        })
        .collect();
    ok(t.path(), &["site", "remove", "one"]);
    for (p, bytes) in credentials {
        assert_eq!(std::fs::read(p).unwrap(), bytes);
    }
}

#[test]
fn default_reset_and_one_command_override_preserve_aliases() {
    let t = tempfile::tempdir().unwrap();
    ok(t.path(), &["site", "add", "eu", "https://eu.example.org"]);
    ok(t.path(), &["site", "use", "eu"]);
    assert_eq!(ok(t.path(), &["site", "list"])["selected"], "eu");
    assert_eq!(
        ok(t.path(), &["--site", "default", "site", "list"])["selected"],
        "prod"
    );
    assert_eq!(stored(t.path())["default"], "eu");
    ok(t.path(), &["site", "use", "default"]);
    assert_eq!(stored(t.path())["default"], "prod");
    assert_eq!(ok(t.path(), &["site", "list"])["selected"], "prod");
    assert_eq!(stored(t.path())["sites"]["eu"], "https://eu.example.org/");
    assert!(!t.path().join("credentials").exists());
    for args in [
        vec!["site", "add", "default", "https://example.org"],
        vec!["site", "remove", "default"],
    ] {
        assert_eq!(call(t.path(), &args, &[], None).0, 2);
    }
}

#[test]
fn default_reset_restores_missing_builtin_profile() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        json!({"default":"custom","sites":{"custom":"https://example.org"}}).to_string(),
    )
    .unwrap();
    ok(t.path(), &["site", "use", "default"]);
    assert_eq!(
        ok(t.path(), &["conversation", "share", "2p027generated"])["participation_url"],
        "https://pol.is/2p027generated"
    );
    assert!(stored(t.path())["auth"]["prod"]["client_id"].is_string());
}

#[test]
fn callback_port_is_persisted_and_invalid_values_never_write() {
    let t = tempfile::tempdir().unwrap();
    ok(
        t.path(),
        &[
            "site",
            "add",
            "eu",
            "https://eu.example.org",
            "--issuer",
            "https://login.example.org/",
            "--client-id",
            "native-client",
            "--callback-port",
            "54321",
        ],
    );
    assert_eq!(stored(t.path())["auth"]["eu"]["callback_port"], 54321);
    for port in ["0", "65536", "-1", "not-a-port"] {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(
            call(
                t.path(),
                &[
                    "site",
                    "add",
                    "eu",
                    "https://eu.example.org",
                    "--issuer",
                    "https://login.example.org/",
                    "--client-id",
                    "native-client",
                    "--callback-port",
                    port
                ],
                &[],
                None
            )
            .0,
            2
        );
        assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 0);
    }
}

fn human(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> std::process::Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("POLIS_") {
            c.env_remove(key);
        }
    }
    c.env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_KEYCHAIN", "off")
        .envs(env.iter().copied())
        .args(args)
        .arg("--no-interactive")
        .output()
        .unwrap()
}

#[test]
fn human_headers_identify_effective_origin_and_json_stays_clean() {
    let t = tempfile::tempdir().unwrap();
    ok(t.path(), &["site", "add", "eu", "https://eu.example.org"]);
    let args = ["--site", "eu", "conversation", "share", "2p027generated"];
    let out = human(t.path(), &args, &[]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("Site: eu (https://eu.example.org)\n"));
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        value["participation_url"],
        "https://eu.example.org/2p027generated"
    );
    let out = human(
        t.path(),
        &[
            "--site",
            "eu",
            "conversation",
            "share",
            "2p027generated",
            "--json",
        ],
        &[],
    );
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["site"],
        "eu"
    );
    let out = human(t.path(), &["conversation", "share", "2p027generated"], &[]);
    assert!(out.stderr.is_empty());
    let out = human(
        t.path(),
        &["conversation", "share", "2p027generated"],
        &[("POLIS_URL_PROD", "http://127.0.0.1:5000")],
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).starts_with("Site: prod (http://127.0.0.1:5000)\n")
    );
    let out = human(t.path(), &["site", "use", "eu"], &[]);
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("Site: eu (https://eu.example.org)\n"));
    let out = human(t.path(), &["site", "use", "default"], &[]);
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
}

#[test]
fn site_headers_cover_errors_but_do_not_change_offline_discovery() {
    let t = tempfile::tempdir().unwrap();
    ok(t.path(), &["site", "add", "eu", "https://eu.example.org"]);
    ok(t.path(), &["site", "use", "eu"]);
    let out = human(
        t.path(),
        &["comment", "stats", "--conversation", "invalid/id"],
        &[],
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("Site: eu (https://eu.example.org)\n"));
    for args in [vec!["help"], vec!["questions"], vec!["completion", "bash"]] {
        let out = human(t.path(), &args, &[]);
        assert!(out.status.success());
        assert!(out.stderr.is_empty());
    }
}

#[test]
fn headers_use_a_normalized_origin_without_terminal_controls() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        json!({"default":"custom","sites":{"custom":"\nhttps://example.org\t"}}).to_string(),
    )
    .unwrap();
    let out = human(t.path(), &["conversation", "share", "2p027generated"], &[]);
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Site: custom (https://example.org)\n"
    );
}
