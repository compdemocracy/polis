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
const Z: i32 = 8700101;
const U: i32 = 8700201;
const CID: &str = "2selectionfixture";

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
    state.topic_selection_writer = Some(Writer {
        reads: db::Pool::new(connector(url), limits(50)),
        publications: db::Pool::new(connector(url), limits(100)),
        writes: db::Pool::writer(connector(url), limits(1000)),
        verifier: participant::Verifier::new(key, "https://pol.is/", "participants").unwrap(),
        env: "generated-selection".into(),
        scope: Some("generated-scope".into()),
        pending: Arc::new(tokio::sync::Semaphore::new(8)),
        after_mutation: None,
        before_mutation: None,
    });
    state
}
fn token(actor: &str, key: &EncodingKey) -> String {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let (uid, pid) = match actor {
        "pid0" | "owner" => (U, 0),
        "standard" => (U + 2, 2),
        "nonmember" => (U + 5, 5),
        "xid" => (U + 3, 3),
        _ => (U + 1, 1),
    };
    let mut c = json!({"uid":uid,"pid":pid,"conversation_id":CID,"sub":format!("anon:{uid}"),"iss":"https://pol.is/","aud":"participants","iat":now-1,"exp":now+86400,"anonymous_participant":true});
    if actor == "foreign" {
        c["conversation_id"] = json!("2selectionforeign");
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
    if matches!(actor, "owner" | "standard") {
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
        target: format!("{}{}", contract::PATH, case["query"].as_str().unwrap()),
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
        Some("anonymous" | "pid0" | "standard" | "owner")
    ) || matches!(
        case["setup"].as_str(),
        Some("treevite" | "xid-required" | "whitelist")
    ) || case["publication"].as_str().unwrap().starts_with("dynamo")
        || case["query"] != ""
        || !case["raw"].is_null()
        || case["contentType"] != "application/json"
        || case["request"]["conversation_id"] != CID
        || case["request"]
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !matches!(k.as_str(), "conversation_id" | "selections"))
    {
        return false;
    }
    if case["method"] == "DELETE" {
        return true;
    }
    if !case["request"]["selections"]
        .as_array()
        .is_some_and(|a| a.len() <= 256)
    {
        return false;
    }
    // A statement failure is terminal even for an absent row: only a
    // successfully completed zero-row UPDATE can prove a safe hand-back.
    case["method"] != "PUT"
        || matches!(case["setup"].as_str(), Some("present" | "existing"))
        || case["fault"] == "write"
}
fn bytes(body: Body) -> Vec<u8> {
    match body {
        Body::Empty => vec![],
        Body::Fixed(v) => v,
        Body::Chunked(v) => v.concat(),
    }
}
fn snapshot(c: &mut postgres::Client) -> Value {
    let mut result = serde_json::Map::new();
    for table in [
        "users",
        "conversations",
        "zinvites",
        "participants",
        "participants_extended",
        "xids",
        "oidc_user_mappings",
        "topic_agenda_selections",
    ] {
        let rows = c
            .query(
                &format!(
                    "SELECT row_to_json(t)::text FROM {table} t ORDER BY row_to_json(t)::text"
                ),
                &[],
            )
            .unwrap();
        result.insert(
            table.into(),
            Value::Array(
                rows.iter()
                    .map(|r| serde_json::from_str(r.get(0)).unwrap())
                    .collect(),
            ),
        );
    }
    Value::Object(result)
}
fn selection_rows(c: &mut postgres::Client) -> Value {
    let rows=c.query("SELECT row_to_json(t)::text FROM (SELECT zid,pid,archetypal_selections,delphi_job_id,total_selections FROM topic_agenda_selections ORDER BY pid) t",&[]).unwrap();
    Value::Array(
        rows.iter()
            .map(|r| serde_json::from_str(r.get(0)).unwrap())
            .collect(),
    )
}
fn setup(c: &mut postgres::Client, case: &Value) {
    c.batch_execute("DROP TRIGGER IF EXISTS injected_write_failure ON topic_agenda_selections; TRUNCATE users CASCADE; TRUNCATE delphi_result_publications;").unwrap();
    for n in 0..6 {
        c.execute("INSERT INTO users VALUES($1)", &[&(U + n)])
            .unwrap();
    }
    let setup = case["setup"].as_str().unwrap_or("");
    c.execute(
        "INSERT INTO conversations VALUES($1,$2,$3,$4,$5,$6)",
        &[
            &Z,
            &U,
            &(setup != "closed"),
            &(setup == "treevite"),
            &(setup == "xid-required"),
            &(setup == "whitelist"),
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
    for row in case["before"]["rows"].as_array().unwrap() {
        c.execute("INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,delphi_job_id,total_selections) VALUES($1,$2,$3::text::jsonb,$4,$5)",&[&Z,&(row["pid"].as_i64().unwrap() as i32),&row["archetypal_selections"].to_string(),&row["delphi_job_id"].as_str(),&(row["total_selections"].as_i64().unwrap() as i32)]).unwrap();
    }
    match case["publication"].as_str().unwrap() {
        "pg-present" => {
            c.execute("INSERT INTO delphi_result_publications VALUES('generated-selection',$1,'generated-scope','generated-job')",&[&Z]).unwrap();
        }
        "pg-ambiguous" | "pg-scoped" => {
            c.execute("INSERT INTO delphi_result_publications VALUES('generated-selection',$1,'first','generated-a'),('generated-selection',$1,'second','generated-b')",&[&Z]).unwrap();
        }
        _ => {}
    }
    if case["fault"] == "write" {
        c.batch_execute("CREATE TRIGGER injected_write_failure BEFORE INSERT OR UPDATE OR DELETE ON topic_agenda_selections FOR EACH STATEMENT EXECUTE FUNCTION injected_failure()").unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_node_bytes_handbacks_and_mutation_boundaries() {
    let base = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let database = format!("selection_write_test_{}", std::process::id());
    let name = database.clone();
    let base_create = base.clone();
    let url = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&base_create, postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE DATABASE {name}")).unwrap();
        let mut cfg: postgres::Config = base_create.parse().unwrap();
        cfg.dbname(&name);
        cfg
    })
    .await
    .unwrap();
    // Owned disposable database: the fixture uses the published selection DDL,
    // with minimal parent rows and explicit provider/failure controls.
    let fixture_cfg = url.clone();
    let mut c=tokio::task::spawn_blocking(move||{
        let mut c=fixture_cfg.connect(postgres::NoTls).unwrap();
        c.batch_execute("CREATE TABLE users(uid integer PRIMARY KEY); CREATE TABLE conversations(zid integer PRIMARY KEY,owner integer REFERENCES users(uid),is_active boolean,treevite_enabled boolean,xid_required boolean,use_xid_whitelist boolean); CREATE TABLE zinvites(zid integer REFERENCES conversations(zid) ON DELETE CASCADE,zinvite text); CREATE TABLE participants(zid integer REFERENCES conversations(zid) ON DELETE CASCADE,uid integer REFERENCES users(uid),pid integer,PRIMARY KEY(zid,pid)); CREATE TABLE participants_extended(uid integer,zid integer); CREATE TABLE xids(owner integer,uid integer,xid text,zid integer,pid integer); CREATE TABLE oidc_user_mappings(uid integer,oidc_sub text); CREATE TABLE delphi_result_publications(env text,zid integer,scope_key text,job_id text,PRIMARY KEY(env,zid,scope_key)); CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'generated selection failure'; END $$;").unwrap();
        c.batch_execute(include_str!("../../../server/postgres/migrations/000012_create_topic_agenda_selections.sql")).unwrap();OwnedClient(Some(c))
    }).await.unwrap();
    let mut parsed = url::Url::parse(&base).unwrap();
    parsed.set_path(&database);
    let url = parsed.to_string();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../server/characterization/selections/cases.json"
    ))
    .unwrap();
    let mut admitted = 0;
    let mut handed_back = 0;
    for case in corpus.as_array().unwrap() {
        let prepared = case.clone();
        c = tokio::task::spawn_blocking(move || {
            setup(&mut c, &prepared);
            c
        })
        .await
        .unwrap();
        let (next, before) = tokio::task::spawn_blocking(move || {
            let s = snapshot(&mut c);
            (c, s)
        })
        .await
        .unwrap();
        c = next;
        let mut state = app(&url, &public);
        if case["configuration"]["backend"] != "postgres" {
            assert_eq!(case["configuration"]["backend"], "dynamodb");
            state.topic_selection_writer = None;
        }
        // Replay sealed configuration, never infer a different scope from the case name.
        if let Some(writer) = state.topic_selection_writer.as_mut() {
            writer.env = case["configuration"]["env"].as_str().unwrap().into();
            writer.scope = case["configuration"]["scope"].as_str().map(str::to_owned);
        }
        for lookup in case["publicationQueries"].as_array().unwrap() {
            let expected = match case["configuration"]["scope"].as_str() {
                Some(scope) => json!(["generated-selection", Z, scope]),
                None => json!(["generated-selection", Z]),
            };
            assert_eq!(lookup["args"], expected);
        }
        if case["publication"] == "pg-error" {
            state.topic_selection_writer.as_mut().unwrap().publications = db::Pool::new(
                connector("postgresql://postgres@127.0.0.1:1/unused"),
                limits(100),
            );
        }
        let out = route::handle(Arc::new(state), request(case, &key)).await;
        let (next, after, rows) = tokio::task::spawn_blocking(move || {
            let s = snapshot(&mut c);
            let rows = selection_rows(&mut c);
            (c, s, rows)
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
            assert_eq!(
                rows, case["after"]["rows"],
                "{} durable selections",
                case["name"]
            );
            for table in [
                "users",
                "participants",
                "participants_extended",
                "xids",
                "oidc_user_mappings",
                "conversations",
                "zinvites",
            ] {
                assert_eq!(
                    before[table], after[table],
                    "{} changed {table}",
                    case["name"]
                );
            }
            admitted += 1;
        } else {
            assert_eq!(out.status, 502, "{} handback", case["name"]);
            assert_eq!(
                before, after,
                "{} changed durable state on handback",
                case["name"]
            );
            handed_back += 1;
        }
        contract::decode(
            case["status"].as_u64().unwrap() as u16,
            case["body"].as_str().unwrap(),
        )
        .unwrap();
    }
    println!(
        "selection replay: {admitted} byte-exact, {handed_back} pre-mutation handbacks, zero differences"
    );
    let simple = corpus[0].clone();
    c = tokio::task::spawn_blocking(move || {
        setup(&mut c, &simple);
        c
    })
    .await
    .unwrap();
    let state = Arc::new(app(&url, &public));
    // Switch off leaves every recorded request with Node, including valid
    // existing members; no startup configuration or listener is needed here.
    let mut off = app(&url, &public);
    off.topic_selection_writer = None;
    let off = Arc::new(off);
    for case in corpus.as_array().unwrap() {
        assert_eq!(
            route::handle(off.clone(), request(case, &key)).await.status,
            502
        );
    }
    drop(off);
    safety(&url, &public, &key, state, &corpus[0]).await;
    tokio::task::spawn_blocking(move || {
        drop(c);
        let mut admin = postgres::Client::connect(&base, postgres::NoTls).unwrap();
        admin
            .batch_execute(&format!("DROP DATABASE {database}"))
            .unwrap();
    })
    .await
    .unwrap();
}

async fn safety(url: &str, public: &[u8], key: &EncodingKey, state: Arc<App>, case: &Value) {
    let writer = state.topic_selection_writer.as_ref().unwrap();
    // Saturating selection admission never acquires a participation slot and
    // does not spawn any pending mutation. Release restores normal admission.
    let permits = writer.pending.clone().acquire_many_owned(8).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    for _ in 0..32 {
        assert_eq!(
            route::handle(state.clone(), request(case, key))
                .await
                .status,
            502
        );
        calls.fetch_add(1, Ordering::SeqCst);
    }
    assert!(state.db.ping().await);
    assert_eq!(calls.load(Ordering::SeqCst), 32);
    drop(permits);
    assert_eq!(
        route::handle(state.clone(), request(case, key))
            .await
            .status,
        200
    );
    // The publication connection is independent of admission and writer
    // connections. A parked lookup sheds before mutation while both stay free.
    let (ready, wait) = tokio::sync::oneshot::channel();
    let (release, receive) = std::sync::mpsc::channel();
    let pool = writer.publications.clone();
    let parked = tokio::spawn(async move {
        pool.with(move |_| {
            ready.send(()).unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
        .await
    });
    wait.await.unwrap();
    assert!(writer.reads.ping().await);
    assert!(writer.writes.ping().await);
    // Pool acquisition failure matches Node's null-attribution degradation.
    assert_eq!(
        route::handle(state.clone(), request(case, key))
            .await
            .status,
        200
    );
    release.send(()).unwrap();
    parked.await.unwrap().unwrap();
    // A fault in the mutation is terminal, not a replayable gateway status.
    let fault_url = url.to_string();
    tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&fault_url,postgres::NoTls).unwrap();c.batch_execute("CREATE TRIGGER injected_write_failure BEFORE INSERT OR UPDATE OR DELETE ON topic_agenda_selections FOR EACH STATEMENT EXECUTE FUNCTION injected_failure()").unwrap();}).await.unwrap();
    assert_eq!(
        route::handle(state.clone(), request(case, key))
            .await
            .status,
        500
    );
    drop(state);
    let clean = url.to_string();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&clean, postgres::NoTls).unwrap();
        c.batch_execute("DROP TRIGGER injected_write_failure ON topic_agenda_selections")
            .unwrap();
    })
    .await
    .unwrap();
    // Each attempt owns different JSON, count and attribution. An existing
    // row or an earlier successful write cannot satisfy these assertions.
    for (index, lose_caller) in [false, true].into_iter().enumerate() {
        let marker = format!("delayed-commit-{index}");
        let job = format!("delayed-job-{index}");
        let selections = json!([marker, index, lose_caller]);
        let update_url = url.to_string();
        let job_seed = job.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&update_url, postgres::NoTls).unwrap();
            c.execute("DELETE FROM delphi_result_publications", &[]).unwrap();
            c.execute("INSERT INTO delphi_result_publications VALUES('generated-selection',$1,'generated-scope',$2)", &[&Z,&job_seed]).unwrap();
        }).await.unwrap();
        let (started, wait) = tokio::sync::oneshot::channel();
        let started = std::sync::Mutex::new(Some(started));
        let (release, receive) = std::sync::mpsc::channel();
        let receive = std::sync::Mutex::new(receive);
        let mut delayed = app(url, public);
        delayed
            .topic_selection_writer
            .as_mut()
            .unwrap()
            .after_mutation = Some(Arc::new(move || {
            // This hook runs only after Ok(Some(response)), never an SQL error
            // or a known no-write PUT. Its entry therefore witnesses success.
            started.lock().unwrap().take().unwrap().send(()).unwrap();
            receive
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }));
        let delayed = Arc::new(delayed);
        let task_state = delayed.clone();
        let mut marked = case.clone();
        marked["request"]["selections"] = selections.clone();
        let req = request(&marked, key);
        let task = tokio::spawn(async move { route::handle(task_state, req).await });
        tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .unwrap()
            .unwrap();
        assert_selection(url, Some((&selections, &job))).await;
        if lose_caller {
            task.abort();
            assert!(matches!(task.await,Err(e) if e.is_cancelled()));
        } else {
            assert_eq!(task.await.unwrap().status, 500);
        }
        assert_selection(url, Some((&selections, &job))).await;
        release.send(()).unwrap();
        wait_pending(&delayed).await;
        assert_selection(url, Some((&selections, &job))).await;
    }
    // Lose the caller while PostgreSQL is inside the UPDATE, before commit.
    // A fixture-only trigger provides an observable PgSleep barrier; no live
    // schema or serving path is modified. Detached work must commit its marker.
    let setup_url = url.to_string();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
        c.batch_execute("CREATE FUNCTION park_selection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$; CREATE TRIGGER park_selection BEFORE UPDATE ON topic_agenda_selections FOR EACH ROW EXECUTE FUNCTION park_selection(); UPDATE delphi_result_publications SET job_id='in-flight-job';").unwrap();
    }).await.unwrap();
    let in_flight = Arc::new(app(url, public));
    let selections = json!(["in-flight-marker", "second", "third", "fourth"]);
    let mut marked = case.clone();
    marked["request"]["selections"] = selections.clone();
    let req = request(&marked, key);
    let task_state = in_flight.clone();
    let task = tokio::spawn(async move { route::handle(task_state, req).await });
    let inspect = url.to_string();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&inspect, postgres::NoTls).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if c.query_one("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep' AND query LIKE 'INSERT INTO topic_agenda_selections%')", &[]).unwrap().get::<_,bool>(0) { break; }
            assert!(std::time::Instant::now() < deadline, "mutation never entered PostgreSQL barrier");
            std::thread::sleep(Duration::from_millis(1));
        }
        let row=c.query_one("SELECT archetypal_selections::text FROM topic_agenda_selections WHERE zid=$1 AND pid=1", &[&Z]).unwrap();
        assert!(!row.get::<_,String>(0).contains("in-flight-marker"));
    }).await.unwrap();
    task.abort();
    assert!(matches!(task.await, Err(e) if e.is_cancelled()));
    wait_pending(&in_flight).await;
    assert_selection(url, Some((&selections, "in-flight-job"))).await;
    let clean = url.to_string();
    tokio::task::spawn_blocking(move || {
        let mut c=postgres::Client::connect(&clean,postgres::NoTls).unwrap();
        c.batch_execute("DROP TRIGGER park_selection ON topic_agenda_selections; DROP FUNCTION park_selection()").unwrap();
    }).await.unwrap();
    println!(
        "late-write witnesses: unique JSON/count/job after deadline, after caller loss, and after observed in-flight PostgreSQL caller loss"
    );
}

async fn wait_pending(state: &App) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while state
        .topic_selection_writer
        .as_ref()
        .unwrap()
        .pending
        .available_permits()
        != 8
    {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
async fn assert_selection(url: &str, expected: Option<(&Value, &str)>) {
    let url = url.to_owned();
    let expected = expected.map(|(v, j)| (v.clone(), j.to_owned()));
    tokio::task::spawn_blocking(move || {
        let mut c=postgres::Client::connect(&url,postgres::NoTls).unwrap();
        let rows=c.query("SELECT archetypal_selections::text,total_selections,delphi_job_id FROM topic_agenda_selections WHERE zid=$1 AND pid=1", &[&Z]).unwrap();
        if let Some((value,job))=expected {
            assert_eq!(rows.len(),1);
            assert_eq!(serde_json::from_str::<Value>(&rows[0].get::<_,String>(0)).unwrap(),value);
            assert_eq!(rows[0].get::<_,i32>(1),value.as_array().unwrap().len() as i32);
            assert_eq!(rows[0].get::<_,String>(2),job);
        } else { assert!(rows.is_empty()); }
    }).await.unwrap();
}

fn node_request(method: &str, path: &str, token: &str, body: &str) -> (u16, Vec<u8>) {
    use std::io::{Read, Write};
    let address =
        std::env::var("POLIS_SELECTION_NODE_ADDRESS").expect("local Node fixture required");
    assert!(address.starts_with("127.0.0.1:"));
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nX-Forwarded-Proto: https\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(head.as_bytes()).unwrap();
    let mut bytes = Vec::new();
    let mut block = [0u8; 4096];
    loop {
        let n = socket.read(&mut block).unwrap();
        assert!(n > 0, "incomplete Node response");
        bytes.extend_from_slice(&block[..n]);
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut response = httparse::Response::new(&mut headers);
        if let httparse::Status::Complete(offset) = response.parse(&bytes).unwrap() {
            let len = response
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("content-length"))
                .map(|h| {
                    std::str::from_utf8(h.value)
                        .unwrap()
                        .parse::<usize>()
                        .unwrap()
                })
                .unwrap();
            if bytes.len() >= offset + len {
                return (response.code.unwrap(), bytes[offset..offset + len].to_vec());
            }
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the unchanged Node characterization companion and released test schema"]
async fn mixed_node_and_rust_same_key() {
    let (status, raw) = tokio::task::spawn_blocking(|| node_request("GET", "/fixture", "", ""))
        .await
        .unwrap();
    assert_eq!(status, 200);
    let fixture: Value = serde_json::from_slice(&raw).unwrap();
    let token = fixture["token"].as_str().unwrap().to_owned();
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let state = Arc::new(app(&url, fixture["publicKey"].as_str().unwrap().as_bytes()));
    let make = |method: &str, marker: &str| Request {
        method: method.into(),
        target: contract::PATH.into(),
        headers: Headers::from_raw([
            ("host", "localhost"),
            ("origin", "https://localhost"),
            ("x-forwarded-proto", "https"),
            ("content-type", "application/json"),
            ("authorization", &format!("Bearer {token}")),
        ]),
        body: serde_json::to_vec(&json!({"conversation_id":CID,"selections":[marker]})).unwrap(),
    };
    assert_eq!(
        route::handle(state.clone(), make("POST", "initial"))
            .await
            .status,
        200
    );
    let mut same_method = 0;
    for method in ["POST", "PUT", "DELETE"] {
        let mut pending = Vec::new();
        for n in 0..6 {
            let req = make(method, &format!("rust-{n}"));
            let state = state.clone();
            pending.push(tokio::spawn(async move {
                route::handle(state, req).await.status
            }));
            let token = token.clone();
            let body =
                json!({"conversation_id":CID,"selections":[format!("node-{n}")]}).to_string();
            pending.push(tokio::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    node_request(method, contract::PATH, &token, &body).0
                })
                .await
                .unwrap()
            }));
        }
        for task in pending {
            assert_eq!(task.await.unwrap(), 200);
            same_method += 1;
        }
    }
    assert_eq!(same_method, 36);
    println!("same-method concurrent Node/Rust responses: {same_method}");
    // Both requests enter observed pre-SQL barriers before either is released.
    // Exercise each different-method pairing in both commit orderings. These
    // are overlapping Node/Rust requests, not separate same-method waves.
    let mut completed = 0;
    for (rust_method, node_method) in [
        ("PUT", "DELETE"),
        ("PUT", "POST"),
        ("POST", "DELETE"),
        ("DELETE", "PUT"),
        ("POST", "PUT"),
        ("DELETE", "POST"),
    ] {
        for rust_first in [true, false] {
            let seed_url = url.clone();
            tokio::task::spawn_blocking(move || {
                let mut c=postgres::Client::connect(&seed_url,postgres::NoTls).unwrap();
                c.execute("DELETE FROM topic_agenda_selections WHERE zid=$1", &[&Z]).unwrap();
                c.execute("INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,total_selections,delphi_job_id) VALUES($1,1,'[\"initial\"]',1,'generated-old')", &[&Z]).unwrap();
            }).await.unwrap();
            let initial = json!(["initial"]);
            let rust_value = json!([
                format!("rust-{rust_method}-{node_method}-{rust_first}"),
                "rust-second"
            ]);
            let node_value = json!([
                format!("node-{rust_method}-{node_method}-{rust_first}"),
                "node-second",
                "node-third"
            ]);
            fixture_control("arm").await;
            let (entered, wait) = tokio::sync::oneshot::channel();
            let entered = std::sync::Mutex::new(Some(entered));
            let (release, receive) = std::sync::mpsc::channel();
            let receive = std::sync::Mutex::new(receive);
            let mut controlled = app(&url, fixture["publicKey"].as_str().unwrap().as_bytes());
            controlled
                .topic_selection_writer
                .as_mut()
                .unwrap()
                .before_mutation = Some(Arc::new(move || {
                entered.lock().unwrap().take().unwrap().send(()).unwrap();
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }));
            let mut req = make(rust_method, "unused");
            req.body = serde_json::to_vec(&json!({"conversation_id":CID,"selections":rust_value}))
                .unwrap();
            let rust_task =
                tokio::spawn(async move { route::handle(Arc::new(controlled), req).await });
            let node_token = token.clone();
            let node_body = json!({"conversation_id":CID,"selections":node_value}).to_string();
            let node_task = tokio::task::spawn_blocking(move || {
                node_request(node_method, contract::PATH, &node_token, &node_body)
            });
            tokio::time::timeout(Duration::from_secs(5), wait)
                .await
                .unwrap()
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let status = fixture_control("status").await;
                if status["entered"] == true {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "Node never entered mutation barrier"
                );
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            assert_selection(&url, Some((&initial, "generated-old"))).await;
            // Check every hand-back against an all-column durable snapshot;
            // the other writer stays parked until this request has completed.
            if rust_first {
                release.send(()).unwrap();
                let out = rust_task.await.unwrap();
                check_mixed_response(
                    rust_method,
                    true,
                    false,
                    out.status,
                    &bytes(out.body),
                    &rust_value,
                );
                assert_selection(
                    &url,
                    if rust_method == "DELETE" {
                        None
                    } else {
                        Some((&rust_value, "generated-old"))
                    },
                )
                .await;
                fixture_control("release").await;
                let (status, body) = node_task.await.unwrap();
                check_mixed_response(
                    node_method,
                    rust_method != "DELETE",
                    true,
                    status,
                    &body,
                    &node_value,
                );
                assert_mixed_final(&url, node_method, &node_value, rust_method == "DELETE").await;
            } else {
                fixture_control("release").await;
                let (status, body) = node_task.await.unwrap();
                check_mixed_response(node_method, true, true, status, &body, &node_value);
                assert_selection(
                    &url,
                    if node_method == "DELETE" {
                        None
                    } else {
                        Some((&node_value, "generated-old"))
                    },
                )
                .await;
                let before = snapshot_async(&url).await;
                release.send(()).unwrap();
                let out = rust_task.await.unwrap();
                check_mixed_response(
                    rust_method,
                    node_method != "DELETE",
                    false,
                    out.status,
                    &bytes(out.body),
                    &rust_value,
                );
                if out.status == 502 {
                    assert_eq!(
                        snapshot_async(&url).await,
                        before,
                        "hand-back mutated durable state"
                    );
                } else {
                    assert_mixed_final(&url, rust_method, &rust_value, node_method == "DELETE")
                        .await;
                }
            }
            completed += 2;
            println!(
                "forced mixed: Rust {rust_method} / Node {node_method}; rust_first={rust_first}; both entered; exact response and JSON/count/job verified"
            );
        }
    }
    // Force Node PUT's empty UPDATE, then a competing Rust POST, then Node's
    // separate INSERT. Preserve Node's duplicate error and the Rust row.
    assert_eq!(
        route::handle(state.clone(), make("DELETE", "clear-gap"))
            .await
            .status,
        200
    );
    fixture_control("arm-empty-put").await;
    let node_token = token.clone();
    let node_body = json!({"conversation_id":CID,"selections":["node-gap"]}).to_string();
    let node_gap = tokio::task::spawn_blocking(move || {
        node_request("PUT", contract::PATH, &node_token, &node_body)
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while fixture_control("status").await["entered"] != true {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let gap_value = json!(["rust-gap"]);
    let out = route::handle(state.clone(), make("POST", "rust-gap")).await;
    check_mixed_response(
        "POST",
        false,
        false,
        out.status,
        &bytes(out.body),
        &gap_value,
    );
    assert_mixed_final(&url, "POST", &gap_value, true).await;
    let before = snapshot_async(&url).await;
    fixture_control("release").await;
    let (status, body) = node_gap.await.unwrap();
    assert_eq!(status, 500);
    assert_eq!(
        body,
        serde_json::to_vec(&Response::failure(Method::Put)).unwrap()
    );
    assert_eq!(before, snapshot_async(&url).await);
    println!(
        "forced empty Node PUT / Rust POST / Node INSERT: exact 500, Rust marker/count/null attribution unchanged"
    );
    // Restore a known absent row for the explicit Node-created control.
    assert_eq!(
        route::handle(state.clone(), make("DELETE", "clear"))
            .await
            .status,
        200
    );
    // Missing-row PUT must hand back without inserting; the real Node route
    // then owns its update-then-insert and its created response.
    assert_eq!(
        route::handle(state.clone(), make("PUT", "missing"))
            .await
            .status,
        502
    );
    let check = url.clone();
    assert_eq!(
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&check, postgres::NoTls).unwrap();
            c.query_one(
                "SELECT count(*) FROM topic_agenda_selections WHERE zid=$1 AND pid=1",
                &[&Z],
            )
            .unwrap()
            .get::<_, i64>(0)
        })
        .await
        .unwrap(),
        0
    );
    let body = json!({"conversation_id":CID,"selections":["node-created"]}).to_string();
    let node_token = token.clone();
    let (status, body) = tokio::task::spawn_blocking(move || {
        node_request("PUT", contract::PATH, &node_token, &body)
    })
    .await
    .unwrap();
    assert_eq!(status, 200);
    assert!(
        String::from_utf8(body)
            .unwrap()
            .contains("created successfully")
    );
    assert_eq!(
        route::handle(state.clone(), make("POST", "final"))
            .await
            .status,
        200
    );
    tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&url,postgres::NoTls).unwrap();let row=c.query_one("SELECT archetypal_selections::text,total_selections FROM topic_agenda_selections WHERE zid=$1 AND pid=1",&[&Z]).unwrap();assert_eq!(row.get::<_,String>(0),"[\"final\"]");assert_eq!(row.get::<_,i32>(1),1);}).await.unwrap();
    println!(
        "mixed Node/Rust: {completed} forced cross-method responses; missing PUT handback unchanged; Node creation and final Rust row verified"
    );
}

async fn fixture_control(action: &str) -> Value {
    let path = format!("/fixture/{action}");
    let (status, body) = tokio::task::spawn_blocking(move || node_request("GET", &path, "", ""))
        .await
        .unwrap();
    assert_eq!(status, 200);
    serde_json::from_slice(&body).unwrap()
}
async fn snapshot_async(url: &str) -> Value {
    let url = url.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        snapshot(&mut c)
    })
    .await
    .unwrap()
}
fn check_mixed_response(
    method: &str,
    existed: bool,
    node: bool,
    status: u16,
    body: &[u8],
    value: &Value,
) {
    if method == "PUT" && !existed && !node {
        assert_eq!(status, 502);
        return;
    }
    assert_eq!(status, 200);
    let message = match method {
        "POST" => SuccessMessage::Saved,
        "PUT" if existed => SuccessMessage::Updated,
        "PUT" => SuccessMessage::Created,
        "DELETE" if existed => SuccessMessage::Deleted,
        "DELETE" => SuccessMessage::Absent,
        _ => unreachable!(),
    };
    let data = (method != "DELETE").then(|| Data {
        conversation_id: Z.to_string(),
        participant_id: "1".into(),
        selections_count: contract::SelectionCount::Integer(value.as_array().unwrap().len() as i32),
        job_id: existed.then(|| "generated-old".into()),
    });
    assert_eq!(
        body,
        serde_json::to_vec(&Response::success(message, data)).unwrap()
    );
}
async fn assert_mixed_final(url: &str, method: &str, value: &Value, was_absent: bool) {
    if method == "DELETE" {
        assert_selection(url, None).await;
        return;
    }
    if !was_absent {
        assert_selection(url, Some((value, "generated-old"))).await;
        return;
    }
    let url = url.to_owned();
    let value = value.clone();
    tokio::task::spawn_blocking(move || {
        let mut c=postgres::Client::connect(&url,postgres::NoTls).unwrap();
        let rows=c.query("SELECT archetypal_selections::text,total_selections,delphi_job_id FROM topic_agenda_selections WHERE zid=$1 AND pid=1",&[&Z]).unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(serde_json::from_str::<Value>(&rows[0].get::<_,String>(0)).unwrap(),value);
        assert_eq!(rows[0].get::<_,i32>(1),value.as_array().unwrap().len() as i32);
        assert!(rows[0].get::<_,Option<String>>(2).is_none());
    }).await.unwrap();
}
