//! The report topic map route without a database: what it admits, who must be
//! signed in for what, the ETags it reads, the places it sheds on, and the
//! answers it gives before it reads anything. The database tests (the whole
//! request against PostgreSQL) are in `delphi_topic_map_database_tests.rs`.
use super::*;
use crate::http::{Body, Headers};

#[cfg(feature = "db-tests")]
pub(crate) const ZID: i32 = 1424;

/// A `polis-topic-map/1` document of `points` comments in one topic, without
/// text, valid for the contract's closed types.
pub(crate) fn document(points: usize, job: &str) -> String {
    let ids: Vec<String> = (0..points).map(|i| i.to_string()).collect();
    let xs: Vec<String> = (0..points)
        .map(|i| format!("{:.6}", (i % 997) as f64 * 0.013 - 6.5))
        .collect();
    let ys: Vec<String> = (0..points)
        .map(|i| format!("{:.6}", (i / 997) as f64 * 0.017 - 4.25))
        .collect();
    let topic = vec!["0"; points].join(",");
    format!(
        concat!(
            r##"{{"schema":"polis-topic-map/1","title":"","attribution":"","run":{{"jobId":"{job}","topicModel":null,"createdAt":"2026-11-11T02:48:21Z"}},"##,
            r##""bounds":[-6.5,6.5,-4.25,4.25],"pointRadius":0.11,"levels":[{{"level":0,"topics":1,"unclustered":0,"cmapPalette":false}}],"##,
            r##""topics":[{{"id":"0_0","level":0,"cluster":0,"key":"k","name":"0_0: one topic","count":{points},"x":0.0,"y":0.5,"weight":1.31607,"parent":null,"parentShare":null,"color":"#dd6a94","labelColor":"#734252","colorAll":"#dd6a94","labelColorAll":"#734252"}}],"##,
            r##""points":{{"id":[{ids}],"x":[{xs}],"y":[{ys}],"topic":[[{topic}]],"text":[]}}}}"##
        ),
        job = job,
        points = points,
        ids = ids.join(","),
        xs = xs.join(","),
        ys = ys.join(","),
        topic = topic,
    )
}

pub(crate) fn app() -> App {
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
    let pool = |limits| {
        crate::db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
                "postgresql://test@127.0.0.1:1/test".parse().unwrap(),
            )),
            limits,
        )
    };
    let mut app = App::new(&cfg, pool(cfg.pool.clone()));
    app.delphi_topic_map_db = Some(pool(pool_limits()));
    app.delphi_topic_map_auth_db = Some(pool(auth_pool_limits()));
    app.delphi_topic_map_env = "test".into();
    app
}

pub(crate) fn get(target: &str) -> Request {
    Request {
        method: "GET".into(),
        target: target.into(),
        headers: Headers::from_raw([("host", "localhost"), ("x-forwarded-proto", "https")]),
        body: vec![],
    }
}

pub(crate) fn text(out: &Outgoing) -> String {
    String::from_utf8(bytes(out)).unwrap()
}

pub(crate) fn bytes(out: &Outgoing) -> Vec<u8> {
    match &out.body {
        Body::Fixed(bytes) => bytes.clone(),
        Body::Empty => Vec::new(),
        Body::Chunked(chunks) => chunks.concat(),
    }
}

pub(crate) fn header<'a>(out: &'a Outgoing, name: &str) -> Option<&'a str> {
    out.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[test]
fn only_this_routes_query_is_admitted() {
    let app = app();
    let p = parse(
        &app,
        &get(
            "/api/v3/delphi/topicMap?report_id=r1&job_id=j-1&source=shadow&selection=all_comments",
        ),
    )
    .unwrap();
    assert_eq!(p.request.report_id.as_deref(), Some("r1"));
    assert_eq!(p.request.job_id.as_deref(), Some("j-1"));
    assert_eq!(p.request.source, Source::Shadow);
    assert_eq!(p.request.selection, Some(Selection::AllComments));
    assert!(p.bad.is_none());
    let p = parse(&app, &get("/api/v3/delphi/topicMap?report_id=")).unwrap();
    assert_eq!(p.request, contract::Request::default());
    // A known key with a value this route does not know is a 400, not Node's.
    for (target, key) in [
        (
            "/api/v3/delphi/topicMap?report_id=r1&source=served-and-shadow",
            "source",
        ),
        (
            "/api/v3/delphi/topicMap?report_id=r1&selection=everything",
            "selection",
        ),
    ] {
        assert_eq!(
            parse(&app, &get(target)).unwrap().bad,
            Some(key),
            "{target}"
        );
    }
    for target in [
        "/api/v3/delphi/topicMap?report_id=r1&report_id=r2",
        "/api/v3/delphi/topicMap?report_id=r1&source=shadow&source=served",
        "/api/v3/delphi/topicMap?report_id=r1&section=x",
        "/api/v3/delphi/topicMap?report_id=r%2F1",
        "/api/v3/delphi/topicMap?report_id=r1&selection=participant_visible%2F1",
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

#[test]
fn who_must_be_signed_in_for_what() {
    let q = |job: Option<&str>, source, selection| contract::Request {
        report_id: Some("r".into()),
        job_id: job.map(str::to_owned),
        source,
        selection,
    };
    use Selection::*;
    use Source::*;
    for (request, expected) in [
        (q(None, Served, None), Need::Anyone),
        (q(None, Served, Some(ParticipantVisible)), Need::Anyone),
        (q(None, Served, Some(AllComments)), Need::Moderator),
        (q(None, Served, Some(AllButModeratedOut)), Need::Moderator),
        // Ruled public: a past run's map (made under the participants' rule,
        // checked once its job is read) is as public as the current one.
        (q(Some("j"), Served, None), Need::Anyone),
        (q(None, Shadow, None), Need::SiteAdministrator),
        (q(Some("j"), Shadow, None), Need::SiteAdministrator),
        (q(None, Shadow, Some(AllComments)), Need::SiteAdministrator),
    ] {
        assert_eq!(need(&request), expected, "{request:?}");
    }
    // The ruling this waits on is one constant.
    const { assert!(PUBLIC_RUN_HISTORY) };
}

#[test]
fn if_none_match_names_stored_digests_only() {
    let sha = "a".repeat(64);
    let mut req = get("/api/v3/delphi/topicMap?report_id=r1");
    let raw = format!(
        r#"W/"{sha}", "{}", "not-a-digest", W/"{}""#,
        "b".repeat(64),
        "C".repeat(64)
    );
    req.headers = Headers::from_raw([("if-none-match", raw.as_str())]);
    assert_eq!(client_tags(&req), vec![sha, "b".repeat(64)]);
    req.headers = Headers::from_raw([("if-none-match", "*")]);
    assert_eq!(client_tags(&req), vec!["*".to_owned()]);
    let many = (0..20)
        .map(|_| format!("\"{}\"", "d".repeat(64)))
        .collect::<Vec<_>>()
        .join(",");
    req.headers = Headers::from_raw([("if-none-match", many.as_str())]);
    assert_eq!(client_tags(&req).len(), 8);
}

#[test]
fn places_are_taken_without_waiting_and_freed_when_the_last_holder_ends() {
    let state = State::new(2);
    let a = state.admit().unwrap();
    let a_copy = a.clone();
    let _b = state.admit().unwrap();
    assert!(state.admit().is_none(), "no third place");
    assert_eq!(state.busy(), 1);
    drop(a);
    assert!(state.admit().is_none(), "the copy still holds the place");
    drop(a_copy);
    assert!(state.admit().is_some());
    assert_eq!(state.max_in_flight(), 2);
    let held = state.hold(1000);
    assert_eq!(state.max_held(), 1000);
    drop(held);
    assert_eq!(state.0.held.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_full_route_sheds_before_it_reads_and_says_so() {
    let mut app = app();
    app.delphi_topic_map = State::new(0);
    let app = Arc::new(app);
    #[cfg(feature = "db-tests")]
    let pool = app.delphi_topic_map_db.clone().unwrap();
    let out = crate::dispatch(
        app.clone(),
        None,
        get("/api/v3/delphi/topicMap?report_id=r1"),
    )
    .await;
    assert_eq!(out.status, 503);
    assert_eq!(header(&out, "Retry-After"), Some("1"));
    assert_eq!(header(&out, "Cache-Control"), Some("no-store"));
    assert_eq!(
        text(&out),
        r#"{"status":"error","message":"polis_err_topic_map_busy"}"#
    );
    #[cfg(feature = "db-tests")]
    assert_eq!(pool.evidence.snapshot(), [0; 6], "nothing was read");
    // Answered by polis-api, not handed to Node.
    assert_eq!(app.delphi_topic_map_served.load(Ordering::Relaxed), 1);
    assert_eq!(app.delphi_topic_map_fallback.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn refusals_that_need_no_read_are_answered_before_one() {
    let app = Arc::new(app());
    #[cfg(feature = "db-tests")]
    let pool = app.delphi_topic_map_db.clone().unwrap();
    for (target, status, body) in [
        (
            "/api/v3/delphi/topicMap",
            400,
            r#"{"status":"error","message":"report_id is required"}"#,
        ),
        (
            "/api/v3/delphi/topicMap?report_id=r1&source=elsewhere",
            400,
            r#"{"status":"error","message":"polis_err_topic_map_parameter","parameter":"source"}"#,
        ),
        (
            "/api/v3/delphi/topicMap?report_id=r1&job_id=00000000-0000-4000-8000-000000000001&selection=all_comments",
            400,
            r#"{"status":"error","message":"polis_err_topic_map_parameter","parameter":"selection"}"#,
        ),
        // No shadow configured.
        (
            "/api/v3/delphi/topicMap?report_id=r1&source=shadow",
            404,
            r#"{"status":"error","message":"polis_err_topic_map_no_source"}"#,
        ),
    ] {
        let out = crate::dispatch(app.clone(), None, get(target)).await;
        assert_eq!(out.status, status, "{target}");
        assert_eq!(text(&out), body, "{target}");
    }
    #[cfg(feature = "db-tests")]
    assert_eq!(pool.evidence.snapshot()[0], 0, "nothing was read");
    // A database that does not answer is the route shedding its load
    // (503, try again), never Node's 404 for "no such map".
    let out = crate::dispatch(app, None, get("/api/v3/delphi/topicMap?report_id=r1")).await;
    assert_eq!((out.status, header(&out, "Retry-After")), (503, Some("1")));
}

#[test]
fn stored_bytes_are_sent_as_they_are() {
    let req = get("/api/v3/delphi/topicMap?report_id=r1");
    let etag = format!("W/\"{}\"", "e".repeat(64));
    let gz = vec![0x1f, 0x8b, 8, 0, 1, 2, 3];
    let out = route::stored_json(
        &req,
        route::res_for_tests(200),
        Some(gz.clone()),
        true,
        &etag,
        false,
    );
    assert_eq!(out.status, 200);
    assert_eq!(header(&out, "Content-Encoding"), Some("gzip"));
    assert_eq!(header(&out, "Content-Length"), Some("7"));
    assert_eq!(header(&out, "ETag"), Some(etag.as_str()));
    assert_eq!(header(&out, "Vary"), Some("Accept-Encoding"));
    assert_eq!(
        header(&out, "Content-Type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(bytes(&out), gz, "the stored bytes, not compressed again");
    // A large document to a client that takes deflate only: still as stored,
    // never compressed here.
    let mut deflate = get("/api/v3/delphi/topicMap?report_id=r1");
    deflate.headers = Headers::from_raw([("accept-encoding", "deflate")]);
    assert!(!route::negotiate_gzip(&deflate));
    let doc = document(400, "j").into_bytes();
    let out = route::stored_json(
        &deflate,
        route::res_for_tests(200),
        Some(doc.clone()),
        false,
        &etag,
        true,
    );
    assert_eq!(header(&out, "Content-Encoding"), None);
    assert_eq!(header(&out, "Vary"), Some("Authorization, Accept-Encoding"));
    assert_eq!(bytes(&out), doc);
    let out = route::stored_json(&req, route::res_for_tests(200), None, true, &etag, false);
    assert_eq!(out.status, 304);
    assert!(matches!(out.body, Body::Empty));
    assert_eq!(header(&out, "ETag"), Some(etag.as_str()));
    let mut gzip = get("/api/v3/delphi/topicMap?report_id=r1");
    gzip.headers = Headers::from_raw([("accept-encoding", "gzip, deflate, br")]);
    assert!(route::negotiate_gzip(&gzip));
    gzip.method = "HEAD".into();
    assert!(
        !route::negotiate_gzip(&gzip),
        "HEAD reads the document's length"
    );
}

#[test]
fn a_stored_family_is_checked_against_its_digest_and_its_gzip() {
    use sha2::{Digest, Sha256};
    let doc = document(300, "j").into_bytes();
    let sha: String = Sha256::digest(&doc)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let gz = crate::compress::gzip(&doc).unwrap();
    assert!(stored_parts_agree(&doc, &gz, &sha));
    // A digest of the right shape that is not the document's.
    assert!(!stored_parts_agree(&doc, &gz, &"0".repeat(64)));
    // A gzip of another document, a cut gzip, and a gzip that is not one.
    let other = crate::compress::gzip(&document(301, "j").into_bytes()).unwrap();
    assert!(!stored_parts_agree(&doc, &other, &sha));
    assert!(!stored_parts_agree(&doc, &gz[..gz.len() - 9], &sha));
    assert!(!stored_parts_agree(&doc, &doc, &sha));
    // A gzip with a name field (as other writers make them) still reads.
    let mut named = vec![0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3];
    named.extend_from_slice(b"map.json\0");
    named.extend_from_slice(&gz[10..]);
    assert!(stored_parts_agree(&doc, &named, &sha));
}

#[test]
fn the_test_document_is_the_contracts() {
    let doc: contract::TopicMap = serde_json::from_str(&document(3, "j")).unwrap();
    assert_eq!(doc.schema, contract::SCHEMA);
    assert_eq!(doc.points.id.len(), 3);
    assert!(doc.points.text.is_empty());
}

/// The longest a 1 ms timer on this runtime waited past its time while
/// `work` ran: what the runtime's own thread was kept from doing.
#[cfg(feature = "db-tests")]
pub(crate) async fn lateness<F: std::future::Future>(work: F) -> (F::Output, Duration) {
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worst = Arc::new(std::sync::Mutex::new(Duration::ZERO));
    let ticker = tokio::spawn({
        let (stop, worst) = (stop.clone(), worst.clone());
        async move {
            while !stop.load(Ordering::SeqCst) {
                let start = std::time::Instant::now();
                tokio::time::sleep(Duration::from_millis(1)).await;
                let late = start.elapsed().saturating_sub(Duration::from_millis(1));
                let mut w = worst.lock().unwrap();
                *w = (*w).max(late);
            }
        }
    });
    tokio::task::yield_now().await;
    let out = work.await;
    stop.store(true, Ordering::SeqCst);
    ticker.await.unwrap();
    let worst = *worst.lock().unwrap();
    (out, worst)
}

#[cfg(feature = "db-tests")]
#[path = "delphi_topic_map_database_tests.rs"]
pub(crate) mod database_tests;
