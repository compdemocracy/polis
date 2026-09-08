//! CO04 v0: parent -> lease -> ticks -> bidtopid -> ptptstats -> main.
use crate::{config::Config, fault::Fault};
use anyhow::{Result, bail, ensure};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payloads {
    pub main: Value,
    pub bidtopid: Value,
    pub ptptstats: Value,
}
impl Payloads {
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
}
#[derive(Debug)]
pub enum Current {
    Absent,
    Inconsistent,
    Coherent(Box<Bundle>),
}
#[derive(Debug, PartialEq)]
pub enum Publication {
    Committed(i64),
    Conflict,
    Fenced,
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
}
impl PgStore {
    pub fn connect(config: Config) -> Result<Self> {
        Fault::reject_release_control()?;
        let mut client = Client::connect(&config.database_url, NoTls)?;
        client.batch_execute("SET statement_timeout='30s'; SET lock_timeout='5s'; SET application_name='p026-coordinator'")?;
        let fault = Fault::new(&mut client, &config.math_env)?;
        Ok(Self {
            client,
            config,
            fault,
        })
    }
    /// Explicit local migration command; never implicitly migrate on startup.
    pub fn migrate(&mut self) -> Result<()> {
        self.client
            .batch_execute(include_str!("../migration.sql"))?;
        Ok(())
    }
    pub fn acquire(&mut self, zid: i32) -> Result<Option<i64>> {
        let c = &self.config;
        let mut tx = self.client.transaction()?;
        tx.query_one(
            "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
            &[&zid],
        )?;
        let rows = tx.query("INSERT INTO coordinator_leases (math_env,zid,owner_id,owner_epoch,expires_at) VALUES($1,$2,$3,1,clock_timestamp()+make_interval(secs=>$4::int)) ON CONFLICT(math_env,zid) DO UPDATE SET owner_id=excluded.owner_id,owner_epoch=coordinator_leases.owner_epoch+1,expires_at=excluded.expires_at WHERE coordinator_leases.expires_at<=clock_timestamp() OR coordinator_leases.owner_id=$3 RETURNING owner_epoch", &[&c.math_env,&zid,&c.owner,&c.lease_seconds])?;
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
        tx.execute("UPDATE coordinator_leases SET expires_at=clock_timestamp() WHERE math_env=$1 AND zid=$2 AND owner_id=$3 AND owner_epoch=$4", &[&c.math_env,&zid,&c.owner,&epoch])?;
        tx.commit()?;
        Ok(())
    }
    pub fn current_tick(&mut self, zid: i32) -> Result<Option<i64>> {
        Ok(self
            .client
            .query_opt(
                "SELECT math_tick FROM math_ticks WHERE math_env=$1 AND zid=$2",
                &[&self.config.math_env, &zid],
            )?
            .map(|r| r.get(0)))
    }
}
impl ResultsStore for PgStore {
    fn load_current(&mut self, zid: i32) -> Result<Current> {
        let row = self.client.query_opt("SELECT m.data,b.data,p.data,m.math_tick,m.caching_tick,t.input_checkpoint,COALESCE(m.math_tick=b.math_tick AND m.math_tick=p.math_tick AND m.math_tick=t.math_tick AND t.publisher_epoch IS NOT NULL AND t.input_checkpoint IS NOT NULL,false) FROM (SELECT zid FROM math_main WHERE math_env=$1 AND zid=$2 UNION SELECT zid FROM math_bidtopid WHERE math_env=$1 AND zid=$2 UNION SELECT zid FROM math_ptptstats WHERE math_env=$1 AND zid=$2 UNION SELECT zid FROM math_ticks WHERE math_env=$1 AND zid=$2) k LEFT JOIN math_main m ON m.zid=k.zid AND m.math_env=$1 LEFT JOIN math_bidtopid b ON b.zid=k.zid AND b.math_env=$1 LEFT JOIN math_ptptstats p ON p.zid=k.zid AND p.math_env=$1 LEFT JOIN math_ticks t ON t.zid=k.zid AND t.math_env=$1", &[&self.config.math_env,&zid])?;
        let Some(r) = row else {
            return Ok(Current::Absent);
        };
        if !r.get::<_, bool>(6) {
            return Ok(Current::Inconsistent);
        }
        let payloads = Payloads {
            main: r.get(0),
            bidtopid: r.get(1),
            ptptstats: r.get(2),
        };
        let checkpoint: Value = r.get(5);
        if payloads.validate(zid).is_err() || payloads.hashes()? != checkpoint["payload_digests"] {
            return Ok(Current::Inconsistent);
        }
        Ok(Current::Coherent(Box::new(Bundle {
            payloads,
            math_tick: r.get(3),
            caching_tick: r.get(4),
            checkpoint,
        })))
    }
    fn publish(
        &mut self,
        zid: i32,
        expected_tick: Option<i64>,
        epoch: i64,
        mut checkpoint: Value,
        payload: &Payloads,
    ) -> Result<Publication> {
        payload.validate(zid)?;
        checkpoint["payload_digests"] = payload.hashes()?; // before ANY lock
        let encoded =
            [&payload.main, &payload.bidtopid, &payload.ptptstats].map(serde_json::to_string);
        let [main, bid, stats] = encoded;
        let (main, bid, stats) = (main?, bid?, stats?);
        let stamp = payload.main["lastVoteTimestamp"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("invalid timestamp"))?;
        let c = &self.config;
        let mut tx = self.client.transaction()?;
        tx.query_one(
            "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
            &[&zid],
        )?;
        let owned = tx.query_opt("SELECT owner_id=$3 AND owner_epoch=$4 AND expires_at>clock_timestamp() FROM coordinator_leases WHERE math_env=$1 AND zid=$2 FOR UPDATE", &[&c.math_env,&zid,&c.owner,&epoch])?;
        if !owned.is_some_and(|r| r.get::<_, bool>(0)) {
            return Ok(Publication::Fenced);
        }
        let context = json!({"zid":zid,"math_env":c.math_env,"epoch":epoch,"checkpoint":checkpoint,
            "backend_pid":tx.query_one("SELECT pg_backend_pid()", &[])?.get::<_,i32>(0)});
        self.fault.hit("before_ticks", &context)?;
        let current = tx
            .query_opt(
                "SELECT math_tick FROM math_ticks WHERE math_env=$1 AND zid=$2 FOR UPDATE",
                &[&c.math_env, &zid],
            )?
            .map(|r| r.get::<_, i64>(0));
        if current != expected_tick {
            return Ok(Publication::Conflict);
        }
        let tick = match current {
            Some(n) => n
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("tick overflow"))?,
            None => 0,
        };
        tx.execute("INSERT INTO math_ticks(zid,math_env,math_tick,publisher_epoch,input_checkpoint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,publisher_epoch=excluded.publisher_epoch,input_checkpoint=excluded.input_checkpoint,modified=now_as_millis()", &[&zid,&c.math_env,&tick,&epoch,&checkpoint])?;
        self.fault.hit("after_ticks", &context)?;
        for (table, name, data) in [
            ("math_bidtopid", "bidtopid", bid),
            ("math_ptptstats", "ptptstats", stats),
        ] {
            self.fault.hit(&format!("before_{name}"), &context)?;
            tx.execute(&format!("INSERT INTO {table}(zid,math_env,math_tick,data) VALUES($1,$2,$3,$4::text::jsonb) ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,data=excluded.data,modified=now_as_millis()"), &[&zid,&c.math_env,&tick,&data])?;
            self.fault.hit(&format!("after_{name}"), &context)?;
        }
        self.fault.hit("before_main", &context)?;
        let cursor: i64 = tx
            .query_one("SELECT nextval('coordinator_caching_tick')", &[])?
            .get(0);
        ensure!(
            cursor <= 9_007_199_254_740_991,
            "cursor exceeds exact Node integer range"
        );
        tx.execute("INSERT INTO math_main(zid,math_env,math_tick,data,last_vote_timestamp,caching_tick) VALUES($1,$2,$3,$4::text::jsonb,$5,$6) ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,data=excluded.data,last_vote_timestamp=excluded.last_vote_timestamp,caching_tick=excluded.caching_tick,modified=now_as_millis()", &[&zid,&c.math_env,&tick,&main,&stamp,&cursor])?;
        self.fault.hit("after_main", &context)?;
        self.fault.hit("before_commit", &context)?;
        // The lease row remains locked throughout publication; a transferee cannot
        // acquire an epoch while this transaction is still capable of committing.
        let unexpired: bool = tx.query_one("SELECT expires_at>clock_timestamp() FROM coordinator_leases WHERE math_env=$1 AND zid=$2", &[&c.math_env,&zid])?.get(0);
        if !unexpired {
            return Ok(Publication::Fenced);
        }
        let committed = tx.commit();
        if let Err(error) = committed {
            // Lost COMMIT response: reconnect and compare immutable identity.
            self.client = Client::connect(&self.config.database_url, NoTls)?;
            if let Current::Coherent(bundle) = self.load_current(zid)?
                && bundle.checkpoint == checkpoint
            {
                return Ok(Publication::Committed(bundle.math_tick));
            }
            bail!("uncertain commit, checkpoint not observed: {error}");
        }
        self.fault.hit("after_commit", &context)?;
        Ok(Publication::Committed(tick))
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
