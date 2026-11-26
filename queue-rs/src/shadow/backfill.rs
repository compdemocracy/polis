//! The derived-map backfill: every stored run of the shadow's env that has no
//! topic map of its own and no derived map job yet is asked for one, a few at
//! a time, only when nothing else is waiting.
//!
//! **Off by default** (`DELPHI_SHADOW_DERIVED_BACKFILL`, [`Settings`]). Off,
//! the scheduler makes no inventory query, asks nothing and writes no line it
//! did not write before. It asks only through the derived jobs' one admission
//! call, which an [`Admitter`] supplies (this crate cannot name it: the crate
//! that holds it depends on this one), and that call has its own switch: with
//! the backfill on and admission off, the backfill reads nothing (it is
//! checked before any pause, roster or set read) and one `derived_held` line
//! says `admission_off`. The separate derived storage estimate is read only
//! with both switches on and no full-run hold. That read precedes this
//! module's rest, queue-depth and daily-cap checks. It changes no full-run
//! ledger; an unknown or over-budget reading holds only derived requests.
//!
//! **Nothing on the box.** What has been asked and what is done is in
//! Postgres. The inventory is a query, every cycle nothing pauses it: a page
//! of the env's jobs of the conversations the shadow looks at (its three
//! sets), in `(zid, created_at, job_id)` order from a cursor held in memory,
//! with, for each, whether it is a finished run, whether its own result batch
//! holds the three stored inputs, and whether it holds a topic map family of
//! its own. For each finished, complete run without one, the derived key's
//! alias (the admission's own key function, through [`Admitter::alias`]) is
//! looked up by the alias table's primary key. A run whose key is there has
//! its derived job, in whatever state: never asked again. A restart loses the
//! cursor only, and the next pass starts from the beginning: nothing is
//! duplicated, because the key is the record.
//!
//! **Refusals.** A run that admission would refuse for what the query can see
//! (not succeeded, no sealed output, an input missing or another job's, no
//! result scope) is never asked: it is counted (`unfinished`, `incomplete`).
//! A refusal that still comes back (its words: the admission's) leaves no job
//! behind; it is counted by its word and its key is kept in memory for the
//! life of the process, so it is asked at most once per process start.
//!
//! **Lines.** The scheduler's backfill lines carry counts and closed words
//! only: never a conversation code, a conversation id, a job id or a report
//! id. The admission's own line, for each job it records, names the source
//! and derived job ids, the env and the derived key's SHA-256.
use super::{config::Config, db::Db, plan::Pause, scheduler::log};
use anyhow::Result;
use postgres::{Client, Transaction};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

/// The switch, default off.
pub const SWITCH: &str = "DELPHI_SHADOW_DERIVED_BACKFILL";
/// The binary the scheduler runs as when the backfill is on.
pub const SCHEDULER: &str = "polis-topic-map";
/// Jobs read per inventory page.
pub const PAGE: i64 = 200;
/// Pages read per cycle at most.
pub const PAGES_PER_CYCLE: usize = 5;
/// The kind of a full run: the stored runs a map is made from.
pub const RUN_KIND: &str = "full_pipeline";
/// The kind of a derived job.
pub const DERIVED_KIND: &str = "derived";
/// Where the cursor starts.
const START: (i32, &str, &str) = (
    i32::MIN,
    "-infinity",
    "00000000-0000-0000-0000-000000000000",
);

/// The backfill's settings, read with the scheduler's.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// `DELPHI_SHADOW_DERIVED_BACKFILL=1`; anything but `0`, `1` or empty is
    /// refused at startup.
    pub enabled: bool,
    /// Admission calls per cycle at most, whatever each answers (queued, a
    /// job already there, refused or failed), and the most derived jobs
    /// queued or running at once before another is asked
    /// (`DELPHI_SHADOW_DERIVED_PER_CYCLE`, default 2, 1..=20).
    pub per_cycle: u32,
    /// Derived jobs of the env created this UTC day at most, by any asker and
    /// for any conversation (`DELPHI_SHADOW_DERIVED_DAILY`, default 100,
    /// 1..=2000). A refused ask makes no job and is bounded by `per_cycle`.
    pub daily: u32,
    /// After a pass that found nothing to ask, how long before the next
    /// (`DELPHI_SHADOW_DERIVED_EVERY_SECONDS`, default 3600, 60..=86400).
    pub every: Duration,
    /// The derived maps' own storage budget, in bytes
    /// (`DELPHI_SHADOW_DERIVED_STORAGE_BYTES`, default [`STORAGE_BYTES`],
    /// [`STORAGE_BYTES_MIN`]..=[`STORAGE_BYTES_MAX`]): no derived job is
    /// asked for while the derived jobs' stored bytes (one reading of the
    /// database, `storage::derived_total`) are at or over it, or unknown. It
    /// holds back only derived work; the full runs' budget never counts them.
    pub storage_bytes: u64,
}

/// The derived maps' budget by default, 1 GiB: at the largest measured
/// estimate (a large checked-in map, about 0.8 MB a job) about 1,300 maps, at
/// a job that stores no map (about 21 KB) about 50,000; the daily cap of 100
/// jobs at the large size is about 80 MB a day.
pub const STORAGE_BYTES: u64 = 1 << 30;
/// At least 1 MiB: more than the largest measured job's estimate.
pub const STORAGE_BYTES_MIN: u64 = 1 << 20;
/// At most 1 TiB.
pub const STORAGE_BYTES_MAX: u64 = 1 << 40;

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            per_cycle: 2,
            daily: 100,
            every: Duration::from_secs(3600),
            storage_bytes: STORAGE_BYTES,
        }
    }
}

/// One stored run to ask a map for.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub env: String,
    pub job_id: String,
    pub zid: i32,
    /// The comment rule the run recorded (`config_effective.selection`).
    pub selection: Option<String>,
}

/// What the admission answered.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Enqueued,
    Existing,
    Refused(String),
}

/// The derived jobs' admission, as the scheduler uses it.
pub trait Admitter {
    /// Whether the admission's own switch is on.
    fn switched_on(&self) -> bool;
    /// The alias table's primary key for the topic map of `source_job_id`
    /// (made by the admission's own key function).
    fn alias(&self, env: &str, source_job_id: &str) -> String;
    /// The one admission call, as asker `scheduler`, on the queue login.
    /// `Err` only for a database or transport failure.
    fn admit(
        &mut self,
        client: &mut Client,
        source: &Source,
        code: &str,
    ) -> Result<Outcome, String>;
    /// The stored families a map is made from.
    fn inputs(&self) -> &'static [&'static str];
    /// The topic map's family.
    fn map_family(&self) -> &'static str;
}

/// One job of an inventory page.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub job_id: String,
    pub zid: i32,
    pub created_at: String,
    pub run: bool,
    pub finished: bool,
    pub complete: bool,
    pub own_map: bool,
    pub selection: Value,
}

/// The inventory page: one ordered range of `delphi_jobs_history`
/// (`env, zid, created_at, job_id`) from the cursor, then for each job its
/// own result artifact (`UNIQUE(env, job_id, output_role)`), that artifact's
/// batch (`UNIQUE(env, artifact_id)`) and the batch's families (primary key
/// `env, batch_id, family`). Families and kinds are parameters.
pub const PAGE_SQL: &str = "\
SELECT j.job_id::text, j.zid, j.created_at::text, j.kind = $7 AS run, \
 (j.status = 'succeeded' AND j.output_manifest_digest IS NOT NULL) AS finished, \
 (j.config_effective ? 'result_scope' AND b.batch_id IS NOT NULL AND \
  (SELECT count(*) FROM public.delphi_result_families f \
    WHERE f.env = j.env AND f.batch_id = b.batch_id AND f.family = ANY($8::text[])) \
   = cardinality($8::text[])) AS complete, \
 (b.batch_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delphi_result_families f \
    WHERE f.env = j.env AND f.batch_id = b.batch_id AND f.family = $9)) AS own_map, \
 coalesce(j.config_effective -> 'selection', 'null'::jsonb) AS selection \
FROM (SELECT * FROM public.delphi_jobs \
       WHERE env = $1 AND zid = ANY($2::int[]) \
         AND (zid, created_at, job_id) > ($3::int, $4::text::timestamptz, $5::text::uuid) \
       ORDER BY zid, created_at, job_id LIMIT $6) j \
LEFT JOIN public.delphi_artifacts a \
  ON a.env = j.env AND a.job_id = j.job_id AND a.output_role = 'result' \
LEFT JOIN public.delphi_result_batches b \
  ON b.env = a.env AND b.artifact_id = a.artifact_id AND b.job_id = j.job_id \
ORDER BY j.zid, j.created_at, j.job_id";

/// The aliases of `keys` that exist: primary-key lookups only.
pub const ALIASES_SQL: &str =
    "SELECT public_id::text FROM public.delphi_job_aliases WHERE public_id = ANY($1::text[])";

/// Derived jobs of the env created since `$2`, whatever their conversation
/// (so a conversation leaving the sets does not return its jobs to the day's
/// room): the env's range of the history index, filtered.
pub const TODAY_SQL: &str = "SELECT count(*) FROM public.delphi_jobs \
 WHERE env = $1 AND created_at >= to_timestamp($2::float8) AND kind = $3";

pub fn page(
    tx: &mut Transaction<'_>,
    env: &str,
    zids: &[i32],
    cursor: &(i32, String, String),
    inputs: &[&str],
    map_family: &str,
) -> Result<Vec<Row>> {
    let inputs: Vec<String> = inputs.iter().map(|s| (*s).to_owned()).collect();
    let rows = tx.query(
        PAGE_SQL,
        &[
            &env,
            &zids,
            &cursor.0,
            &cursor.1,
            &cursor.2,
            &PAGE,
            &RUN_KIND,
            &inputs,
            &map_family,
        ],
    )?;
    Ok(rows
        .iter()
        .map(|r| Row {
            job_id: r.get(0),
            zid: r.get(1),
            created_at: r.get(2),
            run: r.get(3),
            finished: r.get(4),
            complete: r.get::<_, Option<bool>>(5).unwrap_or(false),
            own_map: r.get::<_, Option<bool>>(6).unwrap_or(false),
            selection: r.get(7),
        })
        .collect())
}

/// What one pass over the inventory has counted so far.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Counts {
    pub scanned: u64,
    pub with_map: u64,
    /// Runs whose key already names a derived job.
    pub derived: u64,
    /// Runs with no map of their own and no derived job: the asks owed.
    pub without_map: u64,
    pub admitted: u64,
    /// Asked, and the key named a job already (another asker came first).
    pub existing: u64,
    pub refused: BTreeMap<String, u64>,
    /// Refused earlier in this process, not asked again.
    pub refused_before: u64,
    pub incomplete: u64,
    pub unfinished: u64,
    pub errors: u64,
}

impl Counts {
    fn add(&mut self, o: &Counts) {
        self.scanned += o.scanned;
        self.with_map += o.with_map;
        self.derived += o.derived;
        self.without_map += o.without_map;
        self.admitted += o.admitted;
        self.existing += o.existing;
        for (w, n) in &o.refused {
            *self.refused.entry(w.clone()).or_default() += n;
        }
        self.refused_before += o.refused_before;
        self.incomplete += o.incomplete;
        self.unfinished += o.unfinished;
        self.errors += o.errors;
    }
    fn json(&self) -> Value {
        json!({"scanned": self.scanned, "with_map": self.with_map, "derived": self.derived,
               "without_map": self.without_map, "admitted": self.admitted,
               "existing": self.existing, "refused": self.refused,
               "refused_before": self.refused_before, "incomplete": self.incomplete,
               "unfinished": self.unfinished, "errors": self.errors})
    }
}

/// Why the backfill asked nothing this cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    /// A pause of the scheduler (its word).
    Paused(Pause),
    /// A full run was admitted, or is running or waiting, this cycle.
    FullRun,
    AdmissionOff,
    /// Enough derived jobs are queued or running (`per_cycle`).
    Backlog,
    DailyCap,
    /// Resting after a pass that found nothing to ask (`every`).
    Rest,
    /// The derived jobs' stored bytes are at or over their own budget
    /// (`storage_bytes`).
    StorageBudget,
    /// No reading of the derived jobs' stored bytes is known (none yet, or
    /// the last failed or timed out).
    StorageUnread,
}

impl Held {
    pub fn word(self) -> &'static str {
        match self {
            Self::Paused(p) => p.word(),
            Self::FullRun => "full_run",
            Self::AdmissionOff => "admission_off",
            Self::Backlog => "backlog",
            Self::DailyCap => "derived_daily_cap",
            Self::Rest => "rest",
            Self::StorageBudget => "derived_storage_budget",
            Self::StorageUnread => "derived_storage_unread",
        }
    }
}

/// The backfill's memory: optimization only, never the record.
#[derive(Default)]
pub struct Backfill<'a> {
    pub admitter: Option<Box<dyn Admitter + 'a>>,
    cursor: Option<(i32, String, String)>,
    pass: Counts,
    /// Keys refused in this process, with their word.
    refused: BTreeSet<String>,
    rest_until_ms: i64,
    held: Option<&'static str>,
    /// Inventory queries made (for the switch-off test).
    pub queries: u64,
    /// The derived jobs' stored bytes, read for their own budget.
    pub stored: super::storage::Derived,
}

impl<'a> Backfill<'a> {
    pub fn new(admitter: Option<Box<dyn Admitter + 'a>>) -> Self {
        Self {
            admitter,
            ..Default::default()
        }
    }

    fn hold(&mut self, h: Held) {
        if self.held != Some(h.word()) {
            log("derived_held", json!({"reason": h.word()}));
            self.held = Some(h.word());
        }
    }

    /// One cycle's step, after the scheduler's own. `held` is why it may not
    /// ask this cycle (`None`: nothing pauses it and no full run is waiting).
    /// Errors are logged by a closed word and never fail the cycle.
    pub fn step(&mut self, cfg: &Config, db: &Db<'_>, zids: &[i32], now: i64, held: Option<Held>) {
        if !cfg.derived.enabled {
            return;
        }
        let Some(admitter) = self.admitter.as_ref() else {
            return;
        };
        if let Some(h) = held {
            return self.hold(h);
        }
        if !admitter.switched_on() {
            return self.hold(Held::AdmissionOff);
        }
        if self.cursor.is_none() && now < self.rest_until_ms {
            return self.hold(Held::Rest);
        }
        if let Err(word) = self.ask(cfg, db, zids, now) {
            log("derived_unread", json!({"reason": word}));
        }
    }

    fn ask(
        &mut self,
        cfg: &Config,
        db: &Db<'_>,
        zids: &[i32],
        now: i64,
    ) -> Result<(), &'static str> {
        let s = &cfg.derived;
        let Some(admitter) = self.admitter.as_ref() else {
            return Ok(());
        };
        let (inputs, map_family) = (admitter.inputs(), admitter.map_family());
        let mut queue = db.connect_queue().map_err(|_| "queue_connect")?;
        let depth: Value = queue
            .query_one("SELECT public.pq_class_depth($1,'derived')", &[&cfg.env])
            .and_then(|r| r.try_get(0))
            .map_err(|_| "class_depth")?;
        let outstanding =
            depth["queued"].as_i64().unwrap_or(0) + depth["leased"].as_i64().unwrap_or(0);
        if outstanding >= i64::from(s.per_cycle) {
            self.hold(Held::Backlog);
            return Ok(());
        }
        let since = (now.div_euclid(86_400_000) * 86_400) as f64;
        let env = cfg.env.clone();
        let start = self
            .cursor
            .clone()
            .unwrap_or((START.0, START.1.into(), START.2.into()));
        self.queries += 1;
        let (today, rows, next) = db
            .read(|tx| {
                let today: i64 = tx
                    .query_one(TODAY_SQL, &[&env, &since, &DERIVED_KIND])?
                    .get(0);
                let mut cursor = start;
                let mut rows = Vec::new();
                for _ in 0..PAGES_PER_CYCLE {
                    let got = page(tx, &env, zids, &cursor, inputs, map_family)?;
                    let full = got.len() as i64 == PAGE;
                    let last = got
                        .last()
                        .map(|r| (r.zid, r.created_at.clone(), r.job_id.clone()));
                    rows.extend(got);
                    match last {
                        Some(l) if full => cursor = l,
                        _ => return Ok((today, rows, None)),
                    }
                }
                Ok((today, rows, Some(cursor)))
            })
            .map_err(|_| "inventory")?;
        let mut c = Counts::default();
        let mut owed = Vec::new();
        for r in rows.iter().filter(|r| r.run) {
            c.scanned += 1;
            if !r.finished {
                c.unfinished += 1;
            } else if r.own_map {
                c.with_map += 1;
            } else if !r.complete || !(r.selection.is_null() || r.selection.is_string()) {
                c.incomplete += 1;
            } else {
                owed.push((admitter.alias(&env, &r.job_id), r));
            }
        }
        let keys: Vec<String> = owed.iter().map(|(k, _)| k.clone()).collect();
        let known: BTreeSet<String> = if keys.is_empty() {
            BTreeSet::new()
        } else {
            db.read(|tx| {
                Ok(tx
                    .query(ALIASES_SQL, &[&keys])?
                    .iter()
                    .map(|r| r.get::<_, String>(0))
                    .collect())
            })
            .map_err(|_| "aliases")?
        };
        // Every admission call spends an ask, whatever it answers; only a job
        // queued spends room and the day's room.
        let mut asks = i64::from(s.per_cycle);
        let mut room = i64::from(s.per_cycle) - outstanding;
        let mut daily_room = i64::from(s.daily) - today;
        let mut capped = false;
        for (key, r) in owed {
            if known.contains(&key) {
                c.derived += 1;
                continue;
            }
            if self.refused.contains(&key) {
                c.refused_before += 1;
                continue;
            }
            c.without_map += 1;
            if asks <= 0 || room <= 0 || daily_room <= 0 || c.errors > 0 {
                capped |= daily_room <= 0;
                continue;
            }
            let source = Source {
                env: env.clone(),
                job_id: r.job_id.clone(),
                zid: r.zid,
                selection: r.selection.as_str().map(str::to_owned),
            };
            let Some(admitter) = self.admitter.as_mut() else {
                break;
            };
            asks -= 1;
            match admitter.admit(&mut queue, &source, &cfg.code_version) {
                Ok(Outcome::Enqueued) => {
                    c.admitted += 1;
                    room -= 1;
                    daily_room -= 1;
                }
                Ok(Outcome::Existing) => c.existing += 1,
                Ok(Outcome::Refused(word)) => {
                    *c.refused.entry(word).or_default() += 1;
                    self.refused.insert(key);
                }
                // Errors can carry SQL input: counted, never logged.
                Err(_) => c.errors += 1,
            }
        }
        drop(queue);
        self.pass.add(&c);
        let mut line = c.json();
        line["asked"] = (i64::from(s.per_cycle) - asks).into();
        line["admitted_today"] = (today + c.admitted as i64).into();
        line["daily"] = s.daily.into();
        line["pass"] = if next.is_none() {
            "complete"
        } else {
            "continues"
        }
        .into();
        log("derived_backfill", line);
        if capped {
            self.hold(Held::DailyCap);
        } else {
            self.held = None;
        }
        match next {
            Some(cursor) => self.cursor = Some(cursor),
            None => {
                let pass = std::mem::take(&mut self.pass);
                self.cursor = None;
                // A whole pass found nothing owed: every run has its own
                // map, a derived job, or a refusal recorded in this process.
                if pass.without_map == 0 && pass.errors == 0 {
                    let mut line = pass.json();
                    line["message"] = "every stored run has a map or a recorded outcome".into();
                    log("derived_inventory_empty", line);
                    self.rest_until_ms = now + s.every.as_millis() as i64;
                }
            }
        }
        Ok(())
    }
}
