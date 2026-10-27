use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output},
};

fn call(dir: &std::path::Path, args: &[&str]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("POLIS_CONFIG_DIR", dir)
        .env("POLIS_KEYCHAIN", "off")
        .env("POLIS_TOKEN_LOCAL", "generated-token")
        .args(args)
        .arg("--no-interactive")
        .output()
        .unwrap()
}
fn table(o: &Output) -> (Vec<String>, Vec<Vec<String>>) {
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let mut r = csv::Reader::from_reader(o.stdout.as_slice());
    let headers = r.headers().unwrap().iter().map(str::to_owned).collect();
    let rows = r
        .records()
        .map(|r| r.unwrap().iter().map(str::to_owned).collect())
        .collect();
    (headers, rows)
}
fn response(v: Value) -> (u16, &'static str, String) {
    (200, "application/json", v.to_string())
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

#[test]
fn csv_locations_preserves_duplicates_extensions_and_text_without_identity() {
    let t = tempfile::tempdir().unwrap();
    let value = json!([{"lat":1.5,"lng":2.0,"n":1,"text":"=formula,\"quoted\"\r\n雪","nested":{"a":[true,null]}},{"lat":1.5,"lng":2.0,"n":1}]);
    let s = server(t.path(), vec![response(value)]);
    let o = call(
        t.path(),
        &[
            "participant",
            "locations",
            "--conversation",
            "convA",
            "--group",
            "0",
            "--csv",
        ],
    );
    let (h, r) = table(&o);
    assert_eq!(h, ["lat", "lng", "n", "nested", "text"]);
    assert_eq!(r.len(), 2);
    assert_eq!(r[0][4], "=formula,\"quoted\"\r\n雪");
    assert_eq!(r[0][3], r#"{"a":[true,null]}"#);
    assert_eq!(r[1][3], "");
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn json_and_csv_preserve_existing_group_pids_and_empty_groups() {
    for mode in ["--json", "--csv"] {
        let t = tempfile::tempdir().unwrap();
        let value = json!({"bidToPid":[[],[0,7]],"future":null});
        let s = server(t.path(), vec![response(value.clone())]);
        let o = call(
            t.path(),
            &[
                "participant",
                "group-members",
                "--conversation",
                "convA",
                mode,
            ],
        );
        assert!(o.status.success());
        if mode == "--json" {
            assert_eq!(
                serde_json::from_slice::<Value>(&o.stdout).unwrap()["data"],
                value
            );
        } else {
            let (h, r) = table(&o);
            assert_eq!(h, ["bidToPid", "future"]);
            assert_eq!(r, vec![vec!["[[],[0,7]]", "null"]]);
        }
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn csv_owner_conversations_uses_only_the_json_read_with_no_report_lookup() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![response(
            json!([{"is_owner":true,"conversation_id":"convA","topic":"a very long topic with commas, and unicode 雪"}]),
        )],
    );
    let o = call(t.path(), &["--csv", "conversation", "list"]);
    let (h, r) = table(&o);
    assert_eq!(h, ["conversation_id", "is_owner", "topic"]);
    assert_eq!(r[0][2], "a very long topic with commas, and unicode 雪");
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/v3/conversations?"));
}
#[test]
fn csv_owner_xids_keep_leading_zeroes_and_empty_values() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![response(
            json!([{"pid":0,"xid":"00123"},{"pid":7,"xid":""}]),
        )],
    );
    let o = call(
        t.path(),
        &[
            "participant",
            "xid",
            "list",
            "--conversation",
            "convA",
            "--csv",
        ],
    );
    let (h, r) = table(&o);
    assert_eq!(h, ["pid", "xid"]);
    assert_eq!(r, vec![vec!["0", "00123"], vec!["7", ""]]);
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0]
        .to_lowercase()
        .contains("authorization: bearer generated-token"));
}
#[test]
fn csv_votes_preserve_wire_values_and_do_not_add_xids() {
    let t = tempfile::tempdir().unwrap();
    let vote = polis_contracts::votes::wire_values()["agree"].clone();
    assert!(!vote.is_null());
    let s = server(t.path(), vec![response(json!([{"tid":0,"vote":vote}]))]);
    let o = call(
        t.path(),
        &[
            "vote",
            "list",
            "--conversation",
            "convA",
            "--pid",
            "0",
            "--csv",
        ],
    );
    let (h, r) = table(&o);
    assert_eq!(h, ["tid", "vote"]);
    assert_eq!(r[0][1], vote.to_string());
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn empty_tables_are_header_only_and_errors_emit_no_csv() {
    for (status, body) in [(200, "[]"), (403, r#"{"error":"denied"}"#)] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![(status, "application/json", body.into())]);
        let o = call(
            t.path(),
            &[
                "participant",
                "xid",
                "list",
                "--conversation",
                "convA",
                "--csv",
            ],
        );
        if status == 200 {
            assert_eq!(o.stdout, b"value\r\n");
            assert!(o.status.success());
        } else {
            assert_eq!(o.status.code(), Some(4));
            assert!(o.stdout.is_empty());
        }
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn csv_is_rejected_before_configuration_for_writes_and_conflicting_modes() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), "broken").unwrap();
    for args in [
        vec!["site", "use", "default", "--csv"],
        vec!["comment", "convA", "text", "--csv"],
        vec!["site", "list", "--csv", "--json"],
    ] {
        let o = call(t.path(), &args);
        assert_eq!(o.status.code(), Some(2));
        assert_eq!(
            std::fs::read_to_string(t.path().join("profiles.json")).unwrap(),
            "broken"
        );
    }
}
#[test]
fn every_implemented_command_has_json_help_and_csv_discovery() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), "broken").unwrap();
    let o = call(t.path(), &["schema", "--json"]);
    assert!(o.status.success());
    let schema: Value = serde_json::from_slice(&o.stdout).unwrap();
    fn visit(v: &Value, t: &std::path::Path, count: &mut usize) {
        if v["implemented"] == true {
            *count += 1;
            let mut args: Vec<_> = v["command"]
                .as_str()
                .unwrap()
                .split_whitespace()
                .skip(1)
                .collect();
            args.extend(["--help", "--json"]);
            let o = call(t, &args);
            assert!(o.status.success(), "{args:?}");
            let help: Value = serde_json::from_slice(&o.stdout).unwrap();
            assert_eq!(help["ok"], true);
            assert!(help["data"]["help"].as_str().unwrap().contains("--json"));
            assert!(v["csv"].is_boolean());
        }
        for c in v["commands"].as_array().unwrap() {
            visit(c, t, count);
        }
    }
    let mut count = 0;
    visit(&schema["data"], t.path(), &mut count);
    // After retiring account invite, support contribute, math refresh/correlation and report export-start/export-results.
    assert!(count >= 156);
}

#[test]
fn csv_flag_does_not_replace_the_seed_csv_input_argument() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let input = t.path().join("seeds.csv");
    std::fs::write(
        &input,
        "comment_text,original_id\nGenerated seed,external-one\n",
    )
    .unwrap();
    let o = call(
        t.path(),
        &["seed", "csv", "preview", input.to_str().unwrap(), "--csv"],
    );
    let (headers, rows) = table(&o);
    assert_eq!(rows.len(), 1);
    assert!(headers.iter().any(|h| h == "comment_text"));
    assert!(rows[0].iter().any(|cell| cell == "Generated seed"));
}

#[test]
fn csv_generic_api_is_get_only_before_configuration() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("profiles.json"), "broken").unwrap();
    let o = call(
        t.path(),
        &["api", "/api/v3/users", "--method", "POST", "--csv"],
    );
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("read results only"));
}

#[test]
fn csv_participant_metadata_query_uses_existing_post_read() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![response(json!([{"pid":0},{"pid":7}]))]);
    let o = call(
        t.path(),
        &[
            "participant",
            "query",
            "--conversation",
            "convA",
            "--answers",
            "1",
            "--csv",
        ],
    );
    let (headers, rows) = table(&o);
    assert_eq!(headers, ["pid"]);
    assert_eq!(rows, vec![vec!["0"], vec!["7"]]);
    let requests = s.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /api/v3/query_participants_by_metadata "));
}
