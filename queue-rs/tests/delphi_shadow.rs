//! `polis-delphi-shadow` against a throwaway PostgreSQL 17 holding the
//! release migration chain: what it admits, under which env, one at a time,
//! and that its two sessions never make the participation path wait.
//! Run with `--features jobs-integration` and `POLIS_JOBS_TEST_DATABASE_URL`
//! (a superuser DSN on a loopback port), as `tests/jobs_integration.rs`.
#![cfg(feature = "jobs-integration")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use polis_queue_adapter::jobs::inputs::contract;
use polis_queue_adapter::shadow::{
    config, db, plan,
    scheduler::{self, Scheduler},
    state,
};
use postgres::{Client, NoTls};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const ENV: &str = "shadow-delphi-1";
const CODE: &str = "0123456789abcdef0123456789abcdef01234567";
/// A moderator's rejection (comments.mod), as the next-comment read filters it.
const REJECTED_COMMENT_MOD: i32 = -1;

fn admin_url() -> String {
    std::env::var("POLIS_JOBS_TEST_DATABASE_URL")
        .expect("POLIS_JOBS_TEST_DATABASE_URL is required with --features jobs-integration")
}

fn url_for(db: &str, user: &str) -> String {
    let base = admin_url();
    let rest = base.split_once('@').map(|x| x.1).unwrap();
    let host = rest.split('/').next().unwrap();
    format!("postgresql://{user}@{host}/{db}")
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

struct Fixture {
    name: String,
    login: String,
    dir: PathBuf,
}

impl Fixture {
    /// A fresh database with the release chain and a queue login.
    fn new() -> Self {
        let id = Uuid::new_v4().simple().to_string();
        let name = format!("shadow_{}", &id[..16]);
        let login = format!("shadow_exec_{}", &id[..12]);
        let mut admin = Client::connect(&admin_url(), NoTls).unwrap();
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        let dsn = url_for(&name, "postgres");
        let release = polis_migrate::load(&root().join("../server/postgres/migrations")).unwrap();
        let mut runner = polis_migrate::connect(&format!("{dsn}?sslmode=disable")).unwrap();
        polis_migrate::apply(&mut runner, &release).unwrap();
        drop(runner);
        let mut c = Client::connect(&dsn, NoTls).unwrap();
        c.batch_execute(&format!(
            "CREATE ROLE {login} LOGIN; GRANT polis_queue_executor TO {login}"
        ))
        .unwrap();
        let dir = std::env::temp_dir().join(format!("delphi-shadow-test-{id}"));
        std::fs::create_dir_all(&dir).unwrap();
        Self { name, login, dir }
    }

    fn superuser(&self) -> Client {
        Client::connect(&url_for(&self.name, "postgres"), NoTls).unwrap()
    }

    fn config(&self, extra: &[(&str, &str)]) -> config::Config {
        let m = self.environment(extra);
        match config::load(|k| m.get(k).cloned()).unwrap() {
            config::Load::Ready(c) => *c,
            config::Load::Disabled => panic!("disabled"),
        }
    }

    /// The scheduler's environment, as `config` loads it (and as the
    /// scheduler's own process is started with).
    fn environment(&self, extra: &[(&str, &str)]) -> HashMap<String, String> {
        let mut m: HashMap<String, String> = [
            ("DELPHI_SHADOW_ENABLED", "1".to_owned()),
            ("QUEUE_DATABASE_URL", url_for(&self.name, &self.login)),
            (
                "DELPHI_SHADOW_READ_DATABASE_URL",
                url_for(&self.name, "postgres"),
            ),
            ("POLIS_JOBS_TRANSPORT", "loopback".to_owned()),
            ("DELPHI_SHADOW_CODE_VERSION", CODE.to_owned()),
            (
                "DELPHI_SHADOW_STATE_PATH",
                self.dir.join("state.json").display().to_string(),
            ),
            (
                "DELPHI_SHADOW_PAUSE_FILE",
                self.dir.join("pause").display().to_string(),
            ),
            ("DELPHI_SHADOW_DISK_PATH", self.dir.display().to_string()),
            ("DELPHI_SHADOW_DISK_FREE_MIN_MB", "0".to_owned()),
            ("DELPHI_SHADOW_DISK_USED_MAX_PCT", "100".to_owned()),
            ("DELPHI_SHADOW_DUTY_CYCLE", "1".to_owned()),
            ("DELPHI_SHADOW_PROBE_MAX_MS", "5000".to_owned()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        for (k, v) in extra {
            m.insert((*k).to_owned(), (*v).to_owned());
        }
        m
    }

    /// A conversation with `n` comments, its code (`c<zid>`), its math row
    /// and one vote (a pass, 0: the same value in every sign convention, as
    /// jobs_integration.rs seeds its vote) so the math engine reads as caught
    /// up.
    fn conversation(&self, zid: i32, n: usize) {
        let mut c = self.superuser();
        let owner = zid * 1000;
        c.execute(
            "INSERT INTO users(uid,hname) VALUES($1,'generated owner')",
            &[&owner],
        )
        .unwrap();
        c.execute(
            "INSERT INTO conversations(zid,owner,topic,is_active) VALUES($1,$2,'generated',true)",
            &[&zid, &owner],
        )
        .unwrap();
        c.execute(
            "INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)",
            &[&zid, &format!("c{zid}")],
        )
        .unwrap();
        let pid: i32 = c
            .query_one(
                "INSERT INTO participants(zid,uid) VALUES($1,$2) RETURNING pid",
                &[&zid, &owner],
            )
            .unwrap()
            .get(0);
        for i in 0..n {
            c.execute(
                "INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES($1,$2,$3,$4,0,true)",
                &[
                    &zid,
                    &pid,
                    &owner,
                    &format!("generated comment {i} of conversation {zid}"),
                ],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO votes(zid,pid,tid,vote,created) VALUES($1,$2,0,0,now_as_millis()-1000)",
            &[&zid, &pid],
        )
        .unwrap();
        c.execute(
            "INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,modified) \
             VALUES($1,'python','{}'::jsonb,0,now_as_millis())",
            &[&zid],
        )
        .unwrap();
    }

    /// A conversation with no comment created or moderated for a long time
    /// (outside every live window) and `participants` participants.
    fn quiet(&self, zid: i32, n: usize, participants: i32) {
        self.conversation(zid, n);
        let mut c = self.superuser();
        c.execute(
            "UPDATE comments SET modified = 1000 WHERE zid = $1",
            &[&zid],
        )
        .unwrap();
        c.execute(
            "UPDATE conversations SET participant_count = $2 WHERE zid = $1",
            &[&zid, &participants],
        )
        .unwrap();
    }

    /// The owner's "anyone can export a data dump" setting on: the
    /// conversation is open data, of the featured set.
    fn open_data(&self, zid: i32) {
        self.superuser()
            .execute(
                "UPDATE conversations SET is_data_open = true WHERE zid = $1",
                &[&zid],
            )
            .unwrap();
    }

    /// The named set each job's run record says it was selected from, by
    /// conversation id, in admission order.
    fn sets(&self) -> Vec<(i32, Value)> {
        self.jobs()
            .into_iter()
            .filter(|(env, ..)| env == ENV)
            .map(|(_, zid, _, config)| (zid, config["shadow"]["set"].clone()))
            .collect()
    }

    fn jobs(&self) -> Vec<(String, i32, String, Value)> {
        self.superuser()
            .query(
                "SELECT env,zid,job_id::text,config_effective FROM delphi_jobs ORDER BY created_at",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
            .collect()
    }

    fn cancel(&self, job: &str) {
        let mut c = self.superuser();
        let status: Value = c
            .query_one("SELECT pq_job_status($1,$2::text::uuid)", &[&ENV, &job])
            .unwrap()
            .get(0);
        let version: i64 = status["mgmt_version"].as_str().unwrap().parse().unwrap();
        c.query_one(
            "SELECT pq_cancel($1,$2::text::uuid,$3)",
            &[&ENV, &job, &version],
        )
        .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Ok(mut admin) = Client::connect(&admin_url(), NoTls) {
            let _ = admin.batch_execute(&format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE); DROP ROLE IF EXISTS {}",
                self.name, self.login
            ));
        }
    }
}

#[test]
fn changed_sets_are_admitted_one_at_a_time_under_the_shadow_env_only() {
    let f = Fixture::new();
    f.conversation(101, 3); // below the 20-comment floor
    f.conversation(102, 25);
    f.conversation(103, 40);
    let cfg = f.config(&[("DELPHI_SHADOW_RERUN_AFTER_SECONDS", "0")]);
    let mut s = Scheduler::new(&cfg).unwrap();

    // The smallest conversation inside the bounds goes first.
    s.cycle().unwrap();
    let jobs = f.jobs();
    assert_eq!(jobs.len(), 1);
    let (env, zid, job, config) = &jobs[0];
    assert_eq!((env.as_str(), *zid), (ENV, 102));
    let digest = db::read_only(&mut f.superuser(), 30_000, |tx| db::comment_set(tx, 102)).unwrap();
    assert_eq!(
        config["shadow"]["comment_set_sha256"],
        digest.digest.as_str()
    );
    assert_eq!(config["shadow"]["comments"], 25);
    assert_eq!(config["shadow"]["twin_of"], Value::Null);
    assert_eq!(config["shadow"]["set"], "current", "live: the current set");
    assert_eq!(config["result_backend"], "postgres");
    assert_eq!(s.state.in_flight.as_ref().unwrap().job_id, *job);

    // While it is not terminal, nothing else is admitted.
    for _ in 0..3 {
        s.cycle().unwrap();
    }
    assert_eq!(f.jobs().len(), 1);

    // Terminal: the next set goes.
    f.cancel(job);
    s.cycle().unwrap();
    assert!(s.state.in_flight.is_none());
    s.cycle().unwrap();
    let jobs = f.jobs();
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[1].1, 103);
    f.cancel(&jobs[1].2);
    s.cycle().unwrap();

    // Nothing changed: nothing more is admitted.
    for _ in 0..3 {
        s.cycle().unwrap();
    }
    assert_eq!(f.jobs().len(), 2);

    // A new comment changes 102's set: it is admitted again, keyed by the new set.
    f.superuser()
        .execute(
            "INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES(102,0,102000,'one more generated comment',0,true)",
            &[],
        )
        .unwrap();
    s.cycle().unwrap();
    let jobs = f.jobs();
    assert_eq!(jobs.len(), 3);
    assert_eq!(jobs[2].1, 102);
    assert_ne!(
        jobs[2].3["shadow"]["comment_set_sha256"],
        jobs[0].3["shadow"]["comment_set_sha256"]
    );
    assert_eq!(jobs[2].3["shadow"]["comments"], 26);

    // A moderation that leaves the text alone still changes the set.
    f.cancel(&jobs[2].2);
    s.cycle().unwrap();
    f.superuser()
        .execute(
            "UPDATE comments SET mod=-1, modified=now_as_millis() WHERE zid=103 AND tid=0",
            &[],
        )
        .unwrap();
    s.cycle().unwrap();
    assert_eq!(f.jobs().len(), 4);

    // Only the shadow env holds anything, in every queue and result table.
    let mut c = f.superuser();
    for table in [
        "delphi_jobs",
        "polis_queue_jobs",
        "polis_queue_runs",
        "delphi_graphs",
        "delphi_result_batches",
        "delphi_graph_served",
        "delphi_comment_embeddings",
    ] {
        let envs: Vec<String> = c
            .query(&format!("SELECT DISTINCT env FROM {table}"), &[])
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert!(envs.iter().all(|e| e == ENV), "{table}: {envs:?}");
    }
    // The state file survives a restart and admits nothing twice.
    s.state.save(&cfg.state_path).unwrap();
    let mut again = Scheduler::new(&cfg).unwrap();
    again.cycle().unwrap();
    assert_eq!(f.jobs().len(), 4);
}

/// What participants are shown, by a query written here from the comment list
/// participants are served (server/src/comment.ts, participantVisibleClause),
/// not by the code under test: the expected tids and the selection's digest of
/// them (`polis-jobs.selection/1`: the header, the name, `tid\tsha256(txt)`).
fn shown(c: &mut Client, zid: i32) -> (Vec<i64>, String) {
    let rows = c
        .query(
            "SELECT c.tid::bigint, c.txt FROM comments c JOIN conversations v USING (zid) \
             WHERE c.zid = $1 AND c.active AND c.velocity > 0 \
             AND CASE WHEN coalesce(v.strict_moderation, false) THEN c.mod = 1 ELSE c.mod <> -1 END \
             ORDER BY c.tid",
            &[&zid],
        )
        .unwrap();
    let mut text = String::from("polis-jobs.selection/1\nparticipant_visible/1\n");
    let mut tids = Vec::new();
    for r in &rows {
        let (tid, txt): (i64, String) = (r.get(0), r.get(1));
        text.push_str(&format!(
            "{tid}\t{}\n",
            contract::sha256_hex(txt.as_bytes())
        ));
        tids.push(tid);
    }
    (tids, contract::sha256_hex(text.as_bytes()))
}

/// The selection is part of each run's identity. A run embeds every comment
/// and lays out, clusters and names what participants are shown; its
/// admission names the selection with both census digests and their counts;
/// a moderation that changes what participants are shown is a new run, and
/// one that does not (an unmoderated comment accepted outside strict
/// moderation, a rejected comment added) is not. A state entry an earlier
/// build wrote (its runs laid out every comment) is run once more, then not
/// again.
#[test]
fn the_selection_keys_each_run_and_follows_moderation() {
    let f = Fixture::new();
    f.conversation(301, 30);
    f.conversation(302, 30);
    let mut c = f.superuser();
    // 301, open: rejected, inactive, muted, accepted; the rest unmoderated.
    // 302, strict: 22 accepted; rejected, inactive, muted among the rest.
    c.batch_execute(&format!(
        "UPDATE comments SET mod = {REJECTED_COMMENT_MOD} WHERE zid = 301 AND tid = 0;
         UPDATE comments SET active = false WHERE zid = 301 AND tid = 1;
         UPDATE comments SET velocity = 0 WHERE zid = 301 AND tid = 2;
         UPDATE comments SET mod = 1 WHERE zid = 301 AND tid = 3;
         UPDATE conversations SET strict_moderation = true WHERE zid = 302;
         UPDATE comments SET mod = 1 WHERE zid = 302 AND tid < 25;
         UPDATE comments SET mod = {REJECTED_COMMENT_MOD} WHERE zid = 302 AND tid = 22;
         UPDATE comments SET active = false WHERE zid = 302 AND tid = 23;
         UPDATE comments SET velocity = 0 WHERE zid = 302 AND tid = 24;"
    ))
    .unwrap();
    let cfg = f.config(&[("DELPHI_SHADOW_RERUN_AFTER_SECONDS", "0")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(301));
    assert_eq!(next_admitted(&f, &mut s), Some(302));
    for (job, zid, selected) in [(0, 301, 27), (1, 302, 22)] {
        let config = &f.jobs()[job].3;
        let census = db::read_only(&mut c, 30_000, |tx| db::comment_set(tx, zid)).unwrap();
        let (tids, digest) = shown(&mut c, zid);
        assert_eq!(tids.len(), selected, "{zid}: {tids:?}");
        assert_eq!(config["selection"], "participant_visible/1");
        assert_eq!(config["exclude_comment_selections"], false);
        assert!(config.get("include_moderation").is_none());
        let shadow = &config["shadow"];
        assert_eq!(shadow["schema"], "delphi-shadow/2");
        // The embedded set: every comment, the run's census digest.
        assert_eq!(shadow["comment_set_sha256"], census.digest.as_str());
        assert_eq!(shadow["comments"], 30);
        // The selection: what participants are shown.
        assert_eq!(shadow["selection"], "participant_visible/1");
        assert_eq!(shadow["selection_sha256"], digest.as_str());
        assert_eq!(shadow["selected"], selected as i64);
    }
    assert_eq!(next_admitted(&f, &mut s), None, "nothing changed");

    // The same comments shown: no run. 301 accepts an unmoderated comment
    // (shown before, shown now), and a rejected comment arrives.
    let before = s.state.totals.unchanged;
    c.batch_execute(&format!(
        "UPDATE comments SET mod = 1, modified = now_as_millis() WHERE zid = 301 AND tid = 4;
         INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES(301,0,301000,'a generated rejected comment',{REJECTED_COMMENT_MOD},true);"
    ))
    .unwrap();
    assert_eq!(next_admitted(&f, &mut s), None);
    assert!(
        s.state.totals.unchanged > before,
        "read, and found unchanged"
    );
    assert_eq!(f.jobs().len(), 2);

    // What participants are shown changes: a new run, keyed by the new
    // selection, which is what participants are shown at its admission.
    let admitted = |s: &mut Scheduler<'_>, c: &mut Client, zid: i32, why: &str| {
        assert_eq!(next_admitted(&f, s), Some(zid), "{why}");
        let (tids, digest) = shown(c, zid);
        let jobs = f.jobs();
        let (_, job_zid, _, config) = jobs.last().unwrap();
        assert_eq!(*job_zid, zid);
        assert_eq!(
            config["shadow"]["selection_sha256"],
            digest.as_str(),
            "{why}"
        );
        assert_eq!(config["shadow"]["selected"], tids.len() as i64, "{why}");
        config["shadow"]["selection_sha256"].clone()
    };
    c.batch_execute(
        "UPDATE comments SET mod = 1, modified = now_as_millis() WHERE zid = 302 AND tid = 25",
    )
    .unwrap();
    let strict_more = admitted(&mut s, &mut c, 302, "strict: one more accepted");
    assert_ne!(strict_more, f.jobs()[1].3["shadow"]["selection_sha256"]);
    c.batch_execute(&format!(
        "UPDATE comments SET mod = {REJECTED_COMMENT_MOD}, modified = now_as_millis() WHERE zid = 301 AND tid = 3"
    ))
    .unwrap();
    admitted(&mut s, &mut c, 301, "an accepted comment rejected");
    // Strict moderation turned off, seen at the next comment change.
    c.batch_execute(
        "UPDATE conversations SET strict_moderation = false WHERE zid = 302;
         UPDATE comments SET modified = now_as_millis() WHERE zid = 302 AND tid = 0",
    )
    .unwrap();
    admitted(&mut s, &mut c, 302, "strict off: the unmoderated shown");
    assert_eq!(f.jobs().len(), 5);
    assert_eq!(f.jobs()[4].3["shadow"]["selected"], 27);
    assert_eq!(next_admitted(&f, &mut s), None);

    // A conversation an earlier build ran: its admission named no selection
    // (every comment laid out, keyed by every comment's digest) and its state
    // entry names none. Every comment of it is shown, and still it is run once
    // more, because its stored run cannot be told from a run of every comment
    // by anything but its record; then not again.
    f.conversation(303, 30);
    let census = db::read_only(&mut c, 30_000, |tx| db::comment_set(tx, 303)).unwrap();
    assert_eq!(census.selected, census.comments, "nothing hidden");
    let earlier = serde_json::json!({"include_moderation": false, "exclude_comment_selections": true,
        "embeddings_table": true, "shadow": {"schema": "delphi-shadow/1",
        "comment_set_sha256": census.digest, "comments": 30, "size_class": "b 20-99",
        "set": "current", "twin_of": null, "scheduler": "polis-delphi-shadow (an earlier build)"}});
    let job = Uuid::new_v4().to_string();
    let reply: Value = Client::connect(&cfg.queue_dsn, NoTls)
        .unwrap()
        .query_one(
            "SELECT pd_writer_admit($1,303,$2,$3,$4,repeat('a',64),$5::text::uuid,gen_random_uuid(),\
             'delphi_full_pipeline',NULL,$6::text::jsonb,$7)",
            &[&ENV, &config::SCOPE, &config::ACTOR,
              &format!("shadow:first:303:{}", &census.digest[..48]), &job, &earlier.to_string(), &CODE],
        )
        .unwrap()
        .get(0);
    assert_eq!(reply["outcome"], "enqueued");
    f.cancel(&job);
    let last_modified: i64 = c
        .query_one("SELECT max(modified) FROM comments WHERE zid = 303", &[])
        .unwrap()
        .get(0);
    s.state.conversations.insert(
        303,
        state::Seen {
            last_modified,
            digest: census.digest.clone(),
            comments: 30,
            admitted_digest: Some(census.digest.clone()),
            admitted_at_ms: Some(scheduler::now_ms() - 2 * 86_400_000),
            job_id: Some(job.clone()),
            outcome: Some("cancelled".into()),
            ..state::Seen::default()
        },
    );
    s.state.save(&cfg.state_path).unwrap();
    let mut again = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut again), Some(303));
    let jobs = f.jobs();
    assert_eq!(jobs.len(), 7);
    // Told apart by their records: the earlier run names no selection.
    let old = jobs.iter().find(|j| j.2 == job).unwrap();
    assert!(old.3.get("selection").is_none());
    assert_eq!(old.3["shadow"]["schema"], "delphi-shadow/1");
    let new = &jobs[6].3;
    assert_eq!(
        (jobs[6].1, &new["selection"]),
        (303, &Value::from("participant_visible/1"))
    );
    assert_eq!(
        new["shadow"]["comment_set_sha256"],
        old.3["shadow"]["comment_set_sha256"]
    );
    assert_eq!(new["shadow"]["selected"], 30);
    for _ in 0..3 {
        assert_eq!(next_admitted(&f, &mut again), None);
    }
    assert_eq!(f.jobs().len(), 7, "nothing else runs again");
}

/// A conversation with enough comments in all but too few shown is below the
/// floor, and is not read again until a comment changes.
#[test]
fn the_floor_counts_what_participants_are_shown() {
    let f = Fixture::new();
    f.conversation(311, 25);
    let mut c = f.superuser();
    c.batch_execute(&format!(
        "UPDATE comments SET mod = {REJECTED_COMMENT_MOD} WHERE zid = 311 AND tid < 10"
    ))
    .unwrap();
    let cfg = f.config(&[("DELPHI_SHADOW_RERUN_AFTER_SECONDS", "0")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(
        next_admitted(&f, &mut s),
        None,
        "15 shown: below the floor of 20"
    );
    let seen = s.state.conversations.get(&311).unwrap();
    assert_eq!((seen.comments, seen.selected), (25, 15));
    assert_eq!(seen.selection.as_deref(), Some("participant_visible/1"));
    assert_eq!(f.jobs().len(), 0);
    c.batch_execute(
        "UPDATE comments SET mod = 0, modified = now_as_millis() WHERE zid = 311 AND tid < 6",
    )
    .unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(311), "21 shown");
    assert_eq!(f.jobs()[0].3["shadow"]["selected"], 21);
}

/// Admit, record and cancel the next run; the zid admitted (None: nothing).
fn next_admitted(f: &Fixture, s: &mut Scheduler<'_>) -> Option<i32> {
    s.cycle().unwrap();
    let flight = s.state.in_flight.clone()?;
    f.cancel(&flight.job_id);
    s.cycle().unwrap();
    assert!(s.state.in_flight.is_none());
    Some(flight.zid)
}

#[test]
fn the_benchmark_set_then_the_featured_set_then_the_current_set_whatever_their_activity() {
    use polis_queue_adapter::shadow::plan::Set;
    let f = Fixture::new();
    f.conversation(301, 30); // current (live), one participant
    f.quiet(302, 25, 3); // benchmark, listed second
    f.quiet(303, 40, 3); // benchmark, listed first, and open data
    f.open_data(303);
    f.quiet(304, 35, 500); // featured (open data)
    f.open_data(304);
    f.quiet(305, 50, 250); // featured, fewer participants
    f.open_data(305);
    f.quiet(306, 22, 900); // many participants, not open data: never run
    f.quiet(307, 3, 900); // featured but below the comment floor
    f.open_data(307);
    let cfg = f.config(&[
        ("DELPHI_SHADOW_BENCHMARK", "c303,c999unknown,c302,c303"),
        ("DELPHI_SHADOW_RERUN_AFTER_SECONDS", "0"),
    ]);
    let mut s = Scheduler::new(&cfg).unwrap();
    let mut order = Vec::new();
    while let Some(zid) = next_admitted(&f, &mut s) {
        order.push(zid);
        assert!(order.len() <= 10, "{order:?}");
    }
    assert_eq!(order, [303, 302, 304, 305, 301]);
    assert_eq!(f.jobs().len(), 5);
    assert!(f.jobs().iter().all(|(env, ..)| env == ENV));
    // Each run record names its set: 303, open data too, is a benchmark.
    assert_eq!(
        f.sets(),
        [
            (303, "benchmark".into()),
            (302, "benchmark".into()),
            (304, "featured".into()),
            (305, "featured".into()),
            (301, "current".into()),
        ]
    );
    let t = &s.state.totals;
    assert_eq!(
        (
            t.benchmark_admitted,
            t.featured_admitted,
            t.current_admitted
        ),
        (2, 2, 1)
    );
    // Read once: the codes that exist in the list's order, the open-data
    // conversations most participants first (307 is listed, and too small to
    // run; 303 is listed, and runs as a benchmark).
    let roster = s.roster.clone().unwrap();
    let zids = |l: &[db::Live]| l.iter().map(|x| x.zid).collect::<Vec<_>>();
    assert_eq!(zids(&roster.benchmark), [303, 302]);
    assert_eq!(zids(&roster.featured), [307, 304, 305, 303]);

    // A benchmark conversation that changes after the roster was read is
    // seen at the next poll (through the live read) and goes first again.
    f.superuser()
        .execute(
            "INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES(302,0,302000,'one more generated comment',0,true)",
            &[],
        )
        .unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(302));
    assert_eq!(f.sets().last().unwrap().1, "benchmark");
    assert_eq!(next_admitted(&f, &mut s), None);

    // The open-data read is made once a UTC day: a conversation whose owner
    // opens its data now waits for the next day's read.
    f.open_data(306);
    assert_eq!(next_admitted(&f, &mut s), None);
    if let Some(r) = s.roster.as_mut() {
        r.day -= 1;
    }
    assert_eq!(next_admitted(&f, &mut s), Some(306));
    assert_eq!(f.sets().last().unwrap().1, "featured");
    assert_eq!(
        zids(&s.roster.as_ref().unwrap().featured),
        [306, 307, 304, 305, 303]
    );
    assert_eq!(s.state.totals.featured_admitted, 3);
    // Terminal and still to be measured: its bytes will be logged under its
    // set.
    assert_eq!(
        s.state
            .storage
            .pending
            .iter()
            .map(|p| p.set)
            .collect::<Vec<_>>(),
        [Some(Set::Featured)]
    );
}

#[test]
fn every_pause_reason_holds_admission() {
    let f = Fixture::new();
    f.conversation(301, 30);
    // The operator's pause file.
    let cfg = f.config(&[]);
    std::fs::write(&cfg.pause_file, b"").unwrap();
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    assert_eq!(s.paused, Some(plan::Pause::Operator));
    assert!(f.jobs().is_empty());
    std::fs::remove_file(&cfg.pause_file).unwrap();
    // A disk floor no filesystem meets.
    let cfg = f.config(&[("DELPHI_SHADOW_DISK_FREE_MIN_MB", "1099511627776")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    assert_eq!(s.paused, Some(plan::Pause::Disk));
    // The math engine trails the newest vote.
    f.superuser()
        .execute(
            "UPDATE math_main SET modified = now_as_millis() - 3600000",
            &[],
        )
        .unwrap();
    f.superuser()
        .execute("UPDATE votes SET created = now_as_millis()", &[])
        .unwrap();
    let cfg = f.config(&[]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    assert_eq!(s.paused, Some(plan::Pause::MathLag));
    assert!(f.jobs().is_empty());
    // Caught up again: it resumes and admits.
    f.superuser()
        .execute("UPDATE math_main SET modified = now_as_millis()", &[])
        .unwrap();
    s.cycle().unwrap();
    assert_eq!(s.paused, None);
    assert_eq!(f.jobs().len(), 1);
}

/// The participation path's statements, each under a 50 ms lock timeout, on
/// their own session: a comment, the conversation update votes and comments
/// cause, a vote (a pass), the next comment's candidate read and the
/// notification state. Returns the slowest.
fn participation(c: &mut Client, zid: i32, i: usize) -> Duration {
    c.batch_execute("SET lock_timeout = '50ms'").unwrap();
    let mut slowest = Duration::ZERO;
    let mut time = |c: &mut Client, sql: &str| {
        let start = Instant::now();
        c.batch_execute(sql)
            .unwrap_or_else(|e| panic!("participation statement waited or failed: {sql}: {e}"));
        slowest = slowest.max(start.elapsed());
    };
    time(
        c,
        &format!(
            "INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES({zid},0,{},'participation comment {i}',0,true)",
            zid * 1000
        ),
    );
    time(
        c,
        &format!("UPDATE conversations SET modified = now_as_millis() WHERE zid = {zid}"),
    );
    time(
        c,
        &format!(
            "INSERT INTO votes(zid,pid,tid,vote,created) VALUES({zid},0,{},0,now_as_millis())",
            i % 20
        ),
    );
    time(
        c,
        &format!(
            "SELECT tid FROM comments WHERE zid={zid} AND active=true AND velocity>0 AND mod != {REJECTED_COMMENT_MOD} \
         AND tid NOT IN (SELECT tid FROM votes_latest_unique WHERE zid={zid} AND pid=0) ORDER BY created"
        ),
    );
    time(
        c,
        &format!(
            "UPDATE participants SET last_interaction = now_as_millis() WHERE zid = {zid} AND pid = 0"
        ),
    );
    slowest
}

#[test]
fn the_schedulers_sessions_never_make_a_vote_a_comment_or_the_next_comment_wait() {
    let f = Fixture::new();
    f.conversation(201, 30);
    // A benchmark and open data, so every cycle's roster reads find it.
    f.open_data(201);
    let cfg = f.config(&[("DELPHI_SHADOW_BENCHMARK", "c201")]);
    let mut part = f.superuser();

    // 1. The read session, held open across the participation statements: its
    // snapshot and ACCESS SHARE locks block none of them.
    let mut read = Client::connect(&cfg.read_dsn, NoTls).unwrap();
    let slow_read = db::read_only(&mut read, 30_000, |tx| {
        db::live(tx, 0)?;
        assert_eq!(db::benchmark(tx, &["c201".to_owned()])?.len(), 1);
        assert_eq!(db::featured(tx)?.len(), 1);
        db::comment_set(tx, 201)?;
        db::math_lag(tx, "python")?;
        let mut slowest = Duration::ZERO;
        for i in 0..5 {
            slowest = slowest.max(participation(&mut part, 201, i));
        }
        // And it writes nothing: the transaction is read only.
        let refused = tx.execute(
            "INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES(201,0,201000,'never',0,true)",
            &[],
        );
        let code = refused.unwrap_err().code().cloned();
        assert_eq!(
            code,
            Some(postgres::error::SqlState::READ_ONLY_SQL_TRANSACTION)
        );
        Ok(slowest)
    });
    let slow_read = slow_read.unwrap();
    eprintln!("participation slowest while the read was open: {slow_read:?}");
    assert!(slow_read < Duration::from_secs(1));

    // 2. An admission held open (its FOR KEY SHARE on the conversation, the
    // scope lock and the job rows) across the same statements on the same
    // conversation.
    let mut queue = Client::connect(&cfg.queue_dsn, NoTls).unwrap();
    let mut tx = queue.transaction().unwrap();
    let census = db::CommentSet {
        digest: "ab".repeat(32),
        comments: 30,
        selection: plan::SELECTION,
        selection_digest: "ef".repeat(32),
        selected: 30,
    };
    let a = plan::admission(201, &census, Some(plan::Set::Current), None);
    let reply: Value = tx
        .query_one(
            "SELECT pd_writer_admit($1,$2,'delphi','delphi-shadow',$3,$4,$5::text::uuid,$6::text::uuid,\
             'delphi_full_pipeline',NULL,$7::text::jsonb,$8)",
            &[
                &ENV,
                &201i32,
                &a.key,
                &a.request_sha,
                &a.job_id.to_string(),
                &a.run_id.to_string(),
                &a.config.to_string(),
                &CODE,
            ],
        )
        .unwrap()
        .get(0);
    assert_eq!(reply["outcome"], "enqueued");
    let mut slowest = Duration::ZERO;
    for i in 5..10 {
        slowest = slowest.max(participation(&mut part, 201, i));
    }
    tx.commit().unwrap();
    f.cancel(reply["job_id"].as_str().unwrap());
    eprintln!("participation slowest while the admission was open: {slowest:?}");
    assert!(slowest < Duration::from_secs(1));

    // 3. Whole cycles, with the participation statements running beside them:
    // never more than one connection per login, none left open after. Counted
    // in this test's own database: the other tests' schedulers run beside it
    // on the same server, each in its own.
    let stop = Arc::new(AtomicBool::new(false));
    let most = Arc::new(AtomicUsize::new(0));
    let sampler = {
        let (stop, most, dsn) = (stop.clone(), most.clone(), url_for(&f.name, "postgres"));
        std::thread::spawn(move || {
            let mut c = Client::connect(&dsn, NoTls).unwrap();
            while !stop.load(Ordering::SeqCst) {
                let n: i64 = c
                    .query_one(
                        "SELECT count(*) FROM pg_stat_activity \
                         WHERE application_name = ANY($1) AND datname = current_database()",
                        &[&vec![db::READ_APPLICATION, db::QUEUE_APPLICATION]],
                    )
                    .unwrap()
                    .get(0);
                most.fetch_max(n as usize, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };
    let mut s = Scheduler::new(&cfg).unwrap();
    s.state.in_flight = None;
    for i in 10..30 {
        // A new day's roster read in every cycle, beside the participation
        // statements.
        s.roster = None;
        s.cycle().unwrap();
        s.rest_until_ms = 0;
        if let Some(flight) = s.state.in_flight.clone() {
            f.cancel(&flight.job_id);
        }
        let took = participation(&mut part, 201, i);
        assert!(took < Duration::from_secs(1), "{took:?}");
    }
    stop.store(true, Ordering::SeqCst);
    sampler.join().unwrap();
    let most = most.load(Ordering::SeqCst);
    eprintln!("scheduler connections at once, at most: {most}");
    assert!(
        most <= 1,
        "one connection at a time, opened per call: {most}"
    );
    let open: i64 = f
        .superuser()
        .query_one(
            "SELECT count(*) FROM pg_stat_activity \
                         WHERE application_name = ANY($1) AND datname = current_database()",
            &[&vec![db::READ_APPLICATION, db::QUEUE_APPLICATION]],
        )
        .unwrap()
        .get(0);
    assert_eq!(open, 0, "no connection is kept between calls");
}

#[test]
fn a_twin_is_admitted_on_the_same_set_and_named_in_its_record_or_dropped() {
    use polis_queue_adapter::shadow::state::PendingTwin;
    let f = Fixture::new();
    f.conversation(401, 30);
    f.conversation(402, 30);
    let cfg = f.config(&[("DELPHI_SHADOW_TWIN_EVERY", "1")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let first = s.state.in_flight.clone().unwrap();
    assert_eq!(first.zid, 401);
    assert_eq!(first.set, Some(plan::Set::Current));
    f.cancel(&first.job_id);
    s.cycle().unwrap();
    // As if the first run had succeeded and kept its clustering.
    s.state.pending_twin = Some(PendingTwin {
        zid: 401,
        first_job_id: first.job_id.clone(),
        digest: first.digest.clone(),
        comments: first.comments,
        assignments: [(0, vec![0])].into_iter().collect(),
        twin_job_id: None,
        set: first.set,
    });
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    let twin = s.state.in_flight.clone().unwrap();
    assert_eq!(twin.zid, 401, "the twin goes before any new set");
    assert_eq!(twin.twin_of.as_deref(), Some(first.job_id.as_str()));
    assert_eq!(twin.digest, first.digest);
    let record: Value = f
        .superuser()
        .query_one(
            "SELECT pd_run_record($1,$2::text::uuid)",
            &[&ENV, &twin.job_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        record["config_effective"]["shadow"]["twin_of"],
        first.job_id.as_str()
    );
    // The flight's digest is the selection's, which keys it; the census
    // digest of every comment is beside it.
    assert_eq!(
        record["config_effective"]["shadow"]["selection_sha256"],
        first.digest.as_str()
    );
    assert_eq!(
        record["config_effective"]["shadow"]["comment_set_sha256"],
        first.comment_set_sha256.as_deref().unwrap()
    );
    // A twin carries its first run's set, in its record and its flight.
    assert_eq!(record["config_effective"]["shadow"]["set"], "current");
    assert_eq!(twin.set, first.set);
    assert_eq!(
        s.state
            .pending_twin
            .as_ref()
            .unwrap()
            .twin_job_id
            .as_deref(),
        Some(twin.job_id.as_str())
    );
    // A twin whose set changed before its admission is dropped.
    f.cancel(&twin.job_id);
    s.cycle().unwrap();
    assert!(
        s.state.pending_twin.is_none(),
        "a cancelled twin compares nothing"
    );
    s.state.pending_twin = Some(PendingTwin {
        zid: 401,
        first_job_id: first.job_id.clone(),
        digest: "0".repeat(64),
        comments: first.comments,
        assignments: Default::default(),
        twin_job_id: None,
        set: first.set,
    });
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert!(s.state.pending_twin.is_none());
    let next = s.state.in_flight.clone().unwrap();
    assert_eq!((next.zid, next.twin_of), (402, None));
}

#[test]
fn a_twin_pending_across_a_deploy_is_dropped() {
    use polis_queue_adapter::shadow::state::PendingTwin;
    let f = Fixture::new();
    f.conversation(501, 30);
    let cfg = f.config(&[("DELPHI_SHADOW_TWIN_EVERY", "1")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let first = s.state.in_flight.clone().unwrap();
    f.cancel(&first.job_id);
    s.cycle().unwrap();
    // As if the first run had succeeded; then a deploy: the scheduler starts
    // again from its state file under the new source commit.
    s.state.pending_twin = Some(PendingTwin {
        zid: 501,
        first_job_id: first.job_id.clone(),
        digest: first.digest.clone(),
        comments: first.comments,
        assignments: [(0, vec![0])].into_iter().collect(),
        twin_job_id: None,
        set: first.set,
    });
    s.rest_until_ms = 0;
    s.state.save(&cfg.state_path).unwrap();
    let deployed = f.config(&[
        ("DELPHI_SHADOW_TWIN_EVERY", "1"),
        (
            "DELPHI_SHADOW_CODE_VERSION",
            "fedcba9876543210fedcba9876543210fedcba98",
        ),
    ]);
    let mut again = Scheduler::new(&deployed).unwrap();
    again.cycle().unwrap();
    assert!(
        again.state.pending_twin.is_none(),
        "a twin of another build is dropped"
    );
    assert!(
        f.jobs()
            .iter()
            .all(|(_, _, _, config)| config["shadow"]["twin_of"].is_null()),
        "no twin was admitted across the deploy"
    );
}

// ---- The storage budget -----------------------------------------------------

/// The four tables a run's rows land in, with their TOAST tables and indexes.
const STORED: [&str; 4] = [
    "delphi_result_rows",
    "delphi_result_families",
    "delphi_comment_embeddings",
    "polis_queue_logs",
];

fn stored_bytes(c: &mut Client) -> [i64; 4] {
    STORED.map(|t| {
        c.query_one(&format!("SELECT pg_total_relation_size('public.{t}')"), &[])
            .unwrap()
            .get::<_, i64>(0)
    })
}

/// What one Delphi run leaves in the four tables, written directly by the
/// superuser with triggers and foreign keys off (`session_replication_role`),
/// at the shapes the pipeline writes: DynamoDB-typed rows of a few hundred
/// bytes to about 1.5 KB, families as one large wire text each, one
/// 384-float embedding per comment and the child's log lines. Two attempts
/// (a retry), each its own batch. The job's row in `delphi_jobs` names its
/// comments, as an admission's configuration does. Returns the job id.
fn stored_run(c: &mut Client, env: &str, zid: i32, comments: i32, rows: i32) -> String {
    let job = Uuid::new_v4();
    let attempts = [Uuid::new_v4(), Uuid::new_v4()];
    let mut tx = c.transaction().unwrap();
    tx.batch_execute("SET LOCAL session_replication_role = replica")
        .unwrap();
    tx.execute(
        "INSERT INTO delphi_jobs(job_id,env,zid,kind,origin,status,config_effective) \
         VALUES($1,$2,$3,'full_pipeline','queued','succeeded', \
                jsonb_build_object('shadow', jsonb_build_object('comments', $4::int)))",
        &[&job, &env, &zid, &comments],
    )
    .unwrap();
    for (epoch, attempt) in attempts.iter().enumerate() {
        tx.execute(
            "INSERT INTO polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome) \
             VALUES($1,$2,$3,$4,$5,'succeeded')",
            &[&env, attempt, &job, &Uuid::new_v4(), &(epoch as i64 + 1)],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO delphi_result_rows(env,batch_id,family,item_key,ordinal,item) \
             SELECT $1::text, $2::uuid, 'Delphi_UMAPGraph', \
                    jsonb_build_object('edge_id', jsonb_build_object('S', g::text || '-' || $2::uuid::text)), g, \
                    jsonb_build_object('conversation_id', jsonb_build_object('S', $3::int::text), \
                      'edge_id', jsonb_build_object('S', g::text), \
                      'weight', jsonb_build_object('N', (g * 0.6180339887)::text), \
                      'text', jsonb_build_object('S', repeat(md5(g::text), 1 + g % 40))) \
             FROM generate_series(1, $4::int) g",
            &[&env, attempt, &zid, &rows],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO delphi_result_families(env,batch_id,family,codec_wire,content_sha,row_count) \
             SELECT $1::text, $2::uuid, f, w, encode(sha256(convert_to(w,'UTF8')),'hex'), $3::int FROM ( \
               SELECT f, string_agg('{\"comment_id\":{\"N\":\"' || g || '\"},\"layer0_cluster_id\":{\"N\":\"' \
                 || (g % 17) || '\"},\"umap_x\":{\"N\":\"' || md5(f || g) || '\"}}', ',') AS w \
               FROM unnest(ARRAY['Delphi_UMAPGraph','Delphi_CommentHierarchicalClusterAssignments', \
                                 'Delphi_CommentClustersFeatures','Delphi_CommentClustersStructureKeywords']) f, \
                    generate_series(1, $3::int) g GROUP BY f) s",
            &[&env, attempt, &rows],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO delphi_comment_embeddings(env,zid,model_id,tid,text_sha,embedding,batch_id) \
             SELECT $1::text, $2::int, 1, t + $4::int * $5::int, sha256(convert_to('comment ' || t, 'UTF8')), \
                    (SELECT array_agg((((i * 31 + t) % 997) / 997.0)::real) FROM generate_series(1, 384) i), $3::uuid \
             FROM generate_series(0, $4::int - 1) t",
            &[&env, &zid, attempt, &comments, &(epoch as i32)],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) \
             SELECT $1::text, $2::uuid, g, 'stdout', 'delphi_step/1 ' || repeat(md5(g::text), 1 + g % 6) \
             FROM generate_series(0, $3::int - 1) g",
            &[&env, attempt, &(rows / 2)],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    job.to_string()
}

#[test]
fn a_runs_bytes_are_what_the_tables_grew_by_read_by_index_ranges_alone() {
    use polis_queue_adapter::shadow::storage;
    let f = Fixture::new();
    f.conversation(601, 25);
    f.conversation(602, 25);
    let mut c = f.superuser();
    // Rows of other runs, of the shadow env and of a served env, first: a
    // run's measure counts its own rows only.
    let other = stored_run(&mut c, ENV, 602, 300, 2000);
    stored_run(&mut c, "import-example-1", 601, 300, 2000);
    // And a small run, whose share of each table is what a run's is in
    // production: a sliver.
    let small = stored_run(&mut c, ENV, 603, 40, 100);
    let before = stored_bytes(&mut c);
    let job = stored_run(&mut c, ENV, 601, 1000, 6000);
    let after = stored_bytes(&mut c);
    let by_table: Vec<i64> = after.iter().zip(before).map(|(a, b)| a - b).collect();
    let grew: i64 = by_table.iter().sum();
    let measured =
        db::read_only(&mut c, 30_000, |tx| storage::measure(tx, ENV, &job, 601)).unwrap();
    assert_eq!(measured.attempts, 2);
    assert_eq!(measured.result_rows, 12_000);
    assert_eq!(measured.families, 8);
    assert_eq!(measured.embeddings, 2000);
    assert_eq!(measured.log_lines, 6000);
    // The indexes the measure charges are the ones the migrations create.
    let mut indexes: Vec<(String, String)> = c
        .query(
            "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' \
             AND tablename = ANY($1) ORDER BY 1, 2",
            &[&STORED.to_vec()],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let mut modelled: Vec<(String, String)> = storage::INDEXES
        .iter()
        .map(|(t, i)| ((*t).to_owned(), (*i).to_owned()))
        .collect();
    indexes.sort();
    modelled.sort();
    assert_eq!(indexes, modelled, "an index the measure does not charge");
    let ratio = measured.stored() as f64 / grew as f64;
    println!(
        "storage measure: measured {} bytes, the four tables grew {grew} bytes ({STORED:?}: {by_table:?}), ratio {ratio:.3}; {measured:?}",
        measured.stored()
    );
    assert!(
        (0.9..=1.2).contains(&ratio),
        "the measure must be within 10% under to 20% over the tables' growth: {ratio:.3}"
    );
    // The other shadow run measures as its own.
    let o = db::read_only(&mut c, 30_000, |tx| storage::measure(tx, ENV, &other, 602)).unwrap();
    assert_eq!((o.result_rows, o.embeddings), (4000, 600));
    // A job with no attempt (refused, cancelled while queued) stored nothing.
    let none = db::read_only(&mut c, 30_000, |tx| {
        storage::measure(tx, ENV, &Uuid::new_v4().to_string(), 601)
    })
    .unwrap();
    assert_eq!(none.stored(), 0);

    // Many more runs, as production's tables hold: 400 batches of a few rows
    // each, so one run is the sliver of each table it is there.
    let mut tx = c.transaction().unwrap();
    tx.batch_execute(
        "SET LOCAL session_replication_role = replica; \
         CREATE TEMP TABLE other_batches ON COMMIT DROP AS \
           SELECT gen_random_uuid() AS b FROM generate_series(1, 400); \
         INSERT INTO delphi_result_rows(env,batch_id,family,item_key,ordinal,item) \
           SELECT 'shadow-delphi-1', b, 'Delphi_UMAPGraph', jsonb_build_object('k', g), g, \
                  jsonb_build_object('v', repeat('x', 200)) \
           FROM other_batches, generate_series(1, 40) g; \
         INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) \
           SELECT 'shadow-delphi-1', b, g, 'stdout', repeat('y', 100) \
           FROM other_batches, generate_series(0, 19) g; \
         INSERT INTO delphi_result_families(env,batch_id,family,codec_wire,content_sha,row_count) \
           SELECT 'shadow-delphi-1', b, 'Delphi_UMAPGraph', 'w', encode(sha256(convert_to('w','UTF8')),'hex'), 40 \
           FROM other_batches",
    )
    .unwrap();
    tx.commit().unwrap();
    // Cheap: every read is an index range on the run's own keys. With the
    // planner's statistics current, the small run's rows are read by index
    // in the three tables that are large here (result rows, embeddings, log
    // lines; families and attempts are a few pages, which the planner reads
    // whole); and no read needs a scan: with scans priced out, every one,
    // families' and attempts' too, is an index range.
    c.batch_execute(
        "ANALYZE delphi_result_rows, delphi_result_families, delphi_comment_embeddings, \
         polis_queue_logs, polis_queue_attempts",
    )
    .unwrap();
    fn plan_of(c: &mut impl postgres::GenericClient, job: &str, zid: i32) -> Vec<(String, String)> {
        fn walk(node: &Value, out: &mut Vec<(String, String)>) {
            if let (Some(kind), Some(rel)) = (
                node.get("Node Type").and_then(Value::as_str),
                node.get("Relation Name").and_then(Value::as_str),
            ) {
                out.push((kind.to_owned(), rel.to_owned()));
            }
            for child in node
                .get("Plans")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                walk(child, out);
            }
        }
        let plan: Value = c
            .query_one(
                &format!("EXPLAIN (FORMAT JSON) {}", storage::measure_sql()),
                &[&ENV, &job, &zid],
            )
            .unwrap()
            .get(0);
        let mut seen = Vec::new();
        walk(&plan[0]["Plan"], &mut seen);
        seen
    }
    fn by_index(seen: &[(String, String)], table: &str) -> bool {
        let of: Vec<_> = seen.iter().filter(|(_, rel)| rel == table).collect();
        !of.is_empty()
            && of
                .iter()
                .all(|(kind, _)| kind.contains("Index") || kind == "Bitmap Heap Scan")
    }
    let natural = plan_of(&mut c, &small, 603);
    println!("storage measure plan: {natural:?}");
    for table in [
        "delphi_result_rows",
        "delphi_comment_embeddings",
        "polis_queue_logs",
    ] {
        assert!(by_index(&natural, table), "{table} is scanned: {natural:?}");
    }
    let mut tx = c.transaction().unwrap();
    tx.batch_execute("SET LOCAL enable_seqscan = off").unwrap();
    let priced = plan_of(&mut tx, &small, 603);
    tx.rollback().unwrap();
    for table in STORED.iter().chain(["polis_queue_attempts"].iter()) {
        assert!(by_index(&priced, table), "{table} needs a scan: {priced:?}");
    }
}

#[test]
fn the_storage_budget_and_a_set_daily_limit_hold_admission_from_the_databases_own_bytes() {
    use polis_queue_adapter::shadow::storage::MIB;
    let f = Fixture::new();
    f.conversation(701, 30);
    f.conversation(702, 25);
    // A shadow run already stored, about 20 MB, before this scheduler (a new
    // state file: the first start, or a lost volume).
    let mut c = f.superuser();
    stored_run(&mut c, "shadow-twin-1", 702, 1000, 6000);
    let cfg = f.config(&[
        ("DELPHI_SHADOW_STORAGE_BUDGET_MB", "8"),
        ("DELPHI_SHADOW_LIVE_RESERVE_MB", "0"),
        ("DELPHI_SHADOW_STORAGE_DAILY_MB", "8"),
    ]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    // Listed from the database and measured: every shadow env counts.
    assert!(s.state.storage.reconciled);
    assert_eq!(s.state.storage.jobs, 1);
    assert!(s.state.storage.pending.is_empty());
    assert_eq!(s.state.storage.jobs, 1);
    assert_eq!(s.state.storage.comment_runs, 1000);
    let stored = s.state.storage.bytes;
    assert!(stored > 8 * MIB, "{stored}");
    assert_eq!(s.paused, Some(plan::Pause::StorageBudget));
    assert!(
        f.jobs().iter().all(|(env, ..)| env != ENV),
        "nothing admitted past the budget"
    );
    // Its state file keeps the count: a restart does not list or measure again.
    s.state.save(&cfg.state_path).unwrap();
    let mut again = Scheduler::new(&cfg).unwrap();
    again.cycle().unwrap();
    assert_eq!(again.state.storage.bytes, stored);
    assert_eq!(again.paused, Some(plan::Pause::StorageBudget));

    // A larger budget, but a daily limit is set and today's bytes reached it:
    // still nothing.
    let cfg = f.config(&[
        ("DELPHI_SHADOW_STORAGE_BUDGET_MB", "1024"),
        ("DELPHI_SHADOW_STORAGE_DAILY_MB", "8"),
    ]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    assert!(s.state.storage.day_bytes > 8 * MIB);
    assert_eq!(s.paused, Some(plan::Pause::StorageDaily));
    assert!(f.jobs().iter().all(|(env, ..)| env != ENV));

    // The same day's bytes with the daily limit left at its default, none
    // (and with 0, which says the same): room for the next run's estimate in
    // the total (25 comments at the measured bytes a comment), so admitted;
    // then its own bytes are read once it is terminal, before anything more
    // is admitted.
    let zero = f.config(&[
        ("DELPHI_SHADOW_STORAGE_BUDGET_MB", "1024"),
        ("DELPHI_SHADOW_STORAGE_DAILY_MB", "0"),
    ]);
    let cfg = f.config(&[("DELPHI_SHADOW_STORAGE_BUDGET_MB", "1024")]);
    assert_eq!(
        (cfg.storage_daily_bytes, zero.storage_daily_bytes),
        (None, None)
    );
    let mut s = Scheduler::new(&cfg).unwrap();
    assert!(
        s.state.storage.day_bytes > 8 * MIB,
        "today holds what a set limit refused"
    );
    s.cycle().unwrap();
    assert_eq!(s.paused, None, "no daily limit by default");
    let flight = s.state.in_flight.clone().unwrap();
    assert_eq!(flight.zid, 702);
    f.cancel(&flight.job_id);
    s.cycle().unwrap();
    assert_eq!(s.state.storage.pending.len(), 1, "terminal, to be measured");
    assert_eq!(s.state.storage.pending[0].set, Some(plan::Set::Current));
    // Listed again from the database (a lost state file), it keeps its set,
    // read from its run record; the run admitted before runs named one has
    // none.
    let listed = db::read_only(
        &mut f.superuser(),
        30_000,
        polis_queue_adapter::shadow::storage::shadow_jobs,
    )
    .unwrap();
    assert_eq!(
        listed.iter().map(|p| p.set).collect::<Vec<_>>(),
        [None, Some(plan::Set::Current)]
    );
    s.cycle().unwrap();
    assert!(s.state.storage.pending.is_empty());
    assert_eq!(s.state.storage.jobs, 2);
}

#[test]
fn the_live_reserve_stops_the_benchmark_and_featured_sets_while_current_runs_go_on_to_the_total() {
    use polis_queue_adapter::shadow::storage::MIB;
    let f = Fixture::new();
    f.quiet(801, 25, 3); // benchmark
    f.quiet(802, 30, 3); // featured (open data)
    f.open_data(802);
    f.conversation(803, 30); // current
    f.conversation(804, 35); // current
    // A shadow run already stored, about 20 MB (more than 8 MiB).
    let mut c = f.superuser();
    stored_run(&mut c, "shadow-twin-1", 804, 1000, 6000);
    let sources = [("DELPHI_SHADOW_BENCHMARK", "c801")];
    // With the budget less the reserve (4 MiB) already passed, the benchmark
    // and featured sets wait and the current set runs, smallest first,
    // against the whole budget (1 GiB).
    let mut extra = sources.to_vec();
    extra.extend([
        ("DELPHI_SHADOW_STORAGE_BUDGET_MB", "1024"),
        ("DELPHI_SHADOW_LIVE_RESERVE_MB", "1020"),
    ]);
    let cfg = f.config(&extra);
    assert_eq!(cfg.storage_live_reserve_bytes, 1020 * MIB);
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(803));
    assert!(s.state.storage.bytes > 4 * MIB);
    assert_eq!(next_admitted(&f, &mut s), Some(804));
    // Nothing current is left to run: the benchmark and featured sets still
    // wait, on the reserve.
    assert_eq!(next_admitted(&f, &mut s), None);
    assert_eq!(s.paused, Some(plan::Pause::StorageReserve));
    let t = &s.state.totals;
    assert_eq!(
        (
            t.benchmark_admitted,
            t.featured_admitted,
            t.current_admitted
        ),
        (0, 0, 2)
    );
    let shadow_zids = || -> Vec<i32> {
        f.jobs()
            .iter()
            .filter(|(env, ..)| env == ENV)
            .map(|(_, zid, ..)| *zid)
            .collect()
    };
    assert_eq!(shadow_zids(), [803, 804]);

    // Current runs stop at the total: with the stored bytes past the whole
    // budget (8 MiB, 4 of it kept for live), nothing runs, and the pause
    // names the budget, not the reserve.
    f.superuser()
        .execute(
            "INSERT INTO comments(zid,pid,uid,txt,mod,active) VALUES(803,0,803000,'one more generated comment',0,true)",
            &[],
        )
        .unwrap();
    let mut extra = sources.to_vec();
    extra.extend([
        ("DELPHI_SHADOW_STORAGE_BUDGET_MB", "8"),
        ("DELPHI_SHADOW_LIVE_RESERVE_MB", "4"),
        ("DELPHI_SHADOW_RERUN_AFTER_SECONDS", "0"),
    ]);
    let cfg = f.config(&extra);
    s.state.save(&cfg.state_path).unwrap();
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), None);
    assert_eq!(s.paused, Some(plan::Pause::StorageBudget));
    assert_eq!(shadow_zids(), [803, 804]);

    // And with room in the budget less the reserve (512 MiB of 1 GiB), the
    // benchmark set goes first again, then the featured one.
    let mut extra = sources.to_vec();
    extra.extend([
        ("DELPHI_SHADOW_STORAGE_BUDGET_MB", "1024"),
        ("DELPHI_SHADOW_LIVE_RESERVE_MB", "512"),
        ("DELPHI_SHADOW_RERUN_AFTER_SECONDS", "0"),
    ]);
    let cfg = f.config(&extra);
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(801));
    assert_eq!(next_admitted(&f, &mut s), Some(802));
    assert_eq!(
        f.sets(),
        [
            (803, "current".into()),
            (804, "current".into()),
            (801, "benchmark".into()),
            (802, "featured".into()),
        ]
    );
}

#[test]
fn graph_snapshot_keeps_moderation_and_active_status_and_refuses_oversize() {
    use polis_queue_adapter::shadow::graph;
    let f = Fixture::new();
    f.conversation(901, 6);
    let mut c = f.superuser();
    c.execute(
        "UPDATE comments SET mod=$2,active=false WHERE zid=$1 AND tid=0",
        &[&901_i32, &REJECTED_COMMENT_MOD],
    )
    .unwrap();
    let cfg = f.config(&[]);
    let db = db::Db::new(&cfg);
    let s = graph::snapshot(&db, 901).unwrap();
    assert_eq!(s.ids.len(), 6);
    assert!(s.ids.contains(&0));
    f.conversation(902, 2001);
    assert!(graph::snapshot(&db, 902).is_err());
    for zid in [901_i32, 902] {
        let rid: i64 = c
            .query_one(
                "INSERT INTO reports(zid,report_id) VALUES($1,$1::integer::text) RETURNING rid",
                &[&zid],
            )
            .unwrap()
            .get(0);
        // The same tid in another conversation must not remove this one's row.
        let tid = if zid == 901 { 1_i32 } else { 2_i32 };
        c.execute(
            "INSERT INTO report_comment_selections(zid,rid,tid,selection) VALUES($1,$2,$3,$4)",
            &[&zid, &rid, &tid, &(-1_i16)],
        )
        .unwrap();
    }
    let snapshot = graph::snapshot(&db, 901).unwrap();
    assert_eq!(snapshot.ids, vec![0, 2, 3, 4, 5]);
    let list = graph::listed(&db, &["c901".into()]).unwrap();
    assert_eq!(list[0].comments, snapshot.ids.len() as i64);
    assert_eq!(graph::snapshot(&db, 902).unwrap().ids.len(), 2000);
    c.execute(
        "UPDATE comments SET txt=E' \n\t' WHERE zid=901 AND tid=0",
        &[],
    )
    .unwrap();
    assert!(graph::snapshot(&db, 901).is_err());
    assert_eq!(graph::listed(&db, &["c901".into()]).unwrap()[0].comments, 5);
}

#[test]
fn graph_recovery_cancels_overdue_nodes_without_rewriting_terminal_results() {
    use polis_queue_adapter::shadow::graph;
    let f = Fixture::new();
    let mut cfg = f.config(&[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c911,c912")]);
    cfg.job_deadline = Duration::ZERO;
    let env = cfg.graph.as_ref().unwrap().env.clone();
    for zid in [911, 912] {
        f.conversation(zid, 20);
        let snapshot = graph::snapshot(&db::Db::new(&cfg), zid).unwrap();
        let mut admin = f.superuser();
        let data = serde_json::json!({"texts": snapshot.texts}).to_string();
        let sha: String = admin
            .query_one("SELECT public.pd_graph_hash($1::text::jsonb)", &[&data])
            .unwrap()
            .get(0);
        let mut spec = graph::spec(&snapshot, &sha, &serde_json::json!({"code": CODE,"runtime":"fixture-runtime","model_sha256":"a".repeat(64),"adapter_sha256":"b".repeat(64)})).unwrap();
        // The code-only test uses the existing catalog, without the separately
        // reviewed model admission migration or loading any numerical model.
        spec["nodes"][0]["declared"]["model"] = "sentence-transformers/all-MiniLM-L6-v2".into();
        spec["nodes"][3]["declared"]["model"] = "local-narrative-fixture/1".into();
        for n in spec["nodes"].as_array_mut().unwrap() {
            n["declared"]["config"]["shadow"]["expected_generation"] = 0.into();
        }
        let mut queue = Client::connect(&cfg.queue_dsn, NoTls).unwrap();
        let mut tx = queue.transaction().unwrap();
        let admitted: Value = tx
            .query_one(
                "SELECT pd_graph_admit($1,$2,$3,'fixture',$4::text::jsonb)",
                &[&env, &zid, &graph::scope(zid), &spec.to_string()],
            )
            .unwrap()
            .get(0);
        assert_eq!(admitted["outcome"], "enqueued");
        // The graph's held KEY SHARE and private scope locks do not block
        // the same participation statements tested for the full pipeline.
        assert!(participation(&mut admin, zid, 1) < Duration::from_secs(1));
        tx.commit().unwrap();
        let mut scheduler = Scheduler::new(&cfg).unwrap();
        let flight = scheduler.state.graph_flight.clone().unwrap();
        assert_eq!(flight.zid, zid);
        assert_eq!(flight.nodes.len(), 4);
        scheduler
            .state
            .graph_flight
            .as_mut()
            .unwrap()
            .admitted_at_ms -= 1000;
        scheduler.cycle().unwrap();
        scheduler.cycle().unwrap();
        assert!(scheduler.state.graph_flight.is_none());
        assert_eq!(scheduler.state.totals.failed, 1);
        assert!(scheduler.state.storage.bytes > 0);
        for node in flight.nodes {
            let before: Value = admin.query_one("SELECT to_jsonb(q) FROM polis_queue_jobs q WHERE env=$1 AND job_id=$2::text::uuid", &[&env,&node.job_id]).unwrap().get(0);
            let version = before["mgmt_version"].as_i64().unwrap();
            let reply: Value = queue
                .query_one(
                    "SELECT pq_cancel($1,$2::text::uuid,$3)",
                    &[&env, &node.job_id, &version],
                )
                .unwrap()
                .get(0);
            assert_eq!(reply["outcome"], "terminal");
            let after: Value = admin.query_one("SELECT to_jsonb(q) FROM polis_queue_jobs q WHERE env=$1 AND job_id=$2::text::uuid", &[&env,&node.job_id]).unwrap().get(0);
            assert_eq!(before, after);
        }
        assert_ne!(graph::scope(911), graph::scope(912));
    }
}

/// Stub local-file provenance only; scheduler SQL and queue contracts are real.
fn graph_config(f: &Fixture, extra: &[(&str, &str)]) -> config::Config {
    let model = polis_queue_adapter::shadow::graph::default_model().unwrap();
    let mut cfg = f.config(extra);
    let scripts = f.dir.join("scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    let mut p = serde_json::json!({"model":model,"code":CODE,"runtime":"fixture-runtime","adapter_sha256":"a".repeat(64),"model_sha256":"b".repeat(64)});
    p["implementations"] = serde_json::json!(polis_queue_adapter::job_graph_contract::registry().unwrap().iter().map(|row|
        serde_json::json!({"step":row.step,"model":row.model,"adapter_sha256":"a".repeat(64)})).collect::<Vec<_>>());
    std::fs::write(
        scripts.join("graph_provenance.py"),
        format!("import json\nprint(json.dumps({}))\n", p),
    )
    .unwrap();
    let g = cfg.graph.as_mut().unwrap();
    g.app = f.dir.clone();
    g.python = std::env::var("POLIS_JOBS_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
    cfg
}

fn graph_catalog(f: &Fixture) {
    // A disposable database simulates the separately installed model catalog.
    // No migration, table, role, or production configuration is changed here.
    let mut c = f.superuser();
    let sql:String=c.query_one("SELECT pg_get_functiondef('pd_graph_admit(text,integer,text,text,jsonb,uuid)'::regprocedure)",&[]).unwrap().get(0);
    let sql = sql
        .replace(
            "'sentence-transformers/all-MiniLM-L6-v2'",
            &format!(
                "'sentence-transformers/all-MiniLM-L6-v2','{}'",
                polis_queue_adapter::shadow::graph::default_model().unwrap()
            ),
        )
        .replace(
            "'local-narrative-fixture/1'",
            "'local-narrative-fixture/1','delphi-keyword-labels/1'",
        );
    c.batch_execute(&sql).unwrap();
}

/// Make the disposable database's admission function refuse every graph,
/// with the error it gives a model it does not admit, whichever models the
/// installed function admits. Returns the function as it was, to restore it.
fn graph_catalog_refuses(f: &Fixture) -> String {
    let mut c = f.superuser();
    let sql:String=c.query_one("SELECT pg_get_functiondef('pd_graph_admit(text,integer,text,text,jsonb,uuid)'::regprocedure)",&[]).unwrap().get(0);
    let head = &sql[..sql.find("AS $function$").unwrap()];
    c.batch_execute(&format!(
        "{head}AS $function$BEGIN RAISE EXCEPTION 'invalid stage contract (incremental not supported)'; END$function$"
    ))
    .unwrap();
    sql
}

#[test]
fn graph_refusals_and_errors_allow_benchmark_admission_and_are_remembered() {
    let f = Fixture::new();
    f.quiet(921, 2001, 1);
    f.quiet(922, 25, 1);
    f.quiet(923, 25, 1);
    let cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c921"),
            ("DELPHI_SHADOW_BENCHMARK", "c922,c923"),
        ],
    );
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(922));
    assert_eq!(s.state.graph_observed[&921].comments, 2001);
    let remembered = s.state.graph_observed.clone();
    s.state.save(&cfg.state_path).unwrap();
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(923));
    assert_eq!(s.state.graph_observed, remembered);
    // The admission function's invalid-stage-contract error must also fall
    // through, with the graph retry backed off.
    let original = graph_catalog_refuses(&f);
    f.quiet(924, 25, 1);
    f.quiet(925, 25, 1);
    f.quiet(926, 25, 1);
    f.quiet(927, 25, 1);
    let cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c924"),
            ("DELPHI_SHADOW_BENCHMARK", "c925"),
        ],
    );
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(925));
    // A failed provenance helper is an admission error too. With no backoff,
    // the first cycle caches the helper's value and is refused by the
    // function. The function then admits the graph and the helper is
    // removed: the changed directory makes the retry call the helper, and its
    // failure alone keeps the graph out while the next benchmark runs.
    let mut cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c924"),
            ("DELPHI_SHADOW_BENCHMARK", "c926,c927"),
        ],
    );
    cfg.roster_retry = Duration::ZERO;
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(926));
    f.superuser().batch_execute(&original).unwrap();
    graph_catalog(&f);
    std::fs::remove_file(f.dir.join("scripts/graph_provenance.py")).unwrap();
    assert_eq!(next_admitted(&f, &mut s), Some(927));
    assert!(s.state.graph_flight.is_none());
}

#[test]
fn graph_snapshot_and_serialized_bounds_are_conversation_refusals() {
    for (count, text) in [
        (25, " \n\t".to_owned()),
        (1500, "x".repeat(200)),
        (1000, "x".repeat(250)),
    ] {
        let f = Fixture::new();
        f.quiet(931, count, 1);
        f.quiet(932, 25, 1);
        if text.trim().is_empty() {
            f.superuser()
                .execute(
                    "UPDATE comments SET txt=$1 WHERE zid=931 AND tid=0",
                    &[&text],
                )
                .unwrap();
        } else {
            f.superuser()
                .execute(
                    "UPDATE comments SET txt=$1 || tid::text WHERE zid=931",
                    &[&text],
                )
                .unwrap();
        }
        let cfg = graph_config(
            &f,
            &[
                ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c931"),
                ("DELPHI_SHADOW_BENCHMARK", "c932"),
            ],
        );
        if count == 1000 {
            use polis_queue_adapter::shadow::graph;
            let snapshot = graph::snapshot(&db::Db::new(&cfg), 931).unwrap();
            let p = serde_json::json!({"code":CODE,"runtime":"fixture-runtime","adapter_sha256":"a".repeat(64),"model_sha256":"b".repeat(64)});
            let spec = graph::spec(&snapshot, &"e".repeat(64), &p)
                .unwrap()
                .to_string();
            assert!(spec.len() <= 1_048_576, "compact JSON fits");
            let sql_bytes: i32 = f
                .superuser()
                .query_one("SELECT octet_length(($1::text::jsonb)::text)", &[&spec])
                .unwrap()
                .get(0);
            assert!(
                sql_bytes > 1_048_576,
                "jsonb representation exceeds the bound"
            );
        }
        let mut s = Scheduler::new(&cfg).unwrap();
        assert_eq!(next_admitted(&f, &mut s), Some(932));
        assert_eq!(s.state.graph_observed[&931].comments, count as i64);
        assert!(s.state.graph_flight.is_none());
    }
}

/// Complete a graph through real claim/finalize calls with small fixture
/// artifacts. No child is spawned, so confirm_exit truthfully proves exit.
fn finish_graph(f: &Fixture, flight: &polis_queue_adapter::shadow::graph::Flight) {
    let mut c = f.superuser();
    for stage in polis_queue_adapter::shadow::graph::STAGES {
        let owner = Uuid::new_v4().to_string();
        let attempt = Uuid::new_v4().to_string();
        let claim:Value=c.query_one("SELECT pd_graph_claim($1,1::smallint,$2::text::uuid,$3::text::uuid,60,'delphi',$4)",&[&flight.env,&owner,&attempt,&stage]).unwrap().get(0);
        assert_eq!(claim["outcome"], "owned", "{claim}");
        let job = claim["job_id"].as_str().unwrap();
        let epoch = claim["lease_epoch"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        c.query_one("SELECT pq_end_attempt($1,$2::text::uuid,$3::text::uuid,$4::text::uuid,$5,'confirm_exit',NULL,true)",&[&flight.env,&job,&owner,&attempt,&epoch]).unwrap();
        let payload = "{\"fixture\":true}";
        let manifest=serde_json::json!({"schema":"polis-job-artifact-manifest/1","job_id":job,"run_id":claim["run_id"],"attempt_id":attempt,"stage":stage,"input_sha256":claim["graph_input_sha"],"outcome":"succeeded","output":{"role":"result","schema":format!("{stage}/1"),"payload":payload,"sha256":polis_queue_adapter::jobs::sha256_hex(payload.as_bytes())}}).to_string();
        c.execute("INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES($1,$2::text::uuid,0,'manifest',$3)",&[&flight.env,&attempt,&manifest]).unwrap();
        let sha = polis_queue_adapter::jobs::sha256_hex(manifest.as_bytes());
        let done:Value=c.query_one("SELECT pd_graph_finalize($1,$2::text::uuid,$3::text::uuid,$4::text::uuid,$5,'unused',$6)",&[&flight.env,&job,&owner,&attempt,&epoch,&sha]).unwrap().get(0);
        assert_eq!(done["outcome"], "succeeded", "{done}");
    }
}

#[test]
fn graph_scheduler_admits_publishes_and_accepts_only_its_lost_reply() {
    for lost_reply in [false, true] {
        let f = Fixture::new();
        f.quiet(941, 25, 1);
        graph_catalog(&f);
        let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c941")]);
        let mut s = Scheduler::new(&cfg).unwrap();
        s.cycle().unwrap();
        let flight = s.state.graph_flight.clone().unwrap();
        assert_eq!(flight.nodes.len(), 4);
        finish_graph(&f, &flight);
        if lost_reply {
            let leaf = flight
                .nodes
                .iter()
                .find(|n| n.stage == "graph_narrative")
                .unwrap();
            let published: Value = f
                .superuser()
                .query_one(
                    "SELECT pd_graph_publish($1,$2::text::uuid,$3::text::uuid,$4)",
                    &[
                        &flight.env,
                        &flight.graph_id,
                        &leaf.job_id,
                        &flight.generation,
                    ],
                )
                .unwrap()
                .get(0);
            assert_eq!(published["outcome"], "published");
            // The original commit is durable but its reply was lost. A later
            // publish call may itself fail; the separate root read still wins.
            f.superuser().batch_execute("ALTER FUNCTION pd_graph_publish(text,uuid,uuid,bigint) RENAME TO publish_before_lost_reply; CREATE FUNCTION pd_graph_publish(text,uuid,uuid,bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RAISE EXCEPTION 'publication reply unavailable' USING ERRCODE='40001'; END $$; GRANT EXECUTE ON FUNCTION pd_graph_publish(text,uuid,uuid,bigint) TO polis_queue_executor;").unwrap();
        }
        s.cycle().unwrap();
        assert!(s.state.graph_flight.is_none());
        assert_eq!(s.state.totals.succeeded, 1);
        assert_eq!(s.state.totals.failed, 0);
        let served: Value = f
            .superuser()
            .query_one(
                "SELECT pd_graph_served($1,$2,$3)",
                &[
                    &flight.env,
                    &flight.zid,
                    &polis_queue_adapter::shadow::graph::scope(flight.zid),
                ],
            )
            .unwrap()
            .get(0);
        assert_eq!(served["generation"], 1);
        s.rest_until_ms = 0;
        s.cycle().unwrap();
        assert!(s.state.graph_flight.is_none());
    }
}

#[test]
fn graph_publish_exception_counts_failure_once_and_allows_the_next_benchmark() {
    let f = Fixture::new();
    f.quiet(951, 25, 1);
    f.quiet(952, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c951"),
            ("DELPHI_SHADOW_BENCHMARK", "c952"),
        ],
    );
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    finish_graph(&f, &flight);
    // A newer graph supersedes the completed bundle before publication.
    let mut admin = f.superuser();
    admin
        .query_one("SELECT pd_graph_reconcile($1)", &[&flight.env])
        .unwrap();
    let newer:Value=admin.query_one("SELECT pd_graph_admit(env,zid,scope_key,'newer',request) FROM delphi_graphs WHERE env=$1 AND graph_id=$2::text::uuid",&[&flight.env,&flight.graph_id]).unwrap().get(0);
    let newer_id = newer["graph_id"].as_str().unwrap();
    let jobs=admin.query("SELECT q.job_id::text,q.mgmt_version FROM delphi_graph_nodes n JOIN polis_queue_jobs q USING(env,job_id) WHERE n.env=$1 AND n.graph_id=$2::text::uuid",&[&flight.env,&newer_id]).unwrap();
    for job in jobs {
        let id: String = job.get(0);
        let version: i64 = job.get(1);
        admin
            .query_one(
                "SELECT pq_cancel($1,$2::text::uuid,$3)",
                &[&flight.env, &id, &version],
            )
            .unwrap();
    }
    admin
        .query_one("SELECT pd_graph_reconcile($1)", &[&flight.env])
        .unwrap();
    s.cycle().unwrap();
    assert_eq!(s.state.totals.failed, 1);
    assert!(s.state.graph_flight.is_none());
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert_eq!(s.state.in_flight.as_ref().unwrap().zid, 952);
    assert_eq!(s.state.totals.failed, 1);
}

#[test]
fn graph_provenance_is_cached_until_source_metadata_changes() {
    let f = Fixture::new();
    f.quiet(961, 25, 1);
    f.quiet(962, 25, 1);
    f.quiet(963, 25, 1);
    let mut cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c961"),
            ("DELPHI_SHADOW_BENCHMARK", "c962,c963"),
        ],
    );
    cfg.roster_retry = Duration::ZERO;
    graph_catalog_refuses(&f);
    let helper = f.dir.join("scripts/graph_provenance.py");
    let counter = f.dir.join("calls.txt");
    let mut script = std::fs::read_to_string(&helper).unwrap();
    script += &format!(
        "\nwith open({}, 'a') as f: f.write('called\\n')\n",
        serde_json::to_string(&counter.to_string_lossy()).unwrap()
    );
    std::fs::write(&helper, &script).unwrap();
    let mut s = Scheduler::new(&cfg).unwrap();
    // Each graph admission reaches the admission function, which refuses it.
    s.cycle().unwrap();
    let job = s.state.in_flight.clone().unwrap().job_id;
    f.cancel(&job);
    s.cycle().unwrap();
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert_eq!(
        std::fs::read_to_string(&counter).unwrap().lines().count(),
        1
    );
    let job = s.state.in_flight.clone().unwrap().job_id;
    f.cancel(&job);
    s.cycle().unwrap();
    s.rest_until_ms = 0;
    // Metadata changes invalidate the value even within the same process.
    std::fs::write(&helper, format!("{script}\n# changed local file\n")).unwrap();
    s.cycle().unwrap();
    assert_eq!(
        std::fs::read_to_string(&counter).unwrap().lines().count(),
        2
    );
}

#[test]
fn typed_admission_resolves_external_producers_with_executor_privileges() {
    use polis_queue_adapter::{job_graph_contract::Image, jobs::admission};
    let f = Fixture::new();
    f.quiet(961, 25, 1);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c961")]);
    let mut scheduler = Scheduler::new(&cfg).unwrap();
    scheduler.cycle().unwrap();
    let flight = scheduler.state.graph_flight.clone().unwrap();
    finish_graph(&f, &flight);
    let mut admin = f.superuser();
    let original: Value = admin
        .query_one(
            "SELECT request FROM delphi_graphs WHERE env=$1 AND graph_id=$2::text::uuid",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap()
        .get(0);
    let view: Value = admin
        .query_one(
            "SELECT pd_graph_view($1,$2::text::uuid)",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap()
        .get(0);
    let producer = view["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["key"] == "graph_cluster")
        .unwrap();
    let mut topic = original["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["stage"] == "graph_topics")
        .unwrap()
        .clone();
    topic["inputs"] = serde_json::json!([{"role":"clusters","artifact_id":producer["artifact"]["artifact_id"],"sha256":producer["artifact"]["content_sha"],"contract_sha256":producer["declared_sha"]}]);
    let spec = serde_json::json!({"schema":"polis-job-graph/1","nodes":[topic]});
    let image: Image = serde_json::from_value(serde_json::json!({"code":CODE,"runtime":"fixture-runtime","implementations":[{"step":"keywords","model":"delphi-tfidf-keywords/1","adapter_sha256":"a".repeat(64)}]})).unwrap();
    let mut executor = Client::connect(&url_for(&f.name, &f.login), NoTls).unwrap();
    let reply = admission::admit(
        &mut executor,
        &flight.env,
        961,
        "external-topics",
        "one",
        spec.clone(),
        &image,
        None,
    )
    .unwrap();
    assert!(reply["graph_id"].is_string());
    let mut wrong = spec;
    let producer = view["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["key"] == "graph_embed")
        .unwrap();
    wrong["nodes"][0]["inputs"][0] = serde_json::json!({"role":"clusters","artifact_id":producer["artifact"]["artifact_id"],"sha256":producer["artifact"]["content_sha"],"contract_sha256":producer["declared_sha"]});
    let error = admission::admit(
        &mut executor,
        &flight.env,
        961,
        "wrong-producer",
        "two",
        wrong,
        &image,
        None,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "graph_producer_type");
}

#[test]
fn lost_graph_attempt_does_not_hold_other_conversations_after_restart_and_list_clear() {
    let f = Fixture::new();
    f.quiet(971, 25, 1);
    f.quiet(972, 25, 1);
    graph_catalog(&f);
    let mut cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c971"),
            ("DELPHI_SHADOW_BENCHMARK", "c971,c972"),
        ],
    );
    let mut scheduler = Scheduler::new(&cfg).unwrap();
    scheduler.cycle().unwrap();
    let flight = scheduler.state.graph_flight.clone().unwrap();
    let mut c = f.superuser();
    // A claimed attempt with no exit attestation models a lost journal. No
    // child is spawned in this database test; it must still remain unproven.
    let owner = Uuid::new_v4().to_string();
    let attempt = Uuid::new_v4().to_string();
    let claim:Value=c.query_one("SELECT pd_graph_claim($1,1::smallint,$2::text::uuid,$3::text::uuid,60,'delphi','graph_embed')",&[&flight.env,&owner,&attempt]).unwrap().get(0);
    assert_eq!(claim["outcome"], "owned");
    scheduler.state.save(&cfg.state_path).unwrap();
    drop(scheduler);
    cfg.graph = None;
    cfg.job_deadline = Duration::ZERO;
    let mut scheduler = Scheduler::new(&cfg).unwrap();
    scheduler.cycle().unwrap();
    assert!(scheduler.state.graph_flight.is_none());
    assert_eq!(scheduler.state.graph_deferred.len(), 1);
    scheduler.state.save(&cfg.state_path).unwrap();
    drop(scheduler);
    let mut scheduler = Scheduler::new(&cfg).unwrap();
    scheduler.cycle().unwrap();
    assert_eq!(scheduler.state.in_flight.as_ref().unwrap().zid, 972);
    let view: Value = c
        .query_one(
            "SELECT pd_graph_view($1,$2::text::uuid)",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(view["guard_held"], true);
    let unconfirmed:i64=c.query_one("SELECT count(*) FROM polis_queue_attempts WHERE env=$1 AND attempt_id=$2::text::uuid AND process_exit_confirmed_at IS NULL",&[&flight.env,&attempt]).unwrap().get(0);
    assert_eq!(unconfirmed, 1);
}

#[test]
fn committed_graph_admission_with_unread_reply_is_recovered_before_full_pipeline() {
    let f = Fixture::new();
    f.quiet(981, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c981"),
            ("DELPHI_SHADOW_BENCHMARK", "c981"),
        ],
    );
    let mut scheduler = Scheduler::new(&cfg).unwrap();
    scheduler.cycle().unwrap();
    let graph_id = scheduler
        .state
        .graph_flight
        .as_ref()
        .unwrap()
        .graph_id
        .clone();
    // Discard the successful reply as a lost transport reply would do. The
    // persisted recovery domain precedes admission, even without flight state.
    scheduler.state.graph_flight = None;
    scheduler.state.graph_seen.clear();
    scheduler.cycle().unwrap();
    assert_eq!(
        scheduler.state.graph_flight.as_ref().unwrap().graph_id,
        graph_id
    );
    assert!(scheduler.state.in_flight.is_none());
}

#[test]
fn transient_publish_before_commit_retries_and_keeps_one_generation() {
    let f = Fixture::new();
    f.quiet(991, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c991")]);
    let mut scheduler = Scheduler::new(&cfg).unwrap();
    scheduler.cycle().unwrap();
    let flight = scheduler.state.graph_flight.clone().unwrap();
    finish_graph(&f, &flight);
    let mut c = f.superuser();
    // Sequences survive rollback, so the first call refuses before its commit
    // and the second exercises the original publication function.
    c.batch_execute("CREATE SEQUENCE publish_calls; ALTER FUNCTION pd_graph_publish(text,uuid,uuid,bigint) RENAME TO publish_original;
        CREATE FUNCTION pd_graph_publish(text,uuid,uuid,bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN IF nextval('publish_calls')=1 THEN RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END IF;
        RETURN publish_original($1,$2,$3,$4); END $$;
        GRANT EXECUTE ON FUNCTION pd_graph_publish(text,uuid,uuid,bigint) TO polis_queue_executor;").unwrap();
    // The retry is on the next poll, not within this one: the flight is
    // kept and nothing is counted until then.
    scheduler.cycle().unwrap();
    assert!(scheduler.state.graph_flight.is_some());
    assert_eq!(
        (
            scheduler.state.totals.succeeded,
            scheduler.state.totals.failed
        ),
        (0, 0)
    );
    scheduler.cycle().unwrap();
    assert_eq!(scheduler.state.totals.succeeded, 1);
    assert_eq!(scheduler.state.totals.failed, 0);
    let calls: i64 = c
        .query_one("SELECT last_value FROM publish_calls", &[])
        .unwrap()
        .get(0);
    assert_eq!(calls, 2);
    assert_eq!(served(&f, &flight)["generation"], 1, "one generation");
}

// ---------------------------------------------------------------------------
// The graph path before its list is set: an absent executor, publication
// retries and a held admission.

/// Each node's queue state, in node order.
fn graph_states(f: &Fixture, flight: &polis_queue_adapter::shadow::graph::Flight) -> Vec<String> {
    f.superuser()
        .query(
            "SELECT q.state FROM delphi_graph_nodes n JOIN polis_queue_jobs q USING(env,job_id) WHERE n.env=$1 AND n.graph_id=$2::text::uuid ORDER BY n.node_key",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

fn served(f: &Fixture, flight: &polis_queue_adapter::shadow::graph::Flight) -> Value {
    f.superuser()
        .query_one(
            "SELECT pd_graph_served($1,$2,$3)",
            &[
                &flight.env,
                &flight.zid,
                &polis_queue_adapter::shadow::graph::scope(flight.zid),
            ],
        )
        .unwrap()
        .get::<_, Option<Value>>(0)
        .unwrap_or(Value::Null)
}

#[test]
fn an_unclaimed_graph_is_let_go_after_a_short_deadline_and_the_full_pipeline_goes_on() {
    // No graph executor runs (absent, unstartable, or refused at deploy), so
    // nothing ever claims the graph's first node.
    let f = Fixture::new();
    f.quiet(1011, 25, 1);
    f.quiet(1012, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(
        &f,
        &[
            ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1011"),
            ("DELPHI_SHADOW_BENCHMARK", "c1012"),
        ],
    );
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    assert_eq!(flight.zid, 1011);
    // Inside the short deadline the graph is waited for, as before: two
    // seconds short of ten minutes, nothing of it is cancelled.
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 598_000;
    s.cycle().unwrap();
    assert_eq!(
        s.state.graph_flight.as_ref().map(|g| g.graph_id.clone()),
        Some(flight.graph_id.clone())
    );
    assert_eq!(
        graph_states(&f, &flight),
        ["queued"; 4],
        "nothing is cancelled inside ten minutes"
    );
    assert!(s.state.in_flight.is_none());
    // Unclaimed for longer than ten minutes, far inside the job deadline.
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 3_000;
    s.cycle().unwrap();
    assert!(
        graph_states(&f, &flight).iter().all(|st| st == "cancelled"),
        "{:?}",
        graph_states(&f, &flight)
    );
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    assert!(s.state.graph_deferred.is_empty(), "let go, not deferred");
    assert_eq!(s.state.totals.failed, 1);
    let view: Value = f
        .superuser()
        .query_one(
            "SELECT pd_graph_view($1,$2::text::uuid)",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(view["guard_held"], false, "its scope is released");
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert_eq!(s.state.in_flight.as_ref().unwrap().zid, 1012);
}

#[test]
fn a_claimed_graph_is_not_let_go_at_the_short_deadline() {
    let f = Fixture::new();
    f.quiet(1016, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1016")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    let (owner, attempt) = (Uuid::new_v4().to_string(), Uuid::new_v4().to_string());
    let claim: Value = f.superuser().query_one("SELECT pd_graph_claim($1,1::smallint,$2::text::uuid,$3::text::uuid,60,'delphi','graph_embed')", &[&flight.env, &owner, &attempt]).unwrap().get(0);
    assert_eq!(claim["outcome"], "owned");
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
    s.cycle().unwrap();
    s.cycle().unwrap();
    assert_eq!(
        s.state.graph_flight.as_ref().map(|g| g.graph_id.clone()),
        Some(flight.graph_id.clone())
    );
    assert_eq!(s.state.totals.failed, 0);
    assert!(!graph_states(&f, &flight).iter().any(|st| st == "cancelled"));
}

#[test]
fn a_graph_whose_claimed_node_was_put_back_in_the_queue_is_not_let_go() {
    // Every node is queued again, but one was claimed once: an executor
    // ran, so the short deadline does not apply. Only the read of the
    // attempts tells this graph from one nothing ever claimed.
    let f = Fixture::new();
    f.quiet(1017, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1017")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    let mut c = f.superuser();
    let (owner, attempt) = (Uuid::new_v4().to_string(), Uuid::new_v4().to_string());
    let claim: Value = c.query_one("SELECT pd_graph_claim($1,1::smallint,$2::text::uuid,$3::text::uuid,60,'delphi','graph_embed')", &[&flight.env, &owner, &attempt]).unwrap().get(0);
    assert_eq!(claim["outcome"], "owned");
    let job = claim["job_id"].as_str().unwrap().to_owned();
    let epoch: i64 = claim["lease_epoch"].as_str().unwrap().parse().unwrap();
    // Parked with its exit confirmed (its executor stopped it), then put
    // back in the queue by the reaper.
    let parked: Value = c.query_one("SELECT pq_end_attempt($1,$2::text::uuid,$3::text::uuid,$4::text::uuid,$5,'park','fixture_parked',true,clock_timestamp())", &[&flight.env, &job, &owner, &attempt, &epoch]).unwrap().get(0);
    assert_eq!(parked["outcome"], "parked", "{parked}");
    c.query_one(
        "SELECT pq_reap_one($1,$2::text::uuid)",
        &[&flight.env, &job],
    )
    .unwrap();
    assert_eq!(graph_states(&f, &flight), ["queued"; 4]);
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
    s.cycle().unwrap();
    s.cycle().unwrap();
    assert_eq!(
        s.state.graph_flight.as_ref().map(|g| g.graph_id.clone()),
        Some(flight.graph_id.clone())
    );
    assert_eq!(
        graph_states(&f, &flight),
        ["queued"; 4],
        "nothing cancelled"
    );
    assert_eq!(s.state.totals.failed, 0);
    assert!(unclaimed(&s, &flight.env).is_null());
}

#[test]
fn a_graph_with_a_node_out_of_the_queue_is_not_let_go_whatever_the_attempts_table_holds() {
    // The short deadline is for a graph whose every node is still queued.
    // A node in any other state is not let go by it, even with no attempt
    // on record: a row only a direct update makes (the queue's functions
    // never take a job out of `queued` without an attempt), so that the
    // rule is seen to read the nodes' states and not only the attempts.
    let f = Fixture::new();
    f.quiet(1018, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1018")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    let embed = flight
        .nodes
        .iter()
        .find(|n| n.stage == "graph_embed")
        .unwrap()
        .job_id
        .clone();
    f.superuser()
        .execute(
            "UPDATE polis_queue_jobs SET state='retry_wait', eligible_at=clock_timestamp()+interval '1 day' WHERE env=$1 AND job_id=$2::text::uuid",
            &[&flight.env, &embed],
        )
        .unwrap();
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
    s.cycle().unwrap();
    s.cycle().unwrap();
    assert_eq!(
        s.state.graph_flight.as_ref().map(|g| g.graph_id.clone()),
        Some(flight.graph_id.clone())
    );
    let states = graph_states(&f, &flight);
    assert!(!states.iter().any(|st| st == "cancelled"), "{states:?}");
    assert_eq!(s.state.totals.failed, 0);
    assert!(unclaimed(&s, &flight.env).is_null());
}

/// The scheduler's record of the graphs let go as unclaimed in `env`, as
/// its state file holds it (null when there is none).
fn unclaimed(s: &Scheduler<'_>, env: &str) -> Value {
    serde_json::to_value(&s.state).unwrap()["graph_unclaimed"][env].clone()
}

/// Move the env's hold back by `ms`, as if that much more time had passed
/// since the last graph there was let go.
fn age_hold(s: &mut Scheduler<'_>, env: &str, ms: i64) {
    let mut v = serde_json::to_value(&s.state).unwrap();
    let at = v["graph_unclaimed"][env]["at_ms"]
        .as_i64()
        .expect("a graph let go as unclaimed");
    v["graph_unclaimed"][env]["at_ms"] = (at - ms).into();
    s.state = serde_json::from_value(v).unwrap();
}

/// The graph in flight, unclaimed past ten minutes: one cycle cancels its
/// nodes, the next finishes it.
fn let_go_unclaimed(
    f: &Fixture,
    s: &mut Scheduler<'_>,
) -> polis_queue_adapter::shadow::graph::Flight {
    let flight = s.state.graph_flight.clone().unwrap();
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
    s.cycle().unwrap();
    assert_eq!(graph_states(f, &flight), ["cancelled"; 4]);
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    flight
}

/// A conversation let go as unclaimed is neither seen nor observed, so it
/// is admitted again when its env's hold ends.
fn assert_forgotten(s: &Scheduler<'_>, zid: i32) {
    assert!(!s.state.graph_seen.contains_key(&zid), "seen: {zid}");
    assert!(
        !s.state.graph_observed.contains_key(&zid),
        "observed: {zid}"
    );
}

/// A graph's admission key and specification.
fn graph_request(
    f: &Fixture,
    flight: &polis_queue_adapter::shadow::graph::Flight,
) -> (String, Value) {
    let r = f
        .superuser()
        .query_one(
            "SELECT request_key, request FROM delphi_graphs WHERE env=$1 AND graph_id=$2::text::uuid",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap();
    (r.get(0), r.get(1))
}

#[test]
fn a_let_go_graph_is_admitted_again_as_a_new_graph_after_its_hold_across_a_restart() {
    // An unchanged listed conversation (a closed benchmark conversation)
    // whose graph nothing claimed. Its next admission is a new graph, not
    // the cancelled one its snapshot's own key would answer with, and the
    // full pipeline goes on meanwhile.
    let f = Fixture::new();
    f.quiet(1051, 25, 1);
    f.quiet(1052, 25, 1);
    graph_catalog(&f);
    let list = ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1051");
    let cfg = graph_config(&f, &[list, ("DELPHI_SHADOW_BENCHMARK", "c1052")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let first = let_go_unclaimed(&f, &mut s);
    assert_eq!(s.state.totals.failed, 1);
    let held = unclaimed(&s, &first.env);
    assert_eq!(held["count"], 1, "{held}");
    assert_eq!(held["graphs"]["1051"]["graph_id"], first.graph_id.as_str());
    assert_eq!(held["graphs"]["1051"]["digest"], first.digest.as_str());
    assert_eq!(held["graphs"]["1051"].as_object().map(|o| o.len()), Some(2));
    assert_forgotten(&s, 1051);
    // While the hold lasts no graph is admitted; the full pipeline goes on.
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    let run = s
        .state
        .in_flight
        .clone()
        .expect("the full pipeline goes on");
    assert_eq!(run.zid, 1052);
    f.cancel(&run.job_id);
    s.cycle().unwrap();
    assert!(s.state.in_flight.is_none());
    // A restart of the scheduler keeps the hold and what was let go.
    s.state.save(&cfg.state_path).unwrap();
    drop(s);
    let mut s = Scheduler::new(&cfg).unwrap();
    assert_eq!(unclaimed(&s, &first.env), held);
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none(), "held after the restart");
    // Nor is its snapshot remembered as seen again from the database.
    assert_forgotten(&s, 1051);
    // One minute short of the hour, the hold stands.
    age_hold(&mut s, &first.env, 3_540_000);
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none(), "an hour, not less");
    // Past the hour the same snapshot is admitted again, as a new graph.
    age_hold(&mut s, &first.env, 61_000);
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    let second = s.state.graph_flight.clone().expect("admitted again");
    assert_ne!(second.graph_id, first.graph_id, "not the cancelled graph");
    assert_eq!(second.digest, first.digest, "of the same snapshot");
    assert_eq!(graph_states(&f, &second), ["queued"; 4]);
    let (first_key, first_request) = graph_request(&f, &first);
    let (second_key, second_request) = graph_request(&f, &second);
    assert_ne!(first_key, second_key);
    assert_eq!(first_request, second_request, "the same specification");
    assert_eq!(s.state.graph_seen.get(&1051), Some(&first.digest));
    // Claimed and finished: the executor is back, and the count is reset.
    finish_graph(&f, &second);
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    assert_eq!(s.state.totals.succeeded, 1);
    assert_eq!(served(&f, &second)["generation"], 1);
    assert_eq!(unclaimed(&s, &first.env)["count"], 0);
    // The unchanged snapshot, now published, is not admitted again.
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    assert_eq!(graphs_of(&f, &first.env, 1051), 2);
}

#[test]
fn a_let_go_graph_returns_at_the_next_build_its_hold_doubles_and_its_publication_retry_finds_it() {
    let f = Fixture::new();
    f.quiet(1061, 25, 1);
    graph_catalog(&f);
    let list = ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1061");
    let build = |code: &str| graph_config(&f, &[list, ("DELPHI_SHADOW_CODE_VERSION", code)]);
    let cfg = build(CODE);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let first = let_go_unclaimed(&f, &mut s);
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none(), "held under the same build");
    // The next build (a deploy, which may have fixed the executor) admits
    // it at once, as a new graph.
    s.state.save(&cfg.state_path).unwrap();
    drop(s);
    let next = build("fedcba9876543210fedcba9876543210fedcba98");
    let mut s = Scheduler::new(&next).unwrap();
    s.cycle().unwrap();
    let second = s
        .state
        .graph_flight
        .clone()
        .expect("admitted at the next build");
    assert_ne!(second.graph_id, first.graph_id);
    // Nothing claims it either: let go again, and the hold is two hours.
    let second = let_go_unclaimed(&f, &mut s);
    let held = unclaimed(&s, &second.env);
    assert_eq!(held["count"], 2, "{held}");
    assert_eq!(held["graphs"]["1061"]["graph_id"], second.graph_id.as_str());
    age_hold(&mut s, &second.env, 3_601_000);
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert!(
        s.state.graph_flight.is_none(),
        "two hours after a second in a row"
    );
    age_hold(&mut s, &second.env, 3_600_000);
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    let third = s
        .state
        .graph_flight
        .clone()
        .expect("admitted after two hours");
    assert!(third.graph_id != first.graph_id && third.graph_id != second.graph_id);
    // Claimed and finished, but its publication is given up.
    finish_graph(&f, &third);
    publication_fails_first(&f, 1_000_000);
    for _ in 0..3 {
        s.cycle().unwrap();
    }
    assert!(s.state.graph_flight.is_none());
    assert_eq!(publish_calls(&f), 3);
    assert_eq!(s.state.totals.failed, 3);
    // At the build after, the same snapshot's admission finds that finished
    // graph, and only its publication runs.
    publication_restored(&f);
    s.state.save(&next.state_path).unwrap();
    drop(s);
    let after = build("00112233445566778899aabbccddeeff00112233");
    let mut s = Scheduler::new(&after).unwrap();
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert_eq!(
        s.state.graph_flight.as_ref().map(|g| g.graph_id.clone()),
        Some(third.graph_id.clone()),
        "the finished graph, not a new one"
    );
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    assert_eq!(s.state.totals.succeeded, 1);
    assert_eq!(served(&f, &third)["generation"], 1);
    assert_eq!(graphs_of(&f, &third.env, 1061), 3);
}

#[test]
fn a_graph_found_cancelled_with_no_claim_or_past_its_deadline_with_none_is_let_go_as_unclaimed() {
    // A scheduler that stopped after cancelling and before saving its state,
    // a person who cancelled the graph before any claim, and a graph past the
    // whole job deadline that nothing ever claimed: each is let go as
    // unclaimed when it finishes, and admitted again later.
    for how in ["cancelled", "overdue"] {
        let f = Fixture::new();
        f.quiet(1071, 25, 1);
        graph_catalog(&f);
        let mut cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1071")]);
        if how == "overdue" {
            cfg.job_deadline = Duration::from_secs(60);
        }
        let mut s = Scheduler::new(&cfg).unwrap();
        s.cycle().unwrap();
        let flight = s.state.graph_flight.clone().unwrap();
        if how == "cancelled" {
            let mut c = f.superuser();
            for n in &flight.nodes {
                let status: Value = c
                    .query_one(
                        "SELECT pq_job_status($1,$2::text::uuid)",
                        &[&flight.env, &n.job_id],
                    )
                    .unwrap()
                    .get(0);
                let version: i64 = status["mgmt_version"].as_str().unwrap().parse().unwrap();
                c.query_one(
                    "SELECT pq_cancel($1,$2::text::uuid,$3)",
                    &[&flight.env, &n.job_id, &version],
                )
                .unwrap();
            }
        } else {
            s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
        }
        for _ in 0..4 {
            s.cycle().unwrap();
        }
        assert!(s.state.graph_flight.is_none(), "{how}");
        assert!(s.state.graph_deferred.is_empty(), "{how}");
        assert_eq!(s.state.totals.failed, 1, "{how}");
        let held = unclaimed(&s, &flight.env);
        assert_eq!(held["count"], 1, "{how}: {held}");
        assert_eq!(
            held["graphs"]["1071"]["graph_id"],
            flight.graph_id.as_str(),
            "{how}"
        );
        assert_forgotten(&s, 1071);
        age_hold(&mut s, &flight.env, 3_601_000);
        s.rest_until_ms = 0;
        s.cycle().unwrap();
        let again = s.state.graph_flight.clone().expect(how);
        assert_ne!(again.graph_id, flight.graph_id, "{how}");
    }
}

#[test]
fn a_claim_racing_the_let_go_does_not_make_it_permanent() {
    // The executor's claim can land between the read that finds no attempt
    // and the cancel (the cancel then wins): the graph was let go as
    // unclaimed, and is admitted again later, though an attempt now exists.
    let f = Fixture::new();
    f.quiet(1076, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1076")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
    s.cycle().unwrap();
    assert_eq!(graph_states(&f, &flight), ["cancelled"; 4]);
    // The racing claim's attempt, ended by the cancel, as pq_cancel ends a
    // claimed job's attempt.
    let embed = flight
        .nodes
        .iter()
        .find(|n| n.stage == "graph_embed")
        .unwrap()
        .job_id
        .clone();
    f.superuser()
        .execute(
            "INSERT INTO polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome,ended_at,process_exit_confirmed_at) VALUES($1,gen_random_uuid(),$2::text::uuid,gen_random_uuid(),1,'cancelled',clock_timestamp(),clock_timestamp())",
            &[&flight.env, &embed],
        )
        .unwrap();
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    assert_eq!(
        unclaimed(&s, &flight.env)["graphs"]["1076"]["graph_id"],
        flight.graph_id.as_str()
    );
    assert_forgotten(&s, 1076);
    age_hold(&mut s, &flight.env, 3_601_000);
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    let again = s.state.graph_flight.clone().expect("admitted again");
    assert_ne!(again.graph_id, flight.graph_id);
}

#[test]
fn a_let_go_says_so_with_its_count_and_its_hold_once() {
    let f = Fixture::new();
    f.quiet(1081, 25, 1);
    graph_catalog(&f);
    let list = ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1081");
    let cfg = graph_config(&f, &[list]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    // Unclaimed for more than ten minutes when the scheduler's process starts.
    s.state.graph_flight.as_mut().unwrap().admitted_at_ms -= 601_000;
    s.state.save(&cfg.state_path).unwrap();
    drop(s);
    let app = f.dir.display().to_string();
    let python = std::env::var("POLIS_JOBS_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
    let polls_held = |lines: &[Value]| {
        lines
            .iter()
            .skip_while(|l| l["event"] != "graph_admission_held")
            .filter(|l| l["event"] == "idle")
            .count()
    };
    let lines = scheduler_lines(
        &f,
        &[
            list,
            ("DELPHI_SHADOW_POLL_SECONDS", "1"),
            ("DELPHI_SHADOW_JOB_POLL_SECONDS", "1"),
            ("DELPHI_APP_PATH", &app),
            ("POLIS_JOBS_PYTHON", &python),
        ],
        |lines| polls_held(lines) >= 3,
        Duration::from_secs(60),
    );
    assert!(polls_held(&lines) >= 3, "{lines:?}");
    let let_go: Vec<&Value> = lines
        .iter()
        .filter(|l| l["event"] == "graph_unclaimed")
        .collect();
    assert_eq!(let_go.len(), 1, "{lines:?}");
    assert_eq!(let_go[0]["graph_id"], flight.graph_id.as_str());
    assert_eq!(let_go[0]["reason"], "no_executor_claim");
    assert_eq!(let_go[0]["let_go"], 1);
    assert_eq!(let_go[0]["hold_seconds"], 3600);
    let held: Vec<&Value> = lines
        .iter()
        .filter(|l| l["event"] == "graph_admission_held")
        .collect();
    assert_eq!(held.len(), 1, "once, however many polls hold it: {lines:?}");
    assert_eq!(held[0]["reason"], "graph_unclaimed");
    assert_eq!(held[0]["let_go"], 1);
    assert_eq!(held[0]["graph_ids"], serde_json::json!([flight.graph_id]));
    assert!(
        held[0]["resume_seconds"]
            .as_i64()
            .is_some_and(|n| (3500..=3600).contains(&n)),
        "{}",
        held[0]
    );
    assert!(!lines.iter().any(|l| l["event"] == "graph_admitted"));
}

/// Replace the disposable database's publication function: its first `fail`
/// calls refuse with a serialization failure before anything commits; the
/// rest run the original. `publish_calls` counts the calls.
fn publication_fails_first(f: &Fixture, fail: i64) {
    f.superuser().batch_execute(&format!("CREATE SEQUENCE publish_calls; ALTER FUNCTION pd_graph_publish(text,uuid,uuid,bigint) RENAME TO publish_original;
        CREATE FUNCTION pd_graph_publish(text,uuid,uuid,bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN IF nextval('publish_calls')<={fail} THEN RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END IF;
        RETURN publish_original($1,$2,$3,$4); END $$;
        GRANT EXECUTE ON FUNCTION pd_graph_publish(text,uuid,uuid,bigint) TO polis_queue_executor;")).unwrap();
}

fn publication_restored(f: &Fixture) {
    f.superuser()
        .batch_execute(
            "DROP FUNCTION pd_graph_publish(text,uuid,uuid,bigint);
             ALTER FUNCTION publish_original(text,uuid,uuid,bigint) RENAME TO pd_graph_publish;",
        )
        .unwrap();
}

fn publish_calls(f: &Fixture) -> i64 {
    f.superuser()
        .query_one(
            "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM publish_calls",
            &[],
        )
        .unwrap()
        .get(0)
}

#[test]
fn a_transient_publication_failure_keeps_the_flight_and_is_retried_on_later_polls() {
    let f = Fixture::new();
    f.quiet(1021, 25, 1);
    graph_catalog(&f);
    let cfg = graph_config(&f, &[("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1021")]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    finish_graph(&f, &flight);
    publication_fails_first(&f, 2);
    for attempt in 1..=2i64 {
        s.cycle().unwrap();
        assert_eq!(
            publish_calls(&f),
            attempt,
            "one publication attempt per poll"
        );
        let kept = s.state.graph_flight.clone().expect("the flight is kept");
        assert_eq!(kept.graph_id, flight.graph_id);
        assert_eq!(
            serde_json::to_value(&kept).unwrap()["publish_attempts"],
            attempt,
            "the count is carried in the flight"
        );
        assert_eq!((s.state.totals.succeeded, s.state.totals.failed), (0, 0));
        // And it is carried across a restart of the scheduler.
        s.state.save(&cfg.state_path).unwrap();
        s = Scheduler::new(&cfg).unwrap();
    }
    s.cycle().unwrap();
    assert_eq!(publish_calls(&f), 3);
    assert!(s.state.graph_flight.is_none());
    assert_eq!((s.state.totals.succeeded, s.state.totals.failed), (1, 0));
    assert_eq!(served(&f, &flight)["generation"], 1);
}

#[test]
fn a_publication_that_keeps_failing_is_counted_once_and_its_snapshot_is_not_remembered_as_seen() {
    let f = Fixture::new();
    f.quiet(1031, 25, 1);
    f.quiet(1032, 25, 1);
    graph_catalog(&f);
    let list = ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1031");
    let benchmark = ("DELPHI_SHADOW_BENCHMARK", "c1032");
    let cfg = graph_config(&f, &[list, benchmark]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    finish_graph(&f, &flight);
    publication_fails_first(&f, 1_000_000);
    for _ in 0..3 {
        s.cycle().unwrap();
    }
    assert_eq!(publish_calls(&f), 3, "three attempts, one per poll");
    assert!(s.state.graph_flight.is_none());
    assert_eq!((s.state.totals.succeeded, s.state.totals.failed), (0, 1));
    assert!(!s.state.graph_seen.contains_key(&1031));
    // Given up, the graph is not taken up again: no further attempt, no
    // second failure, and the full pipeline goes on.
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert_eq!(publish_calls(&f), 3);
    assert_eq!(s.state.totals.failed, 1);
    let run = s.state.in_flight.clone().unwrap();
    assert_eq!(run.zid, 1032);
    assert!(
        !s.state.graph_seen.contains_key(&1031),
        "nor remembered again from the database"
    );
    f.cancel(&run.job_id);
    s.cycle().unwrap();
    assert!(s.state.in_flight.is_none());
    // The next build reconsiders the conversation. Its snapshot is unchanged
    // and was never published, so the same graph is taken up again and
    // published, with nothing computed twice.
    publication_restored(&f);
    s.state.save(&cfg.state_path).unwrap();
    drop(s);
    let next = graph_config(
        &f,
        &[
            list,
            benchmark,
            (
                "DELPHI_SHADOW_CODE_VERSION",
                "fedcba9876543210fedcba9876543210fedcba98",
            ),
        ],
    );
    let mut s = Scheduler::new(&next).unwrap();
    s.rest_until_ms = 0;
    s.cycle().unwrap();
    assert_eq!(
        s.state.graph_flight.as_ref().map(|g| g.graph_id.clone()),
        Some(flight.graph_id.clone())
    );
    assert!(
        !s.state.graph_unpublished.contains(&flight.graph_id),
        "taken up again, it is off the given-up list"
    );
    s.cycle().unwrap();
    assert!(s.state.graph_flight.is_none());
    assert_eq!(s.state.totals.succeeded, 1);
    assert_eq!(served(&f, &flight)["generation"], 1);
    // Its nodes ran once: the same four jobs, one attempt each.
    let attempts: i64 = f
        .superuser()
        .query_one(
            "SELECT count(*) FROM polis_queue_attempts a JOIN delphi_graph_nodes n USING(env,job_id) WHERE n.env=$1 AND n.graph_id=$2::text::uuid",
            &[&flight.env, &flight.graph_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(attempts, 4, "nothing computed twice");
    assert_eq!(graphs_of(&f, &flight.env, 1031), 1, "no second graph");
}

/// How many graphs a conversation has in an env.
fn graphs_of(f: &Fixture, env: &str, zid: i32) -> i64 {
    f.superuser()
        .query_one(
            "SELECT count(*) FROM delphi_graphs WHERE env=$1 AND zid=$2",
            &[&env, &zid],
        )
        .unwrap()
        .get(0)
}

/// The scheduler as its container runs it, until `done` holds of its
/// `delphi_shadow/1` lines so far (or `ceiling` passes), then stopped as a
/// deploy stops it (SIGTERM): its lines. Reading the lines as they come,
/// rather than sleeping a fixed time, keeps a loaded machine's slower polls
/// from deciding the result.
fn scheduler_lines(
    f: &Fixture,
    extra: &[(&str, &str)],
    done: impl Fn(&[Value]) -> bool,
    ceiling: Duration,
) -> Vec<Value> {
    use std::io::BufRead;
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_polis-delphi-shadow"));
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(f.environment(extra))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = c.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (send, recv) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let parsed = line
                .strip_prefix("delphi_shadow/1 ")
                .and_then(|l| serde_json::from_str::<Value>(l).ok());
            if let Some(v) = parsed
                && send.send(v).is_err()
            {
                break;
            }
        }
    });
    let start = Instant::now();
    let mut lines = Vec::new();
    while !done(&lines) && start.elapsed() < ceiling {
        if let Ok(v) = recv.recv_timeout(Duration::from_millis(200)) {
            lines.push(v);
        }
    }
    // SAFETY: a signal to the child this test started.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    child.wait().unwrap();
    reader.join().unwrap();
    lines.extend(recv.try_iter());
    lines
}

fn polls(lines: &[Value]) -> usize {
    lines.iter().filter(|l| l["event"] == "idle").count()
}

#[test]
fn a_held_graph_admission_says_so_once_with_its_reason() {
    let f = Fixture::new();
    f.quiet(1041, 25, 1);
    f.quiet(1042, 25, 1);
    graph_catalog(&f);
    let list = ("DELPHI_SHADOW_GRAPH_CONVERSATIONS", "c1041,c1042");
    let mut cfg = graph_config(&f, &[list]);
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    let flight = s.state.graph_flight.clone().unwrap();
    assert_eq!(flight.zid, 1041);
    // An attempt with no exit proof, as a lost journal leaves it: past the
    // job deadline the graph is deferred, and graph admission is held.
    let (owner, attempt) = (Uuid::new_v4().to_string(), Uuid::new_v4().to_string());
    let claim: Value = f.superuser().query_one("SELECT pd_graph_claim($1,1::smallint,$2::text::uuid,$3::text::uuid,60,'delphi','graph_embed')", &[&flight.env, &owner, &attempt]).unwrap().get(0);
    assert_eq!(claim["outcome"], "owned");
    s.state.save(&cfg.state_path).unwrap();
    drop(s);
    cfg.job_deadline = Duration::ZERO;
    let mut s = Scheduler::new(&cfg).unwrap();
    s.cycle().unwrap();
    assert_eq!(s.state.graph_deferred.len(), 1);
    s.state.save(&cfg.state_path).unwrap();
    drop(s);
    let app = f.dir.display().to_string();
    let python = std::env::var("POLIS_JOBS_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
    let lines = scheduler_lines(
        &f,
        &[
            list,
            ("DELPHI_SHADOW_POLL_SECONDS", "1"),
            ("DELPHI_APP_PATH", &app),
            ("POLIS_JOBS_PYTHON", &python),
        ],
        |lines| polls(lines) >= 3,
        Duration::from_secs(60),
    );
    assert!(polls(&lines) >= 3, "{lines:?}");
    let held: Vec<&Value> = lines
        .iter()
        .filter(|l| l["event"] == "graph_admission_held")
        .collect();
    assert_eq!(held.len(), 1, "once, however many polls hold it: {lines:?}");
    assert_eq!(held[0]["reason"], "graph_deferred");
    assert_eq!(held[0]["graph_ids"], serde_json::json!([flight.graph_id]));
    assert_eq!(held[0]["deferred"], 1);
    assert!(!lines.iter().any(|l| l["event"] == "graph_admitted"));
}
