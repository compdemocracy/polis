//! The built-in queue sweep (cost-reduction plan P-083; migration 000026).
//! Retention runs inside the daemon, not as a child: no process is started
//! and no DSN is handed out. With `POLIS_JOBS_SWEEP=1` the main loop asks
//! `pq_sweep(env, sweep_id, page, max_pages)` for one bounded page at a
//! time, only when its claim pass found nothing to start (a sweep never goes
//! ahead of a job: the "lane 2" of the plan). Page 1 opens a sweep or is told
//! `not_due` (one sweep per 24 h per env, decided in SQL) or `busy` (another
//! daemon is sweeping); each later page follows the previous one; the last
//! page closes it and this module prints one `polis_jobs.sweep/1` line with
//! the counts. The SQL keeps the ledger (`polis_queue_sweeps`) and its own
//! bounds; a database without 000026 has no `pq_sweep`, and the sweep turns
//! itself off for this process with one line saying so.
use super::{readiness::emit, rpc::Rpc};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// SQLSTATE undefined_function: the database has no `pq_sweep` (000026 not
/// applied).
const UNDEFINED_FUNCTION: &str = "42883";

pub struct Sweeper {
    enabled: bool,
    max_pages: u32,
    check_every: Duration,
    next_check: Instant,
    active: Option<Active>,
}

struct Active {
    sweep_id: String,
    page: u32,
    started: Instant,
}

impl Sweeper {
    pub fn new(enabled: bool, max_pages: u32, check_every: Duration) -> Self {
        Self {
            enabled,
            max_pages,
            check_every,
            next_check: Instant::now(),
            active: None,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// At most one page. `idle` is true when the claim pass found nothing
    /// to start (or the worker is at its concurrency).
    pub fn tick(&mut self, rpc: &mut Rpc, idle: bool) {
        if !self.enabled || !idle {
            return;
        }
        let (sweep_id, page) = match &self.active {
            Some(a) => (a.sweep_id.clone(), a.page + 1),
            None if Instant::now() >= self.next_check => (Uuid::new_v4().to_string(), 1),
            None => return,
        };
        let env = rpc.env().to_owned();
        let reply = rpc.committed(
            "pq_sweep",
            &[
                json!(env),
                json!(sweep_id),
                json!(page),
                json!(self.max_pages),
            ],
        );
        match reply {
            Ok(r) => self.answer(&env, &sweep_id, page, &r),
            Err(e) => {
                let missing = e
                    .downcast_ref::<super::rpc::DbError>()
                    .and_then(|d| d.sqlstate.as_deref())
                    == Some(UNDEFINED_FUNCTION);
                if missing {
                    self.enabled = false;
                    emit(&format!(
                        "polis_jobs sweep off: the database has no pq_sweep (migration 000026 is not applied); env={env}"
                    ));
                } else {
                    // The SQL closes an unfinished sweep as abandoned after
                    // an hour; this process asks again at the next check.
                    emit(&format!(
                        "polis_jobs sweep page {page} of {sweep_id} failed: {e}"
                    ));
                }
                self.active = None;
                self.next_check = Instant::now() + self.check_every;
            }
        }
    }

    fn answer(&mut self, env: &str, sweep_id: &str, page: u32, r: &Value) {
        match r["outcome"].as_str() {
            Some("sweep_page") => {
                let started = self
                    .active
                    .as_ref()
                    .map_or_else(Instant::now, |a| a.started);
                self.active = Some(Active {
                    sweep_id: sweep_id.to_owned(),
                    page,
                    started,
                });
            }
            Some("sweep_done") => {
                let started = self
                    .active
                    .as_ref()
                    .map_or_else(Instant::now, |a| a.started);
                let c = &r["counts"];
                let n = |k: &str| c[k].as_u64().unwrap_or(0);
                emit(
                    &json!({
                        "schema": "polis_jobs.sweep/1",
                        "env": env,
                        "sweep_id": sweep_id,
                        "pages": page,
                        "stopped_by": r["stopped_by"].as_str().unwrap_or_default(),
                        "jobs_deleted": n("jobs_deleted"),
                        "attempts_deleted": n("attempts_deleted"),
                        "log_rows_deleted": n("log_rows_deleted"),
                        "bindings_deleted": n("bindings_deleted"),
                        "runs_deleted": n("runs_deleted"),
                        "sweeps_deleted": n("sweeps_deleted"),
                        "duration_ms": started.elapsed().as_millis() as u64,
                    })
                    .to_string(),
                );
                self.active = None;
                self.next_check = Instant::now() + self.check_every;
            }
            // not_due, busy, or anything else: nothing to do until the next
            // check.
            _ => {
                self.active = None;
                self.next_check = Instant::now() + self.check_every;
            }
        }
    }
}
