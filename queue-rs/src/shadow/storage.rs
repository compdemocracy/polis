//! The bytes the shadow adds to the database, and the budget that bounds them.
//!
//! Shadow rows cannot be deleted (result rows, families and embeddings are
//! immutable by trigger, and nothing prunes a shadow env yet), so the
//! scheduler stops admitting when the shadow has added
//! `DELPHI_SHADOW_STORAGE_BUDGET_MB` in all (3 GiB by default), or, when
//! `DELPHI_SHADOW_STORAGE_DAILY_MB` is set above 0, that many in one UTC day
//! (by default there is no daily limit). Of the budget,
//! `DELPHI_SHADOW_LIVE_RESERVE_MB` (1 GiB by default) is kept for the current
//! set (the live conversations): the benchmark and featured sets together, and
//! twins, stop at the budget less it; current runs at the whole budget.
//!
//! How the bytes are read, cheaply: never by scanning a table. Each run's
//! bytes are read from the database once, after the run is terminal, by one
//! read-only statement whose every read is an index range on that run's own
//! keys: its attempts (`polis_queue_attempts (env, job_id, lease_epoch)`),
//! and per attempt its result rows and families (primary keys led by
//! `(env, batch_id)`, the batch being the attempt), its log lines
//! (`(env, attempt_id, seq)`), and the embeddings its attempts first wrote
//! (`(env, zid, model_id, tid)`, filtered to its batches). The cost is
//! proportional to the run, not to the tables. The sum is kept in the state
//! file with the day's share; the poll in between reads nothing.
//!
//! A run's bytes are the on-disk size of what it stored, modelled row by row
//! from its values as `pg_column_size` gives them (compressed, as stored):
//! the heap row (header, alignment, line pointer) charged its share of a page
//! of rows its size, or, when TOAST moves its large values out, a small heap
//! row and the values in TOAST chunks; and one entry per index of the table
//! (its keys, header, alignment, line pointer) at half a leaf's room, since
//! every index of these tables is led by the run's own random id (its batch,
//! attempt or conversation), so its entries go into the middle of the index,
//! where a B-tree leaf that fills is split in two halves. Plus [`JOB_BYTES`]
//! for the queue's own rows of the job (job, run, request, attempts, batch,
//! artifact). `tests/delphi_shadow.rs` holds the measure against what the
//! tables really grew by, and holds the indexes modelled here to the ones the
//! migrations create.
//!
//! The state file is a cache of the database, not the record: a scheduler
//! that starts without one (a new volume, a lost file) lists every job of
//! every `shadow-` env (`delphi_jobs`, once) and measures each again, a few
//! per poll, admitting nothing until it has.
use anyhow::Result;
use postgres::Transaction;
use serde::{Deserialize, Serialize};

pub const MIB: u64 = 1024 * 1024;
/// The queue's own rows of one job, counted with it: measured at 10 to 15 KB
/// a job in the rehearsal (jobs, attempts, runs, requests, batches,
/// artifacts, with their indexes).
pub const JOB_BYTES: u64 = 16 * 1024;
/// The bytes a comment adds per run before any run is measured: the
/// rehearsal measured about 7.3 KB a comment per run, all tables in.
pub const DEFAULT_BYTES_PER_COMMENT: u64 = 8 * 1024;
/// How many runs a fresh state file measures per poll.
pub const MEASURE_PER_CYCLE: usize = 20;

/// What one job stored, by table: rows and bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Measured {
    pub attempts: u64,
    pub result_rows: u64,
    pub result_row_bytes: u64,
    pub families: u64,
    pub family_bytes: u64,
    pub embeddings: u64,
    pub embedding_bytes: u64,
    pub log_lines: u64,
    pub log_bytes: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub graph_bytes: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

impl Measured {
    /// The bytes the four tables hold for the job.
    pub fn stored(&self) -> u64 {
        self.result_row_bytes
            + self.family_bytes
            + self.embedding_bytes
            + self.log_bytes
            + self.graph_bytes
    }

    /// With the queue's own rows of the job.
    pub fn total(&self) -> u64 {
        self.stored() + JOB_BYTES
    }
}

/// A heap row of these columns on disk. Its size t is the 24-byte header and
/// the values aligned to 8 bytes, with its 4-byte line pointer; a page holds
/// 8,168 bytes of rows, so a row is charged 8,192 / (rows of its size a page
/// holds). Over 2,032 bytes TOAST moves the large values out: the row is
/// charged a small heap row and its values in 1,996-byte chunks, four to a
/// page, each with its index entry (2,080 bytes a chunk).
fn heap(cols: &[&str]) -> String {
    let values = sizes(cols);
    let t = format!("((((24 + {values}) + 7) / 8 * 8) + 4)");
    format!(
        "CASE WHEN {t} <= 2032 THEN 8192 / (8168 / {t}) \
         ELSE 256 + (({values}) + 1995) / 1996 * 2080 END"
    )
}

/// A B-tree leaf entry of these key columns: its 8-byte header and the keys,
/// aligned to 8 bytes, and its line pointer, at half a leaf's room.
fn entry(keys: &[&str]) -> String {
    format!("((((8 + {}) + 7) / 8 * 8) + 4) * 2", sizes(keys))
}

fn sizes(cols: &[&str]) -> String {
    cols.iter()
        .map(|c| format!("pg_column_size({c})"))
        .collect::<Vec<_>>()
        .join(" + ")
}

/// One table's rows of the job and their bytes: `(count, bytes)`, summed over
/// the heap row and one entry per index.
fn table(name: &str, filter: &str, heap_cols: &[&str], indexes: &[&[&str]]) -> String {
    let mut per_row = vec![heap(heap_cols)];
    per_row.extend(indexes.iter().map(|keys| entry(keys)));
    format!(
        "(SELECT count(*)::bigint AS n, coalesce(sum({}), 0)::bigint AS bytes \
         FROM public.{name} WHERE {filter})",
        per_row.join(" + ")
    )
}

/// The indexes of the four tables, by name, as the migrations create them:
/// what [`measure_sql`] charges an entry in. A migration that adds one must
/// add it here (`tests/delphi_shadow.rs` compares this list with the
/// database's).
pub const INDEXES: [(&str, &str); 7] = [
    ("delphi_result_rows", "delphi_result_rows_pkey"),
    (
        "delphi_result_rows",
        "delphi_result_rows_env_batch_id_family_ordinal_key",
    ),
    ("delphi_result_rows", "delphi_result_rows_key_order"),
    ("delphi_result_families", "delphi_result_families_pkey"),
    (
        "delphi_comment_embeddings",
        "delphi_comment_embeddings_pkey",
    ),
    (
        "delphi_comment_embeddings",
        "delphi_comment_embeddings_env_zid_model_id_seq_key",
    ),
    ("polis_queue_logs", "polis_queue_logs_pkey"),
];

/// The statement that reads one job's bytes. `$1` the env, `$2` the job, `$3`
/// its conversation. Every read is an index range on the job's own keys (see
/// the module comment): its attempts, and per attempt (a result batch is an
/// attempt) its rows in each of the four tables.
pub fn measure_sql() -> String {
    let batch = "env = $1 AND batch_id = ANY(ARRAY(SELECT attempt_id FROM a))";
    let rows = table(
        "delphi_result_rows",
        batch,
        &["env", "batch_id", "family", "item_key", "ordinal", "item"],
        &[
            &["env", "batch_id", "family", "item_key"],
            &["env", "batch_id", "family", "ordinal"],
            &[
                "env",
                "batch_id",
                "family",
                "COALESCE((item_key->-1->>'N')::numeric, 0)",
                "COALESCE(item_key->-1->>'S', '')",
            ],
        ],
    );
    let families = table(
        "delphi_result_families",
        batch,
        &[
            "env",
            "batch_id",
            "family",
            "codec_wire",
            "content_sha",
            "row_count",
        ],
        &[&["env", "batch_id", "family"]],
    );
    let embeddings = table(
        "delphi_comment_embeddings",
        "env = $1 AND zid = $3 AND batch_id = ANY(ARRAY(SELECT attempt_id FROM a))",
        &[
            "env",
            "zid",
            "model_id",
            "tid",
            "seq",
            "text_sha",
            "embedding",
            "batch_id",
        ],
        &[
            &["env", "zid", "model_id", "tid"],
            &["env", "zid", "model_id", "seq"],
        ],
    );
    let logs = table(
        "polis_queue_logs",
        "env = $1 AND attempt_id = ANY(ARRAY(SELECT attempt_id FROM a))",
        &["env", "attempt_id", "seq", "ts", "stream", "line"],
        &[&["env", "attempt_id", "seq"]],
    );
    format!(
        "WITH a AS (SELECT attempt_id FROM public.polis_queue_attempts \
                    WHERE env = $1 AND job_id = $2::text::uuid) \
         SELECT (SELECT count(*) FROM a)::bigint, r.n, r.bytes, f.n, f.bytes, e.n, e.bytes, l.n, l.bytes \
         FROM {rows} r, {families} f, {embeddings} e, {logs} l"
    )
}

pub fn measure(tx: &mut Transaction<'_>, env: &str, job_id: &str, zid: i32) -> Result<Measured> {
    let r = tx.query_one(&measure_sql(), &[&env, &job_id, &zid])?;
    let n = |i: usize| -> Result<u64> { Ok(r.try_get::<_, i64>(i)?.max(0) as u64) };
    Ok(Measured {
        attempts: n(0)?,
        result_rows: n(1)?,
        result_row_bytes: n(2)?,
        families: n(3)?,
        family_bytes: n(4)?,
        embeddings: n(5)?,
        embedding_bytes: n(6)?,
        log_lines: n(7)?,
        log_bytes: n(8)?,
        graph_bytes: 0,
    })
}

/// One job whose bytes are still to be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub env: String,
    pub job_id: String,
    pub zid: i32,
    /// The comments its admission named (`config_effective.shadow.comments`).
    pub comments: i64,
    /// The named set its admission named (`config_effective.shadow.set`;
    /// `None` for a run admitted before runs named it), for the log.
    #[serde(default)]
    pub set: Option<crate::shadow::plan::Set>,
}

/// Every job of every shadow env, oldest first, but derived topic map jobs:
/// read once, by a scheduler that starts with no record of what it measured.
/// `delphi_jobs` holds one row per job and has no index led by a prefix of
/// `env`, so this is the one read that scans it; it never runs again for that
/// state file.
///
/// `kind <> 'derived'` is the one predicate that keeps derived jobs out of the
/// full runs' accounting: the runs' ledger is filled only from this listing
/// and from the scheduler's own runs (never a derived job), so a new ledger
/// does not measure, count or log derived jobs as runs. `kind` is `NOT NULL`, and a
/// database without derived jobs (every database before the migration that
/// allows the kind) gives exactly the rows, in the order, it gave without the
/// predicate. A previously saved ledger or pending list from an older release
/// can still contain derived jobs; loading it does not relist or subtract
/// them. Derived jobs have their own budget ([`derived_total_sql`]).
pub fn shadow_jobs(tx: &mut Transaction<'_>) -> Result<Vec<Pending>> {
    tx.query(
        "SELECT env, job_id::text, zid, \
                coalesce((config_effective #>> '{shadow,comments}')::bigint, 0), \
                config_effective #>> '{shadow,set}' \
         FROM public.delphi_jobs WHERE left(env, 7) = 'shadow-' AND kind <> 'derived' \
         ORDER BY created_at, job_id",
        &[],
    )?
    .iter()
    .map(|r| {
        Ok(Pending {
            env: r.try_get(0)?,
            job_id: r.try_get(1)?,
            zid: r.try_get(2)?,
            comments: r.try_get(3)?,
            set: r
                .try_get::<_, Option<String>>(4)?
                .as_deref()
                .and_then(crate::shadow::plan::Set::from_word),
        })
    })
    .collect()
}

/// Age after which an eligible cycle refreshes a successful derived reading
/// (ms). This cached estimate is a growth threshold, not a reservation: it
/// excludes nonterminal jobs and may lag completions or independent askers.
pub const DERIVED_READ_MS: i64 = 300_000;
/// A stored result row, apart from its item and its env, as [`measure_sql`]
/// models it: the heap row's header, batch, family, key and ordinal, its line
/// pointer and page share, and its three index entries at half a leaf's room,
/// with their alignment.
pub const DERIVED_ROW_BYTES: u64 = 640;
/// Per byte of the env, per result row: the env is stored in the heap row
/// and in each of its three index entries (an entry is charged twice, at
/// half a leaf's room), 7 bytes, and one more for alignment.
pub const DERIVED_ROW_PER_ENV_BYTE: u64 = 8;
/// The item of a stored result row, per byte of its line in the family's
/// wire: jsonb of these DynamoDB-shaped values is larger than their text
/// (headers and entries per key), counted twice.
pub const DERIVED_ITEM_PER_WIRE_BYTE: u64 = 2;

/// The bytes the scheduler's env's terminal derived jobs have stored, read
/// from the database in one statement: what [`measure`] counts for a job,
/// summed over every such job, except that its result rows are ESTIMATED
/// from what their family records at store time (its `row_count` and its
/// wire's length) instead of read row by row. `$1` the env, `$2` the UTC
/// day's start (ms), for the day's share (jobs completed since; logged only).
///
/// Counted exactly as [`measure`] does: [`JOB_BYTES`] per job, each family
/// row (heap and key entry), each log line (heap and key entry). Estimated:
/// the result rows, `row_count * (`[`DERIVED_ROW_BYTES`] `+`
/// [`DERIVED_ROW_PER_ENV_BYTE`] `* env length) +`
/// [`DERIVED_ITEM_PER_WIRE_BYTE`] `*` the wire's length. It is an estimate,
/// not a bound: above [`measure`]'s result rows on every case measured (a
/// job that stored no map, at a 16- and at the longest 64-byte env; the
/// small and the large checked-in maps), by up to about 3.2 times on the
/// large map's rows (about 2 times its whole job). Its purpose, to stop the
/// derived maps' growth at their budget, does not depend on its exactness.
/// Left out: comment embeddings (a derived job stores none) and graph
/// records (it has none). The plan is sequential scans and hash joins over
/// the env's terminal derived jobs, their attempts, families and log lines:
/// proportional to those, never to the result rows.
pub fn derived_total_sql() -> String {
    let family = format!(
        "{} + {}",
        heap(&[
            "env",
            "batch_id",
            "family",
            "codec_wire",
            "content_sha",
            "row_count",
        ]),
        entry(&["env", "batch_id", "family"])
    );
    let rows = format!(
        "row_count::bigint * ({DERIVED_ROW_BYTES} + {DERIVED_ROW_PER_ENV_BYTE} * octet_length(env)) \
         + octet_length(codec_wire)::bigint * {DERIVED_ITEM_PER_WIRE_BYTE}"
    );
    let log = format!(
        "{} + {}",
        heap(&["env", "attempt_id", "seq", "ts", "stream", "line"]),
        entry(&["env", "attempt_id", "seq"])
    );
    format!(
        "WITH j AS (SELECT job_id AS job, completed_at >= to_timestamp($2::float8 / 1000) AS today \
                    FROM public.delphi_jobs WHERE env = $1 AND kind = 'derived' \
                     AND status IN ('succeeded','dead','cancelled')), \
              a AS (SELECT q.attempt_id AS att, j.today FROM j \
                    JOIN public.polis_queue_attempts q ON q.env = $1 AND q.job_id = j.job) \
         SELECT (SELECT count(*) FROM j)::bigint, \
                (SELECT count(*) FILTER (WHERE today) FROM j)::bigint, \
                (SELECT count(*) FROM a)::bigint, f.n, f.rows, f.fb, f.rb, f.day, l.n, l.lb, l.day \
         FROM (SELECT count(*)::bigint AS n, coalesce(sum(row_count), 0)::bigint AS rows, \
                      coalesce(sum({family}), 0)::bigint AS fb, \
                      coalesce(sum({rows}), 0)::bigint AS rb, \
                      coalesce(sum(({family}) + ({rows})) FILTER (WHERE today), 0)::bigint AS day \
               FROM a JOIN public.delphi_result_families ON env = $1 AND batch_id = a.att) f, \
              (SELECT count(*)::bigint AS n, coalesce(sum({log}), 0)::bigint AS lb, \
                      coalesce(sum({log}) FILTER (WHERE today), 0)::bigint AS day \
               FROM a JOIN public.polis_queue_logs ON env = $1 AND attempt_id = a.att) l"
    )
}

/// One reading of [`derived_total_sql`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct DerivedTotal {
    pub jobs: u64,
    pub day_jobs: u64,
    pub attempts: u64,
    pub families: u64,
    pub rows: u64,
    pub family_bytes: u64,
    /// Modelled (see [`derived_total_sql`]).
    pub row_bytes: u64,
    pub log_lines: u64,
    pub log_bytes: u64,
    /// Everything, [`JOB_BYTES`] per job included.
    pub bytes: u64,
    /// The share of jobs completed since the day's start.
    pub day_bytes: u64,
}

pub fn derived_total(
    tx: &mut Transaction<'_>,
    env: &str,
    day_start_ms: i64,
) -> Result<DerivedTotal> {
    let r = tx.query_one(&derived_total_sql(), &[&env, &(day_start_ms as f64)])?;
    let n = |i: usize| -> Result<u64> { Ok(r.try_get::<_, i64>(i)?.max(0) as u64) };
    let (jobs, day_jobs) = (n(0)?, n(1)?);
    let (family_bytes, row_bytes, log_bytes) = (n(5)?, n(6)?, n(9)?);
    Ok(DerivedTotal {
        jobs,
        day_jobs,
        attempts: n(2)?,
        families: n(3)?,
        rows: n(4)?,
        family_bytes,
        row_bytes,
        log_lines: n(8)?,
        log_bytes,
        bytes: jobs * JOB_BYTES + family_bytes + row_bytes + log_bytes,
        day_bytes: day_jobs * JOB_BYTES + n(7)? + n(10)?,
    })
}

/// The derived jobs' stored bytes, for their own budget (the topic map
/// backfill's `DELPHI_SHADOW_DERIVED_STORAGE_BYTES`): the latest reading of
/// [`derived_total`], kept in process memory only until the next
/// ([`DERIVED_READ_MS`]). It is a reading of the database, never a running
/// total, and never part of the full runs' [`Ledger`]. `None` (none yet, or
/// the last one failed) is an unknown total: no derived job is asked for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Derived {
    pub read: Option<DerivedTotal>,
    /// When `read` was read (ms).
    pub read_ms: i64,
}

impl Derived {
    /// Due for a reading: none yet, or [`DERIVED_READ_MS`] since the last.
    pub fn due(&self, now_ms: i64) -> bool {
        self.read.is_none() || now_ms - self.read_ms >= DERIVED_READ_MS
    }

    pub fn bytes(&self) -> Option<u64> {
        self.read.map(|t| t.bytes)
    }
}

/// What the scheduler knows of the shadow's bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    /// The shadow envs' jobs were listed from the database (once per state file).
    pub reconciled: bool,
    pub bytes: u64,
    pub jobs: u64,
    /// The comments of every measured run, summed (for the estimate).
    pub comment_runs: u64,
    /// The UTC day (days since the epoch) `day_bytes` is for.
    pub day: i64,
    pub day_bytes: u64,
    /// Terminal jobs not yet measured; nothing is admitted while any is.
    pub pending: Vec<Pending>,
}

impl Ledger {
    pub fn roll_day(&mut self, now_ms: i64) {
        let day = now_ms.div_euclid(86_400_000);
        if day != self.day {
            self.day = day;
            self.day_bytes = 0;
        }
    }

    pub fn add(&mut self, now_ms: i64, comments: i64, bytes: u64) {
        self.roll_day(now_ms);
        self.bytes = self.bytes.saturating_add(bytes);
        self.day_bytes = self.day_bytes.saturating_add(bytes);
        self.jobs += 1;
        self.comment_runs = self.comment_runs.saturating_add(comments.max(0) as u64);
    }

    /// The measured bytes a comment adds per run (the queue's own rows of
    /// each job left out), or the rehearsal's figure before any is measured.
    pub fn bytes_per_comment(&self) -> u64 {
        if self.comment_runs == 0 {
            return DEFAULT_BYTES_PER_COMMENT;
        }
        (self.bytes.saturating_sub(self.jobs * JOB_BYTES) / self.comment_runs).max(1)
    }

    /// What a run of `comments` comments is expected to add.
    pub fn estimate(&self, comments: i64) -> u64 {
        (comments.max(0) as u64).saturating_mul(self.bytes_per_comment()) + JOB_BYTES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ledger_counts_by_day_and_estimates_from_what_it_measured() {
        let mut l = Ledger::default();
        assert_eq!(l.bytes_per_comment(), DEFAULT_BYTES_PER_COMMENT);
        assert_eq!(l.estimate(100), 100 * DEFAULT_BYTES_PER_COMMENT + JOB_BYTES);
        let day = 86_400_000;
        l.add(3 * day + 5, 100, 100 * 5000 + JOB_BYTES);
        l.add(3 * day + 6, 300, 300 * 5000 + JOB_BYTES);
        assert_eq!((l.jobs, l.comment_runs), (2, 400));
        assert_eq!(l.bytes, 400 * 5000 + 2 * JOB_BYTES);
        assert_eq!(l.day_bytes, l.bytes);
        assert_eq!(l.bytes_per_comment(), 5000);
        assert_eq!(l.estimate(10), 10 * 5000 + JOB_BYTES);
        // A new UTC day starts the daily count again; the total stays.
        l.roll_day(4 * day);
        assert_eq!((l.day, l.day_bytes), (4, 0));
        l.add(4 * day + 1, 0, JOB_BYTES);
        assert_eq!(l.day_bytes, JOB_BYTES);
        assert_eq!(l.bytes, 400 * 5000 + 3 * JOB_BYTES);
        // A failed run (nothing stored but the queue's rows) does not divide by zero.
        let mut f = Ledger::default();
        f.add(0, 0, JOB_BYTES);
        assert_eq!(f.bytes_per_comment(), DEFAULT_BYTES_PER_COMMENT);
        assert_eq!(Measured::default().total(), JOB_BYTES);
    }
}
