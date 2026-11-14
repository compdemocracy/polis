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
//! run's own keys. With an important-conversations list, the read login also
//! resolves its codes on `zinvites` (the unique index on the code), the same
//! read the participation path makes to find a conversation; and it lists the
//! conversations with many participants from `conversations.participant_count`
//! (one pass over `conversations`, no index on that column). Both are read
//! once a UTC day (the scheduler's roster), never per poll, and both take
//! `ACCESS SHARE` only, which the `conversations` updates votes and comments
//! cause (`ROW EXCLUSIVE`) do not wait on.
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

/// One comment set, as the run's census will digest it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentSet {
    pub digest: String,
    pub comments: i64,
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

    fn connect_queue(&self) -> Result<Client> {
        Connector::from_parts(
            &self.cfg.queue_dsn,
            &self.cfg.transport,
            self.cfg.password_file.as_deref(),
            QUEUE_APPLICATION,
        )?
        .connect()
    }

    /// One read-only transaction with the scheduler's bounds.
    fn read<T>(&self, f: impl FnOnce(&mut Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut client = self.connect_read()?;
        read_only(&mut client, self.cfg.statement_timeout.as_millis(), f)
    }

    /// Conversations with a comment created or moderated since `since_ms`.
    pub fn live(&self, since_ms: i64) -> Result<Vec<Live>> {
        self.read(|tx| live(tx, since_ms))
    }

    /// The roster's two reads, in one read-only transaction on one
    /// connection: the listed conversations that exist, in the list's order,
    /// and those of at least `min` participants, most first.
    pub fn roster(&self, codes: &[String], min: i32) -> Result<(Vec<Live>, Vec<Live>)> {
        self.read(|tx| Ok((important(tx, codes)?, large(tx, min)?)))
    }

    pub fn comment_set(&self, zid: i32) -> Result<CommentSet> {
        self.read(|tx| comment_set(tx, zid))
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
        self.read(|tx| storage::measure(tx, &p.env, &p.job_id, p.zid))
    }

    /// Every shadow env's jobs, once per state file (`storage`).
    pub fn shadow_jobs(&self) -> Result<Vec<Pending>> {
        self.read(storage::shadow_jobs)
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

/// The conversations an important-conversations list names, highest priority
/// first: each code resolved through `zinvites_zinvite_key`, then its counts by
/// the primary key, as `live` counts them. A code no conversation has is left
/// out (the caller counts it); a conversation with no comment reads as 0, and
/// one two codes name is kept at its first place.
pub fn important(tx: &mut Transaction<'_>, codes: &[String]) -> Result<Vec<Live>> {
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

/// Every conversation with at least `min` participants
/// (`conversations.participant_count`, which the participant trigger keeps at
/// the highest participant number plus one), most participants first, with
/// its counts as `live` counts them (by the comments' `zid` index). One pass
/// over `conversations`: read once a day, not per poll. `min` 0 reads nothing.
pub fn large(tx: &mut Transaction<'_>, min: i32) -> Result<Vec<Live>> {
    if min <= 0 {
        return Ok(Vec::new());
    }
    let rows = tx.query(
        "WITH big AS (SELECT zid, participant_count FROM conversations WHERE participant_count >= $1) \
         SELECT b.zid, \
                (count(c.tid) FILTER (WHERE c.txt IS NOT NULL AND btrim(c.txt) <> ''))::bigint, \
                max(c.modified)::bigint \
         FROM big b LEFT JOIN comments c ON c.zid = b.zid \
         GROUP BY b.zid, b.participant_count ORDER BY b.participant_count DESC, b.zid",
        &[&min],
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

/// The comment set's digest, computed by the input bundle's own function from
/// the same columns the bundle reads, so it equals the digest the run's census
/// records (`manifest.inputs.comment_set_sha256` in the run record).
pub fn comment_set(tx: &mut Transaction<'_>, zid: i32) -> Result<CommentSet> {
    let mut comments = Vec::new();
    for r in tx.query(
        "SELECT tid::bigint, zid::bigint, pid::bigint, txt::text, created::bigint, \
         mod::bigint, active FROM comments WHERE zid = $1::bigint ORDER BY tid",
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
        });
    }
    let with_text = comments.iter().filter(|c| !c.txt.trim().is_empty()).count() as i64;
    Ok(CommentSet {
        digest: contract::comment_set_sha256(&comments),
        comments: with_text,
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
                &SCOPE,
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
