//! `polis-delphi-shadow` against a throwaway PostgreSQL 17 holding the
//! release migration chain: what it admits, under which env, one at a time,
//! and that its two sessions never make the participation path wait.
//! Run with `--features jobs-integration` and `POLIS_JOBS_TEST_DATABASE_URL`
//! (a superuser DSN on a loopback port), as `tests/jobs_integration.rs`.
#![cfg(feature = "jobs-integration")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use polis_queue_adapter::shadow::{config, db, plan, scheduler::Scheduler};
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
        match config::load(|k| m.get(k).cloned()).unwrap() {
            config::Load::Ready(c) => *c,
            config::Load::Disabled => panic!("disabled"),
        }
    }

    /// A conversation with `n` comments, its math row and one vote (a pass,
    /// 0: the same value in every sign convention, as jobs_integration.rs
    /// seeds its vote) so the math engine reads as caught up.
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
    let cfg = f.config(&[]);
    let mut part = f.superuser();

    // 1. The read session, held open across the participation statements: its
    // snapshot and ACCESS SHARE locks block none of them.
    let mut read = Client::connect(&cfg.read_dsn, NoTls).unwrap();
    let slow_read = db::read_only(&mut read, 30_000, |tx| {
        db::live(tx, 0)?;
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
    let a = plan::admission(201, &"ab".repeat(32), 30, None);
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
    // never more than one connection per login, none left open after.
    let stop = Arc::new(AtomicBool::new(false));
    let most = Arc::new(AtomicUsize::new(0));
    let sampler = {
        let (stop, most, dsn) = (stop.clone(), most.clone(), url_for(&f.name, "postgres"));
        std::thread::spawn(move || {
            let mut c = Client::connect(&dsn, NoTls).unwrap();
            while !stop.load(Ordering::SeqCst) {
                let n: i64 = c
                    .query_one(
                        "SELECT count(*) FROM pg_stat_activity WHERE application_name = ANY($1)",
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
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = ANY($1)",
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
    assert_eq!(
        record["config_effective"]["shadow"]["comment_set_sha256"],
        first.digest.as_str()
    );
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
