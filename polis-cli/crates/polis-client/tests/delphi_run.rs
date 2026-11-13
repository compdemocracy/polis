//! `Client::delphi_run`: one Delphi job's run record, read from the site and
//! decoded into the contract's own type, against a fixture HTTP server. The
//! 200 bodies are the recorded bytes of the route for real local sequences
//! (a full pipeline run, a collective-statement save, a second full run;
//! and, from a later recording, a second save after the second run).
use polis_client::Client;
use polis_contracts::delphi_provenance::WrittenBy;
use polis_contracts::delphi_run::{JobId, ResultFamily, RunFamily};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};

const SECOND: &str = "404137c3-e1e5-4d7a-a13e-2c41ff2fcece";

fn recorded(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../queue-rs/polis-api/conformance/delphi-run-fixtures")
        .join(format!("{name}.json"));
    // The recording ends with a newline; the route's body does not.
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .trim_end()
        .to_owned()
}

/// Answers one request and returns what the client sent (head only).
fn site(
    status: u16,
    content_type: &str,
    body: String,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let content_type = content_type.to_owned();
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buf = [0; 8192];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut buf).unwrap();
            assert!(n > 0, "the request ended before its head did");
            request.extend_from_slice(&buf[..n]);
        }
        write!(
            socket,
            "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        String::from_utf8(request).unwrap()
    });
    (base, thread)
}

fn client(base: &str) -> Client {
    Client::new(base, Some("fixture-token".into()), 5).unwrap()
}

#[test]
fn a_job_id_leads_to_the_typed_record_of_that_job() {
    // What a reader asks with: a job id, here the second run's. (A topic
    // key carries a clustering label, which is not looked up as a job.)
    let job = JobId::new(SECOND).unwrap();
    let body = recorded("second");
    let (base, thread) = site(200, "application/json; charset=utf-8", body.clone());
    let run = client(&base).delphi_run(&job).unwrap().unwrap();
    let request = thread.join().unwrap();
    // One GET of the run record route, by job id, with the caller's token.
    assert!(
        request.starts_with(&format!(
            "GET /api/v3/delphi/run?job_id={SECOND} HTTP/1.1\r\n"
        )),
        "{request}"
    );
    assert!(request
        .to_ascii_lowercase()
        .contains("\r\nauthorization: bearer fixture-token\r\n"));
    // The record is the contract's type, and writes back the bytes it was read from.
    assert_eq!(run.job_id, job);
    assert_eq!(
        run.run_id.as_ref().map(|r| r.as_str()),
        Some("72ff7574-cb32-46f3-942a-eb512664ad49")
    );
    assert!(polis_contracts::wire::to_json(&run).unwrap() == body);
    // The run produced the topic names it published, and the record says
    // so with typed ids.
    let names = ResultFamily::Run(RunFamily::CommentClustersLlmTopicNames);
    let Some(WrittenBy::Producer(named_by)) = run.written_by(names) else {
        panic!("{:?}", run.written_by(names))
    };
    assert_eq!(named_by.job_id, job);
    assert_eq!(named_by.run_id, run.run_id);
    // The collective statements beside them name only their last writer.
    let statements = ResultFamily::Run(RunFamily::CollectiveStatement);
    assert!(matches!(
        run.written_by(statements),
        Some(WrittenBy::LastWriter(_))
    ));
    // And which family beside them came from another run's topics.
    let mixed = run.inputs_from_other_runs();
    assert_eq!(mixed.len(), 1);
    assert_eq!(
        mixed[0].family,
        ResultFamily::Run(RunFamily::CollectiveStatement)
    );
    assert_eq!(
        mixed[0].computed_from.job_id.as_str(),
        "46c7aff4-daa2-4b63-ae05-2473d103f2e6"
    );
}

#[test]
fn every_recorded_run_record_decodes_to_the_bytes_the_site_sent() {
    for name in ["first", "statement", "second", "statement-after-second"] {
        let body = recorded(name);
        let id: serde_json::Value = serde_json::from_str(&body).unwrap();
        let job = JobId::new(id["job_id"].as_str().unwrap()).unwrap();
        let (base, thread) = site(200, "application/json", body.clone());
        let run = client(&base).delphi_run(&job).unwrap().unwrap();
        thread.join().unwrap();
        assert!(
            polis_contracts::wire::to_json(&run).unwrap() == body,
            "{name}"
        );
    }
}

/// The contract's own golden run records: every state a job can be in,
/// among them a job that died at a stage, cancelled jobs, a parked narrative
/// job and a legacy import with no run id. A record whose job failed is
/// still a 200 with a record in it: the client reads it, and does not take
/// the job's failure for a failed request.
#[test]
fn a_record_of_a_job_in_any_state_is_read_as_a_record() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../queue-rs/polis-contracts/tests/fixtures/delphi-run");
    let mut states = std::collections::BTreeSet::new();
    let mut without_run_id = 0;
    let mut with_failure = 0;
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    for path in &paths {
        let body = std::fs::read_to_string(path).unwrap().trim_end().to_owned();
        let sent: serde_json::Value = serde_json::from_str(&body).unwrap();
        let job = JobId::new(sent["job_id"].as_str().unwrap()).unwrap();
        let (base, thread) = site(200, "application/json; charset=utf-8", body);
        let run = client(&base)
            .delphi_run(&job)
            .unwrap_or_else(|e| panic!("{}: {}", path.display(), e.code))
            .unwrap_or_else(|| panic!("{}: no record", path.display()));
        thread.join().unwrap();
        assert_eq!(run.job_id, job, "{}", path.display());
        // What was read is what was sent, field for field.
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            sent,
            "{}",
            path.display()
        );
        states.insert(sent["state"].as_str().unwrap().to_owned());
        without_run_id += usize::from(run.run_id.is_none());
        with_failure += usize::from(run.failure.is_some());
    }
    assert_eq!(paths.len(), 11, "the contract's golden run records");
    for state in [
        "cancelled",
        "dead",
        "parked",
        "retry_wait",
        "running",
        "succeeded",
    ] {
        assert!(states.contains(state), "no golden record is {state}");
    }
    assert!(without_run_id >= 1, "the legacy import has no run id");
    assert!(with_failure >= 1, "the dead job carries its failure");
}

#[test]
fn a_site_with_no_record_for_the_job_answers_none() {
    let job = JobId::new(SECOND).unwrap();
    for (content_type, body) in [
        // The route's own refusal: no such job.
        (
            "application/json; charset=utf-8",
            r#"{"status":"error","message":"Job not found"}"#,
        ),
        // A site that does not serve run records: its own 404 page.
        (
            "text/html; charset=utf-8",
            "<pre>Cannot GET /api/v3/delphi/run</pre>",
        ),
    ] {
        let (base, thread) = site(404, content_type, body.into());
        assert_eq!(client(&base).delphi_run(&job).unwrap(), None, "{body}");
        thread.join().unwrap();
    }
}

#[test]
fn a_refusal_or_a_record_the_contract_refuses_is_an_error_never_a_guess() {
    let job = JobId::new(SECOND).unwrap();
    let answer = |status: u16, content_type: &str, body: String| {
        let (base, thread) = site(status, content_type, body);
        let result = client(&base).delphi_run(&job);
        thread.join().unwrap();
        result.unwrap_err()
    };
    // Not signed in, and not a moderator of the job's conversation.
    let e = answer(
        401,
        "application/json",
        r#"{"error":"No authentication token found"}"#.into(),
    );
    assert_eq!((e.code, e.exit), ("auth_invalid", 3));
    let e = answer(
        403,
        "application/json",
        r#"{"status":"error","message":"polis_err_delphi_run_auth"}"#.into(),
    );
    assert_eq!((e.code, e.exit), ("forbidden", 4));
    // A 200 that is not the asked job's run record under this contract. Two
    // are the asked job's own record with one thing wrong, so the contract's
    // decoding is what refuses them.
    let asked: serde_json::Value = serde_json::from_str(&recorded("second")).unwrap();
    let mut unknown_field = asked.clone();
    unknown_field["invented"] = serde_json::json!(true);
    let mut no_run_id = asked.clone();
    no_run_id["run_id"] = serde_json::Value::Null;
    let another_job = recorded("first");
    for (case, content_type, body) in [
        ("an empty object", "application/json", "{}".to_owned()),
        ("not JSON", "application/json", "not json".to_owned()),
        ("a record served as HTML", "text/html", recorded("second")),
        (
            "an unknown field",
            "application/json",
            unknown_field.to_string(),
        ),
        // A queued job always has a run id: the contract's own rule.
        (
            "a queued job without a run id",
            "application/json",
            no_run_id.to_string(),
        ),
        // A whole, valid record, of a job that was not asked for.
        ("another job's record", "application/json", another_job),
    ] {
        let e = answer(200, content_type, body);
        assert_eq!(
            (e.code, e.exit, e.outcome),
            ("invalid_response", 1, "rejected"),
            "{case}"
        );
    }
}
