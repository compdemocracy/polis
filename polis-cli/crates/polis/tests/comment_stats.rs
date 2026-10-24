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
fn math() -> Value {
    json!({"math_tick":12,"group-votes":{
        "0":{"votes":{"0":{"A":3,"D":1,"S":5},"1":{"A":4,"D":0,"S":4},"2":{"A":0,"D":0,"S":0}}},
        "1":{"votes":{"0":{"A":1,"D":3,"S":5},"1":{"A":2,"D":0,"S":4},"2":{"A":0,"D":0,"S":3}}}
    }})
}
fn page() -> Value {
    json!({"comments":[{"tid":2,"txt":"pass only"},{"tid":1,"txt":"agree"},{"tid":0,"txt":"split"},{"tid":3,"txt":"not in math"}],"pagination":{"hasMore":false}})
}
fn counts() -> Value {
    json!({"schema":"statement-importance/1","conversation_id":"convA","read_at_ms":1700000000123u64,"statements":[{"tid":0,"important":0,"voters":10},{"tid":1,"important":4,"voters":8}]})
}
fn args() -> Vec<&'static str> {
    vec!["comment", "stats", "--conversation", "convA"]
}
#[test]
fn stats_sums_seen_not_pass_and_retains_unknowns() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(math()), json_res(page()), json_res(counts())],
    );
    let mut a = args();
    a.push("--by-group");
    let (exit, v) = call(t.path(), &a, None, false);
    assert_eq!(exit, 0, "{v}");
    let rows = v["data"]["comments"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["tid"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(rows[0]["votes"], 10);
    assert_eq!(rows[0]["agree_pct"], 40.0);
    assert_eq!(rows[0]["disagree_pct"], 40.0);
    assert_eq!(rows[0]["pass_pct"], 20.0);
    assert_eq!(rows[0]["divisiveness"], 1.0);
    assert_eq!(rows[0]["consensus"], 20.0);
    assert_eq!(rows[0]["important"], 0);
    assert_eq!(rows[0]["groups"][0]["agree_pct"], 60.0);
    assert_eq!(rows[0]["groups"][1]["disagree_pct"], 60.0);
    assert_eq!(rows[2]["votes"], 3);
    assert!(rows[2]["divisiveness"].is_null());
    assert!(rows[2]["consensus"].is_null());
    assert!(rows[3]["votes"].is_null());
    assert!(rows[3].get("important").is_none());
    let req = s.join().unwrap();
    assert_eq!(req.len(), 3);
    assert!(req.iter().all(|r| r.starts_with("GET ")));
    assert!(req[0].contains("/math/pca2?"));
}
#[test]
fn stats_all_sorts_are_descending_with_unknown_last() {
    for (sort, expected) in [
        ("agree", vec![1, 0, 2, 3]),
        ("disagree", vec![0, 1, 2, 3]),
        ("pass", vec![2, 1, 0, 3]),
        ("consensus", vec![1, 0, 2, 3]),
        ("important", vec![1, 0, 2, 3]),
        ("votes", vec![0, 1, 2, 3]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![json_res(math()), json_res(page()), json_res(counts())],
        );
        let mut a = args();
        a.extend(["--sort", sort]);
        let (exit, v) = call(t.path(), &a, None, false);
        assert_eq!(exit, 0, "{v}");
        assert_eq!(
            v["data"]["comments"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["tid"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "{sort}"
        );
        assert!(v["data"]["comments"][0].get("groups").is_none());
        s.join().unwrap();
    }
}
#[test]
fn stats_optional_importance_failure_never_invents_zero_or_ranks_it() {
    for (sort, status) in [("divisive", 404), ("divisive", 502), ("important", 404)] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![
                json_res(math()),
                json_res(page()),
                (status, "text/plain", "unavailable".into()),
            ],
        );
        let mut a = args();
        a.extend(["--sort", sort]);
        let (exit, v) = call(t.path(), &a, None, false);
        if sort == "important" {
            assert_eq!(exit, 8, "{v}");
            assert!(v["data"].is_null());
        } else {
            assert_eq!(exit, 0, "{v}");
            assert_eq!(v["data"]["importance"]["state"], "unavailable");
            assert!(v["data"]["comments"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r.get("important").is_none()));
        }
        s.join().unwrap();
    }
}
#[test]
fn stats_json_preserves_source_body_bytes_and_full_text() {
    let t = tempfile::tempdir().unwrap();
    let raw = "{ \"math_tick\" : 12, \"group-votes\": {}, \"extension\": 1.234567890123456789 }\n";
    let text = format!("{}\u{001b}[31m\u{202e}", "é".repeat(100));
    let p = json!({"comments":[{"tid":0,"txt":text}],"pagination":{"hasMore":false}}).to_string();
    let s = server(
        t.path(),
        vec![
            (200, "application/json", raw.into()),
            (200, "application/json", p.clone()),
            json_res(counts()),
        ],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["reads"][0]["body"], raw);
    assert_eq!(v["data"]["reads"][1]["body"], p);
    assert_eq!(v["data"]["comments"][0]["text"], text);
    assert!(v["data"]["comments"][0]["votes"].is_null());
    s.join().unwrap();
}
#[test]
fn stats_pages_before_ranking_and_ties_by_tid() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(math()),
            json_res(json!({"comments":[{"tid":1,"txt":"one"}],"pagination":{"hasMore":true}})),
            json_res(json!({"comments":[{"tid":0,"txt":"zero"}],"pagination":{"hasMore":false}})),
            json_res(counts()),
        ],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["comments"][0]["tid"], 0);
    let r = s.join().unwrap();
    assert!(r[2].contains("offset=1"));
}
#[test]
fn stats_missing_group_entry_is_unknown_and_hidden_math_is_not_exposed() {
    let t = tempfile::tempdir().unwrap();
    let mut m = math();
    m["group-votes"]["1"]["votes"]
        .as_object_mut()
        .unwrap()
        .remove("0");
    m["group-votes"]["0"]["votes"]["99"] = json!({"A":3,"D":0,"S":3});
    let s = server(
        t.path(),
        vec![json_res(m), json_res(page()), json_res(counts())],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 0, "{v}");
    let rows = v["data"]["comments"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().find(|r| r["tid"] == 0).unwrap()["votes"].is_null());
    s.join().unwrap();
}
#[test]
fn stats_rejects_malformed_math_before_text_or_importance() {
    for (key, value) in [
        ("A", json!(-1)),
        ("D", json!(1.5)),
        ("S", json!(1)),
        ("A", json!(9007199254740992u64)),
        ("D", Value::Null),
    ] {
        let t = tempfile::tempdir().unwrap();
        let mut m = math();
        m["group-votes"]["0"]["votes"]["0"][key] = value;
        let s = server(t.path(), vec![json_res(m)]);
        let (exit, v) = call(t.path(), &args(), None, false);
        assert_eq!(exit, 1, "{v}");
        assert!(v["data"].is_null());
        s.join().unwrap();
    }
}
#[test]
fn stats_rejects_duplicate_text_or_nonprogressing_pages() {
    for p in [
        json!({"comments":[{"tid":0,"txt":"one"},{"tid":0,"txt":"two"}],"pagination":{"hasMore":false}}),
        json!({"comments":[],"pagination":{"hasMore":true}}),
        json!({"comments":[],"pagination":{}}),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(math()), json_res(p)]);
        let (exit, v) = call(t.path(), &args(), None, false);
        assert_eq!(exit, 1, "{v}");
        assert!(v["data"].is_null());
        s.join().unwrap();
    }
}
#[test]
fn stats_invalid_inputs_fail_before_credentials_or_network() {
    for a in [
        vec!["comment", "stats", "--conversation", "bad/id"],
        vec![
            "comment",
            "stats",
            "--conversation",
            "convA",
            "--sort",
            "bogus",
        ],
    ] {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("credentials-local.json"), "broken").unwrap();
        let (exit, v) = call(t.path(), &a, None, false);
        assert_eq!(exit, 2, "{v}");
    }
}
#[test]
fn stats_empty_and_pass_only_do_not_claim_consensus_or_division() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(math()),
            json_res(json!({"comments":[],"pagination":{"hasMore":false}})),
            json_res(counts()),
        ],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["comments"], json!([]));
    s.join().unwrap();
}
#[test]
fn stats_terminal_is_truncated_and_control_safe() {
    let t = tempfile::tempdir().unwrap();
    let mut p = page();
    p["comments"][0]["txt"] = json!(format!("\u{001b}[31m\u{202e}{}", "a".repeat(100)));
    let s = server(
        t.path(),
        vec![json_res(math()), json_res(p), json_res(counts())],
    );
    let out = Command::new(env!("CARGO_BIN_EXE_polis"))
        .env("POLIS_CONFIG_DIR", t.path())
        .args(args())
        .arg("--by-group")
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("AGREE%"));
    assert!(text.contains("group 0:"));
    assert!(text.contains('…'));
    assert!(!text.contains(&"a".repeat(100)));
    assert!(!text.contains('\u{001b}'));
    assert!(!text.contains('\u{202e}'));
    s.join().unwrap();
}
#[test]
fn stats_rejects_excess_groups_tids_and_unsafe_sums() {
    let mut too_many = math();
    too_many["group-votes"] = json!((0..1001)
        .map(|i| (i.to_string(), json!({"votes":{}})))
        .collect::<serde_json::Map<_, _>>());
    let mut too_many_tids = math();
    too_many_tids["group-votes"]["0"]["votes"] = json!((0..10001)
        .map(|i| (i.to_string(), json!({"A":0,"D":0,"S":0})))
        .collect::<serde_json::Map<_, _>>());
    for m in [too_many, too_many_tids] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(m)]);
        let (exit, v) = call(t.path(), &args(), None, false);
        assert_eq!(exit, 1, "{v}");
        assert_eq!(v["error"]["code"], "comment_stats_limit");
        s.join().unwrap();
    }
    let mut m = math();
    m["group-votes"]["0"]["votes"]["0"]["S"] = json!(9007199254740991u64);
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(m), json_res(page()), json_res(counts())],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 1, "{v}");
    assert!(v["data"].is_null());
    s.join().unwrap();
}
#[test]
fn stats_rejects_more_than_ten_thousand_text_rows_without_partial_output() {
    let t = tempfile::tempdir().unwrap();
    let mut replies = vec![json_res(math())];
    for page in 0..20 {
        replies.push(json_res(json!({"comments":(page*500..(page+1)*500).map(|tid|json!({"tid":tid,"txt":"generated"})).collect::<Vec<_>>(),"pagination":{"hasMore":true}})));
    }
    let s = server(t.path(), replies);
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 1, "{v}");
    assert_eq!(v["error"]["code"], "comment_stats_limit");
    assert!(v["data"].is_null());
    assert_eq!(s.join().unwrap().len(), 21);
}
#[test]
fn stats_rejects_invalid_successful_importance_contract() {
    let t = tempfile::tempdir().unwrap();
    let mut c = counts();
    c["conversation_id"] = json!("other");
    let s = server(
        t.path(),
        vec![json_res(math()), json_res(page()), json_res(c)],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 1, "{v}");
    assert!(v["data"].is_null());
    s.join().unwrap();
}

#[test]
fn stats_legacy_snake_case_pagination_is_not_mistaken_for_a_complete_page() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(math()),
            json_res(json!({"comments":[],"pagination":{"has_more":false}})),
        ],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 1, "{v}");
    assert!(v["data"].is_null());
    s.join().unwrap();
}
#[test]
fn stats_math_without_groups_marks_every_statistic_unknown() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            json_res(json!({"math_tick":0,"group-votes":{}})),
            json_res(page()),
            json_res(counts()),
        ],
    );
    let (exit, v) = call(t.path(), &args(), None, false);
    assert_eq!(exit, 0, "{v}");
    let rows = v["data"]["comments"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert!(rows
        .iter()
        .all(|r| r["votes"].is_null() && r["consensus"].is_null()));
    assert!(v["data"]["notes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n.as_str().unwrap().contains("no opinion groups")));
    s.join().unwrap();
}
