//! The worker of the derived stage (`delphi_derived`, worker class `derived`):
//! it claims one derived job, reads its source run's three stored families
//! through a checked reader, makes the run's topic map exactly as `from-run`
//! does, and stores only the map family in a result batch of the derived
//! job's own, through the queue's fenced put, seal, exit proof and finalize.
//!
//! What it can reach, by construction: this module and the daemon loop in
//! `polis-topic-map derived-worker` are Rust reading stored rows. They link no
//! embedding model, UMAP, EVoC, namer or pipeline, spawn no process, and the
//! only SQL they send is the queue's own functions (`pq_claim`,
//! `pq_heartbeat`, `pq_reap`, `pq_end_attempt`, `pq_fail`, `pq_finalize`,
//! `pd_result_put_family`, `pd_result_seal`) and the two stored-run readers
//! (`pd_run_record`, `pd_result_artifact_wire`). A source whose families
//! are missing, changed or unreadable ends the job; nothing is ever
//! recomputed in its place.
//!
//! The source's batch is never written: every put names the derived job's own
//! attempt as its batch, and the database refuses a put by any job other than
//! the batch's own (`pd_result_insert_family`, `result run binding`).
//!
//! It is off unless [`SWITCH`] is exactly `1`; without it the daemon claims
//! nothing. Admission has its own switch ([`crate::derived::SWITCH`]): with
//! admission off no derived job is made; with the worker off one that was made
//! waits queued, and no other daemon claims it (its class is `derived`).
use crate::derived::{Operation, SPEC_SCHEMA};
use crate::from_run;
use crate::stored::{self, Outcome, RunIdentity, Wires};
use polis_queue_adapter::jobs::journal::{self, Journal};
use polis_queue_adapter::jobs::lease::Heartbeat;
use polis_queue_adapter::jobs::rpc::Rpc;
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The worker's switch: only `1` is on.
pub const SWITCH: &str = "POLIS_JOBS_DERIVED_WORKER";
pub const CLASS: &str = "derived";
pub const STAGE: &str = "delphi_derived";

/// The bounds of one source read.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    /// Each statement of the read (`statement_timeout`).
    pub statement: Duration,
    /// Each lock wait (`lock_timeout`); the read takes ACCESS SHARE only.
    pub lock: Duration,
    /// The whole source read, including connection setup and transport.
    /// Expiry closes the source connection.
    pub deadline: Duration,
    /// The largest family accepted (the store's own cap is 64 MiB).
    pub family_bytes: usize,
    /// The three families together, and the source's own map when it has one.
    pub total_bytes: usize,
}

impl Default for Bounds {
    fn default() -> Self {
        Self {
            statement: Duration::from_secs(30),
            lock: Duration::from_secs(5),
            deadline: Duration::from_secs(120),
            family_bytes: 32 << 20,
            total_bytes: 64 << 20,
        }
    }
}

/// How an attempt ends when it does not store a map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fail {
    /// The source cannot be made into this job's map, now or later: the job
    /// ends dead with this one word, and is never retried.
    Permanent(&'static str),
    /// The database or the transport failed: a retry within the queue's
    /// attempt budget (`max_attempts` 3, then dead).
    Transient(String),
}

impl Fail {
    pub fn code(&self) -> &str {
        match self {
            Self::Permanent(w) => w,
            Self::Transient(_) => "derived_transient",
        }
    }
}

/// What the derived job's record says it reads (`config_effective.derived`).
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub key: String,
    pub job_id: String,
    pub run_id: String,
    pub batch_id: String,
    pub conversation_id: i64,
    pub scope: String,
    pub selection: Option<String>,
    /// `(family, artifact_id, batch_id, sha256)`, in [`stored::INPUTS`] order.
    pub families: Vec<(String, String, String, String)>,
}

/// The derived job's specification, as admission stored it, checked.
pub fn source_of(env: &str, job: &str, config: &Value) -> Result<Source, Fail> {
    let bad = Fail::Permanent("spec_invalid");
    let spec = &config["derived"];
    let s = |v: &Value| v.as_str().map(str::to_owned);
    if spec["schema"] != SPEC_SCHEMA
        || spec["operation"] != Operation::TopicMap.name()
        || !spec["version"]
            .as_u64()
            .is_some_and(|v| Operation::TopicMap.versions().contains(&(v as u32)))
        || spec["env"] != env
    {
        return Err(bad);
    }
    let key = s(&spec["key"]).ok_or(bad.clone())?;
    if config["result_scope"] != format!("derived:{key}").as_str() {
        return Err(bad);
    }
    let src = &spec["source"];
    let job_id = s(&src["job_id"]).ok_or(bad.clone())?;
    if job_id == job {
        return Err(bad);
    }
    let families = src["families"].as_array().ok_or(bad.clone())?;
    if families.len() != stored::INPUTS.len() {
        return Err(bad);
    }
    let mut out = Vec::new();
    for (f, name) in families.iter().zip(stored::INPUTS) {
        if f["family"] != name {
            return Err(bad);
        }
        out.push((
            name.to_owned(),
            s(&f["artifact_id"]).ok_or(bad.clone())?,
            s(&f["batch_id"]).ok_or(bad.clone())?,
            s(&f["sha256"]).ok_or(bad.clone())?,
        ));
    }
    Ok(Source {
        key,
        job_id,
        run_id: s(&src["run_id"]).ok_or(bad.clone())?,
        batch_id: s(&src["batch_id"]).ok_or(bad.clone())?,
        conversation_id: src["conversation_id"].as_i64().ok_or(bad.clone())?,
        scope: s(&src["scope"]).ok_or(bad.clone())?,
        selection: match &src["selection"] {
            Value::Null => None,
            Value::String(v) => Some(v.clone()),
            _ => return Err(bad),
        },
        families: out,
    })
}

/// The source as read: its identity (with its execution record) and the
/// three families' bytes, each checked against the source's record.
pub struct Read {
    pub run: RunIdentity,
    pub positions: String,
    pub assignments: String,
    pub names: String,
    /// Bytes received, all families together.
    pub bytes: usize,
}

fn transient(e: impl std::fmt::Display) -> Fail {
    Fail::Transient(e.to_string())
}

/// The checked stored-source reader. One read-only, repeatable-read
/// transaction on its own connection: the derived job's own record (for its
/// specification), the source's record, then each family's bytes. Every
/// family must be the one the specification names (artifact, batch, SHA-256),
/// the one the source's record names now, and its received bytes must hash
/// to that SHA-256. Bounded by `bounds`; the transaction holds no lock beyond
/// ACCESS SHARE and is closed before the map is made.
pub fn read_source(
    client: &mut postgres::Client,
    env: &str,
    job: &str,
    bounds: Bounds,
) -> Result<(Source, Read), Fail> {
    read_source_until(client, env, job, bounds, Instant::now() + bounds.deadline)
}

fn read_source_until(
    client: &mut postgres::Client,
    env: &str,
    job: &str,
    bounds: Bounds,
    deadline: Instant,
) -> Result<(Source, Read), Fail> {
    client.set_deadline(Some(deadline));
    client.set_io_timeout(Some(bounds.statement));
    let mut tx = client
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .map_err(transient)?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout='{}ms'; SET LOCAL lock_timeout='{}ms'; \
         SET LOCAL idle_in_transaction_session_timeout='{}ms'",
        bounds.statement.as_millis(),
        bounds.lock.as_millis(),
        bounds.deadline.as_millis()
    ))
    .map_err(transient)?;
    let record = |tx: &mut postgres::Transaction, id: &str| -> Result<Value, Fail> {
        let v: Option<Value> = tx
            .query_one("SELECT pd_run_record($1,$2::text::uuid)", &[&env, &id])
            .map_err(transient)?
            .get(0);
        Ok(v.unwrap_or(Value::Null))
    };
    let own = record(&mut tx, job)?;
    if own["job_id"] != job {
        return Err(Fail::Permanent("spec_invalid"));
    }
    let source = source_of(env, job, &own["config_effective"])?;
    let src_record = record(&mut tx, &source.job_id)?;
    if src_record.is_null() {
        return Err(Fail::Permanent("source_missing"));
    }
    let mut plan = from_run::plan(env, &source.job_id, &src_record).map_err(|_| {
        let state = src_record["state"].as_str().unwrap_or_default();
        Fail::Permanent(if state == "succeeded" {
            "source_incomplete"
        } else {
            "source_not_succeeded"
        })
    })?;
    // The source today is the source admission recorded.
    let same = plan.run.run_id == source.run_id
        && plan.run.batch_id == source.batch_id
        && plan.run.conversation_id == source.conversation_id
        && plan.run.scope == source.scope
        && plan.run.selection == source.selection
        && plan
            .inputs
            .iter()
            .zip(&source.families)
            .all(|(f, (_, a, b, h))| &f.artifact_id == a && &f.batch_id == b && &f.sha256 == h);
    if !same {
        return Err(Fail::Permanent("source_changed"));
    }
    let mut total = 0usize;
    let mut wire = |tx: &mut postgres::Transaction,
                    name: &str,
                    f: &from_run::FamilyRef|
     -> Result<String, Fail> {
        if Instant::now() >= deadline {
            return Err(Fail::Transient("source read deadline".into()));
        }
        let row = tx
            .query_one(
                "SELECT w->>'wire', w->>'batch_id', w->>'sha256' \
                 FROM (SELECT pd_result_artifact_wire($1,($2::text)::uuid,$3) AS w) s",
                &[&env, &f.artifact_id, &name],
            )
            .map_err(transient)?;
        let (text, batch, sha): (Option<String>, Option<String>, Option<String>) =
            (row.get(0), row.get(1), row.get(2));
        let text = text.ok_or(Fail::Permanent("source_missing"))?;
        if batch.as_deref() != Some(f.batch_id.as_str()) || sha.as_deref() != Some(&f.sha256) {
            return Err(Fail::Permanent("source_changed"));
        }
        if text.len() > bounds.family_bytes {
            return Err(Fail::Permanent("source_too_large"));
        }
        total += text.len();
        if total > bounds.total_bytes {
            return Err(Fail::Permanent("source_too_large"));
        }
        if hex(&Sha256::digest(text.as_bytes())) != f.sha256 {
            return Err(Fail::Permanent("source_digest"));
        }
        Ok(text)
    };
    let positions = wire(&mut tx, stored::POSITIONS, &plan.inputs[0])?;
    let assignments = wire(&mut tx, stored::ASSIGNMENTS, &plan.inputs[1])?;
    let names = wire(&mut tx, stored::NAMES, &plan.inputs[2])?;
    // As `from-run`: a source that stored its own map lends it its execution
    // record, so the document is the same bytes.
    let already = match &plan.stored {
        Some(f) => Some(wire(&mut tx, stored::FAMILY, f)?),
        None => None,
    };
    tx.commit().map_err(transient)?;
    if let Some(w) = &already {
        plan.run.execution = stored::stored_execution(w)
            .map_err(|_| Fail::Permanent("source_invalid"))?
            .unwrap_or_else(|| {
                stored::execution_unavailable("the run's stored map holds no execution record")
            });
    }
    Ok((
        source,
        Read {
            run: plan.run,
            positions,
            assignments,
            names,
            bytes: total,
        },
    ))
}

/// The map family of a derived job: the bytes `from-run` makes for the
/// source, with the derived job as the owner of the outer rows.
pub fn make(read: &Read, derived_job: &str) -> Result<stored::Stored, Fail> {
    stored::store_owned(
        &read.run,
        &Wires {
            positions: &read.positions,
            assignments: &read.assignments,
            names: &read.names,
        },
        derived_job,
    )
    .map_err(|_| Fail::Permanent("source_invalid"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The worker's settings.
pub struct Config {
    pub env: String,
    /// The queue login (`QUEUE_DATABASE_URL` and the daemon's transport rules).
    pub connector: Arc<Connector>,
    /// The source reader's own connection, same login, opened per job.
    pub reader: Box<dyn Fn(Instant) -> Result<postgres::Client, String> + Send + Sync>,
    pub journal_dir: std::path::PathBuf,
    pub boot_id: String,
    pub container_id: String,
    pub lease_seconds: u32,
    pub bounds: Bounds,
}

/// A step after which a test stops the attempt, as a crash would.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashAt {
    AfterPut,
    AfterSeal,
    BeforeFinalize,
    /// The finalize commits and its reply is lost: the worker asks again.
    LoseFinalizeReply,
}

/// What one pass did.
#[derive(Clone, Debug, PartialEq)]
pub enum Pass {
    Idle,
    /// The job succeeded: its batch holds the map, or a `no_map` row with its
    /// one-word reason (a terminal outcome, never retried).
    Stored {
        job_id: String,
        outcome: String,
        finalize: String,
    },
    Failed {
        job_id: String,
        code: String,
        state: String,
    },
    #[doc(hidden)]
    Crashed {
        job_id: String,
    },
}

pub struct Worker {
    pub cfg: Config,
    pub owner: String,
    rpc: Rpc,
    journal: Journal,
}

fn args(v: &[Value]) -> Vec<Value> {
    v.to_vec()
}

impl Worker {
    pub fn new(cfg: Config) -> Result<Self, String> {
        let journal = Journal::open(&cfg.journal_dir).map_err(|e| e.to_string())?;
        let rpc = Rpc::new(cfg.connector.clone(), &cfg.env);
        Ok(Self {
            owner: uuid::Uuid::new_v4().to_string(),
            cfg,
            rpc,
            journal,
        })
    }

    /// The existing daemon's restart rule: every journaled attempt of this
    /// env whose process is provably gone (another boot or container, or its
    /// pid dead) ends as a retry, `daemon_restarted`. An entry not provably
    /// gone is left; its job parks `exit_unconfirmed` at the reaper when its
    /// lease expires, for an operator.
    pub fn recover(&mut self) -> Vec<(String, String)> {
        let mut ended = vec![];
        for e in self.journal.entries() {
            if e.env != self.cfg.env
                || !journal::provably_gone(
                    &e,
                    &self.cfg.boot_id,
                    &self.cfg.container_id,
                    &self.owner,
                )
            {
                continue;
            }
            let reply = self.rpc.committed(
                "pq_fail",
                &args(&[
                    json!(e.env),
                    json!(e.job_id),
                    json!(e.owner_id),
                    json!(e.attempt_id),
                    json!(e.lease_epoch),
                    json!(false),
                    json!("daemon_restarted"),
                    json!(true),
                ]),
            );
            if let Ok(r) = reply {
                let _ = self.journal.remove(&e.attempt_id);
                ended.push((
                    e.job_id.clone(),
                    r["state"].as_str().unwrap_or_default().to_owned(),
                ));
            }
        }
        ended
    }

    /// One reaper pass over class `derived` (the daemon's own reaper).
    pub fn reap(&mut self) -> Result<usize, String> {
        let counters = polis_queue_adapter::jobs::readiness::Counters::default();
        polis_queue_adapter::jobs::reaper::Reaper::new(self.cfg.lease_seconds, Duration::ZERO)
            .tick(&mut self.rpc, CLASS, &self.owner, &counters)
            .map_err(|e| e.to_string())
    }

    /// Claim one derived job and run it to its end.
    pub fn pass(&mut self) -> Result<Pass, String> {
        self.pass_until(None)
    }

    #[doc(hidden)]
    pub fn pass_until(&mut self, crash: Option<CrashAt>) -> Result<Pass, String> {
        let attempt = uuid::Uuid::new_v4().to_string();
        let reply = self
            .rpc
            .committed(
                "pq_claim",
                &args(&[
                    json!(self.cfg.env),
                    json!(1),
                    json!(self.owner),
                    json!(attempt),
                    json!(self.cfg.lease_seconds),
                    json!(CLASS),
                ]),
            )
            .map_err(|e| e.to_string())?;
        if reply["outcome"] != "owned" {
            return Ok(Pass::Idle);
        }
        let text = |k: &str| reply[k].as_str().map(str::to_owned).unwrap_or_default();
        let (job, epoch) = (text("job_id"), text("lease_epoch"));
        if text("attempt_id") != attempt || text("stage") != STAGE {
            return Err("claim reply is not this worker's".into());
        }
        let id = vec![
            json!(self.cfg.env),
            json!(job),
            json!(self.owner),
            json!(attempt),
            json!(epoch),
        ];
        // Journaled before any work: this process is the only one that can
        // write for the attempt (no child), so its pid stands for the group.
        let pid = std::process::id();
        let entry = journal::Entry {
            schema: journal::SCHEMA.into(),
            env: self.cfg.env.clone(),
            owner_id: self.owner.clone(),
            job_id: job.clone(),
            attempt_id: attempt.clone(),
            lease_epoch: epoch.clone(),
            pgid: i32::try_from(pid).ok(),
            daemon_pid: pid,
            boot_id: self.cfg.boot_id.clone(),
            container_id: self.cfg.container_id.clone(),
        };
        if self.journal.write(&entry).is_err() {
            let mut a = id.clone();
            a.push(json!(true));
            let _ = self.rpc.committed("pq_release", &a);
            return Err("journal unwritable".into());
        }
        let heartbeat = Heartbeat::start(
            self.cfg.connector.clone(),
            self.cfg.env.clone(),
            job.clone(),
            self.owner.clone(),
            attempt.clone(),
            epoch.clone(),
            self.cfg.lease_seconds,
            Duration::from_secs(u64::from(self.cfg.lease_seconds / 4).max(1)),
        );
        let started = Instant::now();
        let result = self.attempt(&id, &job, &attempt, started, crash);
        heartbeat.stop();
        let pass = match result {
            Ok(p) => p,
            Err(fail) => {
                let mut a = id.clone();
                a.extend([
                    json!(matches!(fail, Fail::Permanent(_))),
                    json!(fail.code()),
                    json!(true),
                ]);
                let r = self
                    .rpc
                    .committed("pq_fail", &a)
                    .map_err(|e| e.to_string())?;
                log(&job, &attempt, "failed", fail.code(), &fail);
                Pass::Failed {
                    job_id: job.clone(),
                    code: fail.code().to_owned(),
                    state: r["state"].as_str().unwrap_or_default().to_owned(),
                }
            }
        };
        if !matches!(pass, Pass::Crashed { .. }) {
            let _ = self.journal.remove(&attempt);
        }
        Ok(pass)
    }

    fn attempt(
        &mut self,
        id: &[Value],
        job: &str,
        attempt: &str,
        started: Instant,
        crash: Option<CrashAt>,
    ) -> Result<Pass, Fail> {
        let deadline = Instant::now() + self.cfg.bounds.deadline;
        let mut reader = (self.cfg.reader)(deadline).map_err(Fail::Transient)?;
        let (source, read) =
            read_source_until(&mut reader, &self.cfg.env, job, self.cfg.bounds, deadline)?;
        drop(reader);
        let made = make(&read, job)?;
        let crashed = || Ok(Pass::Crashed { job_id: job.into() });
        let mut put = id.to_vec();
        put.extend([json!(stored::FAMILY), json!(made.wire)]);
        let receipt = self
            .rpc
            .committed("pd_result_put_family", &put)
            .map_err(transient)?;
        if receipt["sha256"] != hex(&Sha256::digest(made.wire.as_bytes())) {
            return Err(Fail::Transient("put receipt".into()));
        }
        if crash == Some(CrashAt::AfterPut) {
            return crashed();
        }
        let results = self
            .rpc
            .committed("pd_result_seal", id)
            .map_err(transient)?;
        if results["batch_id"] != attempt || results["families"] != json!([stored::FAMILY]) {
            return Err(Fail::Transient("seal receipt".into()));
        }
        if crash == Some(CrashAt::AfterSeal) {
            return crashed();
        }
        let conversation = read.run.conversation_id.to_string();
        let (outcome, parts): (String, Vec<&str>) = match &made.outcome {
            Outcome::Map { .. } => (
                "map".into(),
                vec![
                    stored::part::DOCUMENT,
                    stored::part::GZIP,
                    stored::part::EXECUTION,
                    stored::part::SHA256,
                ],
            ),
            Outcome::NoMap { reason, .. } => (
                reason.as_str().to_owned(),
                vec![stored::part::EXECUTION, stored::part::NO_MAP],
            ),
        };
        let manifest = serde_json::to_string(&json!({
            "schema": "polis-jobs.output-manifest/2",
            "job_id": job, "attempt_id": attempt, "stage": STAGE,
            "phase": "run", "outcome": "succeeded",
            "inputs": {"math_env": null, "math_tick": null, "math_caching_tick": null,
                       "comment_set_sha256": null, "vote_hwm": null},
            "outputs": [{"store": "postgres", "family": stored::FAMILY, "table": stored::FAMILY,
                         "rows": parts.len(),
                         "keys": parts.iter().map(|p| json!({"conversation_id": conversation, "part": p})).collect::<Vec<_>>()}],
            "models": {"embed": null, "topic": null, "narrative": null},
            "cost": {"llm_tokens_in": null, "llm_tokens_out": null, "provider_batches": null},
            "recheck_after": null,
            "duration_ms": started.elapsed().as_millis() as u64,
            "results": results,
        }))
        .map_err(transient)?;
        polis_queue_adapter::jobs::manifest::validate(
            Some(manifest.as_bytes()),
            job,
            attempt,
            STAGE,
        )
        .map_err(|_| Fail::Permanent("manifest_invalid"))?;
        let sha = hex(&Sha256::digest(manifest.as_bytes()));
        let attempt_uuid = uuid::Uuid::parse_str(attempt).map_err(transient)?;
        self.rpc
            .insert_logs(attempt_uuid, &[(0, "manifest", manifest.as_str())])
            .map_err(transient)?;
        // In process and no child: this process is the writer, alive and
        // fenced, so its own exit proof is honest (as `refuse_without_child`).
        let mut confirm = id.to_vec();
        confirm.extend([json!("confirm_exit"), Value::Null, json!(true)]);
        let c = self
            .rpc
            .committed("pq_end_attempt", &confirm)
            .map_err(transient)?;
        if c["outcome"] != "exit_confirmed" {
            return Err(Fail::Transient(format!("exit proof: {}", c["outcome"])));
        }
        if crash == Some(CrashAt::BeforeFinalize) {
            return crashed();
        }
        let uri = format!("file://derived/{attempt}/output-manifest.json");
        let mut fin = id.to_vec();
        fin.extend([json!(uri), json!(sha)]);
        let mut done = self.rpc.committed("pq_finalize", &fin).map_err(transient)?;
        if crash == Some(CrashAt::LoseFinalizeReply) {
            done = self.rpc.committed("pq_finalize", &fin).map_err(transient)?;
        }
        let word = done["outcome"].as_str().unwrap_or_default().to_owned();
        if word != "succeeded" && word != "already_succeeded" {
            return Err(Fail::Transient(format!("finalize: {word}")));
        }
        log(job, attempt, "stored", &outcome, &source.job_id);
        Ok(Pass::Stored {
            job_id: job.into(),
            outcome,
            finalize: word,
        })
    }
}

fn log(job: &str, attempt: &str, event: &str, word: &str, detail: &dyn std::fmt::Debug) {
    eprintln!(
        "{}",
        json!({"event": format!("derived_{event}"), "job_id": job, "attempt_id": attempt,
               "word": word, "detail": format!("{detail:?}")})
    );
}

/// The daemon: off unless [`SWITCH`] is `1`; then recover, reap and claim
/// one job at a time until a shutdown signal.
pub fn daemon(get: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    if get(SWITCH).as_deref() != Some("1") {
        eprintln!(
            "{}",
            json!({"event": "derived_worker", "outcome": "switched_off"})
        );
        return Ok(());
    }
    let env = get("POLIS_JOBS_ENV")
        .filter(|s| !s.is_empty())
        .ok_or("POLIS_JOBS_ENV is required")?;
    let connector = Arc::new(connector(&get)?);
    let reader_connector = connector.clone();
    let bounds = Bounds::default();
    let cfg = Config {
        env,
        connector,
        reader: Box::new(move |deadline| {
            reader_connector
                .connect_bounded(deadline, bounds.statement)
                .map_err(|e| e.to_string())
        }),
        journal_dir: get("POLIS_JOBS_DERIVED_JOURNAL_DIR")
            .filter(|s| !s.is_empty())
            .ok_or("POLIS_JOBS_DERIVED_JOURNAL_DIR is required")?
            .into(),
        boot_id: get("POLIS_JOBS_BOOT_ID")
            .filter(|s| !s.is_empty())
            .or_else(|| {
                std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                    .ok()
                    .map(|s| s.trim().to_owned())
            })
            .unwrap_or_else(|| "unknown-boot".into()),
        container_id: get("POLIS_JOBS_CONTAINER_ID").unwrap_or_else(|| "unknown-container".into()),
        lease_seconds: 120,
        bounds,
    };
    polis_queue_adapter::jobs::shutdown::install();
    let mut worker = Worker::new(cfg)?;
    worker.recover();
    while !polis_queue_adapter::jobs::shutdown::requested() {
        let _ = worker.reap();
        match worker.pass() {
            Ok(Pass::Idle) | Err(_) => std::thread::sleep(Duration::from_secs(5)),
            Ok(_) => {}
        }
    }
    Ok(())
}

/// The queue login with the daemon's transport rules (as `from_run::connect`).
pub fn connector(get: &impl Fn(&str) -> Option<String>) -> Result<Connector, String> {
    use polis_queue_adapter::jobs::config::TransportKind;
    let dsn = get("QUEUE_DATABASE_URL")
        .filter(|s| !s.trim().is_empty())
        .ok_or("QUEUE_DATABASE_URL is required")?;
    let transport = match get("POLIS_JOBS_TRANSPORT").as_deref().unwrap_or("tls") {
        "tls" => TransportKind::Tls {
            ca_file: get("POLIS_JOBS_CA_FILE")
                .filter(|s| !s.is_empty())
                .ok_or("tls transport requires POLIS_JOBS_CA_FILE")?
                .into(),
            host_allowlist: get("POLIS_JOBS_HOST_ALLOWLIST")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        },
        "local" => TransportKind::Local,
        "loopback" => TransportKind::Loopback,
        _ => return Err("POLIS_JOBS_TRANSPORT must be tls, local or loopback".into()),
    };
    let password = get("POLIS_JOBS_PASSWORD_FILE")
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    Connector::from_parts(
        &dsn,
        &transport,
        password.as_deref(),
        "polis-topic-map-derived/1",
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn config(key: &str) -> Value {
        json!({"result_scope": format!("derived:{key}"), "derived": {
            "schema": SPEC_SCHEMA, "key": key, "operation": "topic_map", "version": 1, "env": "e",
            "source": {"job_id": "s", "run_id": "r", "batch_id": "b", "conversation_id": 7,
                       "scope": "delphi", "selection": null,
                       "families": stored::INPUTS.iter().map(|f| json!({"family": f, "artifact_id": "a", "batch_id": "b", "sha256": "h"})).collect::<Vec<_>>()}}})
    }

    #[test]
    fn the_spec_is_read_whole_or_refused_with_one_word() {
        let ok = source_of("e", "j", &config("k")).unwrap();
        assert_eq!(ok.job_id, "s");
        assert_eq!(ok.families.len(), 3);
        let mut other_env = config("k");
        other_env["derived"]["env"] = json!("f");
        let mut scope = config("k");
        scope["result_scope"] = json!("derived:other");
        let mut v2 = config("k");
        v2["derived"]["version"] = json!(2);
        let mut order = config("k");
        order["derived"]["source"]["families"][0]["family"] = json!(stored::NAMES);
        for bad in [other_env, scope, v2, order, json!({})] {
            assert_eq!(
                source_of("e", "j", &bad),
                Err(Fail::Permanent("spec_invalid"))
            );
        }
        assert_eq!(
            source_of("e", "s", &config("k")),
            Err(Fail::Permanent("spec_invalid"))
        );
    }

    #[test]
    fn only_one_turns_the_worker_on() {
        for v in [None, Some("0"), Some("true"), Some("")] {
            let got = daemon(|k| {
                if k == SWITCH {
                    v.map(str::to_owned)
                } else {
                    None
                }
            });
            assert_eq!(got, Ok(()), "{v:?}");
        }
    }
}
