//! The bytes the shadow adds to the database, and the budget that bounds them.
//!
//! Shadow rows cannot be deleted (result rows, families and embeddings are
//! immutable by trigger, and nothing prunes a shadow env yet), so the
//! scheduler stops admitting when the shadow has added
//! `DELPHI_SHADOW_STORAGE_BUDGET_MB` in all (3 GiB by default), or
//! `DELPHI_SHADOW_STORAGE_DAILY_MB` in one UTC day (300 MiB by default).
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
}

impl Measured {
    /// The bytes the four tables hold for the job.
    pub fn stored(&self) -> u64 {
        self.result_row_bytes + self.family_bytes + self.embedding_bytes + self.log_bytes
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
}

/// Every job of every shadow env, oldest first: read once, by a scheduler that
/// starts with no record of what it measured. `delphi_jobs` holds one row per
/// job and has no index led by a prefix of `env`, so this is the one read
/// that scans it; it never runs again for that state file.
pub fn shadow_jobs(tx: &mut Transaction<'_>) -> Result<Vec<Pending>> {
    tx.query(
        "SELECT env, job_id::text, zid, \
                coalesce((config_effective #>> '{shadow,comments}')::bigint, 0) \
         FROM public.delphi_jobs WHERE left(env, 7) = 'shadow-' ORDER BY created_at, job_id",
        &[],
    )?
    .iter()
    .map(|r| {
        Ok(Pending {
            env: r.try_get(0)?,
            job_id: r.try_get(1)?,
            zid: r.try_get(2)?,
            comments: r.try_get(3)?,
        })
    })
    .collect()
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
