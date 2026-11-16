//! The report topic map: what three stored families become, the maps too small
//! to draw, the bounds, the cache, the computation slot, and the contract
//! against the generator's own bytes. The two public fixtures are the
//! generator crate's (`polis-topic-map/tests/fixtures`).
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const ZID: i32 = 1424;

fn wire(family: &str, key: &[&str], rows: &[Value]) -> (String, u64) {
    let mut out = json!({"codec": CODEC, "family": family, "key": key}).to_string();
    out.push('\n');
    for row in rows {
        out.push_str(&row.to_string());
        out.push('\n');
    }
    (out, rows.len() as u64)
}

fn node(zid: i32, tid: u32, x: f64, y: f64) -> Value {
    json!({"conversation_id":{"S":zid.to_string()},"distance":{"N":"0"},
        "edge_id":{"S":format!("{tid}_{tid}")},"is_nearest_neighbor":{"BOOL":false},
        "position":{"M":{"x":{"N":x.to_string()},"y":{"N":y.to_string()}}},
        "shared_cluster_layers":{"L":[]},"source_id":{"N":tid.to_string()},
        "target_id":{"N":tid.to_string()},"weight":{"N":"1"}})
}

fn edge(zid: i32, a: u32, b: u32) -> Value {
    json!({"conversation_id":{"S":zid.to_string()},"distance":{"N":"0.25"},
        "edge_id":{"S":format!("{a}_{b}")},"is_nearest_neighbor":{"BOOL":true},
        "shared_cluster_layers":{"L":[{"N":"0"}]},"source_id":{"N":a.to_string()},
        "target_id":{"N":b.to_string()},"weight":{"N":"0.75"}})
}

fn assignment(zid: i32, tid: u32, clusters: &[(u32, i64)]) -> Value {
    let mut row = json!({"conversation_id":{"S":zid.to_string()},"comment_id":{"N":tid.to_string()},
        "is_outlier":{"BOOL":false}});
    for (layer, cluster) in clusters {
        row[format!("layer{layer}_cluster_id")] = json!({"N": cluster.to_string()});
    }
    row
}

fn topic(zid: i32, layer: u32, cluster: i64, name: Option<&str>, key: &str, model: &str) -> Value {
    json!({"conversation_id":{"S":zid.to_string()},"layer_id":{"N":layer.to_string()},
        "cluster_id":{"N":cluster.to_string()},
        "topic_name": name.map_or(json!({"NULL":true}), |n| json!({"S":n})),
        "topic_key":{"S":key},"model_name":{"S":model},"created_at":{"S":"2026-11-11T02:48:21.639910"}})
}

pub(crate) fn wires(zid: i32, nodes: &[Value], assignments: &[Value], topics: &[Value]) -> Wires {
    Wires {
        zid,
        created_at: Some("2026-11-11T02:48:21.639910".into()),
        umap: wire(UMAP, &["conversation_id", "edge_id"], nodes),
        assignments: wire(ASSIGNMENTS, &["conversation_id", "comment_id"], assignments),
        topics: wire(TOPICS, &["conversation_id", "topic_key"], topics),
    }
}

/// A public fixture's run as the result store holds it, its job id, and the
/// document the generator writes for the same run with no text, title or
/// attribution.
pub(crate) fn fixture(set: &str) -> (Wires, String, String) {
    let (proximity, topics) = match set {
        "bg2050" => (
            include_str!("../../polis-topic-map/tests/fixtures/bg2050/proximity.json"),
            include_str!("../../polis-topic-map/tests/fixtures/bg2050/topics.json"),
        ),
        _ => (
            include_str!("../../polis-topic-map/tests/fixtures/biodiversity/proximity.json"),
            include_str!("../../polis-topic-map/tests/fixtures/biodiversity/topics.json"),
        ),
    };
    let p: Value = serde_json::from_str(proximity).unwrap();
    let t: Value = serde_json::from_str(topics).unwrap();
    let (job, run) = t["runs"].as_object().unwrap().iter().next().unwrap();
    let model = run["model_name"].as_str().unwrap();
    let mut nodes = Vec::new();
    let mut assignments = Vec::new();
    let points = p["proximity_data"].as_array().unwrap();
    for (n, point) in points.iter().enumerate() {
        let tid = point["comment_id"].as_u64().unwrap() as u32;
        nodes.push(node(
            ZID,
            tid,
            point["umap_x"].as_f64().unwrap(),
            point["umap_y"].as_f64().unwrap(),
        ));
        // Stored neighbour edges, which the map does not draw.
        if let Some(next) = points.get(n + 1) {
            nodes.push(edge(ZID, tid, next["comment_id"].as_u64().unwrap() as u32));
        }
        let clusters: Vec<(u32, i64)> = point["clusters"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(layer, c)| (layer.parse().unwrap(), c.as_i64().unwrap()))
            .collect();
        assignments.push(assignment(ZID, tid, &clusters));
    }
    let mut names = Vec::new();
    for (layer, clusters) in run["topics_by_layer"].as_object().unwrap() {
        for (cluster, name) in clusters.as_object().unwrap() {
            assert_eq!(name["model_name"], model, "one model named the fixture");
            names.push(topic(
                ZID,
                layer.parse().unwrap(),
                cluster.parse().unwrap(),
                name["topic_name"].as_str(),
                name["topic_key"].as_str().unwrap(),
                model,
            ));
        }
    }
    let mut stored = wires(ZID, &nodes, &assignments, &names);
    stored.created_at = run["created_at"].as_str().map(str::to_owned);
    let mut expected = polis_topic_map::build(
        serde_json::from_str(proximity).unwrap(),
        serde_json::from_str(topics).unwrap(),
        &BTreeMap::new(),
        "",
        "",
    )
    .unwrap();
    expected.points.text = Vec::new();
    (
        stored,
        job.clone(),
        serde_json::to_string(&expected).unwrap(),
    )
}

fn map(outcome: Result<Outcome, Invalid>) -> String {
    match outcome {
        Ok(Outcome::Map(doc)) => doc.to_string(),
        Ok(Outcome::NoMap(reason)) => panic!("no map: {reason:?}"),
        Ok(_) => panic!("refused"),
        Err(e) => panic!("invalid: {e:?}"),
    }
}

fn reason(outcome: Result<Outcome, Invalid>) -> NoMapReason {
    match outcome {
        Ok(Outcome::NoMap(reason)) => reason,
        Ok(Outcome::Map(_)) => panic!("a map"),
        Ok(_) => panic!("refused"),
        Err(e) => panic!("invalid: {e:?}"),
    }
}

#[test]
fn stored_families_draw_the_generators_document_to_the_byte() {
    // Recorded lengths and digests of the route's documents: the generator's
    // recorded documents of the same runs (tests/document_recording.rs) with
    // an empty title, attribution and text.
    for (set, bytes, sha) in [
        (
            "biodiversity",
            8_899usize,
            "2860c322604fee15856f40b6ef76b572bdbc9f4ded595c0cbe795dcc9384f040",
        ),
        (
            "bg2050",
            200_031usize,
            "18c895f703dde62d04c7154981ab566f8d088b0bdb52adaea8bae34c9b10fa80",
        ),
    ] {
        let (stored, job, expected) = fixture(set);
        let doc = map(build(&job, stored));
        assert_eq!(
            doc, expected,
            "{set}: the stored families give the generator's document"
        );
        let digest = format!("{:x}", Sha256::digest(doc.as_bytes()));
        eprintln!("{set} bytes={} sha256={digest}", doc.len());
        assert_eq!((doc.len(), digest.as_str()), (bytes, sha), "{set}");
        let value: Value = serde_json::from_str(&doc).unwrap();
        assert_eq!(value["points"]["text"], json!([]));
        assert_eq!(value["title"], "");
        assert_eq!(value["run"]["jobId"], job.as_str());
        // The same run, computed again: the same bytes.
        let (again, _, _) = fixture(set);
        assert_eq!(map(build(&job, again)), doc);
    }
}

#[test]
fn the_document_is_the_contract_field_for_field() {
    for set in ["biodiversity", "bg2050"] {
        let (stored, job, _) = fixture(set);
        let doc = map(build(&job, stored));
        let typed: contract::TopicMap = serde_json::from_str(&doc).unwrap();
        assert_eq!(typed.schema, contract::SCHEMA);
        assert_eq!(serde_json::to_string(&typed).unwrap(), doc, "{set}");
        assert_eq!(typed.points.id.len(), typed.points.x.len());
        assert!(
            typed
                .points
                .topic
                .iter()
                .all(|row| row.len() == typed.points.id.len())
        );
    }
}

#[test]
fn one_or_two_comments_or_one_position_have_no_map() {
    let topics = [topic(ZID, 0, 0, Some("0_0: a"), "k#0#0", "m")];
    let mut nodes = vec![];
    let mut assignments = vec![];
    for tid in 0..2u32 {
        nodes.push(node(ZID, tid, f64::from(tid), 1.0));
        assignments.push(assignment(ZID, tid, &[(0, 0)]));
        let n = (tid + 1) as usize;
        assert_eq!(
            reason(build(
                "j",
                wires(ZID, &nodes[..n], &assignments[..n], &topics)
            )),
            NoMapReason::TooFewComments,
            "{n} comments"
        );
    }
    // Three comments; the two the first view keeps, (0, 1) and (1, 2), span
    // an area: a map.
    assignments.push(assignment(ZID, 2, &[(0, 0)]));
    let three = [
        node(ZID, 0, 0.0, 1.0),
        node(ZID, 1, 1.0, 2.0),
        node(ZID, 2, 0.5, 5.0),
    ];
    let doc = map(build("j", wires(ZID, &three, &assignments, &topics)));
    let typed: contract::TopicMap = serde_json::from_str(&doc).unwrap();
    assert!(typed.bounds[1] > typed.bounds[0] && typed.bounds[3] > typed.bounds[2]);
    assert!(typed.point_radius > 0.0);
    // Three comments, the two the first view keeps at one position.
    let same = [
        node(ZID, 0, 0.0, 0.0),
        node(ZID, 1, 0.0, 0.0),
        node(ZID, 2, 5.0, 5.0),
    ];
    assert_eq!(
        reason(build("j", wires(ZID, &same, &assignments, &topics))),
        NoMapReason::TooFewComments
    );
    // Three comments, the two it keeps on one horizontal line.
    let line = [
        node(ZID, 0, 0.0, 1.0),
        node(ZID, 1, 1.0, 1.0),
        node(ZID, 2, 0.5, 3.0),
    ];
    assert_eq!(
        reason(build("j", wires(ZID, &line, &assignments, &topics))),
        NoMapReason::TooFewComments
    );
}

#[test]
fn a_run_without_positions_or_topics_has_no_map() {
    let nodes = [
        node(ZID, 0, 0.0, 0.0),
        node(ZID, 1, 1.0, 2.0),
        node(ZID, 2, 3.0, 1.0),
    ];
    let named = [topic(ZID, 0, 0, Some("0_0: a"), "k#0#0", "m")];
    let clustered: Vec<_> = (0..3).map(|t| assignment(ZID, t, &[(0, 0)])).collect();
    // Only edges: no positions.
    assert_eq!(
        reason(build("j", wires(ZID, &[edge(ZID, 0, 1)], &[], &named))),
        NoMapReason::NoPositions
    );
    // No layer at all.
    let bare: Vec<_> = (0..3).map(|t| assignment(ZID, t, &[])).collect();
    assert_eq!(
        reason(build("j", wires(ZID, &nodes, &bare, &named))),
        NoMapReason::NoTopics
    );
    // Layers, but no named cluster.
    let unnamed = [topic(ZID, 0, -1, Some("outliers"), "k#0#-1", "m")];
    assert_eq!(
        reason(build("j", wires(ZID, &nodes, &clustered, &unnamed))),
        NoMapReason::NoTopics
    );
    // A cluster without a stored name is drawn with the generator's name for it.
    let other = [topic(ZID, 0, 7, Some("0_7: b"), "k#0#7", "m")];
    let doc = map(build("j", wires(ZID, &nodes, &clustered, &other)));
    assert!(doc.contains(r#""name":"Topic 0""#), "{doc}");
}

#[test]
fn stored_rows_that_do_not_agree_are_not_drawn() {
    let nodes = || {
        vec![
            node(ZID, 0, 0.0, 0.0),
            node(ZID, 1, 1.0, 2.0),
            node(ZID, 2, 3.0, 1.0),
        ]
    };
    let clustered = || {
        (0..3)
            .map(|t| assignment(ZID, t, &[(0, 0)]))
            .collect::<Vec<_>>()
    };
    let named = || vec![topic(ZID, 0, 0, Some("0_0: a"), "k#0#0", "m")];
    assert!(build("j", wires(ZID, &nodes(), &clustered(), &named())).is_ok());
    let mut cases: Vec<(&str, Wires)> = vec![];
    let mut n = nodes();
    n[1] = node(ZID + 1, 1, 1.0, 2.0);
    cases.push((
        "another conversation's position",
        wires(ZID, &n, &clustered(), &named()),
    ));
    let mut n = nodes();
    n.push(node(ZID, 2, 4.0, 4.0));
    cases.push((
        "a comment placed twice",
        wires(ZID, &n, &clustered(), &named()),
    ));
    cases.push((
        "a position without clusters",
        wires(ZID, &nodes(), &clustered()[..2], &named()),
    ));
    let mut a = clustered();
    a.push(assignment(ZID, 9, &[(0, 0)]));
    cases.push((
        "clusters without a position",
        wires(ZID, &nodes(), &a, &named()),
    ));
    let mut a = clustered();
    a[0] = assignment(ZID, 0, &[(16, 0)]);
    cases.push(("a layer past the bound", wires(ZID, &nodes(), &a, &named())));
    let mut t = named();
    t.push(topic(ZID, 0, 0, Some("again"), "k2", "m"));
    cases.push((
        "one cluster named twice",
        wires(ZID, &nodes(), &clustered(), &t),
    ));
    cases.push((
        "a topic of another conversation",
        wires(
            ZID,
            &nodes(),
            &clustered(),
            &[topic(ZID + 1, 0, 0, Some("a"), "k", "m")],
        ),
    ));
    let mut n = nodes();
    n[0]["source_id"] = json!({"N":"00"});
    n[0]["target_id"] = json!({"N":"00"});
    cases.push((
        "a comment id spelled two ways",
        wires(ZID, &n, &clustered(), &named()),
    ));
    let mut n = nodes();
    n[0]["position"] = json!({"M":{"x":{"N":"NaN"},"y":{"N":"0"}}});
    cases.push((
        "a position that is not a number",
        wires(ZID, &n, &clustered(), &named()),
    ));
    let mut w = wires(ZID, &nodes(), &clustered(), &named());
    w.umap.1 += 1;
    cases.push(("a row count the family does not have", w));
    let mut w = wires(ZID, &nodes(), &clustered(), &named());
    w.topics = wire(UMAP, &["conversation_id", "edge_id"], &named());
    cases.push(("a codec file of another family", w));
    let mut w = wires(ZID, &nodes(), &clustered(), &named());
    w.assignments.0.pop();
    cases.push(("a codec file without its last newline", w));
    for (case, stored) in cases {
        assert!(build("j", stored).is_err(), "{case}");
    }
}

#[test]
fn a_run_over_the_comment_bound_is_refused_not_cut() {
    let count = MAX_COMMENTS as u32 + 1;
    let nodes: Vec<_> = (0..count)
        .map(|t| node(ZID, t, f64::from(t % 200), f64::from(t / 200)))
        .collect();
    let clustered: Vec<_> = (0..count).map(|t| assignment(ZID, t, &[(0, 0)])).collect();
    let named = [topic(ZID, 0, 0, Some("0_0: a"), "k#0#0", "m")];
    assert!(matches!(
        build("j", wires(ZID, &nodes, &clustered, &named)),
        Ok(Outcome::TooLarge)
    ));
    // One fewer is drawn.
    let n = count as usize - 1;
    assert!(matches!(
        build("j", wires(ZID, &nodes[..n], &clustered[..n], &named)),
        Ok(Outcome::Map(_))
    ));
}

#[test]
fn the_cache_keeps_runs_within_its_byte_bound() {
    let entry = |n: usize| {
        Arc::new(Entry {
            zid: ZID,
            outcome: Outcome::Map("x".repeat(n).into()),
        })
    };
    let mut cache = Cache::default();
    cache.insert("a".into(), entry(40), 100, 10);
    cache.insert("b".into(), entry(40), 100, 10);
    assert!(cache.get("a").is_some());
    // c pushes out the least recent, b.
    cache.insert("c".into(), entry(40), 100, 10);
    assert!(cache.get("b").is_none());
    assert!(cache.get("a").is_some() && cache.get("c").is_some());
    assert_eq!(cache.bytes, 80);
    // A document over the whole bound is not kept, and evicts nothing.
    cache.insert("d".into(), entry(101), 100, 10);
    assert!(cache.get("d").is_none());
    assert_eq!(cache.entries.len(), 2);
    // Replacing an entry counts it once.
    cache.insert("a".into(), entry(10), 100, 10);
    assert_eq!(cache.bytes, 50);
    // And the entry bound.
    cache.insert("e".into(), entry(1), 100, 2);
    assert_eq!(cache.entries.len(), 2);
}

#[test]
fn bounds_and_pool_are_the_ones_the_note_states() {
    let limits = pool_limits();
    assert_eq!(limits.size, 2);
    assert_eq!(limits.acquire_timeout, Duration::from_millis(50));
    assert_eq!(limits.statement_timeout, Duration::from_millis(2000));
    assert_eq!(DEADLINE, Duration::from_millis(4000));
    assert_eq!(COMPUTE_SLOTS, 1);
    assert_eq!(MAX_COMMENTS, 20_000);
    assert_eq!(MAX_DOCUMENT_BYTES, 8 * 1024 * 1024);
    assert_eq!(CACHE_BYTES, 32 * 1024 * 1024);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_for_one_run_compute_it_once_one_at_a_time() {
    let state = State::new(CACHE_BYTES, CACHE_ENTRIES, COMPUTE_SLOTS);
    let (_, job, expected) = fixture("biodiversity");
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let job = job.clone();
        let (stored, _, _) = fixture("biodiversity");
        tasks.push(tokio::spawn(
            async move { state.compute(job, stored).await },
        ));
    }
    for task in tasks {
        let entry = task.await.unwrap().unwrap();
        let Outcome::Map(doc) = &entry.outcome else {
            panic!("a map")
        };
        assert_eq!(doc.as_ref(), expected);
    }
    assert_eq!(state.max_in_flight(), 1);
    assert_eq!(
        state.computed(),
        1,
        "the later requests found the first one's map"
    );
    assert!(state.cached(&job).is_some());
}

fn app() -> App {
    let cfg = crate::config::Config {
        listen: String::new(),
        math_env: "python".into(),
        cache_size: 1,
        pca_cache_size: 1,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: crate::db::Limits {
            size: 1,
            acquire_timeout: Duration::from_millis(20),
            statement_timeout: Duration::from_millis(20),
            max_lifetime: Duration::from_secs(60),
        },
    };
    // A closed loopback port: any read fails at once.
    let pg = "postgresql://test@127.0.0.1:1/test".parse().unwrap();
    let pool = |limits| {
        crate::db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg)),
            limits,
        )
    };
    let mut app = App::new(&cfg, pool(cfg.pool.clone()));
    app.delphi_topic_map_db = Some(crate::db::Pool::new(
        polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
            "postgresql://test@127.0.0.1:1/test".parse().unwrap(),
        )),
        pool_limits(),
    ));
    app
}

fn get(target: &str) -> Request {
    Request {
        method: "GET".into(),
        target: target.into(),
        headers: crate::http::Headers::default(),
        body: vec![],
    }
}

#[test]
fn only_this_routes_query_is_admitted() {
    let app = app();
    let parsed = parse(
        &app,
        &get("/api/v3/delphi/topicMap?report_id=r1&job_id=j-1"),
    )
    .unwrap();
    assert_eq!(parsed.report_id.as_deref(), Some("r1"));
    assert_eq!(parsed.job_id.as_deref(), Some("j-1"));
    let parsed = parse(&app, &get("/api/v3/delphi/topicMap?report_id=")).unwrap();
    assert_eq!(parsed, contract::Request::default());
    for target in [
        "/api/v3/delphi/topicMap?report_id=r1&report_id=r2",
        "/api/v3/delphi/topicMap?report_id=r1&section=x",
        "/api/v3/delphi/topicMap?report_id=r%2F1",
        "/api/v3/delphi/topicMapx?report_id=r1",
    ] {
        assert!(parse(&app, &get(target)).is_none(), "{target}");
    }
    let long = format!("/api/v3/delphi/topicMap?report_id={}", "r".repeat(101));
    assert!(parse(&app, &get(&long)).is_none());
    let mut post = get("/api/v3/delphi/topicMap?report_id=r1");
    post.method = "POST".into();
    assert!(parse(&app, &post).is_none());
    let mut body = get("/api/v3/delphi/topicMap?report_id=r1");
    body.body = b"{}".to_vec();
    assert!(parse(&app, &body).is_none());
    // Switched off, nothing is admitted.
    let mut off = app;
    off.delphi_topic_map_db = None;
    assert!(parse(&off, &get("/api/v3/delphi/topicMap?report_id=r1")).is_none());
}

#[tokio::test]
async fn a_missing_report_is_refused_before_any_read_and_a_failed_read_hands_back() {
    let app = Arc::new(app());
    let out = crate::dispatch(app.clone(), None, get("/api/v3/delphi/topicMap")).await;
    assert_eq!(out.status, 400);
    let crate::http::Body::Fixed(body) = out.body else {
        panic!("a body")
    };
    assert_eq!(
        String::from_utf8(body).unwrap(),
        r#"{"status":"error","message":"report_id is required"}"#
    );
    let out = crate::dispatch(app, None, get("/api/v3/delphi/topicMap?report_id=r1")).await;
    assert_eq!(out.status, 502, "the database is unreachable: Node answers");
}

#[cfg(feature = "db-tests")]
#[path = "delphi_topic_map_database_tests.rs"]
mod database_tests;
