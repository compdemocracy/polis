//! The loop: pace, pick, admit one, wait for it, record, rest.
//!
//! One run at a time: nothing is admitted while the last admission is not
//! terminal. Before each admission the scheduler pauses for the operator's
//! pause file, a disk below its floor, a slow database, a math engine that
//! trails the votes, the daily cap, or the storage budget (the bytes the
//! shadow has added to the database, in all and, when a daily limit is set,
//! today, read once per run:
//! `storage`); after each run it rests for the duty cycle. It picks from three
//! named sets in priority order (`plan::Set`): the benchmark set
//! (`DELPHI_SHADOW_BENCHMARK`, in its order), the featured set (the open-data
//! conversations, most participants first), both whatever their recent
//! activity and read once a day (`Roster`), then the current set, the live
//! conversations whose comment set changed. The benchmark and featured sets
//! together (and twins) spend the budget less the live reserve
//! (`DELPHI_SHADOW_LIVE_RESERVE_MB`); the current set may spend all of it. It
//! writes one `delphi_shadow/1` line per event on standard output: job ids,
//! counts, seconds, digests and closed words, never a comment, a conversation
//! code or a conversation id (the run record has the id). Every line about a
//! run names its set (`"set"`: `benchmark`, `featured` or `current`; a twin,
//! its first run's), as its run record does (`config_effective.shadow.set`).
//! When a comment-rule list is set (`DELPHI_SHADOW_ALL_COMMENTS`,
//! `DELPHI_SHADOW_ALL_BUT_MODERATED_OUT`), a conversation it names also runs
//! under that list's rule, after the conversations' own runs, each
//! (conversation, rule) its own job in its own publication scope; the lines
//! about those runs name their `selection`.
//! One kind of line goes to standard error instead, beginning `Error:`
//! (`error`): a graph cancelled after an executor claimed it (`graph`). It
//! keeps the same rule: it names the graph and the conversation's position in
//! `DELPHI_SHADOW_GRAPH_CONVERSATIONS` ("entry 2"), never its code, which is
//! the conversation's address. Both output streams go to the same log.
use super::{
    backfill::{self, Admitter, Backfill, Held},
    config::{Config, SCOPE, Share},
    db::{Admission, Db, Live, Signals},
    plan::{self, Look, Pause, Set, rule_word},
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
    let line = format!("{PREFIX} {fields}");
    keep(&line);
    println!("{line}");
}

/// One line on standard error beginning `Error:`, for what an operator must
/// see though nothing stops on it. The module's rule holds for it too: no
/// comment, no conversation code, no conversation id.
pub fn error(text: &str) {
    let line = format!("Error: {text}");
    keep(&line);
    eprintln!("{line}");
}

thread_local! {
    /// The lines `log` and `error` wrote on this thread, kept only once a
    /// test has asked for them (`keep_lines`); `None`, and never filled,
    /// otherwise.
    static KEPT: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

fn keep(line: &str) {
    KEPT.with(|k| {
        if let Some(lines) = k.borrow_mut().as_mut() {
            lines.push(line.to_owned());
        }
    });
}

/// For tests: from now on keep every line this thread's scheduler writes,
/// as well as writing it, so that a test can read them back (`kept_lines`).
#[doc(hidden)]
pub fn keep_lines() {
    KEPT.with(|k| *k.borrow_mut() = Some(Vec::new()));
}

/// For tests: the lines kept on this thread since `keep_lines` or the last
/// call, oldest first.
#[doc(hidden)]
pub fn kept_lines() -> Vec<String> {
    KEPT.with(|k| {
        k.borrow_mut()
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default()
    })
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

/// The two sets read whatever their recent activity, read at the start and
/// once each UTC day: the benchmark set in the list's order, and the featured
/// set (the open-data conversations), most participants first. Between reads each
/// entry takes this cycle's live read when it has one (`plan::overlay`), so a
/// change to one of them is seen at the next poll without reading the roster
/// again.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Roster {
    /// The UTC day (days since the epoch) it was read on.
    pub day: i64,
    pub benchmark: Vec<Live>,
    pub featured: Vec<Live>,
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
    /// The benchmark and featured sets, once read (`Roster`).
    pub roster: Option<Roster>,
    /// When a roster read last failed: the next is tried after
    /// `roster_retry`, so a failing read is not repeated every poll.
    pub roster_failed_at_ms: Option<i64>,
    pub(super) graph_failed_at_ms: Option<i64>,
    pub(super) graph_provenance: Option<(String, Value)>,
    pub(super) graph_list_counts: Option<(usize, usize)>,
    pub(super) graph_wait_bucket: Option<i64>,
    /// The deferred graphs the last `graph_admission_held` line named.
    pub(super) graph_held: Option<String>,
    /// The comment rules the lists add, once their codes are resolved
    /// (`rules`), with the UTC day they were resolved on. In memory only:
    /// resolved again at every start.
    pub rules: Option<(i64, plan::Rules)>,
    /// When resolving the lists last failed (`rules`).
    pub rules_failed_at_ms: Option<i64>,
    /// Per (conversation, rule): the newest comment change at which this
    /// process found nothing to run, and the newest run it found then
    /// (`plan::rule_look`). Memory only, never written: it saves reading a
    /// census again; the decision itself is the run history in Postgres.
    pub rules_checked: std::collections::BTreeMap<(i32, &'static str), (i64, String)>,
    /// The derived-map backfill (`backfill`): its admitter and its memory.
    pub derived: Backfill<'a>,
    /// The conversations of the three sets this cycle read, when it reached
    /// the end of its candidates (memory only; with the backfill on).
    pub(super) sets_seen: Option<Vec<i32>>,
}

impl<'a> Scheduler<'a> {
    pub fn new(cfg: &'a Config) -> Result<Self> {
        let state = State::load(&cfg.state_path, &cfg.env)?;
        let mut scheduler = Self {
            cfg,
            db: Db::new(cfg),
            state,
            paused: None,
            rest_until_ms: 0,
            roster: None,
            roster_failed_at_ms: None,
            graph_failed_at_ms: None,
            graph_provenance: None,
            graph_list_counts: None,
            graph_wait_bucket: None,
            graph_held: None,
            rules: None,
            rules_failed_at_ms: None,
            rules_checked: Default::default(),
            derived: Backfill::new(None),
            sets_seen: None,
        };
        scheduler.recover_graph()?;
        Ok(scheduler)
    }

    /// The derived jobs' admission, for the backfill (`backfill`). Without
    /// it the backfill asks nothing, whatever its switch.
    pub fn with_admitter(mut self, admitter: Box<dyn Admitter + 'a>) -> Self {
        self.derived = Backfill::new(Some(admitter));
        self
    }

    fn save(&self) {
        if let Err(e) = self.state.save(&self.cfg.state_path) {
            log("state_unwritten", json!({"error": e.to_string()}));
        }
    }

    /// Run until stopped. Errors of one cycle are logged and the cycle is
    /// tried again after the poll interval; nothing is retried faster.
    pub fn run(&mut self) -> i32 {
        let mut started = json!({"env": self.cfg.env, "min_comments": self.cfg.min_comments,
               "max_comments": self.cfg.max_comments, "daily_runs": self.cfg.daily_runs,
               "twin_every": self.cfg.twin_every, "duty_cycle": self.cfg.duty_cycle,
               "benchmark": self.cfg.benchmark.len(),
               "storage_budget_bytes": self.cfg.storage_budget_bytes,
               "storage_live_reserve_bytes": self.cfg.storage_live_reserve_bytes,
               "storage_daily_bytes": self.cfg.storage_daily_log()});
        // A list is named only when it is set, so without them the line is
        // what it was.
        for list in self.cfg.rule_lists.iter().filter(|l| !l.codes.is_empty()) {
            started[rule_word(list.selection)] = list.codes.len().into();
        }
        // Named only when the backfill is on, so off the line is what it was.
        if self.cfg.derived.enabled {
            let d = &self.cfg.derived;
            started["derived_backfill"] = json!({"per_cycle": d.per_cycle, "daily": d.daily,
                "every_seconds": d.every.as_secs(), "page": backfill::PAGE,
                "pages_per_cycle": backfill::PAGES_PER_CYCLE,
                "admitter": self.derived.admitter.is_some(),
                "admission": self.derived.admitter.as_ref().is_some_and(|a| a.switched_on())});
        }
        log("started", started);
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
        self.sets_seen = None;
        self.state.roll_day(now);
        self.reconcile_storage()?;
        self.measure_pending(now);
        self.poll_deferred_graph(now)?;
        self.recover_graph()?;
        if let Some(flight) = self.state.graph_flight.clone() {
            return self.watch_graph(flight, now);
        }
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
                           "storage_live_reserve_bytes": self.cfg.storage_live_reserve_bytes,
                           "storage_daily_bytes": self.cfg.storage_daily_log(),
                           "storage_unmeasured": l.pending.len()}),
                );
            }
            self.paused = Some(reason);
            self.derived_step(now, Some(reason));
            return Ok(self.cfg.poll);
        }
        self.resume();
        self.derived_step(now, None);
        Ok(
            if self.state.in_flight.is_some() || self.state.graph_flight.is_some() {
                self.cfg.job_poll
            } else {
                self.cfg.poll
            },
        )
    }

    /// The backfill's turn, after the cycle's own (`backfill`): it may ask
    /// only when no full run is running or was admitted this cycle, none is
    /// held by a pause, and no pause but the full runs' daily cap
    /// permits. With the switch off it returns at once and reads nothing;
    /// with the admission's switch off it says so and reads nothing either.
    fn derived_step(&mut self, now: i64, held_by: Option<Pause>) {
        let Some(admission) = self.derived.admitter.as_ref().map(|a| a.switched_on()) else {
            return;
        };
        if !self.cfg.derived.enabled {
            return;
        }
        if !admission {
            let off = Some(Held::AdmissionOff);
            return self.derived.step(self.cfg, &self.db, &[], now, off);
        }
        let held = if self.state.in_flight.is_some() || self.state.graph_flight.is_some() {
            Some(Held::FullRun)
        } else {
            match held_by {
                None => None,
                // Full runs are done for the day: the backfill pauses for the rest.
                Some(Pause::DailyCap) => self.derived_pauses().map(Held::Paused),
                // A benchmark or featured run waits on the live reserve.
                Some(Pause::StorageReserve) => Some(Held::FullRun),
                Some(p) => Some(Held::Paused(p)),
            }
        };
        if held.is_some() {
            return self.derived.step(self.cfg, &self.db, &[], now, held);
        }
        let zids = match self.sets_seen.take() {
            Some(z) => z,
            None => {
                self.refresh_roster(now);
                let since = now - self.cfg.live_days as i64 * 86_400_000;
                let Ok(live) = self.db.live(since) else {
                    log("derived_unread", json!({"reason": "sets"}));
                    return;
                };
                let roster = self.roster.clone().unwrap_or_default();
                roster
                    .benchmark
                    .iter()
                    .chain(roster.featured.iter())
                    .chain(live.iter())
                    .map(|l| l.zid)
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect()
            }
        };
        self.derived.step(self.cfg, &self.db, &zids, now, None);
    }

    /// Every pause of `pace` but the full runs' daily cap.
    fn derived_pauses(&self) -> Option<Pause> {
        let operator = self.cfg.pause_file.exists();
        let disk = plan::disk(&self.cfg.disk_path).ok();
        let signals = if operator {
            None
        } else {
            self.db.signals().ok()
        };
        plan::derived_pause(
            self.cfg,
            &self.state,
            operator,
            disk,
            signals.as_ref(),
            self.paused,
        )
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
        if let Some(flight) = &self.state.graph_flight {
            self.state.storage.pending.retain(|p| {
                p.env != flight.env || !flight.nodes.iter().any(|n| n.job_id == p.job_id)
            });
        }
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
                        json!({"job_id": p.job_id, "comments": p.comments, "set": p.set,
                               "bytes": m.total(),
                               "measured": m, "storage_bytes": l.bytes,
                               "storage_day_bytes": l.day_bytes,
                               "storage_budget_bytes": self.cfg.storage_budget_bytes,
                               "storage_live_reserve_bytes": self.cfg.storage_live_reserve_bytes,
                               "storage_daily_bytes": self.cfg.storage_daily_log(),
                               "bytes_per_comment": l.bytes_per_comment()}),
                    );
                }
                Err(e) => {
                    log(
                        "storage_unread",
                        json!({"job_id": p.job_id, "set": p.set, "error": e.to_string()}),
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

    /// Read the roster at the start and on a new UTC day. A read that fails
    /// keeps the roster there is (none at the start: the current set still
    /// runs) and is tried again after `roster_retry`.
    fn refresh_roster(&mut self, now: i64) {
        let day = now.div_euclid(86_400_000);
        if self.roster.as_ref().is_some_and(|r| r.day == day) {
            return;
        }
        if let Some(at) = self.roster_failed_at_ms
            && now - at < self.cfg.roster_retry.as_millis() as i64
        {
            return;
        }
        let read = self
            .db
            .roster(&self.cfg.benchmark)
            .map(|(benchmark, featured)| Roster {
                day,
                benchmark,
                featured,
            });
        match read {
            Ok(roster) => {
                // Counts only: never a code or a conversation id.
                log(
                    "roster",
                    json!({"benchmark": self.cfg.benchmark.len(),
                           "benchmark_found": roster.benchmark.len(),
                           "featured": roster.featured.len()}),
                );
                self.roster = Some(roster);
                self.roster_failed_at_ms = None;
            }
            Err(e) => {
                log("roster_unread", json!({"error": e.to_string()}));
                self.roster_failed_at_ms = Some(now);
            }
        }
    }

    /// Admit the next run, or say why not: `Some` when the storage budget
    /// holds the next run back. The benchmark set is tried first, in the
    /// list's order, then the featured set, most participants first, then the
    /// current set, smallest first. The first candidate whose run does not
    /// fit the budget holds admission: in the benchmark and featured sets that
    /// keeps their priority (nothing after it goes first); in the current
    /// set, none after it is smaller. The benchmark and featured sets may
    /// spend the budget less the live reserve: one that does not fit that
    /// alone holds the rest of those two, and the current set is still
    /// tried, against the whole budget.
    fn pick_and_admit(&mut self, now: i64) -> Result<Option<Pause>> {
        self.recover_graph()?;
        if self.state.graph_flight.is_some() {
            return Ok(None);
        }
        match self.admit_twin(now)? {
            TwinStep::Admitted => return Ok(None),
            TwinStep::Held(reason) => return Ok(Some(reason)),
            TwinStep::Nothing => {}
        }
        if self
            .graph_failed_at_ms
            .is_none_or(|at| now - at >= self.cfg.roster_retry.as_millis() as i64)
        {
            match self.admit_graph(now) {
                Ok(true) => {
                    self.graph_failed_at_ms = None;
                    return Ok(None);
                }
                Ok(false) => self.graph_failed_at_ms = None,
                Err(_) => {
                    // Errors can contain SQL input. Log a closed reason only.
                    log(
                        "graph_unavailable",
                        json!({"reason":"admission_error","retry_seconds":self.cfg.roster_retry.as_secs()}),
                    );
                    self.graph_failed_at_ms = Some(now);
                    // Admission may have committed before its reply was lost.
                    // Recovery failure stops this cycle, including full runs.
                    self.recover_graph()?;
                    if self.state.graph_flight.is_some() {
                        return Ok(None);
                    }
                }
            }
        }
        self.refresh_roster(now);
        let since = now - self.cfg.live_days as i64 * 86_400_000;
        let live = self.db.live(since)?;
        let roster = self.roster.clone().unwrap_or_default();
        let benchmark = plan::overlay(&roster.benchmark, &live);
        let featured = plan::overlay(&roster.featured, &live);
        let (mut small, mut too_large, mut costly) = (0u64, 0u64, 0u64);
        let mut counted = std::collections::BTreeSet::new();
        let named = benchmark
            .iter()
            .map(|l| (l, Set::Benchmark))
            .chain(featured.iter().map(|l| (l, Set::Featured)))
            .chain(live.iter().map(|l| (l, Set::Current)));
        for (l, set) in named {
            if !counted.insert(l.zid) {
                continue;
            }
            match plan::look(self.cfg, &self.state, l, now, set.share()) {
                Look::TooSmall => small += 1,
                Look::TooLarge => too_large += 1,
                Look::TooCostly => costly += 1,
                _ => {}
            }
        }
        let candidates = plan::candidates(self.cfg, &self.state, &benchmark, &featured, &live, now);
        // Set once a run of the benchmark or featured set would pass the
        // budget less the live reserve: the rest of those two wait, the
        // current set goes on. When even the smallest run there can be would,
        // none of their comment sets is read.
        let mut reserve_held = plan::storage_room(
            self.cfg,
            &self.state.storage,
            self.cfg.min_comments,
            Share::Shared,
        ) == Some(Pause::StorageReserve);
        // A benchmark or featured candidate was passed over for the reserve.
        let mut reserve_waiting = false;
        for (candidate, set_name) in candidates {
            if self.graph_scope_held(candidate.zid)? {
                continue;
            }
            let share = set_name.share();
            if reserve_held && share == Share::Shared {
                reserve_waiting = true;
                continue;
            }
            let set = self.db.comment_set(candidate.zid)?;
            let seen = self.state.conversations.entry(candidate.zid).or_default();
            // Unchanged only when the last run was admitted under this
            // selection and kept the same comments. An entry an earlier
            // build wrote names no selection: its run laid out every comment.
            let unchanged = seen.selection.as_deref() == Some(set.selection)
                && seen.admitted_digest.as_deref() == Some(set.selection_digest.as_str());
            seen.last_modified = candidate.last_modified;
            seen.digest = set.selection_digest.clone();
            seen.comments = set.comments;
            seen.selected = set.selected;
            if seen.selection.as_deref() != Some(set.selection) {
                seen.selection = Some(set.selection.to_owned());
                seen.admitted_digest = None;
            }
            if unchanged {
                // The selection is the one already run: a run now would
                // recompute what is stored.
                self.state.totals.unchanged += 1;
                log(
                    "unchanged",
                    json!({"comments": set.comments, "selected": set.selected, "set": set_name.word(),
                    "size_class": plan::size_class(set.comments), "digest": set.selection_digest}),
                );
                continue;
            }
            // The floor is of what a run lays out (the selection), the cap of
            // what it embeds (every comment with text).
            if set.selected < self.cfg.min_comments || set.comments > self.cfg.max_comments {
                continue;
            }
            match plan::storage_room(self.cfg, &self.state.storage, set.comments, share) {
                Some(Pause::StorageReserve) => {
                    (reserve_held, reserve_waiting) = (true, true);
                    continue;
                }
                Some(reason) => return Ok(Some(reason)),
                None => {}
            }
            let request = plan::admission(candidate.zid, &set, Some(set_name), None);
            self.admit(request, set.comments, None, Some(set_name), now)?;
            return Ok(None);
        }
        // Then the runs the comment-rule lists add (none without them).
        if let Some(rules) = self.rules(now)
            && let Some(held) = self.admit_rules(
                now,
                &rules,
                [
                    (&benchmark, Set::Benchmark),
                    (&featured, Set::Featured),
                    (&live, Set::Current),
                ],
                &mut reserve_held,
                &mut reserve_waiting,
            )?
        {
            return Ok(held);
        }
        self.state.totals.too_small = small;
        self.state.totals.too_large = too_large;
        self.state.totals.too_costly = costly;
        if reserve_waiting {
            // Nothing current to run: the benchmark and featured sets wait on
            // the live reserve.
            return Ok(Some(Pause::StorageReserve));
        }
        if self.cfg.derived.enabled {
            self.sets_seen = Some(
                benchmark
                    .iter()
                    .chain(featured.iter())
                    .chain(live.iter())
                    .map(|l| l.zid)
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect(),
            );
        }
        // Counts only: never a code or a conversation id.
        log(
            "idle",
            json!({"benchmark": self.cfg.benchmark.len(), "benchmark_found": benchmark.len(),
                   "featured": featured.len(), "current": live.len(),
                   "too_small": small, "too_large": too_large, "too_costly": costly}),
        );
        Ok(None)
    }

    /// The comment rules the lists add, or `None` when every list is empty
    /// (then nothing is read, and nothing runs but what runs without them)
    /// or none has been resolved yet. The codes are resolved on the read
    /// login at the first cycle and again each UTC day (or sooner, when an
    /// admission found the resolution stale); a failed read keeps the last
    /// resolution and is tried again after `roster_retry`. The resolution
    /// only nominates: every admission it leads to checks again, in its census
    /// snapshot, that a listed code still names the conversation
    /// (`db::rule_census`), so nothing is ever queued on a stale one. The log
    /// names counts only, never a code or a conversation id.
    fn rules(&mut self, now: i64) -> Option<plan::Rules> {
        if self.cfg.rule_lists.iter().all(|l| l.codes.is_empty()) {
            return None;
        }
        let day = now.div_euclid(86_400_000);
        let due = match (&self.rules, self.rules_failed_at_ms) {
            (Some((read, _)), _) if *read == day => false,
            (_, Some(at)) => now - at >= self.cfg.roster_retry.as_millis() as i64,
            _ => true,
        };
        if due {
            match self.resolve_rules() {
                Ok((rules, line)) => {
                    log("rules", line);
                    self.rules = Some((day, rules));
                    self.rules_failed_at_ms = None;
                }
                Err(_) => {
                    // Errors can contain SQL input: a closed reason only.
                    log("rules_unread", json!({"reason": "read_error"}));
                    self.rules_failed_at_ms = Some(now);
                }
            }
        }
        self.rules.as_ref().map(|(_, r)| r.clone())
    }

    /// Each list's codes resolved to conversations. A code repeated in a
    /// list, or a second code of a conversation the same list already names,
    /// is one job, not two: counted in `<rule>_repeated`.
    fn resolve_rules(&self) -> Result<(plan::Rules, Value)> {
        let mut rules = plan::Rules::default();
        let mut line = json!({});
        for list in self.cfg.rule_lists.iter().filter(|l| !l.codes.is_empty()) {
            let mut repeated = list.repeated;
            let mut found = 0usize;
            for (_, zid) in self.db.listed(&list.codes)? {
                if rules.add(zid, list.selection) {
                    found += 1;
                } else {
                    repeated += 1;
                }
            }
            let word = rule_word(list.selection);
            line[word] = list.codes.len().into();
            line[format!("{word}_found")] = found.into();
            line[format!("{word}_repeated")] = repeated.into();
        }
        Ok((rules, line))
    }

    /// The codes of the list that adds `selection`.
    fn rule_codes(&self, selection: &str) -> Vec<String> {
        self.cfg
            .rule_lists
            .iter()
            .find(|l| l.selection == selection)
            .map(|l| l.codes.clone())
            .unwrap_or_default()
    }

    /// Admit the next run a comment-rule list adds, or say why not: `None`
    /// when there is none to admit, `Some(None)` when one was admitted or
    /// taken up (or the pass stopped on a stale resolution), `Some(Some(_))`
    /// when the storage budget holds it. The sets in priority order, each
    /// conversation once and each of its added rules in list order; each
    /// (conversation, rule) is decided from its own newest run in Postgres
    /// (`db::rule_history`), never from the state file: one not yet ended is
    /// watched rather than run beside (a run admitted before a restart, or
    /// whose reply was lost); one whose newest run has the census's selection
    /// digest needs no run; any other is admitted under a key that names the
    /// run it follows (`plan::rule_admission`).
    fn admit_rules(
        &mut self,
        now: i64,
        rules: &plan::Rules,
        sets: [(&Vec<Live>, Set); 3],
        reserve_held: &mut bool,
        reserve_waiting: &mut bool,
    ) -> Result<Option<Option<Pause>>> {
        let mut tried = std::collections::BTreeSet::new();
        for (list, set) in sets {
            for l in list {
                if !tried.insert(l.zid) || rules.added(l.zid).is_empty() {
                    continue;
                }
                if self.graph_scope_held(l.zid)? {
                    continue;
                }
                let share = set.share();
                if *reserve_held && share == Share::Shared {
                    *reserve_waiting = true;
                    continue;
                }
                for &selection in rules.added(l.zid) {
                    let history = self.db.rule_history(l.zid, selection)?;
                    if let Some(run) = history.as_ref().filter(|r| !r.terminal()) {
                        log(
                            "taken_up",
                            json!({"job_id": run.job_id, "selection": selection, "set": run.set,
                                   "comments": run.comments}),
                        );
                        self.state.in_flight = Some(InFlight {
                            zid: l.zid,
                            job_id: run.job_id.clone(),
                            digest: run.selection_sha256.clone().unwrap_or_default(),
                            comment_set_sha256: run.comment_set_sha256.clone(),
                            comments: run.comments,
                            admitted_at_ms: now - run.age_ms,
                            twin_of: None,
                            set: run.set,
                        });
                        return Ok(Some(None));
                    }
                    let checked = (l.zid, selection);
                    let look = plan::rule_look(
                        self.cfg,
                        &self.state,
                        l,
                        share,
                        history.as_ref(),
                        self.rules_checked.get(&checked),
                    );
                    if look != Look::Read {
                        continue;
                    }
                    let newest = history.as_ref().map(|r| r.job_id.clone());
                    let seen = (l.last_modified, newest.clone().unwrap_or_default());
                    let codes = self.rule_codes(selection);
                    let Some(census) = self.db.rule_census(l.zid, selection, &codes)? else {
                        // No listed code names the conversation now: the
                        // resolution is stale. Nothing is queued on it; it is
                        // resolved again at the next cycle.
                        log("rules_stale", json!({"selection": selection, "set": set}));
                        if let Some((day, _)) = self.rules.as_mut() {
                            *day = i64::MIN;
                        }
                        self.rules_failed_at_ms = None;
                        return Ok(Some(None));
                    };
                    if plan::rule_unchanged(history.as_ref(), &census) {
                        self.state.totals.unchanged += 1;
                        log(
                            "unchanged",
                            json!({"comments": census.comments, "selected": census.selected,
                                   "set": set.word(), "size_class": plan::size_class(census.comments),
                                   "digest": census.selection_digest, "selection": selection}),
                        );
                        self.rules_checked.insert(checked, seen);
                        continue;
                    }
                    if census.selected < self.cfg.min_comments
                        || census.comments > self.cfg.max_comments
                    {
                        self.rules_checked.insert(checked, seen);
                        continue;
                    }
                    match plan::storage_room(self.cfg, &self.state.storage, census.comments, share)
                    {
                        Some(Pause::StorageReserve) => {
                            (*reserve_held, *reserve_waiting) = (true, true);
                            continue;
                        }
                        Some(reason) => return Ok(Some(Some(reason))),
                        None => {}
                    }
                    let request =
                        plan::rule_admission(l.zid, &census, Some(set), newest.as_deref());
                    self.admit_rule(request, census.comments, set, now, checked, seen)?;
                    return Ok(Some(None));
                }
            }
        }
        Ok(None)
    }

    /// Admit one run a comment-rule list adds. Nothing of it is written to
    /// the conversation's state entry (that is its run under what participants
    /// are shown); its truth is its run record.
    fn admit_rule(
        &mut self,
        request: Admission,
        comments: i64,
        set: Set,
        now: i64,
        checked: (i32, &'static str),
        seen: (i64, String),
    ) -> Result<()> {
        self.resume();
        let reply = self.db.admit(&request)?;
        let shadow = &request.config["shadow"];
        let digest = shadow["selection_sha256"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let selection = shadow["selection"].as_str().map(str::to_owned);
        let Some((outcome, job_id)) = plan::admitted_job(&reply) else {
            log(
                "refused",
                json!({"outcome": reply.get("outcome"), "comments": comments,
                       "set": set, "twin_of": Value::Null, "selection": selection}),
            );
            // Not tried again until a comment changes (in this process).
            self.rules_checked.insert(checked, seen);
            return Ok(());
        };
        self.state.totals.admitted += 1;
        match set {
            Set::Benchmark => self.state.totals.benchmark_admitted += 1,
            Set::Featured => self.state.totals.featured_admitted += 1,
            Set::Current => self.state.totals.current_admitted += 1,
        }
        self.state.day_runs += 1;
        log(
            "admitted",
            json!({"job_id": job_id, "outcome": outcome, "comments": comments,
                   "selection": selection, "selected": shadow["selected"].as_i64(),
                   "size_class": plan::size_class(comments), "digest": digest,
                   "twin_of": Value::Null, "set": set, "follows": shadow["follows"]}),
        );
        self.state.in_flight = Some(InFlight {
            zid: request.zid,
            job_id,
            digest,
            comment_set_sha256: shadow["comment_set_sha256"].as_str().map(str::to_owned),
            comments,
            admitted_at_ms: now,
            twin_of: None,
            set: Some(set),
        });
        Ok(())
    }

    fn admit(
        &mut self,
        request: super::db::Admission,
        comments: i64,
        twin_of: Option<String>,
        set: Option<Set>,
        now: i64,
    ) -> Result<()> {
        self.resume();
        let reply = self.db.admit(&request)?;
        let shadow = &request.config["shadow"];
        let digest = shadow["selection_sha256"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let selection = shadow["selection"].as_str().map(str::to_owned);
        let comment_set = shadow["comment_set_sha256"].as_str().map(str::to_owned);
        let selected = shadow["selected"].as_i64();
        let Some((outcome, job_id)) = plan::admitted_job(&reply) else {
            log(
                "refused",
                json!({"outcome": reply.get("outcome"), "comments": comments,
                       "set": set, "twin_of": twin_of}),
            );
            // Do not try the same selection again until it changes.
            let seen = self.state.conversations.entry(request.zid).or_default();
            seen.selection = selection;
            seen.admitted_digest = Some(digest);
            seen.admitted_at_ms = Some(now);
            seen.outcome = reply
                .get("outcome")
                .and_then(Value::as_str)
                .map(str::to_owned);
            return Ok(());
        };
        let seen = self.state.conversations.entry(request.zid).or_default();
        seen.selection = selection.clone();
        seen.admitted_digest = Some(digest.clone());
        seen.admitted_at_ms = Some(now);
        seen.job_id = Some(job_id.clone());
        seen.outcome = None;
        if twin_of.is_some() {
            self.state.totals.twins_admitted += 1;
        } else {
            self.state.totals.admitted += 1;
            match set {
                Some(Set::Benchmark) => self.state.totals.benchmark_admitted += 1,
                Some(Set::Featured) => self.state.totals.featured_admitted += 1,
                Some(Set::Current) => self.state.totals.current_admitted += 1,
                None => {}
            }
        }
        self.state.day_runs += 1;
        log(
            "admitted",
            json!({"job_id": job_id, "outcome": outcome, "comments": comments,
                   "selection": selection, "selected": selected,
                   "size_class": plan::size_class(comments), "digest": digest, "twin_of": twin_of,
                   "set": set}),
        );
        self.state.in_flight = Some(InFlight {
            zid: request.zid,
            job_id,
            digest,
            comment_set_sha256: comment_set,
            comments,
            admitted_at_ms: now,
            twin_of,
            set,
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
        // A run a comment-rule list added publishes in its rule's own scope;
        // every other run in the shadow's (or has no record).
        let rule = record
            .as_ref()
            .and_then(|r| r.pointer("/config_effective/result_scope"))
            .and_then(Value::as_str)
            .is_some_and(|scope| scope != SCOPE);
        let mut line = json!({"job_id": flight.job_id, "state": outcome, "overdue": overdue && !terminal,
               "comments": flight.comments, "size_class": plan::size_class(flight.comments),
               "seconds_since_admission": run_ms as f64 / 1000.0,
               "attempt": attempt, "families": families,
               "census_digest_matches": census.map(|c| {
                   c == flight.comment_set_sha256.as_deref().unwrap_or(&flight.digest)
               }),
               "twin_of": flight.twin_of, "set": flight.set});
        if rule {
            line["selection"] = record
                .as_ref()
                .and_then(|r| r.pointer("/config_effective/selection"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        log("finished", line);
        if !rule && let Some(seen) = self.state.conversations.get_mut(&flight.zid) {
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
            set: flight.set,
        });
        self.state.in_flight = None;
        // Twins repeat the conversations' own runs only.
        if !rule {
            self.after_run(&flight, &outcome, record.as_ref())?;
        }
        self.rest_until_ms = now + plan::rest_ms(self.cfg.duty_cycle, run_ms);
        Ok(
            Duration::from_millis((self.rest_until_ms - now).max(0) as u64)
                .max(Duration::from_secs(1)),
        )
    }

    /// A twin waiting for admission goes before any new set. It is admitted
    /// only on the same selection as its first run; a selection that changed
    /// in between drops it (and the next first run on the new one may get
    /// one). Its closed reason word stays `comment_set_changed`.
    fn admit_twin(&mut self, now: i64) -> Result<TwinStep> {
        let Some(pending) = self.state.pending_twin.clone() else {
            return Ok(TwinStep::Nothing);
        };
        if pending.twin_job_id.is_some() {
            return Ok(TwinStep::Nothing);
        }
        if self.graph_scope_held(pending.zid)? {
            return Ok(TwinStep::Nothing);
        }
        let set = self.db.comment_set(pending.zid)?;
        if set.selection_digest != pending.digest {
            log(
                "twin_dropped",
                json!({"first_job_id": pending.first_job_id, "reason": "comment_set_changed",
                       "set": pending.set}),
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
                json!({"first_job_id": pending.first_job_id, "reason": "code_version_changed",
                       "set": pending.set}),
            );
            self.state.pending_twin = None;
            return Ok(TwinStep::Nothing);
        }
        // The twin waits, kept, while the budget holds it back. A twin repeats
        // a run to measure it, so it spends what the first two do, never the
        // live reserve: held by the reserve alone, it waits while the current
        // set goes on.
        match plan::storage_room(self.cfg, &self.state.storage, set.comments, Share::Shared) {
            Some(Pause::StorageReserve) => return Ok(TwinStep::Nothing),
            Some(reason) => return Ok(TwinStep::Held(reason)),
            None => {}
        }
        let request = plan::admission(pending.zid, &set, pending.set, Some(&pending.first_job_id));
        self.admit(
            request,
            set.comments,
            Some(pending.first_job_id.clone()),
            pending.set,
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
                        set: flight.set,
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
                        json!({"first_job_id": first, "twin_job_id": flight.job_id, "state": outcome,
                               "set": flight.set}),
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
                               "reason": "code_version_changed", "set": flight.set}),
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
                    "digest": flight.digest, "set": flight.set, "comparison": comparison});
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
