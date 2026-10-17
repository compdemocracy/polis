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
    server_then(dir, responses, None)
}
fn server_then(
    dir: &std::path::Path,
    responses: Vec<(u16, &'static str, String)>,
    before_response: Option<Box<dyn Fn() + Send>>,
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
            if let Some(hook) = &before_response {
                hook();
            }
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
fn vote_receipt() -> Value {
    json!({"currentPid":0,"auth":{"token":TOKEN,"token_type":"Bearer"},"nextComment":{"tid":1,"txt":"next"}})
}
#[test]
fn first_vote_needs_no_join_or_account_and_reuses_token_for_all_choices() {
    use polis_contracts::votes::VoteChoice;
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![
            json_res(vote_receipt()),
            json_res(json!({"currentPid":0})),
            json_res(json!({"currentPid":0})),
        ],
    );
    for (tid, flag, choice) in [
        ("0", "--agree", VoteChoice::Agree),
        ("1", "--disagree", VoteChoice::Disagree),
        ("2", "--pass", VoteChoice::Pass),
    ] {
        let (code, v) = call(
            d.path(),
            &["vote", "2demo", "--statement", tid, flag],
            None,
            true,
        );
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["choice"], choice.name());
        assert_eq!(v["data"]["state"], "recorded");
        assert!(!v.to_string().contains(TOKEN));
        assert!(v["data"].get("nextComment").is_none());
    }
    let rs = t.join().unwrap();
    assert!(!rs[0].to_lowercase().contains("authorization:"));
    for (r, choice) in rs
        .iter()
        .zip([VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass])
    {
        assert!(r.starts_with("POST /api/v3/votes "));
        let body: Value = serde_json::from_str(r.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["vote"], choice.wire());
        assert_eq!(body["conversation_id"], "2demo");
        assert_eq!(body.as_object().unwrap().len(), 3);
    }
    assert!(rs[1].contains(TOKEN));
    assert!(rs[2].contains(TOKEN));
    assert_eq!(private(d.path())[0]["token"], TOKEN);
}
#[test]
fn invite_vote_reuses_participant_and_preserves_returning_login_secret() {
    let d = tempfile::tempdir().unwrap();
    let t = server(
        d.path(),
        vec![json_res(receipt()), json_res(vote_receipt())],
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
    assert_eq!(
        call(
            d.path(),
            &["vote", "2demo", "--statement", "0", "--agree"],
            None,
            false
        )
        .0,
        0
    );
    let rs = t.join().unwrap();
    assert!(rs[1].contains(TOKEN));
    assert_eq!(private(d.path())[0]["participant_login"], LOGIN);
}
#[test]
fn votes_are_isolated_by_conversation_profile_and_origin() {
    let d = tempfile::tempdir().unwrap();
    let t = server(d.path(), vec![json_res(vote_receipt()); 4]);
    let path = d.path().join("profiles.json");
    let original = std::fs::read_to_string(&path).unwrap();
    for conv in ["2demo", "3other"] {
        assert_eq!(
            call(
                d.path(),
                &["vote", conv, "--statement", "0", "--agree"],
                None,
                false
            )
            .0,
            0
        );
    }
    std::fs::write(&path, original.replace("local", "other")).unwrap();
    assert_eq!(
        call(
            d.path(),
            &["vote", "2demo", "--statement", "0", "--agree"],
            None,
            false
        )
        .0,
        0
    );
    std::fs::write(&path, original).unwrap();
    assert_eq!(
        call(
            d.path(),
            &["vote", "2demo", "--statement", "1", "--pass"],
            None,
            false
        )
        .0,
        0
    );
    let rs = t.join().unwrap();
    for r in &rs[..3] {
        assert!(!r.contains(TOKEN));
    }
    assert!(rs[3].contains(TOKEN));
    let t = server(d.path(), vec![json_res(vote_receipt())]);
    assert_eq!(
        call(
            d.path(),
            &["vote", "2demo", "--statement", "0", "--agree"],
            None,
            false
        )
        .0,
        0
    );
    assert!(!t.join().unwrap()[0].contains(TOKEN));
}
#[test]
fn malformed_receipts_are_unknown_but_valid_issued_tokens_are_retained() {
    for response in [
        json!({}),
        json!({"currentPid":0}),
        json!({"auth":{"token":TOKEN,"token_type":"Bearer"}}),
        json!({"currentPid":0,"auth":{"token":TOKEN,"token_type":"Basic"}}),
    ] {
        let d = tempfile::tempdir().unwrap();
        let t = server(d.path(), vec![json_res(response.clone())]);
        let (code, v) = call(
            d.path(),
            &["vote", "2demo", "--statement", "0", "--agree"],
            None,
            false,
        );
        assert_eq!(code, 7);
        assert_eq!(v["error"]["outcome"], "unknown");
        assert!(!v.to_string().contains(TOKEN));
        assert_eq!(
            private(d.path()).len(),
            usize::from(response["auth"]["token_type"] == "Bearer")
        );
        assert_eq!(t.join().unwrap().len(), 1);
    }
}
#[test]
fn failed_votes_do_not_retry_or_echo_upstream_credentials() {
    for (status, exit) in [(0, 7), (500, 7), (403, 4), (401, 3), (406, 1), (302, 7)] {
        let d = tempfile::tempdir().unwrap();
        let t = server(
            d.path(),
            vec![(
                status,
                "application/json\r\nX-Request-Id: participant-secret-fixture",
                json!({"error":TOKEN}).to_string(),
            )],
        );
        let (code, v) = call(
            d.path(),
            &["vote", "2demo", "--statement", "0", "--agree"],
            None,
            false,
        );
        assert_eq!(code, exit);
        assert!(!v.to_string().contains(TOKEN));
        assert_eq!(t.join().unwrap().len(), 1);
    }
}
#[test]
fn a_redirected_vote_is_unknown_and_not_retried_but_a_redirected_read_is_refused() {
    // The site may store a vote before redirecting, so only a read-back can tell.
    let redirect = || {
        vec![(
            302,
            "application/json\r\nLocation: https://elsewhere.example/api/v3/votes",
            "{}".to_string(),
        )]
    };
    let d = tempfile::tempdir().unwrap();
    let t = server(d.path(), redirect());
    let (code, v) = call(
        d.path(),
        &["vote", "2demo", "--statement", "0", "--agree"],
        None,
        false,
    );
    assert_eq!(code, 7, "{v}");
    assert_eq!(v["error"]["code"], "redirect_outcome_unknown");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert_eq!(v["error"]["upstream"]["status"], 302);
    assert!(v["error"]["action"]
        .as_str()
        .unwrap()
        .starts_with("Read back before retrying"));
    assert_eq!(t.join().unwrap().len(), 1);
    assert!(private(d.path()).is_empty());

    let d = tempfile::tempdir().unwrap();
    let t = server(d.path(), redirect());
    let (code, v) = call(
        d.path(),
        &["vote", "list", "--conversation", "2demo", "--pid", "0"],
        None,
        true,
    );
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"]["code"], "redirect_refused");
    assert_eq!(v["error"]["outcome"], "rejected");
    assert_eq!(t.join().unwrap().len(), 1);
}
#[test]
fn invalid_noninteractive_choices_fail_before_any_request() {
    let d = tempfile::tempdir().unwrap();
    for args in [
        vec!["vote"],
        vec!["vote", "2demo"],
        vec!["vote", "2demo", "--statement", "0"],
        vec!["vote", "2demo", "--agree"],
        vec!["vote", "2demo", "--statement", "0", "--agree", "--pass"],
        vec!["vote", "2demo", "--statement", "2147483648", "--agree"],
        vec!["vote", "2demo", "list", "--conversation", "2demo"],
    ] {
        assert_eq!(call(d.path(), &args, None, false).0, 2);
    }
}
#[test]
fn unsafe_store_refuses_before_first_vote() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    std::fs::write(
        d.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:1"}}"#,
    )
    .unwrap();
    std::fs::create_dir(d.path().join("credentials")).unwrap();
    std::fs::set_permissions(
        d.path().join("credentials"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let (code, v) = call(
        d.path(),
        &["vote", "2demo", "--statement", "0", "--agree"],
        None,
        false,
    );
    assert_eq!(code, 3);
    assert_eq!(v["error"]["code"], "credential_file_unsafe");
}
#[test]
fn vote_discovery_and_legacy_vote_list_remain_available() {
    let d = tempfile::tempdir().unwrap();
    for path in [vec!["schema", "vote"], vec!["schema", "vote", "list"]] {
        let (code, v) = call(d.path(), &path, None, false);
        assert_eq!(code, 0);
        assert_eq!(v["data"]["implemented"], true);
    }
    let t = server(d.path(), vec![json_res(json!([]))]);
    assert_eq!(
        call(
            d.path(),
            &["vote", "list", "--conversation", "2demo", "--pid", "0"],
            None,
            true
        )
        .0,
        0
    );
    assert!(t.join().unwrap()[0].starts_with("GET /api/v3/votes?"));
}

#[test]
fn credential_save_failure_after_vote_response_is_unknown_and_not_retried() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("credentials");
    let t = server_then(
        d.path(),
        vec![json_res(vote_receipt())],
        Some(Box::new(move || {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        })),
    );
    let (code, v) = call(
        d.path(),
        &["vote", "2demo", "--statement", "0", "--agree"],
        None,
        false,
    );
    assert_eq!(code, 7);
    assert_eq!(v["error"]["code"], "participant_credentials_not_saved");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert!(!v.to_string().contains(TOKEN));
    assert_eq!(t.join().unwrap().len(), 1);
}
