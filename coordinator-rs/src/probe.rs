//! CO01 incremental discovery: a cheap per-conversation change probe in front
//! of the authoritative full snapshot, and the durable per-zid cursor that
//! bounds how long the fast path may be trusted.
//!
//! The contract is explicit about what this may and may not be. Rev5:
//! "Count/max(created)/max(modified) are optimization hints, not completeness
//! proof: unchanged aggregate maxima can hide changed state or a late commit.
//! Keep the authoritative reconciliation path unless a separately proven change
//! token covers every relevant transaction; never make a weak hint the only
//! rebuild gate." So this probe is a *filter*, never a gate:
//!
//! 1. A probe that **differs** always forces the authoritative full snapshot.
//! 2. A probe that **matches** skips the full snapshot only while this
//!    conversation's last authoritative reconciliation is younger than
//!    `P026_RECONCILE_SECONDS`. Every conversation is therefore fully
//!    reconciled at a bounded age no matter what the hint says, and CO05's
//!    complete fair sweep stays the unconditional backstop.
//! 3. `P026_INCREMENTAL=0` disables the fast path entirely and restores the
//!    original behaviour: every pass takes the full authoritative snapshot.
//! 4. The probe is captured **before** the snapshot it certifies, and the
//!    database timestamp it carries is the one recorded as `reconciled_at`.
//!    A row that commits between the probe and the snapshot changes the *next*
//!    probe, so a concurrent write can never be swallowed by a stored later
//!    probe; and because the stored age runs from *before* the source read
//!    rather than from the end of publication, a long compute cannot reset the
//!    advertised source age (Rev7 CO01: "a completion timestamp must not
//!    masquerade as the age of the source observed").
//! 5. The probe carries `ordering::algorithm_digest`, so the declared source
//!    normalization and its storage agree-convention constant are part of the
//!    change token: flipping the convention invalidates every conversation
//!    even though no source row moved.
//!
//! `OldestReconciliationAgeSeconds` is the metric that makes the whole scheme
//! auditable, and it is why the metrics in this prototype are not decoration:
//! the incremental fast path is only sound while that age stays bounded.
use crate::{ordering, store::PgStore};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::time::{Duration, SystemTime};

/// Pinned so a stored probe from an older shape is never compared as equal.
pub const SCHEMA: &str = "polis-source-probe/1";

/// One statement, therefore one snapshot, over the three source tables.
/// Aggregates only: no row is materialised and no payload is detoasted.
const PROBE_SQL: &str = "SELECT clock_timestamp(), jsonb_build_object(
 'schema',$3::text,
 'votes',(SELECT jsonb_build_object('n',count(*),'max_created',max(created),
    'min_created',min(created),'sum_created',COALESCE(sum(created),0),
    'sum_vote',COALESCE(sum(vote),0),'sum_weight',COALESCE(sum(weight_x_32767),0))
   FROM votes WHERE zid=$1),
 'comments',(SELECT jsonb_build_object('n',count(*),'max_modified',max(modified),
    'sum_modified',COALESCE(sum(modified),0),'sum_mod',COALESCE(sum(mod),0),
    'meta',count(*) FILTER (WHERE is_meta))
   FROM comments WHERE zid=$1),
 'participants',(SELECT jsonb_build_object('n',count(*),'sum_mod',COALESCE(sum(mod),0))
   FROM participants WHERE zid=$1),
 'ordering_algorithm',$2::text)";

/// Aggregate CO01/CO06 gauges for one namespace and shard.
#[derive(Debug, Clone, Copy)]
pub struct Backlog {
    /// Conversations never reconciled, or overdue for reconciliation.
    pub overdue: i64,
    /// CO01 scan age. For a never-reconciled conversation the age runs from
    /// `conversations.created`, so a conversation the coordinator has never
    /// looked at cannot hide behind an empty table.
    pub oldest_reconciliation: Duration,
    /// Conversations currently in durable backoff. Scoped to this shard and
    /// allowlist, exactly like the source-age gauges: a failure this process
    /// would never attempt is not this process's backlog (Rev7 observability).
    pub failures: i64,
    /// CO06 oldest unrepaired age.
    pub oldest_unrepaired: Duration,
}

/// A probe, with the database time at which it — and therefore, conservatively,
/// the source snapshot it precedes — was observed.
pub struct Probe {
    pub value: Value,
    pub observed_at: SystemTime,
}

impl PgStore {
    /// The cheap change hint for one conversation, stamped with database time
    /// taken in the same statement and therefore before the source read.
    pub fn probe(&mut self, zid: i32) -> Result<Probe> {
        let algorithm = ordering::algorithm_digest(self.config.storage_agree_value)?;
        let row = self
            .client
            .query_one(PROBE_SQL, &[&zid, &algorithm, &SCHEMA])?;
        Ok(Probe {
            observed_at: row.get(0),
            value: row.get(1),
        })
    }

    /// The stored probe and the age of the authoritative snapshot it certifies.
    pub fn reconciliation(&mut self, zid: i32) -> Result<Option<(Value, Duration)>> {
        let row = self.client.query_opt(
            "SELECT source_probe,EXTRACT(EPOCH FROM clock_timestamp()-reconciled_at)::float8
             FROM polis_coordinator_reconciliation WHERE math_env=$1 AND zid=$2",
            &[&self.config.math_env, &zid],
        )?;
        Ok(row.map(|r| {
            (
                r.get::<_, Value>(0),
                Duration::from_secs_f64(r.get::<_, f64>(1).max(0.0)),
            )
        }))
    }

    /// Record that the authoritative snapshot was taken, with the probe that
    /// was observed **before** it and the database time of that observation —
    /// not the time this call happens, which is after compute and publication.
    /// Its own small transaction: this is a discovery hint, and CO04 forbids
    /// adding it to the publication transaction's lock set. Parent-first
    /// ordering still applies.
    pub fn record_reconciliation(&mut self, zid: i32, probe: &Probe) -> Result<()> {
        ensure!(probe.value["schema"] == SCHEMA, "unrecognised probe shape");
        let mut tx = self.client.transaction()?;
        tx.query_one(
            "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
            &[&zid],
        )?;
        tx.execute(
            "INSERT INTO polis_coordinator_reconciliation(math_env,zid,reconciled_at,source_probe)
             VALUES($1,$2,$4,$3)
             ON CONFLICT(math_env,zid) DO UPDATE
             SET reconciled_at=excluded.reconciled_at,source_probe=excluded.source_probe",
            &[
                &self.config.math_env,
                &zid,
                &probe.value,
                &probe.observed_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The CO01 backlog/scan-age and CO06 unrepaired-age gauges, scoped to this
    /// namespace and this shard's candidate conversations. One bounded
    /// aggregate statement; it reads no payload column.
    pub fn backlog(&mut self) -> Result<Backlog> {
        let c = &self.config;
        let row = self.client.query_one(
            "WITH mine AS (
               SELECT zid,created FROM conversations
                WHERE zid % $2 = $3
                  AND (cardinality($4::int[])=0 OR zid = ANY($4))
             ), state AS (
               SELECT m.zid,
                      COALESCE(EXTRACT(EPOCH FROM r.reconciled_at),m.created/1000.0) AS at,
                      r.reconciled_at IS NULL
                        OR r.reconciled_at <= clock_timestamp()-make_interval(secs=>$5::int)
                        AS overdue
                 FROM mine m
                 LEFT JOIN polis_coordinator_reconciliation r
                        ON r.math_env=$1 AND r.zid=m.zid
             )
             SELECT COALESCE(count(*) FILTER (WHERE overdue),0)::bigint,
                    COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp())-min(at),0),0)::float8,
                    (SELECT count(*) FROM polis_coordinator_failures f
                      WHERE f.math_env=$1 AND EXISTS(SELECT 1 FROM mine m WHERE m.zid=f.zid))::bigint,
                    (SELECT COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(f.first_failed_at)),0)
                       FROM polis_coordinator_failures f
                      WHERE f.math_env=$1 AND EXISTS(SELECT 1 FROM mine m WHERE m.zid=f.zid))::float8
               FROM state",
            &[
                &c.math_env,
                &c.shard_count,
                &c.shard_index,
                &c.allowlist,
                &c.reconcile_seconds,
            ],
        )?;
        Ok(Backlog {
            overdue: row.get(0),
            oldest_reconciliation: Duration::from_secs_f64(row.get::<_, f64>(1).max(0.0)),
            failures: row.get(2),
            oldest_unrepaired: Duration::from_secs_f64(row.get::<_, f64>(3).max(0.0)),
        })
    }
}
