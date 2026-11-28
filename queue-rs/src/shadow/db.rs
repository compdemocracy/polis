//! Every statement the scheduler sends, and the two connections it sends them on.
//!
//! The participation path (votes, comments, the next comment) runs in the
//! server and the Rust API on the web boxes, on their own pools. This process
//! holds none of those pools and shares no connection with them: it opens at
//! most one connection per login, for one call, and closes it. On the read
//! login every read is one `READ ONLY` transaction with its own statement and
//! lock timeouts, so it takes `ACCESS SHARE` locks only (which no vote,
//! comment or next-comment statement waits on) and it can write nothing. On the
//! queue login it calls the queue's own functions: admission
//! (`pd_writer_admit`, which takes `FOR KEY SHARE` on the conversation's row
//! and so never waits on, or makes wait, the `conversations` updates votes and
//! comments cause), job status, run records, and the shadow env's current
//! result rows. `tests/delphi_shadow.rs` holds both sessions open against
//! participation statements under a 50 ms lock timeout. After each run the
//! read login also reads that run's bytes (`storage`), by index ranges on the
//! run's own keys. For the benchmark set the read login also resolves the
//! listed codes on `zinvites` (the unique index on the code), the same read
//! the participation path makes to find a conversation; and for the featured
//! set it lists the open-data conversations (`conversations.is_data_open`,
//! one pass over `conversations`, which has no index on that column). Both
//! are read once a UTC day (the scheduler's roster), never per poll, and both
//! take `ACCESS SHARE` only, which the `conversations` updates votes and
//! comments cause (`ROW EXCLUSIVE`) do not wait on. Only when a comment-rule
//! list is set (`DELPHI_SHADOW_ALL_COMMENTS`,
//! `DELPHI_SHADOW_ALL_BUT_MODERATED_OUT`) the read login also resolves its
//! codes (`listed`, by the unique index on the code, once a UTC day), reads
//! each listed conversation's newest run under each of its rules from
//! `delphi_jobs` (`rule_history`, by the `delphi_jobs_history` index), and,
//! before admitting one, checks in the census snapshot that a listed code
//! still names the conversation (`rule_census`, by `zinvites_zid_idx`). All
//! are the same `READ ONLY` transactions with the same timeouts; with the
//! lists empty none of them is made.
use super::{
    config::{ACTOR, Config, SCOPE},
    storage::{self, Measured, Pending},
};
use crate::jobs::{
    inputs::contract::{self, Comment},
    transport::Connector,
};
use anyhow::{Context, Result, anyhow};
use postgres::{Client, IsolationLevel, Transaction};
use serde_json::Value;
use std::{collections::BTreeMap, time::Instant};

pub const READ_APPLICATION: &str = "polis-delphi-shadow-reads/1";
pub const QUEUE_APPLICATION: &str = "polis-delphi-shadow/1";

pub struct Db<'a> {
    cfg: &'a Config,
}

/// A live conversation: its comment count (comments with text) and the newest
/// `comments.modified`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub zid: i32,
    pub comments: i64,
    pub last_modified: i64,
}

/// One conversation's census: every comment, as the run's census will digest
/// it (the set the run embeds), and the selection the run lays out, clusters
/// and names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentSet {
    /// `polis-jobs.comment-set/1` over every comment.
    pub digest: String,
    /// Comments with text: the comments the run embeds.
    pub comments: i64,
    /// The selection the census was taken under: [`super::plan::SELECTION`]
    /// for every conversation's run, or a comment rule a list adds.
    pub selection: &'static str,
    /// `polis-jobs.selection/1` over the comments it keeps: the admission's key.
    pub selection_digest: String,
    /// The comments it keeps that have text: the comments the run lays out.
    pub selected: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Signals {
    /// Median of three `SELECT 1` round trips.
    pub probe_ms: f64,
    /// How far the math engine's newest write trails the newest vote (0 when
    /// it is caught up).
    pub math_lag_ms: i64,
}

impl<'a> Db<'a> {
    pub fn new(cfg: &'a Config) -> Self {
        Self { cfg }
    }

    fn connect_read(&self) -> Result<Client> {
        Connector::from_parts(
            &self.cfg.read_dsn,
            &self.cfg.transport,
            None,
            READ_APPLICATION,
        )?
        .connect()
    }

    pub(super) fn connect_queue(&self) -> Result<Client> {
        Connector::from_parts(
            &self.cfg.queue_dsn,
            &self.cfg.transport,
            self.cfg.password_file.as_deref(),
            QUEUE_APPLICATION,
        )?
        .connect()
    }

    /// One read-only transaction with the scheduler's bounds.
    pub(super) fn read<T>(&self, f: impl FnOnce(&mut Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut client = self.connect_read()?;
        read_only(&mut client, self.cfg.statement_timeout.as_millis(), f)
    }

    /// Conversations with a comment created or moderated since `since_ms`.
    pub fn live(&self, since_ms: i64) -> Result<Vec<Live>> {
        self.read(|tx| live(tx, since_ms))
    }

    /// The roster's two reads, in one read-only transaction on one
    /// connection: the benchmark set (the listed conversations that exist, in
    /// the list's order) and the featured set (the open-data conversations,
    /// most participants first).
    pub fn roster(&self, codes: &[String]) -> Result<(Vec<Live>, Vec<Live>)> {
        self.read(|tx| Ok((benchmark(tx, codes)?, featured(tx)?)))
    }

    pub fn comment_set(&self, zid: i32) -> Result<CommentSet> {
        self.read(|tx| comment_set(tx, zid))
    }

    /// Each code of `codes` that names a conversation, with it (`listed`).
    pub fn listed(&self, codes: &[String]) -> Result<Vec<(String, i32)>> {
        self.read(|tx| listed(tx, codes))
    }

    /// The newest run of conversation `zid` under `selection` in the shadow
    /// env (`rule_history`).
    pub fn rule_history(&self, zid: i32, selection: &str) -> Result<Option<RuleRun>> {
        let env = self.cfg.env.clone();
        let scope = super::plan::rule_scope(selection);
        self.read(|tx| rule_history(tx, &env, zid, selection, &scope))
    }

    /// The census of `zid` under `selection`, or `None` when no code of
    /// `codes` names it now (`rule_census`).
    pub fn rule_census(
        &self,
        zid: i32,
        selection: &str,
        codes: &[String],
    ) -> Result<Option<CommentSet>> {
        self.read(|tx| rule_census(tx, zid, selection, codes))
    }

    /// What the named list's step decides from (`naming_state`,
    /// `naming_sources`): its two statements in one read-only transaction on
    /// the scheduler's own read connection, opened for the call and closed
    /// after it, with its statement and lock timeouts.
    pub fn naming(
        &self,
        zids: &[i32],
        namer: &str,
        default_bound_micro_usd: i64,
    ) -> Result<(NamingState, Vec<NamingSource>)> {
        let env = self.cfg.env.clone();
        self.read(|tx| {
            Ok((
                naming_state(tx, &env, default_bound_micro_usd)?,
                naming_sources(tx, &env, zids, namer)?,
            ))
        })
    }

    pub fn signals(&self) -> Result<Signals> {
        let mut client = self.connect_read()?;
        let mut samples = Vec::with_capacity(3);
        for _ in 0..3 {
            let start = Instant::now();
            client.simple_query("SELECT 1")?;
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let math_env = self.cfg.math_env.clone();
        let lag = read_only(&mut client, self.cfg.statement_timeout.as_millis(), |tx| {
            math_lag(tx, &math_env)
        })?;
        Ok(Signals {
            probe_ms: samples[1],
            math_lag_ms: lag,
        })
    }

    pub fn admit(&self, request: &Admission) -> Result<Value> {
        let mut client = self.connect_queue()?;
        admit(&mut client, &self.cfg.env, &self.cfg.code_version, request)
    }

    pub fn job_state(&self, job_id: &str) -> Result<Option<String>> {
        let mut client = self.connect_queue()?;
        job_state(&mut client, &self.cfg.env, job_id)
    }

    pub fn run_record(&self, job_id: &str) -> Result<Option<Value>> {
        let mut client = self.connect_queue()?;
        run_record(&mut client, &self.cfg.env, job_id)
    }

    /// One terminal job's bytes (`storage`): index ranges on its own keys only.
    pub fn measure(&self, p: &Pending) -> Result<Measured> {
        self.read(|tx| {
            let mut m = storage::measure(tx, &p.env, &p.job_id, p.zid)?;
            if self.cfg.graph.is_some() {
                m.graph_bytes = super::graph::measure_records(tx, &p.env, &p.job_id)?;
            }
            Ok(m)
        })
    }

    /// Every shadow env's jobs, once per state file (`storage`).
    pub fn shadow_jobs(&self) -> Result<Vec<Pending>> {
        self.read(storage::shadow_jobs)
    }

    /// The bytes this env's terminal derived jobs have stored, for their own
    /// budget (`storage::derived_total`): one read-only statement, on the
    /// scheduler's own read connection, with its statement and lock timeouts.
    pub fn derived_total(&self, day_start_ms: i64) -> Result<storage::DerivedTotal> {
        self.read(|tx| storage::derived_total(tx, &self.cfg.env, day_start_ms))
    }

    pub fn assignments(&self, zid: i32) -> Result<BTreeMap<i64, Vec<i64>>> {
        let mut client = self.connect_queue()?;
        assignments(&mut client, &self.cfg.env, zid)
    }
}

pub fn read_only<T>(
    client: &mut Client,
    statement_timeout_ms: u128,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T>,
) -> Result<T> {
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = '{statement_timeout_ms}ms'; SET LOCAL lock_timeout = '1s'"
    ))?;
    let out = f(&mut tx)?;
    tx.commit()?;
    Ok(out)
}

/// The candidates: one index range scan of `comments_modified_idx` for the
/// conversations, then their counts by the primary key.
pub fn live(tx: &mut Transaction<'_>, since_ms: i64) -> Result<Vec<Live>> {
    let rows = tx.query(
        "WITH live AS (SELECT DISTINCT zid FROM comments WHERE modified > $1::bigint) \
         SELECT c.zid, \
                (count(*) FILTER (WHERE c.txt IS NOT NULL AND btrim(c.txt) <> ''))::bigint, \
                max(c.modified)::bigint \
         FROM comments c JOIN live USING (zid) GROUP BY c.zid ORDER BY c.zid",
        &[&since_ms],
    )?;
    rows.iter()
        .map(|r| {
            Ok(Live {
                zid: r.try_get(0)?,
                comments: r.try_get(1)?,
                last_modified: r.try_get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })
        .collect()
}

/// The conversations the benchmark list names, highest priority first: each code resolved through `zinvites_zinvite_key`, then its counts by
/// the primary key, as `live` counts them. A code no conversation has is left
/// out (the caller counts it); a conversation with no comment reads as 0, and
/// one two codes name is kept at its first place.
pub fn benchmark(tx: &mut Transaction<'_>, codes: &[String]) -> Result<Vec<Live>> {
    if codes.is_empty() {
        return Ok(Vec::new());
    }
    let rows = tx.query(
        "WITH wanted AS (SELECT code, ord FROM unnest($1::text[]) WITH ORDINALITY AS w(code, ord)),               listed AS (SELECT min(w.ord) AS ord, z.zid FROM wanted w                          JOIN zinvites z ON z.zinvite = w.code GROUP BY z.zid)          SELECT l.zid,                 (count(c.tid) FILTER (WHERE c.txt IS NOT NULL AND btrim(c.txt) <> ''))::bigint,                 max(c.modified)::bigint          FROM listed l LEFT JOIN comments c ON c.zid = l.zid          GROUP BY l.ord, l.zid ORDER BY l.ord",
        &[&codes],
    )?;
    rows.iter()
        .map(|r| {
            Ok(Live {
                zid: r.try_get(0)?,
                comments: r.try_get(1)?,
                last_modified: r.try_get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })
        .collect()
}

/// The featured set: every open-data conversation
/// (`conversations.is_data_open` true, the owner's "anyone can export a data
/// dump" setting, which the server writes on conversation create and update
/// and reads to permit the participants-of-interest data read), most
/// participants first (`participant_count`, then the conversation id), with
/// its counts as `live` counts them (by the comments' `zid` index). One pass
/// over `conversations` (no index on the column), read once a UTC day by the
/// roster, never per poll.
pub fn featured(tx: &mut Transaction<'_>) -> Result<Vec<Live>> {
    let rows = tx.query(
        "WITH open AS (SELECT zid, coalesce(participant_count, 0) AS n FROM conversations \
                       WHERE is_data_open IS TRUE) \
         SELECT o.zid, \
                (count(c.tid) FILTER (WHERE c.txt IS NOT NULL AND btrim(c.txt) <> ''))::bigint, \
                max(c.modified)::bigint \
         FROM open o LEFT JOIN comments c ON c.zid = o.zid \
         GROUP BY o.zid, o.n ORDER BY o.n DESC, o.zid",
        &[],
    )?;
    rows.iter()
        .map(|r| {
            Ok(Live {
                zid: r.try_get(0)?,
                comments: r.try_get(1)?,
                last_modified: r.try_get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })
        .collect()
}

/// Each code that names a conversation, with the conversation, by the unique
/// index on the code (`zinvites_zinvite_key`), as `benchmark` resolves its
/// list; a code no conversation has is not returned. No comment is read.
pub fn listed(tx: &mut Transaction<'_>, codes: &[String]) -> Result<Vec<(String, i32)>> {
    if codes.is_empty() {
        return Ok(Vec::new());
    }
    let rows = tx.query(
        "SELECT zinvite, zid FROM zinvites WHERE zinvite = ANY($1::text[]) ORDER BY zinvite",
        &[&codes],
    )?;
    rows.iter()
        .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
        .collect()
}

/// The newest run of one conversation under one comment rule, as its
/// admission recorded it in Postgres (`delphi_jobs.config_effective`): the
/// durable record the rule's "unchanged, no rerun needed" is decided from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleRun {
    pub job_id: String,
    /// `delphi_jobs.status`.
    pub status: String,
    /// How long ago it was admitted, in ms, by the database's own clock (its
    /// `created_at` against `clock_timestamp()`), so no other clock is
    /// compared with it.
    pub age_ms: i64,
    /// The selection digest it was admitted under (`shadow.selection_sha256`).
    pub selection_sha256: Option<String>,
    /// The comment set's digest and count it was admitted under.
    pub comment_set_sha256: Option<String>,
    pub comments: i64,
    /// The named set it was selected from.
    pub set: Option<super::plan::Set>,
}

impl RuleRun {
    /// Whether the job has ended.
    pub fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "succeeded" | "dead" | "cancelled")
    }
}

/// The newest job of conversation `zid` in `env` whose admission named
/// `selection` in its rule's own scope (`scope`), by the history index
/// (`delphi_jobs_history`, env and zid, newest first).
pub fn rule_history(
    tx: &mut Transaction<'_>,
    env: &str,
    zid: i32,
    selection: &str,
    scope: &str,
) -> Result<Option<RuleRun>> {
    let row = tx.query_opt(
        "SELECT job_id::text, status, \
                (extract(epoch FROM clock_timestamp() - created_at) * 1000)::bigint, \
                config_effective #>> '{shadow,selection_sha256}', \
                config_effective #>> '{shadow,comment_set_sha256}', \
                coalesce((config_effective #>> '{shadow,comments}')::bigint, 0), \
                config_effective #>> '{shadow,set}' \
         FROM public.delphi_jobs \
         WHERE env = $1 AND zid = $2 AND config_effective ->> 'selection' = $3 \
           AND config_effective ->> 'result_scope' = $4 \
         ORDER BY created_at DESC, job_id DESC LIMIT 1",
        &[&env, &zid, &selection, &scope],
    )?;
    row.map(|r| {
        Ok(RuleRun {
            job_id: r.try_get(0)?,
            status: r.try_get(1)?,
            age_ms: r.try_get(2)?,
            selection_sha256: r.try_get(3)?,
            comment_set_sha256: r.try_get(4)?,
            comments: r.try_get(5)?,
            set: r
                .try_get::<_, Option<String>>(6)?
                .as_deref()
                .and_then(super::plan::Set::from_word),
        })
    })
    .transpose()
}

/// The named runs of the shadow env, as Postgres holds them: what today's
/// requests can have cost at most, and the named run not yet ended, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamingState {
    /// Every attempt of a named run started since the start of the current
    /// UTC day (by the database's clock), at its run's frozen price bound
    /// (`shadow.price_bound_micro_usd`), plus one bound for each named run
    /// not ended that has no attempt yet. In millionths of a US dollar. An
    /// attempt sends at most one request and the naming program refuses a
    /// run whose worst case is over its cap, so this never counts less than
    /// was sent; it counts an attempt that never reached the model, and an
    /// answer that cost less than its bound, at the full bound.
    ///
    /// An attempt is counted on the UTC day it started, not the day its
    /// request left: an attempt started just before midnight whose request
    /// leaves after it is counted on the day before, and the new day does
    /// not see it. So by when the money left, one UTC day can carry one cap
    /// more than its limit (that attempt); by this count no day passes its
    /// limit, and nothing is ever left uncounted.
    pub spent_micro_usd: i64,
    /// The oldest named run of the env not yet ended, with its conversation.
    pub in_flight: Option<(i32, RuleRun)>,
}

/// One conversation of the named list, in list order: its newest finished
/// keyword run under what participants are shown, and whether it is named.
#[derive(Debug, Clone, PartialEq)]
pub struct NamingSource {
    pub zid: i32,
    /// The run (`job_id`) and its `config_effective`, or `None` when it has
    /// no finished keyword run yet.
    pub source: Option<(String, Value)>,
    /// A named run by the same namer of the same comments has succeeded with
    /// the model's names: the same selection and comment-set digests as the
    /// source, and its output manifest does not record the topic model as
    /// `keywords` (the fallback). A run whose manifest cannot be found counts
    /// as named, so nothing is asked again on a guess.
    pub named: bool,
    /// A named run of this very source by the same namer exists that is not
    /// a fallback admitted before today (UTC, by the database's clock): one
    /// in any state but succeeded on keyword names, or any admitted today.
    /// Such a source is not asked again; one whose named runs all kept
    /// keyword names on earlier days is asked once more, counted against
    /// today's limit.
    pub asked: bool,
    /// How many named runs of this very source by the same namer exist: the
    /// next ask's key (`plan::asked_again`).
    pub asks: i64,
}

/// Statement one (`NamingState`). Bounds: one range of the shadow env's run
/// records by the env prefix of `delphi_jobs_history` (env, zid, created_at,
/// job_id), of which only the named runs are kept; for each named run, its
/// own attempts by `polis_queue_attempts`'s unique (env, job_id,
/// lease_epoch). Every named run of the env counts, listed or not, so a code
/// taken off the list during the day still counts what its runs sent.
/// `default_bound` prices a named run that froze no bound.
pub fn naming_state(
    tx: &mut Transaction<'_>,
    env: &str,
    default_bound: i64,
) -> Result<NamingState> {
    let row = tx.query_one(
        "WITH d AS (SELECT date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') \
                           AT TIME ZONE 'UTC' AS start), \
              n AS MATERIALIZED (SELECT job_id, zid, status, created_at, config_effective \
                                 FROM public.delphi_jobs \
                                 WHERE env = $1 AND config_effective ->> 'names_of' IS NOT NULL) \
         SELECT (SELECT coalesce(sum( \
                    coalesce((n.config_effective #>> '{shadow,price_bound_micro_usd}')::bigint, $2) * \
                    greatest((SELECT count(*) FROM public.polis_queue_attempts a \
                              WHERE a.env = $1 AND a.job_id = n.job_id AND a.started_at >= d.start), \
                             CASE WHEN n.status NOT IN ('succeeded','dead','cancelled') \
                                   AND NOT EXISTS (SELECT 1 FROM public.polis_queue_attempts a \
                                                   WHERE a.env = $1 AND a.job_id = n.job_id) \
                                  THEN 1 ELSE 0 END)), 0)::bigint FROM d, n), \
                f.job_id::text, f.status, \
                (extract(epoch FROM clock_timestamp() - f.created_at) * 1000)::bigint, \
                f.config_effective #>> '{shadow,selection_sha256}', \
                f.config_effective #>> '{shadow,comment_set_sha256}', \
                coalesce((f.config_effective #>> '{shadow,comments}')::bigint, 0), f.zid \
         FROM (SELECT 1) one LEFT JOIN LATERAL ( \
                SELECT * FROM n WHERE n.status NOT IN ('succeeded','dead','cancelled') \
                ORDER BY n.created_at, n.job_id LIMIT 1) f ON true",
        &[&env, &default_bound],
    )?;
    let job_id: Option<String> = row.try_get(1)?;
    let in_flight = match job_id {
        None => None,
        Some(job_id) => Some((
            row.try_get::<_, Option<i32>>(7)?.unwrap_or_default(),
            RuleRun {
                job_id,
                status: row.try_get(2)?,
                age_ms: row.try_get(3)?,
                selection_sha256: row.try_get(4)?,
                comment_set_sha256: row.try_get(5)?,
                comments: row.try_get(6)?,
                set: None,
            },
        )),
    };
    Ok(NamingState {
        spent_micro_usd: row.try_get(0)?,
        in_flight,
    })
}

/// Statement two (`NamingSource`), for the listed conversations `zids` in
/// their order and the namer word `namer`. Bounds: per conversation, index
/// ranges of `delphi_jobs_history` on (env, zid) only: the newest succeeded
/// keyword run (newest first, one row), two existence checks and a count
/// over the same range, and for each named run met there its own attempts
/// and their manifest lines. At most `RULE_LIST_MAX` conversations, the
/// list's own bound. It reads only `delphi_jobs`, `polis_queue_attempts` and
/// `polis_queue_logs`, which the read login already reads.
pub fn naming_sources(
    tx: &mut Transaction<'_>,
    env: &str,
    zids: &[i32],
    namer: &str,
) -> Result<Vec<NamingSource>> {
    if zids.is_empty() {
        return Ok(Vec::new());
    }
    // A named run "fell back" when it succeeded and its finalized output
    // manifest (the `manifest` line of one of its attempts whose SHA-256 the
    // run record holds) names the topic model `keywords`. Read by the run's
    // own attempts (`polis_queue_attempts` (env, job_id, lease_epoch)) and
    // their log lines (`polis_queue_logs` (env, attempt_id, seq)).
    const FELL_BACK: &str = "n.status = 'succeeded' AND EXISTS (\
        SELECT 1 FROM public.polis_queue_attempts a JOIN public.polis_queue_logs g \
          ON g.env = a.env AND g.attempt_id = a.attempt_id AND g.stream = 'manifest' \
        WHERE a.env = $1 AND a.job_id = n.job_id \
          AND CASE WHEN sha256(convert_to(g.line, 'UTF8')) = n.output_manifest_digest \
                   THEN g.line::jsonb #>> '{models,topic}' END = 'keywords')";
    let sql = format!(
        "WITH d AS (SELECT date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') \
                           AT TIME ZONE 'UTC' AS start) \
         SELECT l.zid, s.job_id::text, s.config_effective, \
                s.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delphi_jobs n \
                   WHERE n.env = $1 AND n.zid = l.zid AND n.status = 'succeeded' \
                     AND n.config_effective ->> 'names_of' IS NOT NULL \
                     AND n.config_effective #>> '{{shadow,namer}}' = $3 \
                     AND n.config_effective #>> '{{shadow,selection_sha256}}' \
                         = s.config_effective #>> '{{shadow,selection_sha256}}' \
                     AND n.config_effective #>> '{{shadow,comment_set_sha256}}' \
                         = s.config_effective #>> '{{shadow,comment_set_sha256}}' \
                     AND NOT ({FELL_BACK})), \
                s.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delphi_jobs n, d \
                   WHERE n.env = $1 AND n.zid = l.zid \
                     AND n.config_effective ->> 'names_of' = s.job_id::text \
                     AND n.config_effective #>> '{{shadow,namer}}' = $3 \
                     AND NOT (n.created_at < d.start AND {FELL_BACK})), \
                (SELECT count(*) FROM public.delphi_jobs n \
                   WHERE s.job_id IS NOT NULL AND n.env = $1 AND n.zid = l.zid \
                     AND n.config_effective ->> 'names_of' = s.job_id::text \
                     AND n.config_effective #>> '{{shadow,namer}}' = $3) \
         FROM unnest($2::int[]) WITH ORDINALITY AS l(zid, ord) \
         LEFT JOIN LATERAL (SELECT j.job_id, j.config_effective FROM public.delphi_jobs j \
                WHERE j.env = $1 AND j.zid = l.zid AND j.status = 'succeeded' \
                  AND j.config_effective ->> 'selection' = $4 \
                  AND j.config_effective ->> 'result_scope' = $5 \
                  AND j.config_effective ->> 'names_of' IS NULL \
                ORDER BY j.created_at DESC, j.job_id DESC LIMIT 1) s ON true \
         ORDER BY l.ord"
    );
    let rows = tx.query(
        sql.as_str(),
        &[&env, &zids, &namer, &super::plan::SELECTION, &SCOPE],
    )?;
    rows.iter()
        .map(|r| {
            let job: Option<String> = r.try_get(1)?;
            let config: Option<Value> = r.try_get(2)?;
            Ok(NamingSource {
                zid: r.try_get(0)?,
                source: job.zip(config),
                named: r.try_get(3)?,
                asked: r.try_get(4)?,
                asks: r.try_get(5)?,
            })
        })
        .collect()
}

/// The census of one conversation under a comment rule a list adds, in the
/// same snapshot as the check that a code of that list (`codes`) still names
/// the conversation, by `zinvites_zid_idx`. `None` when none does: the
/// resolution the scheduler holds is stale, and nothing is admitted on it.
pub fn rule_census(
    tx: &mut Transaction<'_>,
    zid: i32,
    selection: &str,
    codes: &[String],
) -> Result<Option<CommentSet>> {
    let named = tx
        .query_opt(
            "SELECT 1 FROM zinvites WHERE zid = $1 AND zinvite = ANY($2::text[]) LIMIT 1",
            &[&zid, &codes],
        )?
        .is_some();
    if !named {
        return Ok(None);
    }
    census(tx, zid, selection).map(Some)
}

/// The census of one conversation under the selection every conversation's
/// runs name, [`super::plan::SELECTION`] (what participants are shown).
pub fn comment_set(tx: &mut Transaction<'_>, zid: i32) -> Result<CommentSet> {
    census(tx, zid, super::plan::SELECTION)
}

/// The census of one conversation under `selection`. The comment set's digest is computed by
/// the input bundle's own function from the same columns the bundle reads, so
/// it equals the digest the run's census records
/// (`manifest.inputs.comment_set_sha256` in the run record); the selection by
/// the contract's own rule (`contract::select`), from the two more columns a
/// run that names it reads in its bundle (`strict_moderation`, `velocity`).
/// One read-only snapshot: `ACCESS SHARE` on `comments` and `conversations`
/// only, which no vote, comment or moderation statement waits on.
pub fn census(tx: &mut Transaction<'_>, zid: i32, selection: &str) -> Result<CommentSet> {
    let strict = tx
        .query_opt(
            "SELECT coalesce(strict_moderation, false) FROM conversations WHERE zid = $1",
            &[&zid],
        )?
        .map(|r| r.try_get::<_, bool>(0))
        .transpose()?
        .unwrap_or(false);
    let mut comments = Vec::new();
    for r in tx.query(
        "SELECT tid::bigint, zid::bigint, pid::bigint, txt::text, created::bigint, \
         mod::bigint, active, velocity::float8 FROM comments WHERE zid = $1::bigint ORDER BY tid",
        &[&i64::from(zid)],
    )? {
        comments.push(Comment {
            tid: r.try_get(0)?,
            zid: r.try_get(1)?,
            pid: r.try_get(2)?,
            txt: r.try_get(3)?,
            created: r.try_get(4)?,
            r#mod: r.try_get(5)?,
            active: r.try_get(6)?,
            velocity: Some(r.try_get(7)?),
        });
    }
    let selection = contract::select(selection, &comments, strict)?;
    let has_text = |c: &&Comment| !c.txt.trim().is_empty();
    let selected = comments
        .iter()
        .filter(has_text)
        .filter(|c| selection.tids.binary_search(&c.tid).is_ok())
        .count() as i64;
    Ok(CommentSet {
        digest: contract::comment_set_sha256(&comments),
        comments: comments.iter().filter(has_text).count() as i64,
        selection: selection.name,
        selection_digest: selection.sha256,
        selected,
    })
}

/// The newest vote's time against the math engine's newest write. Reads the
/// `votes_created_idx` end and `math_main`; no vote's value.
pub fn math_lag(tx: &mut Transaction<'_>, math_env: &str) -> Result<i64> {
    let row = tx.query_one(
        "SELECT (SELECT max(created) FROM votes)::bigint, \
                (SELECT max(modified) FROM math_main WHERE math_env = $1)::bigint",
        &[&math_env],
    )?;
    let vote: Option<i64> = row.try_get(0)?;
    let math: Option<i64> = row.try_get(1)?;
    Ok(match (vote, math) {
        (Some(v), Some(m)) => (v - m).max(0),
        (Some(_), None) => i64::MAX,
        _ => 0,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Admission {
    pub zid: i32,
    /// The publication scope it is admitted under: [`SCOPE`] for every
    /// conversation's run, the rule's own (`plan::rule_scope`) for a run a
    /// comment-rule list adds, so no rule's results replace another's.
    pub scope: String,
    pub key: String,
    pub request_sha: String,
    pub job_id: uuid::Uuid,
    pub run_id: uuid::Uuid,
    pub config: Value,
}

pub fn admit(client: &mut Client, env: &str, code: &str, a: &Admission) -> Result<Value> {
    let config = a.config.to_string();
    let reply: String = client
        .query_one(
            "SELECT public.pd_writer_admit($1,$2,$3,$4,$5,$6,$7::text::uuid,$8::text::uuid,\
             'delphi_full_pipeline',NULL,$9::text::jsonb,$10)::text",
            &[
                &env,
                &a.zid,
                &a.scope,
                &ACTOR,
                &a.key,
                &a.request_sha,
                &a.job_id.to_string(),
                &a.run_id.to_string(),
                &config,
                &code,
            ],
        )?
        .try_get(0)?;
    serde_json::from_str(&reply).context("admission reply")
}

pub fn job_state(client: &mut Client, env: &str, job_id: &str) -> Result<Option<String>> {
    let reply: Option<String> = client
        .query_one(
            "SELECT public.pq_job_status($1,$2::text::uuid)::text",
            &[&env, &job_id],
        )?
        .try_get(0)?;
    let Some(reply) = reply else { return Ok(None) };
    let v: Value = serde_json::from_str(&reply)?;
    Ok(v.get("state").and_then(Value::as_str).map(str::to_owned))
}

pub fn run_record(client: &mut Client, env: &str, job_id: &str) -> Result<Option<Value>> {
    let reply: Option<String> = client
        .query_one(
            "SELECT public.pd_run_record($1,$2::text::uuid)::text",
            &[&env, &job_id],
        )?
        .try_get(0)?;
    reply
        .map(|r| serde_json::from_str(&r).map_err(|e| anyhow!("run record: {e}")))
        .transpose()
}

/// The shadow env's served cluster assignments of one conversation: comment
/// id → one cluster id per layer (`layer<N>_cluster_id`, in layer order).
pub fn assignments(client: &mut Client, env: &str, zid: i32) -> Result<BTreeMap<i64, Vec<i64>>> {
    let rows = client.query(
        "SELECT item::text FROM public.delphi_result_current_rows \
         WHERE env=$1 AND zid=$2 AND scope_key=$3 \
         AND family='Delphi_CommentHierarchicalClusterAssignments'",
        &[&env, &zid, &SCOPE],
    )?;
    let mut out = BTreeMap::new();
    for r in rows {
        let item: Value = serde_json::from_str(&r.try_get::<_, String>(0)?)?;
        if let Some((comment, layers)) = parse_assignment(&item) {
            out.insert(comment, layers);
        }
    }
    Ok(out)
}

fn number(v: &Value) -> Option<i64> {
    match v {
        Value::Object(o) => o
            .get("N")
            .and_then(|n| n.as_str()?.parse::<f64>().ok())
            .map(|f| f as i64),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// One stored assignment row (DynamoDB-typed JSON): its comment id and its
/// cluster per layer. A layer the row does not carry (or carries as null) is
/// -1, unclustered.
pub fn parse_assignment(item: &Value) -> Option<(i64, Vec<i64>)> {
    let o = item.as_object()?;
    let comment = number(o.get("comment_id")?)?;
    let mut layers: Vec<(usize, i64)> = o
        .iter()
        .filter_map(|(k, v)| {
            let n = k
                .strip_prefix("layer")?
                .strip_suffix("_cluster_id")?
                .parse::<usize>()
                .ok()?;
            Some((n, number(v).unwrap_or(-1)))
        })
        .collect();
    layers.sort_unstable();
    let width = layers.last().map_or(0, |(n, _)| n + 1);
    let mut out = vec![-1; width];
    for (n, c) in layers {
        out[n] = c;
    }
    Some((comment, out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_assignment_row_reads_as_its_comment_and_layers() {
        let item = json!({"conversation_id":{"S":"7"},"comment_id":{"N":"12"},
            "layer0_cluster_id":{"N":"3"},"layer2_cluster_id":{"N":"0"},
            "layer1_cluster_id":{"NULL":true},"umap_x":{"N":"0.5"}});
        assert_eq!(parse_assignment(&item), Some((12, vec![3, -1, 0])));
        assert_eq!(
            parse_assignment(&json!({"layer0_cluster_id":{"N":"1"}})),
            None
        );
    }
}
