//! The main loop (build spec §1.3): contract check (the installed contract
//! must be one the worker's class may start on), restart-journal recovery,
//! then LISTEN `polis_queue_wakeup_v1` with a poll fallback, the six-argument
//! `pq_claim` with the worker class (reply `owned` or `none`; a worker sees
//! only jobs of its class), admission of the class's stages only, the reaper
//! cadence and the readiness cadence.
use super::{
    child::{self, Claim},
    config::Config,
    journal::{self, Journal},
    readiness::{self, Counters, Snapshot, Transition},
    reaper::Reaper,
    rpc::{CONTRACTS, Rpc},
    shutdown,
    sweep::Sweeper,
    task::{self, Ctx, Pending},
    transport::Connector,
};
use crate::Completion;
use postgres::fallible_iterator::FallibleIterator;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, OnceLock},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const EXIT_CONFIG: i32 = 2;
pub const EXIT_CONTRACT: i32 = 3;

fn line(message: &str) {
    readiness::emit(&format!("polis_jobs {message}"));
}

fn claim_of(reply: &Value, owner: &str) -> Option<Claim> {
    let s = |k: &str| reply[k].as_str().map(str::to_owned);
    Some(Claim {
        env: s("env")?,
        job_id: s("job_id")?,
        run_id: s("run_id")?,
        attempt_id: s("attempt_id")?,
        owner_id: owner.to_owned(),
        lease_epoch: s("lease_epoch")?,
        stage: s("stage")?,
    })
}

/// One claim pass over the priority lanes. `Ok(None)` when nothing is ready.
fn claim_one(
    rpc: &mut Rpc,
    ctx: &Ctx,
    cfg: &Config,
    owner: &str,
) -> anyhow::Result<Option<(Claim, Value)>> {
    for priority in 0..=2i16 {
        let attempt = Uuid::new_v4().to_string();
        let args = [
            json!(cfg.env),
            json!(priority),
            json!(owner),
            json!(attempt),
            json!(cfg.lease_seconds),
            json!(cfg.worker_class.name()),
        ];
        let reply = match rpc.call("pq_claim", &args)? {
            Completion::Committed(r) => r,
            Completion::Unknown(r) => {
                // Never reissue an uncertain claim: renew the exact token.
                if r["outcome"] != "owned" {
                    continue;
                }
                let hb = rpc.call(
                    "pq_heartbeat",
                    &[
                        json!(cfg.env),
                        r["job_id"].clone(),
                        json!(owner),
                        json!(attempt),
                        r["lease_epoch"].clone(),
                        json!(cfg.lease_seconds),
                    ],
                );
                match hb {
                    Ok(Completion::Committed(h)) if h["outcome"] == "owned" => r,
                    _ => {
                        // Maybe owned, never run: end it with honest proof (no
                        // child was spawned) so it cannot sit unconfirmed. If
                        // the claim never committed the call is simply fenced.
                        line(&format!(
                            "uncertain claim of job {} not renewed; ending it as claim_uncertain",
                            r["job_id"].as_str().unwrap_or("?")
                        ));
                        if let Ok(mut p) = ctx.pending.lock() {
                            p.push(Pending {
                                entry: journal::Entry {
                                    schema: journal::SCHEMA.into(),
                                    env: cfg.env.clone(),
                                    owner_id: owner.to_owned(),
                                    job_id: r["job_id"].as_str().unwrap_or_default().to_owned(),
                                    attempt_id: attempt.clone(),
                                    lease_epoch: r["lease_epoch"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_owned(),
                                    pgid: None,
                                    daemon_pid: std::process::id(),
                                    boot_id: cfg.boot_id.clone(),
                                    container_id: cfg.container_id.clone(),
                                },
                                code: Some("claim_uncertain".into()),
                            });
                        }
                        continue;
                    }
                }
            }
        };
        match reply["outcome"].as_str() {
            Some("owned") => {
                let claim = claim_of(&reply, owner)
                    .ok_or_else(|| anyhow::anyhow!("claim reply missing identity"))?;
                anyhow::ensure!(claim.attempt_id == attempt, "claim reply attempt mismatch");
                return Ok(Some((claim, reply)));
            }
            Some("none") => continue,
            other => anyhow::bail!("unexpected claim outcome {other:?}"),
        }
    }
    Ok(None)
}

fn retry_pending(ctx: &Ctx, rpc: &mut Rpc) {
    let items: Vec<Pending> = match ctx.pending.lock() {
        Ok(mut p) => std::mem::take(&mut *p),
        Err(_) => return,
    };
    let mut keep = vec![];
    for item in items {
        let e = &item.entry;
        let id = vec![
            json!(e.env),
            json!(e.job_id),
            json!(e.owner_id),
            json!(e.attempt_id),
            json!(e.lease_epoch),
        ];
        let (name, rest, reason) = if let Some(code) = &item.code {
            (
                "pq_fail",
                vec![json!(false), json!(code), json!(true)],
                code.as_str(),
            )
        } else {
            (
                "pq_end_attempt",
                vec![json!("confirm_exit"), Value::Null, json!(true)],
                "exit_confirmed",
            )
        };
        let mut args = id;
        args.extend(rest);
        match rpc.call(name, &args) {
            Ok(Completion::Committed(reply)) => {
                let _ = ctx.journal.remove(&e.attempt_id);
                let state = reply["state"].as_str().unwrap_or_default().to_owned();
                Transition {
                    env: e.env.clone(),
                    job_id: e.job_id.clone(),
                    attempt_id: Some(e.attempt_id.clone()),
                    from: "journal".into(),
                    to: reply["state"]
                        .as_str()
                        .or(reply["outcome"].as_str())
                        .unwrap_or("recorded")
                        .to_owned(),
                    reason: Some(format!(
                        "{reason}:{}",
                        reply["outcome"].as_str().unwrap_or_default()
                    )),
                    owner: ctx.owner.clone(),
                    ..Default::default()
                }
                .emit();
                super::scope::after_terminal(
                    rpc,
                    &ctx.counters,
                    &ctx.owner,
                    &e.env,
                    &e.job_id,
                    &state,
                );
            }
            Err(e) if !super::rpc::is_transient(&e) => {
                // A definite refusal by SQL: nothing to retry.
                let _ = ctx.journal.remove(&item.entry.attempt_id);
                line(&format!("journal entry dropped after refusal: {e}"));
            }
            Err(e) => {
                // Lock/statement timeout, failover, lost connection: keep the
                // entry and retry on the next reaper tick.
                line(&format!("journal entry kept for retry: {e}"));
                keep.push(item);
            }
            Ok(Completion::Unknown(_)) => keep.push(item),
        }
    }
    if let Ok(mut p) = ctx.pending.lock() {
        p.extend(keep);
    }
}

/// Recovery: every journaled attempt that is provably gone is confirmed with
/// `pq_fail(env, job, owner, attempt, epoch, false, 'daemon_restarted', true)`.
fn recover(ctx: &Ctx, rpc: &mut Rpc) {
    for entry in ctx.journal.entries() {
        if entry.env != ctx.cfg.env {
            continue;
        }
        if !journal::provably_gone(&entry, &ctx.cfg.boot_id, &ctx.cfg.container_id, &ctx.owner) {
            line(&format!(
                "journal entry {} not provably gone; left in place",
                entry.attempt_id
            ));
            continue;
        }
        if let Ok(mut p) = ctx.pending.lock() {
            p.push(Pending {
                entry,
                code: Some("daemon_restarted".into()),
            });
        }
    }
    retry_pending(ctx, rpc);
}

fn snapshot_line(ctx: &Ctx, progress: &str) -> String {
    let in_flight = ctx
        .in_flight
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    readiness::readiness_line(&Snapshot {
        env: &ctx.cfg.env,
        owner: &ctx.owner,
        identity: &ctx.cfg.identity,
        progress,
        in_flight,
        counters: &ctx.counters,
        transport: ctx.cfg.transport.name(),
        contract: ctx.contract(),
    })
}

/// Run the daemon; returns the process exit code.
pub fn run(cfg: Config) -> i32 {
    shutdown::install();
    child::become_subreaper();
    let journal = match Journal::open(&cfg.journal_dir) {
        Ok(j) => j,
        Err(e) => {
            line(&format!(
                "config refused: POLIS_JOBS_JOURNAL_DIR {} is not usable ({e})",
                cfg.journal_dir.display()
            ));
            return EXIT_CONFIG;
        }
    };
    let connector = match Connector::new(&cfg) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            line(&format!("config refused: {e}"));
            return EXIT_CONFIG;
        }
    };
    let owner = Uuid::new_v4().to_string();
    let ctx = Arc::new(Ctx {
        cfg: Arc::new(cfg),
        connector: connector.clone(),
        owner: owner.clone(),
        journal,
        counters: Counters::default(),
        pending: Mutex::new(vec![]),
        in_flight: Mutex::new(Default::default()),
        contract: OnceLock::new(),
    });
    let cfg = ctx.cfg.clone();
    line(&format!(
        "starting owner={owner} identity={} env={} class={} transport={} dsn={}",
        cfg.identity,
        cfg.env,
        cfg.worker_class.name(),
        cfg.transport.name(),
        cfg.redacted_dsn()
    ));
    let mut rpc = Rpc::new(connector.clone(), &cfg.env);
    // Contract: polis_queue_install.contract_version must read one the class
    // may start on (delphi: /2 or /3; large: /3 only).
    let mut failures = 0u32;
    loop {
        if shutdown::requested() {
            return 0;
        }
        match rpc.contract() {
            Ok(Some(v)) if cfg.worker_class.admits_contract(&v) => {
                let _ = ctx.contract.set(v);
                break;
            }
            Ok(found) => {
                line(&format!(
                    "contract missing: polis_queue_install.contract_version is {}; class {} needs {} (known: {})",
                    found.as_deref().unwrap_or("absent"),
                    cfg.worker_class.name(),
                    cfg.worker_class.contracts().join(" or "),
                    CONTRACTS.join(", ")
                ));
                return EXIT_CONTRACT;
            }
            Err(e) if e.to_string().starts_with("queue_login_boundary") => {
                line(&format!("config refused: {e}"));
                return EXIT_CONFIG;
            }
            Err(e) => {
                failures += 1;
                if failures > 2 {
                    readiness::emit(&snapshot_line(&ctx, "degraded"));
                }
                line(&format!("database unreachable at start: {e}"));
                std::thread::sleep(cfg.poll);
            }
        }
    }
    recover(&ctx, &mut rpc);
    let mut listener: Option<postgres::Client> = rpc.listener().ok();
    let mut jobs: Vec<JoinHandle<()>> = vec![];
    let mut reaper = Reaper::new(cfg.lease_seconds, cfg.reap_interval);
    let mut next_reap = Instant::now();
    let mut next_ready = Instant::now();
    let mut next_poll = Instant::now();
    let mut wake = true;
    let mut db_failures = 0u32;
    let mut sweeper = Sweeper::new(cfg.sweep, cfg.sweep_max_pages, cfg.sweep_check);
    // The last claim pass found nothing to start: the sweep may take a page.
    let mut claim_idle = false;
    while !shutdown::requested() {
        let before = jobs.len();
        jobs.retain(|h| !h.is_finished());
        if jobs.len() < before {
            wake = true;
        }
        if Instant::now() >= next_poll {
            wake = true;
            next_poll = Instant::now() + cfg.poll;
        }
        while wake && jobs.len() < cfg.concurrency && !shutdown::requested() {
            match claim_one(&mut rpc, &ctx, &cfg, &owner) {
                Ok(Some((claim, reply))) => {
                    db_failures = 0;
                    claim_idle = false;
                    Counters::bump(&ctx.counters.claimed);
                    if !cfg.stages.contains(&claim.stage) {
                        // Map 1 D8: refused at claim; no child is spawned.
                        task::refuse_without_child(&ctx, &mut rpc, &claim, true, "unknown_stage");
                        continue;
                    }
                    Transition {
                        env: claim.env.clone(),
                        job_id: claim.job_id.clone(),
                        run_id: Some(claim.run_id.clone()),
                        attempt_id: Some(claim.attempt_id.clone()),
                        stage: Some(claim.stage.clone()),
                        from: "queued".into(),
                        to: "running".into(),
                        owner: owner.clone(),
                        ..Default::default()
                    }
                    .emit();
                    let ctx2 = ctx.clone();
                    jobs.push(std::thread::spawn(move || task::run(ctx2, claim, reply)));
                }
                Ok(None) => {
                    db_failures = 0;
                    wake = false;
                    claim_idle = true;
                }
                Err(e) => {
                    db_failures += 1;
                    line(&format!("claim failed: {e}"));
                    wake = false;
                }
            }
        }
        // P-083: retention never goes ahead of a job; one page per pass.
        if sweeper.enabled() && !shutdown::requested() {
            sweeper.tick(&mut rpc, claim_idle || jobs.len() >= cfg.concurrency);
        }
        if Instant::now() >= next_reap {
            next_reap = Instant::now() + cfg.reap_interval;
            retry_pending(&ctx, &mut rpc);
            if let Err(e) = reaper.tick(&mut rpc, cfg.worker_class.name(), &owner, &ctx.counters) {
                db_failures += 1;
                line(&format!("reap failed: {e}"));
            }
        }
        if Instant::now() >= next_ready {
            next_ready = Instant::now() + cfg.readiness;
            let progress = if db_failures > 2 {
                "degraded"
            } else if jobs.is_empty() {
                "idle"
            } else {
                "running"
            };
            readiness::emit(&snapshot_line(&ctx, progress));
        }
        // Wait for a wakeup notification, in short slices so that a finished
        // job, a signal or a due tick is noticed promptly.
        let mut lost = false;
        match listener.as_mut() {
            Some(l) => {
                let mut notes = l.notifications();
                let mut it = notes.timeout_iter(Duration::from_millis(250));
                match it.next() {
                    Ok(Some(_)) => {
                        wake = true;
                        while let Ok(Some(_)) = it.next() {}
                    }
                    Ok(None) => {}
                    Err(_) => lost = true,
                }
            }
            None => {
                std::thread::sleep(Duration::from_millis(250));
                listener = rpc.listener().ok();
            }
        }
        if lost {
            listener = None;
        }
    }
    readiness::emit(&snapshot_line(&ctx, "draining"));
    for h in jobs {
        let _ = h.join();
    }
    retry_pending(&ctx, &mut rpc);
    readiness::emit(&snapshot_line(&ctx, "draining"));
    line("stopped");
    0
}
