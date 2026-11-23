//! The live vote writer's identity switch: the identity cases that write
//! nothing. Each case is asked through the whole route, with the switch off
//! (handed back exactly as before) and on (served, or refused with Node's
//! bytes), against a database built from the published migrations.
use super::{database::Database, *};
use crate::http::{Body, Headers};
use crate::votes::{StorageConvention, VoteChoice};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

struct Stage {
    db: Database,
    key: EncodingKey,
    public: Vec<u8>,
}

/// Owner 9 owns every conversation. Users 2 to 5 are members: 2 by an
/// anonymous token, 3 by an external-id token for `x3`, 4 by a signed-in
/// account's participant token, 5 in a Treevite conversation. User 6 is an
/// owner account bound to the external id `x6`.
fn stage(label: &str) -> Stage {
    let db = Database::new(label);
    db.connect()
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS oidc_user_mappings(uid integer);
             INSERT INTO users(uid) VALUES (9),(2),(3),(4),(5);
             INSERT INTO users(uid,is_owner) VALUES (6,true);
             INSERT INTO conversations(zid,owner,is_active,modified) VALUES (1,9,true,0);
             INSERT INTO conversations(zid,owner,is_active,modified,use_xid_whitelist,xid_required)
               VALUES (2,9,true,0,true,true);
             INSERT INTO conversations(zid,owner,is_active,modified,treevite_enabled)
               VALUES (3,9,true,0,true);
             INSERT INTO conversations(zid,owner,is_active,modified,xid_required)
               VALUES (4,9,true,0,true);
             INSERT INTO zinvites(zid,zinvite) VALUES
               (1,'2plain'),(2,'2listed'),(3,'2tree'),(4,'2required');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES
               (1,0,2,0),(1,1,3,0),(1,2,4,0),(2,0,2,0),(2,1,3,0),(3,0,5,0);
             ALTER TABLE participants ENABLE TRIGGER USER;
             INSERT INTO xids(uid,owner,xid) VALUES (3,9,'x3'),(6,9,'x6');",
        )
        .unwrap();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Stage {
        db,
        key: EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        public: rsa.public_key_to_pem().unwrap(),
    }
}

/// The live writer, with or without the identity switch, and its pools warm.
fn app(stage: &Stage, identity_no_write: bool) -> Arc<App> {
    let connector = || Connector::Plain(Box::new(stage.db.config.clone()));
    let limits = db::Limits {
        size: 4,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_secs(1),
        max_lifetime: Duration::from_secs(300),
    };
    let cfg = config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: limits.clone(),
    };
    let mut app = App::new(&cfg, db::Pool::new(connector(), read_limits()));
    app.post_votes = Some(Writer {
        pool: db::Pool::writer(connector(), limits.clone()),
        reads: db::Pool::new(connector(), read_limits()),
        background: NotificationPool::new(db::Pool::writer(
            connector(),
            db::Limits { size: 2, ..limits },
        )),
        verifier: participant::Verifier::new(&stage.public, "fixture", "fixture").unwrap(),
        admins: vec![],
        priorities: Arc::default(),
        follow_on: Arc::new(FollowOnLane::default()),
        identity_no_write,
    });
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        for pool in [&writer.reads, &writer.pool, &writer.background.pool] {
            pool.with(|c| Ok(c.simple_query("select 1").map(drop)?))
                .await
                .unwrap();
        }
    });
    Arc::new(app)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A participant token of one of the three kinds Node issues.
fn token(stage: &Stage, uid: i32, pid: i32, cid: &str, kind: &str) -> String {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let mut claims = json!({
        "uid": uid, "pid": pid, "conversation_id": cid,
        "iss": "fixture", "aud": "fixture", "exp": now + 3600, "iat": now,
    });
    let extra = match kind {
        "anonymous" => json!({"sub": format!("anon:{uid}"), "anonymous_participant": true}),
        "xid" => json!({"sub": "xid:x3", "xid_participant": true, "xid": "x3"}),
        "standard" => {
            json!({"sub": "user:s4", "standard_user_participant": true, "oidc_sub": "s4"})
        }
        _ => unreachable!(),
    };
    for (k, v) in extra.as_object().unwrap() {
        claims[k] = v.clone();
    }
    encode(&Header::new(Algorithm::RS256), &claims, &stage.key).unwrap()
}

fn vote(app: &Arc<App>, body: Value, token: Option<&str>) -> (u16, String) {
    let mut request = req(&body.to_string());
    let bearer = token.map(|t| format!("Bearer {t}"));
    let mut headers = vec![
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
    ];
    if let Some(bearer) = &bearer {
        headers.push(("authorization", bearer));
    }
    request.headers = Headers::from_raw(headers);
    let out = runtime().block_on(crate::route::handle(app.clone(), request));
    let body = match &out.body {
        Body::Empty => String::new(),
        Body::Fixed(bytes) => String::from_utf8(bytes.clone()).unwrap(),
        Body::Chunked(chunks) => String::from_utf8(chunks.concat()).unwrap(),
    };
    (out.status, body)
}

fn ballot(cid: &str) -> Value {
    json!({"conversation_id": cid, "tid": 7, "vote": crate::votes::WIRE_AGREE})
}

/// Node's `failJson` body for a refusal its participant middleware answers.
fn node_refusal(status: u16, code: &str) -> String {
    format!(r#"{{"error":"{code}","message":"{code}","status":{status}}}"#)
}

/// The stored agree, read through the convention, never a literal sign.
fn stored(stage: &Stage, zid: i32, pid: i32) -> Option<i16> {
    stage
        .db
        .connect()
        .query_opt(
            "select vote from votes_latest_unique where zid=$1 and pid=$2 and tid=7",
            &[&zid, &pid],
        )
        .unwrap()
        .map(|row| row.get(0))
}

fn agree() -> Option<i16> {
    Some(i16::try_from(StorageConvention::CURRENT.encode(VoteChoice::Agree)).unwrap())
}

/// Users, participants, external-id bindings and votes, counted.
fn rows(stage: &Stage) -> Vec<i64> {
    let mut c = stage.db.connect();
    ["users", "participants", "xids", "votes"]
        .iter()
        .map(|table| {
            c.query_one(&format!("select count(*) from {table}"), &[])
                .unwrap()
                .get(0)
        })
        .collect()
}

#[test]
fn with_the_identity_switch_off_every_new_case_is_handed_back() {
    let stage = stage("identity_off");
    let app = app(&stage, false);
    let before = rows(&stage);
    let xid = token(&stage, 3, 1, "2plain", "xid");
    let anonymous = token(&stage, 2, 0, "2plain", "anonymous");
    let listed = token(&stage, 2, 0, "2listed", "anonymous");
    let tree = token(&stage, 5, 0, "2tree", "anonymous");
    let mut named = ballot("2plain");
    named["xid"] = json!("someone");
    for (body, token) in [
        (ballot("2plain"), Some(xid.as_str())),
        (named, Some(anonymous.as_str())),
        (ballot("2listed"), Some(listed.as_str())),
        (ballot("2tree"), Some(tree.as_str())),
        (ballot("2required"), None),
    ] {
        assert_eq!(vote(&app, body, token).0, 502);
    }
    assert_eq!(rows(&stage), before, "a hand-back writes nothing");
}

#[test]
fn an_external_id_tokens_member_votes_and_is_checked_on_every_vote() {
    let stage = stage("identity_xid_member");
    let app = app(&stage, true);
    let xid = token(&stage, 3, 1, "2plain", "xid");
    assert_eq!(vote(&app, ballot("2plain"), Some(&xid)).0, 200);
    assert_eq!(stored(&stage, 1, 1), agree());
    // The same token, naming another external id: Node resolves that one.
    let mut other = ballot("2plain");
    other["xid"] = json!("x9");
    assert_eq!(vote(&app, other, Some(&xid)).0, 502);
    // The owner's allow-list is read on every vote.
    let listed = token(&stage, 3, 1, "2listed", "xid");
    assert_eq!(
        vote(&app, ballot("2listed"), Some(&listed)),
        (403, node_refusal(403, "polis_err_xid_not_allowed"))
    );
    stage
        .db
        .connect()
        .batch_execute("INSERT INTO xid_whitelist(owner,xid) VALUES (9,'x3')")
        .unwrap();
    assert_eq!(vote(&app, ballot("2listed"), Some(&listed)).0, 200);
    // The signed user's account is checked first, as Node's hybrid auth does.
    stage
        .db
        .connect()
        .batch_execute("DELETE FROM xid_whitelist; UPDATE users SET is_owner=true WHERE uid=3")
        .unwrap();
    assert_eq!(
        vote(&app, ballot("2listed"), Some(&listed)),
        (403, node_refusal(403, "polis_err_xid_owner_account"))
    );
}

#[test]
fn external_id_keys_beside_a_member_token_are_dropped() {
    let stage = stage("identity_keys");
    let app = app(&stage, true);
    let before = rows(&stage);
    let anonymous = token(&stage, 2, 0, "2plain", "anonymous");
    let standard = token(&stage, 4, 2, "2plain", "standard");
    let mut named = ballot("2plain");
    for (key, value) in [
        ("xid", "someone"),
        ("x_name", "n"),
        ("x_email", "e"),
        ("x_profile_image_url", "u"),
    ] {
        named[key] = json!(value);
    }
    assert_eq!(vote(&app, named.clone(), Some(&anonymous)).0, 200);
    assert_eq!(vote(&app, named.clone(), Some(&standard)).0, 200);
    assert_eq!(stored(&stage, 1, 0), agree());
    assert_eq!(stored(&stage, 1, 2), agree());
    let after = rows(&stage);
    assert_eq!(after[..3], before[..3], "no user, participant or binding");
    // An external id Node's parser refuses, or one of whitespace, is Node's.
    for xid in [json!(""), json!("   "), json!("x".repeat(1000))] {
        named["xid"] = xid;
        assert_eq!(vote(&app, named.clone(), Some(&anonymous)).0, 502);
    }
}

#[test]
fn members_of_conversations_that_require_or_list_external_ids_vote() {
    let stage = stage("identity_required_member");
    let app = app(&stage, true);
    let member = token(&stage, 2, 0, "2listed", "anonymous");
    assert_eq!(vote(&app, ballot("2listed"), Some(&member)).0, 200);
    assert_eq!(stored(&stage, 2, 0), agree());
}

#[test]
fn a_treevite_member_votes_only_under_its_own_row() {
    let stage = stage("identity_treevite");
    let app = app(&stage, true);
    let member = token(&stage, 5, 0, "2tree", "anonymous");
    assert_eq!(vote(&app, ballot("2tree"), Some(&member)).0, 200);
    assert_eq!(stored(&stage, 3, 0), agree());
    // A token whose number is not its row's stays Node's.
    let other = token(&stage, 5, 4, "2tree", "anonymous");
    assert_eq!(vote(&app, ballot("2tree"), Some(&other)).0, 502);
}

#[test]
fn refusals_before_any_write_carry_nodes_bytes_and_write_nothing() {
    let stage = stage("identity_refusals");
    let app = app(&stage, true);
    let before = rows(&stage);
    let named = |cid: &str, xid: &str| {
        let mut body = ballot(cid);
        body["xid"] = json!(xid);
        body
    };
    // A malformed field does not matter: Node refuses before it parses one.
    let mut malformed = ballot("2required");
    malformed["vote"] = json!(5);
    for (body, status, code) in [
        (ballot("2required"), 403, "polis_err_xid_required"),
        (malformed, 403, "polis_err_xid_required"),
        (
            named("2listed", "unlisted"),
            403,
            "polis_err_xid_not_allowed",
        ),
        (ballot("2tree"), 401, "polis_err_treevite_auth_required"),
        (named("2plain", "x6"), 403, "polis_err_xid_owner_account"),
    ] {
        assert_eq!(vote(&app, body, None), (status, node_refusal(status, code)));
    }
    // A first contact writes, and stays Node's.
    assert_eq!(vote(&app, ballot("2plain"), None).0, 502);
    assert_eq!(vote(&app, named("2plain", "new"), None).0, 502);
    assert_eq!(rows(&stage), before, "a refusal writes nothing");
}

#[test]
fn identity_reads_never_take_the_vote_append_pools() {
    let stage = stage("identity_pools");
    let app = app(&stage, true);
    let writer = app.post_votes.as_ref().unwrap();
    let append = writer.pool.evidence.snapshot();
    let background = writer.background.pool.evidence.snapshot();
    let reads = writer.reads.evidence.snapshot();
    let listed = token(&stage, 3, 1, "2listed", "xid");
    assert_eq!(vote(&app, ballot("2required"), None).0, 403);
    assert_eq!(vote(&app, ballot("2listed"), Some(&listed)).0, 403);
    assert_eq!(writer.pool.evidence.snapshot(), append);
    assert_eq!(writer.background.pool.evidence.snapshot(), background);
    assert_eq!(
        writer.reads.evidence.snapshot()[0],
        reads[0] + 2,
        "each refusal is one admission read"
    );
    // A member's vote still takes the append pool, once.
    let xid = token(&stage, 3, 1, "2plain", "xid");
    assert_eq!(vote(&app, ballot("2plain"), Some(&xid)).0, 200);
    assert_eq!(writer.pool.evidence.snapshot()[0], append[0] + 1);
}
