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
fn settings() -> Value {
    json!({"is_mod":true,"topic":"Before","description":"old","is_draft":true,"is_data_open":true,"owner_sees_participation_stats":true,"treevite_enabled":true,"topics_enabled":true,"strict_moderation":false})
}
#[test]
fn edit_preserves_legacy_defaults_and_only_changes_requested_fields() {
    let t = tempfile::tempdir().unwrap();
    let before = settings();
    let mut after = before.clone();
    after["topic"] = json!("Exact 🐱");
    after["description"] = json!("");
    let s = server(
        t.path(),
        vec![json_res(before), json_res(json!({})), json_res(after)],
    );
    let (exit, v) = parsed_call(
        t.path(),
        &[
            "conversation",
            "edit",
            "convA",
            "--topic",
            "Exact 🐱",
            "--description",
            "",
        ],
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["state"], "updated");
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].starts_with("PUT /api/v3/conversations "));
    let body: Value = serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
    for key in [
        "is_draft",
        "is_data_open",
        "owner_sees_participation_stats",
        "treevite_enabled",
        "topics_enabled",
    ] {
        assert_eq!(body[key], true);
    }
    assert_eq!(body["topic"], "Exact 🐱");
    assert_eq!(body["description"], "");
    for key in [
        "short_url",
        "send_created_email",
        "is_active",
        "strict_moderation",
    ] {
        assert!(body.get(key).is_none());
    }
}
#[test]
fn explicit_false_settings_are_not_dropped() {
    let t = tempfile::tempdir().unwrap();
    let mut after = settings();
    after["is_draft"] = json!(false);
    after["is_data_open"] = json!(false);
    after["strict_moderation"] = json!(true);
    let s = server(
        t.path(),
        vec![json_res(settings()), json_res(json!({})), json_res(after)],
    );
    let (exit, _) = parsed_call(
        t.path(),
        &[
            "conversation",
            "edit",
            "convA",
            "--draft",
            "false",
            "--data-open",
            "false",
            "--strict-moderation",
            "true",
        ],
    );
    assert_eq!(exit, 0);
    let req = s.join().unwrap();
    assert!(req[1].contains("\"is_draft\":false"));
    assert!(req[1].contains("\"is_data_open\":false"));
}
#[test]
fn incomplete_settings_refuse_before_write_even_when_that_flag_is_requested() {
    for field in [
        "is_draft",
        "is_data_open",
        "owner_sees_participation_stats",
        "treevite_enabled",
        "topics_enabled",
    ] {
        for value in [Value::Null, json!("false")] {
            let t = tempfile::tempdir().unwrap();
            let mut before = settings();
            before[field] = value;
            let s = server(t.path(), vec![json_res(before)]);
            let (exit, v) = parsed_call(
                t.path(),
                &["conversation", "edit", "convA", "--draft", "false"],
            );
            assert_eq!(exit, 8);
            assert_eq!(v["error"]["outcome"], "not_sent");
            assert_eq!(s.join().unwrap().len(), 1);
        }
    }
}
#[test]
fn moderator_access_must_be_observed_before_edit() {
    let t = tempfile::tempdir().unwrap();
    let mut before = settings();
    before["is_mod"] = json!(false);
    let s = server(t.path(), vec![json_res(before)]);
    assert_eq!(
        parsed_call(
            t.path(),
            &["conversation", "edit", "convA", "--topic", "new"]
        )
        .0,
        4
    );
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn failed_or_changed_readback_remains_unknown_without_retry() {
    for response in [
        json_res(settings()),
        (503, "application/json", json!({}).to_string()),
        json_res(json!({})),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(settings()), json_res(json!({})), response],
        );
        let (exit, v) = parsed_call(
            t.path(),
            &["conversation", "edit", "convA", "--topic", "new"],
        );
        assert_eq!(exit, 7);
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(s.join().unwrap().len(), 3);
    }
}
#[test]
fn unexpected_change_to_preserved_flag_also_fails_confirmation() {
    let t = tempfile::tempdir().unwrap();
    let mut after = settings();
    after["topic"] = json!("new");
    after["treevite_enabled"] = json!(false);
    let s = server(
        t.path(),
        vec![json_res(settings()), json_res(json!({})), json_res(after)],
    );
    assert_eq!(
        parsed_call(
            t.path(),
            &["conversation", "edit", "convA", "--topic", "new"]
        )
        .0,
        7
    );
    s.join().unwrap();
}
#[test]
fn edit_permission_loss_stops_at_write_and_gives_specific_action() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(settings()),
            (
                403,
                "application/json",
                json!({"error":"polis_err_update_conversation_permission"}).to_string(),
            ),
        ],
    );
    let (exit, v) = parsed_call(
        t.path(),
        &["conversation", "edit", "convA", "--topic", "new"],
    );
    assert_eq!(exit, 4);
    assert!(v["error"]["action"].as_str().unwrap().contains("moderator"));
    assert_eq!(s.join().unwrap().len(), 2);
}
#[test]
fn edit_invalid_input_is_rejected_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let long = "🐱".repeat(501);
    for args in [
        vec!["conversation", "edit", "convA"],
        vec!["conversation", "edit", "convA", "--topic", " "],
        vec!["conversation", "edit", "convA", "--topic", long.as_str()],
        vec!["conversation", "edit", "convA", "--draft", "yes"],
        vec!["conversation", "edit", "../x", "--topic", "new"],
    ] {
        assert_eq!(parsed_call(t.path(), &args).0, 2);
    }
}
#[test]
fn sharing_needs_no_token_and_does_not_contact_site() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let (exit, v) = call(t.path(), &["conversation", "share", "convA"], None, false);
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["verified"], false);
    assert_eq!(v["data"]["participation_url"], "http://127.0.0.1:9/convA");
    assert_eq!(
        v["data"]["admin_share_url"],
        "http://127.0.0.1:9/m/convA/share"
    );
}
#[test]
fn account_reads_authenticated_profile_and_stats_keep_exact_cutoff() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(json!({"hname":"Generated"})),
            json_res(json!({"votesHistogram":[],"voteTimes":[]})),
        ],
    );
    assert_eq!(
        parsed_call(t.path(), &["account", "view"]).1["data"]["hname"],
        "Generated"
    );
    assert_eq!(
        parsed_call(
            t.path(),
            &["conversation", "stats", "convA", "--until", "1791417600000"]
        )
        .0,
        0
    );
    let requests = s.join().unwrap();
    assert!(requests[0].starts_with("GET /api/v3/users "));
    assert!(requests[1]
        .starts_with("GET /api/v3/conversationStats?conversation_id=convA&until=1791417600000 "));
}
#[test]
fn report_creation_never_attributes_readback_rows_to_the_request() {
    for rows in [
        json!([]),
        json!([{"report_id":"rA"}]),
        json!([{"report_id":"rA"},{"report_id":"rB"}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!({})), json_res(rows.clone())]);
        let (exit, v) = parsed_call(t.path(), &["report", "create", "--conversation", "convA"]);
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["state"], "accepted");
        assert!(v["data"]["report_id"].is_null());
        assert_eq!(v["data"]["reports"], rows);
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("POST /api/v3/reports "));
        assert!(requests[0].contains("\"mod_level\":-2"));
    }
}
#[test]
fn report_creation_projects_the_id_the_server_returns() {
    let rows = json!([{"report_id":"rolder"},{"report_id":"r2abcdefghijklmnopqrs"}]);
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(json!({"report_id":"r2abcdefghijklmnopqrs"})),
            json_res(rows.clone()),
        ],
    );
    let (exit, v) = parsed_call(t.path(), &["report", "create", "--conversation", "convA"]);
    assert_eq!(exit, 0);
    assert_eq!(v["data"]["state"], "accepted");
    assert_eq!(v["data"]["report_id"], "r2abcdefghijklmnopqrs");
    assert_eq!(
        v["data"]["receipt"],
        json!({"report_id":"r2abcdefghijklmnopqrs"})
    );
    assert_eq!(v["data"]["reports"], rows);
    assert_eq!(s.join().unwrap().len(), 2);

    // Without --json the printed result carries the id too.
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(json!({"report_id":"r2abcdefghijklmnopqrs"})),
            json_res(json!([])),
        ],
    );
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    let o = cmd
        .env("POLIS_CONFIG_DIR", t.path())
        .env("POLIS_TOKEN_LOCAL", "fixture-token")
        .args([
            "report",
            "create",
            "--conversation",
            "convA",
            "--no-interactive",
        ])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    let printed: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(printed["report_id"], "r2abcdefghijklmnopqrs");
    s.join().unwrap();
}
#[test]
fn report_creation_ignores_a_malformed_returned_id() {
    for receipt in [
        json!({"report_id":7}),
        json!({"report_id":""}),
        json!({"report_id":"r/../x"}),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(receipt.clone()), json_res(json!([]))],
        );
        let (exit, v) = parsed_call(t.path(), &["report", "create", "--conversation", "convA"]);
        assert_eq!(exit, 0);
        assert!(v["data"]["report_id"].is_null());
        assert_eq!(v["data"]["receipt"], receipt);
        s.join().unwrap();
    }
}
#[test]
fn report_success_receipt_survives_failed_readback() {
    for response in [
        (503, "application/json", json!({}).to_string()),
        json_res(json!({"bad":"shape"})),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(json!({})), response]);
        let (exit, v) = parsed_call(t.path(), &["report", "create", "--conversation", "convA"]);
        assert_eq!(exit, 0);
        assert_eq!(v["data"]["state"], "accepted");
        assert_eq!(v["data"]["readback_state"], "unavailable");
        assert!(v["data"]["reports"].is_null());
        s.join().unwrap();
    }
}
#[test]
fn report_refusal_and_uncertain_failure_do_not_retry_or_list() {
    for (status, expected, code) in [
        (403, 4, "polis_err_post_reports_permissions"),
        (500, 7, "polis_err_post_reports_misc"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![(
                status,
                "application/json",
                json!({"error":code}).to_string(),
            )],
        );
        let (exit, v) = parsed_call(t.path(), &["report", "create", "--conversation", "convA"]);
        assert_eq!(exit, expected);
        assert_eq!(s.join().unwrap().len(), 1);
        if status == 500 {
            assert!(v["error"]["action"]
                .as_str()
                .unwrap()
                .contains("duplicates"));
        }
    }
}
#[test]
fn help_and_schema_explain_effects_and_new_arguments() {
    let t = tempfile::tempdir().unwrap();
    for (args, text) in [
        (vec!["help", "conversation", "edit"], "compare-and-set"),
        (vec!["help", "report", "create"], "idempotency"),
        (vec!["help", "conversation", "stats"], "epoch-millisecond"),
        (vec!["help", "conversation", "share"], "no HTTP"),
        (vec!["help", "account", "view"], "personal data"),
        (vec!["help", "conversation", "edit"], "--invite-only"),
        (vec!["help", "conversation", "edit"], "fixed once"),
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert!(v["data"]["help"].as_str().unwrap().contains(text));
    }
    let (exit, v) = call(t.path(), &["schema", "conversation", "edit"], None, false);
    assert_eq!(exit, 0);
    assert!(v.to_string().contains("strict-moderation"));
    assert!(v.to_string().contains("external-id"));
}
fn admission() -> Value {
    let mut v = settings();
    v["xid_required"] = json!(false);
    v["use_xid_whitelist"] = json!(false);
    v
}
#[test]
fn admission_settings_change_only_what_was_asked_and_are_read_back() {
    for (args, invite_only, xid_required, allowlist) in [
        (
            vec!["--invite-only", "false", "--external-id", "allowlist"],
            false,
            true,
            true,
        ),
        (vec!["--external-id", "required"], true, true, false),
        (vec!["--invite-only", "false"], false, false, false),
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut after = admission();
        after["treevite_enabled"] = json!(invite_only);
        after["xid_required"] = json!(xid_required);
        after["use_xid_whitelist"] = json!(allowlist);
        let s = server(
            t.path(),
            vec![json_res(admission()), json_res(json!({})), json_res(after)],
        );
        let mut call_args = vec!["conversation", "edit", "convA"];
        call_args.extend(&args);
        let (exit, v) = parsed_call(t.path(), &call_args);
        assert_eq!(exit, 0, "{v}");
        assert_eq!(v["data"]["state"], "updated");
        let requests = s.join().unwrap();
        let body: Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["treevite_enabled"], invite_only);
        if args.contains(&"--external-id") {
            assert_eq!(body["xid_required"], xid_required);
            assert_eq!(body["use_xid_whitelist"], allowlist);
        } else {
            assert!(body.get("xid_required").is_none());
            assert!(body.get("use_xid_whitelist").is_none());
        }
        assert!(body.get("topic").is_none());
    }
    // A read-back that does not show the change is not a success.
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(admission()),
            json_res(json!({})),
            json_res(admission()),
        ],
    );
    let (exit, v) = parsed_call(
        t.path(),
        &["conversation", "edit", "convA", "--external-id", "required"],
    );
    assert_eq!(exit, 7, "{v}");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert_eq!(s.join().unwrap().len(), 3);
}
#[test]
fn allowlist_switch_after_start_is_refused_plainly_and_never_retried() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(admission()),
            (
                409,
                "application/json",
                json!({"error":"polis_err_xid_whitelist_fixed_after_start","message":"polis_err_xid_whitelist_fixed_after_start","status":409}).to_string(),
            ),
        ],
    );
    let (exit, v) = parsed_call(
        t.path(),
        &[
            "conversation",
            "edit",
            "convA",
            "--external-id",
            "allowlist",
        ],
    );
    assert_eq!(exit, 5, "{v}");
    assert_eq!(v["error"]["code"], "xid_allowlist_fixed");
    assert_eq!(v["error"]["outcome"], "rejected");
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("fixed once participation has started"));
    assert_eq!(s.join().unwrap().len(), 2);
}
#[test]
fn admission_options_are_typed_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for args in [
        vec!["conversation", "edit", "convA", "--invite-only", "yes"],
        vec!["conversation", "edit", "convA", "--external-id", "maybe"],
    ] {
        assert_eq!(parsed_call(t.path(), &args).0, 2);
    }
    // Each listed value is accepted and reaches the (closed) site.
    for (arg, value) in [
        ("--invite-only", "true"),
        ("--invite-only", "false"),
        ("--external-id", "optional"),
        ("--external-id", "required"),
        ("--external-id", "allowlist"),
    ] {
        let (exit, v) = parsed_call(t.path(), &["conversation", "edit", "convA", arg, value]);
        assert_eq!(exit, 6, "{arg} {value}: {v}");
    }
}
