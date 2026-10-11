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
fn parsed_call(dir: &std::path::Path, args: &[&str]) -> (i32, Value) {
    call(dir, args, None, true)
}
#[test]
fn close_and_reopen_confirm_state_and_use_exact_endpoints() {
    for (action, active) in [("close", false), ("reopen", true)] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(json!({})), json_res(json!({"is_active":active}))],
        );
        let (exit, v) = parsed_call(t.path(), &["conversation", action, "convA"]);
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["is_active"], active);
        let requests = s.join().unwrap();
        assert!(requests[0].starts_with(&format!("POST /api/v3/conversation/{action} ")));
        assert!(requests[0].contains(r#""conversation_id":"convA""#));
        assert!(requests[1].starts_with("GET /api/v3/conversations?conversation_id=convA "));
    }
}
#[test]
fn successful_write_without_confirmation_remains_unknown() {
    for read in [
        json_res(json!({"is_active":true})),
        (
            503,
            "application/json",
            json!({"error":"failed"}).to_string(),
        ),
        json_res(json!({})),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!({})), read]);
        let (exit, v) = parsed_call(t.path(), &["conversation", "close", "convA"]);
        assert_eq!(exit, 7);
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(s.join().unwrap().len(), 2);
    }
}
#[test]
fn close_permission_failure_does_not_read_or_retry() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(403, "application/json", json!({}).to_string())],
    );
    let (exit, _) = parsed_call(t.path(), &["conversation", "close", "convA"]);
    assert_eq!(exit, 4);
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn participant_exports_preserve_cells_and_scope() {
    let raw = "pid,xid,vote_count\n0,000123,4\n1,\"=untrusted,a\",0\n";
    for format in ["csv", "json"] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(200, "text/csv", raw.into())]);
        let out = t.path().join("export");
        let (exit, v) = parsed_call(
            t.path(),
            &[
                "participant",
                "export",
                "--conversation",
                "convA",
                "--format",
                format,
                "--output",
                out.to_str().unwrap(),
            ],
        );
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["roster_complete"], false);
        let bytes = std::fs::read(out).unwrap();
        if format == "csv" {
            assert_eq!(bytes, raw.as_bytes());
        } else {
            let data: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(data["rows"][0][1], "000123");
            assert_eq!(data["rows"][1][1], "=untrusted,a");
        }
        assert!(s.join().unwrap()[0].starts_with("GET /api/v3/xids/csv?conversation_id=convA "));
    }
}
#[test]
fn participant_export_refuses_existing_path_and_symlink_before_http() {
    use std::os::unix::fs::symlink;
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let target = t.path().join("target");
    std::fs::write(&target, "keep").unwrap();
    let link = t.path().join("link");
    symlink(t.path().join("missing"), &link).unwrap();
    for path in [&target, &link] {
        assert_eq!(
            parsed_call(
                t.path(),
                &[
                    "participant",
                    "xid",
                    "export",
                    "--conversation",
                    "convA",
                    "--output",
                    path.to_str().unwrap()
                ]
            )
            .0,
            2
        );
    }
    assert_eq!(std::fs::read_to_string(target).unwrap(), "keep");
}
#[test]
fn export_refuses_html_without_publishing_a_file() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(200, "text/html", "<html>login</html>".into())],
    );
    let out = t.path().join("out");
    assert_eq!(
        parsed_call(
            t.path(),
            &[
                "participant",
                "export",
                "--conversation",
                "convA",
                "--output",
                out.to_str().unwrap()
            ]
        )
        .0,
        1
    );
    assert!(!out.exists());
    s.join().unwrap();
}
#[test]
fn report_json_preserves_duplicate_headers_and_numeric_strings() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(200, "text/csv", "value,value\n001,-1\n".into())],
    );
    let out = t.path().join("out");
    assert_eq!(
        parsed_call(
            t.path(),
            &[
                "report",
                "export",
                "rExample",
                "--type",
                "votes.csv",
                "--format",
                "json",
                "--output",
                out.to_str().unwrap()
            ]
        )
        .0,
        0
    );
    let v: Value = serde_json::from_slice(&std::fs::read(out).unwrap()).unwrap();
    assert_eq!(v["headers"], json!(["value", "value"]));
    assert_eq!(
        v["rows"],
        json!([["001", polis_contracts::votes::WIRE_AGREE_CELL]])
    );
    s.join().unwrap();
}
fn inputs(dir: &std::path::Path, vote: &str) -> (String, String) {
    let seeds = dir.join("seeds.csv");
    let votes = dir.join("votes.csv");
    std::fs::write(&seeds, "comment_text,original_id\nStatement,external-A\n").unwrap();
    std::fs::write(&votes,format!("vote_id,user_id,vote_value,timestamp,comment_id\nv1,p1,{vote},2026-01-01T00:00:00Z,external-A\n")).unwrap();
    (
        seeds.to_str().unwrap().into(),
        votes.to_str().unwrap().into(),
    )
}
#[test]
fn seed_votes_preserve_both_signs_and_map_identifiers() {
    for (sign, vote) in [
        (
            polis_contracts::votes::SOURCE_AGREE_EXPORT,
            polis_contracts::votes::EXPORT_AGREE_CELL,
        ),
        (
            polis_contracts::votes::SOURCE_AGREE_WIRE,
            polis_contracts::votes::WIRE_AGREE_CELL,
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let (seed, votes) = inputs(t.path(), vote);
        let s = server(
            t.path(),
            vec![
                json_res(json!({"results":[{"status":"success"}]})),
                json_res(json!({"status":"processing"})),
            ],
        );
        let (exit, v) = parsed_call(
            t.path(),
            &[
                "seed",
                "import",
                &seed,
                "--conversation",
                "convA",
                "--votes",
                &votes,
                "--source-agree",
                sign,
            ],
        );
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["state"], "processing");
        let req = s.join().unwrap();
        let body: Value = serde_json::from_str(req[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let csv = body["csv"].as_str().unwrap();
        assert!(csv.starts_with(&format!("# vote-convention: agree={sign};")));
        assert!(csv.contains(&format!("v1,p1,{vote},")));
        assert!(!csv.contains("external-A"));
        assert!(csv.contains(
            v["data"]["seeds"]["id_mapping"][0]["submitted_original_id"]
                .as_str()
                .unwrap()
        ));
    }
}
#[test]
fn seed_votes_invalid_or_undeclared_inputs_make_no_request() {
    for vote in ["2", "true", " 1"] {
        let t = tempfile::tempdir().unwrap();
        let (seed, votes) = inputs(t.path(), vote);
        assert_eq!(
            parsed_call(
                t.path(),
                &[
                    "seed",
                    "import",
                    &seed,
                    "--conversation",
                    "convA",
                    "--votes",
                    &votes,
                    "--source-agree=+1"
                ]
            )
            .0,
            2
        );
    }
    let t = tempfile::tempdir().unwrap();
    let (seed, votes) = inputs(t.path(), "1");
    assert_eq!(
        parsed_call(
            t.path(),
            &[
                "seed",
                "import",
                &seed,
                "--conversation",
                "convA",
                "--votes",
                &votes
            ]
        )
        .0,
        2
    );
    let original = std::fs::read_to_string(&votes).unwrap();
    for raw in [
        original.replace("external-A", "missing"),
        original.replace("2026-01-01", "2026-02-30"),
        format!("{}\n{original}", polis_contracts::votes::WIRE_DECLARATION),
        original.clone() + "v1,p1,0,2026-01-01T00:00:00Z,external-A\n",
    ] {
        std::fs::write(&votes, raw).unwrap();
        assert_eq!(
            parsed_call(
                t.path(),
                &[
                    "seed",
                    "import",
                    &seed,
                    "--conversation",
                    "convA",
                    "--votes",
                    &votes,
                    "--source-agree=+1"
                ]
            )
            .0,
            2
        );
    }
}
#[test]
fn failed_seed_receipt_never_submits_votes() {
    let t = tempfile::tempdir().unwrap();
    let (seed, votes) = inputs(t.path(), "1");
    let s = server(
        t.path(),
        vec![json_res(json!({"results":[{"status":"failed"}]}))],
    );
    let (exit, v) = parsed_call(
        t.path(),
        &[
            "seed",
            "import",
            &seed,
            "--conversation",
            "convA",
            "--votes",
            &votes,
            "--source-agree=+1",
        ],
    );
    assert_eq!(exit, 1);
    assert_eq!(v["data"]["votes"]["state"], "not_sent");
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn failed_vote_submission_preserves_confirmed_seed_receipt() {
    for status in [403, 503] {
        let t = tempfile::tempdir().unwrap();
        let (seed, votes) = inputs(t.path(), "1");
        let s = server(
            t.path(),
            vec![
                json_res(json!({"results":[{"status":"success"}]})),
                (
                    status,
                    "application/json",
                    json!({"error":"private-value"}).to_string(),
                ),
            ],
        );
        let (exit, v) = parsed_call(
            t.path(),
            &[
                "seed",
                "import",
                &seed,
                "--conversation",
                "convA",
                "--votes",
                &votes,
                "--source-agree=+1",
            ],
        );
        assert_eq!(exit, 1);
        assert_eq!(v["data"]["seeds"]["state"], "complete");
        assert_eq!(
            v["data"]["votes"]["error"]["outcome"],
            if status == 403 { "rejected" } else { "unknown" }
        );
        assert!(!v.to_string().contains("private-value"));
        assert_eq!(s.join().unwrap().len(), 2);
    }
}
#[test]
fn offline_manual_and_completions_ignore_broken_profiles() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), "broken").unwrap();
    for args in [
        vec!["help", "tutorial"],
        vec!["tutorial"],
        vec!["completion", "bash"],
        vec!["completion", "zsh"],
        vec!["completion", "fish"],
        vec!["completion", "powershell"],
        vec!["completion", "elvish"],
    ] {
        let (exit, v) = parsed_call(t.path(), &args);
        assert_eq!(exit, 0, "{args:?} {v}");
        assert!(v["data"]["help"].as_str().unwrap().contains("polis"));
    }
}
#[test]
fn plan_browser_stubs_preserve_unavailable_and_same_origin() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"https://example.invalid/"}}"#,
    )
    .unwrap();
    for args in [
        vec!["plan", "upgrade"],
        vec!["plan", "manage", "--no-browser"],
        vec!["plan", "view", "--web"],
    ] {
        let (exit, v) = parsed_call(t.path(), &args);
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["url"], "https://example.invalid/account");
        assert_eq!(v["data"]["browser_opened"], false);
        assert_eq!(v["data"]["state"], "unavailable");
        assert_eq!(v["data"]["checkout"], Value::Null);
    }
}
#[test]
fn browser_launcher_gets_only_account_url_and_no_credentials() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"https://example.invalid/"}}"#,
    )
    .unwrap();
    let bin = t.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let script = bin.join(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    });
    std::fs::write(
        &script,
        "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = https://example.invalid/account ] && [ -z \"$POLIS_TOKEN_LOCAL\" ]\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_polis"))
        .env("POLIS_CONFIG_DIR", t.path())
        .env("PATH", bin)
        .env("POLIS_TOKEN_LOCAL", "fixture-launch-secret")
        .args(["plan", "upgrade", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let v: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(v["data"]["browser_opened"], true);
}

#[test]
fn adversarial_seed_failure_preserves_mapping_and_unsent_votes() {
    let t = tempfile::tempdir().unwrap();
    let seeds = t.path().join("seeds.csv");
    let votes = t.path().join("votes.csv");
    std::fs::write(&seeds, "comment_text,original_id\nExample,external-one\n").unwrap();
    std::fs::write(&votes, "vote_id,user_id,vote_value,timestamp,comment_id\nv1,person-one,1,2024-01-01T00:00:00Z,external-one\n").unwrap();
    // The server could have committed a statement before returning its error.
    let s = server(
        t.path(),
        vec![(503, "application/json", r#"{"error":"unavailable"}"#.into())],
    );
    let (exit, value) = parsed_call(
        t.path(),
        &[
            "seed",
            "import",
            seeds.to_str().unwrap(),
            "--conversation",
            "convA",
            "--votes",
            votes.to_str().unwrap(),
            "--source-agree=+1",
        ],
    );
    assert_eq!(exit, 7);
    assert_eq!(s.join().unwrap().len(), 1);
    assert_eq!(value["data"]["seeds"]["state"], "unknown");
    assert_eq!(
        value["data"]["seeds"]["id_mapping"][0]["original_id"],
        "external-one"
    );
    assert!(value["data"]["seeds"]["id_mapping"][0]["submitted_original_id"].is_string());
    assert_eq!(value["data"]["votes"]["state"], "not_sent");
}
