//! The source loader's tests. The database tests (feature `db-tests`) build
//! their own `math_main` in a schema of their own, twice: in the shape the
//! migrations give it (`jsonb`, the migration's column order) and in the
//! shape of a database that predates the migrations (`json`, another column
//! order), so every statement is proven on both in every pass. Constructed
//! documents and made-up ids only.

use super::cache::{MAX_CACHE_BYTES, RoutingPlanCache};
use super::load::*;
use polis_routing_plan::{
    DEFAULT_CACHE_BYTES, MAX_SHARE_DIVISOR, Plan, Projection, Rejection, RuleConfig,
};

const STORED: &str = r#"{"rule":"stored-weights/1","params":{},"terms":[]}"#;
const UNIFORM: &str = r#"{"rule":"uniform/1","params":{},"terms":[]}"#;
const FLOOR: &str = r#"{"rule":"symmetric-gic-floor/2","params":{"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0,"meta_policy":"exclude","consensus_form":"gic-geomean/1","gic_offset":0.5,"gic_min_groups":2,"floor_share":0.1},"terms":[]}"#;
const FLOOR_POLICY: &str = "base-counts:lag-0";
const DIGEST: [u8; 32] = [7; 32];
const ENV: &str = "example";

fn job(zid: i32, text: &str, policy: Option<&str>, desired_tick: i64) -> Job {
    let rule = RuleConfig::parse(text, policy).unwrap();
    Job {
        zid,
        math_env: ENV.into(),
        desired_tick,
        rule_plain: rule.to_plain(),
        rule,
        policy: policy.map(Into::into),
        config_digest: DIGEST,
    }
}

fn cache() -> std::sync::Arc<RoutingPlanCache> {
    RoutingPlanCache::new(DEFAULT_CACHE_BYTES, Some(DIGEST)).unwrap()
}

/// One build's admission at the loader's limits fits one conversation's
/// share of the default budget, beside the connection's own charge.
#[test]
fn loader_admission_fits_one_share() {
    assert_eq!(MAX_CACHE_BYTES, DEFAULT_CACHE_BYTES);
    let share = DEFAULT_CACHE_BYTES / MAX_SHARE_DIVISOR;
    for text in [STORED, UNIFORM] {
        let j = job(1, text, None, 0);
        let allowance = allowance(&j.rule, &j).unwrap();
        let wanted = Projection::parse_reservation(LIMITS.max_bytes as usize, &LIMITS).unwrap()
            + LIMITS.max_bytes
            + allowance;
        println!("{text}: admission asks {wanted} of share {share}");
        let c = cache();
        let admitted = c
            .admit_build(LIMITS.max_bytes as usize, &LIMITS, allowance)
            .unwrap()
            .expect("admitted at the default budget");
        println!("{text}: admitted {} of share {share}", admitted.bytes());
        assert!(admitted.bytes() <= share);
        let connection = c.try_reserve(LIMITS.max_bytes + CONNECTION_FIXED).unwrap();
        assert!(connection.bytes() <= share);
    }
}

/// A rule with no calibrated build allowance (the floor) is refused before
/// anything is reserved or read: the loader never connects.
#[test]
fn rule_without_allowance_reads_nothing() {
    let primary = polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
        "host=127.0.0.1 port=1 user=nobody".parse().unwrap(),
    ));
    let mut loader = Loader::new(primary, None);
    let c = cache();
    let before = c.used_for_test();
    let outcome = loader.load(&c, &job(1, FLOOR, Some(FLOOR_POLICY), 0), &mut NoHooks);
    assert_eq!(outcome, Outcome::NoAllowance);
    assert_eq!(loader.open_target(), None);
    assert_eq!(c.used_for_test(), before);
}

/// A full budget admits nothing: no connection is opened and no statement
/// is sent, and the loader ends `NotAdmitted` after one retry.
#[test]
fn receive_buffer_reserved_before_fetch() {
    let primary = polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
        "host=127.0.0.1 port=1 user=nobody".parse().unwrap(),
    ));
    let mut loader = Loader::new(primary, None);
    let small = RoutingPlanCache::new(super::cache::MIN_CACHE_BYTES, Some(DIGEST)).unwrap();
    let outcome = loader.load(&small, &job(1, STORED, None, 0), &mut NoHooks);
    assert_eq!(outcome, Outcome::NotAdmitted);
    assert_eq!(loader.open_target(), None);
}

/// No outcome can carry a comment id, a participant, text or a vote: it is
/// a field-less enum but for the publication's own closed reason.
#[test]
fn outcomes_are_closed() {
    assert!(size_of::<Outcome>() <= 2);
    let _: fn(Rejection) -> Outcome = Outcome::Refused;
}

/// Nothing under `routing_plan/` touches a file (the boxes cannot keep
/// state): its source names no file API.
#[test]
fn no_fs_in_routing_plan() {
    for (name, text) in [
        ("mod.rs", include_str!("mod.rs")),
        ("cache.rs", include_str!("cache.rs")),
        ("load.rs", include_str!("load.rs")),
    ] {
        for word in ["std::fs", "fs::", "File::", "OpenOptions", "tempfile"] {
            assert!(!text.contains(word), "{name} names {word}");
        }
    }
}

/// The build's own bound is the crate's, never one the loader makes up.
#[test]
fn allowance_is_the_crates() {
    let j = job(1, STORED, None, 0);
    let build = Plan::build_allowance(&j.rule, &LIMITS).unwrap();
    assert!(allowance(&j.rule, &j).unwrap() > build);
    let _ = Projection::parse_reservation(LIMITS.max_bytes as usize, &LIMITS).unwrap();
}

#[cfg(feature = "db-tests")]
mod db {
    use super::*;
    use polis_queue_adapter::jobs::transport::Connector;
    use polis_routing_plan::{BuildRefusal, BundleKey, CachedPlan, RowIdentity};
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, mpsc};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[derive(Clone, Copy, Debug)]
    enum Shape {
        /// What the migrations build.
        Repository,
        /// A database that predates them: `json`, another column order.
        Older,
    }
    const SHAPES: [Shape; 2] = [Shape::Repository, Shape::Older];

    struct Db {
        url: String,
        schema: String,
        doc_type: &'static str,
    }

    fn url() -> String {
        std::env::var("POLIS_API_TEST_DATABASE_URL").expect("provide the isolated test database")
    }

    impl Db {
        fn new(shape: Shape) -> Self {
            let schema = format!(
                "routing_load_{}_{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            );
            let (doc_type, table) = match shape {
                Shape::Repository => (
                    "jsonb",
                    "zid integer NOT NULL, math_env varchar(999) NOT NULL, data jsonb NOT NULL, \
                     last_vote_timestamp bigint NOT NULL, caching_tick bigint NOT NULL DEFAULT 0, \
                     math_tick bigint NOT NULL DEFAULT -1, modified bigint, UNIQUE (zid, math_env)",
                ),
                Shape::Older => (
                    "json",
                    "zid integer NOT NULL, math_env varchar(999) NOT NULL, data json NOT NULL, \
                     last_vote_timestamp bigint NOT NULL, modified bigint, \
                     math_tick bigint NOT NULL DEFAULT -1, caching_tick bigint NOT NULL DEFAULT 0, \
                     UNIQUE (zid, math_env)",
                ),
            };
            let db = Self {
                url: url(),
                schema,
                doc_type,
            };
            db.client()
                .batch_execute(&format!(
                    "CREATE SCHEMA {s}; CREATE TABLE {s}.math_main ({table});",
                    s = db.schema
                ))
                .unwrap();
            db
        }

        fn config(&self) -> postgres::Config {
            let mut c: postgres::Config = self.url.parse().unwrap();
            c.options(&format!("-c search_path={}", self.schema));
            c
        }

        fn client(&self) -> postgres::Client {
            self.config().connect(postgres::NoTls).unwrap()
        }

        fn connector(&self) -> Connector {
            Connector::Plain(Box::new(self.config()))
        }

        fn put(&self, zid: i32, tick: i64, doc: &Value) {
            self.client()
                .execute(
                    &format!(
                        "INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, math_tick) \
                         VALUES ($1, $2, $3::text::{t}, $4, $5) \
                         ON CONFLICT (zid, math_env) DO UPDATE SET data = excluded.data, \
                         math_tick = excluded.math_tick, last_vote_timestamp = excluded.last_vote_timestamp",
                        t = self.doc_type
                    ),
                    &[&zid, &ENV, &doc.to_string(), &(1_700_000_000_000 + tick), &tick],
                )
                .unwrap();
        }
    }

    impl Drop for Db {
        fn drop(&mut self) {
            if let Ok(mut c) = self.config().connect(postgres::NoTls) {
                let _ = c.batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema));
            }
        }
    }

    /// A constructed math result: the keys the adapter reads, and keys it
    /// does not (which the projection must leave out).
    fn doc(tids: &[i32], json_tick: i64) -> Value {
        let votes: serde_json::Map<String, Value> = tids
            .iter()
            .map(|t| (t.to_string(), json!({"A": 2, "D": 1, "S": 4})))
            .collect();
        let priorities: serde_json::Map<String, Value> = tids
            .iter()
            .map(|t| (t.to_string(), json!(1.5)))
            .collect();
        json!({
            "tids": tids,
            "meta-tids": [],
            "comment-priorities": priorities,
            "pca": {
                "comment-extremity": tids.iter().map(|_| 0.25).collect::<Vec<_>>(),
                "comment-projection": [[0.0], [0.0]],
                "center": [0.0],
                "comps": [[0.0]]
            },
            "group-votes": {"0": {"id": 0, "n-members": 4, "votes": votes}},
            "group-clusters": [{"id": 0, "members": [100], "center": [0.0, 0.0]}],
            "base-clusters": {"id": [100], "members": [[1, 2, 3, 4]], "count": [4], "x": [0.0], "y": [0.0]},
            "math_tick": json_tick,
            "n": 4,
            "lastVoteTimestamp": 1
        })
    }

    /// A math result older than group inputs: tids and priorities only.
    fn old_doc(tids: &[i32]) -> Value {
        json!({"tids": tids, "comment-priorities": {}, "n": 4})
    }

    struct At<F: FnMut(Stage, Option<i32>)>(F);
    impl<F: FnMut(Stage, Option<i32>)> Hooks for At<F> {
        fn at(&mut self, stage: Stage, backend: Option<i32>) {
            (self.0)(stage, backend)
        }
    }

    /// A normal result publishes; the projection is exactly the stored
    /// result's own values under the keys the adapter reads (the stored
    /// extremity, never a derived one; nothing the adapter does not read),
    /// and the tick is the row's column, never the document's.
    #[test]
    fn normal_result_publishes_the_stored_fields() {
        for shape in SHAPES {
            let db = Db::new(shape);
            let d = doc(&[11, 12, 13], 999);
            db.put(1, 41, &d);
            let source = read_source(&mut db.client(), 1, ENV, LIMITS.max_bytes)
                .unwrap()
                .unwrap();
            assert_eq!(source.row.math_tick, 41, "{shape:?}");
            assert_eq!(source.row.math_env, ENV);
            assert_eq!(source.row.last_vote_timestamp, Some(1_700_000_000_041));
            let text = source.projection.unwrap();
            assert_eq!(source.projection_bytes, text.len() as i64);
            let got: Value = serde_json::from_str(&text).unwrap();
            let want = json!({
                "group-votes": d["group-votes"],
                "pca": {"comment-extremity": d["pca"]["comment-extremity"]},
                "tids": d["tids"],
                "meta-tids": d["meta-tids"],
                "comment-priorities": d["comment-priorities"],
                "group-clusters": d["group-clusters"],
                "base-clusters": d["base-clusters"],
            });
            assert_eq!(got, want, "{shape:?}");

            let c = cache();
            let mut loader = Loader::new(db.connector(), None);
            let outcome = loader.load(&c, &job(1, STORED, None, 41), &mut NoHooks);
            assert_eq!(outcome, Outcome::Published, "{shape:?}");
            assert!(c.fenced(1, ENV).unwrap());
            assert_eq!(loader.open_target(), Some(Target::Primary));
        }
    }

    /// No current row: `NoRow`, remembered, so the next load for that tick
    /// backs off instead of reading again.
    #[test]
    fn missing_row_is_no_row_then_backs_off() {
        for shape in SHAPES {
            let db = Db::new(shape);
            let c = cache();
            let mut loader = Loader::new(db.connector(), None);
            let j = job(2, STORED, None, 5);
            assert_eq!(loader.load(&c, &j, &mut NoHooks), Outcome::NoRow, "{shape:?}");
            assert_eq!(loader.load(&c, &j, &mut NoHooks), Outcome::BackingOff);
        }
    }

    /// A result older than group inputs is read, and the adapter refuses a
    /// plan that needs them as missing: today's draw is the fallback.
    #[test]
    fn older_result_without_group_inputs_is_missing() {
        for shape in SHAPES {
            let db = Db::new(shape);
            db.put(3, 7, &old_doc(&[21, 22]));
            let source = read_source(&mut db.client(), 3, ENV, LIMITS.max_bytes)
                .unwrap()
                .unwrap();
            let text = source.projection.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&text).unwrap(),
                json!({"tids": [21, 22], "comment-priorities": {}})
            );
            let projection = Projection::parse(text.as_bytes(), source.row, &LIMITS).unwrap();
            let floor = RuleConfig::parse(FLOOR, Some(FLOOR_POLICY)).unwrap();
            let missing = match projection.frames(floor.needs()) {
                Err(_) => true,
                Ok(f) => matches!(
                    Plan::build(&f, &floor),
                    Err(BuildRefusal::MissingFrame { .. })
                ),
            };
            assert!(missing, "{shape:?}");
        }
    }

    /// Past the byte bound, only the length crosses the wire: the statement
    /// itself withholds the document. Through the loader: `Oversized`.
    #[test]
    fn oversized_refused_before_transfer() {
        for shape in SHAPES {
            let db = Db::new(shape);
            db.put(4, 9, &doc(&[1, 2, 3], 9));
            let source = read_source(&mut db.client(), 4, ENV, 64).unwrap().unwrap();
            assert!(source.projection_bytes > 64, "{shape:?}");
            assert!(source.projection.is_none(), "{shape:?}");

            let tids: Vec<i32> = (0..300_000).collect();
            db.put(5, 9, &json!({"tids": tids, "comment-priorities": {}}));
            let c = cache();
            let mut loader = Loader::new(db.connector(), None);
            let outcome = loader.load(&c, &job(5, STORED, None, 9), &mut NoHooks);
            assert_eq!(outcome, Outcome::Oversized, "{shape:?}");
        }
    }

    /// Identity and content come from one statement: a two-statement read
    /// across a committed math update returns a mixed bundle; the loader's
    /// one statement, under a writer that keeps updating, never does.
    #[test]
    fn one_statement_one_snapshot() {
        for shape in SHAPES {
            let db = Db::new(shape);
            db.put(6, 1, &json!({"tids": [1]}));
            // The witness: two statements with an update between them.
            let mut naive = db.client();
            let tick: i64 = naive
                .query_one("select math_tick from math_main where zid = 6", &[])
                .unwrap()
                .get(0);
            db.put(6, 2, &json!({"tids": [2]}));
            let tids: String = naive
                .query_one("select (data -> 'tids')::text from math_main where zid = 6", &[])
                .unwrap()
                .get(0);
            assert_ne!(format!("[{tick}]"), tids.replace(' ', ""), "the witness mixes");

            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let start = Arc::new(Barrier::new(2));
            let writer = {
                let (stop, start) = (stop.clone(), start.clone());
                let mut w = db.client();
                let t = db.doc_type;
                std::thread::spawn(move || {
                    start.wait();
                    let mut n = 3i64;
                    while !stop.load(Ordering::SeqCst) {
                        w.execute(
                            &format!(
                                "update math_main set math_tick = $1::int8, \
                                 data = json_build_object('tids', json_build_array($1::int8))::{t} where zid = 6"
                            ),
                            &[&n],
                        )
                        .unwrap();
                        n += 1;
                    }
                })
            };
            start.wait();
            let mut reader = db.client();
            for _ in 0..300 {
                let s = read_source(&mut reader, 6, ENV, LIMITS.max_bytes)
                    .unwrap()
                    .unwrap();
                let v: Value = serde_json::from_str(&s.projection.unwrap()).unwrap();
                assert_eq!(v["tids"], json!([s.row.math_tick]), "{shape:?}");
            }
            stop.store(true, Ordering::SeqCst);
            writer.join().unwrap();
        }
    }

    /// The connection is idle (no statement, no open transaction) once the
    /// row is received, before anything is parsed or built.
    #[test]
    fn connection_released_before_parse() {
        for shape in SHAPES {
            let db = Db::new(shape);
            db.put(7, 3, &doc(&[1, 2], 3));
            let c = cache();
            let mut loader = Loader::new(db.connector(), None);
            let mut observer = db.client();
            let mut seen = None;
            let outcome = loader.load(
                &c,
                &job(7, STORED, None, 3),
                &mut At(|stage, backend| {
                    if stage == Stage::AfterRead {
                        let state: String = observer
                            .query_one(
                                "select state from pg_stat_activity where pid = $1",
                                &[&backend.unwrap()],
                            )
                            .unwrap()
                            .get(0);
                        seen = Some(state);
                    }
                }),
            );
            assert_eq!(outcome, Outcome::Published);
            assert_eq!(seen.as_deref(), Some("idle"), "{shape:?}");
        }
    }

    /// A math update that lands between the reservation and the publication:
    /// the newer update publishes first, and the older build is refused as
    /// superseded (the pointer only moves forward).
    #[test]
    fn math_update_between_reserve_and_publish() {
        for shape in SHAPES {
            let db = Db::new(shape);
            db.put(8, 10, &doc(&[1, 2], 10));
            let c = cache();
            let mut first = Loader::new(db.connector(), None);
            let mut second = Loader::new(db.connector(), None);
            let mut inner = None;
            let outcome = first.load(
                &c,
                &job(8, STORED, None, 10),
                &mut At(|stage, _| {
                    if stage == Stage::BeforePublish {
                        db.put(8, 11, &doc(&[1, 2, 3], 11));
                        inner = Some(second.load(&c, &job(8, STORED, None, 11), &mut NoHooks));
                    }
                }),
            );
            assert_eq!(inner, Some(Outcome::Published), "{shape:?}");
            assert_eq!(outcome, Outcome::Refused(Rejection::Superseded), "{shape:?}");
        }
    }

    /// Unfenced, the primary is read even when a replica is configured;
    /// fenced, the replica is read; a fence forgotten between that read and
    /// the publication refuses it (`FenceForgotten`), because the same
    /// reservation, cut down, is published.
    #[test]
    fn replica_only_when_fenced_and_forgotten_fence_refuses() {
        for shape in SHAPES {
            let primary = Db::new(shape);
            let replica = Db::new(shape);
            primary.put(9, 10, &doc(&[1, 2], 10));
            replica.put(9, 8, &doc(&[1], 8));
            let c = cache();
            let mut loader = Loader::new(primary.connector(), Some(replica.connector()));
            let outcome = loader.load(&c, &job(9, STORED, None, 10), &mut NoHooks);
            assert_eq!(outcome, Outcome::Published, "{shape:?}");
            assert_eq!(loader.open_target(), Some(Target::Primary));
            // The plan goes; its fence stays.
            assert_eq!(c.evict_lru().unwrap(), Some(true));
            assert!(c.fenced(9, ENV).unwrap());
            let outcome = loader.load(
                &c,
                &job(9, STORED, None, 10),
                &mut At(|stage, _| {
                    if stage == Stage::BeforePublish {
                        c.set_config(None).unwrap();
                        c.set_config(Some(DIGEST)).unwrap();
                        assert!(!c.fenced(9, ENV).unwrap());
                    }
                }),
            );
            assert_eq!(loader.open_target(), Some(Target::Replica), "{shape:?}");
            assert_eq!(outcome, Outcome::Refused(Rejection::FenceForgotten), "{shape:?}");
        }
    }

    /// A full fence table: the loader evicts one plan and publishes once more.
    #[test]
    fn fence_full_evicts_and_retries_once() {
        let db = Db::new(Shape::Older);
        db.put(50_000, 1, &doc(&[1], 1));
        let c = cache();
        let uniform = RuleConfig::parse(UNIFORM, None).unwrap();
        for zid in 0..polis_routing_plan::FENCE_ENTRIES as i32 {
            let row = RowIdentity {
                zid,
                math_env: ENV.into(),
                math_tick: 1,
                last_vote_timestamp: Some(1),
                db_now_ms: 1,
            };
            let projection = Projection::parse(b"{}", row, &LIMITS).unwrap();
            let frames = projection.frames(uniform.needs()).unwrap();
            let plan = Plan::build(&frames, &uniform).unwrap();
            let key = BundleKey::of(&projection, &uniform, None, DIGEST);
            let cached = CachedPlan::new(key, plan, c.reading()).unwrap();
            let need = cached.charge() + 8192;
            let r = c.try_reserve(need).unwrap();
            r.publish(super::super::cache::PlanRef::new(cached)).unwrap();
        }
        let mut loader = Loader::new(db.connector(), None);
        let outcome = loader.load(&c, &job(50_000, UNIFORM, None, 1), &mut NoHooks);
        assert_eq!(outcome, Outcome::Published);
        assert!(c.fenced(50_000, ENV).unwrap());
    }

    /// A statement held past the timeout is cancelled and ends
    /// `StatementTimeout`; the next load opens a fresh connection and works.
    #[test]
    fn statement_timeout_cancels() {
        let db = Db::new(Shape::Repository);
        db.put(10, 1, &doc(&[1], 1));
        let mut locker = db.client();
        locker
            .batch_execute("BEGIN; LOCK TABLE math_main IN ACCESS EXCLUSIVE MODE")
            .unwrap();
        let c = cache();
        let mut loader = Loader::new(db.connector(), None);
        let started = std::time::Instant::now();
        let outcome = loader.load(&c, &job(10, STORED, None, 1), &mut NoHooks);
        assert_eq!(outcome, Outcome::StatementTimeout);
        assert!(started.elapsed() < STATEMENT_TIMEOUT + IO_TIMEOUT);
        assert_eq!(loader.open_target(), None);
        locker.batch_execute("ROLLBACK").unwrap();
        let outcome = loader.load(&c, &job(10, STORED, None, 2), &mut NoHooks);
        assert_eq!(outcome, Outcome::Published);
    }

    /// The loader's own thread: started from a tokio runtime's thread, it
    /// still loads (the synchronous client panics when it runs on a runtime
    /// thread, as this test's own setup would), and ends when its jobs'
    /// sender is gone.
    #[test]
    fn loader_runs_on_its_own_thread() {
        let db = Db::new(Shape::Older);
        db.put(11, 1, &doc(&[1, 2], 1));
        let connector = db.connector();
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let (handle, outcome) = rt.block_on(async move {
            let (jobs, rx) = mpsc::sync_channel(1);
            let (tx, outcomes) = mpsc::sync_channel(1);
            let handle = spawn(Loader::new(connector, None), cache(), rx, tx).unwrap();
            jobs.send(job(11, STORED, None, 1)).unwrap();
            drop(jobs);
            (handle, outcomes.recv().unwrap())
        });
        assert_eq!(outcome, Outcome::Published);
        assert_eq!(handle.thread().name(), Some("polis-api-routing-plan-loader"));
        handle.join().unwrap();
    }
}
}
