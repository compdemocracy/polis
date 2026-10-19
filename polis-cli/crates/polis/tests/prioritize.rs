use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
};

const C: &str = "2demo";
const TOKEN: &str = "participant-secret-fixture";
const LOGIN: &str = "returning-secret-fixture";
const TYPED: &str = "private-typed-value";

fn command(dir: &std::path::Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_polis"));
    for (key, _) in std::env::vars() {
        if key.starts_with("POLIS_TOKEN_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("POLIS_CONFIG_DIR", dir)
        .env_remove("POLIS_TOKEN")
        .env_remove("POLIS_SITE")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}
fn clean_output(o: &std::process::Output) -> String {
    let (out, err) = (
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr),
    );
    for secret in [TOKEN, LOGIN, TYPED, "private-correlation"] {
        assert!(!out.contains(secret) && !err.contains(secret), "{secret}");
    }
    out.into_owned()
}
fn call(dir: &std::path::Path, args: &[&str]) -> (i32, Value) {
    let o = command(dir, args)
        .args(["--json", "--no-interactive"])
        .output()
        .unwrap();
    let out = clean_output(&o);
    (
        o.status.code().unwrap(),
        serde_json::from_str(&out).unwrap(),
    )
}
fn human(dir: &std::path::Path, args: &[&str]) -> (i32, String) {
    let o = command(dir, args).output().unwrap();
    (o.status.code().unwrap(), clean_output(&o))
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
fn ok(v: Value) -> (u16, &'static str, String) {
    (200, "application/json", v.to_string())
}
fn failing(status: u16) -> (u16, &'static str, String) {
    (
        status,
        "application/json\r\nX-Request-Id: private-correlation",
        json!({"status":"error","message":"Topic unavailable","detail":"private-correlation"})
            .to_string(),
    )
}
fn body(request: &str) -> Value {
    serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}
fn authorized(request: &str) -> bool {
    request.to_ascii_lowercase().contains("authorization:")
}
fn private(dir: &std::path::Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir.join("credentials")) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| {
            let p = e.unwrap().path();
            (p.extension().unwrap() == "json")
                .then(|| serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap())
        })
        .collect()
}

fn topics() -> Value {
    json!({"status":"success","message":"Topics retrieved successfully","topics_by_layer":{
        "0":[{"topic_name":"Parks","model_name":"fixture","topic_key":"run-1#0#7","layer_id":"0","cluster_id":"7",
              "moderation":{"status":"pending","moderator":null,"moderated_at":null,"comment_count":0}}],
        "1":[{"topic_name":"Transit","topic_key":"run-1#1#2","layer_id":"1","cluster_id":"2"},
             {"topic_name":"Housing","topic_key":"run-1#1#3","layer_id":"1","cluster_id":"3"}],
        "2":[{"topic_name":"Unplaced","topic_key":"run-1#2#0","layer_id":"2","cluster_id":"0"}]},
        "total_topics":4,"moderation_available":false})
}
fn proximity() -> Value {
    json!({"status":"success","message":"All proximity data retrieved successfully","proximity_data":[
        {"comment_id":5,"umap_x":0,"umap_y":0,"weight":1,"clusters":{"0":7,"1":2}},
        {"comment_id":6,"umap_x":2,"umap_y":0,"weight":1,"clusters":{"1":2}},
        {"comment_id":7,"umap_x":0,"umap_y":2,"weight":1,"clusters":{"1":2}},
        {"comment_id":8,"umap_x":2,"umap_y":2,"weight":1,"clusters":{"1":2}},
        {"comment_id":9,"umap_x":1,"umap_y":1,"weight":1,"clusters":{"1":2}},
        {"comment_id":10,"umap_x":9,"umap_y":9,"weight":1,"clusters":{"1":3}},
        {"comment_id":11,"umap_x":1,"umap_y":1,"weight":1,"clusters":{}},
        {"comment_id":12,"umap_x":0.5,"umap_y":-1.25,"weight":1,"clusters":{"0":7}}],
        "total_points":8})
}
fn comments() -> Value {
    json!([{"tid":5,"txt":"Five"},{"tid":6,"txt":"Six"},{"tid":7,"txt":"Seven"},
           {"tid":9,"txt":"Nine","mod":-1},{"tid":10,"txt":"Ten"}])
}
/// The selection the participation page builds for these fixtures: each topic's
/// three statements nearest the mean of its coordinates, stable on ties.
fn selections() -> Value {
    let root2 = 2f64.sqrt();
    let parks = 0.453125f64.sqrt();
    json!([
        {"layer_id":1,"cluster_id":"2","topic_key":"run-1#1#2","archetypal_comments":[
            {"comment_id":9,"comment_text":"Nine","coordinates":{"x":1,"y":1},"distance_to_centroid":0},
            {"comment_id":5,"comment_text":"Five","coordinates":{"x":0,"y":0},"distance_to_centroid":root2},
            {"comment_id":6,"comment_text":"Six","coordinates":{"x":2,"y":0},"distance_to_centroid":root2}]},
        {"layer_id":0,"cluster_id":"7","topic_key":"run-1#0#7","archetypal_comments":[
            {"comment_id":5,"comment_text":"Five","coordinates":{"x":0,"y":0},"distance_to_centroid":parks},
            {"comment_id":12,"comment_text":"[Comment 12]","coordinates":{"x":0.5,"y":-1.25},"distance_to_centroid":parks}]}
    ])
}
fn saved(job: &str) -> Value {
    json!({"status":"success","message":"Topic agenda selections saved successfully",
        "data":{"conversation_id":"12","participant_id":"0","selections_count":2,"job_id":job},
        "auth":{"token":TOKEN,"token_type":"Bearer","expires_in":3600}})
}
fn readback(job: &str) -> Value {
    json!({"status":"success","data":{"conversation_id":"12","participant_id":"0",
        "archetypal_selections":selections(),"delphi_job_id":job,"total_selections":2,
        "created_at":"2026-10-18T00:00:00.000Z","updated_at":"2026-10-18T00:00:01.000Z"}})
}
fn preflight() -> Vec<(u16, &'static str, String)> {
    vec![ok(topics()), ok(proximity()), ok(comments())]
}
fn save_args() -> Vec<&'static str> {
    vec!["topic", "prioritize", C, "--topics", "run-1#1#2, run-1#0#7"]
}
fn without_auth(mut v: Value) -> Value {
    v.as_object_mut().unwrap().remove("auth");
    v
}
fn none() -> Value {
    json!({"status":"success","message":"No selections found","data":null})
}
/// A one-time invite issues the participant identity that later saves reuse.
/// Credentials are scoped by origin, so one fixture server serves the sequence.
fn invited() -> (u16, &'static str, String) {
    ok(json!({"status":"ok","auth":{"token":TOKEN,"token_type":"Bearer"},"login_code":LOGIN}))
}

#[test]
fn a_save_sends_the_participation_page_shape_once_and_reads_it_back() {
    let d = tempfile::tempdir().unwrap();
    let mut responses = preflight();
    responses.extend([
        ok(saved("run-1")),
        ok(readback("run-1")),
        ok(readback("run-1")),
    ]);
    let t = server(d.path(), responses);
    let (code, v) = call(d.path(), &save_args());
    assert_eq!(code, 0, "{v}");
    // The site's responses, unchanged apart from the issued token.
    assert_eq!(
        v["data"],
        json!({"receipt":without_auth(saved("run-1")),"readback":readback("run-1")})
    );
    assert_eq!(private(d.path())[0]["token"], TOKEN);
    // The saved identity reads its own choice back, unchanged.
    let (code, v) = call(d.path(), &["topic", "prioritize", C, "--show"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"], readback("run-1"));

    let rs = t.join().unwrap();
    assert_eq!(rs.len(), 6);
    for (r, line) in rs.iter().zip([
        "GET /api/v3/topicMod/topics?conversation_id=2demo&job_id=run-1 ",
        "GET /api/v3/topicMod/proximity?conversation_id=2demo&layer_id=all ",
        "GET /api/v3/comments?conversation_id=2demo&moderation=true ",
        "POST /api/v3/topicAgenda/selections ",
        "GET /api/v3/topicAgenda/selections?conversation_id=2demo ",
        "GET /api/v3/topicAgenda/selections?conversation_id=2demo ",
    ]) {
        assert!(r.starts_with(line), "{r}");
    }
    assert!(rs[..4].iter().all(|r| !authorized(r)));
    assert!(rs[4..]
        .iter()
        .all(|r| r.contains(&format!("Bearer {TOKEN}"))));
    assert_eq!(
        body(&rs[3]),
        json!({"conversation_id":C,"selections":selections()})
    );
    // Integral numbers are written as JavaScript writes them.
    let sent = rs[3].split("\r\n\r\n").nth(1).unwrap();
    assert!(!sent.contains(".0,") && !sent.contains(".0}"), "{sent}");
}

#[test]
fn a_save_reuses_the_saved_participant_and_its_returning_login() {
    let d = tempfile::tempdir().unwrap();
    let mut responses = vec![invited()];
    responses.extend(preflight());
    responses.extend([ok(without_auth(saved("run-1"))), ok(readback("run-1"))]);
    let t = server(d.path(), responses);
    assert_eq!(call(d.path(), &["join", C, "--invite", "invite"]).0, 0);
    let (code, v) = call(d.path(), &save_args());
    assert_eq!(code, 0, "{v}");
    let rs = t.join().unwrap();
    assert!(rs[1..]
        .iter()
        .all(|r| r.contains(&format!("Bearer {TOKEN}"))));
    let creds = private(d.path());
    assert_eq!(creds.len(), 1);
    assert_eq!(creds[0]["token"], TOKEN);
    assert_eq!(creds[0]["participant_login"], LOGIN);
}

#[test]
fn show_and_clear_return_the_site_responses_unchanged() {
    let d = tempfile::tempdir().unwrap();
    let deleted =
        json!({"status":"success","message":"Topic agenda selections deleted successfully"});
    let t = server(
        d.path(),
        vec![
            ok(none()),
            invited(),
            ok(deleted.clone()),
            ok(none()),
            ok(deleted.clone()),
            ok(readback("run-1")),
        ],
    );
    // No saved identity: the read is sent without a token and nothing is saved.
    let (code, v) = call(d.path(), &["topic", "prioritize", C, "--show"]);
    assert_eq!((code, &v["data"]), (0, &none()));
    assert!(private(d.path()).is_empty());
    // Nothing to clear without an identity, and nothing is sent.
    let (code, v) = call(d.path(), &["topic", "prioritize", C, "--clear"]);
    assert_eq!(code, 3);
    assert_eq!(v["error"]["code"], "participant_credentials_missing");

    assert_eq!(call(d.path(), &["join", C, "--invite", "invite"]).0, 0);
    let (code, v) = call(d.path(), &["topic", "prioritize", C, "--clear"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["data"], json!({"receipt":deleted,"readback":none()}));
    // A read-back that still holds a choice leaves the outcome uncertain.
    let (code, v) = call(d.path(), &["topic", "prioritize", C, "--clear"]);
    assert_eq!(code, 7);
    assert_eq!(v["error"]["outcome"], "unknown");

    let rs = t.join().unwrap();
    assert_eq!(rs.len(), 6);
    assert!(rs[0].starts_with("GET /api/v3/topicAgenda/selections?conversation_id=2demo "));
    assert!(!authorized(&rs[0]));
    assert!(rs[1].starts_with("POST /api/v3/treevite/acceptInvite "));
    for r in [&rs[2], &rs[4]] {
        assert!(r.starts_with("DELETE /api/v3/topicAgenda/selections "));
        assert_eq!(body(r), json!({"conversation_id":C}));
    }
    assert!(rs[3].starts_with("GET /api/v3/topicAgenda/selections?conversation_id=2demo "));
    assert!(rs[2..]
        .iter()
        .all(|r| r.contains(&format!("Bearer {TOKEN}"))));
}

#[test]
fn input_is_refused_before_any_credential_is_read() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    std::fs::write(
        d.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:1"}}"#,
    )
    .unwrap();
    let dir = d.path().join("credentials");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let typed = format!("run-1#1#2,{TYPED}");
    let mixed = "run-1#1#2,run-2#1#3".to_owned();
    let twice = "run-1#1#2,run-1#1#2".to_owned();
    for args in [
        vec!["topic", "prioritize", "not an id", "--show"],
        vec!["topic", "prioritize", C],
        vec!["topic", "prioritize", C, "--show", "--clear"],
        vec!["topic", "prioritize", C, "--topics", "run-1#1#2", "--show"],
        vec!["topic", "prioritize", C, "--topics", ""],
        vec!["topic", "prioritize", C, "--topics", &typed],
        vec!["topic", "prioritize", C, "--topics", &mixed],
        vec!["topic", "prioritize", C, "--topics", &twice],
        vec!["topic", "prioritize", C, "--topics", "run-1#01#2"],
    ] {
        let (code, v) = call(d.path(), &args);
        assert_eq!(code, 2, "{args:?} {v}");
        assert_eq!(v["error"]["code"], "invalid_input", "{args:?}");
        let (code, _) = human(d.path(), &args);
        assert_eq!(code, 2, "{args:?}");
    }
    let (code, v) = call(
        d.path(),
        &["topic", "prioritize", C, "--topics", "run-1#1#2"],
    );
    assert_eq!(code, 3);
    assert_eq!(v["error"]["code"], "credential_file_unsafe");
}

#[test]
fn topics_missing_from_the_run_or_its_coordinates_are_refused_with_nothing_sent() {
    let d = tempfile::tempdir().unwrap();
    for (topics_arg, responses, position) in [
        ("run-1#1#9", vec![ok(topics())], "Topic key 1 "),
        (
            "run-1#1#2,run-1#1#9",
            vec![ok(
                json!({"status":"success","message":"No topics found for this conversation","topics":[]}),
            )],
            "Topic key 1 ",
        ),
        (
            "run-1#1#2,run-1#2#0",
            vec![ok(topics()), ok(proximity())],
            "Topic key 2 ",
        ),
    ] {
        let n = responses.len();
        let t = server(d.path(), responses);
        let (code, v) = call(
            d.path(),
            &["topic", "prioritize", C, "--topics", topics_arg],
        );
        assert_eq!(code, 5, "{v}");
        assert_eq!(v["error"]["code"], "topic_unavailable");
        assert_eq!(v["error"]["outcome"], "not_sent");
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with(position));
        assert_eq!(t.join().unwrap().len(), n);
    }
    assert!(private(d.path()).is_empty());
}

#[test]
fn malformed_reads_before_the_write_send_nothing() {
    let d = tempfile::tempdir().unwrap();
    let mut unplaced = proximity();
    unplaced["proximity_data"][1]
        .as_object_mut()
        .unwrap()
        .remove("comment_id");
    for responses in [
        vec![ok(json!({"status":"success"}))],
        vec![ok(
            json!({"status":"success","topics_by_layer":{"1":[{"topic_name":"No key"}]}}),
        )],
        vec![ok(topics()), ok(unplaced)],
        vec![
            ok(topics()),
            ok(json!({"status":"success","proximity_data":{}})),
        ],
        vec![ok(topics()), ok(proximity()), ok(json!({"comments":[]}))],
        vec![
            ok(topics()),
            ok(proximity()),
            ok(json!([{"tid":"5","txt":"Five"}])),
        ],
    ] {
        let n = responses.len();
        let t = server(d.path(), responses);
        let (code, v) = call(d.path(), &save_args());
        assert_eq!(code, 1, "{v}");
        assert_eq!(v["error"]["code"], "invalid_response");
        assert_eq!(t.join().unwrap().len(), n);
    }
}

#[test]
fn errors_map_to_exit_codes_without_retry_or_echo() {
    // Reads before the write, and --show.
    for (status, exit) in [(500, 6), (403, 4), (401, 3), (429, 6), (0, 6)] {
        let d = tempfile::tempdir().unwrap();
        let t = server(d.path(), vec![failing(status)]);
        let (code, v) = call(d.path(), &save_args());
        assert_eq!(code, exit, "{status} {v}");
        if (400..500).contains(&status) {
            assert_eq!(v["error"]["upstream"]["message"], "Topic unavailable");
        }
        assert_eq!(t.join().unwrap().len(), 1);
        let t = server(d.path(), vec![failing(status)]);
        assert_eq!(
            call(d.path(), &["topic", "prioritize", C, "--show"]).0,
            exit
        );
        assert_eq!(t.join().unwrap().len(), 1);
    }
    // The write itself.
    for (status, exit) in [(500, 7), (0, 7), (403, 4), (401, 3), (400, 1)] {
        let d = tempfile::tempdir().unwrap();
        let mut responses = preflight();
        responses.push(failing(status));
        let t = server(d.path(), responses);
        let (code, v) = call(d.path(), &save_args());
        assert_eq!(code, exit, "{status} {v}");
        if exit == 7 {
            assert_eq!(v["error"]["outcome"], "unknown");
        }
        assert_eq!(t.join().unwrap().len(), 4);
    }
    // After the write, every failure to confirm it is uncertain.
    let mut other = readback("run-1");
    other["data"]["archetypal_selections"][0]["topic_key"] = json!("run-1#1#3");
    let mut count = saved("run-1");
    count["data"]["selections_count"] = json!(1);
    for (after, requests) in [
        (vec![failing(500)], 5),
        (vec![failing(403)], 5),
        (vec![(0, "application/json", String::new())], 5),
        (vec![ok(other)], 5),
        (vec![ok(readback("run-2"))], 5),
        (vec![ok(none())], 5),
    ] {
        let d = tempfile::tempdir().unwrap();
        let mut responses = preflight();
        responses.push(ok(saved("run-1")));
        responses.extend(after);
        let t = server(d.path(), responses);
        let (code, v) = call(d.path(), &save_args());
        assert_eq!(code, 7, "{v}");
        assert_eq!(v["error"]["code"], "outcome_unknown");
        assert_eq!(v["error"]["outcome"], "unknown");
        assert_eq!(t.join().unwrap().len(), requests);
        // The issued identity is kept: the choice may be stored under it.
        assert_eq!(private(d.path())[0]["token"], TOKEN);
    }
    // A receipt that does not describe this save is not read back as success.
    let d = tempfile::tempdir().unwrap();
    let mut responses = preflight();
    responses.push(ok(count));
    let t = server(d.path(), responses);
    let (code, v) = call(d.path(), &save_args());
    assert_eq!((code, &v["error"]["outcome"]), (7, &json!("unknown")));
    assert_eq!(t.join().unwrap().len(), 4);
    assert_eq!(private(d.path())[0]["token"], TOKEN);
}

#[test]
fn a_credential_save_failure_after_the_write_is_uncertain_and_not_retried() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("credentials");
    let mut responses = preflight();
    responses.push(ok(saved("run-1")));
    let t = server_then(
        d.path(),
        responses,
        Some(Box::new(move || {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        })),
    );
    let (code, v) = call(d.path(), &save_args());
    assert_eq!(code, 7);
    assert_eq!(v["error"]["code"], "participant_credentials_not_saved");
    assert_eq!(v["error"]["outcome"], "unknown");
    assert_eq!(t.join().unwrap().len(), 4);
}

#[test]
fn terminal_receipts_name_the_run_and_never_print_tokens_or_controls() {
    let d = tempfile::tempdir().unwrap();
    let mut responses = preflight();
    responses.extend([ok(saved("run-1")), ok(readback("run-1"))]);
    let t = server(d.path(), responses);
    let (code, out) = human(d.path(), &save_args());
    assert_eq!(code, 0);
    assert_eq!(out, "Saved 2 topic priorities from analysis run run-1.\n");
    t.join().unwrap();

    // The site may attribute the choice to another run; say so plainly.
    let mut responses = preflight();
    responses.extend([ok(saved("run-2")), ok(readback("run-2"))]);
    let t = server(d.path(), responses);
    let (code, out) = human(d.path(), &save_args());
    assert_eq!(code, 0);
    assert!(out.contains("The site recorded analysis run run-2 for this choice, not run-1"));
    assert!(out.contains("polis topic list --job run-2"));
    t.join().unwrap();

    let mut shown = readback("run-1");
    shown["data"]["archetypal_selections"][0]["topic_key"] = json!("run-1#1#2\u{1b}[31m\u{202e}");
    let t = server(d.path(), vec![ok(shown), ok(none())]);
    let (code, out) = human(d.path(), &["topic", "prioritize", C, "--show"]);
    assert_eq!(code, 0);
    assert!(out.starts_with(
        "2 topic priorities saved (analysis run run-1, updated 2026-10-18T00:00:01.000Z):\n"
    ));
    assert!(out.contains("  run-1#1#2[31m\n  run-1#0#7\n"));
    assert!(!out.contains('\u{1b}') && !out.contains('\u{202e}'));
    let (_, out) = human(d.path(), &["topic", "prioritize", C, "--show"]);
    assert_eq!(
        out,
        "No topic priorities are saved for you in this conversation.\n"
    );
    t.join().unwrap();
}

#[test]
fn discovery_names_the_topic_list_source_in_plain_terms() {
    let d = tempfile::tempdir().unwrap();
    let (code, v) = call(d.path(), &["schema", "topic", "prioritize"]);
    assert_eq!(code, 0);
    assert_eq!(v["data"]["implemented"], true);
    let (code, v) = call(d.path(), &["help", "topic", "prioritize"]);
    assert_eq!(code, 0);
    let help = v["data"]["help"].as_str().unwrap();
    assert!(help.contains("polis topic list"));
    for internal in ["Delphi", "archetyp", "topicAgenda", "selections"] {
        assert!(!help.contains(internal), "{internal}");
    }
}
