use crate::{
    engine::{self, Source},
    store::{Current, PgStore, Publication, ResultsStore, digest},
};
use anyhow::{Result, bail, ensure};
use postgres::IsolationLevel;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct OwnershipRefused;
impl std::fmt::Display for OwnershipRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OWNERSHIP-REFUSED")
    }
}
impl std::error::Error for OwnershipRefused {}

impl PgStore {
    pub fn source(&mut self, zid: i32) -> Result<Source> {
        let mut tx = self
            .client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        // Keyless votes: content order is deterministic, exact duplicate rows remain
        // separate events. No ctid or invented primary key, no timestamp cutoff.
        let votes: Vec<Value> = tx.query("SELECT jsonb_build_object('pid',pid,'tid',tid,'vote',vote,'created',created,'weight_x_32767',weight_x_32767) FROM votes WHERE zid=$1 ORDER BY tid,pid,created,(vote::bigint*$2::bigint),weight_x_32767 NULLS FIRST LIMIT 1000001", &[&zid,&self.config.storage_agree_value])?.iter().map(|r|r.get(0)).collect();
        let comments: Vec<Value> = tx.query("SELECT jsonb_build_object('tid',tid,'mod',mod,'is_meta',is_meta,'modified',modified) FROM comments WHERE zid=$1 ORDER BY tid LIMIT 1000001", &[&zid])?.iter().map(|r|r.get(0)).collect();
        let participants: Vec<Value> = tx.query("SELECT jsonb_build_object('pid',pid,'mod',mod) FROM participants WHERE zid=$1 ORDER BY pid LIMIT 1000001", &[&zid])?.iter().map(|r|r.get(0)).collect();
        tx.commit()?;
        ensure!(
            votes.len() <= 1_000_000
                && comments.len() <= 1_000_000
                && participants.len() <= 1_000_000,
            "RESOURCE_LIMIT: source exceeds admitted row budget"
        );
        let tids = |mod_value: i64| {
            comments
                .iter()
                .filter(|r| r["mod"] == mod_value)
                .map(|r| r["tid"].clone())
                .collect::<Vec<_>>()
        };
        let moderation = json!({"mod_in_tids":tids(1),"mod_out_tids":tids(-1),
            "meta_tids":comments.iter().filter(|r|r["is_meta"]==true).map(|r|r["tid"].clone()).collect::<Vec<_>>(),
            "mod_out_ptpts":participants.iter().filter(|r|r["mod"] == -1).map(|r|r["pid"].clone()).collect::<Vec<_>>(),
            "lastModTimestamp":Value::Null}); // exact Python poller snapshot profile
        let fingerprint = digest(&serde_json::to_vec(
            &json!({"votes":votes,"comments":comments,"participants":participants,"polarity":self.config.storage_agree_value}),
        )?);
        Ok(Source {
            votes,
            moderation,
            fingerprint,
        })
    }
    pub fn process(&mut self, zid: i32) -> Result<bool> {
        let epoch = self.acquire(zid)?.ok_or(OwnershipRefused)?;
        let context = json!({"zid":zid,"math_env":self.config.math_env,"epoch":epoch});
        self.fault.hit("after_lease", &context)?;
        let result = self.process_owned(zid, epoch);
        // Keep epoch history; only expire ownership on clean completion.
        if result.is_ok() {
            self.release(zid, epoch)?;
        }
        result
    }
    fn process_owned(&mut self, zid: i32, epoch: i64) -> Result<bool> {
        let source = self.source(zid)?;
        let context = json!({"zid":zid,"math_env":self.config.math_env,"epoch":epoch,"source_fingerprint":source.fingerprint,"event_count":source.votes.len()});
        self.fault.hit("after_source_selection", &context)?;
        // This is an admitted in-memory checkpoint, not durable acknowledgement.
        // Source remains authoritative until identical provenance commits with math.
        self.fault.hit("after_input_checkpoint", &context)?;
        let expected = self.current_tick(zid)?;
        let prior = self.load_current(zid)?;
        if let Current::Coherent(bundle) = &prior
            && bundle.checkpoint["source_fingerprint"] == source.fingerprint
        {
            return Ok(false);
        }
        let old = match &prior {
            Current::Coherent(b) => Some(b.as_ref()),
            _ => None,
        };
        let (payloads, checkpoint) = engine::compute(&self.config, &self.fault, zid, &source, old)?;
        let mut attempts = 0;
        let published = loop {
            match self.publish(zid, expected, epoch, checkpoint.clone(), &payloads) {
                Ok(result) => break result,
                Err(error) => {
                    let retryable = error
                        .downcast_ref::<postgres::Error>()
                        .and_then(|e| e.code())
                        .is_some_and(|code| matches!(code.code(), "40001" | "40P01"));
                    if !retryable || attempts >= 2 {
                        return Err(error);
                    }
                    attempts += 1;
                    tracing::warn!(zid, attempts, "retrying whole publication transaction");
                    std::thread::sleep(std::time::Duration::from_millis(50 * attempts));
                }
            }
        };
        match published {
            Publication::Committed(tick) => {
                self.fault.hit("after_ack", &context)?;
                tracing::info!(
                    zid,
                    math_env = self.config.math_env,
                    math_tick = tick,
                    events = source.votes.len(),
                    "published"
                );
                Ok(true)
            }
            Publication::Fenced => Err(OwnershipRefused.into()),
            Publication::Conflict => bail!("publication conflict; source retained"),
        }
    }
    pub fn cycle(&mut self) -> Result<usize> {
        let name = format!(
            "source-{}-{}",
            self.config.shard_index, self.config.shard_count
        );
        let mut cursor = self
            .client
            .query_opt(
                "SELECT position FROM coordinator_cursors WHERE math_env=$1 AND consumer=$2",
                &[&self.config.math_env, &name],
            )?
            .and_then(|r| r.get::<_, Value>(0)["zid"].as_i64())
            .unwrap_or(0) as i32;
        let rows = self.client.query(
            "SELECT zid FROM conversations WHERE zid>$1 ORDER BY zid LIMIT $2",
            &[&cursor, &self.config.page_size],
        )?;
        let mut count = 0;
        for r in &rows {
            let zid: i32 = r.get(0);
            if self.config.accepts(zid) {
                let ready = self.client.query_opt("SELECT next_attempt<=clock_timestamp() FROM coordinator_failures WHERE math_env=$1 AND zid=$2", &[&self.config.math_env,&zid])?.is_none_or(|r|r.get::<_,bool>(0));
                if ready {
                    match self.process(zid) {
                        Ok(changed) => {
                            if changed {
                                count += 1;
                            }
                            self.client.execute(
                                "DELETE FROM coordinator_failures WHERE math_env=$1 AND zid=$2",
                                &[&self.config.math_env, &zid],
                            )?;
                        }
                        Err(e) if e.is::<OwnershipRefused>() => return Err(e),
                        Err(e) => {
                            tracing::error!(zid,error=%e,"conversation failed; durable retry scheduled");
                            let mut tx = self.client.transaction()?;
                            tx.query_one(
                                "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
                                &[&zid],
                            )?;
                            tx.execute("INSERT INTO coordinator_failures(math_env,zid,attempts,next_attempt) VALUES($1,$2,1,clock_timestamp()+interval '1 second') ON CONFLICT(math_env,zid) DO UPDATE SET attempts=LEAST(coordinator_failures.attempts+1,30),next_attempt=clock_timestamp()+make_interval(secs=>LEAST(coordinator_failures.attempts+1,30))", &[&self.config.math_env,&zid])?;
                            tx.commit()?;
                        }
                    }
                }
            }
            cursor = zid;
        }
        if rows.len() < self.config.page_size as usize {
            cursor = 0;
        }
        self.client.execute("INSERT INTO coordinator_cursors(math_env,consumer,position) VALUES($1,$2,$3) ON CONFLICT(math_env,consumer) DO UPDATE SET position=excluded.position", &[&self.config.math_env,&name,&json!({"zid":cursor})])?;
        tracing::info!(
            page_rows = rows.len(),
            published = count,
            cursor,
            "source sweep page completed"
        );
        Ok(count)
    }
    /// One complete bounded-memory pass for --once and the black-box launcher.
    pub fn once(&mut self) -> Result<usize> {
        let mut after = 0;
        let mut published = 0;
        loop {
            let rows = self.client.query(
                "SELECT zid FROM conversations WHERE zid>$1 ORDER BY zid LIMIT $2",
                &[&after, &self.config.page_size],
            )?;
            for row in &rows {
                let zid: i32 = row.get(0);
                if self.config.accepts(zid) && self.process(zid)? {
                    published += 1;
                }
                after = zid;
            }
            if rows.len() < self.config.page_size as usize {
                return Ok(published);
            }
        }
    }
}
