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
fn page(rows: Value) -> Value {
    json!({"comments":rows,"pagination":{"total":3,"has_more":false}})
}
fn counts() -> Value {
    json!({"schema":"statement-importance/1","conversation_id":"convA","read_at_ms":1700000000123u64,"statements":[{"tid":0,"important":2,"voters":3},{"tid":1,"important":9,"voters":10},{"tid":2,"important":9,"voters":11}]})
}
#[test]
fn importance_sort_ranks_before_pagination_and_joins_exact_tids() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(counts()),
            json_res(page(json!([{"tid":2,"txt":"second tied"}]))),
        ],
    );
    let (exit, v) = call(
        t.path(),
        &[
            "statement",
            "list",
            "--conversation",
            "convA",
            "--sort",
            "importance",
            "--min-important",
            "3",
            "--limit",
            "1",
            "--offset",
            "1",
        ],
        None,
        false,
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["comments"][0]["tid"], 2);
    assert_eq!(v["data"]["comments"][0]["important"], 9);
    assert_eq!(v["data"]["comments"][0]["voters"], 11);
    assert_eq!(v["data"]["pagination"]["total"], 2);
    assert_eq!(v["data"]["importance"]["read_at_ms"], 1700000000123u64);
    let req = s.join().unwrap();
    assert!(req[0].starts_with("GET /api/v3/statements/importance?conversation_id=convA "));
    assert!(req[1].contains("tids=2"));
    assert!(req[1].contains("offset=0"));
}
#[test]
fn importance_filter_only_uses_tid_order_and_empty_rank_needs_no_text_read() {
    for min in ["0", "10"] {
        let t = tempfile::tempdir().unwrap();
        let mut responses = vec![json_res(counts())];
        if min == "0" {
            responses.push(json_res(page(json!([{"tid":0,"txt":"zero"}]))));
        }
        let s = server(t.path(), responses);
        let (exit, v) = call(
            t.path(),
            &[
                "statement",
                "list",
                "--conversation",
                "convA",
                "--min-important",
                min,
                "--limit",
                "1",
            ],
            None,
            false,
        );
        assert_eq!(exit, 0, "{v}");
        assert_eq!(v["data"]["order"], "tid_asc");
        assert_eq!(
            v["data"]["comments"].as_array().unwrap().len(),
            if min == "0" { 1 } else { 0 }
        );
        assert_eq!(s.join().unwrap().len(), if min == "0" { 2 } else { 1 });
    }
}
#[test]
fn importance_ties_reorder_text_exactly_and_preserve_metadata() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(counts()),
            json_res(page(json!([
        {"tid":0,"txt":"low","includeInReport":false},{"tid":2,"txt":"tie2"},{"tid":1,"txt":"tie1"}]))),
        ],
    );
    let (exit, v) = call(
        t.path(),
        &[
            "statement",
            "list",
            "--conversation",
            "convA",
            "--sort",
            "importance",
        ],
        None,
        false,
    );
    assert_eq!(exit, 0, "{v}");
    let rows = v["data"]["comments"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["tid"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 0]
    );
    assert_eq!(rows[2]["includeInReport"], false);
    assert_eq!(s.join().unwrap().len(), 2);
}
#[test]
fn importance_invalid_contracts_never_print_partial_rank() {
    let mut bad = Vec::new();
    for (key, value) in [
        ("schema", json!("statement-importance/2")),
        ("conversation_id", json!("other")),
        ("read_at_ms", json!(0)),
        ("extra", json!(true)),
    ] {
        let mut v = counts();
        v[key] = value;
        bad.push(v);
    }
    let mut v = counts();
    v["statements"][0]["important"] = json!(4);
    bad.push(v);
    let mut v = counts();
    v["statements"][1]["tid"] = json!(0);
    bad.push(v);
    let mut v = counts();
    v["statements"][0]["voters"] = json!(9007199254740992u64);
    bad.push(v);
    let mut v = counts();
    v["statements"][0]["important"] = json!(null);
    bad.push(v);
    for body in bad {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = call(
            t.path(),
            &[
                "statement",
                "list",
                "--conversation",
                "convA",
                "--sort",
                "importance",
            ],
            None,
            false,
        );
        assert_eq!(exit, 1, "{v}");
        assert_eq!(v["error"]["code"], "invalid_importance");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn importance_missing_duplicate_or_unrequested_text_fails_closed() {
    for rows in [
        json!([]),
        json!([{"tid":1,"txt":"one"},{"tid":1,"txt":"duplicate"}]),
        json!([{"tid":9,"txt":"wrong"}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(counts()), json_res(page(rows))]);
        let (exit, v) = call(
            t.path(),
            &[
                "statement",
                "list",
                "--conversation",
                "convA",
                "--sort",
                "importance",
                "--limit",
                "1",
            ],
            None,
            false,
        );
        assert_eq!(exit, 1, "{v}");
        assert!(v["data"].is_null());
        assert_eq!(s.join().unwrap().len(), 2);
    }
}
#[test]
fn importance_disabled_is_capability_unavailable_without_text_read() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            404,
            "text/html",
            "Cannot GET /api/v3/statements/importance".into(),
        )],
    );
    let (exit, v) = call(
        t.path(),
        &[
            "statement",
            "list",
            "--conversation",
            "convA",
            "--sort",
            "importance",
        ],
        None,
        false,
    );
    assert_eq!(exit, 8, "{v}");
    assert_eq!(v["error"]["code"], "capability_unavailable");
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn report_statement_counts_include_zero_and_keep_unobserved_unknown() {
    let t = tempfile::tempdir().unwrap();
    let mut c = counts();
    c["statements"][0]["important"] = json!(0);
    let s = server(
        t.path(),
        vec![
            json_res(json!([{"report_id":"repA","conversation_id":"convA"}])),
            json_res(page(
                json!([{"tid":0,"txt":"accepted","includeInReport":false},{"tid":7,"txt":"changed since the count read"}]),
            )),
            json_res(c),
        ],
    );
    let (exit, v) = call(
        t.path(),
        &["report", "statements", "list", "repA"],
        None,
        false,
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["comments"][0]["important"], 0);
    assert_eq!(v["data"]["comments"][0]["includeInReport"], false);
    assert!(v["data"]["comments"][1]["important"].is_null());
    assert_eq!(v["data"]["importance"]["state"], "observed");
    let req = s.join().unwrap();
    assert_eq!(req.len(), 3);
    assert!(req[2].contains("conversation_id=convA"));
}
#[test]
fn report_statement_counts_unavailable_remain_unknown_without_hiding_rows() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(json!([{"report_id":"repA","conversation_id":"convA"}])),
            json_res(page(json!([{"tid":0,"txt":"keep"}]))),
            (404, "text/html", "Cannot GET".into()),
        ],
    );
    let (exit, v) = call(
        t.path(),
        &["report", "statements", "list", "repA"],
        None,
        false,
    );
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["comments"][0]["txt"], "keep");
    assert!(v["data"]["comments"][0]["important"].is_null());
    assert_eq!(v["data"]["importance"]["state"], "unavailable");
    assert_eq!(s.join().unwrap().len(), 3);
}
fn assert_statement_list_rejects(args: &[&str]) {
    let t = tempfile::tempdir().unwrap();
    let mut full = vec!["statement", "list", "--conversation", "convA"];
    full.extend(args);
    let (exit, _) = call(t.path(), &full, None, false);
    assert_eq!(exit, 2, "{args:?}");
}
#[test]
fn importance_invalid_counts_reject_before_network_or_credentials() {
    for count in ["-1", "9007199254740992", "1.5"] {
        assert_statement_list_rejects(&["--min-important", count]);
    }
}
#[test]
fn importance_unknown_sort_rejects_before_network_or_credentials() {
    // A response field name, but not a sort key.
    assert_statement_list_rejects(&["--sort", "voters"]);
}
