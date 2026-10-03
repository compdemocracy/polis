//! `polis-jobs` against a throwaway PostgreSQL 17 holding the full migration
//! chain (000000–000022 from the repository) plus the vendored draft 000023
//! (`tests/fixtures/migrations`). Run with `--features jobs-integration` and
//! `POLIS_JOBS_TEST_DATABASE_URL` (a superuser DSN on a loopback port); see
//! the README. Each test copies a template database, runs real daemon
//! processes and the generated fixture child, and inspects committed state.
#![cfg(feature = "jobs-integration")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use postgres::{Client, NoTls};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::net::UnixListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;

const ENV: &str = "test";
const LOGIN: &str = "polis_jobs_test";
static TEMPLATE: Mutex<bool> = Mutex::new(false);

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

fn port() -> String {
    let base = admin_url();
    let rest = base.split_once('@').map(|x| x.1).unwrap();
    rest.split('/')
        .next()
        .unwrap()
        .rsplit(':')
        .next()
        .unwrap()
        .to_owned()
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn sha_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn exists(admin: &mut Client, db: &str) -> bool {
    admin
        .query_opt("SELECT 1 FROM pg_database WHERE datname=$1", &[&db])
        .unwrap()
        .is_some()
}

/// Build `jobs_base` (chain to 000022) and `jobs_v2` (+ draft 000023) once.
fn ensure_templates() {
    let mut done = TEMPLATE.lock().unwrap();
    if *done {
        return;
    }
    let mut admin = Client::connect(&admin_url(), NoTls).unwrap();
    if !exists(&mut admin, "jobs_v2") {
        for db in ["jobs_v2", "jobs_base"] {
            admin
                .batch_execute(&format!("DROP DATABASE IF EXISTS {db}"))
                .unwrap();
        }
        admin.batch_execute("CREATE DATABASE jobs_base").unwrap();
        let mut base = Client::connect(&url_for("jobs_base", "postgres"), NoTls).unwrap();
        let dir = root().join("../server/postgres/migrations");
        let mut chain: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| e == "sql")
                    && p.file_name().unwrap().to_string_lossy().as_bytes()[0].is_ascii_digit()
            })
            .collect();
        chain.sort();
        let numbers: Vec<u32> = chain
            .iter()
            .map(|p| {
                p.file_name().unwrap().to_string_lossy()[..6]
                    .parse()
                    .unwrap()
            })
            .collect();
        let expected: Vec<u32> = (0..23).filter(|n| *n != 20).collect();
        assert_eq!(numbers, expected, "complete 000000-000022 chain required");
        for m in &chain {
            base.batch_execute(&fs::read_to_string(m).unwrap()).unwrap();
        }
        base.batch_execute(
            "INSERT INTO conversations(zid,topic) VALUES(1,'fixture'),(2,'fixture two');",
        )
        .unwrap();
        drop(base);
        admin
            .batch_execute(&format!(
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{LOGIN}') THEN
               CREATE ROLE {LOGIN} LOGIN IN ROLE polis_queue_executor; END IF; END $$;"
            ))
            .unwrap();
        admin
            .batch_execute("CREATE DATABASE jobs_v2 TEMPLATE jobs_base")
            .unwrap();
        let mut v2 = Client::connect(&url_for("jobs_v2", "postgres"), NoTls).unwrap();
        v2.batch_execute(
            &fs::read_to_string(
                root().join("tests/fixtures/migrations/000023_create_delphi_foundation.sql"),
            )
            .unwrap(),
        )
        .unwrap();
    }
    *done = true;
}

struct Db {
    name: String,
    sql: Client,
    scratch: PathBuf,
}

impl Db {
    fn new(template: &str) -> Self {
        ensure_templates();
        let name = format!("t_{}", Uuid::new_v4().simple());
        {
            let _guard = TEMPLATE.lock().unwrap();
            let mut admin = Client::connect(&admin_url(), NoTls).unwrap();
            let mut tries = 0;
            // The template's last session may still be closing on the server.
            while let Err(e) =
                admin.batch_execute(&format!("CREATE DATABASE {name} TEMPLATE {template}"))
            {
                tries += 1;
                assert!(tries < 100, "{e}");
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let sql = Client::connect(&url_for(&name, "postgres"), NoTls).unwrap();
        let scratch = std::env::temp_dir().join(format!("polis-jobs-it-{name}"));
        fs::create_dir_all(&scratch).unwrap();
        Db { name, sql, scratch }
    }

    fn executor(&self) -> Client {
        Client::connect(&url_for(&self.name, LOGIN), NoTls).unwrap()
    }

    /// Enqueue through the one admission RPC, as the executor login.
    fn enqueue(
        &self,
        stage: &str,
        zid: i32,
        report: Option<&str>,
        config: Value,
        max_attempts: i32,
    ) -> (Uuid, String) {
        let job = Uuid::new_v4();
        let run = Uuid::new_v4();
        let admission =
            json!({"schema":"polis-jobs.admission/1","zid":zid,"report_id":report,"config":config});
        let bytes = serde_json::to_vec(&admission).unwrap();
        let uri = polis_queue_adapter::jobs::child::encode_admission(&bytes);
        let scope = format!("scope-{stage}-{zid}-{}", report.unwrap_or("-"));
        let product = match stage {
            "delphi_narrative" => format!("delphi:narrative:{}", report.unwrap()),
            _ => format!("delphi:full:{zid}:{}", report.unwrap_or("")),
        };
        let mut ex = self.executor();
        let mut tx = ex.transaction().unwrap();
        let reply: Value = tx
            .query_one(
                "SELECT pd_enqueue($1,$2,$3,'fixture-actor',$4,repeat('a',64),$5,$6,$7,$8,repeat('c',64),'fixture-image',0::smallint,$9,$10,$11,$12,$13)",
                &[&ENV, &zid, &product, &job.to_string(), &run, &job, &uri, &sha_hex(&bytes), &max_attempts, &stage, &report, &scope, &json!({})],
            )
            .unwrap()
            .get(0);
        tx.commit().unwrap();
        assert_eq!(reply["outcome"], "enqueued", "{reply}");
        (job, scope)
    }

    fn job(&mut self, job: Uuid) -> (String, i32, Option<String>) {
        let r = self
            .sql
            .query_one(
                "SELECT state,attempt_count,last_error_code FROM polis_queue_jobs WHERE env=$1 AND job_id=$2",
                &[&ENV, &job],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2))
    }

    /// (attempt_id, owner_id, lease_epoch, outcome, error_code, exit confirmed)
    fn attempts(&mut self, job: Uuid) -> Vec<(Uuid, Uuid, i64, String, Option<String>, bool)> {
        self.sql
            .query(
                "SELECT attempt_id,owner_id,lease_epoch,outcome,error_code,process_exit_confirmed_at IS NOT NULL
                 FROM polis_queue_attempts WHERE env=$1 AND job_id=$2 ORDER BY lease_epoch",
                &[&ENV, &job],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5)))
            .collect()
    }

    fn wait<F: FnMut(&mut Db) -> bool>(&mut self, what: &str, secs: u64, mut f: F) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if f(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!(
            "timed out waiting for {what}; scratch {}",
            self.scratch.display()
        );
    }

    fn wait_state(&mut self, job: Uuid, state: &str, secs: u64) {
        self.wait(&format!("state {state}"), secs, |d| d.job(job).0 == state);
    }

    fn release(&self, scope: &str) -> bool {
        let mut ex = self.executor();
        let mut tx = ex.transaction().unwrap();
        let ok: bool = tx
            .query_one("SELECT pd_release_scope($1,$2)", &[&ENV, &scope])
            .unwrap()
            .get(0);
        tx.commit().unwrap();
        ok
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.scratch);
        if let Ok(mut admin) = Client::connect(&admin_url(), NoTls) {
            let _ = admin.batch_execute(&format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                self.name
            ));
        }
    }
}

struct Daemon {
    child: Child,
    stderr: PathBuf,
    journal: PathBuf,
}

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_polis-jobs")
}

fn fixture_app() -> PathBuf {
    root().join("tests/fixtures/fake_delphi")
}

fn python() -> String {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| std::env::var("POLIS_JOBS_TEST_PYTHON").unwrap_or_else(|_| "python3".into()))
        .clone()
}

#[derive(Clone)]
struct Opts {
    name: &'static str,
    mode: &'static str,
    boot: String,
    journal: Option<PathBuf>,
    extra: Vec<(String, String)>,
}

impl Opts {
    fn new(name: &'static str, mode: &'static str) -> Self {
        Opts {
            name,
            mode,
            boot: format!("boot-{name}"),
            journal: None,
            extra: vec![],
        }
    }
    fn set(mut self, k: &str, v: impl Into<String>) -> Self {
        self.extra.push((k.into(), v.into()));
        self
    }
}

fn base_env(db: &Db, o: &Opts, journal: &Path) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = [
        ("POLIS_JOBS_ENABLED", "1".to_owned()),
        ("QUEUE_DATABASE_URL", url_for(&db.name, LOGIN)),
        ("QUEUE_ENV", ENV.into()),
        ("POLIS_JOBS_TRANSPORT", "loopback".into()),
        ("POLIS_JOBS_LEASE_SECONDS", "10".into()),
        ("POLIS_JOBS_HEARTBEAT_SECONDS", "2".into()),
        ("POLIS_JOBS_POLL_SECONDS", "1".into()),
        ("POLIS_JOBS_REAP_SECONDS", "1".into()),
        ("POLIS_JOBS_READINESS_SECONDS", "1".into()),
        ("POLIS_JOBS_KILL_GRACE_SECONDS", "2".into()),
        ("POLIS_JOBS_SHUTDOWN_GRACE_SECONDS", "3".into()),
        ("POLIS_JOBS_LOG_BATCH_MS", "200".into()),
        ("POLIS_JOBS_JOURNAL_DIR", journal.display().to_string()),
        (
            "POLIS_JOBS_WORK_DIR",
            db.scratch.join("work").display().to_string(),
        ),
        ("POLIS_JOBS_BOOT_ID", o.boot.clone()),
        ("POLIS_JOBS_CONTAINER_ID", "fixture-host".into()),
        ("POLIS_JOBS_IDENTITY", o.name.into()),
        ("DELPHI_APP_PATH", fixture_app().display().to_string()),
        ("POLIS_JOBS_PYTHON", python()),
        ("FAKE_DELPHI_MODE", o.mode.into()),
        (
            "FAKE_DELPHI_RUNS",
            db.scratch.join("runs.txt").display().to_string(),
        ),
        (
            "FAKE_DELPHI_PIDS",
            db.scratch
                .join(format!("pids-{}.txt", o.name))
                .display()
                .to_string(),
        ),
        ("ANTHROPIC_MODEL", "fixture-model".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    v.extend(o.extra.iter().cloned());
    v
}

fn start(db: &Db, o: Opts) -> Daemon {
    let journal = o
        .journal
        .clone()
        .unwrap_or_else(|| db.scratch.join(format!("journal-{}", o.name)));
    let stderr = db
        .scratch
        .join(format!("stderr-{}-{}.log", o.name, Uuid::new_v4().simple()));
    let mut cmd = Command::new(bin());
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(base_env(db, &o, &journal))
        .stdout(Stdio::null())
        .stderr(fs::File::create(&stderr).unwrap());
    Daemon {
        child: cmd.spawn().unwrap(),
        stderr,
        journal,
    }
}

impl Daemon {
    fn log(&self) -> String {
        fs::read_to_string(&self.stderr).unwrap_or_default()
    }
    fn transitions(&self) -> Vec<Value> {
        self.log()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["schema"] == "polis_jobs.transition/1")
            .collect()
    }
    fn signal(&self, sig: i32) {
        unsafe {
            libc::kill(self.child.id() as i32, sig);
        }
    }
    fn wait_exit(&mut self, secs: u64) -> Option<i32> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if let Ok(Some(s)) = self.child.try_wait() {
                return s.code();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }
    fn stop(mut self) -> Option<i32> {
        self.signal(libc::SIGTERM);
        let code = self.wait_exit(20);
        if code.is_none() {
            let _ = self.child.kill();
        }
        code
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn group_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn pids(db: &Db, name: &str) -> Vec<i32> {
    fs::read_to_string(db.scratch.join(format!("pids-{name}.txt")))
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .filter(|p| *p > 0)
        .collect()
}

fn runs(db: &Db) -> Vec<String> {
    fs::read_to_string(db.scratch.join("runs.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn kill_tree(child_pid: i32) {
    // Stands in for the namespace teardown that kills a PID-1 daemon's children.
    unsafe {
        libc::kill(-child_pid, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && unsafe { libc::kill(-child_pid, 0) } == 0 {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Journal entries (the `.lock` file and temp files are not entries).
fn journal_entries(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .count()
        })
        .unwrap_or(0)
}

fn full() -> Value {
    json!({"include_moderation": false})
}

// ---------------------------------------------------------------------------

#[test]
fn happy_path_claims_heartbeats_and_finalizes_with_the_manifest_row() {
    let mut db = Db::new("jobs_v2");
    let (job, scope) = db.enqueue("delphi_full_pipeline", 1, Some("r1"), full(), 3);
    let d = start(
        &db,
        Opts::new("happy", "success")
            .set("FAKE_DELPHI_LONG", "1")
            .set("POLIS_JOBS_LOG_MAX_LINES", "13"),
    );
    db.wait_state(job, "succeeded", 60);
    let a = db.attempts(job);
    assert_eq!(a.len(), 1);
    assert!(a[0].5, "exit proof recorded");
    let attempt = a[0].0;
    let rows = db
        .sql
        .query(
            "SELECT seq,stream,line,octet_length(line) FROM polis_queue_logs WHERE env=$1 AND attempt_id=$2 ORDER BY seq",
            &[&ENV, &attempt],
        )
        .unwrap();
    let streams: Vec<String> = rows.iter().map(|r| r.get(1)).collect();
    let lines: Vec<String> = rows.iter().map(|r| r.get(2)).collect();
    assert!(lines.iter().any(|l| *l == format!("DELPHI_JOB_ID={job}")));
    assert!(lines.iter().any(|l| l == "queue_dsn_visible=False"));
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("argv=--zid=1 ") && l.contains("--rid=r1"))
    );
    assert_eq!(streams.iter().filter(|s| *s == "truncated").count(), 1);
    assert_eq!(streams.iter().filter(|s| *s == "manifest").count(), 1);
    assert!(rows.iter().all(|r| r.get::<_, i32>(3) <= 1_048_576));
    assert!(
        rows.iter().any(|r| r.get::<_, i32>(3) == 1_048_576),
        "long line split at 1 MiB"
    );
    let manifest: String = rows
        .iter()
        .find(|r| r.get::<_, String>(1) == "manifest")
        .unwrap()
        .get(2);
    let digest: Vec<u8> = db
        .sql
        .query_one(
            "SELECT output_manifest_digest FROM delphi_jobs WHERE job_id=$1",
            &[&job],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        sha_hex(manifest.as_bytes()),
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    assert!(
        manifest.ends_with('\n'),
        "exact canonical bytes, not reserialized"
    );
    // Readiness and transition lines.
    std::thread::sleep(Duration::from_millis(1500));
    let log = d.log();
    let ready: Vec<_> = log
        .lines()
        .filter_map(polis_queue_adapter::jobs::readiness::parse_readiness)
        .collect();
    assert!(!ready.is_empty());
    assert_eq!(ready.last().unwrap().2["finalized_total"], 1);
    assert_eq!(ready.last().unwrap().2["contract"], "polis-queue/2");
    assert!(
        d.transitions()
            .iter()
            .any(|t| t["to"] == "succeeded" && t["job_id"] == job.to_string())
    );
    assert!(db.release(&scope), "terminal root with exit proof releases");
    let journal = d.journal.clone();
    assert_eq!(d.stop(), Some(0));
    db.wait("journal empty", 10, |_| journal_entries(&journal) == 0);
}

#[test]
fn finalize_refuses_without_exit_proof_or_manifest_row_and_cancel_needs_confirm() {
    let db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("r2"), full(), 3);
    let mut ex = db.executor();
    let owner = Uuid::new_v4();
    let attempt = Uuid::new_v4();
    let claim: Value = ex
        .query_one(
            "SELECT pq_claim($1,0::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner, &attempt],
        )
        .unwrap()
        .get(0);
    assert_eq!(claim["outcome"], "owned");
    let epoch: i64 = claim["lease_epoch"].as_str().unwrap().parse().unwrap();
    let sha = "f".repeat(64);
    let err = ex
        .query_one(
            "SELECT pq_finalize($1,$2,$3,$4,$5,'file:///m.json',$6)",
            &[&ENV, &job, &owner, &attempt, &epoch, &sha],
        )
        .unwrap_err();
    assert!(
        err.as_db_error()
            .unwrap()
            .message()
            .contains("process exit proof required")
    );
    let c: Value = ex
        .query_one(
            "SELECT pq_end_attempt($1,$2,$3,$4,$5,'confirm_exit',NULL,true)",
            &[&ENV, &job, &owner, &attempt, &epoch],
        )
        .unwrap()
        .get(0);
    assert_eq!(c["outcome"], "exit_confirmed");
    let f: Value = ex
        .query_one(
            "SELECT pq_finalize($1,$2,$3,$4,$5,'file:///m.json',$6)",
            &[&ENV, &job, &owner, &attempt, &epoch, &sha],
        )
        .unwrap()
        .get(0);
    assert_eq!(f["outcome"], "invalid_output", "no manifest row");

    // Cancel: the scope cannot be released until the original owner confirms exit.
    let (job2, scope2) = db.enqueue("delphi_full_pipeline", 2, Some("r3"), full(), 3);
    let owner2 = Uuid::new_v4();
    let attempt2 = Uuid::new_v4();
    let c2: Value = ex
        .query_one(
            "SELECT pq_claim($1,0::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner2, &attempt2],
        )
        .unwrap()
        .get(0);
    assert_eq!(c2["job_id"], job2.to_string());
    let epoch2: i64 = c2["lease_epoch"].as_str().unwrap().parse().unwrap();
    let mgmt: i64 = c2["mgmt_version"].as_str().unwrap().parse().unwrap();
    let cancelled: Value = ex
        .query_one("SELECT pq_cancel($1,$2,$3)", &[&ENV, &job2, &mgmt])
        .unwrap()
        .get(0);
    assert_eq!(cancelled["outcome"], "cancelled");
    assert!(!db.release(&scope2), "cancelled but exit unconfirmed");
    let view: Value = ex
        .query_one("SELECT pd_job_view($1,$2)", &[&ENV, &job2])
        .unwrap()
        .get(0);
    assert!(view["owner_id"].is_null());
    assert_eq!(view["last_attempt"]["owner_id"], owner2.to_string());
    assert_eq!(view["last_attempt"]["lease_epoch"], epoch2.to_string());
    let hb: Value = ex
        .query_one(
            "SELECT pq_heartbeat($1,$2,$3,$4,$5,60)",
            &[&ENV, &job2, &owner2, &attempt2, &epoch2],
        )
        .unwrap()
        .get(0);
    assert_eq!(hb["outcome"], "fenced");
    let c: Value = ex
        .query_one(
            "SELECT pq_end_attempt($1,$2,$3,$4,$5,'confirm_exit',NULL,true)",
            &[&ENV, &job2, &owner2, &attempt2, &epoch2],
        )
        .unwrap()
        .get(0);
    assert_eq!(c["outcome"], "exit_confirmed");
    assert!(
        db.release(&scope2),
        "released after the original owner's confirm_exit"
    );

    // Restart-journal semantics within the lease: pq_fail(..., true) → retry_wait.
    let (job3, _) = db.enqueue("delphi_full_pipeline", 1, Some("r4"), full(), 3);
    let owner3 = Uuid::new_v4();
    let attempt3 = Uuid::new_v4();
    let c3: Value = ex
        .query_one(
            "SELECT pq_claim($1,0::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner3, &attempt3],
        )
        .unwrap()
        .get(0);
    assert_eq!(c3["job_id"], job3.to_string());
    let epoch3: i64 = c3["lease_epoch"].as_str().unwrap().parse().unwrap();
    let r: Value = ex
        .query_one(
            "SELECT pq_fail($1,$2,$3,$4,$5,false,'daemon_restarted',true)",
            &[&ENV, &job3, &owner3, &attempt3, &epoch3],
        )
        .unwrap()
        .get(0);
    assert_eq!(r["outcome"], "retry_wait");
}

#[test]
fn cancel_fences_the_heartbeat_kills_the_group_and_confirms_exit() {
    let mut db = Db::new("jobs_v2");
    let (job, scope) = db.enqueue("delphi_full_pipeline", 1, Some("c1"), full(), 3);
    let d = start(&db, Opts::new("cancel", "sleep"));
    db.wait("child pids", 60, |d| pids(d, "cancel").len() == 2);
    let p = pids(&db, "cancel");
    let mgmt: Value = db
        .executor()
        .query_one("SELECT pq_job_status($1,$2)", &[&ENV, &job])
        .unwrap()
        .get(0);
    let mgmt: i64 = mgmt["mgmt_version"].as_str().unwrap().parse().unwrap();
    let r: Value = db
        .executor()
        .query_one("SELECT pq_cancel($1,$2,$3)", &[&ENV, &job, &mgmt])
        .unwrap()
        .get(0);
    assert_eq!(r["outcome"], "cancelled");
    let cancelled_at = Instant::now();
    db.wait("exit confirmed", 30, |d| d.attempts(job)[0].5);
    // heartbeat period 2 s + kill grace 2 s
    assert!(cancelled_at.elapsed() < Duration::from_secs(12));
    assert!(
        p.iter().all(|pid| !group_alive(*pid)),
        "child and grandchild gone"
    );
    assert_eq!(db.job(job).0, "cancelled");
    // The transition line follows the final RPC (after the heartbeat stops).
    let deadline = Instant::now() + Duration::from_secs(10);
    while !d
        .transitions()
        .iter()
        .any(|t| t["to"] == "exit_confirmed:cancelled" && t["reason"] == "cancelled")
    {
        assert!(Instant::now() < deadline, "{}", d.log());
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(db.release(&scope));
    assert_eq!(d.stop(), Some(0));
}

#[test]
fn stalled_daemon_is_parked_unconfirmed_then_fenced_confirms_and_the_retry_runs_once() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("s1"), full(), 3);
    let a = start(&db, Opts::new("stall-a", "sleep_first"));
    db.wait("child pids", 60, |d| pids(d, "stall-a").len() == 2);
    let child_pids = pids(&db, "stall-a");
    a.signal(libc::SIGSTOP);
    let b = start(&db, Opts::new("stall-b", "sleep_first"));
    db.wait("expiry parks exit_unconfirmed", 40, |d| {
        d.job(job).2.as_deref() == Some("exit_unconfirmed")
    });
    // B cannot claim while the attempt's exit is unconfirmed.
    std::thread::sleep(Duration::from_secs(4));
    let (state, count, _) = db.job(job);
    assert_eq!((state.as_str(), count), ("parked", 1));
    assert_eq!(db.attempts(job).len(), 1);
    a.signal(libc::SIGCONT);
    db.wait("stalled owner confirms", 40, |d| d.attempts(job)[0].5);
    assert!(child_pids.iter().all(|p| !group_alive(*p)));
    db.wait_state(job, "succeeded", 60);
    let att = db.attempts(job);
    assert_eq!(att.len(), 2);
    assert!(att[1].2 > att[0].2, "higher epoch");
    assert_eq!(att[1].3, "succeeded");
    assert_eq!(runs(&db).len(), 2);
    // The stalled owner's late finalize is fenced.
    let (attempt, owner, epoch) = (att[0].0, att[0].1, att[0].2);
    let late: Value = db
        .executor()
        .query_one(
            "SELECT pq_finalize($1,$2,$3,$4,$5,'file:///late.json',$6)",
            &[&ENV, &job, &owner, &attempt, &epoch, &"e".repeat(64)],
        )
        .unwrap()
        .get(0);
    assert_eq!(late["outcome"], "fenced");
    assert!(a.transitions().iter().any(|t| {
        t["to"]
            .as_str()
            .is_some_and(|s| s.starts_with("exit_confirmed"))
    }));
    assert!(b.log().contains("exit_unconfirmed"));
    let _ = (a.stop(), b.stop());
}

fn journal_restart(after_lease: bool) {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("j1"), full(), 3);
    let journal = db.scratch.join("journal-shared");
    let mut first = Opts::new("jr-a", "sleep");
    first.journal = Some(journal.clone());
    let a = start(&db, first);
    db.wait("child pids", 60, |d| pids(d, "jr-a").len() == 2);
    let leader = pids(&db, "jr-a")[0];
    assert_eq!(
        journal_entries(&journal),
        1,
        "journaled before the child ran"
    );
    a.signal(libc::SIGKILL);
    drop(a);
    kill_tree(leader);
    if after_lease {
        std::thread::sleep(Duration::from_secs(12));
    }
    let mut second = Opts::new("jr-b", "success");
    second.journal = Some(journal.clone());
    second.boot = "boot-after-restart".into();
    let b = start(&db, second);
    db.wait_state(job, "succeeded", 90);
    let att = db.attempts(job);
    assert_eq!(att.len(), 2);
    assert!(att[0].5, "the journaled attempt carries exit proof");
    let expected = if after_lease {
        "daemon_restarted:fenced"
    } else {
        "daemon_restarted:retry_wait"
    };
    assert!(
        b.transitions().iter().any(|t| t["reason"] == expected),
        "missing {expected}: {}",
        b.log()
    );
    // The entry is deleted once the final RPC has returned.
    db.wait("journal empty", 10, |_| journal_entries(&journal) == 0);
    let _ = b.stop();
}

#[test]
fn restart_journal_within_the_lease_gives_retry_wait() {
    journal_restart(false);
}

#[test]
fn restart_journal_after_the_lease_gives_fenced_with_proof() {
    journal_restart(true);
}

#[test]
fn poison_after_max_attempts() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("p1"), full(), 3);
    let d = start(&db, Opts::new("poison", "exit:1"));
    db.wait_state(job, "dead", 120);
    let (_, count, code) = db.job(job);
    assert_eq!(count, 3);
    assert_eq!(code.as_deref(), Some("stage_failed:1"));
    assert!(
        db.attempts(job)
            .iter()
            .all(|a| a.5 && a.4.as_deref() == Some("stage_failed:1"))
    );
    std::thread::sleep(Duration::from_secs(2));
    assert!(d.transitions().iter().any(|t| t["to"] == "poison"));
    assert_eq!(runs(&db).len(), 3, "a dead job is never claimed again");
    let _ = d.stop();
}

#[test]
fn manifest_missing_and_exit_codes_map_to_fail() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("m1"), full(), 1);
    let d = start(&db, Opts::new("nomanifest", "no_manifest"));
    db.wait_state(job, "dead", 60);
    assert_eq!(db.job(job).2.as_deref(), Some("manifest_invalid"));
    let _ = d.stop();
    let (job, _) = db.enqueue("delphi_full_pipeline", 2, Some("m2"), full(), 1);
    let d = start(&db, Opts::new("exit4", "exit:4"));
    db.wait_state(job, "dead", 60);
    assert_eq!(db.job(job).2.as_deref(), Some("stage_failed:math_export"));
    let _ = d.stop();
}

#[test]
fn sigterm_mid_job_interrupts_then_the_next_daemon_retries() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("t1"), full(), 3);
    let mut a = start(&db, Opts::new("term-a", "sleep"));
    db.wait("child pids", 60, |d| pids(d, "term-a").len() == 2);
    let p = pids(&db, "term-a");
    a.signal(libc::SIGTERM);
    assert_eq!(a.wait_exit(30), Some(0));
    assert!(p.iter().all(|pid| !group_alive(*pid)));
    let att = db.attempts(job);
    assert_eq!(att[0].4.as_deref(), Some("interrupted_by_shutdown"));
    assert!(att[0].5);
    assert_eq!(db.job(job).0, "retry_wait");
    assert_eq!(journal_entries(&a.journal), 0);
    let b = start(&db, Opts::new("term-b", "success"));
    db.wait_state(job, "succeeded", 60);
    assert_eq!(db.job(job).1, 2);
    let _ = b.stop();
}

#[test]
fn start_refusals_disabled_config_and_contract() {
    let db = Db::new("jobs_base");
    let run = |env: &[(&str, String)]| {
        let mut cmd = Command::new(bin());
        cmd.env_clear().stderr(Stdio::piped()).stdout(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut c = cmd.spawn().unwrap();
        let start = Instant::now();
        loop {
            if let Some(s) = c.try_wait().unwrap() {
                let mut err = String::new();
                c.stderr.take().unwrap().read_to_string(&mut err).unwrap();
                return (s.code(), err);
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "daemon did not exit"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let journal = db.scratch.join("j").display().to_string();
    // Disabled: exit 0 immediately whatever else is set.
    assert_eq!(run(&[("QUEUE_DATABASE_URL", "x".into())]).0, Some(0));
    assert_eq!(run(&[("POLIS_JOBS_ENABLED", "true".into())]).0, Some(0));
    let on = |extra: &[(&'static str, String)]| -> Vec<(&'static str, String)> {
        let mut v = vec![
            ("POLIS_JOBS_ENABLED", "1".to_owned()),
            ("QUEUE_ENV", ENV.to_owned()),
            ("POLIS_JOBS_JOURNAL_DIR", journal.clone()),
        ];
        v.extend(extra.iter().cloned());
        v
    };
    // A Unix socket without the explicit local setting is refused (tls default needs a CA).
    let (code, err) = run(&on(&[("QUEUE_DATABASE_URL", "host=/tmp user=x".into())]));
    assert_eq!(code, Some(2), "{err}");
    let (code, err) = run(&on(&[
        ("QUEUE_DATABASE_URL", "host=/tmp user=x".into()),
        ("POLIS_JOBS_TRANSPORT", "tls".into()),
        ("POLIS_JOBS_CA_FILE", "/nonexistent".into()),
        ("POLIS_JOBS_HOST_ALLOWLIST", "db".into()),
    ]));
    assert_eq!(code, Some(2), "{err}");
    // TLS is required for a non-loopback host.
    let (code, err) = run(&on(&[
        (
            "QUEUE_DATABASE_URL",
            "postgresql://x@10.0.0.5:5432/d".into(),
        ),
        ("POLIS_JOBS_TRANSPORT", "loopback".into()),
    ]));
    assert_eq!(code, Some(2), "{err}");
    // Heartbeat ≥ lease/3.
    let (code, _) = run(&on(&[
        ("QUEUE_DATABASE_URL", url_for(&db.name, LOGIN)),
        ("POLIS_JOBS_TRANSPORT", "loopback".into()),
        ("POLIS_JOBS_LEASE_SECONDS", "30".into()),
        ("POLIS_JOBS_HEARTBEAT_SECONDS", "10".into()),
    ]));
    assert_eq!(code, Some(2));
    // An unwritable journal refuses to start.
    let (code, _) = run(&[
        ("POLIS_JOBS_ENABLED", "1".into()),
        ("QUEUE_ENV", ENV.into()),
        ("QUEUE_DATABASE_URL", url_for(&db.name, LOGIN)),
        ("POLIS_JOBS_TRANSPORT", "loopback".into()),
        ("POLIS_JOBS_JOURNAL_DIR", "/proc/forbidden/journal".into()),
    ]);
    assert_eq!(code, Some(2));
    // 000019 without 000023: the contract is missing → exit 3.
    let (code, err) = run(&on(&[
        ("QUEUE_DATABASE_URL", url_for(&db.name, LOGIN)),
        ("POLIS_JOBS_TRANSPORT", "loopback".into()),
    ]));
    assert_eq!(code, Some(3), "{err}");
    assert!(err.contains("contract missing"));
}

#[test]
fn narrative_intent_commits_before_the_ack_and_release_waits_for_completion() {
    let mut db = Db::new("jobs_v2");
    let (job, scope) = db.enqueue(
        "delphi_narrative",
        1,
        Some("n1"),
        json!({"model": "fixture-model"}),
        3,
    );
    let mark = db.scratch.join("acked.mark");
    let d = start(
        &db,
        Opts::new("narr", "intent_submit")
            .set("FAKE_DELPHI_MARK", mark.display().to_string())
            .set("FAKE_DELPHI_HOLD", "3"),
    );
    db.wait("first attempt", 60, |d| !d.attempts(job).is_empty());
    let attempt = db.attempts(job)[0].0;
    let ack = db
        .scratch
        .join("work")
        .join(attempt.to_string())
        .join("provider_intent.ack");
    db.wait("ack file", 60, |_| ack.exists());
    // The ack exists only after the intent RPC committed: the row is visible now.
    let state: String = db
        .sql
        .query_one(
            "SELECT state FROM delphi_provider_requests WHERE job_id=$1",
            &[&job],
        )
        .unwrap()
        .get(0);
    assert_eq!(state, "intent");
    let ackv: Value = serde_json::from_slice(&fs::read(&ack).unwrap()).unwrap();
    assert_eq!(ackv["schema"], "polis-jobs.provider-intent-ack/1");
    let intent = fs::read(ack.with_file_name("provider_intent.json")).unwrap();
    assert_eq!(ackv["intent_sha256"], sha_hex(&intent));
    let rid: Uuid = ackv["request_id"].as_str().unwrap().parse().unwrap();
    let digest: Vec<u8> = db
        .sql
        .query_one(
            "SELECT request_digest FROM delphi_provider_requests WHERE request_id=$1",
            &[&rid],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        sha_hex(&intent)
    );
    assert!(!db.release(&scope), "open intent refuses release");
    db.wait("parked awaiting provider", 60, |d| {
        let j = d.job(job);
        j.0 == "parked" && j.2.as_deref() == Some("awaiting_provider")
    });
    let st: String = db
        .sql
        .query_one(
            "SELECT state FROM delphi_provider_requests WHERE request_id=$1",
            &[&rid],
        )
        .unwrap()
        .get(0);
    assert!(st == "submitted" || st == "completed");
    assert!(!db.release(&scope), "submitted request refuses release");
    db.wait_state(job, "succeeded", 90);
    let st: String = db
        .sql
        .query_one(
            "SELECT state FROM delphi_provider_requests WHERE request_id=$1",
            &[&rid],
        )
        .unwrap()
        .get(0);
    assert_eq!(st, "completed");
    let r = runs(&db);
    assert!(
        r.iter().any(|l| l.contains(" 801 submit "))
            && r.iter().any(|l| l.contains(" 803 recheck "))
    );
    assert_eq!(
        db.attempts(job).len(),
        2,
        "submit then recheck, same logical job"
    );
    assert!(db.release(&scope), "released after submitted → completed");
    let _ = d.stop();
}

#[test]
fn intent_acknowledged_then_crash_records_submission_unknown_and_parks() {
    let mut db = Db::new("jobs_v2");
    let (job, scope) = db.enqueue(
        "delphi_narrative",
        1,
        Some("n2"),
        json!({"model": "fixture-model"}),
        3,
    );
    let d = start(&db, Opts::new("crash", "intent_crash"));
    db.wait("parked provider_unresolved", 60, |d| {
        d.job(job).2.as_deref() == Some("provider_unresolved")
    });
    let st: String = db
        .sql
        .query_one(
            "SELECT state FROM delphi_provider_requests WHERE job_id=$1",
            &[&job],
        )
        .unwrap()
        .get(0);
    assert_eq!(st, "submission_unknown");
    assert_eq!(db.job(job).0, "parked");
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(db.attempts(job).len(), 1, "no blind resubmission");
    assert!(!db.release(&scope));
    let _ = d.stop();
}

#[test]
fn two_daemons_run_one_job_exactly_once() {
    let mut db = Db::new("jobs_v2");
    let a = start(&db, Opts::new("par-a", "sleep_then_success"));
    let b = start(&db, Opts::new("par-b", "sleep_then_success"));
    std::thread::sleep(Duration::from_secs(2));
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("x1"), full(), 3);
    db.wait_state(job, "succeeded", 60);
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(runs(&db).len(), 1);
    assert_eq!(db.attempts(job).len(), 1);
    let _ = (a.stop(), b.stop());
}

#[test]
fn killed_daemon_blocks_the_other_until_its_restart_confirms_then_retry_runs_once() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("k1"), full(), 3);
    let journal = db.scratch.join("journal-a");
    let mut oa = Opts::new("kill-a", "parity");
    oa.journal = Some(journal.clone());
    let a = start(&db, oa.clone());
    db.wait("a running", 60, |d| !pids(d, "kill-a").is_empty());
    let b = start(
        &db,
        Opts::new("kill-b", "parity").set("FAKE_DELPHI_SLEEP", "1"),
    );
    let leader = pids(&db, "kill-a")[0];
    // Let the first attempt's opening lines reach polis_queue_logs (batch interval).
    db.wait("first attempt logged", 20, |d| {
        d.sql
            .query_one(
                "SELECT count(*) FROM polis_queue_logs l JOIN polis_queue_attempts a USING (env,attempt_id) WHERE a.job_id=$1",
                &[&job],
            )
            .unwrap()
            .get::<_, i64>(0)
            > 0
    });
    a.signal(libc::SIGKILL);
    drop(a);
    kill_tree(leader);
    db.wait("parked unconfirmed", 40, |d| {
        d.job(job).2.as_deref() == Some("exit_unconfirmed")
    });
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(db.attempts(job).len(), 1, "the other daemon cannot claim");
    let mut restart = oa;
    restart.boot = "boot-kill-a-restarted".into();
    restart.name = "kill-a2";
    let a2 = start(&db, restart.set("FAKE_DELPHI_SLEEP", "1"));
    db.wait_state(job, "succeeded", 90);
    let att = db.attempts(job);
    assert_eq!(att.len(), 2);
    assert!(att[0].5);
    assert_eq!(runs(&db).len(), 2, "the retry ran once");
    let n: i64 = db
        .sql
        .query_one(
            "SELECT count(*) FROM delphi_provider_requests WHERE job_id=$1",
            &[&job],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 1, "exactly one provider intent");
    let st: String = db
        .sql
        .query_one(
            "SELECT state FROM delphi_provider_requests WHERE job_id=$1",
            &[&job],
        )
        .unwrap()
        .get(0);
    assert_eq!(st, "completed");
    let logged: i64 = db
        .sql
        .query_one(
            "SELECT count(DISTINCT attempt_id) FROM polis_queue_logs l JOIN polis_queue_attempts a USING (env,attempt_id) WHERE a.job_id=$1",
            &[&job],
        )
        .unwrap()
        .get(0);
    assert_eq!(logged, 2, "the logs show both attempts");
    let _ = (a2.stop(), b.stop());
}

/// Offline profile: Unix-socket transport, no network settings, no AWS
/// environment. Docker on macOS cannot share a socket, so a local relay
/// exposes the throwaway server's TCP port as `<dir>/.s.PGSQL.<port>`.
#[test]
fn offline_profile_over_a_unix_socket_finalizes() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("o1"), full(), 3);
    let sock_dir = PathBuf::from(format!(
        "/tmp/pj-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    fs::create_dir_all(&sock_dir).unwrap();
    let path = sock_dir.join(format!(".s.PGSQL.{}", port()));
    let listener = UnixListener::bind(&path).unwrap();
    let target = format!("127.0.0.1:{}", port());
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let Ok(tcp) = std::net::TcpStream::connect(&target) else {
                continue;
            };
            let (mut a_r, mut a_w) = (conn.try_clone().unwrap(), conn);
            let (mut b_r, mut b_w) = (tcp.try_clone().unwrap(), tcp);
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut a_r, &mut b_w);
                let _ = b_w.shutdown(std::net::Shutdown::Write);
            });
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut b_r, &mut a_w);
                let _ = a_w.flush();
            });
        }
    });
    let journal = db.scratch.join("journal-offline");
    let mut cmd = Command::new(bin());
    let stderr = db.scratch.join("offline.log");
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")
        .env("POLIS_JOBS_ENABLED", "1")
        .env("QUEUE_ENV", ENV)
        .env("POLIS_JOBS_TRANSPORT", "local")
        .env(
            "QUEUE_DATABASE_URL",
            format!(
                "host={} port={} user={LOGIN} dbname={}",
                sock_dir.display(),
                port(),
                db.name
            ),
        )
        .env("POLIS_JOBS_LEASE_SECONDS", "10")
        .env("POLIS_JOBS_HEARTBEAT_SECONDS", "2")
        .env("POLIS_JOBS_POLL_SECONDS", "1")
        .env("POLIS_JOBS_JOURNAL_DIR", journal.display().to_string())
        .env(
            "POLIS_JOBS_WORK_DIR",
            db.scratch.join("work").display().to_string(),
        )
        .env("DELPHI_APP_PATH", fixture_app().display().to_string())
        .env("POLIS_JOBS_PYTHON", python())
        .env("FAKE_DELPHI_MODE", "success")
        .stdout(Stdio::null())
        .stderr(fs::File::create(&stderr).unwrap());
    let child = cmd.spawn().unwrap();
    let mut d = Daemon {
        child,
        stderr,
        journal,
    };
    db.wait_state(job, "succeeded", 60);
    assert!(d.log().contains("transport=local"));
    assert!(!d.log().to_lowercase().contains("aws"));
    d.signal(libc::SIGTERM);
    assert_eq!(d.wait_exit(20), Some(0));
    let _ = fs::remove_dir_all(sock_dir);
}

#[test]
fn child_timeout_kills_the_group_and_fails_timeout() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("to1"), full(), 1);
    let d = start(
        &db,
        Opts::new("timeout", "sleep").set("POLIS_JOBS_CHILD_TIMEOUT_SECONDS", "3"),
    );
    db.wait_state(job, "dead", 60);
    let a = db.attempts(job);
    assert_eq!(a[0].4.as_deref(), Some("timeout"));
    assert!(a[0].5, "exit proof after the group was emptied");
    assert!(pids(&db, "timeout").iter().all(|p| !group_alive(*p)));
    assert!(
        !d.transitions().iter().any(|t| t["to"] == "poison"),
        "timeout is not poison"
    );
    let _ = d.stop();
}

#[test]
fn exit_6_and_a_malformed_recheck_after_end_the_attempt() {
    let mut db = Db::new("jobs_v2");
    let (job, _) = db.enqueue("delphi_full_pipeline", 1, Some("e6"), full(), 1);
    let d = start(&db, Opts::new("exit6", "exit:6"));
    db.wait_state(job, "dead", 60);
    assert_eq!(
        db.job(job).2.as_deref(),
        Some("provider_intent_unacknowledged")
    );
    assert!(!d.transitions().iter().any(|t| t["to"] == "poison"));
    let _ = d.stop();
    // A malformed recheck_after once panicked the job thread and left the
    // heartbeat renewing: now it is manifest_invalid and the lease is released.
    let (job, _) = db.enqueue("delphi_full_pipeline", 2, Some("br"), full(), 1);
    let d = start(&db, Opts::new("badrecheck", "bad_recheck"));
    db.wait_state(job, "dead", 60);
    assert_eq!(db.job(job).2.as_deref(), Some("manifest_invalid"));
    assert!(db.attempts(job)[0].5);
    let _ = d.stop();
}

#[test]
fn a_second_daemon_on_the_same_journal_refuses_to_start() {
    let db = Db::new("jobs_v2");
    let journal = db.scratch.join("journal-shared-lock");
    let mut first = Opts::new("lock-a", "success");
    first.journal = Some(journal.clone());
    let a = start(&db, first);
    std::thread::sleep(Duration::from_secs(2));
    let mut second = Opts::new("lock-b", "success");
    second.journal = Some(journal);
    second.boot = "boot-lock-a".into();
    let mut b = start(&db, second);
    assert_eq!(b.wait_exit(20), Some(2), "{}", b.log());
    assert!(b.log().contains("locked by another polis-jobs process"));
    assert_eq!(a.stop(), Some(0));
}
