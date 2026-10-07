//! The built-in queue sweep (cost-reduction plan P-083; migration 000026).
//! Retention runs inside the daemon, not as a child: no process is started
//! and no DSN is handed out. With `POLIS_JOBS_SWEEP=1` the main loop asks
//! `pq_sweep(env, sweep_id, page, max_pages)` for one bounded page at a
//! time, only when its claim pass found nothing to start (a sweep never goes
//! ahead of a job: the "lane 2" of the plan). Page 1 opens a sweep or is told
//! `not_due` (one sweep per 24 h per env, decided in SQL) or `busy` (another
//! daemon is sweeping); each later page follows the previous one; the last
//! page closes it and this module prints one `polis_jobs.sweep/1` line with
//! the counts. The SQL keeps the ledger (`polis_queue_sweeps`), its own
//! bounds and the retention policy: by reachability, with the rules as data
//! in `polis_queue_retention_policy`, every kind a dry run until an operator
//! updates it (the line then carries `would_<kind>` counts and nothing is
//! deleted), and deletion in two phases (tombstone, then purge after a
//! grace). A database without 000026 has no `pq_sweep`, and the sweep turns
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
                emit(&sweep_line(env, sweep_id, page, r, started.elapsed()).to_string());
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

/// The one `polis_jobs.sweep/1` line of a finished sweep: what it deleted,
/// what it tombstoned and restored, and, for every kind still a dry run,
/// what it would have deleted (`would_<kind>`; the SQL reports those on
/// page 1 only).
fn sweep_line(env: &str, sweep_id: &str, pages: u32, r: &Value, took: Duration) -> Value {
    let c = &r["counts"];
    let n = |k: &str| c[k].as_u64().unwrap_or(0);
    let mut line = json!({
        "schema": "polis_jobs.sweep/1",
        "env": env,
        "sweep_id": sweep_id,
        "pages": pages,
        "stopped_by": r["stopped_by"].as_str().unwrap_or_default(),
        "jobs_deleted": n("jobs_deleted"),
        "attempts_deleted": n("attempts_deleted"),
        "log_rows_deleted": n("log_rows_deleted"),
        "bindings_deleted": n("bindings_deleted"),
        "runs_deleted": n("runs_deleted"),
        "sweeps_deleted": n("sweeps_deleted"),
        "jobs_tombstoned": n("jobs_tombstoned"),
        "logs_tombstoned": n("logs_tombstoned"),
        "bindings_tombstoned": n("bindings_tombstoned"),
        "tombstones_restored": n("tombstones_restored"),
        "duration_ms": took.as_millis() as u64,
    });
    let would: serde_json::Map<String, Value> = c
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| k.starts_with("would_"))
        .map(|(k, v)| (k.clone(), json!(v.as_u64().unwrap_or(0))))
        .collect();
    line["dry_run"] = json!(!would.is_empty());
    line["would"] = Value::Object(would);
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dry_run_line_carries_the_would_counts_and_deletes_nothing() {
        let r = json!({"stopped_by": "", "counts": {"jobs_deleted": 0, "would_job_succeeded": 3,
            "would_logs_failed": 2, "jobs_tombstoned": 0}});
        let line = sweep_line("e", "s", 1, &r, Duration::from_millis(5));
        assert_eq!(line["dry_run"], true);
        assert_eq!(
            line["would"],
            json!({"would_job_succeeded": 3, "would_logs_failed": 2})
        );
        assert_eq!(line["jobs_deleted"], 0);
        assert_eq!(line["schema"], "polis_jobs.sweep/1");
    }

    #[test]
    fn a_deleting_line_has_no_would_counts() {
        let r = json!({"stopped_by": "budget", "counts": {"jobs_deleted": 4, "jobs_tombstoned": 7,
            "tombstones_restored": 1}});
        let line = sweep_line("e", "s", 3, &r, Duration::from_millis(5));
        assert_eq!(line["dry_run"], false);
        assert_eq!(line["would"], json!({}));
        assert_eq!(line["jobs_deleted"], 4);
        assert_eq!(line["jobs_tombstoned"], 7);
        assert_eq!(line["tombstones_restored"], 1);
        assert_eq!(line["stopped_by"], "budget");
    }
}
