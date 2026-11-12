//! The tool's tests. No AWS: fixture lines are written in each producer's
//! format (nginx's two log formats, Node's winston JSON, the shadow's
//! observation line), the compiled queries run over them through `eval.rs`,
//! and a stand-in for the AWS CLI serves those results to `run`.
use crate::aws::{self, Aws, Reply, Row, Window};
use crate::eval::{self, Line};
use crate::query::{self, Agg, Bounds, E, Key, Query, Stats};
use crate::report::{self, Mark, Verdict};
use crate::route::{self, COMMENTS, Route, VOTES};
use crate::{Command, RunArgs, parse_args, time};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;

pub(crate) const FROM: &str = "2026-11-09T00:00:00Z";
pub(crate) const TO: &str = "2026-11-10T00:00:00Z";

/// The present, for a run over the fixture window: a day after its end.
pub(crate) fn now() -> i64 {
    window().to_s + 86_400
}

pub(crate) fn window() -> Window {
    Window {
        from_s: time::parse(FROM).unwrap(),
        to_s: time::parse(TO).unwrap(),
    }
}

pub(crate) fn id(n: u64) -> String {
    format!("{n:032x}")
}

// ---------------------------------------------------------------- producers

/// nginx's `polis_shadow_edge` format (file-server/nginx/rust-api/shadow-http.conf.template).
pub(crate) fn edge(id: &str, at: i64, status: u16, node_s: &str) -> (i64, String) {
    (
        at,
        json!({
            "message": "shadow_edge", "listener": "shadow", "service": "nginx-proxy",
            "route": "POST /api/v3/votes", "request_id": id, "edge_status": status,
            "edge_upstream_status": status.to_string(), "edge_upstream_s": node_s,
            "edge_request_s": 0.013, "time": "2026-11-09T10:00:00+00:00"
        })
        .to_string(),
    )
}

/// nginx's `polis_shadow_mirror` format. `upstream` is empty when the copy was
/// not sent (outside the body bound) or the shadow's host was absent.
fn mirror(id: &str, at: i64, status: u16, upstream: &str, seconds: f64) -> (i64, String) {
    (
        at,
        json!({
            "message": "shadow_mirror", "listener": "shadow", "service": "nginx-proxy",
            "shadow": "votesShadow", "request_id": id, "mirror_status": status,
            "mirror_upstream_status": upstream, "mirror_s": seconds,
            "time": "2026-11-09T10:00:00+00:00"
        })
        .to_string(),
    )
}

#[derive(Clone, Copy)]
pub(crate) enum Next {
    Statement { remaining: i64, total: i64 },
    Topical,
    None,
}

/// Node's `vote_reply` as winston writes it (server/src/routes/votes.ts):
/// level, message, the line's fields, service, timestamp. The line names no
/// statement: whether Node served one, and the two counts.
pub(crate) fn reply(id: &str, at: i64, zid: i64, status: u16, next: Option<Next>) -> (i64, String) {
    let mut line = json!({
        "level": if status >= 500 { "error" } else if status >= 400 { "warn" } else { "info" },
        "message": "vote_reply", "listener": "shadow", "route": "POST /api/v3/votes",
        "request_id": id, "zid": zid, "node_status": status,
        "service": "server", "timestamp": "2026-11-09T10:00:00.012Z"
    });
    let o = line.as_object_mut().unwrap();
    match next {
        Some(Next::Statement { remaining, total }) => {
            o.insert("node_next".into(), json!("statement"));
            o.insert("node_remaining".into(), json!(remaining));
            o.insert("node_total".into(), json!(total));
        }
        Some(Next::Topical) => {
            o.insert("node_next".into(), json!("topical"));
        }
        Some(Next::None) => {
            o.insert("node_next".into(), json!("none"));
        }
        None => {}
    }
    (at, line.to_string())
}

/// Node's `http_request` access line with the request id
/// (server/src/server-middleware.ts), as winston 3 writes it: the meta's
/// `message` is appended to the message argument, so `message` is
/// "http_request http_request" (the bytes the real logger writes; pinned on
/// the Node side by server/__tests__/unit/shadowLineBytes.test.ts).
fn access(id: &str, at: i64, status: u16) -> (i64, String) {
    access_taking(Some(id), at, status, 12.5)
}

fn access_taking(id: Option<&str>, at: i64, status: u16, ms: f64) -> (i64, String) {
    let mut line = json!({
        "level": if status >= 500 { "error" } else if status >= 400 { "warn" } else { "info" },
        "message": "http_request http_request",
        "service": "server", "env": "prod",
        "http": {"method": "POST", "url": "/api/v3/votes", "route": "/api/v3/votes", "status_code": status},
        "network": {"client": {"ip": "203.0.113.5"}}, "useragent": "fixture",
        "duration_ms": ms, "timestamp": "2026-11-09T10:00:00.012Z"
    });
    if let Some(id) = id {
        line.as_object_mut()
            .unwrap()
            .insert("request_id".into(), json!(id));
    }
    (at, line.to_string())
}

pub(crate) const WEEK_S: i64 = 7 * 86_400;

/// The shadow's `shadow_observation` keys, in its order (polis-api
/// `shadow.rs`, `Line::print`).
const OBSERVATION_KEYS: [&str; 27] = [
    "message",
    "listener",
    "service",
    "env",
    "shadow",
    "route",
    "request_id",
    "outcome",
    "admitted",
    "status",
    "reason",
    "queue_ms",
    "admission_ms",
    "selection_ms",
    "total_ms",
    "readback_s",
    "zid",
    "starred_present",
    "lang_present",
    "append",
    "follow_on",
    "remaining",
    "total",
    "candidates",
    "weights_tick",
    "prev",
    "node_vote",
];

#[derive(Clone)]
struct Obs {
    outcome: &'static str,
    admitted: bool,
    status: Option<u16>,
    reason: Option<&'static str>,
    zid: Option<i64>,
    follow_on: Option<&'static str>,
    /// The next statement's two counts (remaining, total), when one was
    /// selected. The line never names the statement.
    next: Option<(i64, i64)>,
    prev: Option<&'static str>,
    node_vote: &'static str,
    admission_ms: f64,
    total_ms: f64,
}

impl Obs {
    fn serve(zid: i64, next: Option<(i64, i64)>) -> Self {
        Obs {
            outcome: "would_serve",
            admitted: true,
            status: Some(200),
            reason: None,
            zid: Some(zid),
            follow_on: Some(if next.is_some() { "complete" } else { "absent" }),
            next,
            prev: Some("hit"),
            node_vote: "same",
            admission_ms: 4.0,
            total_ms: 20.0,
        }
    }
    fn hand_back(reason: &'static str) -> Self {
        Obs {
            outcome: "would_hand_back",
            admitted: false,
            status: Some(502),
            reason: Some(reason),
            zid: None,
            follow_on: None,
            next: None,
            prev: None,
            node_vote: "not_checked",
            admission_ms: 1.0,
            total_ms: 2.0,
        }
    }
}

fn observation(id: &str, at: i64, o: &Obs) -> (i64, String) {
    let opt = |v: Option<i64>| v.map_or(Value::Null, |v| json!(v));
    let next = o.next;
    let values = BTreeMap::from([
        ("message", json!("shadow_observation")),
        ("listener", json!("shadow")),
        ("service", json!("polis-api-shadow")),
        ("env", json!("prod")),
        ("shadow", json!("votesShadow")),
        ("route", json!("POST /api/v3/votes")),
        ("request_id", json!(id)),
        ("outcome", json!(o.outcome)),
        ("admitted", json!(if o.admitted { 1 } else { 0 })),
        ("status", o.status.map_or(Value::Null, |s| json!(s))),
        ("reason", o.reason.map_or(Value::Null, |r| json!(r))),
        ("queue_ms", json!(0.4)),
        ("admission_ms", json!(o.admission_ms)),
        ("selection_ms", json!(6.0)),
        ("total_ms", json!(o.total_ms)),
        ("readback_s", json!(2.0)),
        ("zid", opt(o.zid)),
        ("starred_present", json!(false)),
        ("lang_present", json!(true)),
        ("append", json!("not_modelled")),
        ("follow_on", o.follow_on.map_or(Value::Null, |f| json!(f))),
        ("remaining", opt(next.map(|n| n.0))),
        ("total", opt(next.map(|n| n.1))),
        ("candidates", json!(4)),
        ("weights_tick", json!(42)),
        ("prev", o.prev.map_or(Value::Null, |p| json!(p))),
        ("node_vote", json!(o.node_vote)),
    ]);
    assert_eq!(values.len(), OBSERVATION_KEYS.len());
    let mut line = serde_json::Map::new();
    for key in OBSERVATION_KEYS {
        line.insert(key.into(), values[key].clone());
    }
    (at, Value::Object(line).to_string())
}

// ---------------------------------------------------------------- scenarios

#[derive(Clone, Copy)]
pub(crate) enum Case {
    /// Both serve a statement; the counts agree.
    Agree,
    /// Both find nothing left.
    Exhausted,
    /// Node's pick was topical.
    Topical,
    /// The shadow's `remaining` is one off.
    RemainingOff,
    /// Node stored the vote, then answered 500.
    Node500AfterStore,
    /// The shadow would say closed; Node stored the vote and answered 200.
    ClosedDisagree,
    /// The readback found the other choice.
    Different,
    /// Handed back before admission.
    HandBack(&'static str),
    /// Node's middleware refused it (no handler reply), the shadow too.
    MiddlewareRefusal,
    /// Outside the copy's body bound.
    NotCopied,
    /// The shadow's rate cap.
    Shed,
    /// A CORS refusal in the prelude.
    Cors,
    /// Copied, the copy timed out, and no observation.
    Uncovered,
    /// The participant closed the connection (nginx 499); Node's handler
    /// finished and stored the vote; the shadow would serve it.
    ClientGone,
    /// nginx answered 502 with no reply from Node's handler.
    NginxOnly5xx,
    /// The shadow is down: nginx answered the copy 502 itself.
    HostAbsent,
    /// Served, with a readback that never ran.
    NotReadBack,
}

pub(crate) struct Fixture {
    pub(crate) lines: Vec<(i64, String)>,
    pub(crate) next: u64,
    pub(crate) at: i64,
}

impl Fixture {
    pub(crate) fn new() -> Self {
        Fixture {
            lines: vec![],
            next: 1,
            at: window().from_s * 1000 + 60_000,
        }
    }

    /// One vote of a case. Neither Node's line nor the shadow's names a
    /// statement.
    pub(crate) fn vote(&mut self, zid: i64, case: Case) -> String {
        let n = self.next;
        self.next += 1;
        self.at += 7_000;
        let t = self.at;
        let id = id(n);
        let statement = || Next::Statement {
            remaining: 12,
            total: 20,
        };
        let lines = &mut self.lines;
        let mut push = |line: (i64, String)| lines.push(line);
        match case {
            Case::Agree | Case::RemainingOff | Case::Topical | Case::Different => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                let node_next = match case {
                    Case::Topical => Next::Topical,
                    _ => statement(),
                };
                push(reply(&id, t, zid, 200, Some(node_next)));
                push(access(&id, t, 200));
                let remaining = if matches!(case, Case::RemainingOff) {
                    13
                } else {
                    12
                };
                let mut o = Obs::serve(zid, Some((remaining, 20)));
                if matches!(case, Case::Different) {
                    o.node_vote = "different";
                }
                push(observation(&id, t + 2_500, &o));
            }
            Case::Exhausted => {
                push(edge(&id, t, 200, "0.010"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(Next::None)));
                push(access(&id, t, 200));
                push(observation(&id, t + 2_500, &Obs::serve(zid, None)));
            }
            Case::Node500AfterStore => {
                push(edge(&id, t, 500, "0.030"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 500, None));
                push(access(&id, t, 500));
                push(observation(
                    &id,
                    t + 2_500,
                    &Obs::serve(zid, Some((12, 20))),
                ));
            }
            Case::ClosedDisagree => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
                let mut o = Obs::serve(zid, None);
                o.status = Some(403);
                o.reason = Some("closed");
                o.follow_on = None;
                o.prev = None;
                push(observation(&id, t + 2_500, &o));
            }
            Case::HandBack(reason) => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
                push(observation(&id, t + 1_000, &Obs::hand_back(reason)));
            }
            Case::MiddlewareRefusal => {
                push(edge(&id, t, 403, "0.004"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(access(&id, t, 403));
                push(observation(&id, t + 1_000, &Obs::hand_back("no_token")));
            }
            Case::NotCopied => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "", 0.0));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
            }
            Case::Shed => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
                let mut o = Obs::hand_back("rate_cap");
                o.outcome = "shed";
                o.status = None;
                push(observation(&id, t, &o));
            }
            Case::Cors => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
                let mut o = Obs::hand_back("cors");
                o.outcome = "would_fail";
                o.status = Some(500);
                push(observation(&id, t + 1_000, &o));
            }
            Case::ClientGone => {
                push(edge(&id, t, 499, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(observation(
                    &id,
                    t + 2_500,
                    &Obs::serve(zid, Some((12, 20))),
                ));
            }
            Case::NginxOnly5xx => {
                push(edge(&id, t, 502, "0.001"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(observation(
                    &id,
                    t + 2_500,
                    &Obs::serve(zid, Some((12, 20))),
                ));
            }
            Case::HostAbsent => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 502, "", 0.0));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
            }
            Case::NotReadBack => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 204, "204", 0.001));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
                let mut o = Obs::serve(zid, Some((12, 20)));
                o.node_vote = "not_checked";
                push(observation(&id, t + 2_500, &o));
            }
            Case::Uncovered => {
                push(edge(&id, t, 200, "0.012"));
                push(mirror(&id, t, 504, "504", 0.030));
                push(reply(&id, t, zid, 200, Some(statement())));
                push(access(&id, t, 200));
            }
        }
        id
    }

    pub(crate) fn eval_lines(&self) -> Vec<Line> {
        self.lines
            .iter()
            .map(|(at, json)| eval::line(*at, json))
            .collect()
    }
}

/// The stop rule's metrics for a quiet week: CPU 20 %, p99 0.2 s both weeks,
/// target 5xx 3 a day against 5.
pub(crate) fn quiet_metrics(w: Window) -> BTreeMap<String, Vec<(i64, f64)>> {
    let mut m = BTreeMap::new();
    let points = |from: i64, to: i64, step: i64, v: f64| {
        (from..to)
            .step_by(step as usize)
            .map(|t| (t, v))
            .collect::<Vec<_>>()
    };
    let week = 7 * 86_400;
    m.insert("db_cpu".into(), points(w.from_s, w.to_s, 300, 20.0));
    m.insert("lb_p99".into(), points(w.from_s, w.to_s, 3600, 0.2));
    m.insert(
        "lb_p99_previous".into(),
        points(w.from_s - week, w.to_s - week, 3600, 0.2),
    );
    m.insert("target_5xx".into(), points(w.from_s, w.to_s, 86_400, 3.0));
    m.insert(
        "target_5xx_previous".into(),
        points(w.from_s - week, w.to_s - week, 86_400, 5.0),
    );
    m
}

// ---------------------------------------------------------------- the AWS stand-in

/// Serves `start-query` by running the compiled query whose text it was sent
/// over the fixture lines, and `get-metric-statistics` from fixture series.
pub(crate) struct FakeAws {
    pub(crate) lines: Vec<Line>,
    pub(crate) metrics: BTreeMap<String, Vec<(i64, f64)>>,
    pub(crate) window: Window,
    pub(crate) route: Route,
    pub(crate) refuse_two_stage: bool,
    /// Lines that arrive after this many queries have been issued, as lines
    /// still in delivery do.
    pub(crate) late: Vec<(usize, Line)>,
    /// A result made this many rows long, by query name (its first row
    /// repeated, or rows dropped).
    pub(crate) resize: Option<(&'static str, usize)>,
    /// An account that keeps at most this many rows of a first stage.
    pub(crate) first_stage_cap: Option<usize>,
    pub(crate) results: RefCell<Vec<Vec<Row>>>,
    pub(crate) issued: RefCell<Vec<String>>,
    /// Each query issued: its name and the window it was issued for.
    pub(crate) asked: RefCell<Vec<(&'static str, i64, i64)>>,
}

impl FakeAws {
    /// A further line in the window (Node's access lines for the vote rules).
    pub(crate) fn push(&mut self, (at, json): (i64, String)) {
        self.lines.push(eval::line(at, &json));
    }

    pub(crate) fn new(fixture: &Fixture) -> Self {
        // The stop rule's baseline: Node's access lines the same week, a
        // week earlier, so the vote rules compare like with like.
        let mut lines = fixture.eval_lines();
        for (at, json) in &fixture.lines {
            if json.contains(r#""message":"http_request http_request""#) {
                lines.push(eval::line(at - WEEK_S * 1000, json));
            }
        }
        FakeAws {
            lines,
            metrics: quiet_metrics(window()),
            window: window(),
            route: VOTES,
            refuse_two_stage: false,
            late: vec![],
            resize: None,
            first_stage_cap: None,
            results: RefCell::new(vec![]),
            issued: RefCell::new(vec![]),
            asked: RefCell::new(vec![]),
        }
    }
}

fn arg<'a>(args: &'a [String], name: &str) -> &'a str {
    let at = args.iter().position(|a| a == name).unwrap();
    &args[at + 1]
}

impl Aws for FakeAws {
    fn call(&self, args: &[String]) -> anyhow::Result<Reply> {
        let ok = |stdout: String| {
            Ok(Reply {
                ok: true,
                stdout,
                stderr: String::new(),
            })
        };
        match (args[0].as_str(), args[1].as_str()) {
            ("logs", "start-query") => {
                let text = arg(args, "--query-string");
                let issued_before = self.issued.borrow().len();
                self.issued.borrow_mut().push(text.to_owned());
                let queries = self.route.queries();
                let start: i64 = arg(args, "--start-time").parse().unwrap();
                let end: i64 = arg(args, "--end-time").parse().unwrap();
                let q = queries
                    .iter()
                    .find(|q| {
                        let w = Window {
                            from_s: start + q.pad_s,
                            to_s: end - q.pad_s,
                        };
                        q.text(w.bounds()) == text
                    })
                    .expect("only compiled queries are issued");
                let (from_s, to_s) = (start + q.pad_s, end - q.pad_s);
                self.asked.borrow_mut().push((q.name, from_s, to_s));
                if q.sliced || q.chunk_s > 0 {
                    // A slice of the window, or a piece of it.
                    assert!(
                        from_s >= self.window.from_s && to_s <= self.window.to_s && from_s < to_s,
                        "{}",
                        q.name
                    );
                } else {
                    // The window, or for the stop rule's baseline the same
                    // window a week earlier.
                    // The window (the stop rule's span of it, for a query
                    // read over that), or the same a week earlier.
                    let span = if q.recent {
                        route::stop_span(self.window)
                    } else {
                        self.window
                    };
                    assert!(
                        from_s == span.from_s
                            || (q.previous_week && from_s == span.from_s - WEEK_S),
                        "{}",
                        q.name
                    );
                    assert_eq!(to_s - from_s, span.to_s - span.from_s);
                }
                if self.refuse_two_stage && q.two_stage() {
                    return Ok(Reply {
                        ok: false,
                        stdout: String::new(),
                        stderr: "An error occurred (MalformedQueryException) when calling the StartQuery operation: unexpected symbol found stats".into(),
                    });
                }
                let mut lines = std::borrow::Cow::Borrowed(&self.lines);
                for (after, line) in &self.late {
                    if issued_before >= *after {
                        lines.to_mut().push(line.clone());
                    }
                }
                let mut rows = eval::run_capped(q, &lines, from_s, to_s, self.first_stage_cap);
                if let Some((name, length)) = self.resize
                    && name == q.name
                    && let Some(first) = rows.first().cloned()
                {
                    rows.resize(length, first);
                }
                let mut results = self.results.borrow_mut();
                results.push(rows);
                ok(json!({ "queryId": format!("q{}", results.len() - 1) }).to_string())
            }
            ("logs", "get-query-results") => {
                let n: usize = arg(args, "--query-id")[1..].parse().unwrap();
                let rows = &self.results.borrow()[n];
                let results: Vec<Value> = rows
                    .iter()
                    .map(|row| {
                        Value::Array(
                            row.iter()
                                .map(|(k, v)| json!({"field": k, "value": v}))
                                .chain([json!({"field": "@ptr", "value": "x"})])
                                .collect(),
                        )
                    })
                    .collect();
                ok(json!({"status": "Complete", "results": results, "statistics": {"bytesScanned": 1000.0}}).to_string())
            }
            ("cloudwatch", "get-metric-statistics") => {
                let start = time::parse(arg(args, "--start-time")).unwrap();
                let end = time::parse(arg(args, "--end-time")).unwrap();
                let metric = arg(args, "--metric-name");
                // The stop rule's metrics are asked for its own span of the
                // window, and for the same span a week earlier.
                let previous = start < route::stop_span(self.window).from_s;
                let name = match (metric, previous) {
                    ("CPUUtilization", _) => "db_cpu",
                    ("TargetResponseTime", false) => "lb_p99",
                    ("TargetResponseTime", true) => "lb_p99_previous",
                    ("HTTPCode_Target_5XX_Count", false) => "target_5xx",
                    _ => "target_5xx_previous",
                };
                let key = if metric == "TargetResponseTime" {
                    "ExtendedStatistics"
                } else if metric == "CPUUtilization" {
                    "Average"
                } else {
                    "Sum"
                };
                let points: Vec<Value> = self.metrics[name]
                    .iter()
                    .filter(|(t, _)| *t >= start && *t < end)
                    .map(|(t, v)| {
                        let value = if key == "ExtendedStatistics" {
                            json!({"p99": v})
                        } else {
                            json!(v)
                        };
                        json!({"Timestamp": time::format(*t).replace('Z', "+00:00"), key: value})
                    })
                    .collect();
                ok(json!({"Label": metric, "Datapoints": points}).to_string())
            }
            other => panic!("unexpected aws call {other:?}"),
        }
    }
    fn pause(&self, _: std::time::Duration) {}
}

pub(crate) fn run_args() -> RunArgs {
    RunArgs {
        route: "votes",
        window: (window().from_s, window().to_s),
        log_group: "fixture-log-group".into(),
        db_instance: "fixture-db".into(),
        load_balancer: "app/fixture/1".into(),
        aws: "aws".into(),
        timeout_s: 60,
    }
}

pub(crate) fn run(aws: &FakeAws) -> report::Report {
    let args = RunArgs {
        route: aws.route.key,
        ..run_args()
    };
    crate::run(aws, &args, now(), &mut std::io::sink()).unwrap()
}

/// Enough evidence for the week: 60 conversations, 6,000 agreeing votes, plus
/// a few of each explained case.
pub(crate) fn passing_fixture() -> Fixture {
    let mut fx = Fixture::new();
    for c in 0..60 {
        let zid = 73_001 + c;
        let votes = if c < 10 { 300 } else { 60 };
        for _ in 0..votes {
            fx.vote(zid, Case::Agree);
        }
    }
    for case in [
        Case::Exhausted,
        Case::Topical,
        Case::Node500AfterStore,
        Case::HandBack("no_token"),
        Case::HandBack("not_a_participant"),
        Case::MiddlewareRefusal,
        Case::NotCopied,
        Case::Shed,
        Case::Cors,
    ] {
        fx.vote(73_001, case);
    }
    fx
}

// ---------------------------------------------------------------- tests

#[test]
fn every_compiled_query_passes_the_allowlist() {
    for (r, count) in [(VOTES, 10), (COMMENTS, 12)] {
        let queries = r.queries();
        assert_eq!(queries.len(), count);
        let mut names: Vec<&str> = queries.iter().map(|q| q.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "{}: a query name is used twice", r.key);
        for q in &queries {
            assert_eq!(query::refusal(q), None, "{}", q.name);
            // No compiled query reads a statement number, from any line.
            let text = q.text(Bounds::Placeholders);
            for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
                assert!(
                    word != "tid" && !word.ends_with("_tid"),
                    "{}: reads {word}",
                    q.name
                );
            }
            // No literal can break out of its quotes.
            let mut literals = query::literals(&q.filter);
            for stage in &q.stages {
                for (_, agg) in &stage.aggs {
                    if let Agg::Sum(e) = agg {
                        literals.extend(query::literals(e));
                    }
                }
            }
            for literal in literals {
                assert!(!literal.contains(['"', '\\', '\n']), "{literal}");
            }
        }
    }
}

#[test]
fn the_allowlist_refuses_what_would_leave_aws() {
    let base = |stages: Vec<Stats>| Query {
        name: "bad",
        about: "",
        filter: query::is("message", "shadow_observation"),
        fields: vec![],
        stages,
        pad_s: 0,
        previous_week: false,
        recent: false,
        chunk_s: 0,
        sliced: false,
    };
    let count_by = |keys: Vec<Key>| Stats {
        aggs: vec![("n", Agg::Count)],
        by: keys,
    };
    let refused = [
        // Grouping by a request, a participant, a vote or an address.
        base(vec![count_by(vec![Key::Field("request_id")])]),
        base(vec![count_by(vec![Key::Field("pid")])]),
        base(vec![count_by(vec![Key::Field("vote")])]),
        base(vec![count_by(vec![Key::Field("network.client.ip")])]),
        // A maximum of a conversation number returns one conversation's.
        base(vec![Stats {
            aggs: vec![("z", Agg::Max("zid"))],
            by: vec![],
        }]),
        // A first stage grouped by anything but the request id.
        base(vec![count_by(vec![Key::Field("zid")]), count_by(vec![])]),
        // A final key that is a first-stage maximum of a participant.
        base(vec![
            Stats {
                aggs: vec![("p", Agg::Max("pid"))],
                by: vec![Key::Field("request_id")],
            },
            count_by(vec![Key::Field("p")]),
        ]),
        // A final count conditioned on a participant.
        base(vec![
            Stats {
                aggs: vec![("p", Agg::Max("pid"))],
                by: vec![Key::Field("request_id")],
            },
            Stats {
                aggs: vec![("n", Agg::Sum(query::num_is("p", 4)))],
                by: vec![],
            },
        ]),
        base(vec![Stats {
            aggs: vec![("n", Agg::Sum(query::num_is("vote", 1)))],
            by: vec![],
        }]),
        // Three stages.
        base(vec![count_by(vec![]), count_by(vec![]), count_by(vec![])]),
        // Node's access line by its single spelling: production writes
        // "http_request http_request", so these would never match.
        Query {
            filter: query::is("message", "http_request"),
            ..base(vec![count_by(vec![])])
        },
        Query {
            filter: E::In("message", vec!["http_request"]),
            ..base(vec![count_by(vec![])])
        },
        base(vec![Stats {
            aggs: vec![("n", Agg::Sum(query::is("message", "http_request")))],
            by: vec![],
        }]),
        // A second-stage name that is also a field the first stage reads:
        // Logs Insights refuses it ("Cycle found in operation dependency
        // graph", seen on the server log group).
        base(vec![
            Stats {
                aggs: vec![("adm", Agg::Max("admitted"))],
                by: vec![Key::Field("request_id")],
            },
            Stats {
                aggs: vec![("admitted", Agg::Sum(query::num_is("adm", 1)))],
                by: vec![],
            },
        ]),
        // A computed field named like a field the filter reads.
        Query {
            fields: vec![("message", E::TimestampMs)],
            ..base(vec![count_by(vec![])])
        },
        // A total of a log field rather than of first-stage counts.
        base(vec![Stats {
            aggs: vec![("t", Agg::Total("vote"))],
            by: vec![],
        }]),
        base(vec![
            Stats {
                aggs: vec![("v", Agg::Max("vote"))],
                by: vec![Key::Field("request_id")],
            },
            Stats {
                aggs: vec![("t", Agg::Total("v"))],
                by: vec![],
            },
        ]),
    ];
    for q in refused {
        assert!(
            query::refusal(&q).is_some(),
            "{}",
            q.text(Bounds::Placeholders)
        );
    }
}

/// A statement number beside a conversation number and a time picks out one
/// row of a conversation's public votes. No query may bring one out of AWS:
/// not as a group, not as a count conditioned on one, not through a first
/// stage, whichever line it is read from.
#[test]
fn the_allowlist_refuses_a_statement_number() {
    let base = |stages: Vec<Stats>| Query {
        name: "bad",
        about: "",
        filter: query::is("listener", "shadow"),
        fields: vec![],
        stages,
        pad_s: 0,
        previous_week: false,
        recent: false,
        chunk_s: 0,
        sliced: false,
    };
    let count_by = |keys: Vec<Key>| Stats {
        aggs: vec![("n", Agg::Count)],
        by: keys,
    };
    for field in ["tid", "next_tid", "node_next_tid"] {
        let first = || Stats {
            aggs: vec![("s", Agg::Max(field))],
            by: vec![Key::Field("request_id")],
        };
        let refused = [
            base(vec![count_by(vec![Key::Field(field)])]),
            base(vec![count_by(vec![Key::Field("zid"), Key::Field(field)])]),
            base(vec![first(), count_by(vec![Key::Field("s")])]),
            base(vec![Stats {
                aggs: vec![("n", Agg::Sum(query::num_is(field, 4)))],
                by: vec![],
            }]),
            base(vec![
                first(),
                Stats {
                    aggs: vec![("n", Agg::Sum(query::num_is("s", 4)))],
                    by: vec![],
                },
            ]),
            base(vec![Stats {
                aggs: vec![("s", Agg::Max(field))],
                by: vec![],
            }]),
        ];
        for q in refused {
            assert!(
                query::refusal(&q).is_some(),
                "{field}: {}",
                q.text(Bounds::Placeholders)
            );
        }
    }
}

#[test]
fn the_votes_queries_render_as_reviewed() {
    let text = |name: &str| {
        VOTES
            .queries()
            .into_iter()
            .find(|q| q.name == name)
            .unwrap()
            .text(Bounds::Placeholders)
    };
    let observation = r#"filter listener = "shadow" and message = "shadow_observation" and shadow = "votesShadow""#;
    let mirror =
        r#"filter listener = "shadow" and message = "shadow_mirror" and shadow = "votesShadow""#;
    assert_eq!(
        text("mirror"),
        format!(
            "{mirror}\n| stats count(*) as n, pct(mirror_s, 50) as p50_s, pct(mirror_s, 99) as p99_s, max(mirror_s) as max_s by mirror_status, mirror_upstream_status\n| limit 10000"
        )
    );
    assert_eq!(
        text("mirror_hours"),
        format!(
            "{mirror}\n| stats count(*) as n, pct(mirror_s, 99) as p99_s, max(mirror_s) as max_s by bin(1h) as hour\n| limit 10000"
        )
    );
    assert_eq!(
        text("edge"),
        r#"filter listener = "shadow" and message = "shadow_edge" and route = "POST /api/v3/votes"
| stats count(*) as n, pct(edge_upstream_s, 50) as node_p50_s, pct(edge_upstream_s, 99) as node_p99_s, max(edge_upstream_s) as node_max_s, pct(edge_request_s, 99) as request_p99_s by edge_status
| limit 10000"#
    );
    assert_eq!(
        text("observations"),
        format!(
            "{observation}\n| stats count(*) as n by outcome, admitted, status, reason, follow_on, node_vote, prev\n| limit 10000"
        )
    );
    assert_eq!(
        text("conversations"),
        format!(
            "{observation} and admitted = 1\n| stats count(*) as n, count_distinct(zid) as conversations\n| limit 10000"
        )
    );
    assert!(text("latency").contains("| stats count(*) as n, pct(queue_ms, 99) as queue_p99, pct(admission_ms, 50) as admission_p50, pct(admission_ms, 99) as admission_p99"));
    let lines = text("lines");
    assert!(lines.ends_with("| stats count(*) as lines by message\n| limit 10000"));
    assert!(lines.contains(r#"(message in ["http_request", "http_request http_request"] and service = "server" and ispresent(request_id) and http.method = "POST" and http.route = "/api/v3/votes")"#));
    assert_eq!(
        text("edge_bins"),
        r#"filter listener = "shadow" and message = "shadow_edge" and route = "POST /api/v3/votes"
| fields toMillis(@timestamp) as t
| stats sum(t >= <from_ms> and t < <to_ms>) as n by bin(5m) as slot
| limit 10000"#
    );
    let join = text("join");
    let commands: Vec<&str> = join.lines().collect();
    assert_eq!(commands.len(), 5, "{join}");
    assert!(commands[0].starts_with("filter ispresent(request_id) and ("));
    assert_eq!(commands[1], "| fields toMillis(@timestamp) as t");
    assert!(commands[2].starts_with("| stats sum(message = \"shadow_edge\") as n_edge, sum(message = \"shadow_edge\" and t >= <from_ms> and t < <to_ms>) as n_edge_in"));
    assert!(commands[2].ends_with(" by request_id"));
    assert!(commands[2].contains("max(node_status) as node_st"));
    assert!(commands[2].contains(
        "sum(message = \"shadow_mirror\" and mirror_upstream_status like /[0-9]/) as n_copied"
    ));
    assert!(commands[3].starts_with("| stats count(*) as ids, sum(n_edge_in) as edge_lines, sum(n_edge = 1 and n_edge_in = 1) as votes"));
    assert!(commands[3].ends_with(" by edge_st, node_st, rust_st"));
    assert!(!commands[3].contains("request_id"));
    // Logs Insights refuses a query string over 10,000 characters.
    assert!(join.len() < 10_000, "{}", join.len());
}

/// Each route's queries name their own path, their own shadow and their own
/// lines, and nothing of the other route's.
#[test]
fn each_route_compiles_with_its_own_names_and_none_of_the_others() {
    let names = |r: Route| {
        let mut names = vec![r.path, r.shadow, r.route];
        if let route::Kind::Votes { node_line } = r.kind {
            names.push(node_line);
        }
        names
    };
    for (own, other) in [(VOTES, COMMENTS), (COMMENTS, VOTES)] {
        for q in own.queries() {
            let text = q.text(Bounds::Placeholders);
            for name in names(other) {
                assert!(!text.contains(name), "{} {}: {text}", own.key, q.name);
            }
            // Every query names the route's shadow, its nginx route or its
            // path on Node's access line: none reads lines by method alone.
            assert!(
                names(own).iter().any(|name| text.contains(name)),
                "{} {}: {text}",
                own.key,
                q.name
            );
            // Wherever Node's access line is read, the path is named.
            if text.contains("http_request") {
                assert!(
                    text.contains(&format!(r#"http.route = "{}""#, own.path)),
                    "{} {}: {text}",
                    own.key,
                    q.name
                );
            }
        }
    }
    let join = COMMENTS
        .queries()
        .into_iter()
        .find(|q| q.name == "join")
        .unwrap()
        .text(Bounds::Placeholders);
    assert!(join.contains(r#"shadow = "commentsShadow""#));
    assert!(join.contains(r#"route = "POST /api/v3/comments""#));
    // Logs Insights refuses a query string over 10,000 characters.
    assert!(join.len() < 10_000, "{}", join.len());
}

#[test]
fn no_argument_takes_query_text() {
    let parse = |s: &str| parse_args(s.split_whitespace().map(str::to_owned));
    for bad in [
        "run --query x",
        "run --query-string x",
        "queries --filter x",
        "report --results d --query x",
        "queries --log-group g",
        "report --results d --log-group g",
        "run --route votes",
        "run --route votes --from 2026-11-09T00:00:00Z --to 2026-11-10T00:00:00Z --log-group g --db-instance d",
        "run --route votes --from 2026-11-10T00:00:00Z --to 2026-11-09T00:00:00Z --log-group g --db-instance d --load-balancer l",
        "run --route votes --from 2026-11-01T00:00:00Z --to 2026-11-10T00:00:00Z --log-group g --db-instance d --load-balancer l",
        "queries --route nope",
        // Ninety-three days of comments: one more than the route's bound.
        "run --route comments --from 2026-08-01T00:00:00Z --to 2026-11-02T00:00:00Z --log-group g --db-instance d --load-balancer l",
        // The draw comparison is gone, and its flag with it.
        "queries --distributions",
        "run --route votes --from 2026-11-09T00:00:00Z --to 2026-11-10T00:00:00Z --log-group g --db-instance d --load-balancer l --distributions",
        "report --results d --distributions",
        "nonsense",
    ] {
        assert!(parse(bad).is_err(), "{bad}");
    }
    // Resource names cannot carry a query or an option.
    for value in [
        "filter x | stats",
        "--query-string",
        "a\"b",
        "fields @message",
    ] {
        let args = [
            "run",
            "--from",
            FROM,
            "--to",
            TO,
            "--log-group",
            value,
            "--db-instance",
            "d",
            "--load-balancer",
            "l",
        ];
        assert!(parse_args(args.map(str::to_owned)).is_err(), "{value}");
    }
    let ok = parse(
        "run --route votes --from 2026-11-09T00:00:00Z --to 2026-11-10T00:00:00Z --log-group server-log-group --db-instance db-1 --load-balancer app/lb/1",
    )
    .unwrap();
    assert_eq!(
        ok,
        Command::Run(RunArgs {
            log_group: "server-log-group".into(),
            db_instance: "db-1".into(),
            load_balancer: "app/lb/1".into(),
            timeout_s: 900,
            ..run_args()
        })
    );
    assert_eq!(
        parse("queries").unwrap(),
        Command::Queries { route: "votes" }
    );
    assert_eq!(
        parse("queries --route comments").unwrap(),
        Command::Queries { route: "comments" }
    );
    // A comments window may be longer than a week: its evidence is counts.
    assert!(
        parse("run --route comments --from 2026-09-01T00:00:00Z --to 2026-11-01T00:00:00Z --log-group g --db-instance d --load-balancer l").is_ok()
    );
}

#[test]
fn run_issues_only_compiled_queries_and_fixed_metrics() {
    let fx = passing_fixture();
    let fake = FakeAws::new(&fx);
    let report = run(&fake);
    // The stand-in refuses any text that is not a compiled query's. Each
    // query is issued once over the window, in the route's order; one with a
    // week-earlier baseline a second time over the window a week earlier;
    // the join once for each slice.
    let asked = fake.asked.borrow();
    let w = window();
    let mut expected = vec![];
    for q in VOTES.queries() {
        if q.sliced {
            let slices: Vec<_> = asked.iter().filter(|a| a.0 == q.name).collect();
            assert!(slices.len() >= 2, "6,000 votes need more than one slice");
            // The slices cover the window exactly once, in order.
            assert_eq!(slices[0].1, w.from_s);
            assert_eq!(slices[slices.len() - 1].2, w.to_s);
            for pair in slices.windows(2) {
                assert_eq!(pair[0].2, pair[1].1);
            }
            expected.extend(slices.iter().map(|a| **a));
            continue;
        }
        expected.push((q.name, w.from_s, w.to_s));
        if q.previous_week {
            expected.push((q.name, w.from_s - WEEK_S, w.to_s - WEEK_S));
        }
    }
    assert_eq!(*asked, expected);
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
}

#[test]
fn the_join_classes_on_fixture_lines() {
    let mut fx = Fixture::new();
    for _ in 0..20 {
        fx.vote(81_001, Case::Agree);
    }
    fx.vote(81_001, Case::Exhausted);
    fx.vote(81_001, Case::Exhausted);
    fx.vote(81_001, Case::Topical);
    fx.vote(81_001, Case::RemainingOff);
    fx.vote(81_001, Case::Node500AfterStore);
    fx.vote(81_001, Case::HandBack("no_token"));
    fx.vote(81_001, Case::HandBack("no_token"));
    fx.vote(81_001, Case::HandBack("xid_required"));
    fx.vote(81_001, Case::MiddlewareRefusal);
    fx.vote(81_001, Case::NotCopied);
    fx.vote(81_001, Case::Shed);
    fx.vote(81_001, Case::Cors);
    fx.vote(81_001, Case::Uncovered);
    // An id repeated on nginx's line, and a Node line whose id nginx never
    // logged (a client-sent header on a path nginx does not shadow).
    let repeated = fx.vote(81_001, Case::Agree);
    let at = fx.at;
    fx.lines.push(edge(&repeated, at, 200, "0.012"));
    fx.lines
        .push(reply(&id(999_999), at, 81_001, 200, Some(Next::None)));
    let fake = FakeAws::new(&fx);
    let report = run(&fake);
    let join = eval::run(
        &VOTES
            .queries()
            .into_iter()
            .find(|q| q.name == "join")
            .unwrap(),
        &fx.eval_lines(),
        window().from_s,
        window().to_s,
    );
    let total = |key: &str| {
        join.iter()
            .map(|r| r[key].parse::<u64>().unwrap())
            .sum::<u64>()
    };
    let cell = |edge: &str, rust: &str, key: &str| {
        join.iter()
            .filter(|r| {
                r.get("edge_st").map(String::as_str) == Some(edge)
                    && r.get("rust_st").map(String::as_str) == Some(rust)
            })
            .map(|r| r[key].parse::<u64>().unwrap())
            .sum::<u64>()
    };
    // 35 ids: 33 votes in the window once each, one repeated, one Node-only.
    assert_eq!(total("ids"), 35);
    assert_eq!(total("votes"), 33);
    assert_eq!(total("edge_lines"), 35);
    assert_eq!(total("repeated"), 1);
    assert_eq!(total("without_edge"), 1);
    // The copy: every vote but the not-copied one; the timed-out one was not
    // observed.
    assert_eq!(total("copied"), 32);
    assert_eq!(total("not_copied"), 1);
    assert_eq!(total("answered"), 31);
    assert_eq!(total("covered"), 31);
    assert_eq!(total("shed"), 1);
    // Admitted: 20 agree, 2 exhausted, topical, remaining off, Node 500.
    assert_eq!(total("admitted_n"), 25);
    assert_eq!(cell("200", "200", "admitted_n"), 24);
    assert_eq!(cell("500", "200", "admitted_n"), 1);
    assert_eq!(cell("500", "200", "same"), 1);
    assert_eq!(cell("200", "200", "both_next"), 21);
    assert_eq!(cell("200", "200", "both_none"), 2);
    assert_eq!(cell("200", "200", "node_topical"), 1);
    assert_eq!(cell("200", "200", "remaining_equal"), 20);
    assert_eq!(cell("200", "200", "total_equal"), 21);
    // Node: the middleware refusal has an access line and no handler reply.
    assert_eq!(total("node_refused_early"), 1);
    assert_eq!(total("node_edge_mismatch"), 0);
    assert_eq!(total("http_edge_mismatch"), 0);
    // CORS is counted on its own.
    assert_eq!(total("cors"), 1);
    // The report reads the same classes.
    assert_eq!(
        report.mark("status agreement"),
        Some(Mark::Pass),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("agree 24 of 25; Node 500 after storing the vote 1; disagree 0"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("would-be failures"), Some(Mark::Pass));
    assert!(
        report
            .text
            .contains("would_fail 0 (CORS refusals, not counted: 1)")
    );
    assert!(
        report.text.contains("no_token                   3"),
        "{}",
        report.text
    );
    assert!(report.text.contains("xid_required               1"));
    assert!(report.text.contains("shed (rate_cap): 1"));
    assert!(
        report
            .text
            .contains("not copied: outside the 1..9999-byte bound       1")
    );
    assert!(report.text.contains("remaining equal 20 of 21"));
    assert_eq!(report.mark("remaining and total"), Some(Mark::Miss));
    assert!(report.text.contains("Node lines with no nginx line 1"));
    assert!(report.text.contains("observed lines for copied votes 31"));
    assert_eq!(report.mark("coverage"), Some(Mark::Miss));
    assert_eq!(report.mark("evidence volume"), Some(Mark::Short));
    // At this volume the one copy that timed out (30 ms) is the hour's p99:
    // the copy's cost misses and the stop rule's hold limit fires.
    assert_eq!(report.mark("the copy's cost"), Some(Mark::Miss));
    assert_eq!(report.mark("stop rule"), Some(Mark::Stop));
    assert_eq!(report.verdict, Verdict::Stop);
}

#[test]
fn verdict_pass_on_enough_agreeing_evidence() {
    let fx = passing_fixture();
    let report = run(&FakeAws::new(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    for c in &report.criteria {
        assert!(
            matches!(c.mark, Mark::Pass | Mark::Info),
            "{} {:?}: {}",
            c.name,
            c.mark,
            c.value
        );
    }
    assert!(report.text.contains("VERDICT: PASS"));
    // Nothing but aggregates: no request id, no conversation or statement
    // number from the fixture.
    for n in 1..fx.next {
        assert!(!report.text.contains(&id(n)));
    }
    for zid in 73_001..73_061 {
        assert!(!report.text.contains(&zid.to_string()), "{zid}");
    }
}

#[test]
fn verdict_stop_on_a_status_disagreement() {
    let mut fx = passing_fixture();
    fx.vote(73_001, Case::ClosedDisagree);
    let report = run(&FakeAws::new(&fx));
    assert_eq!(
        report.mark("status agreement"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(
        report.text.contains("Node 200    shadow 403    1"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("would-be 403 (closed) that Node stored: 1")
    );
    assert_eq!(report.verdict, Verdict::Stop);
}

#[test]
fn verdict_stop_on_a_vote_read_back_with_the_other_choice() {
    let mut fx = passing_fixture();
    fx.vote(73_002, Case::Different);
    let report = run(&FakeAws::new(&fx));
    assert_eq!(
        report.mark("node_vote"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert_eq!(report.verdict, Verdict::Stop);
}

#[test]
fn verdict_stop_on_the_stop_rule() {
    let fx = passing_fixture();
    let hour = |h: i64| (window().from_s + h * 3600) * 1000;
    let stop = |fake: &FakeAws| run(fake).mark("stop rule");
    // 1. Database CPU, two consecutive five-minute averages above 60 %.
    let mut fake = FakeAws::new(&fx);
    let cpu = fake.metrics.get_mut("db_cpu").unwrap();
    cpu[10].1 = 75.0;
    cpu[11].1 = 64.0;
    let report = run(&fake);
    assert_eq!(
        report.mark("stop rule"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("fired: database CPU"));
    assert_eq!(report.verdict, Verdict::Stop);
    assert_eq!(report.verdict.exit_code(), 1);
    // One period above is not two consecutive.
    let mut fake = FakeAws::new(&fx);
    fake.metrics.get_mut("db_cpu").unwrap()[10].1 = 75.0;
    assert_eq!(stop(&fake), Some(Mark::Pass));
    // 3. The load balancer's p99: one hour a quarter above last week is not
    // a stop, two hours well above are not, three in a row are.
    let mut fake = FakeAws::new(&fx);
    fake.metrics.get_mut("lb_p99").unwrap()[3].1 = 0.25;
    assert_eq!(stop(&fake), Some(Mark::Pass));
    let mut fake = FakeAws::new(&fx);
    for h in [3, 4] {
        fake.metrics.get_mut("lb_p99").unwrap()[h].1 = 0.35;
    }
    assert_eq!(stop(&fake), Some(Mark::Pass));
    let mut fake = FakeAws::new(&fx);
    for h in [3, 4, 5] {
        fake.metrics.get_mut("lb_p99").unwrap()[h].1 = 0.35;
    }
    let report = run(&fake);
    assert_eq!(
        report.mark("stop rule"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("fired: load balancer p99, sustained"));
    // Target 5xx are context, not a stop: the pulse's week of 2026-11-02
    // had days of 1,999 against 284 a week before.
    let mut fake = FakeAws::new(&fx);
    fake.metrics.get_mut("target_5xx").unwrap()[0].1 = 1999.0;
    fake.metrics.get_mut("target_5xx_previous").unwrap()[0].1 = 284.0;
    assert_eq!(stop(&fake), Some(Mark::Pass));
    let mut fake = FakeAws::new(&fx);
    fake.metrics.get_mut("target_5xx_previous").unwrap().clear();
    assert_eq!(stop(&fake), Some(Mark::Pass));
    // 4. Vote errors: 60 more Node 5xx on votes (1 % of votes, against one
    // in 6,000 a week earlier) stop; 8 more do not (under ten in all).
    let mut fake = FakeAws::new(&fx);
    for i in 0..60 {
        fake.push(access_taking(None, hour(2) + i * 1000, 500, 20.0));
    }
    let report = run(&fake);
    assert_eq!(
        report.mark("stop rule"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("fired: vote errors"));
    let mut fake = FakeAws::new(&fx);
    for i in 0..8 {
        fake.push(access_taking(None, hour(2) + i * 1000, 500, 20.0));
    }
    assert_eq!(stop(&fake), Some(Mark::Pass));
    // 5. Vote p99: slow votes in three hours in a row stop; in two, not.
    let slow = |hours: &[i64]| {
        let mut fake = FakeAws::new(&fx);
        for &h in hours {
            for i in 0..30 {
                fake.push(access_taking(
                    None,
                    hour(h) + 100_000 + i * 1000,
                    200,
                    500.0,
                ));
            }
        }
        fake
    };
    assert_eq!(stop(&slow(&[3, 4])), Some(Mark::Pass));
    let report = run(&slow(&[3, 4, 5]));
    assert_eq!(
        report.mark("stop rule"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("fired: vote p99, sustained"));
    // 2. A copy held 70 ms.
    let mut held = passing_fixture();
    let at = held.at;
    held.lines.push(mirror(&id(1), at, 504, "504", 0.070));
    assert_eq!(stop(&FakeAws::new(&held)), Some(Mark::Stop));
}

#[test]
fn verdict_too_little_evidence() {
    let mut fx = Fixture::new();
    for _ in 0..40 {
        fx.vote(90_001, Case::Agree);
    }
    let report = run(&FakeAws::new(&fx));
    assert_eq!(report.mark("evidence volume"), Some(Mark::Short));
    // No lines at all: every query answers with no rows; still too little
    // evidence, never a pass.
    let empty = run(&FakeAws::new(&Fixture::new()));
    assert_eq!(
        empty.mark("evidence volume"),
        Some(Mark::Short),
        "{}",
        empty.text
    );
    assert_eq!(empty.verdict, Verdict::TooLittle);
    assert_eq!(report.verdict, Verdict::TooLittle, "{}", report.text);
}

/// A week in which a line loses its statement numbers holds lines of both
/// shapes. The shadow's line named the statement voted on and the one it
/// would serve (`tid`, `next_tid`) and now names neither; Node's reply line
/// named the statement it served next (`node_next_tid`) and now names none.
/// No query reads any of the three keys, so the report over such a week is,
/// byte for byte, the report over the same week written in the new shape.
#[test]
fn a_week_holding_both_line_shapes_reports_as_the_new_shape() {
    let new = run(&FakeAws::new(&passing_fixture()));
    assert_eq!(new.verdict, Verdict::Pass, "{}", new.text);
    let mut mixed = passing_fixture();
    let (mut old, mut observations) = (0, 0);
    let (mut old_replies, mut replies) = (0, 0);
    for (_, json) in &mut mixed.lines {
        let mut value: Value = serde_json::from_str(json).unwrap();
        let line = value.as_object_mut().unwrap();
        if line["message"] == "vote_reply" && line.contains_key("node_next") {
            assert!(!line.contains_key("node_next_tid"));
            replies += 1;
            // Every other reply that served a statement is in the shape
            // Node wrote before: it names that statement.
            if replies % 2 == 1 && line["node_next"] != "none" {
                line.insert("node_next_tid".into(), json!(4));
                *json = value.to_string();
                old_replies += 1;
            }
            continue;
        }
        if line["message"] != "shadow_observation" {
            continue;
        }
        observations += 1;
        // Every other observation line is in the shape written before.
        if observations % 2 == 0 {
            continue;
        }
        let next = if line["follow_on"] == "complete" {
            json!(4)
        } else {
            Value::Null
        };
        line.insert("tid".into(), json!(3));
        line.insert("next_tid".into(), next);
        assert_eq!(line.len(), OBSERVATION_KEYS.len() + 2);
        *json = value.to_string();
        old += 1;
    }
    assert!(
        old > 3_000 && observations - old > 3_000,
        "{old} of {observations}"
    );
    assert!(
        old_replies > 2_000 && replies - old_replies > 2_000,
        "{old_replies} of {replies}"
    );
    let report = run(&FakeAws::new(&mixed));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert_eq!(report.text, new.text);
}

/// The report says in every run what it does not compare: the lines name no
/// statement, so neither the picks nor how they are weighted. No criterion
/// claims it, and no section prints a statement number.
#[test]
fn the_report_compares_no_statement_and_says_so() {
    let fx = passing_fixture();
    let report = run(&FakeAws::new(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert_eq!(report.mark("weights"), None);
    assert!(
        report.text.contains("the shadow's line names no statement"),
        "{}",
        report.text
    );
    assert!(!report.text.contains("Draw distributions"));
    assert!(report.text.contains("\n8. Criteria for the week"));
    for word in report
        .text
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
    {
        assert!(word != "tid" && !word.ends_with("_tid"), "{word}");
    }
}

#[test]
fn a_client_that_goes_away_is_not_a_disagreement() {
    // The passing fixture's 6,003 admitted would-serve copies, plus one whose
    // participant closed the connection (nginx 499) after Node's handler
    // stored the vote.
    let mut fx = passing_fixture();
    fx.vote(73_001, Case::ClientGone);
    let report = run(&FakeAws::new(&fx));
    assert!(
        report.text.contains("agree 6002 of 6003; Node 500 after storing the vote 1; disagree 0; not compared: the participant went away (499) 1, nginx answered 5xx without Node's handler 0"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("status agreement"), Some(Mark::Pass));
    assert_eq!(report.verdict, Verdict::Pass);
    // A 502 nginx answered with no reply from Node's handler: its own class.
    let mut fx = passing_fixture();
    fx.vote(73_001, Case::NginxOnly5xx);
    let report = run(&FakeAws::new(&fx));
    assert!(
        report
            .text
            .contains("nginx answered 5xx without Node's handler 1"),
        "{}",
        report.text
    );
    assert_eq!(report.verdict, Verdict::Pass);
}

#[test]
fn a_down_shadow_counts_against_coverage() {
    let mut fx = passing_fixture();
    for _ in 0..40 {
        fx.vote(73_002, Case::HostAbsent);
    }
    let report = run(&FakeAws::new(&fx));
    assert!(
        report.text.contains("the shadow's host absent 40"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("coverage"), Some(Mark::Miss));
    assert_eq!(report.verdict, Verdict::Examine);
}

#[test]
fn readbacks_that_never_ran_count_against_the_stored_vote_share() {
    let mut fx = passing_fixture();
    for _ in 0..10 {
        fx.vote(73_003, Case::NotReadBack);
    }
    let report = run(&FakeAws::new(&fx));
    assert!(
        report
            .text
            .contains("of 6013 admitted would-be 200s (6003 read back)"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("node_vote"), Some(Mark::Miss));
    assert_eq!(report.verdict, Verdict::Examine);
}

#[test]
fn a_refused_two_stage_query_is_reported_never_answered_wrongly() {
    let fx = passing_fixture();
    let mut fake = FakeAws::new(&fx);
    fake.refuse_two_stage = true;
    let report = run(&fake);
    assert!(report.text.contains("join: Logs Insights refused this query, which has two stats stages; this account may not support them (An error occurred (MalformedQueryException)"), "{}", report.text);
    for name in [
        "coverage",
        "status agreement",
        "remaining and total",
        "exhaustion and presence",
    ] {
        assert_eq!(report.mark(name), Some(Mark::NotEvaluated), "{name}");
    }
    assert_eq!(report.verdict, Verdict::TooLittle);
}

#[test]
fn join_totals_that_disagree_with_the_line_count_are_withheld() {
    let fx = passing_fixture();
    let w = window();
    let mut results = report::Results::new();
    for q in VOTES.queries() {
        results.insert(
            q.name.into(),
            Ok(eval::run(&q, &fx.eval_lines(), w.from_s, w.to_s)),
        );
    }
    // A second stage that lost half its lines.
    if let Some(Ok(join)) = results.get_mut("join") {
        for row in join.iter_mut() {
            let lines: u64 = row["edge_lines"].parse().unwrap();
            row.insert("edge_lines".into(), (lines / 2).to_string());
        }
    }
    let metrics = quiet_metrics(w)
        .into_iter()
        .map(|(k, v)| (k, Ok(v)))
        .collect();
    let report = report::build(&report::Inputs {
        route: VOTES,
        window: w,
        results: &results,
        metrics: &metrics,
    });
    assert!(
        report.text.contains("does not match the one-stage count"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("status agreement"), Some(Mark::NotEvaluated));
}

#[test]
fn an_empty_upstream_status_means_not_copied() {
    let mut fx = Fixture::new();
    fx.vote(1, Case::NotCopied);
    fx.vote(1, Case::Agree);
    // The shadow's host absent from DNS: nginx answers the copy 502 itself.
    let at = fx.at + 1;
    fx.lines.push(edge(&id(77), at, 200, "0.012"));
    fx.lines.push(mirror(&id(77), at, 502, "", 0.0));
    let report = run(&FakeAws::new(&fx));
    assert!(
        report
            .text
            .contains("copied (an upstream status)                      1 (33.33 %)"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("not copied: outside the 1..9999-byte bound       1")
    );
    assert!(
        report
            .text
            .contains("not copied: the shadow's host absent             1")
    );
}

#[test]
fn recorded_get_query_results_parse() {
    let recorded = r#"{
      "results": [
        [{"field": "mirror_status", "value": "204"}, {"field": "mirror_upstream_status", "value": ""},
         {"field": "n", "value": "12"}, {"field": "@ptr", "value": "CmAKJwoj"}],
        [{"field": "mirror_status", "value": "204"}, {"field": "mirror_upstream_status", "value": "204"},
         {"field": "n", "value": "3301"}, {"field": "p99_s", "value": "0.002"}]
      ],
      "statistics": {"recordsMatched": 3313.0, "recordsScanned": 9.1e6, "bytesScanned": 4.2e9},
      "status": "Complete"
    }"#;
    let (status, rows, bytes) = aws::parse_results(recorded).unwrap();
    assert_eq!(status, "Complete");
    assert_eq!(bytes, 4.2e9);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["mirror_upstream_status"], "");
    assert!(!rows[0].contains_key("@ptr"));
    assert_eq!(rows[1]["n"], "3301");
    let datapoints = r#"{"Label": "TargetResponseTime", "Datapoints": [
        {"Timestamp": "2026-11-09T01:00:00+00:00", "ExtendedStatistics": {"p99": 0.31}, "Unit": "Seconds"},
        {"Timestamp": "2026-11-09T00:00:00+00:00", "ExtendedStatistics": {"p99": 0.22}, "Unit": "Seconds"}]}"#;
    let points = aws::parse_datapoints(datapoints, aws::Stat::P99).unwrap();
    assert_eq!(
        points,
        vec![(window().from_s, 0.22), (window().from_s + 3600, 0.31)]
    );
}

#[test]
fn report_reads_a_results_directory() {
    let fx = passing_fixture();
    let w = window();
    let dir = std::env::temp_dir().join(format!("polis-shadow-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let queries = VOTES.queries();
    let lines = FakeAws::new(&fx).lines;
    let mut saved = vec![];
    for q in &queries {
        saved.push((q.name.to_owned(), eval::run(q, &lines, w.from_s, w.to_s)));
        if q.previous_week {
            let before = w.earlier(WEEK_S);
            saved.push((
                format!("{}_previous", q.name),
                eval::run(q, &lines, before.from_s, before.to_s),
            ));
        }
    }
    for (name, rows) in &saved {
        let results: Vec<Value> = rows
            .iter()
            .map(|row| {
                Value::Array(
                    row.iter()
                        .map(|(k, v)| json!({"field": k, "value": v}))
                        .collect(),
                )
            })
            .collect();
        std::fs::write(
            dir.join(format!("{name}.json")),
            json!({"status": "Complete", "results": results}).to_string(),
        )
        .unwrap();
    }
    for (name, points) in quiet_metrics(w) {
        let key = if name.starts_with("lb") {
            "ExtendedStatistics"
        } else if name == "db_cpu" {
            "Average"
        } else {
            "Sum"
        };
        let points: Vec<Value> = points
            .iter()
            .map(|(t, v)| {
                let value = if key == "ExtendedStatistics" {
                    json!({"p99": v})
                } else {
                    json!(v)
                };
                json!({"Timestamp": time::format(*t), key: value})
            })
            .collect();
        std::fs::write(
            dir.join(format!("metric-{name}.json")),
            json!({"Datapoints": points}).to_string(),
        )
        .unwrap();
    }
    let report = crate::report_from(VOTES, &dir, (w.from_s, w.to_s)).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
}

#[test]
fn times_round_trip() {
    let t = time::parse(FROM).unwrap();
    assert_eq!(t, 1_794_182_400);
    assert_eq!(time::format(t), FROM);
    assert_eq!(time::parse("2026-11-09T01:00:00+01:00").unwrap(), t);
    assert_eq!(time::parse("2026-11-09T00:00:00.123Z").unwrap(), t);
    assert_eq!(time::parse("1794182400").unwrap(), t);
    for bad in [
        "2026-11-09",
        "2026-13-09T00:00:00Z",
        "yesterday",
        "2026-11-09T00:00:00+0100",
        "２０２６",
    ] {
        assert!(time::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn metric_requests_are_fixed_and_split_at_the_datapoint_limit() {
    let w = Window {
        from_s: window().from_s,
        to_s: window().from_s + 7 * 86_400,
    };
    let metrics = aws::stop_rule_metrics("db-1", "app/lb/1", w);
    let names: Vec<&str> = metrics.iter().map(|m| m.name).collect();
    assert_eq!(
        names,
        [
            "db_cpu",
            "lb_p99",
            "lb_p99_previous",
            "target_5xx",
            "target_5xx_previous"
        ]
    );
    let cpu = &metrics[0];
    let args = aws::metric_args(cpu, w.from_s, w.from_s + 300 * 1440);
    assert_eq!(
        args,
        [
            "cloudwatch",
            "get-metric-statistics",
            "--namespace",
            "AWS/RDS",
            "--metric-name",
            "CPUUtilization",
            "--dimensions",
            "Name=DBInstanceIdentifier,Value=db-1",
            "--start-time",
            "2026-11-09T00:00:00Z",
            "--end-time",
            "2026-11-14T00:00:00Z",
            "--period",
            "300",
            "--statistics",
            "Average"
        ]
    );
    struct Count(RefCell<u32>);
    impl Aws for Count {
        fn call(&self, _: &[String]) -> anyhow::Result<Reply> {
            *self.0.borrow_mut() += 1;
            Ok(Reply {
                ok: true,
                stdout: r#"{"Datapoints": []}"#.into(),
                stderr: String::new(),
            })
        }
    }
    let counter = Count(RefCell::new(0));
    aws::read_metric(&counter, cpu).unwrap();
    // A week of five-minute points is 2,016: two calls.
    assert_eq!(*counter.0.borrow(), 2);
    assert_eq!(metrics[2].window.to_s, w.to_s - 7 * 86_400);
}

#[test]
fn the_start_query_arguments_carry_only_the_compiled_text() {
    let q = VOTES
        .queries()
        .into_iter()
        .find(|q| q.name == "join")
        .unwrap();
    let args = aws::start_query_args("group-1", &q, window());
    assert_eq!(
        &args[..4],
        ["logs", "start-query", "--log-group-name", "group-1"]
    );
    assert_eq!(args[5], (window().from_s - 60).to_string());
    assert_eq!(args[7], (window().to_s + 60).to_string());
    assert_eq!(args[9], q.text(window().bounds()));
    assert!(args[9].contains(&format!(
        "t >= {} and t < {}",
        window().from_s * 1000,
        window().to_s * 1000
    )));
}

#[test]
fn the_fixture_lines_carry_no_vote_and_the_observation_line_is_the_shadows() {
    let mut fx = Fixture::new();
    fx.vote(5, Case::Agree);
    for (_, json) in &fx.lines {
        let value: Value = serde_json::from_str(json).unwrap();
        let o = value.as_object().unwrap();
        for key in ["vote", "pid", "uid", "txt"] {
            assert!(!o.contains_key(key), "{key} in {json}");
        }
        if o["message"] == "shadow_observation" {
            let keys: Vec<&str> = o.keys().map(String::as_str).collect();
            let mut expected = OBSERVATION_KEYS.to_vec();
            expected.sort();
            let mut keys = keys;
            keys.sort();
            assert_eq!(keys, expected);
        }
    }
    // An expression helper used above, so its rendering is pinned too.
    assert_eq!(
        query::expr_text(&E::In("outcome", vec!["a", "b"]), Bounds::Placeholders),
        r#"outcome in ["a", "b"]"#
    );
    assert_eq!(route::find("votes").map(|r| r.shadow), Some("votesShadow"));
}

/// The fixtures whose vote reports are kept as files.
pub(crate) fn golden_fixtures() -> Vec<(&'static str, Fixture)> {
    let mut classes = Fixture::new();
    for _ in 0..20 {
        classes.vote(81_001, Case::Agree);
    }
    for case in [
        Case::Exhausted,
        Case::Exhausted,
        Case::Topical,
        Case::RemainingOff,
        Case::Node500AfterStore,
        Case::HandBack("no_token"),
        Case::HandBack("no_token"),
        Case::HandBack("xid_required"),
        Case::MiddlewareRefusal,
        Case::NotCopied,
        Case::Shed,
        Case::Cors,
        Case::Uncovered,
    ] {
        classes.vote(81_001, case);
    }
    let repeated = classes.vote(81_001, Case::Agree);
    let at = classes.at;
    classes.lines.push(edge(&repeated, at, 200, "0.012"));
    classes
        .lines
        .push(reply(&id(999_999), at, 81_001, 200, Some(Next::None)));
    let mut stop = passing_fixture();
    stop.vote(73_001, Case::ClosedDisagree);
    stop.vote(73_002, Case::Different);
    let mut examine = passing_fixture();
    for _ in 0..40 {
        examine.vote(73_002, Case::HostAbsent);
    }
    for _ in 0..10 {
        examine.vote(73_003, Case::NotReadBack);
    }
    examine.vote(73_001, Case::ClientGone);
    examine.vote(73_001, Case::NginxOnly5xx);
    let mut small = Fixture::new();
    for _ in 0..40 {
        small.vote(90_001, Case::Agree);
    }
    vec![
        ("passing", passing_fixture()),
        ("classes", classes),
        ("empty", Fixture::new()),
        ("stop", stop),
        ("examine", examine),
        ("small", small),
    ]
}

/// The vote report on these fixtures is, byte for byte, the report the tool
/// printed before it learned a second route (the files were written by that
/// version). Naming the path on Node's access line, running the join in
/// slices and placing ids that are not votes by their first line change no
/// byte of it. One of the six files differs from that version's by three
/// lines, on purpose: over an empty log the stop rule's two rules on Node's
/// vote lines used to read "0 of 0 ... within it" and the stop rule "never
/// fired"; with no line of Node's read they are now "not evaluated".
#[test]
fn the_vote_report_is_byte_for_byte_what_it_was() {
    let saved: BTreeMap<&str, &str> = BTreeMap::from([
        ("passing", include_str!("fixtures/votes-passing.txt")),
        ("classes", include_str!("fixtures/votes-classes.txt")),
        ("empty", include_str!("fixtures/votes-empty.txt")),
        ("stop", include_str!("fixtures/votes-stop.txt")),
        ("examine", include_str!("fixtures/votes-examine.txt")),
        ("small", include_str!("fixtures/votes-small.txt")),
    ]);
    for (name, fx) in golden_fixtures() {
        let report = run(&FakeAws::new(&fx));
        assert_eq!(report.text, saved[name], "{name}");
    }
}
