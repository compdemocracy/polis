//! The loop: pace, pick, admit one, wait for it, record, rest.
//!
//! One run at a time: nothing is admitted while the last admission is not
//! terminal. Before each admission the scheduler pauses for the operator's
//! pause file, a disk below its floor, a slow database, a math engine that
//! trails the votes, the daily cap, or the storage budget (the bytes the
//! shadow has added to the database, in all and today, read once per run:
//! `storage`); after each run it rests for the duty cycle. It writes one `delphi_shadow/1` line per event on standard output:
//! job ids, counts, seconds, digests and closed words, never a comment or a
//! conversation id (the run record has those).
use super::{
    config::Config,
    db::{Db, Signals},
    plan::{self, Look, Pause},
    state::{InFlight, PendingTwin, State, TWIN_RESULTS_KEPT},
    storage::{MEASURE_PER_CYCLE, Pending},
    twin,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PREFIX: &str = "delphi_shadow/1";
pub const EXIT_CONFIG: i32 = 2;

/// SIGTERM and SIGINT set the daemon's own shutdown flag; the loop stops
/// before its next statement. Nothing is in flight on this side: a run that
/// is executing belongs to the daemon, which drains it on its own stop.
pub fn install_signal_handlers() {
    crate::jobs::shutdown::install();
}

pub fn stopping() -> bool {
    crate::jobs::shutdown::requested()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn log(event: &str, mut fields: Value) {
    if let Some(o) = fields.as_object_mut() {
        o.insert("event".into(), Value::String(event.into()));
    }
    println!("{PREFIX} {fields}");
}

/// Whether a run record was admitted under this scheduler's code version (the
/// deploy's source commit, which the daemon's image is built from).
pub fn same_build(cfg: &Config, record: Option<&Value>) -> bool {
    record
        .and_then(|r| r.get("code_version"))
        .and_then(Value::as_str)
        == Some(cfg.code_version.as_str())
}

/// Sleep in short steps so a stop is noticed within a second.
fn sleep(total: Duration) {
    let end = Instant::now() + total;
    while !stopping() {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left.min(Duration::from_secs(1)));
    }
}

/// What a waiting twin came to.
enum TwinStep {
    Nothing,
    Admitted,
    Held(Pause),
}

pub struct Scheduler<'a> {
    pub cfg: &'a Config,
    pub db: Db<'a>,
    pub state: State,
    pub paused: Option<Pause>,
    pub rest_until_ms: i64,
}

impl<'a> Scheduler<'a> {
    pub fn new(cfg: &'a Config) -> Result<Self> {
        let state = State::load(&cfg.state_path, &cfg.env)?;
        Ok(Self {
            cfg,
            db: Db::new(cfg),
            state,
            paused: None,
            rest_until_ms: 0,
        })
    }

    fn save(&self) {
        if let Err(e) = self.state.save(&self.cfg.state_path) {
            log("state_unwritten", json!({"error": e.to_string()}));
        }
    }

    /// Run until stopped. Errors of one cycle are logged and the cycle is
    /// tried again after the poll interval; nothing is retried faster.
    pub fn run(&mut self) -> i32 {
        log(
            "started",
            json!({"env": self.cfg.env, "min_comments": self.cfg.min_comments,
                   "max_comments": self.cfg.max_comments, "daily_runs": self.cfg.daily_runs,
                   "twin_every": self.cfg.twin_every, "duty_cycle": self.cfg.duty_cycle}),
        );
        while !stopping() {
            let wait = match self.cycle() {
                Ok(wait) => wait,
                Err(e) => {
                    log("cycle_failed", json!({"error": e.to_string()}));
                    self.cfg.poll
                }
            };
            self.save();
            sleep(wait);
        }
        log("stopped", json!({"totals": self.state.totals}));
        0
    }

    /// One step of the loop; returns how long to wait before the next.
    pub fn cycle(&mut self) -> Result<Duration> {
        let now = now_ms();
        self.state.roll_day(now);
        self.reconcile_storage()?;
        self.measure_pending(now);
        if let Some(flight) = self.state.in_flight.clone() {
            return self.watch(flight, now);
        }
        if now < self.rest_until_ms {
            return Ok(Duration::from_millis((self.rest_until_ms - now) as u64));
        }
        let held = match self.pace() {
            Some(reason) => Some(reason),
            None => self.pick_and_admit(now)?,
        };
        if let Some(reason) = held {
            if self.paused != Some(reason) {
                let l = &self.state.storage;
                log(
                    "paused",
                    json!({"reason": reason.word(), "storage_bytes": l.bytes,
                           "storage_day_bytes": l.day_bytes,
                           "storage_budget_bytes": self.cfg.storage_budget_bytes,
                           "storage_daily_bytes": self.cfg.storage_daily_bytes,
                           "storage_unmeasured": l.pending.len()}),
                );
            }
            self.paused = Some(reason);
            return Ok(self.cfg.poll);
        }
        self.resume();
        Ok(if self.state.in_flight.is_some() {
            self.cfg.job_poll
        } else {
            self.cfg.poll
        })
    }

    fn resume(&mut self) {
        if let Some(was) = self.paused.take() {
            log("resumed", json!({"after": was.word()}));
        }
    }

    /// A state file with no record of the shadow's bytes (the first start, a
    /// new volume, a lost file): every job of every shadow env is listed from
    /// the database, once, to be measured before anything is admitted.
    fn reconcile_storage(&mut self) -> Result<()> {
        if self.state.storage.reconciled {
            return Ok(());
        }
        let jobs = self.db.shadow_jobs()?;
        log("storage_listed", json!({"jobs": jobs.len()}));
        self.state.storage.pending = jobs;
        self.state.storage.reconciled = true;
        Ok(())
    }

    /// Read the bytes of the terminal runs not yet measured, a few per poll.
    /// One that cannot be read stays pending (and holds admission).
    fn measure_pending(&mut self, now: i64) {
        for _ in 0..MEASURE_PER_CYCLE {
            let Some(p) = self.state.storage.pending.first().cloned() else {
                return;
            };
            match self.db.measure(&p) {
                Ok(m) => {
                    self.state.storage.add(now, p.comments, m.total());
                    self.state.storage.pending.remove(0);
                    let l = &self.state.storage;
                    log(
                        "storage",
                        json!({"job_id": p.job_id, "comments": p.comments, "bytes": m.total(),
                               "measured": m, "storage_bytes": l.bytes,
                               "storage_day_bytes": l.day_bytes,
                               "storage_budget_bytes": self.cfg.storage_budget_bytes,
                               "storage_daily_bytes": self.cfg.storage_daily_bytes,
                               "bytes_per_comment": l.bytes_per_comment()}),
                    );
                }
                Err(e) => {
                    log(
                        "storage_unread",
                        json!({"job_id": p.job_id, "error": e.to_string()}),
                    );
                    return;
                }
            }
        }
    }

    fn pace(&self) -> Option<Pause> {
        let operator = self.cfg.pause_file.exists();
        let disk = plan::disk(&self.cfg.disk_path).ok();
        let signals: Option<Signals> = if operator {
            None
        } else {
            match self.db.signals() {
                Ok(s) => Some(s),
                Err(e) => {
                    log("signals_unread", json!({"error": e.to_string()}));
                    None
                }
            }
        };
        plan::pause(
            self.cfg,
            &self.state,
            operator,
            disk,
            signals.as_ref(),
            self.paused,
        )
    }

    /// Admit the next run, or say why not: `Some` when the storage budget
    /// holds the next run back.
    fn pick_and_admit(&mut self, now: i64) -> Result<Option<Pause>> {
        match self.admit_twin(now)? {
            TwinStep::Admitted => return Ok(None),
            TwinStep::Held(reason) => return Ok(Some(reason)),
            TwinStep::Nothing => {}
        }
        let since = now - self.cfg.live_days as i64 * 86_400_000;
        let live = self.db.live(since)?;
        let (mut small, mut large) = (0u64, 0u64);
        for l in &live {
            match plan::look(self.cfg, &self.state, l, now) {
                Look::TooSmall => small += 1,
                Look::TooLarge => large += 1,
                _ => {}
            }
        }
        let candidates = plan::order(self.cfg, &self.state, &live, now);
        for candidate in candidates {
            let set = self.db.comment_set(candidate.zid)?;
            let seen = self.state.conversations.entry(candidate.zid).or_default();
            let unchanged = seen.admitted_digest.as_deref() == Some(set.digest.as_str());
            seen.last_modified = candidate.last_modified;
            seen.digest = set.digest.clone();
            seen.comments = set.comments;
            if unchanged {
                // The set is the one already run: a run now would recompute
                // what is stored.
                self.state.totals.unchanged += 1;
                log(
                    "unchanged",
                    json!({"comments": set.comments,
                    "size_class": plan::size_class(set.comments), "digest": set.digest}),
                );
                continue;
            }
            if set.comments < self.cfg.min_comments || set.comments > self.cfg.max_comments {
                continue;
            }
            // Candidates go smallest first: when this one does not fit, none
            // after it does.
            if let Some(reason) = plan::storage_room(self.cfg, &self.state.storage, set.comments) {
                return Ok(Some(reason));
            }
            let request = plan::admission(candidate.zid, &set.digest, set.comments, None);
            self.admit(request, set.comments, None, now)?;
            return Ok(None);
        }
        self.state.totals.too_small = small;
        self.state.totals.too_large = large;
        log(
            "idle",
            json!({"live": live.len(), "too_small": small, "too_large": large}),
        );
        Ok(None)
    }

    fn admit(
        &mut self,
        request: super::db::Admission,
        comments: i64,
        twin_of: Option<String>,
        now: i64,
    ) -> Result<()> {
        self.resume();
        let reply = self.db.admit(&request)?;
        let digest = request.config["shadow"]["comment_set_sha256"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let Some((outcome, job_id)) = plan::admitted_job(&reply) else {
            log(
                "refused",
                json!({"outcome": reply.get("outcome"), "comments": comments}),
            );
            // Do not try the same set again until its comments change.
            let seen = self.state.conversations.entry(request.zid).or_default();
            seen.admitted_digest = Some(digest);
            seen.admitted_at_ms = Some(now);
            seen.outcome = reply
                .get("outcome")
                .and_then(Value::as_str)
                .map(str::to_owned);
            return Ok(());
        };
        let seen = self.state.conversations.entry(request.zid).or_default();
        seen.admitted_digest = Some(digest.clone());
        seen.admitted_at_ms = Some(now);
        seen.job_id = Some(job_id.clone());
        seen.outcome = None;
        if twin_of.is_some() {
            self.state.totals.twins_admitted += 1;
        } else {
            self.state.totals.admitted += 1;
        }
        self.state.day_runs += 1;
        log(
            "admitted",
            json!({"job_id": job_id, "outcome": outcome, "comments": comments,
                   "size_class": plan::size_class(comments), "digest": digest, "twin_of": twin_of}),
        );
        self.state.in_flight = Some(InFlight {
            zid: request.zid,
            job_id,
            digest,
            comments,
            admitted_at_ms: now,
            twin_of,
        });
        Ok(())
    }

    fn watch(&mut self, flight: InFlight, now: i64) -> Result<Duration> {
        let state = self.db.job_state(&flight.job_id)?;
        let terminal = matches!(
            state.as_deref(),
            Some("succeeded" | "dead" | "cancelled") | None
        );
        let overdue = now - flight.admitted_at_ms > self.cfg.job_deadline.as_millis() as i64;
        if !terminal && !overdue {
            return Ok(self.cfg.job_poll);
        }
        let record = self.db.run_record(&flight.job_id)?;
        let outcome = state.clone().unwrap_or_else(|| "missing".into());
        let census = record
            .as_ref()
            .and_then(|r| r.pointer("/manifest/inputs/comment_set_sha256"))
            .and_then(Value::as_str);
        let attempt = record.as_ref().and_then(|r| r.get("attempt")).cloned();
        let families = record
            .as_ref()
            .and_then(|r| r.get("families"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let run_ms = now - flight.admitted_at_ms;
        log(
            "finished",
            json!({"job_id": flight.job_id, "state": outcome, "overdue": overdue && !terminal,
                   "comments": flight.comments, "size_class": plan::size_class(flight.comments),
                   "seconds_since_admission": run_ms as f64 / 1000.0,
                   "attempt": attempt, "families": families,
                   "census_digest_matches": census.map(|c| c == flight.digest),
                   "twin_of": flight.twin_of}),
        );
        if let Some(seen) = self.state.conversations.get_mut(&flight.zid) {
            seen.outcome = Some(outcome.clone());
        }
        if outcome == "succeeded" {
            self.state.totals.succeeded += 1;
        } else if terminal {
            self.state.totals.failed += 1;
        }
        // Its bytes are read before the next admission, whatever its state:
        // a failed attempt's rows stay too. (Past its deadline and still
        // running, what it writes after this is not counted.)
        self.state.storage.pending.push(Pending {
            env: self.cfg.env.clone(),
            job_id: flight.job_id.clone(),
            zid: flight.zid,
            comments: flight.comments,
        });
        self.state.in_flight = None;
        self.after_run(&flight, &outcome, record.as_ref())?;
        self.rest_until_ms = now + plan::rest_ms(self.cfg.duty_cycle, run_ms);
        Ok(
            Duration::from_millis((self.rest_until_ms - now).max(0) as u64)
                .max(Duration::from_secs(1)),
        )
    }

    /// A twin waiting for admission goes before any new set. It is admitted
    /// only on the same comment set as its first run; a set that changed in
    /// between drops it (and the next first run on the new set may get one).
    fn admit_twin(&mut self, now: i64) -> Result<TwinStep> {
        let Some(pending) = self.state.pending_twin.clone() else {
            return Ok(TwinStep::Nothing);
        };
        if pending.twin_job_id.is_some() {
            return Ok(TwinStep::Nothing);
        }
        let set = self.db.comment_set(pending.zid)?;
        if set.digest != pending.digest {
            log(
                "twin_dropped",
                json!({"first_job_id": pending.first_job_id, "reason": "comment_set_changed"}),
            );
            self.state.pending_twin = None;
            return Ok(TwinStep::Nothing);
        }
        // A deploy since the first run (a new image, a new scheduler) would
        // make the pair measure two builds, not one build's repeatability.
        let first = self.db.run_record(&pending.first_job_id)?;
        if !same_build(self.cfg, first.as_ref()) {
            log(
                "twin_dropped",
                json!({"first_job_id": pending.first_job_id, "reason": "code_version_changed"}),
            );
            self.state.pending_twin = None;
            return Ok(TwinStep::Nothing);
        }
        // The twin waits, kept, while the budget holds it back.
        if let Some(reason) = plan::storage_room(self.cfg, &self.state.storage, set.comments) {
            return Ok(TwinStep::Held(reason));
        }
        let request = plan::admission(
            pending.zid,
            &set.digest,
            set.comments,
            Some(&pending.first_job_id),
        );
        self.admit(
            request,
            set.comments,
            Some(pending.first_job_id.clone()),
            now,
        )?;
        match self.state.in_flight.as_ref() {
            Some(flight) if flight.twin_of.as_deref() == Some(pending.first_job_id.as_str()) => {
                if let Some(p) = self.state.pending_twin.as_mut() {
                    p.twin_job_id = Some(flight.job_id.clone());
                }
            }
            _ => self.state.pending_twin = None,
        }
        Ok(TwinStep::Admitted)
    }

    /// What follows a terminal run: a first run that succeeded may get a twin
    /// (its clustering is kept to compare with); a twin that succeeded is
    /// compared with its first run.
    fn after_run(
        &mut self,
        flight: &InFlight,
        outcome: &str,
        record: Option<&Value>,
    ) -> Result<()> {
        match &flight.twin_of {
            None if outcome == "succeeded" => {
                self.state.first_runs_succeeded += 1;
                if plan::twin_due(self.cfg.twin_every, self.state.first_runs_succeeded) {
                    let assignments = self.db.assignments(flight.zid)?;
                    self.state.pending_twin = Some(PendingTwin {
                        zid: flight.zid,
                        first_job_id: flight.job_id.clone(),
                        digest: flight.digest.clone(),
                        comments: flight.comments,
                        assignments,
                        twin_job_id: None,
                    });
                }
            }
            None => {}
            Some(first) => {
                let pending = self.state.pending_twin.take();
                let Some(pending) = pending.filter(|p| &p.first_job_id == first) else {
                    return Ok(());
                };
                if outcome != "succeeded" {
                    log(
                        "twin_failed",
                        json!({"first_job_id": first, "twin_job_id": flight.job_id, "state": outcome}),
                    );
                    return Ok(());
                }
                let first_record = self.db.run_record(first)?.unwrap_or(Value::Null);
                let twin_record = record.cloned().unwrap_or(Value::Null);
                // Both runs admitted by this scheduler's build: a deploy while
                // the twin was queued or running would compare two builds.
                if !same_build(self.cfg, Some(&first_record))
                    || !same_build(self.cfg, Some(&twin_record))
                {
                    log(
                        "twin_dropped",
                        json!({"first_job_id": first, "twin_job_id": flight.job_id,
                               "reason": "code_version_changed"}),
                    );
                    return Ok(());
                }
                let twin_rows = self.db.assignments(flight.zid)?;
                let comparison = twin::compare(
                    &first_record,
                    &twin_record,
                    &pending.assignments,
                    &twin_rows,
                );
                self.state.totals.twins_compared += 1;
                if comparison.identical {
                    self.state.totals.twins_identical += 1;
                }
                let line = json!({"first_job_id": first, "twin_job_id": flight.job_id,
                    "comments": flight.comments, "size_class": plan::size_class(flight.comments),
                    "digest": flight.digest, "comparison": comparison});
                log("twin", line.clone());
                self.state.twin_results.push(line);
                let excess = self
                    .state
                    .twin_results
                    .len()
                    .saturating_sub(TWIN_RESULTS_KEPT);
                self.state.twin_results.drain(..excess);
            }
        }
        Ok(())
    }
}
