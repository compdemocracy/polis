//! The report topic map route without a database: what it admits, the ETags
//! it reads, the places it sheds on, and the
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
    assert_eq!(p.request.source, Some(Source::Shadow));
    assert_eq!(p.request.selection, Some(Selection::AllComments));
    assert!(p.bad.is_none());
    let p = parse(&app, &get("/api/v3/delphi/topicMap?report_id=")).unwrap();
    assert_eq!(p.request, contract::Request::default());
    // A query that names no source is not one that names `served`.
    let p = parse(&app, &get("/api/v3/delphi/topicMap?report_id=r1")).unwrap();
    assert_eq!(p.request.source, None);
    let p = parse(
        &app,
        &get("/api/v3/delphi/topicMap?report_id=r1&source=served"),
    )
    .unwrap();
    assert_eq!(p.request.source, Some(Source::Served));
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

/// The stored gzip is served as `Content-Encoding: gzip`, so it is certified
/// only when a conforming decoder would accept it: one whole member, every
/// checksum right, no reserved flag, nothing after it.
#[test]
fn a_stored_topic_map_gzip_is_one_whole_valid_member() {
    use sha2::{Digest, Sha256};
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926, "the RFC 1952 CRC-32");
    let doc = document(300, "j").into_bytes();
    let sha: String = Sha256::digest(&doc)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let gz = crate::compress::gzip(&doc).unwrap();
    let n = gz.len();
    assert!(stored_parts_agree(&doc, &gz, &sha));
    let refused = |bytes: &[u8], why: &str| {
        assert!(gunzip(bytes, doc.len()).is_none(), "{why}");
        assert!(!stored_parts_agree(&doc, bytes, &sha), "{why}");
    };
    // The trailer's CRC-32 (one bit of its first and last byte) and length.
    for at in [n - 8, n - 5] {
        let mut bad = gz.clone();
        bad[at] ^= 1;
        refused(&bad, "a wrong trailer CRC");
    }
    let mut bad = gz.clone();
    bad[n - 4] ^= 1;
    refused(&bad, "a wrong trailer length");
    // Reserved flag bits.
    for bit in [0x20, 0x40, 0x80] {
        let mut bad = gz.clone();
        bad[3] |= bit;
        refused(&bad, "a reserved flag");
    }
    // A header checksum: read when right, refused when wrong.
    let mut header = gz[..10].to_vec();
    header[3] |= 2;
    let check = (crc32(&header) as u16).to_le_bytes();
    let with_check = [&header[..], &check, &gz[10..]].concat();
    assert!(
        stored_parts_agree(&doc, &with_check, &sha),
        "a right header CRC"
    );
    let mut bad = with_check.clone();
    bad[10] ^= 1;
    refused(&bad, "a wrong header CRC");
    // An extra field longer than the member.
    let mut extra = gz[..10].to_vec();
    extra[3] |= 4;
    extra.extend_from_slice(&[0xff, 0xff]);
    extra.extend_from_slice(&gz[10..]);
    refused(&extra, "an extra field past the end");
    // Anything after the member: a byte, a second member, or bytes between
    // the DEFLATE stream's end and the trailer.
    refused(&[&gz[..], &[0]].concat(), "a byte after the member");
    let empty = crate::compress::gzip(b"").unwrap();
    refused(&[&gz[..], &empty[..]].concat(), "a second member");
    refused(
        &[&gz[..n - 8], &[0], &gz[n - 8..]].concat(),
        "bytes between the stream and its trailer",
    );
    // Data longer than the limit, whatever its trailer says.
    let longer = crate::compress::gzip(&[&doc[..], b" "].concat()).unwrap();
    assert!(gunzip(&longer, doc.len()).is_none(), "over the limit");
}

/// A runtime whose one blocking thread is taken until the returned sender is
/// sent to, so a check given to it waits in the queue.
fn topic_map_runtime_with_its_blocking_thread_taken() -> (
    tokio::runtime::Runtime,
    std::sync::mpsc::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let (started, ready) = tokio::sync::oneshot::channel();
    let blocker = {
        let _runtime = rt.enter();
        tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            let _ = wait.recv();
        })
    };
    rt.block_on(ready).unwrap();
    (rt, release, blocker)
}

/// A family to check: its parts, counted as a first read counts them.
fn topic_map_unverified(state: &State, key: &str) -> (Unverified, usize) {
    use sha2::{Digest, Sha256};
    let document = document(300, "j").into_bytes();
    let gzip = crate::compress::gzip(&document).unwrap();
    let sha = Sha256::digest(&document)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let bytes = document.len() + gzip.len();
    let u = Unverified {
        key: key.to_owned(),
        job: "j".into(),
        scope: None,
        sha,
        document,
        gzip,
        held: state.hold(bytes),
        send_gzip: false,
        matched: false,
    };
    (u, bytes)
}

fn topic_map_held(state: &State) -> usize {
    state.0.held.load(Ordering::SeqCst)
}

fn topic_map_in_flight(state: &State) -> usize {
    state.0.in_flight.load(Ordering::SeqCst)
}

/// A check that waits behind a busy blocking pool keeps its place, its
/// bytes' count and the checker's permit the whole time it waits, and hands
/// the count of the bytes it answers with on to the answer.
#[test]
fn topic_map_check_queued_behind_the_blocking_pool_keeps_its_bounds() {
    let (rt, release, blocker) = topic_map_runtime_with_its_blocking_thread_taken();
    rt.block_on(async {
        let state = State::new(MAX_IN_FLIGHT);
        let request = state.admit().unwrap();
        let (u, bytes) = topic_map_unverified(&state, "queued");
        let copy = state.clone();
        let task = tokio::spawn(async move {
            let out = verify(&copy, u, request.clone()).await;
            drop(request);
            out
        });
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(state.0.checking.available_permits(), 0);
            assert_eq!(topic_map_in_flight(&state), 1);
            assert_eq!(topic_map_held(&state), bytes);
            assert_eq!(state.checked(), 0);
        }
        release.send(()).unwrap();
        blocker.await.unwrap();
        let Ok(Ok(Found::Map {
            body: Some((body, held)),
            ..
        })) = task.await
        else {
            panic!("the queued check answers the map");
        };
        assert_eq!(body, document(300, "j").into_bytes());
        assert_eq!(state.checked(), 1);
        assert_eq!(state.0.checking.available_permits(), 1);
        assert_eq!(topic_map_in_flight(&state), 0, "the request has ended");
        assert_eq!(topic_map_held(&state), body.len(), "the answer's bytes");
        drop(held);
        assert_eq!(topic_map_held(&state), 0);
    });
}

/// A request that gives up (the route's deadline drops its future) while its
/// check is queued frees none of the three bounds until the detached check
/// has run and dropped its bytes: with the other places taken, a fifth
/// request is shed, and no other family can be checked, until then.
#[test]
fn topic_map_check_given_up_keeps_its_bounds_until_the_detached_check_ends() {
    let (rt, release, blocker) = topic_map_runtime_with_its_blocking_thread_taken();
    rt.block_on(async {
        let state = State::new(MAX_IN_FLIGHT);
        let others: Vec<Place> = (1..MAX_IN_FLIGHT).map(|_| state.admit().unwrap()).collect();
        let request = state.admit().unwrap();
        let (u, bytes) = topic_map_unverified(&state, "given-up");
        let copy = state.clone();
        let gave_up = tokio::spawn(async move {
            let check = verify(&copy, u, request.clone());
            let out = tokio::time::timeout(Duration::from_millis(50), check).await;
            drop(request);
            out.is_err()
        })
        .await
        .unwrap();
        assert!(gave_up, "the waiter was dropped at its deadline");
        for _ in 0..4 {
            assert_eq!(
                topic_map_in_flight(&state),
                MAX_IN_FLIGHT,
                "the detached check's place"
            );
            assert_eq!(topic_map_held(&state), bytes, "its bytes");
            assert_eq!(state.0.checking.available_permits(), 0, "the checker");
            assert!(state.admit().is_none(), "a fifth request is shed");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // The blocking thread is free: the detached check runs, ends and
        // drops everything it held, and only then do the bounds come back.
        release.send(()).unwrap();
        blocker.await.unwrap();
        for _ in 0..400 {
            if topic_map_in_flight(&state) < MAX_IN_FLIGHT {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(topic_map_in_flight(&state), MAX_IN_FLIGHT - 1);
        assert_eq!(topic_map_held(&state), 0);
        assert_eq!(state.0.checking.available_permits(), 1);
        assert!(state.admit().is_some(), "the next request is admitted");
        drop(others);
    });
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

/// A map of two levels and five comments (ids 10 to 14): at the finer level
/// topics 0_0 {10, 11}, 0_1 {12, 13} and 0_2 {14}; at the coarser 1_0 {10, 11,
/// 12} and 1_1 {13, 14}. Comment 14 is the only member of 0_2, whose name is
/// its words.
pub(crate) fn small_map() -> String {
    let topic = |id: &str,
                 level: u32,
                 cluster: i64,
                 name: &str,
                 count: u64,
                 parent: Option<(&str, f64)>| {
        serde_json::json!({"id": id, "level": level, "cluster": cluster, "key": null, "name": name,
            "count": count, "x": 0.5, "y": 0.25, "weight": (count as f64).powf(0.25),
            "parent": parent.map(|p| p.0), "parentShare": parent.map(|p| p.1),
            "color": "#dd6a94", "labelColor": "#734252", "colorAll": "#dd6a94", "labelColorAll": "#734252"})
    };
    serde_json::json!({
        "schema": "polis-topic-map/1", "title": "", "attribution": "",
        "run": {"jobId": "j", "topicModel": null, "createdAt": null},
        "bounds": [-1.0, 1.0, -1.0, 1.0], "pointRadius": 0.11,
        "levels": [{"level": 0, "topics": 3, "unclustered": 0, "cmapPalette": false},
                   {"level": 1, "topics": 2, "unclustered": 0, "cmapPalette": false}],
        "topics": [topic("0_0", 0, 0, "roads", 2, Some(("1_0", 1.0))),
                   topic("0_1", 0, 1, "schools", 2, Some(("1_0", 0.5))),
                   topic("0_2", 0, 2, "secret words", 1, Some(("1_1", 1.0))),
                   topic("1_0", 1, 0, "town", 3, None),
                   topic("1_1", 1, 1, "secret and schools", 2, None)],
        "points": {"id": [10, 11, 12, 13, 14], "x": [0.9, 0.1, 0.2, 0.3, -0.5],
                   "y": [0.0, 0.1, 0.2, 0.3, 0.4], "topic": [[0, 0, 1, 1, 2], [3, 3, 3, 4, 4]], "text": []},
        "provenance": {"schema": "polis-topic-map.provenance/1"}
    })
    .to_string()
}

#[test]
fn a_reader_receives_moderated_out_comments_as_bare_points() {
    let doc = small_map();
    let hidden = |ids: &[i64]| {
        ids.iter()
            .copied()
            .collect::<std::collections::BTreeSet<i64>>()
    };
    // Nothing of the map moderated out: the stored bytes, untouched.
    assert_eq!(public_form(doc.as_bytes(), &hidden(&[])), Ok(None));
    assert_eq!(public_form(doc.as_bytes(), &hidden(&[1, 99])), Ok(None));
    // Comments 14 and 10 moderated out.
    let form = public_form(doc.as_bytes(), &hidden(&[14, 10]))
        .unwrap()
        .unwrap();
    let raw: serde_json::Value = serde_json::from_slice(&form).unwrap();
    let out: contract::TopicMap = serde_json::from_slice(&form).unwrap();
    let p = &out.points;
    // The visible comments first, as stored; the bare points last, by position.
    assert_eq!(p.id, vec![Some(11), Some(12), Some(13), None, None]);
    assert_eq!(p.x, vec![0.1, 0.2, 0.3, -0.5, 0.9]);
    assert_eq!(p.y, vec![0.1, 0.2, 0.3, 0.4, 0.0]);
    assert_eq!(p.moderated_out, 2);
    assert_eq!(raw["points"]["moderatedOut"], 2);
    assert_eq!(raw["points"]["id"][3], serde_json::Value::Null);
    // No topic for a bare point; 0_2 had no other member and is not sent.
    let ids: Vec<&str> = out.topics.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["0_0", "0_1", "1_0", "1_1"]);
    assert!(!String::from_utf8_lossy(&form).contains("secret words"));
    assert_eq!(p.topic, vec![vec![0, 1, 1, -1, -1], vec![2, 2, 3, -1, -1]]);
    // Counted again over what this reader sees, as the generator counts.
    let counts: Vec<u64> = out.topics.iter().map(|t| t.count).collect();
    assert_eq!(counts, [1, 2, 2, 1]);
    assert_eq!(out.topics[0].weight, 1.0);
    let parents: Vec<(Option<&str>, Option<f64>)> = out
        .topics
        .iter()
        .map(|t| (t.parent.as_deref(), t.parent_share))
        .collect();
    assert_eq!(
        parents,
        [
            (Some("1_0"), Some(1.0)),
            (Some("1_0"), Some(0.5)),
            (None, None),
            (None, None)
        ]
    );
    let levels: Vec<(u64, u64)> = out
        .levels
        .iter()
        .map(|l| (l.topics, l.unclustered))
        .collect();
    assert_eq!(levels, [(2, 2), (2, 2)]);
    // A topic with a held-back member (0_0 held 10; 1_0 held 10; 1_1 held
    // 14) has the neutral name and its label over its visible members only;
    // 0_1 held none and keeps its name and place.
    let labels: Vec<(&str, f64, f64)> = out
        .topics
        .iter()
        .map(|t| (t.name.as_str(), t.x, t.y))
        .collect();
    assert_eq!(
        labels,
        [
            ("Topic 0", 0.1, 0.1),
            ("schools", 0.5, 0.25),
            ("Topic 0", 0.15, 0.15),
            ("Topic 1", 0.3, 0.3)
        ]
    );
    assert!(!String::from_utf8_lossy(&form).contains("secret"));
    // The colours are chosen again from what is sent: none is the stored one.
    for t in &out.topics {
        for c in [&t.color, &t.label_color, &t.color_all, &t.label_color_all] {
            assert!(c.len() == 7 && c.starts_with('#'), "{c}");
        }
    }
    assert_eq!(
        out.levels
            .iter()
            .map(|l| l.cmap_palette)
            .collect::<Vec<_>>(),
        [false, false]
    );
    assert_eq!(
        out.provenance,
        Some(serde_json::json!({"schema": "polis-topic-map.provenance/1"}))
    );
    // Every comment moderated out: no topic, every point bare.
    let all = public_form(doc.as_bytes(), &hidden(&[10, 11, 12, 13, 14]))
        .unwrap()
        .unwrap();
    let all: contract::TopicMap = serde_json::from_slice(&all).unwrap();
    assert!(all.topics.is_empty());
    assert_eq!(all.points.id, vec![None; 5]);
    assert_eq!(all.points.moderated_out, 5);
    assert!(all.points.topic.iter().flatten().all(|k| *k == -1));
    // Text, where a document has it: emptied for a bare point.
    let mut with_text: serde_json::Value = serde_json::from_str(&doc).unwrap();
    with_text["points"]["text"] = serde_json::json!(["a", "b", "c", "d", "e"]);
    let form = public_form(with_text.to_string().as_bytes(), &hidden(&[12]))
        .unwrap()
        .unwrap();
    let form: contract::TopicMap = serde_json::from_slice(&form).unwrap();
    assert_eq!(form.points.text, ["a", "b", "d", "e", ""]);
    // A document the closed type does not read, or whose arrays disagree, is
    // not sent to such a reader.
    let mut unknown: serde_json::Value = serde_json::from_str(&doc).unwrap();
    unknown["points"]["author"] = serde_json::json!([1, 2, 3, 4, 5]);
    assert_eq!(
        public_form(unknown.to_string().as_bytes(), &hidden(&[10])),
        Err(())
    );
    let mut short: serde_json::Value = serde_json::from_str(&doc).unwrap();
    short["points"]["x"] = serde_json::json!([0.0]);
    assert_eq!(
        public_form(short.to_string().as_bytes(), &hidden(&[10])),
        Err(())
    );
}

/// What a held-back comment leaves in the reader's form is its position and
/// nothing else: where it sat inside its topic, and the topic it alone made,
/// change no byte of what is sent.
#[test]
fn a_held_back_comment_leaves_only_its_position() {
    let hidden: std::collections::BTreeSet<i64> = [14, 10].into_iter().collect();
    let form = |doc: &serde_json::Value| {
        public_form(doc.to_string().as_bytes(), &hidden)
            .unwrap()
            .unwrap()
    };
    let doc: serde_json::Value = serde_json::from_str(&small_map()).unwrap();
    // The same map with comment 14 in no topic of its own at the finer
    // level (no 0_2 stored, other stored colours): the run's labels and
    // colours were different, the reader's form is not.
    let mut without = doc.clone();
    without["topics"].as_array_mut().unwrap().remove(2);
    without["points"]["topic"] = serde_json::json!([[0, 0, 1, 1, -1], [2, 2, 2, 3, 3]]);
    without["levels"][0]["topics"] = 2.into();
    without["levels"][0]["unclustered"] = 1.into();
    for t in without["topics"].as_array_mut().unwrap() {
        t["color"] = "#123456".into();
        t["colorAll"] = "#654321".into();
    }
    assert_eq!(form(&doc), form(&without));
    // The held-back comment of a mixed topic (1_1 holds 13 and 14) moved
    // within it: only its own position changes in what is sent, never a
    // label's place.
    let mut moved = doc.clone();
    moved["points"]["x"][4] = 0.8.into();
    let (a, b): (contract::TopicMap, contract::TopicMap) = (
        serde_json::from_slice(&form(&doc)).unwrap(),
        serde_json::from_slice(&form(&moved)).unwrap(),
    );
    let place = |m: &contract::TopicMap| {
        m.topics
            .iter()
            .map(|t| {
                (
                    t.id.clone(),
                    t.name.clone(),
                    t.x,
                    t.y,
                    t.count,
                    t.parent.clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(place(&a), place(&b));
}

#[test]
fn hmac_sha256_is_rfc_4231() {
    // RFC 4231, test case 2.
    assert_eq!(
        super::hex_of(&super::hmac_sha256(
            b"Jefe",
            b"what do ya want for nothing?"
        )),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
}

#[test]
fn a_readers_etag_names_the_form_and_the_moderation() {
    let key = State::default().validator_key().to_owned();
    let sha = "e".repeat(64);
    assert_eq!(
        reader_tag(&sha, ""),
        sha,
        "no comment held back: the stored form"
    );
    let one = reader_tag(&sha, &reader_form(&key, 7, &[3]));
    let two = reader_tag(&sha, &reader_form(&key, 7, &[3, 4]));
    assert!(is_digest(&one) && is_digest(&two));
    assert_ne!(one, sha);
    assert_ne!(one, two);
    assert_eq!(reader_form(&key, 7, &[]), "");
    assert_ne!(
        reader_tag(&"f".repeat(64), &reader_form(&key, 7, &[3])),
        one
    );
    assert_ne!(reader_tag(&sha, &reader_form(&key, 8, &[3])), one);
}

/// Someone who knows the stored digest and every comment id cannot tell
/// which comments are held back from a reader's ETag: every keyless recipe
/// over every small set of ids misses, and the same set under another
/// process's key is another tag.
#[test]
fn a_readers_etag_tells_nothing_to_someone_who_guesses_ids() {
    use sha2::{Digest, Sha256};
    let hex = |b: &[u8]| super::hex_of(b);
    let sha = "e".repeat(64);
    let zid = 7;
    let key = State::default().validator_key().to_owned();
    let tag_14 = reader_tag(&sha, &reader_form(&key, zid, &[14]));
    let tag_15 = reader_tag(&sha, &reader_form(&key, zid, &[15]));
    assert_ne!(tag_14, tag_15);
    let mut guesses = std::collections::BTreeSet::new();
    let sets: Vec<Vec<i64>> = (0..100)
        .map(|i| vec![i])
        .chain((0..30).flat_map(|i| (i + 1..30).map(move |j| vec![i, j])))
        .collect();
    for ids in &sets {
        let csv = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        for name in ["moderated-out/1", READER_FORM] {
            for inner in [
                hex(&Sha256::digest(csv.as_bytes())),
                hex(&Sha256::digest(format!("{zid}:{csv}").as_bytes())),
                // An empty or public key in place of the process's.
                hex(&super::hmac_sha256(b"", format!("{zid}:{csv}").as_bytes())),
                hex(&super::hmac_sha256(
                    sha.as_bytes(),
                    format!("{zid}:{csv}").as_bytes(),
                )),
            ] {
                guesses.insert(reader_tag(&sha, &format!(":{name}:{inner}")));
            }
        }
    }
    assert!(!guesses.contains(&tag_14) && !guesses.contains(&tag_15));
    // Another process draws another key.
    let other = State::default().validator_key().to_owned();
    assert_ne!(key, other);
    assert_ne!(tag_14, reader_tag(&sha, &reader_form(&other, zid, &[14])));
    // The tag's bits look like any digest's: about half of them set, over
    // many held-back sets.
    let ones: u32 = (0..200)
        .map(|i| {
            let t = reader_tag(&sha, &reader_form(&key, zid, &[i]));
            t.chars()
                .map(|c| c.to_digit(16).unwrap().count_ones())
                .sum::<u32>()
        })
        .sum();
    let bits = 200 * 256;
    assert!(
        (ones as f64 / bits as f64 - 0.5).abs() < 0.02,
        "{ones} of {bits}"
    );
}

/// The cost of the reader's form of a large map: 9,000 comments over four
/// levels, half of them moderated out. Run on its own, it prints.
#[test]
#[ignore]
fn the_readers_form_of_a_large_map_is_timed() {
    let n = 9000usize;
    let levels = 4usize;
    let mut topics = Vec::new();
    let mut rows = Vec::new();
    let per = [300usize, 100, 30, 10];
    for (l, k) in per.iter().enumerate().take(levels) {
        for c in 0..*k {
            topics.push(serde_json::json!({"id": format!("{l}_{c}"), "level": l, "cluster": c,
                "key": null, "name": format!("keyword{c} other{c} third{c}"), "count": n / k,
                "x": 0.12345, "y": -1.23456, "weight": 2.5, "parent": null, "parentShare": null,
                "color": "#dd6a94", "labelColor": "#734252", "colorAll": "#dd6a94", "labelColorAll": "#734252"}));
        }
        let first: usize = per[..l].iter().sum();
        rows.push((0..n).map(|i| (first + i % k) as i64).collect::<Vec<_>>());
    }
    let doc = serde_json::json!({
        "schema": "polis-topic-map/1", "title": "", "attribution": "",
        "run": {"jobId": "j", "topicModel": null, "createdAt": null},
        "bounds": [-6.5, 6.5, -4.25, 4.25], "pointRadius": 0.11,
        "levels": (0..levels).map(|l| serde_json::json!({"level": l, "topics": per[l], "unclustered": 0, "cmapPalette": per[l] > 50})).collect::<Vec<_>>(),
        "topics": topics,
        "points": {"id": (0..n).collect::<Vec<_>>(),
                   "x": (0..n).map(|i| ((i * 7919) % 100_000) as f64 / 7919.0 - 6.31234).collect::<Vec<_>>(),
                   "y": (0..n).map(|i| ((i * 104_729) % 100_000) as f64 / 11_731.0 - 4.12345).collect::<Vec<_>>(),
                   "topic": rows, "text": []},
    })
    .to_string();
    let gz = crate::compress::node_stream(doc.as_bytes(), true)
        .unwrap()
        .concat();
    let hidden: std::collections::BTreeSet<i64> = (0..n as i64).filter(|i| i % 2 == 0).collect();
    let rounds = 20;
    let start = std::time::Instant::now();
    let mut out = 0;
    for _ in 0..rounds {
        let d = gunzip(&gz, MAX_PART_BYTES as usize).unwrap();
        let form = public_form(&d, &hidden).unwrap().unwrap();
        out = crate::compress::node_stream(&form, true)
            .unwrap()
            .concat()
            .len();
    }
    let each = start.elapsed() / rounds;
    let start = std::time::Instant::now();
    for _ in 0..rounds {
        public_form(doc.as_bytes(), &hidden).unwrap().unwrap();
    }
    let form_only = start.elapsed() / rounds;
    println!(
        "document {} bytes, gzip {} bytes, reader's gzip {out} bytes; gunzip+form+gzip {each:?} each, form alone {form_only:?} each",
        doc.len(),
        gz.len()
    );
}

/// The kept readers' forms stay within both bounds, least recently kept out
/// first, and a form larger than the byte bound is not kept at all.
#[test]
fn kept_readers_forms_stay_within_their_bounds() {
    use super::{Forms, Kept, READER_FORM_BYTES_KEPT, READER_FORMS_KEPT};
    let form = |n: usize| {
        Arc::new(Kept::Form {
            plain: vec![b'x'; n],
            gzip: vec![b'z'; n / 4],
        })
    };
    let key = |i: usize| (format!("{i:064x}"), format!(":held-back/2:{i}"));
    let mut forms = Forms::default();
    for i in 0..READER_FORMS_KEPT * 2 {
        forms.keep(key(i), form(1000));
        assert!(forms.kept.len() <= READER_FORMS_KEPT);
    }
    assert_eq!(forms.kept.front().unwrap().0, key(READER_FORMS_KEPT));
    assert_eq!(forms.bytes, READER_FORMS_KEPT * 1250);
    let big = READER_FORM_BYTES_KEPT / 3;
    for i in 0..5 {
        forms.keep(key(1000 + i), form(big));
        assert!(forms.bytes <= READER_FORM_BYTES_KEPT, "{}", forms.bytes);
    }
    assert_eq!(forms.kept.len(), 2, "two of a third and their gzip fit");
    forms.keep(key(2000), form(READER_FORM_BYTES_KEPT));
    assert!(forms.kept.iter().all(|(k, _)| *k != key(2000)));
    let total: usize = forms.kept.iter().map(|(_, k)| k.bytes()).sum();
    assert_eq!(total, forms.bytes);
}

/// The rewrites' budget: a quiet process may spend its burst at once, then
/// waits for the share to repay what it spent past it.
#[test]
fn the_rewrites_budget_repays_what_it_spends() {
    use super::{REWRITE_BURST, REWRITE_SHARE, State};
    let state = State::default();
    assert_eq!(state.budget_wait(), Duration::ZERO);
    // Spending the burst and one second's share more: about a second to wait.
    let wait = state.spend(REWRITE_BURST + REWRITE_SHARE);
    assert!(
        wait > Duration::from_millis(900) && wait <= Duration::from_secs(1),
        "{wait:?}"
    );
    assert!(state.budget_wait() > Duration::from_millis(900));
}

/// A `polis-topic-map/1` document of `points` comments in four levels of
/// 300, 100, 30 and 10 topics (the costly shape for a reader's form: every
/// topic of every level is recoloured from what the reader may see), without
/// text, valid for the contract's closed types. `seed` moves the positions,
/// so two documents of the same size are different maps.
pub(crate) fn layered_document(points: usize, job: &str, seed: usize) -> String {
    let per = [300usize, 100, 30, 10];
    let mut topics = Vec::new();
    let mut rows = Vec::new();
    for (l, k) in per.iter().enumerate() {
        for c in 0..*k {
            topics.push(serde_json::json!({"id": format!("{l}_{c}"), "level": l, "cluster": c,
                "key": null, "name": format!("keyword{c} other{c} third{c}"), "count": points / k,
                "x": 0.12345, "y": -1.23456, "weight": 2.5, "parent": null, "parentShare": null,
                "color": "#dd6a94", "labelColor": "#734252", "colorAll": "#dd6a94", "labelColorAll": "#734252"}));
        }
        rows.push((0..points).map(|i| (i % k) as i64).collect::<Vec<_>>());
    }
    serde_json::json!({
        "schema": "polis-topic-map/1", "title": "", "attribution": "",
        "run": {"jobId": job, "topicModel": null, "createdAt": null},
        "bounds": [-6.5, 6.5, -4.25, 4.25], "pointRadius": 0.11,
        "levels": (0..per.len()).map(|l| serde_json::json!({"level": l, "topics": per[l], "unclustered": 0, "cmapPalette": per[l] > 50})).collect::<Vec<_>>(),
        "topics": topics,
        "points": {"id": (0..points).collect::<Vec<_>>(),
                   "x": (0..points).map(|i| (((i + seed) * 7919) % 100_000) as f64 / 7919.0 - 6.31234).collect::<Vec<_>>(),
                   "y": (0..points).map(|i| (((i + seed) * 104_729) % 100_000) as f64 / 11_731.0 - 4.12345).collect::<Vec<_>>(),
                   "topic": rows, "text": []},
    })
    .to_string()
}

/// Distinct costly maps all asking for their reader's form at once, from a
/// quiet process: the rewrites run one at a time, each charged before it
/// starts, and the rewrite time spent stays within the burst plus the share
/// of the time since the first asked, plus what the rewrites took beyond
/// their charges, which is at most the first rewrite's own time (the one
/// made before the process had timed any).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_of_distinct_maps_stays_within_the_rewrites_budget() {
    use super::{MAX_REWRITES, REWRITE_BURST, REWRITE_SHARE, State, reader_body};
    const MAPS: usize = 6;
    let state = State::new(MAPS);
    let hidden: Vec<i64> = (0..9_000).filter(|i| i % 2 == 0).collect();
    let parts: Vec<Vec<u8>> = (0..MAPS)
        .map(|m| {
            let doc = layered_document(9_000, "burst", m * 13);
            crate::compress::node_stream(doc.as_bytes(), true)
                .unwrap()
                .concat()
        })
        .collect();
    let started = std::time::Instant::now();
    let asked: Vec<_> = parts
        .into_iter()
        .enumerate()
        .map(|(m, part)| {
            let (state, hidden) = (state.clone(), hidden.clone());
            tokio::spawn(async move {
                let place = state.admit().expect("a place each");
                let held = state.hold(part.len());
                let key = (format!("{m:064x}"), format!(":held-back/2:{m}"));
                let out = reader_body(&state, key, part, held, hidden, true, place).await;
                (out.is_ok(), std::time::Instant::now())
            })
        })
        .collect();
    let mut last = started;
    for a in asked {
        let (ok, at) = a.await.unwrap();
        assert!(ok, "every form was made");
        last = last.max(at);
    }
    let window = (last - started).as_secs_f64();
    let (charged, overrun) = state.rewrite_time();
    println!(
        "{MAPS} layered maps at once: rewrite time {charged:.3} s ({overrun:.3} s beyond charges) over {window:.3} s; bound {:.3} s",
        REWRITE_BURST.as_secs_f64() + REWRITE_SHARE.as_secs_f64() * window + overrun
    );
    assert_eq!(state.rewrites(), MAPS as u64);
    assert!(state.max_rewriting() <= MAX_REWRITES);
    assert!(
        charged
            <= REWRITE_BURST.as_secs_f64() + REWRITE_SHARE.as_secs_f64() * window + overrun + 1e-6,
        "rewrite time {charged:.3} s over {window:.3} s"
    );
    // Beyond the charges by at most one rewrite's time: the estimate after
    // the first is the slowest rate seen, with headroom.
    assert!(
        overrun <= charged / MAPS as f64 * 2.0,
        "the rewrites took {overrun:.3} s beyond their charges of {charged:.3} s in all"
    );
}
