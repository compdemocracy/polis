//! One shadow listener, two mirrored routes. A copy of a vote and a copy of a
//! comment each go to their own observer through their own lane (its own
//! bound on observations in flight, its own bound on waiting read-backs, its
//! own rate bucket) and their own two read-only pools. These tests hold the
//! table that sends each copy to its route, that the vote observer's line and
//! health are what they were before a second route existed, and that a flood
//! on either lane leaves the other lane's observations unchanged in count,
//! outcome and timing class.
//!
//! Every fixture vote is written through `append`, the vote writer's own
//! sign-aware path.
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[cfg(feature = "db-tests")]
use super::database::{Database, actor};
use super::*;
use crate::post_comments::observe::tests as comments;
use crate::{shadow, votes::VoteChoice};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

/// The vote observation line's key set, in its printed order, as it was
/// before the shadow served a second route.
const VOTE_LINE_KEYS: &[&str] = &[
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

/// The keys of the shadow's /health as the deploy validator reads them, in
/// their printed order, before the shadow served a second route.
const HEALTH_KEYS: &[&str] = &["role", "status", "version", "commit", "postVotes", "shadow"];
const HEALTH_VOTE_KEYS: &[&str] = &[
    "enabled",
    "mode",
    "observed",
    "wouldServe",
    "wouldHandBack",
    "wouldFail",
    "shed",
    "notObserved",
    "readbackSame",
    "readbackAmbiguous",
    "readbackDifferent",
    "readbackAbsent",
    "pools",
];
const HEALTH_LANE_KEYS: &[&str] = &[
    "listening",
    "address",
    "inFlight",
    "capacity",
    "maxPerSecond",
    "readbackWaiting",
    "headRefused",
    "bodyUnread",
];

struct Signing {
    public: Vec<u8>,
    private: EncodingKey,
}

fn signing() -> Signing {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Signing {
        public: rsa.public_key_to_pem().unwrap(),
        private: EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
    }
}

/// The participant of the fixture conversation: uid 1, pid 0.
fn token(keys: &Signing) -> String {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    encode(
        &Header::new(Algorithm::RS256),
        &json!({
            "uid":1,"pid":0,"conversation_id":"2fixture","sub":"anon:1",
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,
            "anonymous_participant":true
        }),
        &keys.private,
    )
    .unwrap()
}

fn request_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn vote_body(tid: i32, choice: VoteChoice) -> String {
    json!({"conversation_id": "2fixture", "tid": tid, "vote": choice.wire()}).to_string()
}

fn comment_body(text: &str) -> String {
    json!({"conversation_id": "2fixture", "txt": text, "vote": VoteChoice::Agree.wire(), "pid": 0})
        .to_string()
}

/// A request as nginx's mirror sends it: `shadow` is the selector name in
/// `X-Polis-Shadow`, when there is one.
fn mirrored(
    method: &str,
    path: &str,
    shadow: Option<&str>,
    body: &str,
    token: Option<&str>,
    id: &str,
) -> Request {
    let authorization = token.map(|token| format!("Bearer {token}"));
    let mut headers = vec![
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", id),
    ];
    if let Some(shadow) = shadow {
        headers.push(("x-polis-shadow", shadow));
    }
    if let Some(authorization) = authorization.as_deref() {
        headers.push(("authorization", authorization));
    }
    Request {
        method: method.into(),
        target: path.into(),
        headers: crate::http::Headers::from_raw(headers),
        body: body.as_bytes().to_vec(),
    }
}

fn vote_copy(body: &str, token: Option<&str>, id: &str) -> Request {
    mirrored("POST", PATH, Some("votesShadow"), body, token, id)
}

fn cfg() -> config::Config {
    config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: read_limits(),
    }
}

fn closed() -> Connector {
    Connector::Plain(Box::new("postgresql://u@127.0.0.1:1/d".parse().unwrap()))
}

fn vote_observer(connector: impl Fn() -> Connector, public: &[u8]) -> Observer {
    let mut observer = Observer::new(
        participant::Verifier::new(public, "fixture", "fixture").unwrap(),
        db::Pool::new(connector(), read_limits()),
        db::Pool::new(connector(), observe::readback_limits()),
        vec![],
        Arc::default(),
    );
    observer.timing = observe::ReadbackTiming {
        first: Duration::from_millis(50),
        retry: Duration::from_millis(150),
    };
    observer
}

/// A shadow process's state with either observer, both or neither.
fn shadow_app(
    connector: impl Fn() -> Connector,
    public: &[u8],
    votes: bool,
    comments: bool,
    comments_per_second: u32,
) -> Arc<App> {
    let mut app = App::new(&cfg(), db::Pool::new(connector(), read_limits()));
    if votes {
        app.post_votes_observe = Some(vote_observer(&connector, public));
    }
    if comments {
        app.post_comments_observe = Some(comments::observer_with(
            connector(),
            connector(),
            public,
            vec![],
            comments_per_second,
        ));
    }
    Arc::new(app)
}

/// The keys of a printed object in their printed order.
fn printed_keys(line: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(line).unwrap();
    let mut keys: Vec<(usize, String)> = value
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (line.find(&format!("\"{key}\":")).unwrap(), key.clone()))
        .collect();
    keys.sort();
    keys.into_iter().map(|(_, key)| key).collect()
}

fn printed_vote_line(id: &str) -> Option<String> {
    let marker = format!("\"request_id\":\"{id}\"");
    shadow::recorded()
        .into_iter()
        .find(|line| line.contains(&marker) && line.contains("\"shadow_observation\""))
}

fn printed_comment_line(id: &str) -> Option<String> {
    let marker = format!("\"request_id\":\"{id}\"");
    shadow::comments::recorded()
        .into_iter()
        .find(|line| line.contains(&marker))
}

/// A vote copy's line, with the vote line's own contract: its keys in their
/// order, its selector name and route.
async fn vote_line(id: &str) -> Value {
    let printed = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(line) = printed_vote_line(id) {
                return line;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no vote observation line for {id}"));
    assert_eq!(printed_keys(&printed), VOTE_LINE_KEYS, "{printed}");
    let line: Value = serde_json::from_str(&printed).unwrap();
    assert_eq!(line["shadow"], "votesShadow");
    assert_eq!(line["route"], "POST /api/v3/votes");
    line
}

fn health_body(out: Outgoing) -> String {
    let crate::http::Body::Fixed(bytes) = out.body else {
        panic!("fixed JSON expected")
    };
    String::from_utf8(bytes).unwrap()
}

/// The table: a copy is one route's when its path and its selector name are
/// both that route's, and each such copy is observed by its own observer and
/// no other. Anything else is not a copy: 404, and no line.
#[tokio::test]
async fn each_copy_goes_to_its_own_route_and_no_other() {
    let keys = signing();
    let lane = shadow::Lane::new(1000);
    let both = shadow_app(closed, &keys.public, true, true, 1000);
    let vote = vote_body(3, VoteChoice::Agree);
    let comment = comment_body("Generated routed comment");
    // A vote copy: the vote observer's line, and nothing from the comment's.
    let id = request_id();
    let out = shadow::accept(both.clone(), lane.clone(), vote_copy(&vote, None, &id)).await;
    assert_eq!(out.status, 204);
    let line = vote_line(&id).await;
    assert_eq!(line["outcome"], "would_hand_back");
    assert_eq!(line["reason"], "no_token");
    assert!(printed_comment_line(&id).is_none());
    // A comment copy: the comment observer's line, and nothing from the vote's.
    let id = request_id();
    let out = shadow::accept(
        both.clone(),
        lane.clone(),
        comments::copy(&comment, None, &id),
    )
    .await;
    assert_eq!(out.status, 204);
    let line = comments::observation(&id).await;
    assert_eq!(line["shadow"], "commentsShadow");
    assert_eq!(line["route"], "POST /api/v3/comments");
    assert_eq!(line["outcome"], "would_hand_back");
    assert_eq!(line["reason"], "no_token");
    assert!(printed_vote_line(&id).is_none());
    // Neither lane took anything from the other.
    let comment_lane = both.post_comments_observe.as_ref().unwrap().lane.clone();
    assert_eq!((lane.in_flight(), comment_lane.in_flight()), (0, 0));
    // Not a copy of either route: the wrong name for the path, no name,
    // another method, another path.
    let comment_path = crate::post_comments::PATH;
    for (method, path, shadow_name, body) in [
        ("POST", PATH, Some("commentsShadow"), &vote),
        ("POST", comment_path, Some("votesShadow"), &comment),
        ("POST", PATH, None, &vote),
        ("POST", comment_path, None, &comment),
        ("POST", comment_path, Some("commentsshadow"), &comment),
        ("GET", comment_path, Some("commentsShadow"), &comment),
        ("PUT", PATH, Some("votesShadow"), &vote),
        (
            "POST",
            "/api/v3/comments-bulk",
            Some("commentsShadow"),
            &comment,
        ),
        ("POST", "/api/v3/nextComment", Some("votesShadow"), &vote),
    ] {
        let id = request_id();
        let req = mirrored(method, path, shadow_name, body, None, &id);
        let out = shadow::accept(both.clone(), lane.clone(), req).await;
        assert_eq!(out.status, 404, "{method} {path} {shadow_name:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(printed_vote_line(&id).is_none() && printed_comment_line(&id).is_none());
    }
    // The vote shadow as it runs today, with no comment observer: a comment
    // copy is not a copy of anything it serves, as before.
    let votes_only = shadow_app(closed, &keys.public, true, false, 1000);
    let id = request_id();
    let out = shadow::accept(
        votes_only.clone(),
        lane.clone(),
        comments::copy(&comment, None, &id),
    )
    .await;
    assert_eq!(out.status, 404);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(printed_vote_line(&id).is_none() && printed_comment_line(&id).is_none());
    // A process with the comment observer alone answers a vote copy as a
    // shadow without a vote observer always has: 204, not observed.
    let comments_only = shadow_app(closed, &keys.public, false, true, 1000);
    let id = request_id();
    let out = shadow::accept(comments_only, lane.clone(), vote_copy(&vote, None, &id)).await;
    assert_eq!(out.status, 204);
    let line = vote_line(&id).await;
    assert_eq!(line["outcome"], "not_observed");
    assert_eq!(line["reason"], "unconfigured");
}

/// With the comment observer built beside it, the vote observer prints the
/// line it printed before (the same keys in the same order, the same values
/// for the same copy), and /health keeps every key the deploy validator
/// reads, in place and with the same value. Without the comment observer,
/// /health has exactly the keys it had.
#[tokio::test]
async fn the_vote_line_and_health_are_unchanged_beside_a_comment_observer() {
    let keys = signing();
    let member = token(&keys);
    let mut starred: Value = serde_json::from_str(&vote_body(3, VoteChoice::Agree)).unwrap();
    starred["starred"] = json!(true);
    starred["lang"] = json!("fr");
    let cases = [
        (vote_body(3, VoteChoice::Agree), None),
        (starred.to_string(), None),
        (vote_body(5, VoteChoice::Pass), Some(member.as_str())),
        ("{\"conversation_id\":".to_owned(), Some(member.as_str())),
    ];
    let mut printed = vec![];
    for with_comments in [false, true] {
        let app = shadow_app(closed, &keys.public, true, with_comments, 1000);
        let lane = shadow::Lane::new(1000);
        let mut lines = vec![];
        for (body, token) in &cases {
            let id = request_id();
            let out = shadow::accept(app.clone(), lane.clone(), vote_copy(body, *token, &id)).await;
            assert_eq!(out.status, 204);
            let mut line = vote_line(&id).await;
            // What differs between two copies of one vote: its id and times.
            for key in ["request_id", "queue_ms", "admission_ms", "total_ms"] {
                line[key] = Value::Null;
            }
            lines.push(line);
        }
        let health = health_body(shadow::health(&app, &lane).await);
        printed.push((lines, health));
    }
    let (alone, beside) = (&printed[0], &printed[1]);
    assert_eq!(
        alone.0, beside.0,
        "the vote lines differ beside a comment observer"
    );
    assert_eq!(alone.0[0]["reason"], "no_token");
    assert_eq!(alone.0[1]["starred_present"], true);
    assert_eq!(alone.0[2]["reason"], "admission_unavailable");
    assert_eq!(alone.0[3]["reason"], "shape_json");
    // /health without the comment observer: exactly the keys it had.
    assert_eq!(printed_keys(&alone.1), HEALTH_KEYS, "{}", alone.1);
    let alone_health: Value = serde_json::from_str(&alone.1).unwrap();
    let beside_health: Value = serde_json::from_str(&beside.1).unwrap();
    for (object, expected) in [
        ("postVotes", HEALTH_VOTE_KEYS),
        ("shadow", HEALTH_LANE_KEYS),
    ] {
        let mut keys: Vec<&str> = alone_health[object]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected, "{object}");
    }
    // In their printed order, in the raw body.
    let position = |body: &str, key: &str| body.find(&format!("\"{key}\":")).unwrap();
    for keys in [HEALTH_VOTE_KEYS, HEALTH_LANE_KEYS] {
        for pair in keys.windows(2) {
            assert!(
                position(&alone.1, pair[0]) < position(&alone.1, pair[1]),
                "{pair:?}: {}",
                alone.1
            );
        }
    }
    // Beside the comment observer: one more key, after the vote observer's,
    // and every key that was there keeps its value.
    assert_eq!(
        printed_keys(&beside.1),
        [
            "role",
            "status",
            "version",
            "commit",
            "postVotes",
            "postComments",
            "shadow"
        ],
        "{}",
        beside.1
    );
    // (Two counters of the listener are the process's, and other tests of
    // this binary move them.)
    let settled = |health: &Value| {
        let mut health = health.clone();
        for key in ["headRefused", "bodyUnread"] {
            health["shadow"][key] = Value::Null;
        }
        health
    };
    for key in HEALTH_KEYS {
        assert_eq!(
            settled(&alone_health)[key],
            settled(&beside_health)[key],
            "{key}"
        );
    }
    // The first part of the body, up to the vote observer's own object, is
    // the same bytes.
    let cut = |body: &str| body[..position(body, "postVotes")].to_owned();
    assert_eq!(cut(&alone.1), cut(&beside.1));
}

#[cfg(feature = "db-tests")]
mod database_tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn connector(db: &Database) -> impl Fn() -> Connector + '_ {
        || Connector::Plain(Box::new(db.config.clone()))
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    /// One conversation with fourteen comments and math priorities, and a
    /// participant (uid 1, pid 0) with two prior votes: what a vote copy and
    /// a comment copy of the same person both need.
    fn fixture(label: &str) -> Database {
        let db = Database::new(label);
        let mut c = db.connect();
        c.batch_execute(
            "INSERT INTO users(uid) VALUES(1);
             INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
             INSERT INTO zinvites(zid,zinvite) VALUES(1,'2fixture');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,0,1,3);
             ALTER TABLE participants ENABLE TRIGGER USER;
             INSERT INTO comments(zid,pid,uid,txt,lang,created)
             SELECT 1,0,1,'Generated comment ' || t,'en',1700000000000+t FROM generate_series(0,13) t ORDER BY t;",
        )
        .unwrap();
        let priorities =
            json!({"comment-priorities": {"0": 2, "1": 0.5, "2": 3, "4": 1.5, "9": 4}});
        c.execute(
            "INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data) VALUES(1,'test',7,0,$1::text::jsonb)",
            &[&priorities.to_string()],
        )
        .unwrap();
        for (tid, choice) in [(0, VoteChoice::Agree), (1, VoteChoice::Disagree)] {
            let fields = ParsedFields {
                tid: f64::from(tid),
                vote: choice,
                starred: None,
                high_priority: false,
                lang: None,
            };
            append(&mut c, &actor(), &fields).unwrap();
        }
        db
    }

    fn digest(config: &postgres::Config) -> Vec<String> {
        let mut c = config.connect(postgres::NoTls).unwrap();
        [
            "comments",
            "votes",
            "votes_latest_unique",
            "notification_tasks",
            "participants",
            "users",
            "xids",
        ]
        .iter()
        .map(|table| {
            c.query_one(
                &format!("select coalesce(json_agg(t order by t::text),'[]')::text from {table} t"),
                &[],
            )
            .unwrap()
            .get(0)
        })
        .collect()
    }

    async fn park(pool: &Arc<db::Pool>, size: usize) -> Vec<std::sync::mpsc::Sender<()>> {
        let (ready, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let mut releases = vec![];
        for _ in 0..size {
            let pool = pool.clone();
            let ready = ready.clone();
            let (release, held) = std::sync::mpsc::channel::<()>();
            releases.push(release);
            tokio::spawn(async move {
                let _ = pool
                    .with(move |_| {
                        ready.send(()).unwrap();
                        let _ = held.recv_timeout(Duration::from_secs(120));
                        Ok(())
                    })
                    .await;
            });
        }
        for _ in 0..size {
            tokio::time::timeout(Duration::from_secs(30), receive.recv())
                .await
                .unwrap()
                .unwrap();
        }
        releases
    }

    /// Whether the copy's admission ended inside the live admission deadline.
    fn timely(line: &Value) -> bool {
        line["admission_ms"]
            .as_f64()
            .is_some_and(|ms| ms <= ADMISSION_DEADLINE.as_secs_f64() * 1000.0)
    }

    /// How many waits, acquire timeouts and failed operations a pool has seen.
    fn contention(pool: &db::Pool) -> [usize; 3] {
        let seen = pool.evidence.snapshot();
        [seen[1], seen[2], seen[4]]
    }

    fn counter(health: &Value, route: &str, key: &str) -> u64 {
        health[route][key].as_u64().unwrap()
    }

    /// Copies of one route, as fast as the listener takes them, until told
    /// to stop. Returns how many were sent.
    async fn flood(
        app: Arc<App>,
        lane: Arc<shadow::Lane>,
        make: impl Fn(usize, &str) -> Request + Send + 'static,
        stop: Arc<AtomicBool>,
    ) -> usize {
        let mut sent = 0;
        while !stop.load(Ordering::SeqCst) {
            for _ in 0..10 {
                let id = request_id();
                let out = shadow::accept(app.clone(), lane.clone(), make(sent, &id)).await;
                assert_eq!(out.status, 204, "a flooded copy is still answered 204");
                sent += 1;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        sent
    }

    const VOTES: [(i32, VoteChoice); 12] = [
        (2, VoteChoice::Agree),
        (4, VoteChoice::Pass),
        (6, VoteChoice::Disagree),
        (2, VoteChoice::Agree),
        (7, VoteChoice::Agree),
        (9, VoteChoice::Pass),
        (10, VoteChoice::Disagree),
        (11, VoteChoice::Agree),
        (0, VoteChoice::Agree),
        (12, VoteChoice::Pass),
        (13, VoteChoice::Disagree),
        (3, VoteChoice::Agree),
    ];

    /// A flood of comment copies, with every connection of the comment
    /// observer's pools held, leaves the vote observations as they are with
    /// no comment copy at all: the same number, each with the same outcome,
    /// would-be status, reason, next-comment class, counts and read-back
    /// class, each inside the admission deadline, and no vote observation
    /// waits for a connection. Nothing is written by either.
    #[test]
    fn a_flood_of_comment_copies_leaves_vote_observations_unchanged() {
        let keys = signing();
        let db = fixture("two_route_comment_flood");
        let before = digest(&db.config);
        let member = token(&keys);
        let mut phases = vec![];
        for flooded in [false, true] {
            let app = shadow_app(connector(&db), &keys.public, true, true, 20);
            let rt = runtime();
            let phase = rt.block_on(async {
                let lane = shadow::Lane::new(1000);
                let votes = app.post_votes_observe.as_ref().unwrap();
                let comment_observer = app.post_comments_observe.as_ref().unwrap();
                let stop = Arc::new(AtomicBool::new(false));
                let mut held = vec![];
                let mut flooding = None;
                if flooded {
                    let [(_, reads), (_, readback)] = comment_observer.startup_pools();
                    held.extend(park(reads, 2).await);
                    held.extend(park(readback, 1).await);
                    let token = member.clone();
                    flooding = Some(tokio::spawn(flood(
                        app.clone(),
                        lane.clone(),
                        move |n, id| {
                            comments::copy(
                                &comment_body(&format!("Generated flood comment {n}")),
                                Some(&format!("Bearer {token}")),
                                id,
                            )
                        },
                        stop.clone(),
                    )));
                    // The comment lane is full before the first vote is sent.
                    tokio::time::timeout(Duration::from_secs(30), async {
                        while comment_observer.lane.in_flight() < shadow::comments::CAPACITY {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .expect("the comment lane fills");
                }
                let waits_before = [contention(&votes.reads), contention(&votes.readback)];
                let mut lines = vec![];
                for (tid, choice) in VOTES {
                    let id = request_id();
                    let req = vote_copy(&vote_body(tid, choice), Some(member.as_str()), &id);
                    let out = shadow::accept(app.clone(), lane.clone(), req).await;
                    assert_eq!(out.status, 204);
                    let line = vote_line(&id).await;
                    lines.push(json!([
                        line["outcome"],
                        line["admitted"],
                        line["status"],
                        line["reason"],
                        line["zid"],
                        line["follow_on"],
                        line["remaining"],
                        line["total"],
                        line["candidates"],
                        line["weights_tick"],
                        line["prev"],
                        line["node_vote"],
                        timely(&line),
                    ]));
                }
                let waits_after = [contention(&votes.reads), contention(&votes.readback)];
                stop.store(true, Ordering::SeqCst);
                let sent = match flooding {
                    Some(task) => task.await.unwrap(),
                    None => 0,
                };
                drop(held);
                tokio::time::timeout(Duration::from_secs(30), async {
                    while comment_observer.lane.in_flight() != 0 {
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                })
                .await
                .expect("the comment lane drains");
                let health: Value =
                    serde_json::from_str(&health_body(shadow::health(&app, &lane).await)).unwrap();
                (lines, waits_before, waits_after, sent, health)
            });
            drop(app);
            drop(rt);
            phases.push(phase);
        }
        let (quiet, flooded) = (&phases[0], &phases[1]);
        // The flood was one: far more copies than the lane's rate and room.
        assert!(
            flooded.3 > 200,
            "only {} comment copies were sent",
            flooded.3
        );
        assert!(
            counter(&flooded.4, "postComments", "shed") > 100,
            "{}",
            flooded.4
        );
        assert!(
            counter(&flooded.4, "postComments", "observed") >= 8,
            "{}",
            flooded.4
        );
        assert_eq!(counter(&quiet.4, "postComments", "observed"), 0);
        // The vote observations: the same count, and each the same.
        assert_eq!(quiet.0.len(), VOTES.len());
        assert_eq!(
            quiet.0, flooded.0,
            "vote observations changed under a comment flood"
        );
        for line in &flooded.0 {
            assert_eq!(line[0], "would_serve", "{line}");
            assert_eq!(line[12], true, "admission ran past its deadline: {line}");
        }
        for phase in [quiet, flooded] {
            assert_eq!(
                counter(&phase.4, "postVotes", "observed"),
                VOTES.len() as u64
            );
            assert_eq!(
                counter(&phase.4, "postVotes", "wouldServe"),
                VOTES.len() as u64
            );
            assert_eq!(counter(&phase.4, "postVotes", "shed"), 0);
            assert_eq!(
                phase.1, phase.2,
                "a vote observation waited for a connection, timed out or failed"
            );
        }
        assert_eq!(digest(&db.config), before, "an observation changed a row");
    }

    /// The reverse: a flood of vote copies, with every connection of the vote
    /// observer's pools held, leaves the comment observations as they are
    /// with no vote copy at all.
    #[test]
    fn a_flood_of_vote_copies_leaves_comment_observations_unchanged() {
        let keys = signing();
        let db = fixture("two_route_vote_flood");
        let before = digest(&db.config);
        let member = token(&keys);
        let authorization = format!("Bearer {member}");
        let texts: Vec<String> = (0..10)
            .map(|n| format!("Generated observed comment {n}"))
            // A text that exists (another time, so a duplicate) and one more.
            .chain([
                "Generated comment 3".to_owned(),
                "Generated comment 4".to_owned(),
            ])
            .collect();
        let mut phases = vec![];
        for flooded in [false, true] {
            let app = shadow_app(connector(&db), &keys.public, true, true, 1000);
            let rt = runtime();
            let phase = rt.block_on(async {
                let lane = shadow::Lane::new(1000);
                let votes = app.post_votes_observe.as_ref().unwrap();
                let comment_observer = app.post_comments_observe.as_ref().unwrap();
                let [(_, reads), (_, readback)] = comment_observer.startup_pools();
                let stop = Arc::new(AtomicBool::new(false));
                let mut held = vec![];
                let mut flooding = None;
                if flooded {
                    held.extend(park(&votes.reads, 2).await);
                    held.extend(park(&votes.readback, 1).await);
                    let token = member.clone();
                    flooding = Some(tokio::spawn(flood(
                        app.clone(),
                        lane.clone(),
                        move |n, id| {
                            let (tid, choice) = VOTES[n % VOTES.len()];
                            vote_copy(&vote_body(tid, choice), Some(token.as_str()), id)
                        },
                        stop.clone(),
                    )));
                    // The vote lane is full before the first comment is sent.
                    tokio::time::timeout(Duration::from_secs(30), async {
                        while lane.in_flight() < 32 {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .expect("the vote lane fills");
                }
                let waits_before = [contention(reads), contention(readback)];
                let mut lines = vec![];
                for text in &texts {
                    let id = request_id();
                    let req =
                        comments::copy(&comment_body(text), Some(authorization.as_str()), &id);
                    let out = shadow::accept(app.clone(), lane.clone(), req).await;
                    assert_eq!(out.status, 204);
                    let line = comments::observation(&id).await;
                    lines.push(json!([
                        line["outcome"],
                        line["admitted"],
                        line["status"],
                        line["reason"],
                        line["strict"],
                        line["text_row"],
                        line["node_comment"],
                        line["node_vote"],
                        line["readback_s"],
                        timely(&line),
                    ]));
                }
                let waits_after = [contention(reads), contention(readback)];
                stop.store(true, Ordering::SeqCst);
                let sent = match flooding {
                    Some(task) => task.await.unwrap(),
                    None => 0,
                };
                drop(held);
                tokio::time::timeout(Duration::from_secs(30), async {
                    while lane.in_flight() != 0 {
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                })
                .await
                .expect("the vote lane drains");
                let health: Value =
                    serde_json::from_str(&health_body(shadow::health(&app, &lane).await)).unwrap();
                (lines, waits_before, waits_after, sent, health)
            });
            drop(app);
            drop(rt);
            phases.push(phase);
        }
        let (quiet, flooded) = (&phases[0], &phases[1]);
        assert!(flooded.3 > 200, "only {} vote copies were sent", flooded.3);
        assert!(
            counter(&flooded.4, "postVotes", "shed") > 100,
            "{}",
            flooded.4
        );
        assert!(
            counter(&flooded.4, "postVotes", "observed") >= 32,
            "{}",
            flooded.4
        );
        assert_eq!(counter(&quiet.4, "postVotes", "observed"), 0);
        assert_eq!(quiet.0.len(), texts.len());
        assert_eq!(
            quiet.0, flooded.0,
            "comment observations changed under a vote flood"
        );
        for (n, line) in flooded.0.iter().enumerate() {
            let (outcome, status) = if n < 10 {
                ("would_serve", 200)
            } else {
                ("would_answer", 409)
            };
            assert_eq!(line[0], outcome, "{line}");
            assert_eq!(line[2], status, "{line}");
            assert_eq!(line[9], true, "admission ran past its deadline: {line}");
        }
        for phase in [quiet, flooded] {
            assert_eq!(
                counter(&phase.4, "postComments", "observed"),
                texts.len() as u64
            );
            assert_eq!(counter(&phase.4, "postComments", "wouldServe"), 10);
            assert_eq!(counter(&phase.4, "postComments", "wouldAnswer"), 2);
            assert_eq!(counter(&phase.4, "postComments", "shed"), 0);
            assert_eq!(
                phase.1, phase.2,
                "a comment observation waited for a connection, timed out or failed"
            );
        }
        assert_eq!(digest(&db.config), before, "an observation changed a row");
    }
}
