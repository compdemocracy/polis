//! The live vote writer's first contact under concurrency and load, through
//! the whole route, against a database built from the published migrations
//! with the comment-number and participant-number locks of migrations 000042
//! and 000044 (held to commit):
//! many first votes at once in one conversation, with creations slow enough
//! that some voters are handed back; and members' votes, members' comments,
//! the comment list, the votes read and the next comment while the first
//! contact's own pool is exhausted, or while its creations wait on the
//! participant-number lock, each measured against the same requests idle.
use super::{database::Database, *};
use crate::http::{Body, Headers};
use crate::votes::{StorageConvention, VoteChoice};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};
use std::io::Write as _;

struct Stage {
    /// The test's own database. None in the child process the loaded test
    /// runs in: there the parent owns it.
    _db: Option<Database>,
    config: postgres::Config,
    private: String,
    public: String,
}

impl Stage {
    fn connect(&self) -> Client {
        self.config.connect(postgres::NoTls).unwrap()
    }
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
    // The comment-number lock held to commit, as production numbers
    // comments: with the session lock of 000000, two members' comments at
    // once in one conversation can take the same number.
    c.batch_execute(include_str!(
        "../../../server/postgres/migrations/000042_tid_auto_transaction_lock.sql"
    ))
    .unwrap();
    c.batch_execute(include_str!(
        "../../../server/postgres/migrations/000044_pid_auto_transaction_lock.sql"
    ))
    .unwrap();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Stage {
        config: db.config.clone(),
        _db: Some(db),
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
    app_with(stage, rt, false)
}

/// `app`; with `participation_writes`, also the live comment writer, built
/// by its own startup (`post_comments::configure`, from this process's
/// environment), and the votes read on its own production pools.
fn app_with(stage: &Stage, rt: &tokio::runtime::Runtime, participation_writes: bool) -> Arc<App> {
    let connector = || Connector::Plain(Box::new(stage.config.clone()));
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
    if participation_writes {
        match crate::post_comments::configure(crate::shadow::Role::Main, Some(&keys(stage)))
            .unwrap()
        {
            crate::post_comments::Configured::Live(writer) => app.post_comments = Some(*writer),
            _ => panic!("the live comment writer was not built"),
        }
        app.votes_read_db = Some(db::Pool::new(connector(), crate::votes_read::pool_limits()));
        app.votes_read_auth_db = Some(db::Pool::new(connector(), crate::votes_read::pool_limits()));
    }
    rt.block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let mut pools = vec![
            &writer.reads,
            &writer.pool,
            &writer.background.pool,
            &writer.first_contact.as_ref().unwrap().pool,
            app.next_comment_db.as_ref().unwrap(),
            app.comments_db.as_ref().unwrap(),
            app.comments_count_db.as_ref().unwrap(),
        ];
        if let Some(comments) = &app.post_comments {
            pools.extend(comments.startup_pools());
            pools.push(app.votes_read_db.as_ref().unwrap());
            pools.push(app.votes_read_auth_db.as_ref().unwrap());
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

/// A member's comment `text` (no vote of its own), with the member's token.
fn comment(text: &str, token: &str) -> Request {
    let body = json!({"conversation_id": "2plain", "txt": text});
    let bearer = format!("Bearer {token}");
    Request {
        method: "POST".into(),
        target: crate::post_comments::PATH.into(),
        headers: Headers::from_raw([
            ("host", "localhost"),
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            ("authorization", bearer.as_str()),
        ]),
        body: body.to_string().into_bytes(),
    }
}

/// An anonymous read of this conversation on `path`, with `extra` query keys.
fn read(path: &str, extra: &str) -> Request {
    Request {
        method: "GET".into(),
        target: format!("{path}?conversation_id=2plain{extra}"),
        headers: Headers::from_raw([("host", "localhost"), ("x-forwarded-proto", "https")]),
        body: vec![],
    }
}

#[derive(Clone, Debug)]
struct Answer {
    status: u16,
    body: String,
    /// The vote or comment route's marker of a request handed back before
    /// dispatch.
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
            .find(|(name, _)| name == "X-Polis-Vote-Dispatch" || name == "X-Polis-Comment-Dispatch")
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
    let mut c = stage.connect();
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

/// What every report line starts with, so the parent of a child process can
/// pass the child's lines on.
const REPORT: &str = "first contact load: ";

/// Written past the test harness's capture, so every run records it.
fn report(line: String) {
    std::io::stdout()
        .write_all(format!("{REPORT}{line}\n").as_bytes())
        .unwrap();
}

/// Enough first voters that the first contact's two connections, each held
/// for a slowed creation, cannot serve them all within its 100 ms wait.
const FIRST_VOTERS: usize = 32;

/// How long each participant row's insert is held, inside the creating
/// transaction and after the participant-number lock is taken (an AFTER
/// INSERT trigger on this test's own `participants` table).
const SLOW_CREATION_SECONDS: f64 = 0.03;

#[test]
fn concurrent_first_votes_in_one_conversation_each_get_their_own_participant() {
    let stage = stage("first_contact_concurrent", false);
    let rt = runtime();
    let app = app(&stage, &rt);
    // Every creation takes at least this long, holding its first-contact
    // connection and the participant-number lock, so that the race reaches
    // the pool's 100 ms wait and hands some voters back.
    stage
        .connect()
        .batch_execute(&format!(
            "CREATE FUNCTION slow_participant_insert() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN PERFORM pg_sleep({SLOW_CREATION_SECONDS}); RETURN NULL; END $$;
             CREATE TRIGGER slow_participant_insert AFTER INSERT ON participants
             FOR EACH ROW EXECUTE FUNCTION slow_participant_insert();"
        ))
        .unwrap();
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
            (502, Some("not-started")) => {
                handed_back += 1;
                assert!(
                    answer.elapsed < DISPATCH_DEADLINE,
                    "a first voter was handed back late: {answer:?}"
                );
            }
            _ => panic!(
                "a first voter was neither served nor handed back before dispatch: {answer:?}"
            ),
        }
    }
    let slowest = answers.iter().map(|a| a.elapsed).max().unwrap();
    let slowest_of = |status: u16| {
        answers
            .iter()
            .filter(|a| a.status == status)
            .map(|a| a.elapsed.as_millis())
            .max()
            .unwrap_or(0)
    };
    report(format!(
        "concurrent first votes: voters={FIRST_VOTERS}; served={}; handed_back={handed_back}; slowest_ms={}; slowest_served_ms={}; slowest_handed_back_ms={}",
        served.len(),
        slowest.as_millis(),
        slowest_of(200),
        slowest_of(502)
    ));
    assert!(!served.is_empty(), "no first voter was served: {answers:?}");
    // The race reached the pool's bound: the hand-back branch above ran.
    assert!(
        handed_back > 0,
        "no first voter was handed back, so the hand-back branch was not exercised: {answers:?}"
    );
    assert_eq!(served.len() + handed_back, FIRST_VOTERS);
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
    let mut c = stage.connect();
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
    // Nobody but the members and the served voters is a participant, a user
    // created here, or a voter: a voter handed back left no row anywhere.
    let created_users: i64 = c
        .query_one("select count(*) from users where uid > 100", &[])
        .unwrap()
        .get(0);
    assert_eq!(created_users, n, "users created by first votes");
    let voters: i64 = c
        .query_one("select count(distinct pid) from votes where zid=1", &[])
        .unwrap()
        .get(0);
    assert_eq!(voters, n, "participants with a vote");
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
/// Members' comments at once: as many as the comment writer's admission
/// reads hold.
const COMMENT_WRITES: usize = 2;
const READS_EACH: usize = 2;
/// The votes read's pool holds one.
const VOTES_READS: usize = 1;
const FIRST_VOTERS_UNDER_LOAD: usize = 8;
/// Rounds of participation per phase: the idle control and each loaded phase
/// are measured over the same number of samples.
const ROUNDS: usize = 10;

/// What a loaded phase may add over the idle control, the same requests
/// measured in the same test: at most this share more misses of a read's own
/// deadline, and a 95th percentile within twice the control's plus the slack.
const MISS_SHARE_PERCENT: usize = 5;
const LATENCY_SLACK: Duration = Duration::from_millis(25);

/// The kinds of participation request a round sends, in its order.
const KINDS: [&str; 5] = [
    "member votes",
    "comment writes",
    "next comment",
    "comment list",
    "votes read",
];

/// One round of participation at once: members' votes (two each, on the
/// three statements), members' comments, the next comment, the comment list
/// and the votes read (as many at once as their pools hold), and `first`
/// first votes. Answers in that order.
fn participation(
    rt: &tokio::runtime::Runtime,
    app: &Arc<App>,
    members: &[String; 2],
    first: usize,
    round: &str,
) -> Vec<Answer> {
    let mut requests: Vec<Request> = (0..MEMBER_VOTES)
        .map(|i| ballot((i % 3) as i32, Some(&members[i % 2])))
        .collect();
    requests.extend(
        (0..COMMENT_WRITES).map(|i| comment(&format!("{round}: comment {i}"), &members[i % 2])),
    );
    requests.extend((0..READS_EACH).map(|_| read(next_comment::PATH, "")));
    requests.extend((0..READS_EACH).map(|_| read(comments::PATH, "")));
    requests.extend((0..VOTES_READS).map(|_| read(crate::votes_read::PATH, "&pid=0&tid=0")));
    requests.extend((0..first).map(|_| ballot(0, None)));
    at_once(rt, app, requests)
}

/// Members' votes, members' comments, the next comment, the comment list,
/// the votes read, then first votes, as `participation` orders them.
fn split(answers: &[Answer]) -> [&[Answer]; 6] {
    let (members, rest) = answers.split_at(MEMBER_VOTES);
    let (written, rest) = rest.split_at(COMMENT_WRITES);
    let (next, rest) = rest.split_at(READS_EACH);
    let (list, rest) = rest.split_at(READS_EACH);
    let (votes, first) = rest.split_at(VOTES_READS);
    [members, written, next, list, votes, first]
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

/// Answered: a 200, and not a hand-back.
fn answered(answer: &Answer) -> bool {
    answer.status == 200 && answer.dispatch.is_none()
}

/// Every answer of kind `index` over a phase's rounds.
fn kind(rounds: &[Vec<Answer>], index: usize) -> Vec<Answer> {
    rounds
        .iter()
        .flat_map(|round| split(round)[index].to_vec())
        .collect()
}

fn p95(answers: &[Answer]) -> Duration {
    let mut elapsed: Vec<Duration> = answers.iter().map(|a| a.elapsed).collect();
    elapsed.sort_unstable();
    elapsed[(elapsed.len() * 95).div_ceil(100) - 1]
}

/// Each kind of participation in a loaded phase against the idle control:
/// misses no more than the control's plus `MISS_SHARE_PERCENT` of the
/// samples, and a 95th percentile within twice the control's plus
/// `LATENCY_SLACK`. Printed whether or not it holds; the kinds that do not
/// hold are returned.
fn latency_failures(phase: &str, control: &[Vec<Answer>], loaded: &[Vec<Answer>]) -> Vec<String> {
    let mut failures = vec![];
    for (index, name) in KINDS.iter().enumerate() {
        let (idle, busy) = (kind(control, index), kind(loaded, index));
        let misses = |answers: &[Answer]| answers.iter().filter(|a| !answered(a)).count();
        let allowed = misses(&idle) + (busy.len() * MISS_SHARE_PERCENT).div_ceil(100);
        let bound = p95(&idle) * 2 + LATENCY_SLACK;
        report(format!(
            "latency {phase}: {name}: samples={}; control_p95_ms={:.1}; loaded_p95_ms={:.1}; bound_ms={:.1}; control_misses={}; loaded_misses={}; allowed_misses={allowed}",
            busy.len(),
            p95(&idle).as_secs_f64() * 1000.0,
            p95(&busy).as_secs_f64() * 1000.0,
            bound.as_secs_f64() * 1000.0,
            misses(&idle),
            misses(&busy),
        ));
        if misses(&busy) > allowed {
            failures.push(format!(
                "{name}: {} misses, at most {allowed}",
                misses(&busy)
            ));
        }
        if p95(&busy) > bound {
            failures.push(format!(
                "{name}: p95 {:?} past {bound:?} (control {:?})",
                p95(&busy),
                p95(&idle)
            ));
        }
    }
    failures
}

/// The environment variable that makes a run of the loaded test its child:
/// the directory holding the database's address and the participant keys.
const LOADED_CHILD: &str = "POLIS_FIRST_CONTACT_LOAD_CHILD";

/// The comment writer exists only as its own startup builds it, from the
/// process environment (`post_comments::configure`). This test therefore
/// stages its database, then runs itself again in a child process given that
/// environment; the child sends every request. The fixture lock is held
/// exclusively here for the whole child run.
#[test]
fn participation_is_answered_as_when_idle_while_first_contacts_cannot_be_created() {
    if let Ok(dir) = std::env::var(LOADED_CHILD) {
        let dir = std::path::PathBuf::from(dir);
        let file = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap();
        let stage = Stage {
            _db: None,
            config: file("dsn").parse().unwrap(),
            private: file("private.pem"),
            public: file("public.pem"),
        };
        participation_under_first_contact_load(&stage);
        return;
    }
    let stage = stage("first_contact_exhausted", true);
    let dir = std::env::temp_dir().join(format!("first-contact-load-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut dsn = url::Url::parse(&std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap()).unwrap();
    dsn.set_path(&format!("/{}", stage.config.get_dbname().unwrap()));
    std::fs::write(dir.join("dsn"), dsn.as_str()).unwrap();
    std::fs::write(dir.join("private.pem"), &stage.private).unwrap();
    std::fs::write(dir.join("public.pem"), &stage.public).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "post_votes::tests::first_contact_load::participation_is_answered_as_when_idle_while_first_contacts_cannot_be_created",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env(LOADED_CHILD, &dir)
        .env("POLIS_API_POST_COMMENTS", "1")
        .env("SHOULD_USE_TRANSLATION_API", "false")
        .env("POLIS_API_POST_COMMENTS_DATABASE_URL", dsn.as_str())
        .env("POLIS_API_DB_TRANSPORT", "loopback")
        .env("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE", dir.join("public.pem"))
        .env("POLIS_JWT_ISSUER", "fixture")
        .env("POLIS_JWT_AUDIENCE", "fixture")
        .output()
        .unwrap();
    std::fs::remove_dir_all(&dir).ok();
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(line) = line.strip_prefix(REPORT) {
            report(line.to_owned());
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "the loaded run failed:\n{stdout}\n{}",
        &stderr[stderr.len().saturating_sub(8000)..]
    );
}

fn participation_under_first_contact_load(stage: &Stage) {
    let rt = runtime();
    let app = app_with(stage, &rt, true);
    let writer = app.post_votes.as_ref().unwrap();
    let lane = writer.first_contact.as_ref().unwrap().pool.clone();
    let members = [member_token(stage, 2, 0), member_token(stage, 3, 1)];
    let [comment_insert, comment_reads, comment_notifications] = app
        .post_comments
        .as_ref()
        .unwrap()
        .startup_pools()
        .map(Arc::clone);
    // The participation pools that are not the first contact's, and none of
    // which a first contact uses: none may time out an acquire.
    let theirs: Vec<(&str, Arc<db::Pool>)> = vec![
        ("vote append", writer.pool.clone()),
        ("vote admission reads", writer.reads.clone()),
        ("vote notifications", writer.background.pool.clone()),
        ("next comment", app.next_comment_db.clone().unwrap()),
        ("comment list", app.comments_db.clone().unwrap()),
        ("comment count", app.comments_count_db.clone().unwrap()),
        ("comment insert", comment_insert),
        ("comment admission reads", comment_reads),
        ("comment notifications", comment_notifications),
    ];
    // Printed, not asserted: a first contact's admission reads on the
    // identity pool, and the votes read is held to its own deadline by the
    // latency rule.
    let printed: Vec<(&str, Arc<db::Pool>)> = vec![
        (
            "vote identity reads",
            writer.identity_reads.clone().unwrap(),
        ),
        ("votes read", app.votes_read_db.clone().unwrap()),
        (
            "votes read identity",
            app.votes_read_auth_db.clone().unwrap(),
        ),
    ];
    let snapshot = |pools: &[(&str, Arc<db::Pool>)]| {
        pools
            .iter()
            .map(|(_, pool)| pool.evidence.snapshot())
            .collect::<Vec<_>>()
    };
    // [acquired, pending, timeouts, completed, errors, deadlines]
    let timeouts =
        |pools: &[(&'static str, Arc<db::Pool>)], before: &[[usize; 6]], after: &[[usize; 6]]| {
            pools
                .iter()
                .zip(before.iter().zip(after))
                .map(|((name, _), (b, a))| (*name, a[2] - b[2]))
                .collect::<Vec<_>>()
        };
    let assert_members_answered = |phase: &str, answers: &[Answer]| {
        let [members, _, next, list, _, _] = split(answers);
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
    // In every round: each member's vote and comment answered, and the
    // comment list answered (neither has a deadline of its own to miss). The
    // first round's next comment and votes read too; later rounds' misses of
    // their own deadlines are held to the latency rule.
    let assert_round = |phase: &str, round: usize, answers: &[Answer]| {
        let [members, written, _, list, votes, _] = split(answers);
        for answer in members.iter().chain(written) {
            assert!(
                answered(answer),
                "{phase} round {round}: a member's vote or comment was not answered: {answer:?}"
            );
        }
        for answer in list {
            assert_eq!(
                answer.status, 200,
                "{phase} round {round}: the comment list was not answered: {answer:?}"
            );
        }
        if round == 0 {
            assert_members_answered(phase, answers);
            for answer in votes {
                assert_eq!(
                    answer.status, 200,
                    "{phase}: the votes read was not answered: {answer:?}"
                );
            }
        }
    };
    let people = |stage: &Stage| rows(stage)[..3].to_vec();
    let comment_count = |stage: &Stage| -> i64 {
        stage
            .connect()
            .query_one("select count(*) from comments where zid=1", &[])
            .unwrap()
            .get(0)
    };
    let phase_report = |phase: &str, rounds: &[Vec<Answer>], extra: String| {
        let [m, w, n, l, v, f] = split(&rounds[0]);
        report(format!(
            "{phase}: member_votes={:?} slowest_ms={}; comment_writes={:?} slowest_ms={}; next_comment={:?} slowest_ms={}; comment_list={:?} slowest_ms={}; votes_read={:?} slowest_ms={}; first_votes={:?} slowest_ms={}; rounds={}; {extra}",
            statuses(m),
            slowest_ms(m),
            statuses(w),
            slowest_ms(w),
            statuses(n),
            slowest_ms(n),
            statuses(l),
            slowest_ms(l),
            statuses(v),
            slowest_ms(v),
            statuses(f),
            slowest_ms(f),
            rounds.len()
        ));
    };
    let run = |phase: &str, first: usize| -> Vec<Vec<Answer>> {
        let comments_before = comment_count(stage);
        let rounds: Vec<Vec<Answer>> = (0..ROUNDS)
            .map(|round| {
                let answers =
                    participation(&rt, &app, &members, first, &format!("{phase} {round}"));
                assert_round(phase, round, &answers);
                answers
            })
            .collect();
        assert_eq!(
            comment_count(stage),
            comments_before + (ROUNDS * COMMENT_WRITES) as i64,
            "{phase}: every member's comment is stored"
        );
        rounds
    };

    // Idle: the first contact's pool free and no first voter. The control.
    let idle = run("idle", 0);
    phase_report("idle", &idle, String::new());
    let people_before = people(stage);

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
    let (before, printed_before) = (snapshot(&theirs), snapshot(&printed));
    let exhausted = run("exhausted", FIRST_VOTERS_UNDER_LOAD);
    let (after, printed_after) = (snapshot(&theirs), snapshot(&printed));
    let lane_after = lane.evidence.snapshot();
    // The first voters: each handed back before dispatch, within a vote's
    // reply deadline. None was refused and none waited for the pool.
    let check_first = |phase: &str, rounds: &[Vec<Answer>]| {
        for answer in rounds.iter().flat_map(|round| split(round)[5]) {
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
    phase_report(
        "exhausted",
        &exhausted,
        format!(
            "first_contact_pool_timeouts={}; other_pool_timeouts={:?}; printed_pool_timeouts={:?}",
            lane_after[2] - lane_before[2],
            timeouts(&theirs, &before, &after),
            timeouts(&printed, &printed_before, &printed_after)
        ),
    );
    assert_members_answered("exhausted", &exhausted[0]);
    check_first("exhausted", &exhausted);
    assert_eq!(
        lane_after[0], lane_before[0],
        "the held first-contact pool lent a connection"
    );
    for (name, count) in timeouts(&theirs, &before, &after) {
        assert_eq!(count, 0, "exhausted: the {name} pool timed out an acquire");
    }
    assert_eq!(
        people(stage),
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
    let mut locker = stage.connect();
    locker
        .batch_execute(&format!(
            "BEGIN; SELECT pg_advisory_xact_lock({PARTICIPANT_NUMBER_LOCK}, 1);"
        ))
        .unwrap();
    let lane_before = lane.evidence.snapshot();
    let (before, printed_before) = (snapshot(&theirs), snapshot(&printed));
    let parked = run("parked", FIRST_VOTERS_UNDER_LOAD);
    let (after, printed_after) = (snapshot(&theirs), snapshot(&printed));
    let lane_after = lane.evidence.snapshot();
    phase_report(
        "parked",
        &parked,
        format!(
            "first_contact_pool_acquired={} timeouts={}; other_pool_timeouts={:?}; printed_pool_timeouts={:?}",
            lane_after[0] - lane_before[0],
            lane_after[2] - lane_before[2],
            timeouts(&theirs, &before, &after),
            timeouts(&printed, &printed_before, &printed_after)
        ),
    );
    assert_members_answered("parked", &parked[0]);
    check_first("parked", &parked);
    assert!(
        lane_after[0] > lane_before[0],
        "parked: no creation reached the participant-number lock"
    );
    for (name, count) in timeouts(&theirs, &before, &after) {
        assert_eq!(count, 0, "parked: the {name} pool timed out an acquire");
    }
    assert_eq!(
        people(stage),
        people_before,
        "parked: a first voter was written"
    );
    locker.batch_execute("ROLLBACK").unwrap();

    // Each loaded phase against the idle control, both printed first.
    let slower = [
        latency_failures("exhausted", &idle, &exhausted),
        latency_failures("parked", &idle, &parked),
    ];
    assert!(
        slower.iter().all(Vec::is_empty),
        "participation was slower than when idle (exhausted, parked): {slower:?}"
    );

    // Free again: a first vote is served, with the next participant number.
    let answer = rt.block_on(send(app.clone(), ballot(0, None)));
    assert_eq!(answer.status, 200, "{answer:?}");
    assert_eq!(served_participant(stage, &answer.body).1, 2);
}
