//! The featured-participants route against a database, on the route's own
//! pools. The expected replies are the unchanged Node server's, recorded.
use super::*;
use crate::math_bundle::Cache;
use std::sync::atomic::AtomicU64;

/// A moderator's "leave this participant out of the picture".
const HIDDEN: i32 = -1;
const NOW: u64 = 1_700_000_100_000;
/// Past the 30 seconds Node keeps a conversation's participant rows.
const COLD: u64 = 30_001;

use crate::votes::{StorageConvention, VoteChoice};
use VoteChoice::{Agree, Disagree, Pass};

fn stored(choice: VoteChoice) -> Option<i16> {
    i16::try_from(StorageConvention::CURRENT.encode(choice)).ok()
}

fn recorded(id: &str) -> String {
    let all: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../polis-contracts/src/fixtures/votes-famous.json"
    ))
    .unwrap();
    all.iter()
        .find(|r| r["id"] == id)
        .unwrap_or_else(|| panic!("no recording {id}"))["body"]
        .as_str()
        .unwrap()
        .to_owned()
}

const TABLES: &str = "
    CREATE TABLE zinvites(zid integer, zinvite text);
    CREATE TABLE conversations(zid integer, is_anon boolean, org_id integer);
    CREATE TABLE participants(zid integer, uid integer, pid integer, mod integer DEFAULT 0);
    CREATE TABLE comments(zid integer, tid integer, uid integer);
    CREATE TABLE xids(owner integer, uid integer, xid text, x_profile_image_url varchar(3000),
        x_name varchar(746), x_email varchar(256));
    CREATE TABLE votes(zid integer, pid integer, tid integer, vote smallint,
        created bigint GENERATED ALWAYS AS IDENTITY);
    CREATE TABLE math_main(zid integer, math_env text, data jsonb, math_tick bigint);
    CREATE TABLE math_bidtopid(zid integer, math_env text, data jsonb, math_tick bigint);
    CREATE TABLE math_ptptstats(zid integer, math_env text, data jsonb, math_tick bigint);
    CREATE TABLE math_ticks(zid integer, math_env text, math_tick bigint);
";

/// A schema of this test's own, and a session to write its fixture with.
struct Fixture {
    url: String,
    schema: String,
}

impl Fixture {
    async fn new(name: &str) -> Self {
        let fixture = Self {
            url: std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap(),
            schema: format!("{name}_{}", std::process::id()),
        };
        fixture
            .run(format!("CREATE SCHEMA {};", fixture.schema), TABLES.into())
            .await;
        fixture
    }

    /// Statements run in this schema; a failure fails the test.
    async fn run(&self, before: String, sql: String) {
        let (url, schema) = (self.url.clone(), self.schema.clone());
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("{before} SET search_path={schema}; {sql}"))
                .unwrap();
        })
        .await
        .unwrap();
    }

    async fn sql(&self, sql: &str) {
        self.run(String::new(), sql.into()).await;
    }

    /// One row of history: a choice, stored through the convention.
    async fn cast(&self, zid: i32, pid: i32, tid: i32, choice: VoteChoice) {
        self.history_row(zid, pid, tid, stored(choice)).await;
    }

    /// Many rows of history at once: one choice, stored through the
    /// convention, for each row (`zid`, `pid`, `tid`) the query names.
    async fn cast_many(&self, rows: &str, choice: VoteChoice) {
        let value = stored(choice).expect("a choice has a stored value");
        self.sql(&format!(
            "INSERT INTO votes(zid,pid,tid,vote)
             SELECT r.zid, r.pid, r.tid, {value}::smallint FROM ({rows}) r"
        ))
        .await;
    }

    /// Deliberately invalid storage, which no convention can express: no
    /// value at all, or a number that is no choice. Never a valid choice;
    /// those go through `cast`.
    async fn corrupt_vote_fixture(&self, zid: i32, pid: i32, tid: i32, value: Option<i16>) {
        assert!(
            StorageConvention::CURRENT
                .decode(value.map(i32::from))
                .is_none(),
            "a valid choice is written with cast"
        );
        self.history_row(zid, pid, tid, value).await;
    }

    async fn history_row(&self, zid: i32, pid: i32, tid: i32, value: Option<i16>) {
        let (url, schema) = (self.url.clone(), self.schema.clone());
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("SET search_path={schema}"))
                .unwrap();
            c.execute(
                "INSERT INTO votes(zid,pid,tid,vote) VALUES($1,$2,$3,$4)",
                &[&zid, &pid, &tid, &value],
            )
            .unwrap();
        })
        .await
        .unwrap();
    }

    async fn math(&self, zid: i32, tick: i64, main: &str, mapping: &str) {
        self.sql(&format!(
            "DELETE FROM math_main WHERE zid={zid}; DELETE FROM math_bidtopid WHERE zid={zid};
             DELETE FROM math_ptptstats WHERE zid={zid}; DELETE FROM math_ticks WHERE zid={zid};
             INSERT INTO math_main VALUES({zid},'test','{main}',{tick});
             INSERT INTO math_bidtopid VALUES({zid},'test','{mapping}',{tick});
             INSERT INTO math_ptptstats VALUES({zid},'test','{{}}',{tick});
             INSERT INTO math_ticks VALUES({zid},'test',{tick});"
        ))
        .await;
    }

    fn pool(&self, limits: crate::db::Limits) -> Arc<Pool> {
        let mut c: postgres::Config = self.url.parse().unwrap();
        c.options(&format!("-c search_path={}", self.schema));
        Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(c)),
            limits,
        )
    }

    async fn drop_schema(self) {
        self.run(
            String::new(),
            format!("DROP SCHEMA {} CASCADE;", self.schema),
        )
        .await;
    }
}

/// The route's state, pools and a clock the test moves.
struct Stack {
    state: State,
    math: Cache,
    pool: Arc<Pool>,
    auth_pool: Arc<Pool>,
    clock: AtomicU64,
}

impl Stack {
    /// These tests are about what is read, not how fast: the pools keep the
    /// route's sizes and read-only sessions, with room for a loaded test box.
    fn new(fixture: &Fixture) -> Self {
        let roomy = |limits: crate::db::Limits| crate::db::Limits {
            acquire_timeout: Duration::from_secs(5),
            statement_timeout: Duration::from_secs(5),
            ..limits
        };
        Self {
            state: State::default(),
            math: Cache::new(true),
            pool: fixture.pool(roomy(pool_limits())),
            auth_pool: fixture.pool(roomy(auth_pool_limits())),
            clock: AtomicU64::new(NOW),
        }
    }

    /// Pools hold blocking clients: they are dropped off the async threads.
    async fn close(self) {
        tokio::task::spawn_blocking(move || drop(self))
            .await
            .unwrap();
    }

    fn later(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    async fn ask(
        &self,
        zid: i32,
        uid: Option<i32>,
        tick: i64,
        limit: i32,
    ) -> Result<String, Handback> {
        let now = || self.clock.load(Ordering::SeqCst) as f64;
        Reader {
            state: &self.state,
            math: &self.math,
            math_env: "test",
            pool: &self.pool,
            auth_pool: &self.auth_pool,
            now_ms: &now,
        }
        .featured(
            zid,
            uid,
            &contract::Request {
                conversation_id: "2fixture".into(),
                math_tick: tick,
                limit,
            },
        )
        .await
    }

    /// The default limit, as a request without `ptptoiLimit`.
    async fn reply(&self, zid: i32, uid: Option<i32>, tick: i64) -> String {
        self.ask(zid, uid, tick, contract::DEFAULT_LIMIT)
            .await
            .unwrap()
    }
}

const BASE: &str = r#""base-clusters":{"id":[10,11,12,13]},"group-clusters":[{"id":0,"members":[10,11]},{"id":1,"members":[12,13]}]"#;

/// The recorded conversation of the driver's history group: every kind of
/// row in a participant's history, and both of Node's caches warm and cold.
#[tokio::test]
async fn histories_and_both_caches_answer_as_the_recorded_node_replies() {
    let fixture = Fixture::new("featured_history").await;
    fixture
        .sql(
            "INSERT INTO zinvites VALUES(1,'2fixture');
             INSERT INTO conversations VALUES(1,false,900);
             INSERT INTO participants(zid,uid,pid) VALUES(1,200001,0),(1,3,1),(1,2,2),(1,200004,3),
                (1,4,4),(1,310001,5),(1,310002,6),(1,310003,7);
             INSERT INTO comments VALUES(1,0,200001),(1,1,3),(1,2,200001),(1,3,3),(1,4,200001),
                (1,5,3),(1,6,200001);
             INSERT INTO xids VALUES
                (900,310001,'history-other','https://example.invalid/other.png','Other',NULL),
                (900,310002,'history-late','https://example.invalid/late.png','Late',NULL),
                (900,310003,'','','Address only','mail@example.invalid');",
        )
        .await;
    for (tid, choice) in [Agree, Pass, Disagree, Agree, Pass, Disagree, Agree]
        .into_iter()
        .enumerate()
    {
        fixture.cast(1, 1, tid as i32, choice).await;
    }
    fixture.cast(1, 1, 0, Disagree).await; // changed twice: the last one stands
    fixture.cast(1, 1, 0, Pass).await;
    // No value after a pass, and a number that is no choice after a
    // disagree: the pass and the disagree stand.
    fixture.corrupt_vote_fixture(1, 1, 1, None).await;
    fixture.corrupt_vote_fixture(1, 1, 2, Some(7)).await;
    // Never anything else on these two comments: unseen.
    fixture.corrupt_vote_fixture(1, 1, 12, None).await;
    fixture.corrupt_vote_fixture(1, 1, 15, Some(7)).await;
    fixture.cast(1, 1, 20, Agree).await;
    fixture.cast(1, 5, 3, Disagree).await;
    fixture.cast(1, 5, 30, Pass).await;
    fixture.cast(1, 7, 2, Agree).await;
    fixture
        .math(
            1,
            7,
            &format!(r#"{{"consensus":{{}},"repness":[],{BASE}}}"#),
            r#"{"bidToPid":[[1],[5],[6],[7]]}"#,
        )
        .await;
    let stack = Stack::new(&fixture);
    let latest = contract::LATEST_TICK;
    assert_eq!(
        stack.reply(1, Some(3), latest).await,
        recorded("history/cold/member")
    );
    // A requester without a credential, within the 30 seconds: the kept
    // rows, and no row of the member's.
    let anonymous = stack.reply(1, None, latest).await;
    assert_eq!(anonymous, recorded("history/warm/anonymous"));
    assert!(!anonymous.contains("isSelf") && !anonymous.contains(r#""1":"#));
    // A new choice at a higher comment number, at the same tick: the rows
    // are read again, the kept letters are not.
    fixture.cast(1, 5, 40, Agree).await;
    stack.later(COLD);
    assert_eq!(
        stack.reply(1, Some(3), latest).await,
        recorded("history/same-tick/cached-choices")
    );
    assert_eq!(
        stack.reply(1, Some(3), 8).await,
        recorded("history/newer-tick/read-again")
    );
    // A participant who appears later is read alone: lengths differ in one reply.
    fixture.cast(1, 6, 50, Disagree).await;
    stack.later(COLD);
    let mixed = stack.reply(1, Some(3), 8).await;
    assert_eq!(
        mixed,
        recorded("history/same-tick/one-participant-read-alone")
    );
    let lengths: BTreeSet<usize> = serde_json::from_str::<Response>(&mixed)
        .unwrap()
        .0
        .iter()
        .map(|p| p.choices.as_ref().unwrap().len())
        .collect();
    assert_eq!(lengths, BTreeSet::from([41, 51]));
    assert_eq!(
        stack.reply(1, Some(3), 9).await,
        recorded("history/newer-tick/all-read-together")
    );
    // The sessions are read-only: a write is refused.
    for pool in [&stack.pool, &stack.auth_pool] {
        let refused = pool
            .with(|c| {
                c.execute("INSERT INTO zinvites VALUES(2,'refused')", &[])?;
                Ok(())
            })
            .await;
        assert!(refused.is_err(), "the route's pools must refuse writes");
    }
    stack.close().await;
    fixture.drop_schema().await;
}

/// The recorded conversation of the driver's last group: a featured author
/// with an external id, as an anonymous requester, as themselves and as
/// another member see them; the requester's own row for each request; then
/// a second external id for the same person.
#[tokio::test]
async fn featured_authors_and_requesters_answer_as_the_recorded_node_replies() {
    let fixture = Fixture::new("featured_authors").await;
    fixture
        .sql(
            "INSERT INTO zinvites VALUES(1,'2fixture');
             INSERT INTO conversations VALUES(1,false,900);
             INSERT INTO participants(zid,uid,pid) VALUES(1,200001,0),(1,3,1),(1,2,2),(1,200004,3),(1,4,4);
             INSERT INTO comments VALUES(1,0,200001),(1,1,3),(1,2,200001),(1,3,3),(1,4,200001),
                (1,5,3),(1,6,200001);
             INSERT INTO xids VALUES(900,2,'no-picture-2',NULL,'No picture','two@example.invalid'),
                (777,200001,'elsewhere','https://example.invalid/elsewhere.png','Elsewhere',NULL);",
        )
        .await;
    // Participant 2 holds an external id under the conversation's account
    // with no picture: that does not feature them, in any reply below. The
    // owner holds one under another account: it is no part of their row here.
    for (tid, choice) in [Agree, Pass, Disagree, Agree, Pass, Disagree, Agree]
        .into_iter()
        .enumerate()
    {
        fixture.cast(1, 1, tid as i32, choice).await;
    }
    fixture.cast(1, 2, 0, Agree).await;
    fixture
        .math(
            1,
            6,
            &format!(
                r#"{{"consensus":{{"agree":[{{"tid":1}}]}},"repness":{{"0":[{{"tid":3}}]}},{BASE}}}"#
            ),
            // Participants 3 and 0 are placed from the start; nothing
            // features either of them in the recorded replies.
            r#"{"bidToPid":[[1],[2],[3],[0]]}"#,
        )
        .await;
    let stack = Stack::new(&fixture);
    let latest = contract::LATEST_TICK;
    // The author of two featured comments holds no external id yet.
    assert_eq!(
        stack.reply(1, None, 1).await,
        recorded("own-external-id/before/anonymous")
    );
    fixture
        .sql("INSERT INTO xids VALUES(900,3,'own-3','https://example.invalid/own3.png','Own \u{e9} \u{4e09}','three@example.invalid')")
        .await;
    stack.later(COLD);
    assert_eq!(
        stack.reply(1, None, latest).await,
        recorded("own-external-id/anonymous")
    );
    stack.later(COLD);
    assert_eq!(
        stack.reply(1, Some(3), latest).await,
        recorded("own-external-id/member")
    );
    stack.later(COLD);
    assert_eq!(
        stack.reply(1, Some(2), latest).await,
        recorded("own-external-id/second")
    );
    // The limit counts people, the requester first: none, then only them.
    assert_eq!(stack.ask(1, Some(2), 50, 0).await.unwrap(), "{}");
    let own = stack.ask(1, Some(2), 51, 1).await.unwrap();
    assert!(own.starts_with(r#"{"2":{"priority":1000,"#), "{own}");
    assert!(!own.contains(r#""1":"#), "{own}");
    // Within the 30 seconds of that key, each requester gets their own row
    // and nobody else's. The featured author asks: their own row, at the
    // requester's priority, and no row of the first requester's.
    let second = stack.ask(1, Some(3), 51, 1).await.unwrap();
    assert!(second.starts_with(r#"{"1":{"priority":1000,"#), "{second}");
    assert!(second.contains(r#""isSelf":true"#), "{second}");
    assert!(!second.contains(r#""2":"#), "{second}");
    // A requester without a credential: the featured author's row as it is
    // kept, at the author's priority, and nobody marked.
    let nobody = stack.ask(1, None, 51, 1).await.unwrap();
    assert!(nobody.starts_with(r#"{"1":{"priority":900,"#), "{nobody}");
    assert!(!nobody.contains("isSelf"), "{nobody}");
    assert!(!nobody.contains(r#""2":"#), "{nobody}");
    // A signed-in account that takes no part in the conversation, and a
    // participant without a vote: the same.
    assert_eq!(stack.ask(1, Some(987_654), 51, 1).await.unwrap(), nobody);
    assert_eq!(stack.ask(1, Some(200_004), 51, 1).await.unwrap(), nobody);
    // The first requester again: the bytes of their first reply.
    assert_eq!(stack.ask(1, Some(2), 51, 1).await.unwrap(), own);
    // With room for two, a requester who is not featured comes with the
    // featured author; the author alone is still their own row only.
    let both = stack.ask(1, Some(2), 51, 2).await.unwrap();
    assert!(both.starts_with(r#"{"1":{"priority":900,"#), "{both}");
    assert!(both.contains(r#""2":{"priority":1000,"#), "{both}");
    assert_eq!(both.matches("isSelf").count(), 1, "{both}");
    let wider = stack.ask(1, Some(3), 51, 2).await.unwrap();
    assert_eq!(wider, second);
    // The kept rows are the same for every requester for their 30 seconds:
    // a participant who becomes featured meanwhile appears to nobody until
    // they are read again, whoever asks; each requester's own row is read
    // at once.
    stack.reply(1, Some(2), 60).await;
    fixture
        .sql("INSERT INTO xids VALUES(900,200004,'later-3','https://example.invalid/later.png','Later',NULL)")
        .await;
    fixture.cast(1, 3, 0, Agree).await;
    fixture.cast(1, 0, 0, Agree).await;
    for uid in [Some(3), Some(200_001), None] {
        let within = stack.reply(1, uid, 60).await;
        assert!(!within.contains(r#""3":"#), "{uid:?} {within}");
    }
    // The tick is part of the rows' key: another tick is read anew, and the
    // first keeps its rows.
    let another = stack.reply(1, None, 61).await;
    assert!(another.contains(r#""3":{"priority":100,"#), "{another}");
    let first = stack.reply(1, None, 60).await;
    assert!(!first.contains(r#""3":"#), "{first}");
    // The owner had no vote when the rows were kept and has one now: their
    // own row is there, and it is in nobody else's reply.
    let owner = stack.reply(1, Some(200_001), 60).await;
    assert!(
        owner.starts_with(
            r#"{"0":{"priority":1000,"x_profile_image_url":null,"xid":null,"x_name":null,"x_email":null,"pid":0,"isSelf":true,"votes":"a","bid":13},"1":{"priority":900,"#
        ),
        "{owner}"
    );
    for uid in [Some(3), Some(2), None] {
        let other = stack.reply(1, uid, 60).await;
        assert!(!other.contains(r#""0":"#), "{uid:?} {other}");
    }
    stack.later(COLD);
    let after = stack.reply(1, Some(3), 60).await;
    assert!(after.contains(r#""3":{"priority":100,"#), "{after}");
    // A moderator's pin comes before a featured author; a hidden participant
    // with an external id is not featured for it, and a participant a
    // moderator has accepted without pinning (the owner here) is no pin.
    fixture
        .sql(&format!(
            "UPDATE participants SET mod=2 WHERE zid=1 AND uid=2;
             UPDATE participants SET mod=1 WHERE zid=1 AND uid=200001;
             INSERT INTO xids VALUES(900,4,'hidden-4','https://example.invalid/4.png','Hidden',NULL);
             UPDATE participants SET mod={HIDDEN} WHERE zid=1 AND uid=4;"
        ))
        .await;
    fixture.cast(1, 4, 0, Pass).await;
    let ranked = |reply: String| -> Vec<(i32, i32)> {
        serde_json::from_str::<Response>(&reply)
            .unwrap()
            .0
            .iter()
            .map(|p| (p.pid, p.priority))
            .collect()
    };
    assert_eq!(ranked(stack.ask(1, None, 52, 1).await.unwrap()), [(2, 999)]);
    // The limit is part of the rows' key: a wider limit at the same tick is
    // read anew, and the narrower one keeps its rows.
    assert_eq!(
        ranked(stack.ask(1, None, 52, 99).await.unwrap()),
        [(1, 900), (2, 999), (3, 100)]
    );
    assert_eq!(ranked(stack.ask(1, None, 52, 1).await.unwrap()), [(2, 999)]);
    // The requester takes the first place; the pin keeps the second and the
    // featured author gives up theirs. The pin, asking, is their own row.
    assert_eq!(
        ranked(stack.ask(1, Some(200_001), 52, 2).await.unwrap()),
        [(0, 1000), (2, 999)]
    );
    assert_eq!(
        ranked(stack.ask(1, Some(2), 52, 2).await.unwrap()),
        [(1, 900), (2, 1000)]
    );
    assert_eq!(
        ranked(stack.ask(1, None, 52, 2).await.unwrap()),
        [(1, 900), (2, 999)]
    );
    // A hidden participant is not featured for their external id, and is
    // still shown their own row. With a second external id under the
    // conversation's account their own row is two rows: Node keeps whichever
    // comes last, so that request is Node's, and only that one.
    assert_eq!(
        ranked(stack.ask(1, Some(4), 52, 99).await.unwrap()),
        [(1, 900), (2, 999), (3, 100), (4, 1000)]
    );
    fixture
        .sql("INSERT INTO xids VALUES(900,4,'hidden-4-again','https://example.invalid/4b.png','Again',NULL)")
        .await;
    assert_eq!(
        stack.ask(1, Some(4), 52, 99).await,
        Err(Handback::AmbiguousRows)
    );
    assert_eq!(
        ranked(stack.ask(1, None, 52, 99).await.unwrap()),
        [(1, 900), (2, 999), (3, 100)]
    );
    // Two external ids of one person under the conversation's account: Node
    // keeps whichever row comes last, so the request is Node's.
    fixture
        .sql("INSERT INTO xids VALUES(900,3,'own-3-again','https://example.invalid/again.png','Again',NULL)")
        .await;
    stack.later(COLD);
    assert_eq!(
        stack.ask(1, Some(3), latest, contract::DEFAULT_LIMIT).await,
        Err(Handback::AmbiguousRows)
    );
    // Nothing was kept from the request that went back.
    assert_eq!(
        stack.ask(1, Some(3), latest, contract::DEFAULT_LIMIT).await,
        Err(Handback::AmbiguousRows)
    );
    stack.close().await;
    fixture.drop_schema().await;
}

#[tokio::test]
async fn conversations_and_bounds_this_process_does_not_read_go_back_named() {
    let fixture = Fixture::new("featured_bounds").await;
    fixture
        .sql(&format!(
            "INSERT INTO conversations VALUES(1,true,900),(2,NULL,NULL),(3,false,900),(4,false,900),
                (6,false,900),(7,false,900),(7,false,900);
             INSERT INTO participants(zid,uid,pid) VALUES(1,3,1),(2,3,1),(3,3,1),(4,3,1),(4,2,2),(6,3,1);
             INSERT INTO xids VALUES(900,2,'long',repeat('p',3000),repeat('n',700),repeat('e',256)),
                (901,2,repeat('x',{ROW_TEXT_BYTES}),'https://example.invalid/2.png','Two',NULL);"
        ))
        .await;
    for zid in [1, 2, 3, 4] {
        fixture.cast(zid, 1, 0, Agree).await;
    }
    fixture.cast(4, 2, 0, Disagree).await;
    fixture.cast(3, 1, GREATEST_COMMENT + 1, Pass).await;
    fixture.cast(6, 1, GREATEST_COMMENT, Pass).await;
    // Math this process does not read whole, math whose tables disagree, and
    // math whose consensus is not in the shape the math writes.
    fixture
        .math(
            8,
            3,
            &format!(r#"{{"padding":"{}",{BASE}}}"#, "x".repeat(70_000)),
            r#"{"bidToPid":[[1]]}"#,
        )
        .await;
    fixture
        .math(9, 3, &format!("{{{BASE}}}"), r#"{"bidToPid":[[1]]}"#)
        .await;
    fixture
        .sql("UPDATE math_bidtopid SET math_tick=4 WHERE zid=9")
        .await;
    fixture
        .math(
            10,
            3,
            &format!(r#"{{"consensus":{{"agree":[{{"tid":null}}]}},{BASE}}}"#),
            r#"{"bidToPid":[[1]]}"#,
        )
        .await;
    let stack = Stack::new(&fixture);
    let ask = |zid, uid| stack.ask(zid, uid, contract::LATEST_TICK, contract::DEFAULT_LIMIT);
    // An anonymous conversation answers {} whoever asks.
    assert_eq!(ask(1, Some(3)).await.unwrap(), "{}");
    // A conversation whose anonymity was never set is not anonymous, and
    // one without an account for external ids has none to show.
    assert_eq!(
        ask(2, Some(3)).await.unwrap(),
        r#"{"1":{"priority":1000,"x_profile_image_url":null,"xid":null,"x_name":null,"x_email":null,"pid":1,"isSelf":true,"votes":"a"}}"#
    );
    // No row for the conversation, and two of them.
    assert_eq!(ask(5, Some(3)).await, Err(Handback::Conversation));
    assert_eq!(ask(7, None).await, Err(Handback::Conversation));
    // A comment number beyond the longest string of letters this process
    // builds, and the longest one it does build.
    assert_eq!(ask(3, Some(3)).await, Err(Handback::Oversize));
    assert_eq!(
        ask(6, Some(3)).await.unwrap().len(),
        GREATEST_COMMENT as usize + 1 + recorded("no-math/cold/member").len() - "apdapda".len()
    );
    // Within the bound a row's text is read whole, here 3960 bytes of it.
    let long = ask(4, Some(2)).await.unwrap();
    assert!(
        long.len() > 3700 && long.contains(&"n".repeat(700)) && long.contains(&"p".repeat(3000)),
        "{}",
        long.len()
    );
    // Beyond it the row comes back without its text, and the request is Node's.
    fixture
        .sql("UPDATE conversations SET org_id=901 WHERE zid=4")
        .await;
    stack.later(COLD);
    assert_eq!(ask(4, Some(2)).await, Err(Handback::Oversize));
    assert_eq!(ask(4, None).await, Err(Handback::Oversize));
    // The same bound holds for the requester's own row alone: hidden, the
    // participant is in nobody's kept rows, and their own request is Node's.
    fixture
        .sql(&format!(
            "UPDATE participants SET mod={HIDDEN} WHERE zid=4 AND uid=2"
        ))
        .await;
    stack.later(COLD);
    assert_eq!(ask(4, None).await.unwrap(), "{}");
    assert_eq!(ask(4, Some(2)).await, Err(Handback::Oversize));
    assert_eq!(ask(8, Some(3)).await, Err(Handback::MathUnreadable));
    assert_eq!(ask(9, Some(3)).await, Err(Handback::MathIncoherent));
    assert_eq!(ask(10, Some(3)).await, Err(Handback::MathShape));
    stack.close().await;
    fixture.drop_schema().await;
}

/// The bounds on what one request reads that the test above does not reach:
/// rows of history, featured authors, and the size of the reply. Node has none
/// of them, so each is a named hand-back and never a shorter reply.
#[tokio::test]
async fn each_bound_on_what_one_request_reads_goes_back_named() {
    let fixture = Fixture::new("featured_reads").await;
    // Conversation 1: one participant with one row of history more than is
    // read. Conversation 2: forty featured participants, each placed, each
    // with a choice on the greatest comment number that is read.
    // Conversation 3: one featured author more than is read.
    fixture
        .sql(&format!(
            "INSERT INTO conversations VALUES(1,false,900),(2,false,900),(3,false,901);
             INSERT INTO participants(zid,uid,pid) VALUES(1,3,1),(3,3,1);
             INSERT INTO participants(zid,uid,pid) SELECT 2,1000+g,g FROM generate_series(0,39) g;
             INSERT INTO xids SELECT 900,1000+g,'reply-'||g,'https://example.invalid/'||g||'.png',
                'Name',NULL FROM generate_series(0,39) g;
             INSERT INTO comments SELECT 3,g,5000+g FROM generate_series(0,{AUTHORS}) g;
             INSERT INTO xids SELECT 902,5000+g,'author-'||g,NULL,NULL,NULL
                FROM generate_series(0,{AUTHORS}) g;"
        ))
        .await;
    fixture
        .cast_many(
            &format!(
                "SELECT 1 AS zid, 1 AS pid, g % 7 AS tid FROM generate_series(0,{HISTORY_ROWS}) g"
            ),
            Agree,
        )
        .await;
    fixture
        .cast_many(
            &format!(
                "SELECT 2 AS zid, g AS pid, {GREATEST_COMMENT} AS tid FROM generate_series(0,39) g"
            ),
            Pass,
        )
        .await;
    fixture.cast(3, 1, 0, Agree).await;
    let everyone: Vec<String> = (0..40).map(|pid| pid.to_string()).collect();
    fixture
        .math(
            2,
            3,
            &format!("{{{BASE}}}"),
            &format!(r#"{{"bidToPid":[[{}]]}}"#, everyone.join(",")),
        )
        .await;
    let featured: Vec<String> = (0..=AUTHORS)
        .map(|tid| format!(r#"{{"tid":{tid}}}"#))
        .collect();
    fixture
        .math(
            3,
            3,
            &format!(
                r#"{{"consensus":{{"agree":[{}]}},{BASE}}}"#,
                featured.join(",")
            ),
            r#"{"bidToPid":[[1]]}"#,
        )
        .await;
    let stack = Stack::new(&fixture);
    let ask = |zid, uid, limit| stack.ask(zid, uid, contract::LATEST_TICK, limit);
    // One row of history more than is read.
    assert_eq!(
        ask(1, Some(3), contract::DEFAULT_LIMIT).await,
        Err(Handback::Oversize)
    );
    // Thirty-one participants' letters fit in a reply; thirty-two do not.
    let fits = ask(2, None, 31).await.unwrap();
    assert!(
        fits.len() > 31 * GREATEST_COMMENT as usize && fits.len() <= REPLY_BYTES,
        "{}",
        fits.len()
    );
    assert_eq!(ask(2, None, 32).await, Err(Handback::Oversize));
    // One featured author more than is read.
    assert_eq!(
        ask(3, Some(3), contract::DEFAULT_LIMIT).await,
        Err(Handback::Oversize)
    );
    stack.close().await;
    fixture.drop_schema().await;
}

/// The whole request path for a requester without a credential: the reply's
/// bytes, the named 502s, and what a full pool does.
#[tokio::test]
async fn requests_are_served_counted_and_shed_on_the_routes_own_pools() {
    let fixture = Fixture::new("featured_requests").await;
    fixture
        .sql(
            "INSERT INTO zinvites VALUES(1,'2fixture');
             INSERT INTO conversations VALUES(1,false,900);
             INSERT INTO participants(zid,uid,pid) VALUES(1,3,1),(1,2,2);
             INSERT INTO comments VALUES(1,1,3);
             INSERT INTO xids VALUES(900,2,'states-2','https://example.invalid/s2.png','Two',NULL);",
        )
        .await;
    fixture.cast(1, 1, 0, Agree).await;
    fixture.cast(1, 2, 0, Agree).await;
    fixture
        .math(
            1,
            0,
            &format!(r#"{{"consensus":{{"agree":[{{"tid":1}}]}},{BASE}}}"#),
            r#"{"bidToPid":[[1],[2],[],[]]}"#,
        )
        .await;
    let cfg = crate::config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: pool_limits(),
    };
    let mut app = App::new(&cfg, fixture.pool(pool_limits()));
    app.votes_famous_db = Some(fixture.pool(pool_limits()));
    app.votes_famous_auth_db = Some(fixture.pool(auth_pool_limits()));
    let app = Arc::new(app);
    let request = |method: &str, query: &str| Request {
        method: method.into(),
        target: format!("{PATH}?{query}"),
        headers: crate::http::Headers::from_raw([("host", "localhost")]),
        body: vec![],
    };
    let reason = |out: &Outgoing| {
        out.headers
            .iter()
            .find(|(name, _)| name == "X-Polis-Handback")
            .map(|(_, value)| value.clone())
    };
    let header = |out: &Outgoing, wanted: &str| {
        out.headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
            .map(|(_, value)| value.clone())
    };
    // A loaded test box can make this route shed a request to Node, as it is
    // built to: ask again, and count every answer. Nothing else is retried.
    let mut shed_by_load = 0;
    let mut settled = async |method: &str, query: &str| {
        for _ in 0..20 {
            let out = route::handle(app.clone(), request(method, query)).await;
            match reason(&out).as_deref() {
                Some("database" | "math_unreadable" | "deadline") => shed_by_load += 1,
                _ => return out,
            }
        }
        panic!("the route shed twenty requests in a row");
    };
    let out = settled("GET", "conversation_id=2fixture").await;
    assert_eq!(out.status, 200);
    let crate::http::Body::Fixed(body) = &out.body else {
        panic!("a short reply has a fixed length");
    };
    assert_eq!(
        String::from_utf8(body.clone()).unwrap(),
        recorded("state/tick-zero/anonymous")
    );
    assert_eq!(
        header(&out, "content-type").as_deref(),
        Some("application/json; charset=utf-8")
    );
    assert!(header(&out, "etag").is_some_and(|tag| tag.starts_with("W/\"")));
    assert_eq!(reason(&out), None);
    assert_eq!(
        settled("HEAD", "conversation_id=2fixture").await.status,
        200
    );
    // A code no conversation has.
    let unknown = settled("GET", "conversation_id=absent").await;
    assert_eq!(
        (unknown.status, reason(&unknown).as_deref()),
        (502, Some("conversation"))
    );
    // What this route does not admit goes back, named, without a query.
    for (query, why) in [
        ("conversation_id=2fixture&unknown=1", "request"),
        ("conversation_id=2fixture&ptptoiLimit=100", "request"),
        ("conversation_id=2fixture&math_tick=01", "request"),
        ("", "request"),
    ] {
        let out = route::handle(app.clone(), request("GET", query)).await;
        assert_eq!(
            (out.status, reason(&out).as_deref()),
            (502, Some(why)),
            "{query}"
        );
    }
    // Every slot of a pool held: the request is shed to Node at once. It
    // never waits for the slot, and never reaches another pool's.
    async fn park(
        pool: &Arc<Pool>,
        slots: usize,
    ) -> Vec<(
        std::sync::mpsc::Sender<()>,
        tokio::task::JoinHandle<anyhow::Result<()>>,
    )> {
        let mut held = Vec::new();
        for _ in 0..slots {
            let (ready, wait) = tokio::sync::oneshot::channel();
            let (release, parked) = std::sync::mpsc::channel::<()>();
            let pool = pool.clone();
            let work = tokio::spawn(async move {
                pool.with(move |_| {
                    let _ = ready.send(());
                    parked.recv_timeout(Duration::from_secs(5))?;
                    Ok(())
                })
                .await
            });
            wait.await.unwrap();
            held.push((release, work));
        }
        held
    }
    let held = park(
        app.votes_famous_auth_db.as_ref().unwrap(),
        auth_pool_limits().size,
    )
    .await;
    let shed = route::handle(app.clone(), request("GET", "conversation_id=2fixture")).await;
    assert_eq!(
        (shed.status, reason(&shed).as_deref()),
        (502, Some("database"))
    );
    for (release, work) in held {
        release.send(()).unwrap();
        work.await.unwrap().unwrap();
    }
    let held = park(app.votes_famous_db.as_ref().unwrap(), pool_limits().size).await;
    // Another tick: rows nothing has kept, so the data pool is needed.
    let shed = route::handle(
        app.clone(),
        request("GET", "conversation_id=2fixture&math_tick=5"),
    )
    .await;
    assert_eq!(shed.status, 502);
    // The math generation is read on the same pool when its three seconds
    // have passed; either way the database did not answer.
    assert!(matches!(
        reason(&shed).as_deref(),
        Some("database" | "math_unreadable")
    ));
    for (release, work) in held {
        release.send(()).unwrap();
        work.await.unwrap().unwrap();
    }
    assert_eq!(app.votes_famous_served.load(Ordering::Relaxed), 2);
    assert_eq!(
        app.votes_famous_fallback.load(Ordering::Relaxed),
        7 + shed_by_load
    );
    let counted = crate::js::stringify(&app.votes_famous.handbacks());
    let counted: serde_json::Value = serde_json::from_str(&counted).unwrap();
    assert_eq!(counted["request"], 4);
    assert_eq!(counted["conversation"], 1);
    assert_eq!(counted["off"], 0);
    assert_eq!(
        counted
            .as_object()
            .unwrap()
            .values()
            .map(|n| n.as_u64().unwrap())
            .sum::<u64>(),
        7 + shed_by_load
    );
    tokio::task::spawn_blocking(move || drop(app))
        .await
        .unwrap();
    fixture.drop_schema().await;
}
