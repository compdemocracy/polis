//! The read lanes on a database: what a copy's line says of an answer the
//! live handler would give (its rows as a class, whether a comment was
//! selected, the counts and the math generation), the one thing an
//! observation does that a live request does not (the answer for a
//! participant with more than one row), and that every session a lane holds
//! refuses a write.
//!
//! Every stored vote of the fixture is written through `StorageConvention`.
use super::*;
use crate::votes::{StorageConvention, VoteChoice};

/// Participants of the fixture conversation, by how many rows each has.
const MANY: i32 = 1_918_273_645;
const ONE: i32 = 1_918_273_646;
const NOBODY: i32 = 1_918_273_647;
/// The math generation of the fixture's priorities.
const GENERATION: i64 = 7;

struct Fixture {
    url: String,
    schema: String,
    config: postgres::Config,
}

impl Fixture {
    /// One conversation of five comments, with a participant who has three
    /// rows, one who has one and one who has none, and priorities from one
    /// math generation.
    fn new(label: &str) -> Self {
        let url =
            std::env::var("POLIS_API_TEST_DATABASE_URL").expect("db-tests requires PostgreSQL");
        let schema = format!("read_lanes_{label}_{}", std::process::id());
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path={schema};
             CREATE TABLE zinvites(zid integer,zinvite text);
             CREATE TABLE conversations(zid integer,strict_moderation boolean);
             CREATE TABLE comments(zid integer,tid integer,txt text,created bigint,quote_src_url text,is_seed boolean,is_meta boolean,lang text,pid integer,original_id uuid,active boolean,velocity real,mod integer);
             CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote smallint,weight_x_32767 smallint,modified bigint);
             CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
             CREATE FUNCTION get_visible_comments(integer) RETURNS TABLE(tid integer) LANGUAGE SQL AS 'select tid from comments where zid=$1 AND active=true AND mod>=0';
             INSERT INTO zinvites(zid,zinvite) VALUES(1,'{CODE}');
             INSERT INTO conversations(zid,strict_moderation) VALUES(1,false);
             INSERT INTO comments(zid,tid,txt,created,is_seed,is_meta,lang,pid,active,velocity,mod)
               SELECT 1,t,'Generated comment '||t,1700000000000+t,false,false,'en',0,true,1,0 FROM generate_series(0,4) t;"
        ))
        .unwrap();
        c.execute(
            "INSERT INTO math_main(zid,math_env,math_tick,data) VALUES(1,'test',$1,'{\"comment-priorities\":{\"0\":2,\"1\":0.5}}')",
            &[&GENERATION],
        )
        .unwrap();
        let stored = |choice| StorageConvention::CURRENT.encode(choice) as i16;
        for (pid, tid, choice) in [
            (MANY, 0, VoteChoice::Agree),
            (MANY, 1, VoteChoice::Disagree),
            (MANY, 2, VoteChoice::Pass),
            (ONE, 0, VoteChoice::Agree),
        ] {
            c.execute(
                "INSERT INTO votes_latest_unique(zid,pid,tid,vote,weight_x_32767,modified) VALUES($1,$2,$3,$4,$5,$6)",
                &[&ZID, &pid, &tid, &stored(choice), &WEIGHT, &1_700_000_000_000_i64],
            )
            .unwrap();
        }
        let mut config: postgres::Config = url.parse().unwrap();
        config.options(&format!("-c search_path={schema}"));
        Self {
            url,
            schema,
            config,
        }
    }

    fn connector(&self) -> impl Fn() -> Connector + '_ {
        || Connector::Plain(Box::new(self.config.clone()))
    }

    fn digest(&self) -> Vec<String> {
        let mut c = self.config.connect(postgres::NoTls).unwrap();
        [
            "zinvites",
            "conversations",
            "comments",
            "votes_latest_unique",
            "math_main",
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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let mut c = postgres::Client::connect(&self.url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .unwrap();
    }
}

const ZID: i32 = 1;
const WEIGHT: i16 = 0;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

/// A pool's acquisitions so far.
fn acquired(pool: &db::Pool) -> usize {
    pool.evidence.snapshot()[0]
}

/// What a copy's line says of the answer: for the vote read its rows as none
/// or one, and for a participant with more than one row the live hand-back
/// with `rows: many`; for the comment list its rows; for the next comment
/// whether one was selected, the counts and the math generation of the
/// weights. A live request for the same participant is handed back after the
/// same two reads and no third: only an observation builds the answer for
/// more than one row. Nothing is written, and no line holds a participant
/// number.
#[test]
fn a_copys_line_reports_the_answer_as_classes_and_counts() {
    let fixture = Fixture::new("answers");
    let before = fixture.digest();
    let app = Arc::new(lanes_app(fixture.connector(), &Route::ALL, 1000, None));
    let rt = runtime();
    rt.block_on(async {
        let votes = shadow::Lane::new(1000);
        let observe = |route: Route, query: String| {
            let (app, votes) = (app.clone(), votes.clone());
            async move {
                let id = request_id();
                let req = copy(route, Some(&query), &[], &id);
                assert_eq!(accept_copy(&app, &votes, req).await, 204);
                observation(&id).await
            }
        };
        let base = format!("conversation_id={CODE}");
        // GET /api/v3/votes.
        for (pid, tid, outcome, status, reason, rows) in [
            (NOBODY, None, "would_serve", 200, None, "none"),
            (ONE, None, "would_serve", 200, None, "one"),
            (MANY, Some(1), "would_serve", 200, None, "one"),
            (MANY, Some(4), "would_serve", 200, None, "none"),
            (
                MANY,
                None,
                "would_hand_back",
                502,
                Some("many_rows"),
                "many",
            ),
        ] {
            let tid = tid
                .map(|tid: i32| format!("&tid={tid}"))
                .unwrap_or_default();
            let line = observe(Route::Votes, format!("{base}&pid={pid}{tid}")).await;
            assert_eq!(line["outcome"], outcome, "{line}");
            assert_eq!(line["status"], status, "{line}");
            assert_eq!(line["reason"], json!(reason), "{line}");
            assert_eq!(line["rows"], rows, "{line}");
            assert_eq!(line["zid"], ZID, "{line}");
            assert!(line["db_ms"].as_f64().is_some_and(|ms| ms > 0.0), "{line}");
            assert!(
                line["handler_ms"].as_f64() >= line["db_ms"].as_f64(),
                "{line}"
            );
        }
        // A conversation that is not there, and a code that is not the
        // conversation's own: no conversation number, no rows.
        let line = observe(Route::Votes, format!("conversation_id=2absent&pid={ONE}")).await;
        assert_eq!(line["reason"], "unknown_conversation");
        assert!(line["zid"].is_null() && line["rows"].is_null(), "{line}");
        // The same request, live: handed back, after the two reads the live
        // path makes. The copy made one more on the same pool.
        let reads = app.votes_read_db.as_ref().unwrap();
        let live = |pid: i32| {
            let app = app.clone();
            let base = base.clone();
            async move {
                let mut req = copy(Route::Votes, Some(&format!("{base}&pid={pid}")), &[], "");
                req.headers =
                    Headers::from_raw([("host", "localhost"), ("x-forwarded-proto", "https")]);
                route::handle(app, req).await
            }
        };
        let at = acquired(reads);
        let out = live(MANY).await;
        assert_eq!(out.status, 502);
        let crate::http::Body::Fixed(bytes) = out.body else {
            panic!("a fixed body expected")
        };
        assert_eq!(bytes, b"Bad Gateway\n");
        assert_eq!(
            acquired(reads) - at,
            2,
            "a live request read more than it did"
        );
        let at = acquired(reads);
        observe(Route::Votes, format!("{base}&pid={MANY}")).await;
        assert_eq!(acquired(reads) - at, 3, "the observation's one more read");
        let at = acquired(reads);
        assert_eq!(live(ONE).await.status, 200);
        assert_eq!(acquired(reads) - at, 2);
        // GET /api/v3/comments.
        for (more, rows) in [
            ("", "many"),
            ("&tids=3", "one"),
            ("&tids=99", "none"),
            ("&limit=2", "many"),
        ] {
            let line = observe(Route::Comments, format!("{base}{more}")).await;
            assert_eq!(line["outcome"], "would_serve", "{line}");
            assert_eq!(line["status"], 200);
            assert_eq!(line["rows"], rows, "{line}");
            assert_eq!(line["zid"], ZID);
            assert!(line["db_ms"].as_f64().is_some_and(|ms| ms > 0.0), "{line}");
        }
        let line = observe(Route::Comments, "conversation_id=2absent".to_owned()).await;
        assert_eq!(line["reason"], "unknown_conversation");
        assert!(line["zid"].is_null());
        // GET /api/v3/nextComment.
        let line = observe(Route::NextComment, base.clone()).await;
        assert_eq!(line["outcome"], "would_serve", "{line}");
        assert_eq!(line["selected"], true, "{line}");
        assert_eq!(line["remaining"], 5, "{line}");
        assert_eq!(line["total"], 5, "{line}");
        assert_eq!(line["weights_tick"], GENERATION, "{line}");
        assert_eq!(line["zid"], ZID);
        let line = observe(Route::NextComment, format!("{base}&without=0,1,2,3,4")).await;
        assert_eq!(line["outcome"], "would_serve", "{line}");
        assert_eq!(line["selected"], false, "{line}");
        assert_eq!(line["total"], 5, "{line}");
        assert_eq!(line["weights_tick"], GENERATION, "{line}");
        // An initial comment is not drawn: no weights are read for it.
        let line = observe(Route::NextComment, format!("{base}&initial_tid=2")).await;
        assert_eq!(line["outcome"], "would_serve", "{line}");
        assert_eq!(line["selected"], true, "{line}");
        assert!(line["weights_tick"].is_null(), "{line}");
        let line = observe(Route::NextComment, "conversation_id=2absent".to_owned()).await;
        assert_eq!(line["reason"], "unknown_conversation");
        assert!(
            line["zid"].is_null() && line["selected"].is_null(),
            "{line}"
        );
        // Every lane found its database.
        let health = health_of(&app, &votes).await;
        assert_eq!(health["status"], "ok");
        for route in Route::ALL {
            let lane = &health[route.health_key()];
            assert_eq!(lane["wouldFail"], 0);
            assert_eq!(lane["shed"], 0);
            assert!(lane["wouldServe"].as_u64().unwrap() >= 3, "{lane}");
        }
    });
    for printed in recorded() {
        for pid in [MANY, ONE, NOBODY] {
            assert!(!printed.contains(&pid.to_string()), "{printed}");
        }
    }
    assert_eq!(fixture.digest(), before, "an observation changed a row");
    drop(rt);
    drop(app);
}

/// Every session a lane holds is read-only: each pool of each lane refuses a
/// write, and so does the pool the handler reads from, which is the same one.
#[test]
fn every_session_a_read_lane_holds_refuses_a_write() {
    let fixture = Fixture::new("read_only");
    let before = fixture.digest();
    let app = Arc::new(lanes_app(fixture.connector(), &Route::ALL, 1000, None));
    let rt = runtime();
    rt.block_on(async {
        let mut refused = 0;
        for lane in app.read_lanes.built() {
            for (name, pool) in lane.pools() {
                for statement in [
                    "INSERT INTO conversations(zid,strict_moderation) VALUES(2,false)",
                    "UPDATE comments SET active=false",
                    "DELETE FROM votes_latest_unique",
                    "CREATE TABLE lane_write_probe(n integer)",
                ] {
                    let error = pool
                        .with(move |c| Ok(c.batch_execute(statement)?))
                        .await
                        .expect_err("a read lane's session wrote");
                    assert!(
                        format!("{error:#}").contains("read-only"),
                        "{} {name}: {error:#}",
                        lane.route.name()
                    );
                    refused += 1;
                }
                assert!(pool.ping().await, "the pool still reads");
            }
        }
        assert_eq!(refused, 5 * 4);
    });
    assert_eq!(fixture.digest(), before);
    drop(rt);
    drop(app);
}

/// Holds one connection of `pool` until the returned sender is used.
async fn hold(
    pool: &Arc<db::Pool>,
) -> (
    std::sync::mpsc::Sender<()>,
    tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    let (ready, wait) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    let pool = pool.clone();
    let work = tokio::spawn(async move {
        pool.with(move |_| {
            let _ = ready.send(());
            let _ = held.recv_timeout(Duration::from_secs(30));
            Ok(())
        })
        .await
    });
    wait.await.unwrap();
    (release, work)
}

/// A lane marked unreachable (a startup probe the database did not answer,
/// or three failed copies in a row) is reachable again when a copy is
/// answered, and when `/health` asks it again: a deploy's health check runs
/// before any copy can arrive, so a lane must not wait for one. A copy that
/// finds the lane's pool busy says `pool_busy`: that is not a failure of the
/// database, however many there are in a row.
#[test]
fn an_unreachable_lane_recovers_and_a_busy_pool_is_not_a_failure() {
    let fixture = Fixture::new("recovery");
    let app = Arc::new(lanes_app(fixture.connector(), &Route::ALL, 1000, None));
    let rt = runtime();
    rt.block_on(async {
        let votes = shadow::Lane::new(1000);
        let lane = app.read_lanes.get(Route::NextComment).unwrap();
        let query = format!("conversation_id={CODE}");
        // As a failed startup probe leaves a lane.
        lane.failures.store(UNREACHABLE, Ordering::Relaxed);
        assert!(!lane.reachable());
        // A copy the database answers clears the mark. A loaded machine can
        // run a copy past its 75 ms deadline, so up to five are sent and one
        // must be served.
        let mut served = false;
        for _ in 0..5 {
            lane.failures.store(UNREACHABLE, Ordering::Relaxed);
            let id = request_id();
            let req = copy(Route::NextComment, Some(&query), &[], &id);
            assert_eq!(accept_copy(&app, &votes, req).await, 204);
            if observation(&id).await["outcome"] == "would_serve" {
                assert!(
                    lane.reachable(),
                    "an answered copy left the lane unreachable"
                );
                served = true;
                break;
            }
        }
        assert!(served, "no copy was served");
        // With no copy at all, /health asks the lane again.
        lane.failures.store(UNREACHABLE, Ordering::Relaxed);
        let health = health_of(&app, &votes).await;
        assert_eq!(health["status"], "ok", "{health}");
        assert_eq!(
            health["getNextComment"]["pools"]["reads"]["reachable"], true,
            "{health}"
        );
        assert!(lane.reachable());
        // Every connection of the lane's pool held: its copies find it busy.
        let (_, pool) = lane.pools().first().unwrap();
        let mut held = vec![];
        for _ in 0..crate::next_comment::pool_limits().size {
            held.push(hold(pool).await);
        }
        for n in 0..=UNREACHABLE {
            let id = request_id();
            let req = copy(Route::NextComment, Some(&query), &[], &id);
            assert_eq!(accept_copy(&app, &votes, req).await, 204);
            let line = observation(&id).await;
            assert_eq!(line["outcome"], "would_hand_back", "{line}");
            assert_eq!(line["reason"], "pool_busy", "{line}");
            assert!(line["db_ms"].is_number(), "{line}");
            assert!(lane.reachable(), "after {n} busy copies");
        }
        // A busy pool does not clear the mark either: only an answer does.
        lane.failures.store(UNREACHABLE - 1, Ordering::Relaxed);
        let id = request_id();
        let req = copy(Route::NextComment, Some(&query), &[], &id);
        assert_eq!(accept_copy(&app, &votes, req).await, 204);
        assert_eq!(observation(&id).await["reason"], "pool_busy");
        assert_eq!(lane.failures.load(Ordering::Relaxed), UNREACHABLE - 1);
        for (release, work) in held {
            release.send(()).unwrap();
            work.await.unwrap().unwrap();
        }
    });
    drop(rt);
    drop(app);
}
