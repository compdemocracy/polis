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
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
fn json_res(v: Value) -> (u16, &'static str, String) {
    (200, "application/json", v.to_string())
}
fn conv() -> Value {
    json!({"conversation_id":"2demo","treevite_enabled":false})
}
fn wave() -> Value {
    json!({"id":"41","zid":1,"wave":1,"parent_wave":0,"invites_per_user":3,"owner_invites":10,"size":13,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"})
}
fn row(status: u64) -> Value {
    json!({"id":"901","invite_code":"code123","wave":1,"status":status,"invite_used_by_pid":null,"invite_used_at":null,"created_at":"2026-01-01T00:00:00.000Z"})
}
fn page(status: u64, limit: u64, offset: u64, total: u64) -> Value {
    json!({"invites":[row(status)],"pagination":{"limit":limit,"offset":offset,"total":total,"hasMore":offset+limit<total}})
}
fn assert_get(request: &str, target: &str) {
    assert!(
        request.starts_with(&format!("GET {target} HTTP/")),
        "{request}"
    );
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer fixture-token"));
}
#[test]
fn codes_project_public_fields_preserve_order_and_normalize_bigint() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(
            json!({"codes":[{"zid":1,"zinvite":"2second","created":"1700000000001","uuid":"hidden-key"},{"zid":1,"zinvite":"2first","created":1700000000000u64}]}),
        )],
    );
    let (code, v) = call(
        t.path(),
        &["invite", "code", "list", "--conversation", "2demo"],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(
        v["data"]["codes"],
        json!([{"code":"2second","created":1700000000001u64},{"code":"2first","created":1700000000000u64}])
    );
    assert!(!v.to_string().contains("hidden-key"));
    assert_get(
        &s.join().unwrap()[0],
        "/api/v3/zinvites/0?conversation_id=2demo",
    );
}
#[test]
fn waves_send_optional_zero_filter() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![json_res(json!([wave()]))]);
    let (code, v) = call(
        t.path(),
        &[
            "invite",
            "wave",
            "list",
            "--conversation",
            "2demo",
            "--wave",
            "0",
        ],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"][0]["id"], 41);
    assert_get(
        &s.join().unwrap()[0],
        "/api/v3/treevite/waves?conversation_id=2demo&wave=0",
    );
}
#[test]
fn list_maps_all_statuses_and_sends_only_supported_filters() {
    for (status, name) in ["unused", "used", "revoked", "expired"].iter().enumerate() {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(conv()), json_res(page(status as u64, 2, 3, 10))],
        );
        let (code, v) = call(
            t.path(),
            &[
                "invite",
                "list",
                "--conversation",
                "2demo",
                "--wave-id",
                "41",
                "--status",
                name,
                "--limit",
                "2",
                "--offset",
                "3",
            ],
            None,
            true,
        );
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["invites"][0]["status"], *name);
        assert_eq!(v["data"]["invite_only"], false);
        assert_eq!(v["data"]["pagination"]["hasMore"], true);
        let rs = s.join().unwrap();
        assert_get(&rs[0], "/api/v3/conversations?conversation_id=2demo");
        assert_get(&rs[1],&format!("/api/v3/treevite/invites?conversation_id=2demo&wave_id=41&limit=2&offset=3&status={status}"));
    }
}
#[test]
fn status_uses_all_four_totals_without_counting_rows() {
    let t = tempfile::tempdir().unwrap();
    let mut responses = vec![json_res(conv()), json_res(json!([wave()]))];
    for i in 0..4 {
        responses.push(json_res(page(i, 1, 0, 10 + i)));
    }
    let s = server(t.path(), responses);
    let (code, v) = call(
        t.path(),
        &["invite", "status", "--conversation", "2demo"],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(
        v["data"]["owner_invites"],
        json!({"unused":10,"used":11,"revoked":12,"expired":13})
    );
    let rs = s.join().unwrap();
    assert_eq!(rs.len(), 6);
    for i in 0..4 {
        assert_get(
            &rs[i + 2],
            &format!("/api/v3/treevite/invites?conversation_id=2demo&status={i}&limit=1&offset=0"),
        );
    }
}
#[test]
fn status_failure_never_reports_partial_counts() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(conv()),
            json_res(json!([])),
            json_res(page(0, 1, 0, 10)),
            (
                500,
                "application/json",
                json!({"error":"secret-upstream-value"}).to_string(),
            ),
        ],
    );
    let (code, v) = call(
        t.path(),
        &["invite", "status", "--conversation", "2demo"],
        None,
        true,
    );
    assert_ne!(code, 0);
    assert!(v["data"].is_null());
    assert!(!v.to_string().contains("secret-upstream-value"));
    s.join().unwrap();
}
#[test]
fn every_command_maps_forbidden_and_suppresses_upstream_secrets() {
    for path in [
        vec!["invite", "code", "list"],
        vec!["invite", "wave", "list"],
        vec!["invite", "list"],
        vec!["invite", "export"],
        vec!["invite", "status"],
        vec!["conversation", "uuid"],
    ] {
        let t = tempfile::tempdir().unwrap();
        let output = t.path().join("new.csv");
        let mut args = path.clone();
        if path[0] == "conversation" {
            args.push("2demo");
        } else {
            args.extend(["--conversation", "2demo"]);
        }
        if path[1] == "export" {
            args.extend(["--output", output.to_str().unwrap()]);
        }
        let s=server(t.path(),vec![(403,"application/json",json!({"error":"polis_err_fetching_zinvite_not_conversation_owner","extra":"private-detail"}).to_string())]);
        let (code, v) = call(t.path(), &args, None, true);
        assert_eq!(code, 4, "{v}");
        assert_eq!(v["error"]["code"], "forbidden");
        assert!(!v.to_string().contains("private-detail"));
        assert!(!output.exists());
        s.join().unwrap();
    }
}
#[test]
fn invite_admin_refusals_preserve_known_codes_and_forbidden_exit() {
    for upstream_code in [
        "polis_err_treevite_not_conversation_owner",
        "polis_err_treevite_auth_check",
        "polis_err_sending_invite_not_conversation_owner",
        "polis_err_sending_invite_auth_check",
        "polis_err_fetching_zinvite_not_conversation_owner",
    ] {
        for (content_type, body) in [
            (
                "application/json",
                json!({"error": upstream_code, "extra": "private-detail"}).to_string(),
            ),
            ("text/plain", upstream_code.to_owned()),
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(t.path(), vec![(403, content_type, body)]);
            let (code, v) = call(
                t.path(),
                &["invite", "code", "list", "--conversation", "2demo"],
                None,
                true,
            );
            assert_eq!(code, 4, "{v}");
            assert_eq!(v["error"]["code"], "forbidden");
            assert_eq!(v["error"]["upstream"]["code"], upstream_code);
            assert_eq!(v["error"]["upstream"]["status"], 403);
            assert!(v["data"].is_null());
            assert!(!v.to_string().contains("private-detail"));
            let requests = s.join().unwrap();
            assert_eq!(requests.len(), 1);
            assert_get(&requests[0], "/api/v3/zinvites/0?conversation_id=2demo");
        }
    }
}
#[test]
fn export_preserves_bytes_and_creates_private_file() {
    let t = tempfile::tempdir().unwrap();
    let output = t.path().join("codes.csv");
    let csv = "wave,invite_code\r\n1,\"=untrusted,code\"\r\n";
    let s = server(t.path(), vec![(200, "text/csv; charset=utf-8", csv.into())]);
    let (code, v) = call(
        t.path(),
        &[
            "invite",
            "export",
            "--conversation",
            "2demo",
            "--output",
            output.to_str().unwrap(),
        ],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(std::fs::read(&output).unwrap(), csv.as_bytes());
    assert_eq!(v["data"]["content_type"], "text/csv; charset=utf-8");
    assert!(!v.to_string().contains("untrusted,code"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_get(
        &s.join().unwrap()[0],
        "/api/v3/treevite/invites/csv?conversation_id=2demo",
    );
}
#[test]
fn export_refuses_existing_file_and_symlink_without_http() {
    let t = tempfile::tempdir().unwrap();
    let output = t.path().join("codes.csv");
    std::fs::write(&output, "keep").unwrap();
    let (code, _) = call(
        t.path(),
        &[
            "invite",
            "export",
            "--conversation",
            "2demo",
            "--output",
            output.to_str().unwrap(),
        ],
        None,
        true,
    );
    assert_eq!(code, 2);
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "keep");
    #[cfg(unix)]
    {
        let link = t.path().join("link.csv");
        std::os::unix::fs::symlink(t.path().join("missing"), &link).unwrap();
        let (code, _) = call(
            t.path(),
            &[
                "invite",
                "export",
                "--conversation",
                "2demo",
                "--output",
                link.to_str().unwrap(),
            ],
            None,
            true,
        );
        assert_eq!(code, 2);
        assert!(!t.path().join("missing").exists());
    }
}
#[test]
fn export_refuses_wrong_media_and_redirects_without_file() {
    for (status, kind, body) in [
        (200, "text/csv-invalid", "secret"),
        (200, "application/json", "{}"),
        (302, "text/csv", "secret"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let output = t.path().join("codes.csv");
        let s = server(t.path(), vec![(status, kind, body.into())]);
        let (code, v) = call(
            t.path(),
            &[
                "invite",
                "export",
                "--conversation",
                "2demo",
                "--output",
                output.to_str().unwrap(),
            ],
            None,
            true,
        );
        assert_ne!(code, 0, "{v}");
        assert!(!output.exists());
        assert!(!v.to_string().contains("secret"));
        s.join().unwrap();
    }
}
#[test]
fn malformed_codes_waves_and_uuid_fail_cleanly() {
    for path in [
        vec!["invite", "code", "list", "--conversation", "2demo"],
        vec!["invite", "wave", "list", "--conversation", "2demo"],
        vec!["conversation", "uuid", "2demo"],
    ] {
        for bad in [
            json!(null),
            json!([]),
            json!({}),
            json!({"codes":[{"zinvite":"x","zid":1,"created":-1}]}),
            json!({"conversation_uuid":"private-invalid-key"}),
        ] {
            let t = tempfile::tempdir().unwrap();
            let s = server(t.path(), vec![json_res(bad)]);
            let (code, v) = call(t.path(), &path, None, true);
            // Empty waves are a valid list.
            if path[1] == "wave" && v["data"] == json!([]) {
                assert_eq!(code, 0);
            } else {
                assert_ne!(code, 0, "{v}");
                assert!(v["data"].is_null());
            }
            assert!(!v.to_string().contains("private-invalid-key"));
            s.join().unwrap();
        }
    }
}
#[test]
fn malformed_pages_and_settings_never_become_empty_success() {
    let mut bad_pages = vec![
        json!({}),
        json!({"invites":[],"pagination":{"limit":50,"offset":0,"total":0,"has_more":false}}),
    ];
    for (field, value) in [
        ("status", json!(4)),
        ("status", json!("unused")),
        ("id", json!(-1)),
        ("invite_code", json!(null)),
        ("created_at", json!(10)),
    ] {
        let mut p = page(0, 50, 0, 1);
        p["invites"][0][field] = value;
        bad_pages.push(p);
    }
    let mut missing = page(0, 50, 0, 1);
    missing["invites"][0]
        .as_object_mut()
        .unwrap()
        .remove("invite_used_at");
    bad_pages.push(missing);
    for p in bad_pages {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(conv()), json_res(p)]);
        let (code, v) = call(
            t.path(),
            &["invite", "list", "--conversation", "2demo"],
            None,
            true,
        );
        assert_eq!(code, 1, "{v}");
        assert!(v["data"].is_null());
        s.join().unwrap();
    }
    for c in [
        json!({}),
        json!({"conversation_id":"2demo","treevite_enabled":"false"}),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(c)]);
        let (code, _) = call(
            t.path(),
            &["invite", "list", "--conversation", "2demo"],
            None,
            true,
        );
        assert_eq!(code, 1);
        s.join().unwrap();
    }
    // A conversation can have several codes; the read may echo another one.
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(json!({"conversation_id":"other","treevite_enabled":true})),
            json_res(page(0, 50, 0, 1)),
        ],
    );
    let (code, v) = call(
        t.path(),
        &["invite", "list", "--conversation", "2demo"],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    s.join().unwrap();
}
#[test]
fn uuid_is_raw_only_when_explicitly_requested_and_errors_never_echo_key() {
    let key = "11111111-2222-4333-8444-555555555555";
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(json!({"conversation_uuid":key,"extra":"hidden"}))],
    );
    let (code, v) = call(t.path(), &["conversation", "uuid", "2demo"], None, true);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"], json!({"conversation_uuid":key}));
    s.join().unwrap();
    let s = server(t.path(), vec![json_res(json!({"conversation_uuid":key}))]);
    let out = Command::new(env!("CARGO_BIN_EXE_polis"))
        .env("POLIS_CONFIG_DIR", t.path())
        .env("POLIS_TOKEN_LOCAL", "fixture-token")
        .args(["conversation", "uuid", "2demo", "--no-interactive"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(out.stdout, format!("{key}\n").as_bytes());
    assert!(out.stderr.is_empty());
    assert_get(
        &s.join().unwrap()[0],
        "/api/v3/conversationUuid?conversation_id=2demo",
    );
    let s = server(t.path(), vec![json_res(json!({"error":key}))]);
    let (code, v) = call(t.path(), &["conversation", "uuid", "2demo"], None, true);
    assert_eq!(code, 7, "{v}");
    assert!(!v.to_string().contains(key));
    s.join().unwrap();
}
#[test]
fn invalid_arguments_are_offline_and_write_commands_stay_unavailable() {
    for args in [
        vec!["invite", "list", "--conversation", "2demo", "--limit", "0"],
        vec![
            "invite",
            "list",
            "--conversation",
            "2demo",
            "--limit",
            "501",
        ],
        vec![
            "invite",
            "list",
            "--conversation",
            "2demo",
            "--offset",
            "-1",
        ],
        vec![
            "invite",
            "list",
            "--conversation",
            "2demo",
            "--status",
            "all",
        ],
        vec!["invite", "code", "list", "--conversation", "../escape"],
        vec!["conversation", "uuid", "../escape"],
    ] {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(call(t.path(), &args, None, true).0, 2);
    }
    for args in [
        vec!["invite", "code", "create"],
        vec!["invite", "wave", "create"],
        vec!["invite", "revoke"],
    ] {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(call(t.path(), &args, None, true).0, 8);
    }
}

#[test]
fn bigint_identity_boundaries_are_exact_and_never_rounded() {
    for value in [
        json!("9007199254740991"),
        json!("9007199254740992"),
        json!("1.5"),
        json!("-1"),
        json!(" 1"),
        json!("18446744073709551616"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut w = wave();
        w["id"] = value.clone();
        let s = server(t.path(), vec![json_res(json!([w]))]);
        let (code, v) = call(
            t.path(),
            &["invite", "wave", "list", "--conversation", "2demo"],
            None,
            true,
        );
        if value == json!("9007199254740991") {
            assert_eq!(code, 0, "{v}");
            assert_eq!(v["data"][0]["id"], json!(9007199254740991u64));
        } else {
            assert_eq!(code, 1, "{v}");
        }
        s.join().unwrap();
    }
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(conv()), json_res(page(0, 50, 0, 1))],
    );
    let (code, v) = call(
        t.path(),
        &[
            "invite",
            "list",
            "--conversation",
            "2demo",
            "--wave-id",
            "9007199254740991",
        ],
        None,
        true,
    );
    assert_eq!(code, 0, "{v}");
    assert_get(
        &s.join().unwrap()[1],
        "/api/v3/treevite/invites?conversation_id=2demo&wave_id=9007199254740991&limit=50&offset=0",
    );
}
