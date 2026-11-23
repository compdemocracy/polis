//! The live vote writer's first contact under concurrency and load, through
//! the whole route, against a database built from the published migrations
//! with the participant-number lock of migration 000044 (held to commit):
//! many first votes at once in one conversation; and members' votes, the
//! comment list and the next comment while the first contact's own pool is
//! exhausted, or while its creations wait on the participant-number lock.
use super::{database::Database, *};
use crate::http::{Body, Headers};
use crate::votes::{StorageConvention, VoteChoice};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};
use std::io::Write as _;

struct Stage {
    db: Database,
    private: String,
    public: String,
}

/// Owner 9 owns conversation 1 (`2plain`), which is open, with members 2 and
/// 3 as participants 0 and 1 and three accepted comments by member 2.
fn stage(label: &str, exclusive: bool) -> Stage {
    let db = if exclusive {
        Database::exclusive(label)
    } else {
        Database::new(label)
    };
    let mut c = db.connect();
    c.batch_execute(
        "CREATE TABLE IF NOT EXISTS oidc_user_mappings(uid integer);
         INSERT INTO users(uid) VALUES (9),(2),(3);
         SELECT setval(pg_get_serial_sequence('users','uid'), 100);
         INSERT INTO conversations(zid,owner,is_active,modified) VALUES (1,9,true,0);
         INSERT INTO zinvites(zid,zinvite) VALUES (1,'2plain');
         ALTER TABLE participants DISABLE TRIGGER USER;
         INSERT INTO participants(zid,pid,uid,nsli) VALUES (1,0,2,0),(1,1,3,0);
         ALTER TABLE participants ENABLE TRIGGER USER;
         INSERT INTO comments(zid,pid,uid,txt,velocity,active,mod)
         VALUES (1,0,2,'first',1,true,1),(1,0,2,'second',1,true,1),(1,0,2,'third',1,true,1);",
    )
    .unwrap();
    c.batch_execute(include_str!(
        "../../../server/postgres/migrations/000044_pid_auto_transaction_lock.sql"
    ))
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

/// The live writer with the identity and first-contact switches on, its
/// production pool bounds, and the comment list and next-comment reads on
/// their own production pools.
fn app(stage: &Stage, rt: &tokio::runtime::Runtime) -> Arc<App> {
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
        identity_reads: Some(db::Pool::new(connector(), identity_read_limits())),
        first_contact: Some(FirstContact {
            pool: db::Pool::writer(connector(), first_contact_limits()),
            keys: Arc::new(keys(stage)),
            issuer: "fixture".into(),
            audience: "fixture".into(),
        }),
    });
    app.next_comment_db = Some(db::Pool::new(connector(), next_comment::pool_limits()));
    app.next_comment_plain = true;
    app.comments_db = Some(db::Pool::new(connector(), comments::pool_limits()));
    app.comments_count_db = Some(db::Pool::new(connector(), comments::count_pool_limits()));
    rt.block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        for pool in [
            &writer.reads,
            &writer.pool,
            &writer.background.pool,
            &writer.first_contact.as_ref().unwrap().pool,
            app.next_comment_db.as_ref().unwrap(),
            app.comments_db.as_ref().unwrap(),
            app.comments_count_db.as_ref().unwrap(),
        ] {
            pool.with(|c| Ok(c.simple_query("select 1").map(drop)?))
                .await
                .unwrap();
        }
    });
    Arc::new(app)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap()
}

/// A vote on statement `tid`, agree on the wire, with a member's token or
/// with none (a first contact).
fn ballot(tid: i32, token: Option<&str>) -> Request {
    let body = json!({"conversation_id": "2plain", "tid": tid, "vote": crate::votes::WIRE_AGREE});
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
    request
}

/// An anonymous read of this conversation on `path`.
fn read(path: &str) -> Request {
    Request {
        method: "GET".into(),
        target: format!("{path}?conversation_id=2plain"),
        headers: Headers::from_raw([("host", "localhost"), ("x-forwarded-proto", "https")]),
        body: vec![],
    }
}

#[derive(Clone, Debug)]
struct Answer {
    status: u16,
    body: String,
    /// The vote route's marker of a request handed back before dispatch.
    dispatch: Option<String>,
    elapsed: Duration,
}

async fn send(app: Arc<App>, request: Request) -> Answer {
    let started = std::time::Instant::now();
    let out = crate::route::handle(app, request).await;
    let elapsed = started.elapsed();
    Answer {
        status: out.status,
        dispatch: out
            .headers
            .iter()
            .find(|(name, _)| name == "X-Polis-Vote-Dispatch")
            .map(|(_, value)| value.clone()),
        body: match &out.body {
            Body::Empty => String::new(),
            Body::Fixed(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Chunked(chunks) => String::from_utf8(chunks.concat()).unwrap(),
        },
        elapsed,
    }
}

/// Every request at once: each task waits on one barrier before it calls
/// the route. Answers come back in the order given.
fn at_once(rt: &tokio::runtime::Runtime, app: &Arc<App>, requests: Vec<Request>) -> Vec<Answer> {
    rt.block_on(async {
        let start = Arc::new(tokio::sync::Barrier::new(requests.len()));
        let tasks: Vec<_> = requests
            .into_iter()
            .map(|request| {
                let (app, start) = (app.clone(), start.clone());
                tokio::spawn(async move {
                    start.wait().await;
                    send(app, request).await
                })
            })
            .collect();
        let mut answers = vec![];
        for task in tasks {
            answers.push(task.await.unwrap());
        }
        answers
    })
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

/// The token Node's participant middleware issues to an anonymous member.
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

/// The user and participant a served first vote names: its token verifies
/// for this conversation and agrees with `currentPid`.
fn served_participant(stage: &Stage, body: &str) -> (i32, i32) {
    let value: Value = serde_json::from_str(body).unwrap();
    let token = value["auth"]["token"]
        .as_str()
        .unwrap_or_else(|| panic!("a served first vote carries its token: {body}"));
    assert_eq!(value["auth"]["token_type"], json!("Bearer"), "{body}");
    let verified = keys(stage)
        .verifier("fixture", "fixture")
        .unwrap()
        .verify(
            &format!("Bearer {token}"),
            "2plain",
            (crate::clock::now_ms() / 1000.0) as u64,
        )
        .expect("an anonymous participant token for this conversation");
    let (uid, pid) = (verified.uid().0, verified.pid().0 as i32);
    assert_eq!(value["currentPid"], json!(pid), "{body}");
    (uid, pid)
}

/// Written past the test harness's capture, so every run records it.
fn report(line: String) {
    std::io::stdout()
        .write_all(format!("{line}\n").as_bytes())
        .unwrap();
}

const FIRST_VOTERS: usize = 16;

#[test]
fn concurrent_first_votes_in_one_conversation_each_get_their_own_participant() {
    let stage = stage("first_contact_concurrent", false);
    let rt = runtime();
    let app = app(&stage, &rt);
    let before = rows(&stage);
    let answers = at_once(
        &rt,
        &app,
        (0..FIRST_VOTERS).map(|_| ballot(0, None)).collect(),
    );
    // Every voter is either served or handed back before dispatch, for Node
    // to answer. Nobody is refused, and nobody gets the unknown receipt.
    let mut served = vec![];
    let mut handed_back = 0;
    for answer in &answers {
        match (answer.status, answer.dispatch.as_deref()) {
            (200, None) => served.push(served_participant(&stage, &answer.body)),
            (502, Some("not-started")) => handed_back += 1,
            _ => panic!(
                "a first voter was neither served nor handed back before dispatch: {answer:?}"
            ),
        }
    }
    let slowest = answers.iter().map(|a| a.elapsed).max().unwrap();
    report(format!(
        "concurrent first votes: voters={FIRST_VOTERS}; served={}; handed_back={handed_back}; slowest_ms={}",
        served.len(),
        slowest.as_millis()
    ));
    assert!(!served.is_empty(), "no first voter was served: {answers:?}");
    // Each served voter has its own participant number: none given twice,
    // and the numbers follow members 0 and 1 with none skipped.
    let mut pids: Vec<i32> = served.iter().map(|(_, pid)| *pid).collect();
    pids.sort_unstable();
    assert_eq!(
        pids,
        (2..2 + served.len() as i32).collect::<Vec<_>>(),
        "participant numbers of the served first voters"
    );
    // One user, one extended row, one participant and one vote per voter
    // served; nothing for a voter handed back.
    let n = served.len() as i64;
    assert_eq!(
        rows(&stage),
        before.iter().map(|count| count + n).collect::<Vec<_>>(),
        "users, participants, participants_extended, votes"
    );
    let mut c = stage.db.connect();
    for (uid, pid) in &served {
        assert_eq!(
            c.query_one("select count(*) from users where uid=$1", &[uid])
                .unwrap()
                .get::<_, i64>(0),
            1
        );
        let participants: Vec<i32> = c
            .query(
                "select pid from participants where zid=1 and uid=$1",
                &[uid],
            )
            .unwrap()
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(participants, vec![*pid], "the participant of user {uid}");
        let votes: Vec<Option<i16>> = c
            .query("select vote from votes where zid=1 and pid=$1", &[pid])
            .unwrap()
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(votes, vec![agree()], "the vote of participant {pid}");
    }
    assert_eq!(
        c.query_one(
            "select count(*) from (select pid from participants where zid=1
             group by pid having count(*) > 1) twice",
            &[],
        )
        .unwrap()
        .get::<_, i64>(0),
        0,
        "a participant number given twice"
    );
}

/// The participant-number lock key of `pid_auto` (migration 000044), taken
/// per conversation.
const PARTICIPANT_NUMBER_LOCK: i32 = 873791983;

const MEMBER_VOTES: usize = 4;
const READS_EACH: usize = 2;
const FIRST_VOTERS_UNDER_LOAD: usize = 8;

/// One round of participation at once: members' votes (two each, on the
/// three statements), the next comment and the comment list (as many at once
/// as their pools hold), and `first` first votes. Answers in that order.
fn participation(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    members: &[String; 2],
    first: usize,
) -> Vec<Answer> {
    let mut requests: Vec<Request> = (0..MEMBER_VOTES)
        .map(|i| ballot((i % 3) as i32, Some(&members[i % 2])))
        .collect();
    requests.extend((0..READS_EACH).map(|_| read(next_comment::PATH)));
    requests.extend((0..READS_EACH).map(|_| read(comments::PATH)));
    requests.extend((0..first).map(|_| ballot(0, None)));
    at_once(rt, app, requests)
}

/// Members' votes, then the next comment, then the comment list, then first
/// votes, as `participation` orders them.
fn split(answers: &[Answer]) -> [&[Answer]; 4] {
    let (members, rest) = answers.split_at(MEMBER_VOTES);
    let (next, rest) = rest.split_at(READS_EACH);
    let (list, first) = rest.split_at(READS_EACH);
    [members, next, list, first]
}

fn statuses(answers: &[Answer]) -> Vec<u16> {
    answers.iter().map(|a| a.status).collect()
}

fn slowest_ms(answers: &[Answer]) -> u128 {
    answers
        .iter()
        .map(|a| a.elapsed.as_millis())
        .max()
        .unwrap_or(0)
}

#[test]
fn participation_is_answered_as_when_idle_while_first_contacts_cannot_be_created() {
    let stage = stage("first_contact_exhausted", true);
    let rt = runtime();
    let app = app(&stage, &rt);
    let writer = app.post_votes.as_ref().unwrap();
    let lane = writer.first_contact.as_ref().unwrap().pool.clone();
    let members = [member_token(&stage, 2, 0), member_token(&stage, 3, 1)];
    // The participation pools that are not the first contact's.
    let theirs: [(&str, Arc<db::Pool>); 6] = [
        ("vote append", writer.pool.clone()),
        ("vote admission reads", writer.reads.clone()),
        ("vote notifications", writer.background.pool.clone()),
        ("next comment", app.next_comment_db.clone().unwrap()),
        ("comment list", app.comments_db.clone().unwrap()),
        ("comment count", app.comments_count_db.clone().unwrap()),
    ];
    let snapshot = || theirs.clone().map(|(_, pool)| pool.evidence.snapshot());
    // [acquired, pending, timeouts, completed, errors, deadlines]
    let timeouts = |before: &[[usize; 6]; 6], after: &[[usize; 6]; 6]| {
        theirs
            .iter()
            .zip(before.iter().zip(after))
            .map(|((name, _), (b, a))| (*name, a[2] - b[2]))
            .collect::<Vec<_>>()
    };
    let assert_members_answered = |phase: &str, answers: &[Answer]| {
        let [members, next, list, _] = split(answers);
        for answer in members {
            assert_eq!(
                (answer.status, answer.dispatch.as_deref()),
                (200, None),
                "{phase}: a member's vote was not answered: {answer:?}"
            );
        }
        for answer in next.iter().chain(list) {
            assert_eq!(
                answer.status, 200,
                "{phase}: a participation read was not answered: {answer:?}"
            );
        }
    };
    let people = |stage: &Stage| rows(stage)[..3].to_vec();

    // Idle: the first contact's pool free and no first voter.
    let idle = participation(&rt, &app, &members, 0);
    assert_members_answered("idle", &idle);
    let [m, n, l, _] = split(&idle);
    report(format!(
        "idle: member_votes={:?} slowest_ms={}; next_comment={:?} slowest_ms={}; comment_list={:?} slowest_ms={}",
        statuses(m),
        slowest_ms(m),
        statuses(n),
        slowest_ms(n),
        statuses(l),
        slowest_ms(l)
    ));
    let people_before = people(&stage);

    // Exhausted: both of the first contact's connections held.
    let mut held = vec![];
    for _ in 0..first_contact_limits().size {
        let (ready, wait) = std::sync::mpsc::channel();
        let (release, park) = std::sync::mpsc::channel::<()>();
        let pool = lane.clone();
        let work = rt.spawn(async move {
            pool.with(move |_| {
                ready.send(()).unwrap();
                park.recv_timeout(Duration::from_secs(60))?;
                Ok(())
            })
            .await
        });
        wait.recv().unwrap();
        held.push((release, work));
    }
    let lane_before = lane.evidence.snapshot();
    let before = snapshot();
    let exhausted = participation(&rt, &app, &members, FIRST_VOTERS_UNDER_LOAD);
    let after = snapshot();
    let lane_after = lane.evidence.snapshot();
    // The first voters: each handed back before dispatch, within a vote's
    // reply deadline. None was refused and none waited for the pool.
    let check_first = |phase: &str, answers: &[Answer]| {
        for answer in split(answers)[3] {
            assert_eq!(
                (answer.status, answer.dispatch.as_deref()),
                (502, Some("not-started")),
                "{phase}: a first vote was not handed back before dispatch: {answer:?}"
            );
            assert!(
                answer.elapsed < DISPATCH_DEADLINE,
                "{phase}: a first vote was handed back late: {answer:?}"
            );
        }
    };
    let [m, n, l, f] = split(&exhausted);
    report(format!(
        "exhausted: member_votes={:?} slowest_ms={}; next_comment={:?} slowest_ms={}; comment_list={:?} slowest_ms={}; first_votes={:?} slowest_ms={}; first_contact_pool_timeouts={}; other_pool_timeouts={:?}",
        statuses(m),
        slowest_ms(m),
        statuses(n),
        slowest_ms(n),
        statuses(l),
        slowest_ms(l),
        statuses(f),
        slowest_ms(f),
        lane_after[2] - lane_before[2],
        timeouts(&before, &after)
    ));
    assert_members_answered("exhausted", &exhausted);
    check_first("exhausted", &exhausted);
    assert_eq!(
        lane_after[0], lane_before[0],
        "the held first-contact pool lent a connection"
    );
    for (name, count) in timeouts(&before, &after) {
        if name != "vote admission reads" {
            assert_eq!(count, 0, "exhausted: the {name} pool timed out an acquire");
        }
    }
    assert_eq!(
        people(&stage),
        people_before,
        "exhausted: a first voter was written"
    );
    for (release, work) in held {
        release.send(()).unwrap();
        rt.block_on(work).unwrap().unwrap();
    }

    // Parked: the first contact's connections free, and the conversation's
    // participant-number lock held elsewhere, so every creation waits on it
    // for its 100 ms and rolls back.
    let mut locker = stage.db.connect();
    locker
        .batch_execute(&format!(
            "BEGIN; SELECT pg_advisory_xact_lock({PARTICIPANT_NUMBER_LOCK}, 1);"
        ))
        .unwrap();
    let lane_before = lane.evidence.snapshot();
    let before = snapshot();
    let parked = participation(&rt, &app, &members, FIRST_VOTERS_UNDER_LOAD);
    let after = snapshot();
    let lane_after = lane.evidence.snapshot();
    let [m, n, l, f] = split(&parked);
    report(format!(
        "parked: member_votes={:?} slowest_ms={}; next_comment={:?} slowest_ms={}; comment_list={:?} slowest_ms={}; first_votes={:?} slowest_ms={}; first_contact_pool_acquired={} timeouts={}; other_pool_timeouts={:?}",
        statuses(m),
        slowest_ms(m),
        statuses(n),
        slowest_ms(n),
        statuses(l),
        slowest_ms(l),
        statuses(f),
        slowest_ms(f),
        lane_after[0] - lane_before[0],
        lane_after[2] - lane_before[2],
        timeouts(&before, &after)
    ));
    assert_members_answered("parked", &parked);
    check_first("parked", &parked);
    assert!(
        lane_after[0] > lane_before[0],
        "parked: no creation reached the participant-number lock"
    );
    for (name, count) in timeouts(&before, &after) {
        if name != "vote admission reads" {
            assert_eq!(count, 0, "parked: the {name} pool timed out an acquire");
        }
    }
    assert_eq!(
        people(&stage),
        people_before,
        "parked: a first voter was written"
    );
    locker.batch_execute("ROLLBACK").unwrap();

    // Free again: a first vote is served, with the next participant number.
    let answer = rt.block_on(send(app.clone(), ballot(0, None)));
    assert_eq!(answer.status, 200, "{answer:?}");
    assert_eq!(served_participant(&stage, &answer.body).1, 2);
}
