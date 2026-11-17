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
    let a = plan::admission(201, &"ab".repeat(32), 30, Some(plan::Set::Current), None);
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
    assert_eq!(
        record["config_effective"]["shadow"]["comment_set_sha256"],
        first.digest.as_str()
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
