//! Paged reaper (build spec §1.3): `pq_reap(env, after_job, 100, worker_class)`
//! until `next_after_job_id` is null. An expired `/2` lease parks the job with
//! `last_error_code='exit_unconfirmed'`; it is never exit proof and never makes
//! the job claimable. Once the attempt's exit is confirmed a later reap moves
//! the parked job to queued (or dead when the budget is spent). A job still
//! parked unconfirmed after LEASE_SECONDS + one reaper tick raises an alarm.
//!
//! Restart-safe (cost-reduction plan P-086, migration 000026): the watch set
//! is rebuilt from the database on every tick (`pq_class_parked`), not only
//! from transitions this process saw, so a row parked before this daemon
//! started is still watched. A parked attempt this daemon's journal knows is
//! watched as before (the journal recovery can prove its exit). One it does
//! not know (the box that ran it is gone) prints `polis_jobs.alarm/1` with
//! `reason: exit_unproven` on every tick: nothing here invents proof from
//! elapsed time; an operator's recorded proof is the way out. Without 000026
//! the read does not exist and the rediscovery says so once and stays off.
use super::{
    readiness::{Counters, Transition, emit},
    rpc::{DbError, Rpc},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

/// SQLSTATE undefined_function: no `pq_class_parked` (000026 not applied).
const UNDEFINED_FUNCTION: &str = "42883";

pub struct Reaper {
    unconfirmed: BTreeMap<String, Instant>,
    alarm_after: Duration,
    rediscovery: bool,
}

impl Reaper {
    pub fn new(lease_seconds: u32, tick: Duration) -> Self {
        Self {
            unconfirmed: BTreeMap::new(),
            alarm_after: Duration::from_secs(u64::from(lease_seconds)) + tick,
            rediscovery: true,
        }
    }

    /// Rebuild the watch set from the database (P-086). `journal` holds the
    /// attempt ids this daemon's journal knows.
    pub fn rediscover(
        &mut self,
        rpc: &mut Rpc,
        worker_class: &str,
        owner: &str,
        journal: &BTreeSet<String>,
    ) -> anyhow::Result<usize> {
        if !self.rediscovery {
            return Ok(0);
        }
        let env = rpc.env().to_owned();
        let mut after: Value = Value::Null;
        let mut seen = 0;
        loop {
            let page = match rpc.committed(
                "pq_class_parked",
                &[json!(env), json!(worker_class), after.clone(), json!(100)],
            ) {
                Ok(p) => p,
                Err(e) => {
                    let missing = e
                        .downcast_ref::<DbError>()
                        .and_then(|d| d.sqlstate.as_deref())
                        == Some(UNDEFINED_FUNCTION);
                    if missing {
                        self.rediscovery = false;
                        emit(&format!(
                            "polis_jobs parked rediscovery off: the database has no pq_class_parked (migration 000026 is not applied); env={env}"
                        ));
                        return Ok(0);
                    }
                    return Err(e);
                }
            };
            for p in page["parked"].as_array().into_iter().flatten() {
                let unproven: Vec<&Value> =
                    p["unconfirmed"].as_array().into_iter().flatten().collect();
                if unproven.is_empty() {
                    continue;
                }
                seen += 1;
                let job = p["job_id"].as_str().unwrap_or_default().to_owned();
                let known = unproven.iter().all(|a| {
                    a["attempt_id"]
                        .as_str()
                        .is_some_and(|id| journal.contains(id))
                });
                if known {
                    // The journal recovery can prove it: watch as before.
                    self.unconfirmed.entry(job).or_insert_with(Instant::now);
                } else {
                    emit(
                        &json!({"schema": "polis_jobs.alarm/1", "alarm": "exit_unconfirmed",
                            "reason": "exit_unproven", "rediscovered": true,
                            "env": env, "job_id": job, "owner": owner,
                            "first_parked_at": p["first_parked_at"],
                            "attempts": unproven})
                        .to_string(),
                    );
                }
            }
            after = page["next_after_job_id"].clone();
            if after.is_null() {
                break;
            }
        }
        Ok(seen)
    }

    /// One full pass. Returns the number of transitions.
    pub fn tick(
        &mut self,
        rpc: &mut Rpc,
        worker_class: &str,
        owner: &str,
        counters: &Counters,
    ) -> anyhow::Result<usize> {
        let env = rpc.env().to_owned();
        let mut after: Value = Value::Null;
        let mut count = 0;
        loop {
            let page = rpc.committed(
                "pq_reap",
                &[json!(env), after.clone(), json!(100), json!(worker_class)],
            )?;
            for t in page["transitions"].as_array().into_iter().flatten() {
                count += 1;
                let job = t["job_id"].as_str().unwrap_or_default().to_owned();
                let state = t["state"].as_str().unwrap_or_default().to_owned();
                let code = t["last_error_code"].as_str().map(str::to_owned);
                if state == "parked" && code.as_deref() == Some("exit_unconfirmed") {
                    Counters::bump(&counters.exit_unconfirmed);
                    self.unconfirmed
                        .entry(job.clone())
                        .or_insert_with(Instant::now);
                }
                Transition {
                    env: env.clone(),
                    job_id: job.clone(),
                    run_id: t["run_id"].as_str().map(str::to_owned),
                    attempt_id: t["attempt_id"].as_str().map(str::to_owned),
                    stage: t["stage"].as_str().map(str::to_owned),
                    from: "reaper".into(),
                    to: state.clone(),
                    reason: code,
                    owner: owner.to_owned(),
                    ..Default::default()
                }
                .emit();
                // A job the reaper declared dead (every exit proven, or it
                // would not have) frees its scope.
                super::scope::after_terminal(rpc, counters, owner, &env, &job, &state);
            }
            after = page["next_after_job_id"].clone();
            if after.is_null() {
                break;
            }
        }
        self.alarms(rpc, &env, owner);
        Ok(count)
    }

    fn alarms(&mut self, rpc: &mut Rpc, env: &str, owner: &str) {
        let mut resolved = vec![];
        for (job, since) in &self.unconfirmed {
            let Ok(view) = rpc.committed("pd_job_view", &[json!(env), json!(job)]) else {
                continue;
            };
            let still = view["state"] == "parked"
                && view["last_error_code"] == "exit_unconfirmed"
                && view["last_attempt"]["process_exit_confirmed_at"].is_null();
            if !still {
                resolved.push(job.clone());
            } else if since.elapsed() >= self.alarm_after {
                emit(
                    &json!({"schema": "polis_jobs.alarm/1", "alarm": "exit_unconfirmed",
                        "env": env, "job_id": job, "owner": owner,
                        "parked_for_ms": since.elapsed().as_millis() as u64,
                        "last_attempt": view["last_attempt"]})
                    .to_string(),
                );
            }
        }
        for job in resolved {
            self.unconfirmed.remove(&job);
        }
    }
}
