//! The live vote writer's first contact: a first vote with no token and no
//! external id. Asked through the whole route, with the switch off (handed
//! back exactly as before) and on (refused first with nothing written, or a
//! user, a participant and the vote written, and the token in the reply),
//! against a database built from the published migrations.
use super::{database::Database, *};
use crate::http::{Body, Headers};
use crate::votes::{StorageConvention, VoteChoice};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

struct Stage {
    db: Database,
    private: String,
    public: String,
}

/// Owner 9 owns both conversations. Conversation 1 (`2plain`) is open, with
/// members 2 and 3 as participants 0 and 1; conversation 5 (`2closed`) is
/// closed.
fn stage(label: &str) -> Stage {
    let db = Database::new(label);
    db.connect()
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS oidc_user_mappings(uid integer);
             INSERT INTO users(uid) VALUES (9),(2),(3);
             SELECT setval(pg_get_serial_sequence('users','uid'), 100);
             INSERT INTO conversations(zid,owner,is_active,modified) VALUES (1,9,true,0);
             INSERT INTO conversations(zid,owner,is_active,modified) VALUES (5,9,false,0);
             INSERT INTO zinvites(zid,zinvite) VALUES (1,'2plain'),(5,'2closed');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES (1,0,2,0),(1,1,3,0);
             ALTER TABLE participants ENABLE TRIGGER USER;",
        )
        .unwrap();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Stage {
        db,
        private: String::from_utf8(rsa.private_key_to_pem().unwrap()).unwrap(),
        public: String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap(),
    }
}

fn keys(stage: &Stage) -> polis_auth::keys::Keys {
    polis_auth::keys::Keys::from_environment(|name| match name {
        "JWT_PRIVATE_KEY" => Some(stage.private.clone().into()),
        "JWT_PUBLIC_KEY" => Some(stage.public.clone().into()),
        _ => None,
    })
    .unwrap()
}

/// The live writer with the identity switch on, and the first-contact switch
/// on or off.
fn app(stage: &Stage, rt: &tokio::runtime::Runtime, first_contact: bool) -> Arc<App> {
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
        verifier: participant::Verifier::new(stage.public.as_bytes(), "fixture", "fixture")
            .unwrap(),
        admins: vec![],
        priorities: Arc::default(),
        follow_on: Arc::new(FollowOnLane::default()),
        identity_no_write: true,
        first_contact: first_contact.then(|| FirstContact {
            pool: db::Pool::writer(connector(), first_contact_limits()),
            keys: Arc::new(keys(stage)),
            issuer: "fixture".into(),
            audience: "fixture".into(),
        }),
    });
    rt.block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let mut pools = vec![&writer.reads, &writer.pool, &writer.background.pool];
        if let Some(lane) = &writer.first_contact {
            pools.push(&lane.pool);
        }
        for pool in pools {
            pool.with(|c| Ok(c.simple_query("select 1").map(drop)?))
                .await
                .unwrap();
        }
    });
    Arc::new(app)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

fn vote(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    body: Value,
    token: Option<&str>,
) -> (u16, String) {
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
    let out = rt.block_on(crate::route::handle(app.clone(), request));
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

/// Node's `failJson` body.
fn node_refusal(status: u16, code: &str) -> String {
    format!(r#"{{"error":"{code}","message":"{code}","status":{status}}}"#)
}

fn agree() -> Option<i16> {
    Some(i16::try_from(StorageConvention::CURRENT.encode(VoteChoice::Agree)).unwrap())
}

/// Users, participants, extended rows and votes, counted.
fn rows(stage: &Stage) -> Vec<i64> {
    let mut c = stage.db.connect();
    ["users", "participants", "participants_extended", "votes"]
        .iter()
        .map(|table| {
            c.query_one(&format!("select count(*) from {table}"), &[])
                .unwrap()
                .get(0)
        })
        .collect()
}

/// The token Node's participant middleware issues to an anonymous member,
/// signed by the minter: `anon:<uid>` for this conversation.
fn member_token(stage: &Stage, uid: i32, pid: u32) -> String {
    polis_auth::participant_mint::mint(
        &keys(stage),
        polis_auth::participant_mint::Identity::anonymous(Uid(uid)),
        "2plain",
        polis_auth::Pid(pid),
        "fixture",
        "fixture",
        || (crate::clock::now_ms() / 1000.0) as u64,
    )
    .unwrap()
}

const AUTH_TAIL: &str = r#"","token_type":"Bearer","expires_in":31536000}}"#;

#[test]
fn a_first_vote_creates_a_participant_and_answers_with_its_token() {
    let stage = stage("first_contact_vote");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let before = rows(&stage);
    let (status, body) = vote(&rt, &app, ballot("2plain"), None);
    assert_eq!(status, 200, "{body}");
    // One user, its extended row and its participant, and the vote.
    let after = rows(&stage);
    assert_eq!(
        after,
        before.iter().map(|n| n + 1).collect::<Vec<_>>(),
        "users, participants, participants_extended, votes"
    );
    let mut c = stage.db.connect();
    let user = c
        .query_one(
            "select uid, hname, email, is_owner, site_owner from users order by uid desc limit 1",
            &[],
        )
        .unwrap();
    let uid: i32 = user.get(0);
    assert!(uid > 100, "a new user from the sequence");
    assert_eq!(user.get::<_, Option<String>>(1), None);
    assert_eq!(user.get::<_, Option<String>>(2), None);
    // The participant number comes from the trigger, under the
    // participant-number lock: the next after 0 and 1.
    let participant = c
        .query_one("select pid, zid from participants where uid=$1", &[&uid])
        .unwrap();
    assert_eq!(
        (participant.get::<_, i32>(0), participant.get::<_, i32>(1)),
        (2, 1)
    );
    assert_eq!(
        c.query_one(
            "select count(*) from participants_extended where zid=1 and uid=$1",
            &[&uid],
        )
        .unwrap()
        .get::<_, i64>(0),
        1
    );
    assert_eq!(
        c.query_opt(
            "select vote from votes_latest_unique where zid=1 and pid=2 and tid=7",
            &[],
        )
        .unwrap()
        .map(|row| row.get::<_, i16>(0)),
        agree()
    );
    // The reply: currentPid, then `auth` as its last key with Node's bytes.
    let value: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(value["currentPid"], json!(2));
    let start = body
        .find(r#","auth":{"token":""#)
        .expect("auth in the reply")
        + 18;
    assert!(body.ends_with(AUTH_TAIL), "{body}");
    let token = &body[start..body.len() - AUTH_TAIL.len()];
    let verified = keys(&stage)
        .verifier("fixture", "fixture")
        .unwrap()
        .verify(
            &format!("Bearer {token}"),
            "2plain",
            (crate::clock::now_ms() / 1000.0) as u64,
        )
        .expect("an anonymous participant token for this conversation");
    assert_eq!((verified.uid().0, verified.pid().0), (uid, 2));
    // Its token makes the caller a member: the same vote again creates nobody.
    let (status, body) = vote(&rt, &app, ballot("2plain"), Some(token));
    assert_eq!(status, 200, "{body}");
    assert!(
        !body.contains(r#""auth""#),
        "a member's reply carries no token"
    );
    assert_eq!(rows(&stage), after);
}

#[test]
fn a_first_contact_is_refused_first_with_nothing_written() {
    let stage = stage("first_contact_refused");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let before = rows(&stage);
    // A closed conversation: Node's 403, nobody created.
    assert_eq!(
        vote(&rt, &app, ballot("2closed"), None),
        (403, node_refusal(403, "polis_err_conversation_is_closed"))
    );
    // A malformed field: the bytes a member's malformed vote gets.
    let malformed = json!({"conversation_id": "2plain", "tid": 7, "vote": 5});
    let member = vote(
        &rt,
        &app,
        malformed.clone(),
        Some(&member_token(&stage, 2, 0)),
    );
    assert_eq!(member.0, 400, "{}", member.1);
    assert_eq!(vote(&rt, &app, malformed, None), member);
    // A statement number out of range is handed back before any write.
    let far = json!({"conversation_id": "2plain", "tid": 1_u64 << 40, "vote": 0});
    assert_eq!(vote(&rt, &app, far, None).0, 502);
    assert_eq!(rows(&stage), before);
}

#[test]
fn with_the_first_contact_switch_off_nothing_changes() {
    let stage = stage("first_contact_off");
    let rt = runtime();
    let off = app(&stage, &rt, false);
    let before = rows(&stage);
    // As at the commit before the switch: every first contact, closed and
    // malformed ones too, is handed back before its fields are read.
    for body in [
        ballot("2plain"),
        ballot("2closed"),
        json!({"conversation_id": "2plain", "tid": 7, "vote": 5}),
    ] {
        assert_eq!(vote(&rt, &off, body, None).0, 502);
    }
    assert_eq!(rows(&stage), before);
    let health = |app: &Arc<App>| {
        let Js::Obj(body) = health(app) else {
            unreachable!()
        };
        body.get("firstContactCommitUnknown").is_some()
    };
    assert!(
        !health(&off),
        "the health body is unchanged with the switch off"
    );
    assert!(health(&app(&stage, &rt, true)));
}

#[test]
fn a_first_contacts_admission_takes_only_its_own_pool() {
    let stage = stage("first_contact_pools");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let writer = app.post_votes.as_ref().unwrap();
    let lane = writer.first_contact.as_ref().unwrap();
    let snap = |pool: &Arc<db::Pool>| pool.evidence.snapshot();
    let pools = || {
        [
            snap(&writer.pool),
            snap(&writer.background.pool),
            snap(&writer.reads),
            snap(&lane.pool),
        ]
    };
    // Both of the first contact's connections held: it is handed back, and
    // no other pool lends it one.
    let mut held = vec![];
    for _ in 0..first_contact_limits().size {
        let (ready, wait) = std::sync::mpsc::channel();
        let (release, park) = std::sync::mpsc::channel::<()>();
        let pool = lane.pool.clone();
        let work = rt.spawn(async move {
            pool.with(move |_| {
                ready.send(()).unwrap();
                park.recv_timeout(Duration::from_secs(5))?;
                Ok(())
            })
            .await
        });
        wait.recv().unwrap();
        held.push((release, work));
    }
    let before = rows(&stage);
    let [append, notify, reads, own] = pools();
    assert_eq!(vote(&rt, &app, ballot("2plain"), None).0, 502);
    let [append2, notify2, reads2, own2] = pools();
    assert_eq!(append2, append, "the vote append pool");
    assert_eq!(notify2, notify, "the notification pool");
    // The admission reads pool serves only the read-only decision.
    assert_eq!(reads2[0], reads[0] + 1);
    assert_eq!(
        own2[2],
        own[2] + 1,
        "the first contact's own acquire timed out"
    );
    assert_eq!(own2[0], own[0]);
    assert_eq!(rows(&stage), before);
    for (release, work) in held {
        release.send(()).unwrap();
        rt.block_on(work).unwrap().unwrap();
    }
    // Free again: the creation takes its own pool once, and the vote takes
    // the append pool once, as a member's vote does.
    let [append, _, _, own] = pools();
    assert_eq!(vote(&rt, &app, ballot("2plain"), None).0, 200);
    let [append2, _, _, own2] = pools();
    assert_eq!(own2[0], own[0] + 1);
    assert_eq!(append2[0], append[0] + 1);
    // A member's vote never touches the first contact's pool.
    let (status, _) = vote(
        &rt,
        &app,
        ballot("2plain"),
        Some(&member_token(&stage, 3, 1)),
    );
    assert_eq!(status, 200);
    assert_eq!(snap(&lane.pool)[0], own2[0]);
}
