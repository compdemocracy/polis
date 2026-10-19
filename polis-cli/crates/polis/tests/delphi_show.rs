//! `polis delphi show`: the report pages' collective statements and topic
//! statistics for one model's run, against a fixture HTTP server.
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
};

fn run(dir: &std::path::Path, args: &[&str], json: bool, token: bool) -> (i32, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("POLIS_CONFIG_DIR", dir)
        .args(args)
        .arg("--no-interactive")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if json {
        cmd.arg("--json");
    }
    if token {
        cmd.env("POLIS_TOKEN_LOCAL", "fixture-token");
    }
    let o = cmd.output().unwrap();
    let out = String::from_utf8(o.stdout).unwrap();
    assert!(!out.contains("fixture-token"));
    (o.status.code().unwrap(), out)
}
fn server(
    dir: &std::path::Path,
    responses: Vec<(u16, String)>,
) -> std::thread::JoinHandle<Vec<String>> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::fs::write(dir.join("profiles.json"),json!({"default":"local","sites":{"local":format!("http://{}",listener.local_addr().unwrap())}}).to_string()).unwrap();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
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
            while !bytes.windows(4).any(|x| x == b"\r\n\r\n") {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            requests.push(String::from_utf8(bytes).unwrap());
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    })
}
fn ok(body: &str) -> (u16, String) {
    (200, body.to_owned())
}

// Route bodies as the server writes them: key order and number spelling are
// kept so --json can be checked byte for byte.
const REPORTS: &str = r#"[{"report_id":"r1","conversation_id":"convA","mod_level":-2}]"#;
// Votes per statement: 2, 3, 3, 1.
const COMMENTS: &str = r#"[{"txt":"zero","tid":0,"agree_count":2,"disagree_count":0,"pass_count":0},{"txt":"one","tid":1,"agree_count":1,"disagree_count":1,"pass_count":1},{"txt":"two","tid":2,"agree_count":2,"disagree_count":0,"pass_count":1},{"txt":"three","tid":3,"agree_count":1,"disagree_count":0,"pass_count":0}]"#;
const MATH: &str = r#"{"math_tick":5,"group-consensus-normalized":{"0":0.5,"1":0.25,"2":0.75,"3":0.1250},"group-aware-consensus":{"0":0.9}}"#;
const DELPHI: &str = r#"{"status":"success","message":"LLM topics retrieved successfully","report_id":"r1","runs":{"alpha_2026-10-18":{"model_name":"alpha","created_date":"2026-10-18T10:00:00","topics_by_layer":{"0":{"0":{"topic_name":"Fine A","topic_key":"jobA#0#0"},"1":{"topic_name":"Fine B","topic_key":"jobA#0#1"}},"1":{"0":{"topic_name":"Coarse A","topic_key":"jobA#1#0"}}},"item_count":3,"job_uuid":null},"beta_2026-10-18":{"model_name":"beta","created_date":"2026-10-18T11:00:00","topics_by_layer":{"0":{"0":{"topic_name":"Beta fine topic","topic_key":"jobB#0#0"}},"1":{"0":{"topic_name":"Beta coarse topic","topic_key":"jobB#1#0"}}},"item_count":2,"job_uuid":null}}}"#;
const STATS: &str = r#"{"status":"success","message":"Topic statistics retrieved successfully","report_id":"r1","stats":{"jobA#0#0":{"comment_count":2,"comment_tids":[0,1]},"jobA#0#1":{"comment_count":2,"comment_tids":[2,3]},"jobA#1#0":{"comment_count":4,"comment_tids":[0,1,2,3]},"jobB#0#0":{"comment_count":4,"comment_tids":[0,1,2,3]},"jobB#1#0":{"comment_count":1,"comment_tids":[3]}},"total_topics":5}"#;
fn statement(topic: &str, name: &str, job: &str, model: &str, at: &str, text: &str) -> Value {
    json!({"statement_data":{"paragraphs":[{"id":"s1","title":"Shared ground","sentences":[{"clauses":[{"text":text,"citations":[3]}]}]}]},
        "topic_key":topic,"zid":"7","topic_name":name,"created_at":at,
        "zid_topic_jobid":format!("7#{topic}#{job}"),"model":model})
}
fn carousel() -> String {
    json!({"status":"success","statements":[
        statement("jobB#1#0","Beta coarse topic","stmtB1","beta","2026-10-18T12:00:00.000Z","Beta agrees."),
        statement("jobA#0#0","Fine A","stmtA1","alpha","2026-10-18T13:00:00.000Z","Alpha agrees."),
    ],"count":2})
    .to_string()
}
fn versions() -> String {
    json!({"status":"success","report_id":"r1","section":null,"count":4,"statements":[
        statement("jobA#0#0","Fine A","stmtA2","alpha","2026-10-18T14:00:00.000Z","Alpha again."),
        statement("jobB#1#0","Beta coarse topic","stmtB1","beta","2026-10-18T13:30:00.000Z","Beta agrees."),
        statement("jobA#0#0","Fine A","stmtA1","alpha","2026-10-18T13:00:00.000Z","Alpha agrees."),
        statement("jobA#1#0","Coarse A","stmtA3","alpha","2026-10-18T12:00:00.000Z","Alpha coarse."),
    ]})
    .to_string()
}
fn reads(stats: &str) -> Vec<(u16, String)> {
    vec![
        ok(REPORTS),
        ok(COMMENTS),
        ok(MATH),
        ok(DELPHI),
        ok(stats),
        ok(&carousel()),
    ]
}
fn squash(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect()
}
fn before(text: &str, parts: &[&str]) {
    let at: Vec<usize> = parts
        .iter()
        .map(|p| {
            text.find(p)
                .unwrap_or_else(|| panic!("missing {p:?} in\n{text}"))
        })
        .collect();
    assert!(
        at.windows(2).all(|w| w[0] < w[1]),
        "order {parts:?} in\n{text}"
    );
}

#[test]
fn prints_the_carousel_then_the_topic_table_in_the_pages_order() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), reads(STATS));
    let (exit, out) = run(t.path(), &["delphi", "show", "r1"], false, false);
    assert_eq!(exit, 0, "{out}");
    let req = s.join().unwrap();
    let lines: Vec<&str> = req.iter().map(|r| r.lines().next().unwrap()).collect();
    assert_eq!(
        lines,
        [
            "GET /api/v3/reports?report_id=r1 HTTP/1.1",
            "GET /api/v3/comments?conversation_id=convA&report_id=r1&moderation=true&mod_gt=-2&include_voting_patterns=true HTTP/1.1",
            "GET /api/v3/math/pca2?lastVoteTimestamp=0&conversation_id=convA HTTP/1.1",
            "GET /api/v3/delphi?report_id=r1 HTTP/1.1",
            "GET /api/v3/topicStats?report_id=r1 HTTP/1.1",
            "GET /api/v3/collectiveStatement?report_id=r1 HTTP/1.1",
        ]
    );
    assert!(!req[0].to_lowercase().contains("authorization:"));
    // The page shows the run key that sorts last (beta), and every statement,
    // newest first.
    before(
        &out,
        &[
            "Report r1 (conversation convA)",
            "Run: model beta, created 2026-10-18T11:00:00, job jobB",
            "Stored models: alpha, beta",
            "COLLECTIVE STATEMENTS (2)",
            "1 of 2: Fine A",
            "Topic jobA#0#0 (job jobA); statement job stmtA1; model alpha; created 2026-10-18T13:00:00.000Z",
            "Shared ground\nAlpha agrees. [3]",
            "2 of 2: Beta coarse topic",
            "statement job stmtB1; model beta",
            "TOPIC STATISTICS (model beta)",
            "Coarse: 1 Topics (Big picture themes) (layer 1)",
            "Finer Grained: 1 Topics (Specific insights) (layer 0)",
        ],
    );
    let rows = squash(&out);
    // 1 vote over 1 statement; consensus 0.125 rounds up as toFixed(2) does.
    assert!(
        rows.contains(&"1 1 1.0 0.13 Beta coarse topic [jobB#1#0]".to_owned()),
        "{out}"
    );
    // 9 votes over 4 statements is 2.25, which toFixed(1) prints as 2.3.
    assert!(
        rows.contains(&"4 9 2.3 0.41 Beta fine topic [jobB#0#0]".to_owned()),
        "{out}"
    );
}

#[test]
fn model_selects_its_run_and_its_newest_statement_per_topic() {
    let t = tempfile::tempdir().unwrap();
    let mut responses = reads(STATS);
    responses.push(ok(&versions()));
    let s = server(t.path(), responses);
    let (exit, out) = run(
        t.path(),
        &["delphi", "show", "r1", "--model", "alpha"],
        false,
        false,
    );
    assert_eq!(exit, 0, "{out}");
    let req = s.join().unwrap();
    assert!(req[6].starts_with("GET /api/v3/delphi/collective/results?report_id=r1 "));
    before(
        &out,
        &[
            "Run: model alpha, created 2026-10-18T10:00:00, job jobA",
            "COLLECTIVE STATEMENTS (2)",
            "2 other stored statements (other models or older versions) not shown.",
            "1 of 2: Fine A",
            "statement job stmtA2; model alpha",
            "Alpha again. [3]",
            "2 of 2: Coarse A",
            "statement job stmtA3",
            "TOPIC STATISTICS (model alpha)",
            "Coarse: 1 Topics",
            "Finer Grained: 2 Topics",
            "Fine A [jobA#0#0]",
            "Fine B [jobA#0#1]",
        ],
    );
    assert!(!out.contains("Alpha agrees.") && !out.contains("Beta agrees."));
    let rows = squash(&out);
    for row in [
        "4 9 2.3 0.41 Coarse A [jobA#1#0]",
        "2 5 2.5 0.38 Fine A [jobA#0#0]",
        "2 4 2.0 0.44 Fine B [jobA#0#1]",
    ] {
        assert!(rows.contains(&row.to_owned()), "{row} in\n{out}");
    }
}

#[test]
fn json_carries_every_route_body_byte_for_byte() {
    let t = tempfile::tempdir().unwrap();
    let s = server(t.path(), reads(STATS));
    let (exit, out) = run(t.path(), &["delphi", "show", "r1"], true, false);
    assert_eq!(exit, 0, "{out}");
    s.join().unwrap();
    let carousel = carousel();
    for body in [REPORTS, COMMENTS, MATH, DELPHI, STATS, carousel.as_str()] {
        assert!(out.contains(body), "body not verbatim: {body}");
    }
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["schema"], "polis-cli/1");
    assert_eq!(v["ok"], true);
    let data = &v["data"];
    assert_eq!(data["run"]["key"], "beta_2026-10-18");
    assert_eq!(data["run"]["jobs"], json!(["jobB"]));
    assert_eq!(
        data["reads"][2]["route"],
        "GET /api/v3/math/pca2?lastVoteTimestamp=0&conversation_id=convA"
    );
    assert_eq!(data["reads"][5]["body"]["count"], 2);
    assert_eq!(data["collective_statements"][0]["statement_job"], "stmtA1");
    assert_eq!(data["topic_stats"][1]["topics"][0]["vote_density"], "2.3");
}

#[test]
fn errors_keep_their_exit_codes() {
    // 2: input is checked before any request or credential read.
    for args in [
        vec!["delphi", "show", "bad-id!"],
        vec!["delphi", "show", "r1", "--model", " "],
    ] {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(
            t.path().join("profiles.json"),
            r#"{"default":"local","sites":{"local":"http://127.0.0.1:1"}}"#,
        )
        .unwrap();
        let (exit, out) = run(t.path(), &args, true, false);
        assert_eq!(exit, 2, "{args:?} {out}");
    }
    // 3: an unsafe credential store refuses even a public read.
    {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        std::fs::write(
            t.path().join("profiles.json"),
            r#"{"default":"local","sites":{"local":"http://127.0.0.1:1"}}"#,
        )
        .unwrap();
        std::fs::create_dir(t.path().join("credentials")).unwrap();
        std::fs::set_permissions(
            t.path().join("credentials"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let (exit, out) = run(t.path(), &["delphi", "show", "r1"], true, false);
        assert_eq!(exit, 3, "{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["error"]["code"], "credential_file_unsafe");
    }
    // 4, 6, 7, 1 and 8 from the site's answers.
    let forbidden = vec![(403, r#"{"status":"error"}"#.to_owned())];
    let mut server_error = reads(STATS);
    server_error.truncate(4);
    server_error.push((
        500,
        r#"{"status":"error","message":"private detail"}"#.to_owned(),
    ));
    // The chosen run's topics are absent from a non-empty topicStats answer.
    let disagree = reads(
        r#"{"status":"success","stats":{"jobC#0#0":{"comment_count":0,"comment_tids":[]}},"total_topics":1}"#,
    );
    let mut no_model = reads(STATS);
    no_model.push(ok(&versions()));
    let mut unserved = reads(STATS);
    unserved.push((404, r#"{"status":"error"}"#.to_owned()));
    for (responses, args, exit, code) in [
        (forbidden, vec![], 4, "forbidden"),
        (server_error, vec![], 6, "server_error"),
        (disagree, vec![], 7, "reads_disagree"),
        (
            no_model,
            vec!["--model", "gamma"],
            1,
            "model_run_unavailable",
        ),
        (
            unserved,
            vec!["--model", "alpha"],
            8,
            "capability_unavailable",
        ),
    ] {
        let t = tempfile::tempdir().unwrap();
        let s = server(t.path(), responses);
        let mut all = vec!["delphi", "show", "r1"];
        all.extend(args);
        let (got, out) = run(t.path(), &all, true, true);
        assert_eq!(got, exit, "{code}: {out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], code);
        assert!(!out.contains("private detail"));
        s.join().unwrap();
    }
}

#[test]
fn a_report_without_a_run_says_so() {
    let t = tempfile::tempdir().unwrap();
    let s = server(
        t.path(),
        vec![
            ok(REPORTS),
            ok(COMMENTS),
            ok(MATH),
            ok(
                r#"{"status":"success","message":"No LLM topics found for this conversation","report_id":"r1","runs":{}}"#,
            ),
            ok(
                r#"{"status":"success","message":"No topics found for this conversation","stats":{}}"#,
            ),
            ok(r#"{"status":"success","statements":[],"count":0}"#),
        ],
    );
    let (exit, out) = run(t.path(), &["delphi", "show", "r1"], false, false);
    assert_eq!(exit, 0, "{out}");
    s.join().unwrap();
    before(
        &out,
        &[
            "No Delphi run is stored for this report.",
            "COLLECTIVE STATEMENTS (0)",
            "No stored collective statements.",
            "TOPIC STATISTICS",
            "No topics.",
        ],
    );
}
