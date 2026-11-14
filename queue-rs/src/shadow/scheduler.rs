//! The loop: pace, pick, admit one, wait for it, record, rest.
//!
//! One run at a time: nothing is admitted while the last admission is not
//! terminal. Before each admission the scheduler pauses for the operator's
//! pause file, a disk below its floor, a slow database, a math engine that
//! trails the votes, or the daily cap; after each run it rests for the duty
//! cycle. It writes one `delphi_shadow/1` line per event on standard output:
//! job ids, counts, seconds, digests and closed words, never a comment or a
//! conversation id (the run record has those).
use super::{
    config::Config,
    db::{Db, Signals},
    plan::{self, Look, Pause},
    state::{InFlight, Seen, State},
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
        if let Some(flight) = self.state.in_flight.clone() {
            return self.watch(flight, now);
        }
        if now < self.rest_until_ms {
            return Ok(Duration::from_millis((self.rest_until_ms - now) as u64));
        }
        if let Some(reason) = self.pace() {
            if self.paused != Some(reason) {
                log("paused", json!({"reason": reason.word()}));
            }
            self.paused = Some(reason);
            return Ok(self.cfg.poll);
        }
        if let Some(was) = self.paused.take() {
            log("resumed", json!({"after": was.word()}));
        }
        self.pick_and_admit(now)?;
        Ok(if self.state.in_flight.is_some() {
            self.cfg.job_poll
        } else {
            self.cfg.poll
        })
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

    fn pick_and_admit(&mut self, now: i64) -> Result<()> {
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
            let request = plan::admission(candidate.zid, &set.digest, set.comments, None);
            return self.admit(request, set.comments, None, now);
        }
        self.state.totals.too_small = small;
        self.state.totals.too_large = large;
        log(
            "idle",
            json!({"live": live.len(), "too_small": small, "too_large": large}),
        );
        Ok(())
    }

    fn admit(
        &mut self,
        request: super::db::Admission,
        comments: i64,
        twin_of: Option<String>,
        now: i64,
    ) -> Result<()> {
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
        self.state.in_flight = None;
        self.after_run(&flight, &outcome, record.as_ref())?;
        self.rest_until_ms = now + plan::rest_ms(self.cfg.duty_cycle, run_ms);
        Ok(
            Duration::from_millis((self.rest_until_ms - now).max(0) as u64)
                .max(Duration::from_secs(1)),
        )
    }

    /// What follows a terminal run (the twin runs hook in here).
    fn after_run(
        &mut self,
        _flight: &InFlight,
        _outcome: &str,
        _record: Option<&Value>,
    ) -> Result<()> {
        Ok(())
    }
}

/// For tests: whether a conversation's recorded state says it was admitted on
/// this digest.
pub fn admitted_on(seen: Option<&Seen>, digest: &str) -> bool {
    seen.and_then(|s| s.admitted_digest.as_deref()) == Some(digest)
}
