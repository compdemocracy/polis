#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::http::{Body, Headers};
use jsonwebtoken::{EncodingKey, Header, encode};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};

// Ensure assertion failures also destroy synchronous clients off Tokio.
struct OwnedClient(Option<postgres::Client>);
impl std::ops::Deref for OwnedClient {
    type Target = postgres::Client;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for OwnedClient {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().unwrap()
    }
}
impl Drop for OwnedClient {
    fn drop(&mut self) {
        if let Some(c) = self.0.take() {
            std::thread::spawn(move || drop(c)).join().unwrap();
        }
    }
}
const Z: i32 = 8710101;
const U: i32 = 8710201;
const CID: &str = "2markfixture";

fn connector(url: &str) -> polis_queue_adapter::jobs::transport::Connector {
    let mut cfg: postgres::Config = url.parse().unwrap();
    cfg.connect_timeout(Duration::from_millis(100));
    polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg))
}
fn app(url: &str, key: &[u8]) -> App {
    let cfg = config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 1,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: limits(100),
    };
    let mut state = App::new(&cfg, db::Pool::new(connector(url), limits(100)));
    state.cors = crate::cors::Cors::for_test(&["localhost"]);
    state.mark_writer = Some(Writer {
        reads: db::Pool::new(connector(url), limits(50)),
        notifications: db::Pool::writer(connector(url), limits(50)),
        notification_pending: Arc::new(tokio::sync::Semaphore::new(8)),
        notification_dropped: Arc::new(AtomicU64::new(0)),
        writes: db::Pool::writer(connector(url), limits(1000)),
        verifier: participant::Verifier::new(key, "https://pol.is/", "participants").unwrap(),
        pending: Arc::new(tokio::sync::Semaphore::new(8)),
        after_mutation: None,
    });
    state
}
fn token(actor: &str, key: &EncodingKey) -> String {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let (uid, pid) = match actor {
        "pid0" | "owner" => (U, 0),
        "standard" | "moderator" | "marked-participant" => (U + 2, 2),
        "admin" => (U + 4, 4),
        "nonmember" => (U + 5, 5),
        "xid" => (U + 3, 3),
        _ => (U + 1, 1),
    };
    let mut c = json!({"uid":uid,"pid":pid,"conversation_id":CID,"sub":format!("anon:{uid}"),"iss":"https://pol.is/","aud":"participants","iat":now-1,"exp":now+86400,"anonymous_participant":true});
    if actor == "stale-pid" {
        c["pid"] = json!(4);
    }
    if actor == "foreign" {
        c["conversation_id"] = json!("2markforeign");
    }
    if actor == "expired" {
        c["exp"] = json!(1);
    }
    if actor == "wrong-issuer" {
        c["iss"] = json!("invalid");
    }
    if actor == "wrong-audience" {
        c["aud"] = json!("invalid");
    }
    if actor == "future" {
        c["nbf"] = json!(now + 86400);
    }
    if matches!(
        actor,
        "owner" | "standard" | "moderator" | "admin" | "marked-participant"
    ) {
        c.as_object_mut().unwrap().remove("anonymous_participant");
        c["standard_user_participant"] = json!(true);
        c["oidc_sub"] = json!("generated-standard");
        c["sub"] = json!("user:generated-standard");
    }
    if actor.starts_with("xid") {
        c.as_object_mut().unwrap().remove("anonymous_participant");
        c["xid_participant"] = json!(true);
        c["xid"] = json!("generated-member");
    }
    if actor.starts_with("oidc") {
        c = json!({"sub":"generated-selection-account","iss":"https://localhost/","aud":"users","iat":now-1,"exp":now+86400});
    }
    let signed = encode(&Header::new(jsonwebtoken::Algorithm::RS256), &c, key).unwrap();
    match actor {
        "malformed" => "generated-invalid".into(),
        "signature" => format!("{signed}invalid"),
        _ => signed,
    }
}
fn request(case: &Value, key: &EncodingKey) -> Request {
    let actor = case["auth"].as_str().unwrap();
    let bearer = format!(
        "{} {}",
        if actor == "lowercase" {
            "bearer"
        } else {
            "Bearer"
        },
        token(actor, key)
    );
    let mut headers = vec![
        ("host", "localhost"),
        ("origin", "https://localhost"),
        ("x-forwarded-proto", "https"),
        ("accept-encoding", "identity"),
        ("content-type", case["contentType"].as_str().unwrap()),
    ];
    if actor != "none" && actor != "cookie" {
        headers.push(("authorization", &bearer));
    }
    if actor == "cookie" {
        headers.push(("cookie", "pc=generated-cookie"));
    }
    Request {
        method: case["method"].as_str().unwrap().into(),
        target: format!(
            "/api/v3/{}{}",
            case["route"].as_str().unwrap(),
            case["query"].as_str().unwrap()
        ),
        headers: Headers::from_raw(headers),
        body: case["raw"]
            .as_str()
            .map(str::as_bytes)
            .map(Vec::from)
            .unwrap_or_else(|| serde_json::to_vec(&case["request"]).unwrap()),
    }
}
fn expected_admitted(case: &Value) -> bool {
    if !matches!(
        case["auth"].as_str(),
        Some(
            "anonymous"
                | "pid0"
                | "standard"
                | "owner"
                | "moderator"
                | "admin"
                | "marked-participant"
        )
    ) || case["setup"] == "treevite"
        || case["query"] != ""
        || !case["raw"].is_null()
        || case["contentType"] != "application/json"
        || case["request"]["conversation_id"] != CID
    {
        return false;
    }
    let field = if case["route"] == "stars" {
        "starred"
    } else {
        "trashed"
    };
    case["request"].as_object().unwrap().len() == 3
        && case["request"]["tid"]
            .as_i64()
            .is_some_and(|n| i32::try_from(n).is_ok())
        && case["request"][field]
            .as_i64()
            .is_some_and(|n| (0..=1).contains(&n))
}
fn bytes(body: Body) -> Vec<u8> {
    match body {
        Body::Empty => vec![],
        Body::Fixed(v) => v,
        Body::Chunked(v) => v.concat(),
    }
}
fn snapshot(c: &mut postgres::Client) -> Value {
    let mut all = serde_json::Map::new();
    for table in [
        "users",
        "conversations",
        "zinvites",
        "participants",
        "stars",
        "trashes",
    ] {
        let rows = c
            .query(
                &format!(
                    "SELECT row_to_json(t)::text FROM {table} t ORDER BY row_to_json(t)::text"
                ),
                &[],
            )
            .unwrap();
        all.insert(
            table.into(),
            Value::Array(
                rows.iter()
                    .map(|r| serde_json::from_str(r.get(0)).unwrap())
                    .collect(),
            ),
        );
    }
    Value::Object(all)
}
fn rows(c: &mut postgres::Client, table: &str) -> Value {
    let column = if table == "stars" {
        "starred"
    } else {
        "trashed"
    };
    let rows=c.query(&format!("SELECT row_to_json(t)::text FROM (SELECT zid,pid,tid,{column} FROM {table} ORDER BY pid,tid,{column}) t"),&[]).unwrap();
    Value::Array(
        rows.iter()
            .map(|r| serde_json::from_str(r.get(0)).unwrap())
            .collect(),
    )
}
fn setup(c: &mut postgres::Client, case: &Value) {
    c.batch_execute("DROP TRIGGER IF EXISTS injected_failure ON stars; DROP TRIGGER IF EXISTS injected_failure ON trashes; TRUNCATE users,conversations,zinvites,participants,stars,trashes;").unwrap();
    for n in 0..6 {
        c.execute("INSERT INTO users VALUES($1)", &[&(U + n)])
            .unwrap();
    }
    c.execute(
        "INSERT INTO conversations VALUES($1,$2,$3,$4,1)",
        &[
            &Z,
            &U,
            &(case["setup"] != "closed"),
            &(case["setup"] == "treevite"),
        ],
    )
    .unwrap();
    c.execute("INSERT INTO zinvites VALUES($1,$2)", &[&Z, &CID])
        .unwrap();
    for n in 0..5 {
        c.execute(
            "INSERT INTO participants VALUES($1,$2,$3)",
            &[&Z, &(U + n), &n],
        )
        .unwrap();
    }
    for table in ["stars", "trashes"] {
        let field = if table == "stars" {
            "starred"
        } else {
            "trashed"
        };
        for row in case["before"][table].as_array().unwrap() {
            c.execute(
                &format!("INSERT INTO {table}(zid,pid,tid,{field}) VALUES($1,$2,$3,$4)"),
                &[
                    &Z,
                    &(row["pid"].as_i64().unwrap() as i32),
                    &(row["tid"].as_i64().unwrap() as i32),
                    &(row[field].as_i64().unwrap() as i32),
                ],
            )
            .unwrap();
        }
    }
    if matches!(case["fault"].as_str(), Some("write" | "duplicate")) {
        let code = if case["fault"] == "duplicate" {
            "23505"
        } else {
            "XX000"
        };
        c.batch_execute(&format!("CREATE OR REPLACE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'generated failure' USING ERRCODE='{code}'; END $$; CREATE TRIGGER injected_failure BEFORE INSERT ON {} FOR EACH STATEMENT EXECUTE FUNCTION injected_failure()",case["route"].as_str().unwrap())).unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_marks_and_dispatch_isolation() {
    let base = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let database = format!("mark_write_test_{}", std::process::id());
    let name = database.clone();
    let base_create = base.clone();
    tokio::task::spawn_blocking(move || {
        postgres::Client::connect(&base_create, postgres::NoTls)
            .unwrap()
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap()
    })
    .await
    .unwrap();
    let mut parsed = url::Url::parse(&base).unwrap();
    parsed.set_path(&database);
    let url = parsed.to_string();
    let fixture_url = url.clone();
    let mut c=tokio::task::spawn_blocking(move||{
        let mut c=postgres::Client::connect(&fixture_url,postgres::NoTls).unwrap();
        c.batch_execute("CREATE TABLE users(uid integer); CREATE TABLE conversations(zid integer,owner integer,is_active boolean,treevite_enabled boolean,modified bigint); CREATE TABLE participants(zid integer,uid integer,pid integer); CREATE TABLE zinvites(zid integer,zinvite text); CREATE FUNCTION now_as_millis() RETURNS bigint LANGUAGE SQL AS 'SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint';").unwrap();
        let ddl=include_str!("../../../server/postgres/migrations/000000_initial.sql");
        for table in ["stars","trashes"] {let start=ddl.find(&format!("CREATE TABLE {table}(")).unwrap();let end=ddl[start..].find("\n);").unwrap()+start+3;c.batch_execute(&ddl[start..end]).unwrap();}
        OwnedClient(Some(c))
    }).await.unwrap();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let corpus: Vec<Value> = serde_json::from_str(include_str!(
        "../../../server/characterization/marks/cases.json"
    ))
    .unwrap();
    let (mut admitted, mut handed_back) = (0, 0);
    for case in &corpus {
        let prepared = case.clone();
        let (next, before) = tokio::task::spawn_blocking(move || {
            setup(&mut c, &prepared);
            let before = snapshot(&mut c);
            (c, before)
        })
        .await
        .unwrap();
        c = next;
        let mut state = app(&url, &public);
        if case["fault"] == "after-commit" {
            state.mark_writer.as_mut().unwrap().after_mutation =
                Some(Arc::new(|| anyhow::bail!("generated lost acknowledgement")));
        }
        let out = route::handle(Arc::new(state), request(case, &key)).await;
        tokio::time::sleep(Duration::from_millis(180)).await;
        let (next, after, stars, trashes, modified) = tokio::task::spawn_blocking(move || {
            let after = snapshot(&mut c);
            let stars = rows(&mut c, "stars");
            let trashes = rows(&mut c, "trashes");
            let modified: i64 = c
                .query_one("SELECT modified FROM conversations", &[])
                .unwrap()
                .get(0);
            (c, after, stars, trashes, modified)
        })
        .await
        .unwrap();
        c = next;
        if expected_admitted(case) {
            assert_eq!(
                out.status,
                case["status"].as_u64().unwrap() as u16,
                "{} status",
                case["name"]
            );
            assert_eq!(
                String::from_utf8(bytes(out.body)).unwrap(),
                case["body"].as_str().unwrap(),
                "{} body",
                case["name"]
            );
            let headers: Vec<_> = out
                .headers
                .into_iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.to_ascii_lowercase().as_str(),
                        "date" | "connection" | "keep-alive"
                    )
                })
                .collect();
            assert_eq!(
                serde_json::to_value(headers).unwrap(),
                case["headers"],
                "{} headers",
                case["name"]
            );
            assert_eq!(stars, case["after"]["stars"], "{} stars", case["name"]);
            assert_eq!(
                trashes, case["after"]["trashes"],
                "{} trashes",
                case["name"]
            );
            assert_eq!(
                if modified == 1 { "initial" } else { "advanced" },
                case["after"]["modified"].as_str().unwrap(),
                "{} notification",
                case["name"]
            );
            for t in ["users", "participants", "zinvites"] {
                assert_eq!(before[t], after[t]);
            }
            admitted += 1;
        } else {
            assert_eq!(out.status, 502, "{} handback", case["name"]);
            assert_eq!(before, after, "{} no mutation", case["name"]);
            handed_back += 1;
        }
        let mut disabled = app(&url, &public);
        disabled.mark_writer = None;
        assert_eq!(
            route::handle(Arc::new(disabled), request(case, &key))
                .await
                .status,
            502
        );
        let (next, off) = tokio::task::spawn_blocking(move || {
            let s = snapshot(&mut c);
            (c, s)
        })
        .await
        .unwrap();
        c = next;
        assert_eq!(off, after);
    }
    eprintln!(
        "marks: {admitted} exact, {handed_back} durable-unchanged handbacks, {} switch-off handbacks",
        corpus.len()
    );
    let clean = corpus
        .iter()
        .find(|r| r["name"] == "trashes-anonymous")
        .unwrap()
        .clone();
    let prepared = clean.clone();
    c = tokio::task::spawn_blocking(move || {
        setup(&mut c, &prepared);
        c
    })
    .await
    .unwrap();
    let state = Arc::new(app(&url, &public));
    let pending = state
        .mark_writer
        .as_ref()
        .unwrap()
        .pending
        .clone()
        .acquire_many_owned(8)
        .await
        .unwrap();
    assert_eq!(
        route::handle(state.clone(), request(&clean, &key))
            .await
            .status,
        502
    );
    drop(pending);
    // Park the metadata row lock. Appends have no parent FK or row lock and
    // still complete; their separate metadata lane times out without retry.
    let lock_url = url.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock = std::thread::spawn(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        let mut tx = c.transaction().unwrap();
        tx.query("SELECT zid FROM conversations FOR NO KEY UPDATE", &[])
            .unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        tx.rollback().unwrap();
    });
    tokio::task::spawn_blocking(move || ready_rx.recv().unwrap())
        .await
        .unwrap();
    let out = route::handle(state.clone(), request(&clean, &key)).await;
    assert_eq!(out.status, 200);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        state
            .mark_writer
            .as_ref()
            .unwrap()
            .notification_dropped
            .load(Ordering::Relaxed)
            > 0
    );
    release_tx.send(()).unwrap();
    tokio::task::spawn_blocking(move || lock.join().unwrap())
        .await
        .unwrap();
    // Pending metadata is bounded before spawning and cannot consume writer capacity.
    let pending = state
        .mark_writer
        .as_ref()
        .unwrap()
        .notification_pending
        .clone()
        .acquire_many_owned(8)
        .await
        .unwrap();
    assert_eq!(
        route::handle(state.clone(), request(&clean, &key))
            .await
            .status,
        200
    );
    drop(pending);
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let mut delayed = app(&url, &public);
    delayed.mark_writer.as_mut().unwrap().after_mutation = Some(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1250));
        Ok(())
    }));
    let delayed = Arc::new(delayed);
    assert_eq!(
        route::handle(delayed.clone(), request(&clean, &key))
            .await
            .status,
        500
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let req = request(&clean, &key);
    let copy = delayed.clone();
    let task = tokio::spawn(async move { route::handle(copy, req).await });
    while count.load(Ordering::SeqCst) < 2 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    task.abort();
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert_eq!(count.load(Ordering::SeqCst), 2);
    let (next, total) = tokio::task::spawn_blocking(move || {
        let n: i64 = c
            .query_one("SELECT count(*) FROM trashes", &[])
            .unwrap()
            .get(0);
        (c, n)
    })
    .await
    .unwrap();
    c = next;
    assert_eq!(total, 4);
    drop(delayed);
    drop(state);
    drop(c);
    tokio::task::spawn_blocking(move || {
        postgres::Client::connect(&base, postgres::NoTls)
            .unwrap()
            .batch_execute(&format!("DROP DATABASE {database} WITH (FORCE)"))
            .unwrap()
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the generated Node companion and its private credential file"]
async fn mixed_node_and_rust_marks() {
    use std::io::{Read, Write};
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let address = std::env::var("POLIS_MARK_NODE_ADDRESS").unwrap();
    let credentials: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("POLIS_MARK_NODE_CREDENTIALS").unwrap()).unwrap(),
    )
    .unwrap();
    let public = credentials["public_key"].as_str().unwrap().as_bytes();
    let bearer = format!("Bearer {}", credentials["token"].as_str().unwrap());
    let state = Arc::new(app(&url, public));
    for (path, field, status) in [
        ("/api/v3/stars", "starred", 500),
        ("/api/v3/trashes", "trashed", 200),
    ] {
        let body = json!({"conversation_id":CID,"tid":0,field:1}).to_string();
        for _ in 0..12 {
            let req = Request {
                method: "POST".into(),
                target: path.into(),
                headers: Headers::from_raw(vec![
                    ("host", "localhost"),
                    ("origin", "https://localhost"),
                    ("x-forwarded-proto", "https"),
                    ("content-type", "application/json"),
                    ("authorization", &bearer),
                ]),
                body: body.as_bytes().to_vec(),
            };
            let address = address.clone();
            let bearer = bearer.clone();
            let body = body.clone();
            let node = tokio::task::spawn_blocking(move || {
                let mut stream = std::net::TcpStream::connect(address).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                write!(stream,"POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: {bearer}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                assert!(
                    response.starts_with(&format!("HTTP/1.1 {status}")),
                    "{response}"
                );
            });
            assert_eq!(route::handle(state.clone(), req).await.status, status);
            node.await.unwrap();
        }
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        for table in ["stars", "trashes"] {
            let n: i64 = c
                .query_one(
                    &format!("SELECT count(*) FROM {table} WHERE zid=$1 AND pid=1 AND tid=0"),
                    &[&Z],
                )
                .unwrap()
                .get(0);
            assert_eq!(n, 24);
        }
    })
    .await
    .unwrap();
    eprintln!(
        "mixed marks: 24 stars (expected 500 after append), 24 trashes (200), exact durable counts"
    );
}
