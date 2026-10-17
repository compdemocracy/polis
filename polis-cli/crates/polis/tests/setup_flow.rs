use polis_contracts::setup::*;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::Command,
};
fn setup() -> ConversationSetup {
    ConversationSetup {
        topic: "Fixture setup".into(),
        ..ConversationSetup::default()
    }
}
fn config(dir: &Path, origin: &str) {
    std::fs::write(
        dir.join("profiles.json"),
        json!({"default":"local","sites":{"local":origin}}).to_string(),
    )
    .unwrap();
}
fn input(dir: &Path, s: &ConversationSetup) -> String {
    let p = dir.join("setup.json");
    std::fs::write(&p, serde_json::to_vec(s).unwrap()).unwrap();
    p.to_str().unwrap().into()
}
fn call(dir: &Path, args: &[&str]) -> (i32, Value) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (k, _) in std::env::vars() {
        if k.starts_with("POLIS_TOKEN") || k.starts_with("POLIS_URL_") || k == "POLIS_SITE" {
            cmd.env_remove(k);
        }
    }
    let out = cmd
        .env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_TOKEN_LOCAL", "fixture-account-secret")
        .args(args)
        .args(["--json", "--no-interactive"])
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&out.stdout).contains("fixture-account-secret"));
    (
        out.status.code().unwrap(),
        serde_json::from_slice(&out.stdout).unwrap(),
    )
}
#[test]
fn dry_run_and_save_are_local_and_preserve_typed_setup_privately() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    config(d.path(), "http://127.0.0.1:1");
    let s = setup();
    let src = input(d.path(), &s);
    let dst = d.path().join("saved.json");
    let (exit, v) = call(
        d.path(),
        &[
            "conversation",
            "new",
            "--from",
            &src,
            "--dry-run",
            "--save",
            dst.to_str().unwrap(),
        ],
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["state"], "planned");
    assert_eq!(
        std::fs::metadata(&dst).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        serde_json::from_slice::<ConversationSetup>(&std::fs::read(&dst).unwrap()).unwrap(),
        s
    );
    assert_eq!(
        call(
            d.path(),
            &[
                "conversation",
                "new",
                "--from",
                &src,
                "--dry-run",
                "--save",
                dst.to_str().unwrap()
            ]
        )
        .0,
        2
    );
}
#[test]
fn unknown_or_invalid_setup_fails_without_http_or_reflected_values() {
    let d = tempfile::tempdir().unwrap();
    config(d.path(), "http://127.0.0.1:1");
    let src = input(d.path(), &setup());
    for value in [
        json!({"private-value":"hidden"}),
        json!({"join":{"invitations":{"mode":"required"}}}),
        json!({}),
    ] {
        std::fs::write(&src, value.to_string()).unwrap();
        let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
        assert_eq!(exit, 2);
        assert!(!v.to_string().contains("private-value"));
    }
    assert_eq!(call(d.path(), &["conversation", "new"]).0, 2);
}
fn server(
    dir: &Path,
    s: ConversationSetup,
    fail: Option<usize>,
) -> std::thread::JoinHandle<Vec<String>> {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.set_nonblocking(true).unwrap();
    config(dir, &format!("http://{}", l.local_addr().unwrap()));
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        let mut fields = s.node_flags();
        fields["is_active"] = json!(false);
        fields["treevite_enabled"] = json!(true);
        fields.as_object_mut().unwrap().remove("xid_required");
        fields.as_object_mut().unwrap().remove("use_xid_whitelist");
        for i in 0..6 {
            let start = std::time::Instant::now();
            let mut sock = loop {
                match l.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(start.elapsed().as_secs() < 10, "missing setup request");
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            sock.set_nonblocking(false).unwrap();
            sock.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 8192];
            let end = loop {
                let n = sock.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + len {
                        break end;
                    }
                }
            };
            let request = String::from_utf8(bytes.clone()).unwrap();
            if request.starts_with("PUT") {
                fields = serde_json::from_slice(&bytes[end + 4..]).unwrap();
                assert!(fields.get("short_url").is_none());
            }
            requests.push(request);
            let (status, data) = if fail == Some(i) {
                (500, json!({"error":"private-error-text"}))
            } else {
                (
                    200,
                    if i == 0 {
                        json!({"conversation_id":"2setup"})
                    } else if i % 2 == 1 {
                        fields.clone()
                    } else {
                        json!({})
                    },
                )
            };
            let body = data.to_string();
            write!(sock,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            if fail == Some(i) {
                break;
            }
        }
        requests
    })
}
#[test]
fn staged_apply_reads_after_each_write_and_only_then_opens() {
    let d = tempfile::tempdir().unwrap();
    let s = setup();
    let src = input(d.path(), &s);
    let t = server(d.path(), s, None);
    let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["state"], "created");
    let requests = t.join().unwrap();
    assert_eq!(requests.len(), 6);
    for (i, r) in requests.iter().enumerate() {
        assert!(r.starts_with(if i % 2 == 1 {
            "GET"
        } else if i == 0 {
            "POST"
        } else {
            "PUT"
        }));
    }
    let first: Value = serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(first["is_active"], false);
    assert_eq!(first["treevite_enabled"], true);
    let final_body: Value =
        serde_json::from_str(requests[4].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(final_body["is_active"], true);
    assert_eq!(final_body["treevite_enabled"], false);
    assert!(v["data"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["state"] == "confirmed"));
}
#[test]
fn failure_at_each_write_or_confirmation_reports_steps_and_never_retries() {
    for fail in 0..6 {
        let d = tempfile::tempdir().unwrap();
        let s = setup();
        let src = input(d.path(), &s);
        let t = server(d.path(), s, Some(fail));
        let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
        assert_eq!(exit, 7, "{v}");
        assert_eq!(v["ok"], false);
        assert_eq!(v["data"]["state"], "setup_partial");
        assert!(!v.to_string().contains("private-error-text"));
        assert_eq!(t.join().unwrap().len(), fail + 1);
        assert_eq!(
            v["data"]["steps"].as_array().unwrap().len(),
            fail.div_ceil(2)
        );
    }
}
#[test]
fn a_partial_setup_says_what_it_left_and_how_to_finish_it() {
    let mut s = setup();
    s.join.external_identity = ExternalIdentity::Required;
    let d = tempfile::tempdir().unwrap();
    let src = input(d.path(), &s);
    // The staged settings write fails after the conversation was created.
    let t = server(d.path(), s.clone(), Some(2));
    let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
    assert_eq!(exit, 7, "{v}");
    t.join().unwrap();
    let message = v["error"]["message"].as_str().unwrap();
    let action = v["error"]["action"].as_str().unwrap();
    assert!(
        message.contains("2setup exists") && message.contains("closed and invite-only"),
        "{message}"
    );
    assert!(action.contains("Never rerun new"), "{action}");
    let finish = [
        "polis conversation edit 2setup --invite-only false --external-id required",
        "polis conversation reopen 2setup",
    ];
    assert_eq!(v["data"]["finish"], json!(finish));
    for command in finish {
        assert!(action.contains(command), "{action}");
    }
    assert!(action.find(finish[0]) < action.find(finish[1]));

    // A setup that asked to stay closed is not told to reopen.
    s.activity = Activity::Closed;
    s.join.invitations = Invitations::Required {
        first_wave: Wave::new(1, 0).unwrap(),
        later_waves: vec![],
    };
    let d = tempfile::tempdir().unwrap();
    let src = input(d.path(), &s);
    let t = server(d.path(), s, Some(2));
    let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
    assert_eq!(exit, 7, "{v}");
    t.join().unwrap();
    assert_eq!(
        v["data"]["finish"],
        json!(["polis conversation edit 2setup --invite-only true --external-id required"])
    );
    assert!(!v["error"]["action"].as_str().unwrap().contains("reopen"));
}
#[test]
fn a_refused_create_reports_its_own_error_because_nothing_was_created() {
    let d = tempfile::tempdir().unwrap();
    let src = input(d.path(), &setup());
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    config(d.path(), &format!("http://{}", l.local_addr().unwrap()));
    let t = std::thread::spawn(move || {
        let (mut sock, _) = l.accept().unwrap();
        sock.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 8192];
        while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut buf).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
        }
        let body = json!({"error":"private-error-text"}).to_string();
        write!(sock,"HTTP/1.1 403 Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        // Any further request would be a retry or a later setup step.
        l.set_nonblocking(true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(l.accept().is_err(), "nothing follows a refused create");
        String::from_utf8(bytes).unwrap()
    });
    let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
    assert_eq!(exit, 4, "{v}");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "forbidden");
    assert_eq!(v["error"]["outcome"], "rejected");
    assert!(!v.to_string().contains("setup_partial"));
    assert!(!v.to_string().contains("private-error-text"));
    assert!(t.join().unwrap().starts_with("POST /api/v3/conversations "));
}
#[test]
fn setup_is_discoverable_without_credentials() {
    let d = tempfile::tempdir().unwrap();
    let (exit, v) = call(d.path(), &["schema", "conversation", "new"]);
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["implemented"], true);
}
/// A mock that answers by route, as Node does: the moderation list ignores `tids`
/// and returns every statement. `drop` leaves one statement out of that list.
fn seeded_server(
    dir: &Path,
    s: ConversationSetup,
    drop: Option<usize>,
) -> std::thread::JoinHandle<Vec<String>> {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    config(dir, &format!("http://{}", l.local_addr().unwrap()));
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        let mut fields = s.node_flags();
        fields["is_active"] = json!(false);
        fields["treevite_enabled"] = json!(true);
        fields.as_object_mut().unwrap().remove("xid_required");
        fields.as_object_mut().unwrap().remove("use_xid_whitelist");
        let mut posted = 0usize;
        loop {
            let (mut sock, _) = l.accept().unwrap();
            sock.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 8192];
            let end = loop {
                let n = sock.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + len {
                        break end;
                    }
                }
            };
            let request = String::from_utf8(bytes.clone()).unwrap();
            let line = request.lines().next().unwrap().to_string();
            let data = if line.starts_with("POST /api/v3/conversations ") {
                json!({"conversation_id":"2setup"})
            } else if line.starts_with("PUT /api/v3/conversations ") {
                fields = serde_json::from_slice(&bytes[end + 4..]).unwrap();
                json!({})
            } else if line.starts_with("GET /api/v3/conversations") {
                fields.clone()
            } else if line.starts_with("POST /api/v3/comments-bulk ") {
                posted += 1;
                json!({"results":[{"status":"success","tid":posted - 1}]})
            } else if line.starts_with("GET /api/v3/comments?") {
                let rows: Vec<Value> = s
                    .seeds
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| Some(*i) != drop)
                    .map(|(i, t)| json!({"tid":i,"txt":t,"mod":1,"active":true}))
                    .collect();
                json!({"comments":rows,"pagination":{"hasMore":false,"total":rows.len()}})
            } else {
                panic!("unexpected request {line}");
            };
            let body = data.to_string();
            write!(sock,"HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            let done = line.starts_with("GET /api/v3/comments?") && drop.is_some()
                || (line.starts_with("GET /api/v3/conversations")
                    && fields["is_active"] == json!(true));
            requests.push(request);
            if done {
                break;
            }
        }
        requests
    })
}
#[test]
fn several_seeds_are_confirmed_by_one_moderation_list_read() {
    let mut s = setup();
    s.seeds = vec![
        "First seed".into(),
        "Second seed".into(),
        "Third seed".into(),
    ];
    let d = tempfile::tempdir().unwrap();
    let src = input(d.path(), &s);
    let t = seeded_server(d.path(), s.clone(), None);
    let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["state"], "created");
    let requests = t.join().unwrap();
    let reads: Vec<_> = requests
        .iter()
        .filter(|r| r.starts_with("GET /api/v3/comments?"))
        .collect();
    assert_eq!(reads.len(), 1, "one paged read confirms every statement");
    assert!(reads[0].contains("moderation=true") && !reads[0].contains("tids="));
    let statements: Vec<_> = v["data"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["step"].as_str().unwrap().starts_with("statement_"))
        .collect();
    assert_eq!(statements.len(), 3);
    assert!(statements.iter().all(|r| r["state"] == "confirmed"));

    let d = tempfile::tempdir().unwrap();
    let src = input(d.path(), &s);
    let t = seeded_server(d.path(), s, Some(1));
    let (exit, v) = call(d.path(), &["conversation", "new", "--from", &src]);
    assert_eq!(exit, 7, "{v}");
    assert_eq!(v["data"]["state"], "setup_partial");
    t.join().unwrap();
}
