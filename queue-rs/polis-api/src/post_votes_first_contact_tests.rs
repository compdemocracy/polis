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
    // Row parity with Node, with one accepted difference: the user, the
    // participant and the vote are written in one transaction, so their
    // `created` values are that transaction's time (`now_as_millis()` is
    // `now()`), one equal value; Node's separate statements give rising ones.
    let created = c
        .query_one(
            "select (select created from users where uid=$1),
                    (select created from participants where uid=$1),
                    (select created from votes where zid=1 and pid=2 and tid=7)",
            &[&uid],
        )
        .unwrap();
    let (user_created, participant_created, vote_created) = (
        created.get::<_, i64>(0),
        created.get::<_, i64>(1),
        created.get::<_, i64>(2),
    );
    assert_eq!(user_created, participant_created);
    assert_eq!(participant_created, vote_created);
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
    let keys = |app: &Arc<App>| {
        let Js::Obj(body) = health(app) else {
            unreachable!()
        };
        [
            "firstContactHandedBack",
            "firstContactCommitUnknown",
            "firstContactExtendedInfoDropped",
            "firstContactVoteNotWritten",
        ]
        .map(|key| body.get(key).is_some())
    };
    assert_eq!(
        keys(&off),
        [false; 4],
        "the health body is unchanged with the switch off"
    );
    // On: the three first-contact counts. A person without their vote can no
    // longer be written, so there is no count of one.
    assert_eq!(keys(&app(&stage, &rt, true)), [true, true, true, false]);
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
    // Free again, and every connection of the vote append pool held: a first
    // vote with a star is served all the same. Its person, its vote and its
    // star take only the first contact's pool (the transaction, then the
    // star): the append pool not once. The next comment is read on the reads
    // pool after the commit, as a member's is.
    let append_held: Vec<_> = (0..4)
        .map(|_| {
            let (ready, wait) = std::sync::mpsc::channel();
            let (release, park) = std::sync::mpsc::channel::<()>();
            let pool = writer.pool.clone();
            let work = rt.spawn(async move {
                pool.with(move |_| {
                    ready.send(()).unwrap();
                    park.recv_timeout(Duration::from_secs(5))?;
                    Ok(())
                })
                .await
            });
            wait.recv().unwrap();
            (release, work)
        })
        .collect();
    let [append, _, reads, own] = pools();
    let starred = json!({"conversation_id": "2plain", "tid": 7, "vote": crate::votes::WIRE_AGREE, "starred": true});
    let (status, body) = vote(&rt, &app, starred, None);
    assert_eq!(status, 200, "{body}");
    let value: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(value["followOn"]["star"], json!("complete"), "{body}");
    let [append2, _, reads2, own2] = pools();
    assert_eq!(append2, append, "the vote append pool");
    assert_eq!(own2[0], own[0] + 2, "the transaction and the star");
    assert_eq!(reads2[0], reads[0] + 1, "the next comment");
    for (release, work) in append_held {
        release.send(()).unwrap();
        rt.block_on(work).unwrap().unwrap();
    }
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
/// deadline cancels it) once `ready` holds of its dispatch, and never before
/// that: the request is dropped, never answered. `fault` is the pause the
/// first-contact task is given, released only after the request is gone.
/// Returns once that task has ended, with its observation.
fn cancelled_first_vote(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    body: Value,
    fault: Option<Fault>,
    ready: impl Fn(&DispatchState) -> bool,
) -> DispatchObservation {
    let mut request = req(&body.to_string());
    request.headers = Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
    ]);
    let observation = DispatchObservation::default();
    observation.lock().unwrap().fault = fault;
    let watched = observation.clone();
    let app = app.clone();
    let route = rt.spawn(async move {
        let mut route = Box::pin(crate::route::handle(app, request));
        std::future::poll_fn(|cx| {
            observing_dispatch(&watched, || std::future::Future::poll(route.as_mut(), cx))
        })
        .await
    });
    assert!(
        eventually(|| ready(&observation.lock().unwrap())),
        "the first contact never reached the state the request is cancelled in"
    );
    route.abort();
    match rt.block_on(route) {
        Err(error) => assert!(error.is_cancelled(), "the request panicked: {error}"),
        Ok(out) => panic!(
            "the request must be cancelled before it is answered, not answered {}",
            out.status
        ),
    }
    observation.lock().unwrap().worker_released = true;
    assert!(
        eventually(|| observation.lock().unwrap().finished),
        "the first-contact task never ended"
    );
    observation
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
    // The creating operation's blocking work waits at its pause before its
    // transaction until the request has been cancelled, so the request is
    // always gone while its person is being created: before the creating
    // commit and before the vote's dispatch, however the host schedules the
    // test. The vote on statement 8 is always refused, inside the same
    // transaction as its person.
    stage
        .db
        .connect()
        .batch_execute(
            "CREATE FUNCTION refuse_vote() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN IF NEW.tid = 8 THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$;
             CREATE TRIGGER refuse_vote BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION refuse_vote();",
        )
        .unwrap();
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let creating = |state: &DispatchState| state.worker_paused;

    // Cancelled during creation: the person and their vote are committed
    // together after the request is gone, the vote exactly once.
    let before = rows(&stage);
    let observation = cancelled_first_vote(
        &rt,
        &app,
        ballot("2plain"),
        Some(Fault::PauseBeforeCommit),
        |state| {
            // Nothing is committed while the request is still there.
            creating(state) && rows(&stage) == before
        },
    );
    let expected = vec![before[0] + 1, before[1] + 1, before[2] + 1, before[3] + 1];
    assert!(
        eventually(|| rows(&stage) == expected),
        "the created person's vote was never written: {:?} -> {:?}",
        before,
        rows(&stage)
    );
    assert_eq!(
        rows(&stage),
        expected,
        "users, participants, participants_extended, votes"
    );
    assert_eq!(stored_votes(&stage, 2, 7), vec![agree()]);
    assert!(observation.lock().unwrap().finished);
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

    // Cancelled during creation, and the vote is refused: the person rolls
    // back with it. Neither exists, and nothing is left that could write.
    let before = rows(&stage);
    let body = json!({"conversation_id": "2plain", "tid": 8, "vote": crate::votes::WIRE_AGREE});
    cancelled_first_vote(&rt, &app, body, Some(Fault::PauseBeforeCommit), |state| {
        creating(state) && rows(&stage) == before
    });
    assert_eq!(
        rows(&stage),
        before,
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
    // Cancelled once its first-contact task exists, and the task has ended
    // (its connection wait ran out) before the pool is let go: nothing is
    // left that could write later.
    let before = rows(&stage);
    let observation = cancelled_first_vote(&rt, &app, ballot("2plain"), None, |state| {
        state.task.is_some()
    });
    for release in release {
        release.send(()).unwrap();
    }
    for held in held {
        rt.block_on(held).unwrap().unwrap();
    }
    assert_eq!(rows(&stage), before, "handed back before any write");
    assert!(observation.lock().unwrap().finished);
}

/// A first vote with no token, as a new person sends it.
fn first_request() -> Request {
    let mut request = req(&ballot("2plain").to_string());
    request.headers = Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
    ]);
    request
}

fn marked_for_node(out: &Outgoing) -> bool {
    out.headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("x-polis-vote-dispatch"))
}

/// What a first vote answers.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    /// 502 with the pre-dispatch marker: nginx gives the request to Node.
    HandedBack,
    /// 200, unmarked, with the person's token as its last key and the
    /// follow-on complete.
    Served,
    /// 200, unmarked, with the person's token as its last key and the vote's
    /// receipt, its follow-on degraded.
    Degraded,
}

fn answer_of(out: &Outgoing, body: &str) -> Answer {
    let marked = marked_for_node(out);
    match out.status {
        502 if marked => Answer::HandedBack,
        200 if !marked && !reply_token(body).is_empty() => {
            let value: Value = serde_json::from_str(body).unwrap();
            if value["followOn"]["nextComment"] == "degraded" {
                Answer::Degraded
            } else {
                Answer::Served
            }
        }
        status => panic!("unexpected answer {status}: {body}"),
    }
}

/// A person and their vote: users, participants and participants_extended,
/// then votes and votes_latest_unique, counted.
fn person_and_vote(stage: &Stage) -> [i64; 5] {
    let mut c = stage.db.connect();
    [
        "users",
        "participants",
        "participants_extended",
        "votes",
        "votes_latest_unique",
    ]
    .map(|table| {
        c.query_one(&format!("select count(*) from {table}"), &[])
            .unwrap()
            .get(0)
    })
}

/// The five counts after a first vote that wrote both (`both`) or neither.
fn after(before: [i64; 5], both: bool) -> [i64; 5] {
    before.map(|n| n + i64::from(both))
}

/// What a state is counted as, in `/health`.
#[derive(Clone, Copy, Debug)]
enum Counted {
    HandedBack,
    FirstContactHandedBack,
    CommitUnknown,
    Degraded,
    Served,
}

impl Counted {
    /// The process's counter, which tests running beside this one also
    /// raise: a state is asserted to raise it, never to leave the others.
    fn read(self) -> u64 {
        match self {
            Self::HandedBack => &HANDED_BACK,
            Self::FirstContactHandedBack => &FIRST_CONTACT_HANDED_BACK,
            Self::CommitUnknown => &FIRST_CONTACT_UNKNOWN,
            Self::Degraded => &DEGRADED,
            Self::Served => &SERVED,
        }
        .load(Ordering::Relaxed)
    }
}

/// The state table of a first vote: each state with a fault injected at that
/// point, from before its one transaction to its reply. Every row writes the
/// person and the vote together or neither (users, participants,
/// participants_extended, votes and votes_latest_unique), and asserts its
/// answer, the pre-dispatch marker (on a hand-back only) and what it is
/// counted as. A COMMIT whose acknowledgement is lost is still handed back
/// and counted as such.
#[test]
fn every_state_of_a_first_vote_writes_its_person_and_vote_together_or_neither() {
    let stage = stage("first_contact_states");
    // The vote on statement 8 is refused by its own statement, inside the
    // transaction; the one on statement 9 at COMMIT.
    stage
        .db
        .connect()
        .batch_execute(
            "CREATE FUNCTION refuse_vote() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'fixture'; END $$;
             CREATE TRIGGER refuse_vote BEFORE INSERT ON votes FOR EACH ROW
             WHEN (NEW.tid = 8) EXECUTE FUNCTION refuse_vote();
             CREATE CONSTRAINT TRIGGER refuse_at_commit AFTER INSERT ON votes
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
             WHEN (NEW.tid = 9) EXECUTE FUNCTION refuse_vote();",
        )
        .unwrap();
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let lane = || {
        app.post_votes
            .as_ref()
            .unwrap()
            .first_contact
            .as_ref()
            .unwrap()
            .pool
            .clone()
    };
    let on = |tid: u64| json!({"conversation_id": "2plain", "tid": tid, "vote": crate::votes::WIRE_AGREE});
    // (state, fault, body, answer, both written, counted)
    let table = [
        (
            "a statement number out of range, before dispatch",
            None,
            on(1_u64 << 40),
            Answer::HandedBack,
            false,
            Counted::HandedBack,
        ),
        (
            "the task, before the transaction",
            Some(Fault::BeforeCreate),
            on(7),
            Answer::HandedBack,
            false,
            Counted::HandedBack,
        ),
        (
            "the worker unwinds before the transaction",
            Some(Fault::InWorkerBeforeCommit),
            on(7),
            Answer::HandedBack,
            false,
            Counted::FirstContactHandedBack,
        ),
        (
            "the vote's own statement refused, after the person's rows",
            None,
            on(8),
            Answer::HandedBack,
            false,
            Counted::FirstContactHandedBack,
        ),
        (
            "the COMMIT refused: its outcome unknown to the writer",
            None,
            on(9),
            Answer::HandedBack,
            false,
            Counted::CommitUnknown,
        ),
        (
            "the worker unwinds after the acknowledged COMMIT",
            Some(Fault::InWorkerAfterCommit),
            on(7),
            Answer::Served,
            true,
            Counted::Served,
        ),
        (
            "the pool fails after the acknowledged COMMIT",
            Some(Fault::PoolErrorAfterCommit),
            on(7),
            Answer::Served,
            true,
            Counted::Served,
        ),
        (
            "the task, after the COMMIT and before the token",
            Some(Fault::AfterCommit),
            on(7),
            Answer::Degraded,
            true,
            Counted::Degraded,
        ),
        (
            "the task, after the follow-on and before the request is told",
            Some(Fault::AfterFollowOn),
            on(7),
            Answer::Degraded,
            true,
            Counted::Degraded,
        ),
        (
            "no fault",
            None,
            on(7),
            Answer::Served,
            true,
            Counted::Served,
        ),
    ];
    for (state, fault, body, answer, both, counted) in table {
        let before = person_and_vote(&stage);
        let count = counted.read();
        let (out, reply, _) = first_vote_with(&rt, &app, body, fault);
        if fault == Some(Fault::PoolErrorAfterCommit) {
            lane().clear_idle_poison();
        }
        assert_eq!(answer_of(&out, &reply), answer, "{state}: {reply}");
        assert_eq!(
            person_and_vote(&stage),
            after(before, both),
            "{state}: users, participants, participants_extended, votes, votes_latest_unique"
        );
        assert!(counted.read() > count, "{state}: counted as {counted:?}");
        if both {
            // The token names the person whose vote was written.
            let pid = i32::try_from(claims(&stage, reply_token(&reply)).2).unwrap();
            assert_eq!(stored_votes(&stage, pid, 7), vec![agree()], "{state}");
        }
    }

    // The runtime stopped while the transaction waits between the person's
    // rows and the vote's statements: no answer; the server ends the idle
    // transaction and nothing is written, then or once the worker goes on.
    // Stopped after the acknowledged COMMIT: no answer, and both exist.
    for (state, pause, both) in [
        (
            "runtime stopped inside the transaction",
            Fault::PauseInTransaction,
            false,
        ),
        (
            "runtime stopped after the acknowledged COMMIT",
            Fault::PauseAfterCommit,
            true,
        ),
    ] {
        let stopping = runtime();
        let stopped = app_with_lane_lifetime(&stage, &stopping, true, Duration::from_secs(300));
        let before = person_and_vote(&stage);
        let observation = DispatchObservation::default();
        observation.lock().unwrap().fault = Some(pause);
        let watched = observation.clone();
        let answered = Arc::new(Mutex::new(None));
        let reply = answered.clone();
        stopping.spawn(async move {
            let mut route = Box::pin(crate::route::handle(stopped, first_request()));
            let out = std::future::poll_fn(|cx| {
                observing_dispatch(&watched, || std::future::Future::poll(route.as_mut(), cx))
            })
            .await;
            *reply.lock().unwrap() = Some(out.status);
        });
        assert!(
            eventually(|| observation.lock().unwrap().worker_paused),
            "{state}: the worker reached its pause"
        );
        stopping.shutdown_background();
        // Past the transaction's one-second idle bound.
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(person_and_vote(&stage), after(before, both), "{state}");
        observation.lock().unwrap().worker_released = true;
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            person_and_vote(&stage),
            after(before, both),
            "{state}: once the worker goes on"
        );
        assert_eq!(*answered.lock().unwrap(), None, "{state}: no answer");
    }
}

/// A first vote with `body` and `fault`: the answer, its body, and what was
/// recorded, once the first-contact task has ended.
fn first_vote_with(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    body: Value,
    fault: Option<Fault>,
) -> (Outgoing, String, DispatchObservation) {
    let observation = DispatchObservation::default();
    observation.lock().unwrap().fault = fault;
    let mut request = req(&body.to_string());
    request.headers = first_request().headers;
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
    // A request handed back before dispatch began has no task.
    let dispatched = observation.lock().unwrap().receipt.is_some();
    assert!(
        !dispatched || eventually(|| observation.lock().unwrap().finished),
        "the first-contact task never ended"
    );
    let body = match &out.body {
        Body::Empty => String::new(),
        Body::Fixed(bytes) => String::from_utf8(bytes.clone()).unwrap(),
        Body::Chunked(chunks) => String::from_utf8(chunks.concat()).unwrap(),
    };
    (out, body, observation)
}

/// A first vote holds the participant-number lock from its participant's
/// row to its COMMIT. A second first voter in the same conversation waits on
/// it for at most its 100 ms and is handed back with nothing written; a
/// member's vote there takes neither that lock nor the conversation's row
/// lock, and is answered while the lock is held.
#[test]
fn a_second_first_voter_waits_on_the_participant_number_lock_at_most_its_bound() {
    let stage = stage("first_contact_lock");
    // The participant-number lock as the migrations hold it: until COMMIT.
    stage
        .db
        .connect()
        .batch_execute(include_str!(
            "../../../server/postgres/migrations/000044_pid_auto_transaction_lock.sql"
        ))
        .unwrap();
    let rt = runtime();
    let app = app(&stage, &rt, true);
    let before = person_and_vote(&stage);
    let observation = DispatchObservation::default();
    observation.lock().unwrap().fault = Some(Fault::PauseInTransaction);
    let watched = observation.clone();
    let held = app.clone();
    let first = rt.spawn(async move {
        let mut route = Box::pin(crate::route::handle(held, first_request()));
        let out = std::future::poll_fn(|cx| {
            observing_dispatch(&watched, || std::future::Future::poll(route.as_mut(), cx))
        })
        .await;
        out.status
    });
    assert!(
        eventually(|| observation.lock().unwrap().worker_paused),
        "the first voter's transaction reached its pause"
    );
    // Its transaction holds the participant-number lock (migration 000044).
    assert!(
        !stage
            .db
            .connect()
            .query_one("select pg_try_advisory_xact_lock(873791983, 1)", &[])
            .unwrap()
            .get::<_, bool>(0),
        "the participant-number lock is held"
    );
    let started = std::time::Instant::now();
    let (out, reply, _) = first_vote_with(&rt, &app, ballot("2plain"), None);
    let waited = started.elapsed();
    assert_eq!(answer_of(&out, &reply), Answer::HandedBack, "{reply}");
    assert!(
        waited >= Duration::from_millis(100) && waited < Duration::from_millis(900),
        "the second first voter waited {waited:?}"
    );
    assert_eq!(
        person_and_vote(&stage),
        before,
        "nothing of the second voter"
    );
    // A member's vote is answered while the lock is held. A wait on either
    // lock would end in its own 100 ms lock timeout and a failed vote.
    let mut member = vec![];
    for tid in [11, 12, 13, 14] {
        let body =
            json!({"conversation_id": "2plain", "tid": tid, "vote": crate::votes::WIRE_AGREE});
        let started = std::time::Instant::now();
        let (status, reply) = vote(&rt, &app, body, Some(&member_token(&stage, 2, 0)));
        assert_eq!(status, 200, "{reply}");
        assert_eq!(stored_votes(&stage, 0, tid), vec![agree()]);
        member.push(started.elapsed());
        if member.last().unwrap() < &Duration::from_millis(100) {
            break;
        }
    }
    eprintln!(
        "participant-number lock: second first voter waited {waited:?}; member votes {member:?}"
    );
    assert!(
        member.iter().any(|t| *t < Duration::from_millis(100)),
        "a member's vote was delayed: {member:?}"
    );
    // The first voter goes on: both of its person and vote, or, if its
    // transaction outlived its idle bound meanwhile, neither.
    observation.lock().unwrap().worker_released = true;
    let status = rt.block_on(first).unwrap();
    let now = person_and_vote(&stage);
    let written = member.len() as i64;
    let members = [0, 0, 0, written, written];
    let both = after(before, true);
    let both: Vec<i64> = both.iter().zip(members).map(|(n, m)| n + m).collect();
    let neither: Vec<i64> = before.iter().zip(members).map(|(n, m)| n + m).collect();
    match status {
        200 => assert_eq!(now.to_vec(), both),
        502 => assert_eq!(now.to_vec(), neither),
        other => panic!("the first voter answered {other}"),
    }
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
