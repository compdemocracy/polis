//! CO04 v0: parent -> lease -> ticks -> bidtopid -> ptptstats -> main.
use crate::{
    cache::WarmCache,
    config::Config,
    fault::Fault,
    lease::{self, LeaseState},
    metrics::{Metrics, Tally},
};
use anyhow::{Result, ensure};
use postgres::{Client, NoTls};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Integrity digest over JSONB numeric equality, NOT the harness semantic hash.
/// PostgreSQL discards negative zero and may render exponents as integers.
/// Expand decimal tokens and trim insignificant fractional zeroes before hashing.
pub fn storage_digest(value: &Value) -> Result<String> {
    fn number(text: &str) -> Result<String> {
        let (mantissa, exponent) = match text.split_once(['e', 'E']) {
            Some((m, e)) => (m, e.parse::<i32>()?),
            None => (text, 0),
        };
        let negative = mantissa.starts_with('-');
        let unsigned = mantissa.trim_start_matches('-');
        let fractional = unsigned.split_once('.').map_or(0, |(_, f)| f.len()) as i32;
        let mut digits = unsigned.replace('.', "");
        let scale = fractional - exponent;
        if scale <= 0 {
            digits.extend(std::iter::repeat_n('0', (-scale) as usize));
        } else {
            while digits.len() <= scale as usize {
                digits.insert(0, '0');
            }
            digits.insert(digits.len() - scale as usize, '.');
            while digits.ends_with('0') {
                digits.pop();
            }
            if digits.ends_with('.') {
                digits.pop();
            }
        }
        while digits.len() > 1 && digits.starts_with('0') && !digits.starts_with("0.") {
            digits.remove(0);
        }
        if negative && digits != "0" {
            digits.insert(0, '-');
        }
        Ok(digits)
    }
    fn encode(v: &Value, out: &mut Vec<u8>) -> Result<()> {
        match v {
            Value::Number(n) => out.extend_from_slice(number(&n.to_string())?.as_bytes()),
            Value::Array(a) => {
                out.push(b'[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    encode(v, out)?;
                }
                out.push(b']');
            }
            Value::Object(m) => {
                out.push(b'{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    serde_json::to_writer(&mut *out, k)?;
                    out.push(b':');
                    encode(v, out)?;
                }
                out.push(b'}');
            }
            _ => serde_json::to_writer(&mut *out, v)?,
        }
        Ok(())
    }
    let mut bytes = Vec::new();
    encode(value, &mut bytes)?;
    Ok(digest(&bytes))
}

/// Exact worker output, retained before JSONB normalization or re-encoding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OriginalPayloads {
    pub main: Vec<u8>,
    pub bidtopid: Vec<u8>,
    pub ptptstats: Vec<u8>,
}
impl OriginalPayloads {
    fn hashes(&self) -> Value {
        json!({"main":digest(&self.main),"bidtopid":digest(&self.bidtopid),"ptptstats":digest(&self.ptptstats)})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payloads {
    pub originals: OriginalPayloads,
    pub main: Value,
    pub bidtopid: Value,
    pub ptptstats: Value,
}
impl Payloads {
    pub fn from_originals(originals: OriginalPayloads) -> Result<Self> {
        Ok(Self {
            main: crate::wire::parse(&originals.main)?,
            bidtopid: crate::wire::parse(&originals.bidtopid)?,
            ptptstats: crate::wire::parse(&originals.ptptstats)?,
            originals,
        })
    }
    pub fn validate_originals(&self) -> Result<()> {
        let parsed = Self::from_originals(self.originals.clone())?;
        ensure!(
            parsed.hashes()? == self.hashes()?,
            "ORIGINAL_JSONB_MISMATCH"
        );
        Ok(())
    }

    pub fn validate(&self, zid: i32) -> Result<()> {
        for data in [&self.main, &self.bidtopid, &self.ptptstats] {
            ensure!(data["zid"] == zid, "foreign payload identity");
            ensure!(data["lastVoteTimestamp"].is_i64(), "missing vote timestamp");
            ensure!(
                data["lastVoteTimestamp"] == self.main["lastVoteTimestamp"],
                "inconsistent payload timestamp"
            );
        }
        let ids = self.main["base-clusters"]["id"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing base ids"))?;
        let members = self.main["base-clusters"]["members"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing base members"))?;
        let bids = self.bidtopid["bidToPid"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing bid mapping"))?;
        ensure!(
            ids.len() == bids.len() && members == bids,
            "positional mapping mismatch"
        );
        ensure!(
            ids.windows(2).all(|w| w[0].as_i64() < w[1].as_i64()),
            "unordered/duplicate base ids"
        );
        let stats = self.ptptstats["ptptstats"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid stats"))?;
        let len = stats
            .get("pid")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        for values in stats.values() {
            ensure!(
                values.as_array().is_some_and(|v| v.len() == len),
                "unequal stats columns"
            );
        }
        Ok(())
    }
    pub fn hashes(&self) -> Result<Value> {
        Ok(json!({"main":storage_digest(&self.main)?,
            "bidtopid":storage_digest(&self.bidtopid)?,
            "ptptstats":storage_digest(&self.ptptstats)?}))
    }
}
#[derive(Debug, Serialize)]
pub struct Bundle {
    pub payloads: Payloads,
    pub math_tick: i64,
    pub caching_tick: i64,
    pub checkpoint: Value,
    pub publisher_epoch: i64,
    pub operation_id: String,
}
#[derive(Debug)]
pub enum Current {
    Absent,
    Inconsistent,
    Coherent(Box<Bundle>),
}
#[derive(Debug, PartialEq)]
pub enum CommitReadback {
    Own(i64),
    Lost,
}
/// In-place storage cannot prove an overwritten operation ever committed. Fail
/// closed unless the current coherent generation is this exact attempt.
pub fn classify_commit(
    current: &Current,
    checkpoint: &Value,
    epoch: i64,
    operation_id: &str,
    tick: i64,
) -> CommitReadback {
    if let Current::Coherent(bundle) = current
        && bundle.math_tick == tick
        && bundle.publisher_epoch == epoch
        && bundle.operation_id == operation_id
        && bundle.checkpoint == *checkpoint
    {
        return CommitReadback::Own(tick);
    }
    CommitReadback::Lost
}
#[derive(Debug)]
pub struct CommitLost;
impl std::fmt::Display for CommitLost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UNCERTAIN_COMMIT_LOST")
    }
}
impl std::error::Error for CommitLost {}

#[derive(Debug, PartialEq)]
pub enum Publication {
    Committed(i64),
    Conflict,
    /// Ownership was refused inside the publication transaction, with the
    /// distinguishable lease state that refused it.
    Refused(LeaseState),
}
#[derive(Debug, Serialize)]
pub struct Metadata {
    pub zid: i32,
    pub math_tick: i64,
    pub caching_tick: i64,
}
pub trait ResultsStore {
    fn load_current(&mut self, zid: i32) -> Result<Current>;
    fn publish(
        &mut self,
        zid: i32,
        expected_tick: Option<i64>,
        epoch: i64,
        checkpoint: Value,
        payload: &Payloads,
    ) -> Result<Publication>;
    fn poll_changes(
        &mut self,
        high_water: i64,
        window: i64,
        after: (i64, i32),
        limit: i64,
    ) -> Result<Vec<Metadata>>;
    fn scan_current(&mut self, after_zid: i32, limit: i64) -> Result<Vec<Metadata>>;
}
pub struct PgStore {
    pub client: Client,
    pub config: Config,
    pub fault: Fault,
    pub cache: WarmCache,
    /// CO01/CO06 observability. Emission never fails an operation.
    pub metrics: Metrics,
    /// Counters for the pass currently in flight.
    pub tally: Tally,
    /// When the bounded backlog aggregate last ran.
    pub gauged: Option<std::time::Instant>,
    pub poller_timings: Option<(std::time::Duration, std::time::Duration)>,
}
impl PgStore {
    pub fn connect(config: Config) -> Result<Self> {
        Fault::reject_release_control()?;
        let mut client = Client::connect(&config.database_url, NoTls)?;
        client.batch_execute("SET statement_timeout='30s'; SET lock_timeout='5s'; SET application_name='p026-coordinator'")?;
        let fault = Fault::new(&mut client, &config.math_env)?;
        crate::bridge::admit_control(&mut client)?;
        let cache = WarmCache::new(config.cache_capacity);
        let metrics = Metrics::from_env(&config);
        tracing::info!(
            sink = metrics.describe(),
            namespace = crate::metrics::NAMESPACE,
            "metrics sink"
        );
        Ok(Self {
            client,
            config,
            fault,
            cache,
            metrics,
            tally: Tally::default(),
            gauged: None,
            poller_timings: None,
        })
    }
    /// Restore the primary connection after a terminated backend, so ownership
    /// can still be released instead of being held for the rest of the window.
    pub fn reconnect_if_closed(&mut self) -> Result<()> {
        if self.client.is_closed() {
            let mut client = Client::connect(&self.config.database_url, NoTls)?;
            client.batch_execute("SET statement_timeout='30s'; SET lock_timeout='5s'; SET application_name='p026-coordinator'")?;
            self.client = client;
        }
        Ok(())
    }
    /// Explicit local migration command; never implicitly migrate on startup.
    pub fn migrate(&mut self) -> Result<()> {
        anyhow::bail!(
            "SCHEMA_OPERATOR_REQUIRED: apply the reviewed, pinned 000021 migration separately"
        )
    }
    pub fn acquire(&mut self, zid: i32) -> Result<Option<i64>> {
        let c = &self.config;
        let mut tx = self.client.transaction()?;
        tx.query_one(
            "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
            &[&zid],
        )?;
        let rows = tx.query("INSERT INTO polis_coordinator_leases (math_env,zid,owner_id,owner_epoch,expires_at) VALUES($1,$2,$3,1,clock_timestamp()+make_interval(secs=>$4::int)) ON CONFLICT(math_env,zid) DO UPDATE SET owner_id=excluded.owner_id,owner_epoch=polis_coordinator_leases.owner_epoch+1,expires_at=excluded.expires_at,dispatch_operation_id=NULL,dispatch_capability_sha256=NULL,dispatch_checkpoint_sha256=NULL,dispatch_expected_tick=NULL,dispatch_margin_ms=NULL WHERE polis_coordinator_leases.expires_at<=clock_timestamp() OR polis_coordinator_leases.owner_id=$3 RETURNING owner_epoch", &[&c.math_env,&zid,&c.owner,&c.lease_seconds])?;
        let epoch = rows.first().map(|r| r.get(0));
        tx.commit()?;
        Ok(epoch)
    }
    pub fn release(&mut self, zid: i32, epoch: i64) -> Result<()> {
        let c = &self.config;
        let mut tx = self.client.transaction()?;
        tx.query_one(
            "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
            &[&zid],
        )?;
        tx.execute("UPDATE polis_coordinator_leases SET expires_at=clock_timestamp() WHERE math_env=$1 AND zid=$2 AND owner_id=$3 AND owner_epoch=$4", &[&c.math_env,&zid,&c.owner,&epoch])?;
        tx.commit()?;
        Ok(())
    }
    /// Authoritative classification of our ownership right now.
    /// `None` means the lease is still ours and unexpired.
    pub fn lease_state(&mut self, zid: i32, epoch: i64) -> Result<Option<LeaseState>> {
        let row = self.client.query_opt("SELECT owner_id,owner_epoch,expires_at>clock_timestamp() FROM polis_coordinator_leases WHERE math_env=$1 AND zid=$2", &[&self.config.math_env,&zid])?;
        Ok(lease::classify(row.as_ref(), &self.config, epoch))
    }
}

/// Metadata-only view of a persisted generation: no `data` column is read, so
/// nothing is detoasted. `complete` means all three companions exist at the same
/// tick as `math_ticks` and the provenance columns are present.
struct GenerationMeta {
    tick: i64,
    caching_tick: Option<i64>,
    checkpoint: Option<Value>,
    complete: bool,
    epoch: Option<i64>,
    operation_id: Option<String>,
}

impl PgStore {
    fn generation_meta(&mut self, zid: i32) -> Result<Option<GenerationMeta>> {
        let row = self.client.query_opt(
            "SELECT t.math_tick,g.publisher_epoch,g.input_checkpoint,
                    m.math_tick,m.caching_tick,b.math_tick,p.math_tick,g.operation_id,
                    (SELECT count(*)=3 FROM polis_coordinator_payloads x
                      WHERE x.math_env=t.math_env AND x.zid=t.zid AND x.math_tick=t.math_tick)
                    AND t.math_tick >= COALESCE((SELECT f.math_tick FROM polis_coordinator_floors f WHERE f.math_env=t.math_env AND f.zid=t.zid),t.math_tick)
               FROM math_ticks t
               LEFT JOIN math_main m ON m.zid=t.zid AND m.math_env=t.math_env
               LEFT JOIN math_bidtopid b ON b.zid=t.zid AND b.math_env=t.math_env
               LEFT JOIN math_ptptstats p ON p.zid=t.zid AND p.math_env=t.math_env
               LEFT JOIN polis_coordinator_generations g ON g.zid=t.zid AND g.math_env=t.math_env AND g.math_tick=t.math_tick AND g.caching_tick=m.caching_tick
              WHERE t.math_env=$1 AND t.zid=$2",
            &[&self.config.math_env, &zid],
        )?;
        let Some(r) = row else {
            return Ok(None);
        };
        let tick: i64 = r.get(0);
        let checkpoint: Option<Value> = r.get(2);
        let companions: [Option<i64>; 3] = [r.get(3), r.get(5), r.get(6)];
        let complete = r.get::<_, Option<i64>>(1).is_some()
            && r.get::<_, Option<String>>(7).is_some()
            && r.get::<_, Option<bool>>(8) == Some(true)
            && checkpoint.is_some()
            && companions.iter().all(|t| *t == Some(tick));
        Ok(Some(GenerationMeta {
            tick,
            caching_tick: r.get(4),
            checkpoint,
            complete,
            epoch: r.get(1),
            operation_id: r.get(7),
        }))
    }

    /// CO06 quiet repair, cheaply. True only when a complete generation is
    /// persisted for this conversation. The incremental fast path must never
    /// skip past an incomplete or missing generation, however fresh its source
    /// reconciliation record is: an absent companion or missing checkpoint
    /// provenance has to be repaired without waiting for future input.
    ///
    /// This is metadata only. It cannot see a mutated payload; that is what the
    /// reconciliation ceiling's authoritative `load_current` is for.
    pub fn generation_is_complete(&mut self, zid: i32) -> Result<bool> {
        Ok(self.generation_meta(zid)?.is_some_and(|g| g.complete))
    }

    /// Rev6 independent resident-cache integrity reconciliation.
    ///
    /// A bundle resident in the warm cache is **never** evidence that the
    /// durable generation is still complete: a companion row can be deleted,
    /// or its checkpoint changed, without the conversation's `math_tick`
    /// moving, and the source fingerprint would then agree forever (F1). Every
    /// pass that hits the cache re-verifies companion presence, every
    /// companion's generation, and the committed checkpoint identity against
    /// the store, again without selecting any payload column.
    ///
    /// Rev7 is explicit that this is *not* complete integrity reconciliation:
    /// it cannot validate persisted payload content. The authoritative path
    /// re-reads and re-hashes the payloads once per reconciliation ceiling.
    ///
    /// Returns false when the store contradicts the resident bundle in any way,
    /// which evicts it and forces the ordinary repair path.
    pub fn resident_is_intact(&mut self, zid: i32, bundle: &Bundle) -> Result<bool> {
        Ok(self.generation_meta(zid)?.is_some_and(|g| {
            g.complete
                && g.epoch == Some(bundle.publisher_epoch)
                && g.operation_id.as_ref() == Some(&bundle.operation_id)
                && g.tick == bundle.math_tick
                && g.caching_tick == Some(bundle.caching_tick)
                && g.checkpoint.as_ref() == Some(&bundle.checkpoint)
        }))
    }
    pub fn current_tick(&mut self, zid: i32) -> Result<Option<i64>> {
        // Immutable receipt history survives loss/regression of the latest
        // pointer. The publication function repeats this floor under its lock.
        let row=self.client.query_one(
            "SELECT greatest((SELECT math_tick FROM math_ticks WHERE math_env=$1 AND zid=$2),
             (SELECT max(math_tick) FROM polis_coordinator_generations WHERE math_env=$1 AND zid=$2),
             (SELECT math_tick FROM polis_coordinator_floors WHERE math_env=$1 AND zid=$2))",
            &[&self.config.math_env,&zid])?;
        Ok(row.get(0))
    }
}
impl ResultsStore for PgStore {
    fn load_current(&mut self, zid: i32) -> Result<Current> {
        let row = self.client.query_opt("SELECT m.data,b.data,p.data,m.math_tick,m.caching_tick,g.input_checkpoint,
          COALESCE(m.math_tick=b.math_tick AND m.math_tick=p.math_tick AND m.math_tick=t.math_tick AND g.publisher_epoch IS NOT NULL AND g.caching_tick=m.caching_tick
          AND m.math_tick >= COALESCE((SELECT f.math_tick FROM polis_coordinator_floors f WHERE f.math_env=m.math_env AND f.zid=m.zid),m.math_tick),false),
          g.publisher_epoch,g.operation_id,om.original_bytes,ob.original_bytes,op.original_bytes,om.original_sha256,ob.original_sha256,op.original_sha256
          FROM (SELECT zid FROM math_main WHERE math_env=$1 AND zid=$2 UNION SELECT zid FROM math_bidtopid WHERE math_env=$1 AND zid=$2 UNION SELECT zid FROM math_ptptstats WHERE math_env=$1 AND zid=$2 UNION SELECT zid FROM math_ticks WHERE math_env=$1 AND zid=$2) k
          LEFT JOIN math_main m ON m.zid=k.zid AND m.math_env=$1
          LEFT JOIN math_bidtopid b ON b.zid=k.zid AND b.math_env=$1
          LEFT JOIN math_ptptstats p ON p.zid=k.zid AND p.math_env=$1
          LEFT JOIN math_ticks t ON t.zid=k.zid AND t.math_env=$1
          LEFT JOIN polis_coordinator_generations g ON g.zid=k.zid AND g.math_env=$1 AND g.math_tick=t.math_tick
          LEFT JOIN polis_coordinator_payloads om ON om.zid=g.zid AND om.math_env=g.math_env AND om.math_tick=g.math_tick AND om.payload_kind='main'
          LEFT JOIN polis_coordinator_payloads ob ON ob.zid=g.zid AND ob.math_env=g.math_env AND ob.math_tick=g.math_tick AND ob.payload_kind='bidtopid'
          LEFT JOIN polis_coordinator_payloads op ON op.zid=g.zid AND op.math_env=g.math_env AND op.math_tick=g.math_tick AND op.payload_kind='ptptstats'", &[&self.config.math_env,&zid])?;
        let Some(r) = row else {
            return Ok(Current::Absent);
        };
        if !r.get::<_, bool>(6) {
            return Ok(Current::Inconsistent);
        }
        let Some(operation_id) = r.get::<_, Option<String>>(8) else {
            return Ok(Current::Inconsistent);
        };
        let raw: [Option<Vec<u8>>; 3] = [r.get(9), r.get(10), r.get(11)];
        let [Some(main), Some(bidtopid), Some(ptptstats)] = raw else {
            return Ok(Current::Inconsistent);
        };
        let originals = OriginalPayloads {
            main,
            bidtopid,
            ptptstats,
        };
        let hashes = originals.hashes();
        for (index, key) in [(12, "main"), (13, "bidtopid"), (14, "ptptstats")] {
            if r.get::<_, Option<String>>(index).as_deref() != hashes[key].as_str() {
                return Ok(Current::Inconsistent);
            }
        }
        let payloads = Payloads {
            originals,
            main: r.get(0),
            bidtopid: r.get(1),
            ptptstats: r.get(2),
        };
        let checkpoint: Value = r.get(5);
        if payloads.validate(zid).is_err()
            || payloads.validate_originals().is_err()
            || payloads.hashes()? != checkpoint["payload_digests"]
            || hashes != checkpoint["original_digests"]
            || checkpoint["operation_id"] != operation_id
            || checkpoint["publisher_epoch"] != r.get::<_, i64>(7)
        {
            return Ok(Current::Inconsistent);
        }
        Ok(Current::Coherent(Box::new(Bundle {
            payloads,
            math_tick: r.get(3),
            caching_tick: r.get(4),
            checkpoint,
            operation_id,
            publisher_epoch: r.get(7),
        })))
    }
    fn publish(
        &mut self,
        zid: i32,
        expected_tick: Option<i64>,
        epoch: i64,
        checkpoint: Value,
        payload: &Payloads,
    ) -> Result<Publication> {
        // Diagnostic fixture ingress still uses the restricted Python publisher.
        // The live coordinator calls dispatch_poller and never handles fresh output.
        crate::bridge::publish_fixture(self, zid, expected_tick, epoch, checkpoint, payload)
    }
    fn scan_current(&mut self, after_zid: i32, limit: i64) -> Result<Vec<Metadata>> {
        ensure!((1..=1000).contains(&limit), "invalid page limit");
        let rows = self.client.query("SELECT zid,math_tick,caching_tick FROM math_main WHERE math_env=$1 AND zid>$2 ORDER BY zid LIMIT $3", &[&self.config.math_env,&after_zid,&limit])?;
        Ok(rows
            .iter()
            .map(|r| Metadata {
                zid: r.get(0),
                math_tick: r.get(1),
                caching_tick: r.get(2),
            })
            .collect())
    }
    fn poll_changes(
        &mut self,
        high_water: i64,
        window: i64,
        after: (i64, i32),
        limit: i64,
    ) -> Result<Vec<Metadata>> {
        ensure!(
            window > 0 && (1..=1000).contains(&limit),
            "invalid polling parameters"
        );
        let low = high_water.saturating_sub(window).max(0);
        let rows = self.client.query("SELECT zid,math_tick,caching_tick FROM math_main WHERE math_env=$1 AND caching_tick >= $2 AND (caching_tick,zid)>($3,$4) ORDER BY caching_tick,zid LIMIT $5", &[&self.config.math_env,&low,&after.0,&after.1,&limit])?;
        Ok(rows
            .iter()
            .map(|r| Metadata {
                zid: r.get(0),
                math_tick: r.get(1),
                caching_tick: r.get(2),
            })
            .collect())
    }
}
