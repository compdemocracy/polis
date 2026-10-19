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
fn report() -> Value {
    json!([{"report_id":"rA","conversation_id":"convA"}])
}
#[test]
fn public_topics_preserve_unavailable_moderation_and_job_filter() {
    let t = tempfile::tempdir().unwrap();
    let body = json!({"status":"success","topics_by_layer":{"0":[]},"moderation_available":false});
    let s = server(t.path(), vec![json_res(body.clone())]);
    let (exit, v) = call(
        t.path(),
        &["topic", "list", "--conversation", "convA", "--job", "job-A"],
        None,
        false,
    );
    assert_eq!(exit, 0);
    assert_eq!(v["data"], body);
    let req = s.join().unwrap();
    assert!(req[0].starts_with("GET /api/v3/topicMod/topics?conversation_id=convA&job_id=job-A "));
    assert!(!req[0].to_lowercase().contains("authorization:"));
}
#[test]
fn topic_key_is_one_encoded_segment_and_round_trips_special_characters() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(json!({"status":"success","comments":[]}))],
    );
    assert_eq!(
        parsed_call(
            t.path(),
            &[
                "topic",
                "statements",
                "job#0#1?%&猫",
                "--conversation",
                "convA"
            ]
        )
        .0,
        0
    );
    let req = s.join().unwrap();
    assert!(req[0].starts_with("GET /api/v3/topicMod/topics/job%230%231%3F%25&%E7%8C%AB/comments?conversation_id=convA "),"{}",req[0]);
}
#[test]
fn unsafe_topic_inputs_refuse_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for key in [
        "",
        ".",
        "..",
        "../users",
        "a/b",
        "a\\b",
        "a\nb",
        &"x".repeat(1025),
    ] {
        assert_eq!(
            parsed_call(
                t.path(),
                &["topic", "statements", key, "--conversation", "convA"]
            )
            .0,
            2
        );
    }
    for layer in ["-1", "1a", "2147483648", ""] {
        assert_eq!(
            parsed_call(
                t.path(),
                &[
                    "topic",
                    "proximity",
                    "--conversation",
                    "convA",
                    "--layer",
                    layer
                ]
            )
            .0,
            2
        );
    }
    for job in ["", "job#0", "job?x=1", &"x".repeat(257)] {
        assert_eq!(
            parsed_call(
                t.path(),
                &["topic", "list", "--conversation", "convA", "--job", job]
            )
            .0,
            2
        );
    }
}
#[test]
fn all_other_topic_reads_preserve_empty_and_populated_shapes() {
    for (leaf, body) in [
        ("hierarchy", json!({"status":"success","hierarchy":null})),
        (
            "hierarchy",
            json!({"status":"success","hierarchy":{"children":[]}}),
        ),
        (
            "proximity",
            json!({"status":"success","proximity_data":[{"umap_x":1.2,"umap_y":3.4}]}),
        ),
        (
            "stats",
            json!({"status":"success","stats":{"total_topics":0},"moderation_available":false}),
        ),
        (
            "stats",
            json!({"status":"success","stats":{"accepted":1},"moderation_available":true}),
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body.clone())]);
        let (exit, v) = parsed_call(t.path(), &["topic", leaf, "--conversation", "convA"]);
        assert_eq!(exit, 0);
        assert_eq!(v["data"], body);
        s.join().unwrap();
    }
}
#[test]
fn proximity_accepts_dynamic_layers_without_remapping() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![json_res(json!({"status":"success","proximity_data":[]}))],
    );
    assert_eq!(
        parsed_call(
            t.path(),
            &[
                "topic",
                "proximity",
                "--conversation",
                "convA",
                "--layer",
                "12"
            ]
        )
        .0,
        0
    );
    assert!(s.join().unwrap()[0].contains("layer_id=12"));
}
#[test]
fn missing_store_is_not_empty_success_and_diagnostics_are_not_reflected() {
    let t = tempfile::tempdir().unwrap();
    let s=server(t.path(),vec![(503,"application/json",json!({"error":"polis_err_topicMod_comments_store_missing","details":"private-upstream-detail"}).to_string())]);
    let (exit, v) = parsed_call(
        t.path(),
        &["topic", "statements", "job#0#1", "--conversation", "convA"],
    );
    assert_eq!(exit, 6);
    assert_eq!(v["error"]["code"], "topic_statements_unavailable");
    assert!(v["error"]["action"]
        .as_str()
        .unwrap()
        .contains("report statements list"));
    assert!(!v.to_string().contains("private-upstream-detail"));
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn http_200_topic_errors_have_context_without_raw_diagnostics() {
    for status in [200, 500] {
        let t = tempfile::tempdir().unwrap();
        let s = server(
            t.path(),
            vec![(
                status,
                "application/json",
                json!({"status":"error","error":"private-upstream-detail"}).to_string(),
            )],
        );
        let (exit, v) = parsed_call(t.path(), &["topic", "hierarchy", "--conversation", "convA"]);
        assert_eq!(exit, if status == 200 { 1 } else { 6 });
        assert_eq!(v["error"]["code"], "topic_read_failed");
        assert!(!v.to_string().contains("private-upstream-detail"));
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn authentication_failure_is_not_disguised_as_missing_topics() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), vec![(401, "application/json", "{}".into())]);
    let (exit, v) = parsed_call(t.path(), &["topic", "list", "--conversation", "convA"]);
    assert_eq!(exit, 3);
    assert_eq!(v["error"]["code"], "auth_invalid");
    s.join().unwrap();
}
#[test]
fn malformed_topic_success_is_rejected() {
    for body in [
        json!({}),
        json!({"status":"success","hierarchy":[]}),
        json!({"status":"success"}),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = parsed_call(t.path(), &["topic", "hierarchy", "--conversation", "convA"]);
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        s.join().unwrap();
    }
}
#[test]
fn report_reads_resolve_the_matching_conversation_and_preserve_fields() {
    for (args, body, route) in [
        (
            vec!["report", "topics", "rA", "--job", "job-A"],
            json!({"status":"success","topics":[]}),
            "/api/v3/topicMod/topics?conversation_id=convA&job_id=job-A",
        ),
        (
            vec!["report", "stats", "rA", "--until", "1234"],
            json!({"voteTimes":[],"commentTimes":[]}),
            "/api/v3/conversationStats?conversation_id=convA&report_id=rA&until=1234",
        ),
        (
            vec![
                "report",
                "statements",
                "list",
                "rA",
                "--limit",
                "2",
                "--offset",
                "4",
            ],
            json!({"comments":[{"tid":4,"includeInReport":false}],"pagination":{"total":5}}),
            "/api/v3/comments?conversation_id=convA&report_id=rA&limit=2&offset=4",
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(report()), json_res(body.clone())]);
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert_eq!(v["data"], body);
        let req = s.join().unwrap();
        assert!(req[0].starts_with("GET /api/v3/reports?report_id=rA "));
        assert!(req[1].starts_with(&format!("GET {route} ")));
        assert!(req
            .iter()
            .all(|r| !r.to_lowercase().contains("authorization:")));
    }
}
#[test]
fn report_mismatch_or_ambiguity_prevents_the_second_read() {
    for body in [
        json!([]),
        json!({}),
        json!([{}, {}]),
        json!([{"report_id":"rB","conversation_id":"convA"}]),
        json!([{"report_id":"rA","conversation_id":"../x"}]),
        json!([{"report_id":"rA"}]),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), vec![json_res(body)]);
        let (exit, v) = call(t.path(), &["report", "stats", "rA"], None, false);
        assert_eq!(exit, 1);
        assert_eq!(v["error"]["code"], "invalid_response");
        assert_eq!(s.join().unwrap().len(), 1);
    }
}
#[test]
fn read_failure_stops_without_retries_or_writes() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![(
            500,
            "application/json",
            json!({"error":"polis_err_get_reports_misc"}).to_string(),
        )],
    );
    let (exit, v) = parsed_call(t.path(), &["report", "stats", "rA"]);
    assert_eq!(exit, 6);
    assert_eq!(v["error"]["code"], "report_read_failed");
    assert_eq!(s.join().unwrap().len(), 1);
}
#[test]
fn help_describes_read_semantics_and_schema_lists_arguments() {
    let t = tempfile::tempdir().unwrap();
    for (args, expected) in [
        (vec!["help", "topic", "list"], "moderation_available=false"),
        (vec!["help", "topic", "statements"], "missing"),
        (
            vec!["help", "report", "statements", "list"],
            "participant-visible",
        ),
        (vec!["help", "report", "stats"], "historical event"),
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 0);
        assert!(v["data"]["help"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains(&expected.to_lowercase()));
    }
    let (exit, v) = call(t.path(), &["schema", "topic", "proximity"], None, false);
    assert_eq!(exit, 0);
    assert!(v.to_string().contains("layer"));
}

#[test]
fn report_topics_accepts_report_option_and_preserves_positional_form() {
    for args in [
        vec!["report", "topics", "rA", "--job", "job-A"],
        vec!["report", "topics", "--report", "rA", "--job", "job-A"],
    ] {
        let t = tempfile::tempdir().unwrap();
        let body = json!({"status":"success","topics_by_layer":{"0":[]}});
        let s = server(t.path(), vec![json_res(report()), json_res(body.clone())]);
        let (exit, v) = parsed_call(t.path(), &args);
        assert_eq!(exit, 0, "{v}");
        assert_eq!(v["data"], body);
        let requests = s.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /api/v3/reports?report_id=rA "));
        assert!(requests[1]
            .starts_with("GET /api/v3/topicMod/topics?conversation_id=convA&job_id=job-A "));
    }
}

#[test]
fn report_topics_refuses_ambiguous_missing_or_invalid_ids_before_network() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    for args in [
        vec!["report", "topics"],
        vec!["report", "topics", "rA", "--report", "rA"],
        vec!["report", "topics", "rA", "--report", "rB"],
        vec!["report", "topics", "--report", "rA", "--report", "rB"],
        vec!["report", "topics", "--report", "../invalid"],
        vec!["report", "topics", "--report", ""],
    ] {
        let (exit, v) = call(t.path(), &args, None, false);
        assert_eq!(exit, 2, "{v}");
        assert_eq!(v["error"]["outcome"], "not_sent");
    }
}
