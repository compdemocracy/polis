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
    cmd.env_remove("POLIS_TOKEN").env_remove("POLIS_SITE");
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
            if status == 0 {
                continue;
            }
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
fn json_res(v: Value) -> (u16, &'static str, String) {
    (200, "application/json", v.to_string())
}

const TOKEN: &str = "participant-secret-fixture";
const LOGIN: &str = "returning-secret-fixture";
fn receipt() -> Value {
    json!({"status":"ok","auth":{"token":TOKEN,"token_type":"Bearer"},"login_code":LOGIN})
}
fn bootstrap(enrolled: bool) -> Value {
    json!({"conversation":{"conversation_id":"2demo"},"ptpt": if enrolled {json!({"pid":0})} else {Value::Null}})
}
fn private(dir: &std::path::Path) -> Vec<Value> {
    use std::os::unix::fs::PermissionsExt;
    let d = dir.join("credentials");
    assert_eq!(
        std::fs::metadata(&d).unwrap().permissions().mode() & 0o777,
        0o700
    );
    std::fs::read_dir(d)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            assert_eq!(
                std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
            (p.extension().unwrap() == "json")
                .then(|| serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap())
        })
        .collect()
}
#[test]
fn anonymous_bootstrap_never_enrolls_or_uses_account_token() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![json_res(bootstrap(false)), json_res(bootstrap(false))],
    );
    for _ in 0..2 {
        let (code, v) = call(d.path(), &["join", "2demo"], None, true);
        assert_eq!(code, 0);
        assert_eq!(v["data"]["state"], "ready_not_enrolled");
        assert_eq!(v["data"]["credentials_saved"], false);
    }
    for r in t.join().unwrap() {
        assert!(r.starts_with("GET /api/v3/participationInit?"));
        assert!(!r.to_lowercase().contains("authorization:"));
    }
    assert!(private(d.path()).is_empty());
}
#[test]
fn invite_stores_private_secrets_and_plain_join_reuses_token() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![
            (201, "application/json", receipt().to_string()),
            json_res(bootstrap(true)),
        ],
    );
    let (code, v) = call(
        d.path(),
        &["join", "2demo", "--invite", "invitation-secret-fixture"],
        None,
        true,
    );
    assert_eq!(code, 0);
    assert_eq!(v["data"]["state"], "enrolled");
    let (code, v) = call(d.path(), &["join", "2demo"], None, true);
    assert_eq!(code, 0);
    assert!(!v.to_string().contains(TOKEN));
    assert!(!v.to_string().contains(LOGIN));
    let req = t.join().unwrap();
    assert!(req[0].starts_with("POST /api/v3/treevite/acceptInvite "));
    assert!(!req[0].contains("fixture-token"));
    assert!(req[1].contains(TOKEN));
    let records = private(d.path());
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["token"], TOKEN);
    assert_eq!(records[0]["participant_login"], LOGIN);
}
#[test]
fn returning_login_is_explicit_and_stores_supplied_login_code() {
    let d = tempfile::tempdir().unwrap();
    let mut r = receipt();
    r.as_object_mut().unwrap().remove("login_code");
    let t = server(d.path(), vec![json_res(r)]);
    let (code, v) = call(
        d.path(),
        &["join", "2demo", "--login-code", LOGIN],
        None,
        false,
    );
    assert_eq!(code, 0);
    assert!(!v.to_string().contains(LOGIN));
    assert!(t.join().unwrap()[0].starts_with("POST /api/v3/treevite/login "));
    assert_eq!(private(d.path())[0]["participant_login"], LOGIN);
}
#[test]
fn conversation_profile_and_origin_are_separate_and_origin_is_normalized() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![
            json_res(receipt()),
            json_res(json!({"conversation":{"conversation_id":"3other"},"ptpt":null})),
            json_res(bootstrap(false)),
            json_res(bootstrap(true)),
        ],
    );
    assert_eq!(
        call(
            d.path(),
            &["join", "2demo", "--invite", "invite"],
            None,
            false
        )
        .0,
        0
    );
    assert_eq!(call(d.path(), &["join", "3other"], None, false).0, 0);
    let p = d.path().join("profiles.json");
    let original = std::fs::read_to_string(&p).unwrap();
    std::fs::write(&p, original.replace("local", "other")).unwrap();
    assert_eq!(call(d.path(), &["join", "2demo"], None, false).0, 0);
    let mut conf: Value = serde_json::from_str(&original).unwrap();
    conf["sites"]["local"] = json!(format!("{}/", conf["sites"]["local"].as_str().unwrap()));
    std::fs::write(&p, conf.to_string()).unwrap();
    assert_eq!(call(d.path(), &["join", "2demo"], None, false).0, 0);
    let rs = t.join().unwrap();
    assert!(!rs[1].contains(TOKEN));
    assert!(!rs[2].contains(TOKEN));
    assert!(rs[3].contains(TOKEN));
    let t = server(d.path(), vec![json_res(bootstrap(false))]);
    assert_eq!(call(d.path(), &["join", "2demo"], None, false).0, 0);
    assert!(!t.join().unwrap()[0].contains(TOKEN));
}
#[test]
fn bootstrap_issued_token_is_saved_for_next_action() {
    let d = tempfile::tempdir().unwrap();
    let mut b = bootstrap(true);
    b["auth"] = receipt()["auth"].clone();
    let t = server(d.path(), vec![json_res(b)]);
    assert_eq!(call(d.path(), &["join", "2demo"], None, false).0, 0);
    t.join().unwrap();
    assert_eq!(private(d.path())[0]["token"], TOKEN);
}
#[test]
fn uncertain_invite_is_not_retried_and_correlation_secrets_are_removed() {
    for status in [0, 500, 302] {
        let d = tempfile::tempdir().unwrap();
        let t = server(
            d.path(),
            vec![(
                status,
                "application/json",
                json!({"error":LOGIN}).to_string(),
            )],
        );
        let (code, v) = call(d.path(), &["join", "2demo", "--invite", LOGIN], None, false);
        assert_eq!(code, if status == 302 { 1 } else { 7 });
        assert!(!v.to_string().contains(LOGIN));
        assert_eq!(t.join().unwrap().len(), 1);
        assert!(private(d.path()).is_empty());
    }
}
#[test]
fn malformed_success_never_leaks_or_claims_saved_credentials() {
    for response in [
        json!({"status":"ok"}),
        json!({"status":"ok","auth":{"token":TOKEN,"token_type":"Basic"},"login_code":LOGIN}),
    ] {
        let d = tempfile::tempdir().unwrap();
        let t = server(d.path(), vec![json_res(response)]);
        let (code, v) = call(d.path(), &["join", "2demo", "--invite", LOGIN], None, false);
        assert_eq!(code, 7);
        assert!(!v.to_string().contains(TOKEN));
        assert!(!v.to_string().contains(LOGIN));
        t.join().unwrap();
        assert!(private(d.path()).is_empty());
    }
}
#[test]
fn accepted_invite_keeps_its_issued_token_when_the_login_code_is_missing() {
    // The invite is spent once Node answers; a valid Bearer token is the only way
    // back in, so it is saved before the rest of the receipt is checked.
    for login in [json!(null), json!(""), json!(7)] {
        let d = tempfile::tempdir().unwrap();
        let t = server(
            d.path(),
            vec![json_res(
                json!({"status":"ok","auth":{"token":TOKEN,"token_type":"Bearer"},"login_code":login}),
            )],
        );
        let (code, v) = call(d.path(), &["join", "2demo", "--invite", LOGIN], None, false);
        assert_eq!(code, 7, "{v}");
        assert!(!v.to_string().contains(TOKEN));
        t.join().unwrap();
        let records = private(d.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["token"], TOKEN);
        assert!(records[0]
            .get("participant_login")
            .is_none_or(Value::is_null));
    }
}
#[test]
fn invalid_bootstrap_is_rejected_without_saving() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![json_res(json!({"conversation":null,"ptpt":null}))],
    );
    assert_eq!(call(d.path(), &["join", "2demo"], None, false).0, 1);
    t.join().unwrap();
}
#[test]
fn unsafe_store_refused_before_invite_is_consumed() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for symlinked in [false, true] {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("profiles.json"),
            r#"{"default":"local","sites":{"local":"http://127.0.0.1:1"}}"#,
        )
        .unwrap();
        if symlinked {
            symlink(d.path(), d.path().join("credentials")).unwrap();
        } else {
            std::fs::create_dir(d.path().join("credentials")).unwrap();
            std::fs::set_permissions(
                d.path().join("credentials"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let (code, v) = call(d.path(), &["join", "2demo", "--invite", LOGIN], None, false);
        assert_eq!(code, 3);
        assert_eq!(v["error"]["code"], "credential_file_unsafe");
    }
}
#[test]
fn conflicting_secrets_are_redacted_in_human_parser_errors() {
    let d = tempfile::tempdir().unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_polis"))
        .env("POLIS_CONFIG_DIR", d.path())
        .args(["join", "2demo", "--invite", TOKEN, "--login-code", LOGIN])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    for bytes in [&o.stdout, &o.stderr] {
        let s = String::from_utf8_lossy(bytes);
        assert!(!s.contains(TOKEN));
        assert!(!s.contains(LOGIN));
    }
}

#[test]
fn claimed_membership_without_credentials_is_not_reported_as_joined() {
    let d = tempfile::tempdir().unwrap();
    let t = server(d.path(), vec![json_res(bootstrap(true))]);
    assert_eq!(call(d.path(), &["join", "2demo"], None, false).0, 1);
    t.join().unwrap();
}
#[test]
fn upstream_correlation_header_cannot_echo_submitted_code() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![(
            400,
            "application/json\r\nX-Request-Id: returning-secret-fixture",
            json!({"error":LOGIN}).to_string(),
        )],
    );
    let (code, v) = call(d.path(), &["join", "2demo", "--invite", LOGIN], None, false);
    assert_eq!(code, 1);
    assert!(!v.to_string().contains(LOGIN));
    t.join().unwrap();
}

#[test]
fn join_is_discoverable_in_help_and_schema_without_a_profile() {
    let d = tempfile::tempdir().unwrap();
    let (code, v) = call(d.path(), &["schema", "join"], None, false);
    assert_eq!(code, 0);
    assert_eq!(v["data"]["implemented"], true);
    let (code, v) = call(d.path(), &["help", "join"], None, false);
    assert_eq!(code, 0);
    assert!(v["data"]["help"].as_str().unwrap().contains("--login-code"));
}
