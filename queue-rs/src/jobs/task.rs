//! One claimed attempt, from journal entry to final `/2` call (build spec
//! §1.3 "job task", §1.4, §1.6). The heartbeat runs until the final RPC
//! returns; the final RPC runs only after the child's process group is empty.
use super::{
    child::{self, Claim},
    config::Config,
    journal::{self, Journal},
    lease::Heartbeat,
    logs,
    manifest::{self, Manifest},
    outcome::{self, Action, Exit},
    readiness::{Counters, InFlight, Transition},
    rpc::{Rpc, db_message},
    shutdown,
    transport::Connector,
};
use crate::Completion;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use uuid::Uuid;

/// An attempt whose process exit is proven locally but not yet recorded.
#[derive(Debug, Clone)]
pub struct Pending {
    pub entry: journal::Entry,
    /// `Some(code)`: `pq_fail(…, false, code, true)` (journal recovery, an
    /// uncertain claim); `None`: `pq_end_attempt(…,'confirm_exit',NULL,true)`.
    pub code: Option<String>,
}

pub struct Ctx {
    pub cfg: Arc<Config>,
    pub connector: Arc<Connector>,
    pub owner: String,
    pub journal: Journal,
    pub counters: Counters,
    pub pending: Mutex<Vec<Pending>>,
    pub in_flight: Mutex<BTreeMap<String, InFlight>>,
}

pub fn identity(c: &Claim) -> Vec<Value> {
    vec![
        json!(c.env),
        json!(c.job_id),
        json!(c.owner_id),
        json!(c.attempt_id),
        json!(c.lease_epoch),
    ]
}

fn with(mut base: Vec<Value>, rest: &[Value]) -> Vec<Value> {
    base.extend_from_slice(rest);
    base
}

pub fn entry_for(ctx: &Ctx, c: &Claim, pgid: Option<i32>) -> journal::Entry {
    journal::Entry {
        schema: journal::SCHEMA.into(),
        env: c.env.clone(),
        owner_id: c.owner_id.clone(),
        job_id: c.job_id.clone(),
        attempt_id: c.attempt_id.clone(),
        lease_epoch: c.lease_epoch.clone(),
        pgid,
        daemon_pid: std::process::id(),
        boot_id: ctx.cfg.boot_id.clone(),
        container_id: ctx.cfg.container_id.clone(),
    }
}

/// Call a terminal RPC with bounded retries. An uncertain COMMIT followed by
/// `fenced` on the retry is resolved by reading `pd_job_view`.
pub fn terminal(rpc: &mut Rpc, name: &str, args: &[Value]) -> anyhow::Result<Value> {
    let mut uncertain = false;
    let mut last_err = None;
    for attempt in 0..8u32 {
        match rpc.call(name, args) {
            Ok(Completion::Committed(reply)) => {
                if uncertain && reply["outcome"] == "fenced" {
                    let view = rpc
                        .committed("pd_job_view", &[args[0].clone(), args[1].clone()])
                        .unwrap_or(Value::Null);
                    return Ok(json!({"outcome": "resolved_after_uncertain_commit",
                        "state": view["state"], "last_error_code": view["last_error_code"],
                        "attempt_count": view["attempt_count"], "max_attempts": view["max_attempts"]}));
                }
                return Ok(reply);
            }
            Ok(Completion::Unknown(_)) => uncertain = true,
            Err(e) => {
                // A definite refusal raised by SQL is an answer; timeouts,
                // failover and lost connections are retried.
                if !super::rpc::is_transient(&e) {
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
        std::thread::sleep(Duration::from_millis(250 << attempt.min(4)));
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("uncertain commit for {name}")))
}

pub const INTENT_SCHEMA: &str = "polis-jobs.provider-intent/1";
pub const ACK_SCHEMA: &str = "polis-jobs.provider-intent-ack/1";

/// One provider intent of this attempt. Slot 0 is `provider_intent.json`
/// (the P1-b child's file); slot n ≥ 1 is `provider_intent.<n>.json`. An
/// optional `provider_intent[.<n>].result.json` ({"state", "batch_id"})
/// lets a child that submits several batches in one attempt resolve each
/// before the next: `polis-queue/2` admits one open request per job.
struct Slot {
    n: u32,
    request_id: String,
    attempts: u32,
    state: IntentState,
    resolved: Option<String>,
}

#[derive(PartialEq, Eq, Debug, Clone, Copy)]
enum IntentState {
    Waiting,
    Acked,
    Refused,
}

fn slot_file(dir: &Path, n: u32, suffix: &str) -> std::path::PathBuf {
    if n == 0 {
        dir.join(format!("provider_intent.{suffix}"))
    } else {
        dir.join(format!("provider_intent.{n}.{suffix}"))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

fn refuse_slot(dir: &Path, slot: &mut Slot, reason: Value) {
    slot.state = IntentState::Refused;
    let _ = write_atomic(
        &slot_file(dir, slot.n, "refused"),
        json!({"reason": reason}).to_string().as_bytes(),
    );
}

/// Record-before-submit handshake (build spec §1.4 (i)-(iii)): the daemon
/// mints the request id, digests the exact intent file bytes, commits
/// `pd_provider_intent`, and only then writes the acknowledgement
/// `{"schema":"polis-jobs.provider-intent-ack/1","request_id","intent_sha256"}`.
fn handle_slot(rpc: &mut Rpc, claim: &Claim, dir: &Path, slot: &mut Slot) {
    let Ok(bytes) = std::fs::read(slot_file(dir, slot.n, "json")) else {
        return;
    };
    let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else {
        slot.attempts += 1;
        if slot.attempts > 100 {
            refuse_slot(dir, slot, json!("unreadable intent"));
        }
        return;
    };
    let bound = doc["schema"] == INTENT_SCHEMA
        && doc["job_id"] == claim.job_id.as_str()
        && doc["attempt_id"] == claim.attempt_id.as_str()
        && doc["lease_epoch"] == claim.lease_epoch.as_str()
        && doc["provider"].as_str().is_some_and(|p| !p.is_empty());
    if !bound {
        return refuse_slot(dir, slot, json!("intent is not bound to this attempt"));
    }
    let provider = doc["provider"].as_str().unwrap_or_default().to_owned();
    let digest = super::sha256_hex(&bytes);
    let args = with(
        identity(claim),
        &[json!(slot.request_id), json!(provider), json!(digest)],
    );
    match rpc.call("pd_provider_intent", &args) {
        Ok(Completion::Committed(reply)) => {
            let ok = reply["outcome"] == "recorded"
                || (reply["outcome"] == "existing" && reply["state"] == "intent");
            if ok {
                let ack = json!({"schema": ACK_SCHEMA, "request_id": slot.request_id,
                    "intent_sha256": digest});
                if write_atomic(&slot_file(dir, slot.n, "ack"), ack.to_string().as_bytes()).is_ok()
                {
                    slot.state = IntentState::Acked;
                }
            } else {
                // An `existing` reply in any state but `intent` is never acknowledged.
                refuse_slot(dir, slot, reply);
            }
        }
        Ok(Completion::Unknown(_)) => {} // retried next tick with the same request id
        Err(e) => {
            if let Some(message) = db_message(&e) {
                refuse_slot(dir, slot, json!(message));
            }
        }
    }
}

/// Apply a child-written result for an acknowledged slot (`submitted`,
/// `completed` or `failed`, with the batch id), once.
fn apply_result(rpc: &mut Rpc, claim: &Claim, dir: &Path, slot: &mut Slot) {
    if slot.state != IntentState::Acked || slot.resolved.is_some() {
        return;
    }
    let Some(doc) = std::fs::read(slot_file(dir, slot.n, "result.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return;
    };
    let state = doc["state"].as_str().unwrap_or_default().to_owned();
    if !["submitted", "completed", "failed"].contains(&state.as_str()) {
        return;
    }
    let batch = doc["batch_id"].clone();
    let mut steps = vec![];
    if state == "completed" {
        steps.push("submitted");
    }
    steps.push(state.as_str());
    for step in steps {
        if terminal(
            rpc,
            "pd_provider_update",
            &with(
                identity(claim),
                &[json!(slot.request_id), json!(step), batch.clone()],
            ),
        )
        .is_err()
        {
            return;
        }
    }
    slot.resolved = Some(state);
}

struct Intents {
    slots: Vec<Slot>,
}

impl Intents {
    fn new() -> Self {
        Self { slots: vec![] }
    }
    fn tick(&mut self, rpc: &mut Rpc, claim: &Claim, dir: &Path) {
        for slot in &mut self.slots {
            apply_result(rpc, claim, dir, slot);
        }
        if self
            .slots
            .last()
            .is_some_and(|s| s.state == IntentState::Waiting)
        {
            if let Some(slot) = self.slots.last_mut() {
                handle_slot(rpc, claim, dir, slot);
            }
            return;
        }
        let n = self.slots.len() as u32;
        if slot_file(dir, n, "json").exists() {
            let mut slot = Slot {
                n,
                request_id: Uuid::new_v4().to_string(),
                attempts: 0,
                state: IntentState::Waiting,
                resolved: None,
            };
            handle_slot(rpc, claim, dir, &mut slot);
            self.slots.push(slot);
        }
    }
    /// Acknowledged slots the child did not resolve itself, in order.
    fn open(&self) -> Vec<&Slot> {
        self.slots
            .iter()
            .filter(|s| s.state == IntentState::Acked && s.resolved.is_none())
            .collect()
    }
}

fn transition(ctx: &Ctx, c: &Claim, phase: &str, to: &str, reason: Option<String>) -> Transition {
    Transition {
        env: c.env.clone(),
        job_id: c.job_id.clone(),
        run_id: Some(c.run_id.clone()),
        attempt_id: Some(c.attempt_id.clone()),
        stage: Some(c.stage.clone()),
        phase: Some(phase.to_owned()),
        from: "running".into(),
        to: to.to_owned(),
        reason,
        owner: ctx.owner.clone(),
        ..Default::default()
    }
}

/// End an attempt for which no child was spawned (proof is honest).
pub fn refuse_without_child(ctx: &Ctx, rpc: &mut Rpc, c: &Claim, permanent: bool, code: &str) {
    let reply = terminal(
        rpc,
        "pq_fail",
        &with(identity(c), &[json!(permanent), json!(code), json!(true)]),
    );
    Counters::bump(&ctx.counters.failed);
    let to = reply
        .as_ref()
        .ok()
        .and_then(|r| r["state"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "unrecorded".into());
    transition(ctx, c, "none", &to, Some(code.to_owned())).emit();
}

pub fn run(ctx: Arc<Ctx>, claim: Claim, reply: Value) {
    let cfg = ctx.cfg.clone();
    let mut rpc = Rpc::new(ctx.connector.clone(), &claim.env);
    let started = Instant::now();
    let admission = match child::decode_admission(
        reply["input"]["uri"].as_str().unwrap_or_default(),
        reply["input"]["sha256"].as_str().unwrap_or_default(),
    ) {
        Ok(a) => a,
        Err(_) => return refuse_without_child(&ctx, &mut rpc, &claim, true, "frame_invalid"),
    };
    // Phase: the narrative checker is the same job reclaimed after a park.
    let mut phase = if claim.stage == "delphi_narrative" {
        "submit".to_owned()
    } else {
        "run".to_owned()
    };
    let mut recheck: Option<(String, String)> = None;
    if claim.stage == "delphi_narrative" {
        match rpc.committed("pd_job_view", &[json!(claim.env), json!(claim.job_id)]) {
            Ok(view) => {
                for p in view["provider_requests"].as_array().into_iter().flatten() {
                    if p["state"] == "submitted"
                        && let (Some(r), Some(b)) =
                            (p["request_id"].as_str(), p["batch_id"].as_str())
                    {
                        recheck = Some((r.to_owned(), b.to_owned()));
                    }
                }
            }
            Err(_) => {
                return refuse_without_child(&ctx, &mut rpc, &claim, false, "job_view_unavailable");
            }
        }
        if recheck.is_some() {
            phase = "recheck".into();
        }
    }
    // Journal before spawn (fsync); refuse to run what we could not journal.
    if ctx.journal.write(&entry_for(&ctx, &claim, None)).is_err() {
        let _ = terminal(
            &mut rpc,
            "pq_release",
            &with(identity(&claim), &[json!(true)]),
        );
        transition(
            &ctx,
            &claim,
            &phase,
            "released",
            Some("journal_unwritable".into()),
        )
        .emit();
        let _ = ctx.journal.remove(&claim.attempt_id);
        return;
    }
    let dir = cfg.work_dir.join(&claim.attempt_id);
    let manifest_path = dir.join("output-manifest.json");
    let frame_path = dir.join("frame.json");
    let batch = recheck.as_ref().map(|(_, b)| b.as_str());
    let frame = child::frame(&claim, &admission, &phase, batch);
    let prepared =
        std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&frame_path, frame.to_string()));
    let command = child::command_args(&cfg.app_path, &claim, &admission, &phase);
    let (script, args) = match (prepared, command) {
        (Ok(()), Ok(v)) => v,
        _ => {
            refuse_without_child(&ctx, &mut rpc, &claim, false, "dispatch_unprepared");
            let _ = ctx.journal.remove(&claim.attempt_id);
            return;
        }
    };
    let heartbeat = Heartbeat::start(
        ctx.connector.clone(),
        claim.env.clone(),
        claim.job_id.clone(),
        claim.owner_id.clone(),
        claim.attempt_id.clone(),
        claim.lease_epoch.clone(),
        cfg.lease_seconds,
        Duration::from_secs(u64::from(cfg.heartbeat_seconds)),
    );
    let spawned = child::spawn(
        &cfg.python,
        &cfg.app_path,
        &script,
        &args,
        &claim,
        &admission,
        &phase,
        &manifest_path,
        &frame_path,
        batch,
    );
    let child::Spawned {
        child: mut proc,
        pgid,
    } = match spawned {
        Ok(s) => s,
        Err(_) => {
            refuse_without_child(&ctx, &mut rpc, &claim, false, "spawn_failed");
            heartbeat.stop();
            let _ = ctx.journal.remove(&claim.attempt_id);
            return;
        }
    };
    if ctx
        .journal
        .write(&entry_for(&ctx, &claim, Some(pgid)))
        .is_err()
    {
        // Without the pgid on disk a restart could not prove this child's
        // exit: stop it now and end the attempt while the proof is local.
        let (_, empty) = child::kill_and_reap(&mut proc, pgid, cfg.kill_grace);
        if empty {
            let _ = terminal(
                &mut rpc,
                "pq_fail",
                &with(
                    identity(&claim),
                    &[json!(false), json!("journal_unwritable"), json!(true)],
                ),
            );
            let _ = ctx.journal.remove(&claim.attempt_id);
        }
        heartbeat.stop();
        Counters::bump(&ctx.counters.failed);
        transition(
            &ctx,
            &claim,
            &phase,
            if empty {
                "retry_wait"
            } else {
                "exit_unconfirmed"
            },
            Some("journal_unwritable".into()),
        )
        .emit();
        return;
    }
    if let Ok(mut map) = ctx.in_flight.lock() {
        map.insert(
            claim.attempt_id.clone(),
            InFlight {
                job_id: claim.job_id.clone(),
                stage: claim.stage.clone(),
                started_at: super::now_rfc3339(),
                last_heartbeat: None,
            },
        );
    }
    transition(&ctx, &claim, &phase, "dispatched", None).emit();
    if let Some(mut stdin) = proc.stdin.take() {
        let bytes = frame.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(bytes.as_bytes());
            let _ = stdin.write_all(b"\n");
        });
    }
    let (sender, receiver) = mpsc::channel();
    let mut pumps = vec![];
    if let Some(out) = proc.stdout.take() {
        pumps.push(logs::pump("stdout", out, sender.clone()));
    }
    if let Some(err) = proc.stderr.take() {
        pumps.push(logs::pump("stderr", err, sender.clone()));
    }
    drop(sender);
    let writer = {
        let rpc_logs = Rpc::new(ctx.connector.clone(), &claim.env);
        let attempt = Uuid::parse_str(&claim.attempt_id).unwrap_or_default();
        let (lines, bytes, batch_lines, interval) = (
            cfg.log_max_lines,
            cfg.log_max_bytes,
            cfg.log_batch_lines,
            cfg.log_batch_interval,
        );
        std::thread::spawn(move || {
            logs::writer(
                rpc_logs,
                attempt,
                receiver,
                lines,
                bytes,
                batch_lines,
                interval,
            )
        })
    };
    // Wait: leader exit, fence, shutdown, timer, provider intent.
    let mut intents = Intents::new();
    let mut killed: Option<Exit> = None;
    let (status, empty) = loop {
        if let Ok(Some(_)) = proc.try_wait() {
            break child::kill_and_reap(&mut proc, pgid, cfg.kill_grace);
        }
        let reason = if heartbeat.fenced() {
            Some((Exit::Fenced, cfg.kill_grace))
        } else if shutdown::requested() {
            Some((Exit::Shutdown, cfg.shutdown_grace))
        } else if started.elapsed() >= cfg.child_timeout {
            Some((Exit::Timeout, cfg.kill_grace))
        } else {
            None
        };
        if let Some((why, grace)) = reason {
            killed = Some(why);
            break child::kill_and_reap(&mut proc, pgid, grace);
        }
        intents.tick(&mut rpc, &claim, &dir);
        if let (Ok(mut map), Ok(last)) = (ctx.in_flight.lock(), heartbeat.state.last_ok.lock())
            && let Some(f) = map.get_mut(&claim.attempt_id)
        {
            f.last_heartbeat = last.clone();
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    for p in pumps {
        let _ = p.join();
    }
    let (mut rpc_logs, written) = writer.join().unwrap_or_else(|_| {
        (
            Rpc::new(ctx.connector.clone(), &claim.env),
            logs::Written {
                buffer: logs::LogBuffer::new(0, 0),
                failed_batches: 0,
            },
        )
    });
    let mut buffer = written.buffer;
    let finish = |ctx: &Ctx| {
        if let Ok(mut map) = ctx.in_flight.lock() {
            map.remove(&claim.attempt_id);
        }
    };
    if !empty {
        // No proof: never pass `true`. The lease expires, the reaper parks the
        // job `exit_unconfirmed`, and the journal entry stays for restart.
        heartbeat.stop();
        Counters::bump(&ctx.counters.exit_unconfirmed);
        transition(
            &ctx,
            &claim,
            &phase,
            "exit_unconfirmed",
            Some("process_group_not_empty".into()),
        )
        .emit();
        finish(&ctx);
        return;
    }
    // A fence observed while the child was finishing still wins.
    let exit = match killed {
        Some(k) => k,
        None if heartbeat.fenced() => Exit::Fenced,
        None => match status {
            Some(s) => match (s.code(), std::os::unix::process::ExitStatusExt::signal(&s)) {
                (Some(code), _) => Exit::Code(code),
                (None, Some(sig)) => Exit::Signal(sig),
                _ => Exit::Code(255),
            },
            None => Exit::Code(255),
        },
    };
    let manifest_bytes = std::fs::read(&manifest_path).ok();
    let manifest: Result<Manifest, manifest::Invalid> = manifest::validate(
        manifest_bytes.as_deref(),
        &claim.job_id,
        &claim.attempt_id,
        &claim.stage,
    );
    let mut action = outcome::decide(&exit, &manifest);
    let id = identity(&claim);
    // Provider bookkeeping while still the owner (or as the late submitter).
    // Pick up a result file written just before exit.
    for slot in &mut intents.slots {
        apply_result(&mut rpc, &claim, &dir, slot);
    }
    // Unresolved acknowledged intents take the manifest's batch ids in order
    // (after the batches the child already resolved); without one, the
    // submission is unknown (§1.4 (iv)).
    let resolved_count = intents
        .slots
        .iter()
        .filter(|s| s.resolved.is_some())
        .count();
    let batch_ids: Vec<String> = manifest
        .as_ref()
        .map(|m| m.batch_ids.clone())
        .unwrap_or_default();
    let mut newly_submitted: Vec<(String, String)> = vec![];
    for (i, slot) in intents.open().into_iter().enumerate() {
        let (state, b) = match batch_ids.get(resolved_count + i) {
            Some(b) => ("submitted", Value::from(b.clone())),
            None => ("submission_unknown", Value::Null),
        };
        if terminal(
            &mut rpc,
            "pd_provider_update",
            &with(
                id.clone(),
                &[json!(slot.request_id), json!(state), b.clone()],
            ),
        )
        .is_ok()
            && let Some(b) = b.as_str()
        {
            newly_submitted.push((slot.request_id.clone(), b.to_owned()));
        }
    }
    if action == Action::Finalize {
        let mut submitted: Vec<(String, String)> = recheck.iter().cloned().collect();
        submitted.extend(newly_submitted);
        for (request, b) in submitted {
            if terminal(
                &mut rpc,
                "pd_provider_update",
                &with(id.clone(), &[json!(request), json!("completed"), json!(b)]),
            )
            .is_err()
            {
                action = Action::Park {
                    eligible_at: String::new(),
                };
            }
        }
    }
    let manifest_uri = format!("file://{}", manifest_path.display());
    let code_of = |a: &Action| match a {
        Action::Fail { code, .. } => Some(code.clone()),
        Action::Park { .. } => Some("awaiting_provider".into()),
        _ => None,
    };
    let mut reason = code_of(&action);
    let result: anyhow::Result<Value> = match &action {
        Action::Finalize => match &manifest {
            Err(_) => {
                reason = Some("manifest_invalid".into());
                terminal(
                    &mut rpc,
                    "pq_fail",
                    &with(
                        id.clone(),
                        &[json!(false), json!("manifest_invalid"), json!(true)],
                    ),
                )
            }
            Ok(m) => {
                let row = buffer.manifest_row(&m.text);
                let attempt = Uuid::parse_str(&claim.attempt_id).unwrap_or_default();
                let mut inserted = false;
                for i in 0..8u32 {
                    if rpc_logs
                        .insert_logs(attempt, &[(row.seq, row.stream, row.line.as_str())])
                        .is_ok()
                    {
                        inserted = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250 << i.min(4)));
                }
                let confirmed = terminal(
                    &mut rpc,
                    "pq_end_attempt",
                    &with(
                        id.clone(),
                        &[json!("confirm_exit"), Value::Null, json!(true)],
                    ),
                );
                match (inserted, confirmed) {
                    (_, Err(e)) => Err(e),
                    (_, Ok(r)) if r["outcome"] != "exit_confirmed" => Ok(r),
                    (false, Ok(_)) => {
                        // The database refused or lost the row, not the child:
                        // retryable and not counted as poison.
                        reason = Some("manifest_row_unrecorded".into());
                        terminal(
                            &mut rpc,
                            "pq_fail",
                            &with(
                                id.clone(),
                                &[json!(false), json!("manifest_row_unrecorded"), json!(true)],
                            ),
                        )
                    }
                    (true, Ok(_)) => {
                        let fin = terminal(
                            &mut rpc,
                            "pq_finalize",
                            &with(id.clone(), &[json!(manifest_uri), json!(m.sha256)]),
                        );
                        match fin {
                            Ok(r) if r["outcome"] == "invalid_output" => {
                                reason = Some("manifest_invalid".into());
                                terminal(
                                    &mut rpc,
                                    "pq_fail",
                                    &with(
                                        id.clone(),
                                        &[json!(false), json!("manifest_invalid"), json!(true)],
                                    ),
                                )
                            }
                            Err(e)
                                if db_message(&e).as_deref()
                                    == Some("provider request unresolved") =>
                            {
                                reason = Some("provider_unresolved".into());
                                terminal(
                                    &mut rpc,
                                    "pq_park",
                                    &with(
                                        id.clone(),
                                        &[json!("provider_unresolved"), json!(true), Value::Null],
                                    ),
                                )
                            }
                            other => other,
                        }
                    }
                }
            }
        },
        Action::Park { eligible_at } => {
            let at = if eligible_at.is_empty() {
                reason = Some("provider_unresolved".into());
                Value::Null
            } else {
                json!(eligible_at)
            };
            let code = if at.is_null() {
                "provider_unresolved"
            } else {
                "awaiting_provider"
            };
            terminal(
                &mut rpc,
                "pq_park",
                &with(id.clone(), &[json!(code), json!(true), at]),
            )
        }
        Action::Fail { permanent, code } => terminal(
            &mut rpc,
            "pq_fail",
            &with(id.clone(), &[json!(permanent), json!(code), json!(true)]),
        ),
        Action::ConfirmExit => terminal(
            &mut rpc,
            "pq_end_attempt",
            &with(
                id.clone(),
                &[json!("confirm_exit"), Value::Null, json!(true)],
            ),
        ),
    };
    heartbeat.stop();
    finish(&ctx);
    let mut t = transition(&ctx, &claim, &phase, "", reason.clone());
    t.dur_ms = Some(started.elapsed().as_millis() as u64);
    t.exit_code = match exit {
        Exit::Code(c) => Some(c),
        _ => None,
    };
    if let Ok(m) = &manifest {
        t.tokens_in = m.tokens_in;
        t.tokens_out = m.tokens_out;
    }
    match result {
        Ok(reply) => {
            let _ = ctx.journal.remove(&claim.attempt_id);
            // The manifest's bytes are in polis_queue_logs; the work dir goes.
            let _ = std::fs::remove_dir_all(&dir);
            let outcome_s = reply["outcome"].as_str().unwrap_or_default().to_owned();
            let state = reply["state"].as_str().unwrap_or_default().to_owned();
            t.to = match (&action, outcome_s.as_str()) {
                (Action::ConfirmExit, _) => {
                    Counters::bump(&ctx.counters.fenced);
                    t.reason = Some(match state.as_str() {
                        "cancelled" => "cancelled".into(),
                        _ => "fenced".into(),
                    });
                    format!("exit_confirmed:{state}")
                }
                (_, "succeeded" | "already_succeeded") => {
                    Counters::bump(&ctx.counters.finalized);
                    "succeeded".into()
                }
                (_, "fenced") => {
                    Counters::bump(&ctx.counters.fenced);
                    "fenced".into()
                }
                (_, _) => {
                    match state.as_str() {
                        "parked" => Counters::bump(&ctx.counters.parked),
                        _ => Counters::bump(&ctx.counters.failed),
                    }
                    if state.is_empty() {
                        outcome_s.clone()
                    } else {
                        state.clone()
                    }
                }
            };
            t.emit();
            if t.to == "dead" && reason.as_deref().is_some_and(outcome::is_poison_code) {
                Counters::bump(&ctx.counters.poison);
                let mut p = t.clone();
                p.from = "dead".into();
                p.to = "poison".into();
                p.emit();
            }
        }
        Err(e) => {
            // The exit is proven here but not recorded: retry from the main loop.
            t.to = "exit_proof_pending".into();
            t.reason = Some(db_message(&e).unwrap_or_else(|| "database_unreachable".into()));
            t.emit();
            if let Ok(mut p) = ctx.pending.lock() {
                p.push(Pending {
                    entry: entry_for(&ctx, &claim, Some(pgid)),
                    code: None,
                });
            }
        }
    }
    if written.failed_batches > 0 || buffer.truncated() {
        super::readiness::emit(
            &json!({"schema": "polis_jobs.log_summary/1", "job_id": claim.job_id,
                "attempt_id": claim.attempt_id, "seen_lines": buffer.seen_lines,
                "dropped_lines": buffer.dropped_lines, "failed_batches": written.failed_batches})
            .to_string(),
        );
    }
}
