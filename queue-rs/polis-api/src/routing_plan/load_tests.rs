//! The source loader's tests. The database tests (feature `db-tests`) build
//! their own `math_main` in a schema of their own, twice: in the shape the
//! migrations give it (`jsonb`, the migration's column order) and in the
//! shape of a database that predates the migrations (`json`, another column
//! order), so every statement is proven on both in every pass. Constructed
//! documents and made-up ids only.

use super::cache::{MAX_CACHE_BYTES, RoutingPlanCache};
use super::load::*;
use polis_routing_plan::{
    DEFAULT_CACHE_BYTES, MAX_SHARE_DIVISOR, Plan, Projection, Rejection, RowIdentity, RuleConfig,
    SourceLimits,
};
use serde_json::{Value, json};

const STORED: &str = r#"{"rule":"stored-weights/1","params":{},"terms":[]}"#;
const UNIFORM: &str = r#"{"rule":"uniform/1","params":{},"terms":[]}"#;
const FLOOR: &str = r#"{"rule":"symmetric-gic-floor/2","params":{"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0,"meta_policy":"exclude","consensus_form":"gic-geomean/1","gic_offset":0.5,"gic_min_groups":2,"floor_share":0.1},"terms":[]}"#;
/// The floor with meta comments weighed by a fixed factor: `exclude` is
/// refused past 10,000 comments by the rule itself.
const FLOOR_FIXED: &str = r#"{"rule":"symmetric-gic-floor/2","params":{"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0,"meta_policy":"fixed","consensus_form":"gic-geomean/1","gic_offset":0.5,"gic_min_groups":2,"floor_share":0.1},"terms":[]}"#;
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

/// A constructed math result: the keys the adapter reads, and keys it
/// does not (which the projection must leave out).
fn doc(tids: &[i32], json_tick: i64) -> Value {
    let votes: serde_json::Map<String, Value> = tids
        .iter()
        .map(|t| (t.to_string(), json!({"A": 2, "D": 1, "S": 4})))
        .collect();
    let priorities: serde_json::Map<String, Value> =
        tids.iter().map(|t| (t.to_string(), json!(1.5))).collect();
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

/// The projection the statement would send for `doc`: its read keys only.
fn projected(d: &Value) -> Vec<u8> {
    let mut p = serde_json::Map::new();
    for k in [
        "group-votes",
        "tids",
        "meta-tids",
        "comment-priorities",
        "group-clusters",
        "base-clusters",
    ] {
        p.insert(k.into(), d[k].clone());
    }
    p.insert(
        "pca".into(),
        json!({"comment-extremity": d["pca"]["comment-extremity"]}),
    );
    serde_json::to_vec(&Value::Object(p)).unwrap()
}

fn row(zid: i32, tick: i64) -> RowIdentity {
    RowIdentity {
        zid,
        math_env: ENV.into(),
        math_tick: tick,
        last_vote_timestamp: Some(1_700_000_000_000 + tick),
        db_now_ms: 1_700_000_100_000,
    }
}

fn unreachable() -> Loader {
    Loader::new(
        polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
            "host=127.0.0.1 port=1 user=nobody".parse().unwrap(),
        )),
        None,
    )
}

/// Takes every byte of the budget left, in pieces of at most one share.
fn fill(c: &std::sync::Arc<RoutingPlanCache>) -> Vec<super::cache::Reserved> {
    let mut held = vec![];
    let mut n = DEFAULT_CACHE_BYTES / MAX_SHARE_DIVISOR;
    while n > 0 {
        match c.try_reserve(n) {
            Ok(r) => held.push(r),
            Err(_) => n /= 2,
        }
    }
    held
}

/// Records what the build's one reservation holds at each stage.
#[derive(Default)]
struct Record(Vec<(Stage, u64)>);
impl Hooks for Record {
    fn reserved(&mut self, stage: Stage, bytes: u64) {
        self.0.push((stage, bytes));
    }
}

/// The steps after the read, on constructed bytes, through to publication.
fn staged(
    c: &std::sync::Arc<RoutingPlanCache>,
    j: &Job,
    bytes: Vec<u8>,
    hooks: &mut dyn Hooks,
) -> Outcome {
    let l = limits(&j.rule);
    let r = c.admit_read(l.max_bytes, &l).unwrap().unwrap();
    match stages(c, r, bytes, row(j.zid, j.desired_tick), j, hooks) {
        Ok((r, cached)) => match r.publish(super::cache::PlanRef::new(cached)) {
            Ok(()) => Outcome::Published,
            Err(_) => Outcome::Refused(Rejection::Superseded),
        },
        Err(o) => o,
    }
}

/// The read's reservation is a stated fraction of one share (an eighth),
/// and the connection's charge covers the largest `max_bytes` of any rule
/// (from review: a connection charged for a smaller rule would leave the
/// rest of a larger row uncharged); both held at once at the read fit a
/// quarter of a share and 64 KiB. Prints, per rule, the largest length any
/// content of which is admitted (the worst case of a source of that length
/// at every stage) beside the read's cap; the stages of the constructed
/// witnesses are printed by the staged-load allocation test.
#[test]
fn loader_admission_fits_one_share() {
    assert_eq!(MAX_CACHE_BYTES, DEFAULT_CACHE_BYTES);
    let share = DEFAULT_CACHE_BYTES / MAX_SHARE_DIVISOR;
    assert_eq!(CONNECTION_MAX_BYTES, STORED_MAX_BYTES.max(FLOOR_MAX_BYTES));
    for (text, policy) in [(STORED, None), (UNIFORM, None), (FLOOR, Some(FLOOR_POLICY))] {
        let j = job(1, text, policy, 0);
        let l = limits(&j.rule);
        assert!(l.max_bytes <= CONNECTION_MAX_BYTES, "{text}");
        assert!(l.max_bytes * 8 <= share, "{text}");
        assert!(
            l.max_bytes + CONNECTION_MAX_BYTES + CONNECTION_FIXED <= share / 4 + CONNECTION_FIXED
        );
        // Any content of this length fits every stage at its worst.
        let worst = |len: u64| -> Option<u64> {
            let at = SourceLimits {
                max_bytes: len,
                ..l
            };
            let parse = Projection::parse_reservation(len as usize, &at).ok()?;
            let build = Plan::build_allowance(&j.rule, &at)?;
            Some(len + parse.max(build) + key_bound(&j).unwrap())
        };
        let (mut lo, mut hi) = (0u64, l.max_bytes);
        while hi - lo > 1024 {
            let mid = (lo + hi) / 2;
            if worst(mid).is_some_and(|w| w <= share) {
                lo = mid
            } else {
                hi = mid
            }
        }
        println!(
            "{text}: max_bytes {} (read {} with the connection's {}, of share {share}); \
             any content admitted up to {lo} bytes; past it, as its measured stages fit",
            l.max_bytes,
            l.max_bytes,
            CONNECTION_MAX_BYTES + CONNECTION_FIXED
        );
        let c = cache();
        let read = c.admit_read(l.max_bytes, &l).unwrap().expect("admitted");
        assert_eq!(read.bytes(), l.max_bytes);
        let connection = c
            .try_reserve(CONNECTION_MAX_BYTES + CONNECTION_FIXED)
            .unwrap();
        assert!(connection.bytes() <= share);
        assert!(c.admit_read(l.max_bytes + 1, &l).unwrap().is_none());
    }
}

/// The floor goes on to connect; an unreachable server ends
/// `DatabaseUnavailable`, with nothing left reserved.
#[test]
fn floor_is_admitted_and_reads() {
    let mut loader = unreachable();
    let c = cache();
    let before = c.used_for_test();
    let outcome = loader.load(&c, &job(1, FLOOR, Some(FLOOR_POLICY), 0), &mut NoHooks);
    assert_eq!(outcome, Outcome::DatabaseUnavailable);
    assert_eq!(loader.open_target(), None);
    // Only the failure's own entry is left charged, not the read's buffer.
    assert!(c.used_for_test() - before < 64 * 1024);
}

/// A full budget admits nothing: no connection is opened and no statement
/// is sent, and the loader ends `NotAdmitted` after one retry.
#[test]
fn receive_buffer_reserved_before_fetch() {
    let mut loader = unreachable();
    let small = RoutingPlanCache::new(super::cache::MIN_CACHE_BYTES, Some(DIGEST)).unwrap();
    let outcome = loader.load(&small, &job(1, STORED, None, 0), &mut NoHooks);
    assert_eq!(outcome, Outcome::NotAdmitted);
    assert_eq!(loader.open_target(), None);
}

/// The read is reserved but the connection's charge is not: nothing is
/// opened or sent.
#[test]
fn connection_not_reserved_sends_nothing() {
    let mut loader = unreachable();
    let c = cache();
    let l = limits(&RuleConfig::parse(STORED, None).unwrap());
    // Room for the read alone.
    let place = c.try_reserve(l.max_bytes).unwrap();
    let _held = fill(&c);
    drop(place);
    let outcome = loader.load(&c, &job(1, STORED, None, 0), &mut NoHooks);
    assert_eq!(outcome, Outcome::ConnectionNotReserved);
    assert_eq!(loader.open_target(), None);
}

/// A poisoned cache ends the load at once, before anything is read.
#[test]
fn cache_poisoned_reads_nothing() {
    let c = cache();
    let poisoner = c.clone();
    let poisoned = std::thread::spawn(move || {
        let _held = poisoner.hold_lock_for_test();
        panic!("constructed panic while the lock is held");
    })
    .join();
    assert!(poisoned.is_err());
    let mut loader = unreachable();
    let outcome = loader.load(&c, &job(1, STORED, None, 0), &mut NoHooks);
    assert_eq!(outcome, Outcome::CachePoisoned);
    assert_eq!(loader.open_target(), None);
}

/// No outcome can carry a comment id, a participant, text or a vote: it is
/// a field-less enum but for the publication's own closed reason and the
/// refused step.
#[test]
fn outcomes_are_closed() {
    assert!(size_of::<Outcome>() <= 2);
    let _: fn(Rejection) -> Outcome = Outcome::Refused;
    let _: fn(Step) -> Outcome = Outcome::StepRefused;
}

/// Nothing under `routing_plan/` touches a file (the boxes cannot keep
/// state): its source names no file API.
#[test]
fn no_fs_in_routing_plan() {
    for (name, text) in [
        ("mod.rs", include_str!("mod.rs")),
        ("cache.rs", include_str!("cache.rs")),
        ("load.rs", include_str!("load.rs")),
        ("builder.rs", include_str!("builder.rs")),
    ] {
        for word in ["std::fs", "fs::", "File::", "OpenOptions", "tempfile"] {
            assert!(!text.contains(word), "{name} names {word}");
        }
    }
}

/// Growing a reservation is the loader's alone, on its own thread: no file
/// of the crate outside `routing_plan/` grows one or names the plan cache
/// (but `main.rs`'s one module line), whatever routes are added later; the
/// scan reads every source file, not a list. Inside, only `load.rs` grows.
#[test]
fn grow_called_only_by_the_loader() {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out)
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p)
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    walk(&src, &mut files);
    assert!(files.len() > 20);
    for f in files {
        let rel = f
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = std::fs::read_to_string(&f).unwrap();
        if let Some(name) = rel.strip_prefix("routing_plan/") {
            // `cache.rs` defines the wrapper's grow over the core's.
            if !name.ends_with("_tests.rs") && name != "load.rs" && name != "cache.rs" {
                assert!(!text.contains(".grow("), "{rel} grows a reservation");
            }
            continue;
        }
        assert!(!text.contains(".grow("), "{rel} grows a reservation");
        let allowed = usize::from(rel == "main.rs");
        assert_eq!(text.matches("routing_plan").count(), allowed, "{rel}");
    }
}

/// The bounds are the crate's: under a reviewed toolchain each stage's
/// bound is made from the source, and the key's bound covers its text.
#[test]
fn stage_bounds_are_the_crates() {
    assert!(polis_routing_plan::std_bounds_reviewed());
    let j = job(1, STORED, None, 0);
    assert!(key_bound(&j).unwrap() >= (ENV.len() + j.rule_plain.len()) as u64);
}

/// The stages after the read publish, each resize is held before its step,
/// and the reservation ends cut down to the plan's entry.
#[test]
fn stages_publish_on_one_reservation() {
    let tids: Vec<i32> = (1..=300).collect();
    for (text, policy) in [(STORED, None), (UNIFORM, None), (FLOOR, Some(FLOOR_POLICY))] {
        let c = cache();
        let j = job(1, text, policy, 3);
        let mut rec = Record::default();
        assert_eq!(
            staged(&c, &j, projected(&doc(&tids, 3)), &mut rec),
            Outcome::Published,
            "{text}"
        );
        let stages: Vec<Stage> = rec.0.iter().map(|s| s.0).collect();
        assert_eq!(
            stages,
            [
                Stage::Received,
                Stage::Parsing,
                Stage::Parsed,
                Stage::Framing,
                Stage::Framed,
                Stage::Building,
                Stage::Built,
                Stage::BeforePublish
            ]
        );
        println!("{text}: {:?}", rec.0);
    }
}

/// The reservation is cut down to the bytes received before they are
/// measured (from the read's `max_bytes`).
#[test]
fn shrink_to_row_length_after_fetch() {
    let c = cache();
    let j = job(1, STORED, None, 3);
    let bytes = projected(&doc(&[1, 2, 3], 3));
    let held = bytes.capacity() + ENV.len();
    let mut rec = Record::default();
    assert_eq!(staged(&c, &j, bytes, &mut rec), Outcome::Published);
    let (stage, received) = rec.0[0];
    assert_eq!(stage, Stage::Received);
    // The buffer's capacity and the row's environment, nothing more.
    assert_eq!(received, held as u64);
    assert!(received < STORED_MAX_BYTES);
}

/// A grow refused at each step: the step's work never starts, what was
/// held is dropped, the reservation is released, the failure is recorded
/// before any content key (so the next load for that tick backs off and is
/// not read again), and the conversation's last plan stays.
#[test]
fn grow_refused_drops_and_keeps_last_plan() {
    let tids: Vec<i32> = (1..=20_000).collect();
    let j = job(1, FLOOR_FIXED, Some(FLOOR_POLICY), 3);
    let mut rec = Record::default();
    assert_eq!(
        staged(&cache(), &j, projected(&doc(&tids, 3)), &mut rec),
        Outcome::Published
    );
    let at = |s: Stage| rec.0.iter().find(|r| r.0 == s).unwrap().1;
    for (before, step, stage) in [
        (Stage::Received, Step::Parse, Stage::Parsing),
        (Stage::Parsed, Step::Frames, Stage::Framing),
        (Stage::Framed, Step::Build, Stage::Building),
    ] {
        assert!(at(stage) > at(before), "{step:?} is a grow at this shape");
        let c = cache();
        // Another conversation's plan, least recently used, which the one
        // retry evicts; then the conversation's own last plan.
        let small: Vec<i32> = (1..=300).collect();
        assert_eq!(
            staged(
                &c,
                &job(2, FLOOR_FIXED, Some(FLOOR_POLICY), 2),
                projected(&doc(&small, 2)),
                &mut NoHooks
            ),
            Outcome::Published
        );
        assert_eq!(
            staged(
                &c,
                &job(1, FLOOR_FIXED, Some(FLOOR_POLICY), 2),
                projected(&doc(&small, 2)),
                &mut NoHooks
            ),
            Outcome::Published
        );
        struct FillAt<'a>(
            Stage,
            &'a std::sync::Arc<RoutingPlanCache>,
            Vec<super::cache::Reserved>,
            Vec<Stage>,
        );
        impl Hooks for FillAt<'_> {
            fn reserved(&mut self, stage: Stage, _: u64) {
                self.3.push(stage);
                if stage == self.0 {
                    self.2 = fill(self.1);
                }
            }
        }
        let mut hook = FillAt(before, &c, vec![], vec![]);
        let outcome = staged(&c, &j, projected(&doc(&tids, 3)), &mut hook);
        assert_eq!(outcome, Outcome::StepRefused(step));
        assert!(!hook.3.contains(&stage), "{step:?} started");
        // Released: with the budget otherwise full, the room left is what
        // the build held, less the failure's own entry.
        let (used, limit) = c.budget().unwrap();
        assert!(
            limit - used + 64 * 1024 >= at(before),
            "{step:?}: reservation not released"
        );
        assert_eq!(
            c.retry_allowed(&polis_routing_plan::Failure::BeforeRead(
                polis_routing_plan::WantedKey {
                    zid: 1,
                    math_env: ENV.into(),
                    desired_tick: 3,
                }
            )),
            Ok(false),
            "{step:?}: no backoff"
        );
        drop(hook);
        // The last plan is still there.
        assert_eq!(c.evict_lru().unwrap(), Some(true), "{step:?}");
        assert_eq!(c.evict_lru().unwrap(), None);
    }
}

/// The one retry after a refused grow uses the room its eviction made: with
/// the budget otherwise full, another conversation's plan is evicted and
/// destroyed before the grow is tried again, so the build goes on and
/// publishes (an evicted plan's bytes stay charged until it is destroyed;
/// a retry before that would lose the other plan for nothing).
#[test]
fn retry_uses_the_room_its_eviction_made() {
    let c = cache();
    let big: Vec<i32> = (1..=20_000).collect();
    assert_eq!(
        staged(
            &c,
            &job(2, FLOOR_FIXED, Some(FLOOR_POLICY), 3),
            projected(&doc(&big, 3)),
            &mut NoHooks
        ),
        Outcome::Published
    );
    struct FillAt<'a>(
        &'a std::sync::Arc<RoutingPlanCache>,
        Vec<super::cache::Reserved>,
    );
    impl Hooks for FillAt<'_> {
        fn reserved(&mut self, stage: Stage, _: u64) {
            if stage == Stage::Received {
                self.1 = fill(self.0);
            }
        }
    }
    let small: Vec<i32> = (1..=300).collect();
    let mut hook = FillAt(&c, vec![]);
    let outcome = staged(
        &c,
        &job(1, FLOOR_FIXED, Some(FLOOR_POLICY), 2),
        projected(&doc(&small, 2)),
        &mut hook,
    );
    assert_eq!(outcome, Outcome::Published);
}

/// A key that does not match its plan ends `KeyMismatch`, nothing
/// published.
#[test]
fn key_mismatch_publishes_nothing() {
    let c = cache();
    let mut j = job(1, FLOOR, Some(FLOOR_POLICY), 3);
    j.policy = None;
    let outcome = staged(&c, &j, projected(&doc(&[1, 2, 3], 3)), &mut NoHooks);
    assert_eq!(outcome, Outcome::KeyMismatch);
    assert_eq!(c.evict_lru().unwrap(), None);
}

/// A reservation smaller than the plan's entry ends `Undercharged`.
#[test]
fn undercharged_cut_down_is_refused() {
    let c = cache();
    let j = job(1, UNIFORM, None, 3);
    let p = Projection::parse(&projected(&doc(&[1, 2], 3)), row(1, 3), &LIMITS).unwrap();
    let frames = p.frames(j.rule.needs()).unwrap();
    let plan = Plan::build(&frames, &j.rule).unwrap();
    let key = polis_routing_plan::BundleKey::of(&p, &j.rule, None, DIGEST);
    let cached = polis_routing_plan::CachedPlan::new(key, plan, c.reading()).unwrap();
    let mut r = c.try_reserve(16).unwrap();
    assert_eq!(
        cut_down(&mut r, &cached, ENV.len() as u64),
        Err(Outcome::Undercharged)
    );
    assert_eq!(r.bytes(), 16);
}

#[cfg(feature = "db-tests")]
mod db {
    use super::*;
    use polis_queue_adapter::jobs::transport::Connector;
    use polis_routing_plan::{BuildRefusal, BundleKey, CachedPlan};
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
                     math_tick bigint NOT NULL, modified bigint, UNIQUE (zid, math_env)",
                ),
                Shape::Older => (
                    "json",
                    "zid integer NOT NULL, math_env varchar(999) NOT NULL, data json NOT NULL, \
                     last_vote_timestamp bigint NOT NULL, modified bigint, \
                     math_tick bigint NOT NULL, caching_tick bigint NOT NULL DEFAULT 0, \
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
            assert_eq!(
                loader.load(&c, &j, &mut NoHooks),
                Outcome::NoRow,
                "{shape:?}"
            );
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

            // Past the 8 MiB bound: about 11 MB of ids.
            let tids: Vec<i32> = (0..1_500_000).collect();
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
                .query_one(
                    "select (data -> 'tids')::text from math_main where zid = 6",
                    &[],
                )
                .unwrap()
                .get(0);
            assert_ne!(
                format!("[{tick}]"),
                tids.replace(' ', ""),
                "the witness mixes"
            );

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
            assert_eq!(
                outcome,
                Outcome::Refused(Rejection::Superseded),
                "{shape:?}"
            );
        }
    }

    /// Unfenced, the primary is read even when a replica is configured;
    /// fenced, the replica is read; a fence forgotten right after that read,
    /// before every grow of the build's reservation, refuses the
    /// publication (`FenceForgotten`): the reservation is grown and cut
    /// down in place, so it keeps the moment it was taken.
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
                    if stage == Stage::AfterRead {
                        c.set_config(None).unwrap();
                        c.set_config(Some(DIGEST)).unwrap();
                        assert!(!c.fenced(9, ENV).unwrap());
                    }
                }),
            );
            assert_eq!(loader.open_target(), Some(Target::Replica), "{shape:?}");
            assert_eq!(
                outcome,
                Outcome::Refused(Rejection::FenceForgotten),
                "{shape:?}"
            );
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
            r.publish(super::super::cache::PlanRef::new(cached))
                .unwrap();
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
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let (handle, outcome) = rt.block_on(async move {
            let (jobs, rx) = mpsc::sync_channel(1);
            let (tx, outcomes) = mpsc::sync_channel(1);
            let handle = spawn(Loader::new(connector, None), cache(), rx, tx).unwrap();
            jobs.send(job(11, STORED, None, 1)).unwrap();
            drop(jobs);
            (handle, outcomes.recv().unwrap())
        });
        assert_eq!(outcome, Outcome::Published);
        assert_eq!(
            handle.thread().name(),
            Some("polis-api-routing-plan-loader")
        );
        handle.join().unwrap();
    }

    /// The loader review's witness, kept: the loader alone reads a stored
    /// result it refused again for the same tick (its refusal is keyed by
    /// content, known only after the read). Through the scheduler, a second
    /// request for that tick sends no statement until the backoff passes;
    /// a newer tick is new content and is read at once.
    #[test]
    fn refused_source_not_read_again_through_the_scheduler() {
        use super::super::builder::{BuildConfig, BuildRequest, BuildResult, Next, Schedule};
        use polis_routing_plan::Monotonic;
        for shape in SHAPES {
            let db = Db::new(shape);
            db.put(12, 4, &json!({"comment-priorities": "not a map"}));
            let c = cache();
            let mut loader = Loader::new(db.connector(), None);
            let rule = RuleConfig::parse(STORED, None).unwrap();
            let config = Arc::new(BuildConfig {
                digest: DIGEST,
                rule,
                rule_plain: rule.to_plain(),
                policy: None,
            });
            let request = |tick| BuildRequest {
                zid: 12,
                env: Arc::from(ENV),
                desired_tick: Some(tick),
                config: config.clone(),
            };
            let now = Monotonic::from_nanos(0);
            let mut s = Schedule::new(10);
            let mut reads = 0;
            let mut counted = |stage: Stage, _: Option<i32>| {
                if stage == Stage::BeforeRead {
                    reads += 1;
                }
            };
            s.offer(request(4));
            let Next::Build(t) = s.next(now) else {
                panic!("the first request is built")
            };
            let first = loader.load(&c, &t.job, &mut At(&mut counted));
            assert_eq!(first, Outcome::SourceRefused, "{shape:?}");
            s.finish(&t, BuildResult::Loaded(first), now, now, 0);
            // The loader alone sends the statement again for tick 4.
            let again = loader.load(&c, &t.job, &mut At(&mut counted));
            assert_eq!(again, Outcome::SourceRefused, "{shape:?}");
            // The scheduler does not.
            s.offer(request(4));
            assert!(
                matches!(s.next(now), Next::Wait(Some(_))),
                "tick 4 is held: {shape:?}"
            );
            // Tick 5 is built at once (and refused again: same document).
            db.put(12, 5, &json!({"comment-priorities": "not a map"}));
            s.offer(request(5));
            let Next::Build(t) = s.next(now) else {
                panic!("tick 5 is built: {shape:?}")
            };
            assert_eq!(t.job.desired_tick, 5);
            let newer = loader.load(&c, &t.job, &mut At(&mut counted));
            assert_eq!(newer, Outcome::SourceRefused, "{shape:?}");
            assert_eq!(reads, 3, "{shape:?}");
        }
    }
}
