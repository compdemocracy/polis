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
    app_with_lane_lifetime(stage, rt, first_contact, Duration::from_secs(300))
}

/// `app`, with the notification lane's connections kept for `lane_lifetime`.
fn app_with_lane_lifetime(
    stage: &Stage,
    rt: &tokio::runtime::Runtime,
    first_contact: bool,
    lane_lifetime: Duration,
) -> Arc<App> {
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
            db::Limits {
                size: 2,
                max_lifetime: lane_lifetime,
                ..limits
            },
        )),
        verifier: participant::Verifier::new(stage.public.as_bytes(), "fixture", "fixture")
            .unwrap(),
        admins: vec![],
        priorities: Arc::default(),
        follow_on: Arc::new(FollowOnLane::default()),
        identity_no_write: true,
        identity_reads: Some(db::Pool::new(connector(), identity_read_limits())),
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
    vote_with(rt, app, body, token, &[])
}

/// `vote`, with more request headers.
fn vote_with(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    body: Value,
    token: Option<&str>,
    extra: &[(&str, &str)],
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
    headers.extend_from_slice(extra);
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
    let identity = || {
        let writer = app.post_votes.as_ref().unwrap();
        writer.identity_reads.as_ref().unwrap().evidence.snapshot()
    };
    let [append, notify, reads, own] = pools();
    let decision = identity();
    assert_eq!(vote(&rt, &app, ballot("2plain"), None).0, 502);
    let [append2, notify2, reads2, own2] = pools();
    assert_eq!(append2, append, "the vote append pool");
    assert_eq!(notify2, notify, "the notification pool");
    // The read-only decision runs on the identity pool, never on a members'
    // admission slot.
    assert_eq!(reads2, reads, "the members' admission reads pool");
    assert_eq!(identity()[0], decision[0] + 1);
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

/// `stage`, and: conversation 6 (`2other`), open, with user 4 as its
/// participant 0; `2alias`, a second code of conversation 1.
fn stage_with_another(label: &str) -> Stage {
    let stage = stage(label);
    stage
        .db
        .connect()
        .batch_execute(
            "INSERT INTO users(uid) VALUES (4);
             INSERT INTO conversations(zid,owner,is_active,modified) VALUES (6,9,true,0);
             INSERT INTO zinvites(zid,zinvite) VALUES (6,'2other'),(1,'2alias');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES (6,0,4,0);
             ALTER TABLE participants ENABLE TRIGGER USER;",
        )
        .unwrap();
    stage
}

/// A token the minter signs, as Node's participant middleware issues it.
fn token_for(
    stage: &Stage,
    identity: polis_auth::participant_mint::Identity<'_>,
    cid: &str,
    pid: u32,
) -> String {
    polis_auth::participant_mint::mint(
        &keys(stage),
        identity,
        cid,
        polis_auth::Pid(pid),
        "fixture",
        "fixture",
        || (crate::clock::now_ms() / 1000.0) as u64,
    )
    .unwrap()
}

fn anonymous(uid: i32) -> polis_auth::participant_mint::Identity<'static> {
    polis_auth::participant_mint::Identity::anonymous(Uid(uid))
}

/// The token in a reply whose last key is `auth`, with Node's bytes:
/// `,"auth":{"token":"…","token_type":"Bearer","expires_in":31536000}}`.
fn reply_token(body: &str) -> &str {
    let start = body
        .find(r#","auth":{"token":""#)
        .unwrap_or_else(|| panic!("auth in the reply: {body}"))
        + 18;
    assert!(body.ends_with(AUTH_TAIL), "auth is the last key: {body}");
    &body[start..body.len() - AUTH_TAIL.len()]
}

/// The request identity a token carries for `2plain`: its kind, user,
/// participant and subject.
fn claims(stage: &Stage, token: &str) -> (participant::Kind, i32, u32, Option<String>) {
    let mut deferred = |_: Uid| Ok::<Option<xid_account::Account>, polis_auth::Unavailable>(None);
    let identity = keys(stage)
        .verifier("fixture", "fixture")
        .unwrap()
        .verify_for_request(
            &format!("Bearer {token}"),
            "2plain",
            None,
            (crate::clock::now_ms() / 1000.0) as u64,
            &mut xid_account::Check {
                db: &mut deferred,
                admin_uids: &[],
            },
        )
        .unwrap()
        .expect("a participant token");
    assert!(
        identity.same_conversation(),
        "a token for this conversation"
    );
    (
        identity.kind,
        identity.uid().unwrap().0,
        identity.pid().unwrap().0,
        identity.subject().map(str::to_owned),
    )
}

fn newest_user(stage: &Stage) -> i32 {
    stage
        .db
        .connect()
        .query_one("select max(uid) from users", &[])
        .unwrap()
        .get(0)
}

#[test]
fn a_failure_after_creation_carries_the_token() {
    let stage = stage("first_contact_failure_auth");
    // The vote's own statement fails after the person is committed: a
    // unique violation on statement 7 (Node's 406), any other error on
    // statement 8 (Node's 500).
    stage
        .db
        .connect()
        .batch_execute(
            "CREATE FUNCTION refuse_vote() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.tid = 7 THEN RAISE EXCEPTION 'fixture' USING ERRCODE = 'unique_violation'; END IF;
               IF NEW.tid = 8 THEN RAISE EXCEPTION 'fixture'; END IF;
               RETURN NEW;
             END $$;
             CREATE TRIGGER refuse_vote BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION refuse_vote();",
        )
        .unwrap();
    let rt = runtime();
    let app = app(&stage, &rt, true);
    // A member's failure: Node's three keys, no token.
    let member = member_token(&stage, 2, 0);
    assert_eq!(
        vote(&rt, &app, ballot("2plain"), Some(&member)),
        (406, node_refusal(406, "polis_err_vote_duplicate"))
    );
    for (tid, status, code, pid) in [
        (7, 406, "polis_err_vote_duplicate", 2),
        (8, 500, "polis_err_vote", 3),
    ] {
        let before = rows(&stage);
        let body =
            json!({"conversation_id": "2plain", "tid": tid, "vote": crate::votes::WIRE_AGREE});
        let (got, reply) = vote(&rt, &app, body, None);
        assert_eq!(got, status, "{reply}");
        // The person was created; the vote was not.
        let after = rows(&stage);
        assert_eq!(
            after,
            vec![before[0] + 1, before[1] + 1, before[2] + 1, before[3]],
            "users, participants, participants_extended, votes"
        );
        let token = reply_token(&reply);
        assert_eq!(
            reply,
            format!(
                r#"{{"error":"{code}","message":"{code}","status":{status},"auth":{{"token":"{token}{AUTH_TAIL}"#
            )
        );
        assert_eq!(
            claims(&stage, token),
            (participant::Kind::Anonymous, newest_user(&stage), pid, None)
        );
        let decoded = contract::Response::decode(status, reply.as_bytes()).unwrap();
        assert!(matches!(decoded, contract::Response::Failure(f) if f.auth.is_some()));
    }
}

#[test]
fn a_receipt_of_unknown_acceptance_carries_the_token() {
    let stage = stage("first_contact_unknown_auth");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let writer = app.post_votes.as_ref().unwrap();
    // Every vote append connection held past the reply deadline: the vote is
    // dispatched and waits, and the reply is the 202 receipt.
    let mut held = vec![];
    for _ in 0..4 {
        let (ready, wait) = std::sync::mpsc::channel();
        let (release, park) = std::sync::mpsc::channel::<()>();
        let pool = writer.pool.clone();
        let work = rt.spawn(async move {
            pool.with(move |_| {
                ready.send(()).unwrap();
                park.recv_timeout(Duration::from_secs(10))?;
                Ok(())
            })
            .await
        });
        wait.recv().unwrap();
        held.push((release, work));
    }
    let before = rows(&stage);
    let (status, body) = vote(&rt, &app, ballot("2plain"), None);
    assert_eq!(status, 202, "{body}");
    let token = reply_token(&body).to_owned();
    assert_eq!(
        body,
        format!(
            r#"{{"acceptance":"unknown","retry":"same_vote","auth":{{"token":"{token}{AUTH_TAIL}"#
        )
    );
    assert!(
        contract::UnknownAcceptance::decode(body.as_bytes())
            .unwrap()
            .auth
            .is_some()
    );
    let uid = newest_user(&stage);
    assert_eq!(
        claims(&stage, &token),
        (participant::Kind::Anonymous, uid, 2, None)
    );
    for (release, work) in held {
        release.send(()).unwrap();
        rt.block_on(work).unwrap().unwrap();
    }
    // The dispatched vote lands for the participant the token names.
    let mut c = stage.db.connect();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while c
        .query_opt(
            "select vote from votes_latest_unique where zid=1 and pid=2 and tid=7",
            &[],
        )
        .unwrap()
        .is_none()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the vote never landed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        rows(&stage),
        before.iter().map(|n| n + 1).collect::<Vec<_>>()
    );
    // Sent again with its token, the same vote creates nobody.
    let (status, body) = vote(&rt, &app, ballot("2plain"), Some(&token));
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains(r#""auth""#));
    assert_eq!(rows(&stage)[0], before[0] + 1);
}

#[test]
fn an_anonymous_token_for_another_conversation_is_a_new_person() {
    let stage = stage_with_another("first_contact_other_anonymous");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    // A token for another conversation, and one for a code that names
    // nothing (another conversation too, as Node counts it): each a new
    // user, participant and vote, and a token for this conversation.
    for (cid, pid) in [("2other", 2), ("2gone", 3)] {
        let before = rows(&stage);
        let presented = token_for(&stage, anonymous(4), cid, 0);
        let (status, body) = vote(&rt, &app, ballot("2plain"), Some(&presented));
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            rows(&stage),
            before.iter().map(|n| n + 1).collect::<Vec<_>>()
        );
        let uid = newest_user(&stage);
        assert!(uid > 100, "a new user, not the token's");
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["currentPid"], json!(pid));
        assert_eq!(
            claims(&stage, reply_token(&body)),
            (participant::Kind::Anonymous, uid, pid, None)
        );
    }
    // A token for another code of this conversation is this conversation's:
    // handed back, nobody created.
    let before = rows(&stage);
    let alias = token_for(&stage, anonymous(2), "2alias", 0);
    assert_eq!(vote(&rt, &app, ballot("2plain"), Some(&alias)).0, 502);
    // With an external id named, it stays Node's.
    let other = token_for(&stage, anonymous(4), "2other", 0);
    let named = json!({"conversation_id": "2plain", "tid": 7, "vote": 0, "xid": "x-1"});
    assert_eq!(vote(&rt, &app, named, Some(&other)).0, 502);
    assert_eq!(rows(&stage), before);
}

#[test]
fn an_accounts_token_for_another_conversation_keeps_its_user() {
    let stage = stage_with_another("first_contact_other_account");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let account = |uid: i32, cid: &str| {
        token_for(
            &stage,
            polis_auth::participant_mint::Identity::standard_user(Uid(uid), "auth0|fixture")
                .unwrap(),
            cid,
            0,
        )
    };
    let before = rows(&stage);
    let (status, body) = vote(&rt, &app, ballot("2plain"), Some(&account(4, "2other")));
    assert_eq!(status, 200, "{body}");
    // No user; a participant, its extended row and the vote.
    assert_eq!(
        rows(&stage),
        vec![before[0], before[1] + 1, before[2] + 1, before[3] + 1]
    );
    let mut c = stage.db.connect();
    assert_eq!(
        c.query_one("select pid from participants where zid=1 and uid=4", &[])
            .unwrap()
            .get::<_, i32>(0),
        2
    );
    let token = reply_token(&body).to_owned();
    assert_eq!(
        claims(&stage, &token),
        (
            participant::Kind::StandardUser,
            4,
            2,
            Some("auth0|fixture".into())
        )
    );
    // Its new token makes it a member: no token in the reply, nobody new.
    let after = rows(&stage);
    let (status, body) = vote(&rt, &app, ballot("2plain"), Some(&token));
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains(r#""auth""#));
    assert_eq!(rows(&stage), after);
    // An account that is already a participant here, or a token for another
    // code of this conversation: handed back, nothing written.
    assert_eq!(
        vote(&rt, &app, ballot("2plain"), Some(&account(2, "2other"))).0,
        502
    );
    assert_eq!(
        vote(&rt, &app, ballot("2plain"), Some(&account(4, "2alias"))).0,
        502
    );
    assert_eq!(rows(&stage), after);
}

#[test]
fn with_the_first_contact_switch_off_tokens_for_another_conversation_are_handed_back() {
    let stage = stage_with_another("first_contact_other_off");
    let rt = runtime();
    let off = app(&stage, &rt, false);
    let before = rows(&stage);
    for presented in [
        token_for(&stage, anonymous(4), "2other", 0),
        token_for(
            &stage,
            polis_auth::participant_mint::Identity::standard_user(Uid(4), "auth0|fixture").unwrap(),
            "2other",
            0,
        ),
    ] {
        assert_eq!(vote(&rt, &off, ballot("2plain"), Some(&presented)).0, 502);
    }
    assert_eq!(rows(&stage), before);
}

/// With the first-contact switch on, a request with no token into a
/// Treevite conversation is still not a first contact Rust answers: with no
/// external id, or one bound to nobody, Node creates a user before its
/// Treevite refusal, so the request is handed back; with an external id
/// bound to an ordinary user Node creates nobody and its 401 is answered.
/// Nothing is written in any case.
#[test]
fn with_the_first_contact_switch_on_a_tokenless_treevite_request_is_not_created() {
    let stage = stage("first_contact_treevite");
    stage
        .db
        .connect()
        .batch_execute(
            "INSERT INTO conversations(zid,owner,is_active,modified,treevite_enabled)
               VALUES (3,9,true,0,true);
             INSERT INTO zinvites(zid,zinvite) VALUES (3,'2tree');
             INSERT INTO xids(uid,owner,xid) VALUES (3,9,'x3');",
        )
        .unwrap();
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let xids = || -> i64 {
        stage
            .db
            .connect()
            .query_one("select count(*) from xids", &[])
            .unwrap()
            .get(0)
    };
    let (before, bound) = (rows(&stage), xids());
    let named = |xid: &str| {
        let mut body = ballot("2tree");
        body["xid"] = json!(xid);
        body
    };
    assert_eq!(
        vote(&rt, &app, ballot("2tree"), None).0,
        502,
        "no external id"
    );
    assert_eq!(
        vote(&rt, &app, named("unbound"), None).0,
        502,
        "an unbound one"
    );
    assert_eq!(
        vote(&rt, &app, named("x3"), None),
        (401, node_refusal(401, "polis_err_treevite_auth_required")),
        "an external id bound to an ordinary user"
    );
    assert_eq!(rows(&stage), before, "nothing is created");
    assert_eq!(xids(), bound, "no external id is bound");
}

/// `stage`, with the published migration that adds the extended row's
/// `origin` column (the fixture database applies only the migrations the
/// vote writer's other tests need).
fn stage_with_origin(label: &str) -> Stage {
    let stage = stage(label);
    stage
        .db
        .connect()
        .batch_execute(include_str!(
            "../../../server/postgres/migrations/000003_add_origin_permanent_cookie_columns.sql"
        ))
        .unwrap();
    stage
}

/// Waits until the notification lane has finished everything it admitted:
/// the extended-row write and the vote's notification state.
fn lane_idle(rt: &tokio::runtime::Runtime, app: &Arc<App>) {
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while notifications_in_flight(app) > 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the notification lane never went idle");
    });
}

/// The newest user's extended row in conversation 1: referrer and origin.
fn extended(stage: &Stage) -> (Option<String>, Option<String>) {
    let row = stage
        .db
        .connect()
        .query_one(
            "select referrer, origin from participants_extended
             where zid=1 and uid=(select max(uid) from users)",
            &[],
        )
        .unwrap();
    (row.get(0), row.get(1))
}

fn extended_dropped(app: &Arc<App>) -> u64 {
    app.post_votes
        .as_ref()
        .unwrap()
        .background
        .extended_info_dropped
        .load(Ordering::Relaxed)
}

#[test]
fn a_first_contact_records_its_referrer_and_origin_as_node_does() {
    let stage = stage_with_origin("first_contact_extended");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let some = |s: &str| Some(s.to_owned());
    // Over the columns' 9999 characters before its query, and within them
    // after it is dropped.
    let long_path = format!("https://example.org/{}", "p".repeat(9990));
    let long_query = format!("https://example.org/embed?{}", "q".repeat(10_000));
    let long_origin = format!("https://{}.example.org", "o".repeat(9990));
    // Each case: the request's headers, then the row Node's
    // `addParticipantAndMetadata` leaves (participant.ts), and whether its
    // one update fails (a value longer than its column).
    type Case<'a> = (
        Vec<(&'a str, &'a str)>,
        (Option<String>, Option<String>),
        bool,
    );
    let cases: Vec<Case> = vec![
        (
            vec![
                (
                    "referer",
                    "https://example.org/embed/2plain?xid=x1&ui=0#top",
                ),
                ("origin", "https://example.org"),
            ],
            (
                some("https://example.org/embed/2plain"),
                some("https://example.org"),
            ),
            false,
        ),
        (
            vec![("referer", "https://example.org/page")],
            (some("https://example.org/page"), None),
            false,
        ),
        (
            vec![("origin", "https://example.org")],
            (None, some("https://example.org")),
            false,
        ),
        (vec![], (None, None), false),
        // Node reads `referrer` when `referer` is absent or empty, and stops
        // at the first `?` or `#`, whichever comes first.
        (
            vec![("referrer", "https://example.org/a#b?c")],
            (some("https://example.org/a"), None),
            false,
        ),
        (
            vec![("referer", ""), ("referrer", "https://example.org/b?c")],
            (some("https://example.org/b"), None),
            false,
        ),
        // A referrer that is only a query is stored empty; an empty origin is
        // not stored.
        (
            vec![("referer", "?xid=x2"), ("origin", "")],
            (some(""), None),
            false,
        ),
        (
            vec![("referer", long_query.as_str())],
            (some("https://example.org/embed"), None),
            false,
        ),
        // Too long for its column: the update fails and neither is written.
        (
            vec![
                ("referer", long_path.as_str()),
                ("origin", "https://example.org"),
            ],
            (None, None),
            true,
        ),
        (
            vec![
                ("referer", "https://example.org/c"),
                ("origin", long_origin.as_str()),
            ],
            (None, None),
            true,
        ),
    ];
    for (headers, expected, fails) in cases {
        let dropped = extended_dropped(&app);
        let before = rows(&stage);
        let (status, body) = vote_with(&rt, &app, ballot("2plain"), None, &headers);
        assert_eq!(status, 200, "{body}");
        assert!(body.ends_with(AUTH_TAIL), "{body}");
        assert_eq!(
            rows(&stage),
            before.iter().map(|n| n + 1).collect::<Vec<_>>()
        );
        lane_idle(&rt, &app);
        assert_eq!(extended(&stage), expected, "{:?}", headers.len());
        assert_eq!(extended_dropped(&app), dropped + u64::from(fails));
    }
    // A member's vote writes no extended row, whatever its headers say.
    let member = member_token(&stage, 2, 0);
    let (status, _) = vote_with(
        &rt,
        &app,
        ballot("2plain"),
        Some(&member),
        &[
            ("referer", "https://example.org/member"),
            ("origin", "https://example.org"),
        ],
    );
    assert_eq!(status, 200);
    lane_idle(&rt, &app);
    assert_eq!(
        stage
            .db
            .connect()
            .query_one(
                "select count(*) from participants_extended where uid=2",
                &[]
            )
            .unwrap()
            .get::<_, i64>(0),
        0
    );
}

#[test]
fn with_the_lane_full_a_first_vote_answers_with_its_token_and_counts_the_drop() {
    let stage = stage_with_origin("first_contact_extended_full");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let lane = &app.post_votes.as_ref().unwrap().background;
    // Every admission permit of the notification lane is taken.
    let held = lane.admitted.clone().try_acquire_many_owned(64).unwrap();
    let before = rows(&stage);
    let (status, body) = vote_with(
        &rt,
        &app,
        ballot("2plain"),
        None,
        &[
            ("referer", "https://example.org/full?xid=x3"),
            ("origin", "https://example.org"),
        ],
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.ends_with(AUTH_TAIL), "{body}");
    assert_eq!(
        rows(&stage),
        before.iter().map(|n| n + 1).collect::<Vec<_>>()
    );
    assert_eq!(extended_dropped(&app), 1);
    let Js::Obj(health) = health(&app) else {
        unreachable!()
    };
    assert_eq!(
        health.get("firstContactExtendedInfoDropped"),
        Some(&Js::Num(1.0))
    );
    drop(held);
    lane_idle(&rt, &app);
    assert_eq!(
        extended(&stage),
        (None, None),
        "a dropped write is not retried"
    );
}

#[test]
fn with_the_first_contact_switch_off_no_extended_row_is_written() {
    let stage = stage_with_origin("first_contact_extended_off");
    let rt = runtime();
    let off = app(&stage, &rt, false);
    let before = rows(&stage);
    let headers = [
        ("referer", "https://example.org/off?xid=x4"),
        ("origin", "https://example.org"),
    ];
    assert_eq!(
        vote_with(&rt, &off, ballot("2plain"), None, &headers).0,
        502
    );
    assert_eq!(rows(&stage), before);
    let member = member_token(&stage, 2, 0);
    assert_eq!(
        vote_with(&rt, &off, ballot("2plain"), Some(&member), &headers).0,
        200
    );
    lane_idle(&rt, &off);
    let mut c = stage.db.connect();
    assert_eq!(
        c.query_one("select count(*) from participants_extended", &[])
            .unwrap()
            .get::<_, i64>(0),
        before[2]
    );
    let Js::Obj(health) = health(&off) else {
        unreachable!()
    };
    assert!(health.get("firstContactExtendedInfoDropped").is_none());
}

/// A first vote whose request is cancelled (as the listener's request
/// deadline cancels it) after `after`, while its person is being created.
fn cancelled_first_vote(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    body: Value,
    after: Duration,
) -> bool {
    let mut request = req(&body.to_string());
    request.headers = Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
    ]);
    let app = app.clone();
    rt.block_on(async move {
        tokio::time::timeout(after, crate::route::handle(app, request))
            .await
            .is_err()
    })
}

/// Waits, up to five seconds, until `done` holds.
fn eventually(mut done: impl FnMut() -> bool) -> bool {
    for _ in 0..250 {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    done()
}

/// Votes of participant `pid` on statement `tid` of conversation 1, as stored.
fn stored_votes(stage: &Stage, pid: i32, tid: i32) -> Vec<Option<i16>> {
    stage
        .db
        .connect()
        .query(
            "select vote from votes where zid=1 and pid=$1 and tid=$2",
            &[&pid, &tid],
        )
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect()
}

#[test]
fn a_request_cancelled_while_its_person_is_created_still_writes_the_vote_once() {
    let stage = stage("first_contact_cancelled");
    // Creating the user takes 0.4 s (below the one-second statement bound),
    // so the request is cancelled while the creating transaction runs, before
    // its commit and before the vote's dispatch. The vote on statement 8
    // always fails after the person is committed.
    stage
        .db
        .connect()
        .batch_execute(
            "CREATE FUNCTION slow_user() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$;
             CREATE TRIGGER slow_user BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION slow_user();
             CREATE FUNCTION refuse_vote() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN IF NEW.tid = 8 THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$;
             CREATE TRIGGER refuse_vote BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION refuse_vote();",
        )
        .unwrap();
    let rt = runtime();
    let app = app(&stage, &rt, true);

    // Cancelled during creation: the person is committed after the request
    // is gone, and their vote is written exactly once all the same.
    let before = rows(&stage);
    assert!(
        cancelled_first_vote(&rt, &app, ballot("2plain"), Duration::from_millis(100)),
        "the request must be cancelled before it is answered"
    );
    assert!(
        eventually(|| rows(&stage)[3] == before[3] + 1),
        "the created person's vote was never written: {:?} -> {:?}",
        before,
        rows(&stage)
    );
    assert_eq!(
        rows(&stage),
        vec![before[0] + 1, before[1] + 1, before[2] + 1, before[3] + 1],
        "users, participants, participants_extended, votes"
    );
    assert_eq!(stored_votes(&stage, 2, 7), vec![agree()]);
    let created = newest_user(&stage);
    assert_eq!(
        stage
            .db
            .connect()
            .query_one(
                "select pid from participants where zid=1 and uid=$1",
                &[&created]
            )
            .unwrap()
            .get::<_, i32>(0),
        2
    );

    // Cancelled during creation, and the vote then cannot be written: the
    // person without their vote is counted and logged as its own event.
    let not_written = FIRST_CONTACT_VOTE_NOT_WRITTEN.load(Ordering::Relaxed);
    let before = rows(&stage);
    let body = json!({"conversation_id": "2plain", "tid": 8, "vote": crate::votes::WIRE_AGREE});
    assert!(cancelled_first_vote(
        &rt,
        &app,
        body,
        Duration::from_millis(100)
    ));
    assert!(
        eventually(|| FIRST_CONTACT_VOTE_NOT_WRITTEN.load(Ordering::Relaxed) > not_written),
        "a created person without their vote raised no alarm"
    );
    assert_eq!(
        rows(&stage),
        vec![before[0] + 1, before[1] + 1, before[2] + 1, before[3]],
        "users, participants, participants_extended, votes"
    );
    assert!(stored_votes(&stage, 3, 8).is_empty());

    // Cancelled before the creating commit with the first-contact pool full:
    // handed back with nothing written, and no vote dispatched later.
    let writer = app.post_votes.as_ref().unwrap();
    let pool = writer.first_contact.as_ref().unwrap().pool.clone();
    let (release, held): (Vec<_>, Vec<_>) = (0..first_contact_limits().size)
        .map(|_| {
            let (ready, wait) = std::sync::mpsc::channel();
            let (release, hold) = std::sync::mpsc::channel::<()>();
            let pool = pool.clone();
            let held = rt.spawn(async move {
                pool.with(move |_| {
                    ready.send(()).unwrap();
                    let _ = hold.recv_timeout(Duration::from_secs(5));
                    Ok(())
                })
                .await
            });
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            (release, held)
        })
        .unzip();
    let before = rows(&stage);
    assert!(cancelled_first_vote(
        &rt,
        &app,
        ballot("2plain"),
        Duration::from_millis(50)
    ));
    std::thread::sleep(Duration::from_millis(300));
    for release in release {
        release.send(()).unwrap();
    }
    for held in held {
        rt.block_on(held).unwrap().unwrap();
    }
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(rows(&stage), before, "handed back before any write");
}

/// A first vote whose first-contact task panics at `fault`: the answer, its
/// body, and what the task recorded, once the task has ended.
fn faulted_first_vote(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    fault: Fault,
) -> (Outgoing, String, DispatchObservation) {
    let observation = DispatchObservation::default();
    observation.lock().unwrap().fault = Some(fault);
    let mut request = req(&ballot("2plain").to_string());
    request.headers = Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
    ]);
    let app = app.clone();
    let out = rt.block_on(async {
        let mut route = Box::pin(crate::route::handle(app, request));
        std::future::poll_fn(|cx| {
            observing_dispatch(&observation, || {
                std::future::Future::poll(route.as_mut(), cx)
            })
        })
        .await
    });
    assert!(
        eventually(|| observation.lock().unwrap().finished),
        "the first-contact task never ended"
    );
    let body = match &out.body {
        Body::Empty => String::new(),
        Body::Fixed(bytes) => String::from_utf8(bytes.clone()).unwrap(),
        Body::Chunked(chunks) => String::from_utf8(chunks.concat()).unwrap(),
    };
    (out, body, observation)
}

fn marked_for_node(out: &Outgoing) -> bool {
    out.headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("x-polis-vote-dispatch"))
}

#[test]
fn a_first_contact_task_that_fails_after_its_creating_commit_is_never_handed_back() {
    let stage = stage("first_contact_unwind");
    let rt = runtime();
    let app = app(&stage, &rt, true);

    // Before the creating commit: handed back to Node, nothing written, no
    // alarm.
    let before = rows(&stage);
    let (out, _, observation) = faulted_first_vote(&rt, &app, Fault::BeforeCreate);
    assert_eq!(out.status, 502);
    assert!(marked_for_node(&out), "a hand-back carries its marker");
    assert_eq!(rows(&stage), before, "nothing written before the commit");
    assert_eq!(observation.lock().unwrap().vote_not_written, 0);

    // After the creating commit, before the request is told of the person:
    // Node's answer to a failed vote, never a hand-back; the person without
    // their vote raises the alarm once.
    let alarms = FIRST_CONTACT_VOTE_NOT_WRITTEN.load(Ordering::Relaxed);
    let before = rows(&stage);
    let (out, body, observation) = faulted_first_vote(&rt, &app, Fault::AfterCreate);
    assert_eq!(
        (out.status, body.as_str()),
        (500, node_refusal(500, "polis_err_vote").as_str())
    );
    assert!(!marked_for_node(&out), "never marked for Node");
    assert_eq!(
        rows(&stage),
        vec![before[0] + 1, before[1] + 1, before[2] + 1, before[3]],
        "users, participants, participants_extended, votes"
    );
    assert_eq!(observation.lock().unwrap().vote_not_written, 1);
    assert!(FIRST_CONTACT_VOTE_NOT_WRITTEN.load(Ordering::Relaxed) > alarms);

    // After the request is told of the person, before the vote's dispatch:
    // the receipt of unknown acceptance with the person's token, never a
    // hand-back; the alarm is raised once.
    let alarms = FIRST_CONTACT_VOTE_NOT_WRITTEN.load(Ordering::Relaxed);
    let before = rows(&stage);
    let (out, body, observation) = faulted_first_vote(&rt, &app, Fault::AfterReport);
    assert_eq!(out.status, 202, "{body}");
    assert!(body.contains(r#""acceptance":"unknown""#), "{body}");
    assert!(!reply_token(&body).is_empty(), "{body}");
    assert!(!marked_for_node(&out), "never marked for Node");
    assert_eq!(
        rows(&stage),
        vec![before[0] + 1, before[1] + 1, before[2] + 1, before[3]],
        "users, participants, participants_extended, votes"
    );
    assert_eq!(observation.lock().unwrap().vote_not_written, 1);
    assert!(FIRST_CONTACT_VOTE_NOT_WRITTEN.load(Ordering::Relaxed) > alarms);

    // With no fault, the same lane serves a first vote as before.
    let before = rows(&stage);
    let (status, body) = vote(&rt, &app, ballot("2plain"), None);
    assert_eq!(status, 200, "{body}");
    assert!(eventually(|| rows(&stage)[3] == before[3] + 1));
}

/// Every new session of the stage's database logs every statement with its
/// parameters.
fn log_every_statement(stage: &Stage) {
    stage
        .db
        .connect()
        .batch_execute(
            "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET log_statement = ''all''',
             current_database()); END $$",
        )
        .unwrap();
}

/// The server's log, once a made-up control value bound on a connection that
/// logs every statement is in it: None when the server writes no log this
/// session can read.
fn logged(stage: &Stage) -> Option<String> {
    let read = || {
        stage
            .db
            .connect()
            .query_one("select pg_read_file(pg_current_logfile())", &[])
            .ok()?
            .try_get::<_, Option<String>>(0)
            .ok()?
    };
    let control = format!("made-up-control-{}", std::process::id());
    let mut c = stage.db.connect();
    c.batch_execute("SET log_statement = 'all'").unwrap();
    c.query_one("select $1::text", &[&control]).unwrap();
    for _ in 0..30 {
        match read() {
            None => return None,
            Some(log) if log.contains(&control) => return Some(log),
            Some(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    None
}

/// Asserts the log, where the server writes one, holds neither value.
fn assert_not_logged(stage: &Stage, values: &[&str]) {
    match logged(stage) {
        Some(log) => {
            for value in values {
                assert!(!log.contains(value), "a value reached the server's log");
            }
        }
        None => eprintln!("no readable server log with the control value: the log is not checked"),
    }
}

/// Where the server logs every statement with its parameters, a first
/// contact's referrer and origin are not sent: the vote and its reply are as
/// before, the extended row keeps neither, the write is counted as dropped,
/// and the server's log holds neither value.
#[test]
fn a_referrer_and_origin_are_not_sent_where_the_server_logs_parameters() {
    let stage = stage_with_origin("first_contact_extended_logged");
    log_every_statement(&stage);
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let before = rows(&stage);
    let referrer = format!(
        "https://example.org/made-up-referrer-{}",
        std::process::id()
    );
    let origin = "https://example.org/made-up-origin";
    let (status, body) = vote_with(
        &rt,
        &app,
        ballot("2plain"),
        None,
        &[("referer", &referrer), ("origin", origin)],
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.ends_with(AUTH_TAIL), "{body}");
    assert_eq!(
        rows(&stage),
        before.iter().map(|n| n + 1).collect::<Vec<_>>()
    );
    lane_idle(&rt, &app);
    assert_eq!(extended(&stage), (None, None), "nothing was written");
    assert_eq!(extended_dropped(&app), 1, "the write is counted");
    let Js::Obj(health) = health(&app) else {
        unreachable!()
    };
    assert_eq!(
        health.get("firstContactExtendedInfoDropped"),
        Some(&Js::Num(1.0))
    );
    assert_not_logged(&stage, &[&referrer, origin]);
}

/// The settings are read on the connection that sends, for each write: with
/// the server's defaults the referrer and origin are written; once every
/// statement is logged (set after the lane's pool was built and used), the
/// next first contact's are not sent, and the drop is counted.
#[test]
fn a_logging_setting_changed_after_startup_stops_the_referrer_being_sent() {
    let stage = stage_with_origin("first_contact_extended_changed");
    let rt = runtime();
    // Every lane write opens its own connection, so a setting changed after
    // the pool was built reaches it.
    let app = app_with_lane_lifetime(&stage, &rt, true, Duration::from_millis(1));
    let (status, body) = vote_with(
        &rt,
        &app,
        ballot("2plain"),
        None,
        &[
            ("referer", "https://example.org/made-up-safe?drop-me"),
            ("origin", "https://example.org"),
        ],
    );
    assert_eq!(status, 200, "{body}");
    lane_idle(&rt, &app);
    assert_eq!(
        extended(&stage),
        (
            Some("https://example.org/made-up-safe".into()),
            Some("https://example.org".into())
        ),
        "safe: written"
    );
    assert_eq!(extended_dropped(&app), 0);
    log_every_statement(&stage);
    let referrer = format!("https://example.org/made-up-later-{}", std::process::id());
    let (status, body) = vote_with(
        &rt,
        &app,
        ballot("2plain"),
        None,
        &[
            ("referer", &referrer),
            ("origin", "https://example.org/made-up-later-origin"),
        ],
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.ends_with(AUTH_TAIL), "{body}");
    lane_idle(&rt, &app);
    assert_eq!(extended(&stage), (None, None), "unsafe: not sent");
    assert_eq!(extended_dropped(&app), 1, "unsafe: counted");
    assert_not_logged(&stage, &[&referrer, "made-up-later-origin"]);
}

/// A first vote through a conversation's second code gets the token Node
/// signs: Node's `getZinvite` names the first row of its own query, not the
/// code the request used. The token then serves a later vote under that code
/// as a member's, as Node does. Under the second code Node sees another code
/// string, resolves both to this conversation and serves the token's
/// participant; here that request is handed back to Node, with nothing
/// written.
#[test]
fn a_first_vote_through_a_second_code_gets_the_code_node_signs() {
    let stage = stage_with_another("first_contact_code");
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let node: String = stage
        .db
        .connect()
        .query("select * from zinvites where zid = ($1);", &[&1i32])
        .unwrap()[0]
        .get("zinvite");
    assert_eq!(node, "2plain", "Node's query selects the first code");
    let (status, body) = vote(&rt, &app, ballot("2alias"), None);
    assert_eq!(status, 200, "{body}");
    let token = reply_token(&body).to_owned();
    // `claims` requires a token for `2plain`.
    let (kind, uid, pid, _) = claims(&stage, &token);
    assert_eq!(
        (kind, uid, pid),
        (participant::Kind::Anonymous, newest_user(&stage), 2)
    );
    let later = |cid: &str| {
        let mut body = ballot(cid);
        body["tid"] = json!(8);
        body
    };
    let before = rows(&stage);
    let (status, body) = vote(&rt, &app, later("2plain"), Some(&token));
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        rows(&stage),
        vec![before[0], before[1], before[2], before[3] + 1],
        "a member's vote: nobody new"
    );
    let before = rows(&stage);
    assert_eq!(
        vote(&rt, &app, later("2alias"), Some(&token)).0,
        502,
        "the second code: handed back"
    );
    assert_eq!(rows(&stage), before, "a hand-back writes nothing");
}
