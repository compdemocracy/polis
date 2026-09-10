use crate::{
    engine::Source,
    lease::{LeaseState, Renewal},
    metrics::{Tally, count, seconds},
    ordering,
    store::{Current, PgStore, Publication, ResultsStore, digest},
};
use anyhow::{Result, bail, ensure};
use postgres::IsolationLevel;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

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
        // The order is the declared `polis-order/1` normalization, and the agree
        // convention reaches it only as that declaration's bound parameter.
        ensure!(
            ordering::PARAMETER_BINDING == "$2",
            "declared ordering parameter is not bound at $2"
        );
        let votes_sql = format!(
            "SELECT jsonb_build_object('pid',pid,'tid',tid,'vote',vote,'created',created,'weight_x_32767',weight_x_32767) FROM votes WHERE zid=$1 ORDER BY {} LIMIT 1000001",
            ordering::order_by()
        );
        let votes: Vec<Value> = tx
            .query(
                votes_sql.as_str(),
                &[&zid, &self.config.storage_agree_value],
            )?
            .iter()
            .map(|r| r.get(0))
            .collect();
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
        let ordering =
            ordering::manifest(self.config.storage_agree_value, ordering::census(&votes))?;
        // The declared normalization is part of the source identity: changing a
        // term or the polarity constant must discard warm state.
        let fingerprint = digest(&serde_json::to_vec(
            &json!({"votes":votes,"comments":comments,"participants":participants,"ordering":ordering}),
        )?);
        Ok(Source {
            votes,
            moderation,
            ordering,
            fingerprint,
        })
    }
    pub fn process(&mut self, zid: i32) -> Result<bool> {
        let started = Instant::now();
        let outcome = self.process_leased(zid);
        // CO03: every terminal outcome is counted under its own typed name, so
        // "unavailable" can never be read as a crash or as successful work.
        match &outcome {
            Ok(_) => {}
            Err(e) => match LeaseState::of(e) {
                Some(LeaseState::Unavailable) => self.tally.lease_unavailable += 1,
                Some(LeaseState::Expired) => self.tally.lease_expired += 1,
                Some(LeaseState::Fenced) => self.tally.lease_fenced += 1,
                None => {}
            },
        }
        self.metrics.emit(
            "conversation",
            &[seconds("ConversationLatencySeconds", started.elapsed())],
            json!({"zid":zid,"outcome":match &outcome {
                Ok(true) => "published".to_owned(),
                Ok(false) => "unchanged".to_owned(),
                Err(e) => LeaseState::of(e).map_or_else(|| "failed".to_owned(), |s| s.token().to_owned()),
            }}),
        );
        outcome
    }
    fn process_leased(&mut self, zid: i32) -> Result<bool> {
        // No epoch: another owner holds an unexpired lease. Recoverable.
        let epoch = self.acquire(zid)?.ok_or(LeaseState::Unavailable)?;
        self.tally.lease_acquired += 1;
        let mut renewal = Renewal::start(&self.config, zid, epoch)?;
        let context = json!({"zid":zid,"math_env":self.config.math_env,"epoch":epoch});
        self.fault.hit("after_lease", &context)?;
        let result = self.process_owned(zid, epoch, &renewal);
        renewal.stop();
        // Release our own epoch on any decided outcome. The update is
        // conditional on (owner_id,owner_epoch), so a transferred or fenced row
        // is untouched, epoch history is preserved, and a clean local failure
        // does not hold the conversation for the rest of the lease window.
        // Only an unclean death leaves a live lease behind, as R05 requires.
        if let Err(error) = self
            .reconnect_if_closed()
            .and_then(|()| self.release(zid, epoch))
        {
            tracing::warn!(zid, epoch, error=%error, "lease release failed; expiry still bounds it");
        }
        result
    }
    /// Authoritative ownership check at a decision point. A heartbeat loss that
    /// the database contradicts is not a loss; anything else stops the work.
    fn lease_guard(&mut self, zid: i32, epoch: i64, renewal: &Renewal) -> Result<()> {
        if renewal.state().is_none() {
            return Ok(());
        }
        match self.lease_state(zid, epoch)? {
            Some(state) => {
                tracing::error!(zid, epoch, state=%state, "lease lost during compute; not publishing");
                Err(state.into())
            }
            None => {
                tracing::warn!(
                    zid,
                    epoch,
                    "uncertain renewal contradicted by the lease row"
                );
                Ok(())
            }
        }
    }
    fn process_owned(&mut self, zid: i32, epoch: i64, renewal: &Renewal) -> Result<bool> {
        let expected = self.current_tick(zid)?;
        // CO01 incremental discovery. The probe is captured *before* the
        // authoritative snapshot it will certify — and carries the database
        // time of that observation, so a long compute cannot reset the
        // advertised source age. It can only ever *skip* a read; it never
        // authorises a rebuild, and it is trusted only while this
        // conversation's last full reconciliation is younger than the
        // configured ceiling. See src/probe.rs.
        let probe = self.probe(zid)?;
        self.tally.probed += 1;
        let fresh = self.reconciliation(zid)?.is_some_and(|(recorded, age)| {
            recorded == probe.value
                && age < Duration::from_secs(self.config.reconcile_seconds.max(1) as u64)
        });
        let resident = self.cache.take(zid, expected);
        // CO06 quiet repair is not negotiable against a fresh hint: an absent
        // companion or missing checkpoint provenance must be repaired without
        // waiting for future input or for the ceiling, so a metadata-complete
        // persisted generation is a precondition of skipping anything.
        if self.config.incremental && fresh && self.generation_is_complete(zid)? {
            // Rev6: a resident bundle is not evidence about the durable store.
            // On the fast path its companions, generation and checkpoint are
            // reconciled against the database; a disagreement drops it and
            // falls through to the authoritative path below.
            let usable = match resident {
                Some(bundle) if self.resident_is_intact(zid, &bundle)? => {
                    self.cache.insert(&self.fault, zid, bundle)?;
                    true
                }
                Some(bundle) => {
                    tracing::warn!(
                        zid,
                        math_tick = bundle.math_tick,
                        "resident bundle contradicted by the store; evicted, repairing"
                    );
                    false
                }
                // Nothing resident to contradict: the ceiling is what bounds
                // this, exactly as it bounds the source hint.
                None => true,
            };
            if usable {
                self.tally.skipped += 1;
                tracing::debug!(zid, "source probe unchanged; full snapshot skipped");
                return Ok(false);
            }
        }
        // The authoritative path. Rev7 CO02/CO06: the full-source ceiling must
        // *also* independently validate the persisted payloads, so the prior
        // generation is re-read and re-hashed from the store here and a
        // resident bundle is never the evidence. Payload corruption that leaves
        // metadata intact therefore becomes eligible for repair once the ceiling
        // elapses, rather than surviving indefinitely behind a warm cache. The
        // ceiling is an eligibility threshold, not a measured deadline.
        let prior = self.load_current(zid)?;
        let read = Instant::now();
        let source = self.source(zid)?;
        let source_seconds = read.elapsed();
        self.tally.reconciled += 1;
        let context = json!({"zid":zid,"math_env":self.config.math_env,"epoch":epoch,"source_fingerprint":source.fingerprint,"event_count":source.votes.len()});
        self.fault.hit("after_source_selection", &context)?;
        // This is an admitted in-memory checkpoint, not durable acknowledgement.
        // Source remains authoritative until identical provenance commits with math.
        self.fault.hit("after_input_checkpoint", &context)?;
        let unchanged = matches!(&prior,
            Current::Coherent(b) if b.checkpoint["source_fingerprint"] == source.fingerprint);
        if unchanged {
            if let Current::Coherent(bundle) = prior {
                self.cache.insert(&self.fault, zid, bundle)?;
            }
            // The authoritative snapshot agreed with the published generation:
            // this is the only evidence that lets a later probe skip a read.
            self.record_reconciliation(zid, &probe)?;
            return Ok(false);
        }
        let old = match &prior {
            Current::Coherent(b) => Some(b.as_ref()),
            _ => None,
        };
        self.lease_guard(zid, epoch, renewal)?;
        let published =
            crate::bridge::dispatch_poller(self, zid, expected, epoch, &source, old, renewal)?;
        let mut timings = vec![seconds("SourceReadSeconds", source_seconds)];
        if let Some((compute, publish)) = self.poller_timings {
            timings.extend([
                seconds("ComputeSeconds", compute),
                seconds("PublishSeconds", publish),
            ]);
        }
        self.metrics.emit(
            "reconciliation",
            &timings,
            json!({"zid":zid,"events":source.votes.len(),"publication":format!("{published:?}")}),
        );
        match published {
            Publication::Committed(tick) => {
                self.tally.publish_committed += 1;
                self.fault.hit("after_ack", &context)?;
                // Durable acknowledgement has happened, so the probe captured
                // before this snapshot now certifies the published generation.
                self.record_reconciliation(zid, &probe)?;
                tracing::info!(
                    zid,
                    math_env = self.config.math_env,
                    math_tick = tick,
                    events = source.votes.len(),
                    "published"
                );
                Ok(true)
            }
            Publication::Refused(state) => {
                self.tally.publish_refused += 1;
                Err(state.into())
            }
            Publication::Conflict => {
                self.tally.publish_conflict += 1;
                bail!("publication conflict; source retained")
            }
        }
    }
    /// One bounded source pass, instrumented. `SourcePassHealthy` is 1 only
    /// when the whole pass completed; a failed pass emits 0 with the same
    /// counters, and a dead process emits nothing at all. It is page-loop
    /// liveness, deliberately not P-031's A01 `PollHealthy`: a pass in which
    /// every conversation failed still completes, and the failure backlog and
    /// unrepaired age are what say so.
    pub fn cycle(&mut self) -> Result<usize> {
        crate::operations::reconcile_pending(
            &mut self.client,
            &self.config.math_env,
            self.config.page_size,
        )?;
        let started = Instant::now();
        self.tally = Tally::default();
        let result = self.cycle_pass();
        let mut data = self.tally.data(started.elapsed(), result.is_ok());
        // Bounded aggregate, at most once per gauge interval: CO01 scan age and
        // backlog, CO06 oldest unrepaired age. Metadata only, no payload column.
        if self
            .gauged
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(self.config.gauge_seconds))
        {
            match self.backlog() {
                Ok(backlog) => {
                    self.gauged = Some(Instant::now());
                    data.extend([
                        seconds(
                            "OldestReconciliationAgeSeconds",
                            backlog.oldest_reconciliation,
                        ),
                        count("ReconciliationBacklogConversations", backlog.overdue as f64),
                        count("FailureBacklogConversations", backlog.failures as f64),
                        seconds("OldestUnrepairedAgeSeconds", backlog.oldest_unrepaired),
                    ]);
                }
                Err(error) => {
                    // An incomplete observation must never publish health.
                    tracing::warn!(error=%error, "backlog gauge unavailable this pass");
                }
            }
        }
        data.push(count("MetricsDropped", self.metrics.dropped() as f64));
        self.metrics.emit(
            "source_pass",
            &data,
            json!({"shard":[self.config.shard_index,self.config.shard_count],
                "incremental":self.config.incremental,
                "reconcile_seconds":self.config.reconcile_seconds}),
        );
        result
    }
    fn cycle_pass(&mut self) -> Result<usize> {
        let name = format!(
            "source-{}-{}",
            self.config.shard_index, self.config.shard_count
        );
        let mut cursor = self
            .client
            .query_opt(
                "SELECT position FROM polis_coordinator_cursors WHERE math_env=$1 AND consumer=$2",
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
                self.tally.visited += 1;
                let ready = self.client.query_opt("SELECT next_attempt<=clock_timestamp() FROM polis_coordinator_failures WHERE math_env=$1 AND zid=$2", &[&self.config.math_env,&zid])?.is_none_or(|r|r.get::<_,bool>(0));
                if ready {
                    match self.process(zid) {
                        Ok(changed) => {
                            if changed {
                                count += 1;
                                self.tally.published += 1;
                            }
                            self.client.execute(
                                "DELETE FROM polis_coordinator_failures WHERE math_env=$1 AND zid=$2",
                                &[&self.config.math_env, &zid],
                            )?;
                        }
                        // Only a superseded owner stops the daemon. A lease that
                        // is merely unavailable or elapsed defers one zid and
                        // must not starve the rest of the sweep.
                        Err(e) if LeaseState::of(&e).is_some_and(|s| !s.recoverable()) => {
                            return Err(e);
                        }
                        Err(e) => {
                            match LeaseState::of(&e) {
                                Some(state) => {
                                    tracing::warn!(zid,state=%state,"lease deferred; bounded backoff, sweep continues")
                                }
                                None => {
                                    tracing::error!(zid,error=%e,"conversation failed; durable retry scheduled")
                                }
                            }
                            self.tally.deferred += 1;
                            self.defer(zid)?;
                        }
                    }
                }
            }
            cursor = zid;
        }
        if rows.len() < self.config.page_size as usize {
            cursor = 0;
        }
        self.client.execute("INSERT INTO polis_coordinator_cursors(math_env,consumer,position) VALUES($1,$2,$3) ON CONFLICT(math_env,consumer) DO UPDATE SET position=excluded.position", &[&self.config.math_env,&name,&json!({"zid":cursor})])?;
        tracing::info!(
            page_rows = rows.len(),
            published = count,
            cursor,
            "source sweep page completed"
        );
        Ok(count)
    }
    /// Durable bounded backoff for one conversation, shared by failures and by
    /// recoverable lease outcomes.
    fn defer(&mut self, zid: i32) -> Result<()> {
        let mut tx = self.client.transaction()?;
        tx.query_one(
            "SELECT zid FROM conversations WHERE zid=$1 FOR KEY SHARE",
            &[&zid],
        )?;
        tx.execute("INSERT INTO polis_coordinator_failures(math_env,zid,attempts,next_attempt) VALUES($1,$2,1,clock_timestamp()+interval '1 second') ON CONFLICT(math_env,zid) DO UPDATE SET attempts=LEAST(polis_coordinator_failures.attempts+1,30),next_attempt=clock_timestamp()+make_interval(secs=>LEAST(polis_coordinator_failures.attempts+1,30))", &[&self.config.math_env,&zid])?;
        tx.commit()?;
        Ok(())
    }
    /// One complete bounded-memory pass for --once and the black-box launcher.
    /// Strict: any lease refusal ends the pass with its typed exit code.
    pub fn once(&mut self) -> Result<usize> {
        let started = Instant::now();
        self.tally = Tally::default();
        crate::operations::reconcile_pending(
            &mut self.client,
            &self.config.math_env,
            self.config.page_size,
        )?;
        let result = self.once_pass();
        let mut data = self.tally.data(started.elapsed(), result.is_ok());
        match self.backlog() {
            Ok(backlog) => data.extend([
                seconds(
                    "OldestReconciliationAgeSeconds",
                    backlog.oldest_reconciliation,
                ),
                count("ReconciliationBacklogConversations", backlog.overdue as f64),
                count("FailureBacklogConversations", backlog.failures as f64),
                seconds("OldestUnrepairedAgeSeconds", backlog.oldest_unrepaired),
            ]),
            Err(error) => tracing::warn!(error=%error, "backlog gauge unavailable this pass"),
        }
        data.push(count("MetricsDropped", self.metrics.dropped() as f64));
        self.metrics.emit(
            "source_pass",
            &data,
            json!({"mode":"once","incremental":self.config.incremental}),
        );
        result
    }
    fn once_pass(&mut self) -> Result<usize> {
        let mut after = 0;
        let mut published = 0;
        loop {
            let rows = self.client.query(
                "SELECT zid FROM conversations WHERE zid>$1 ORDER BY zid LIMIT $2",
                &[&after, &self.config.page_size],
            )?;
            for row in &rows {
                let zid: i32 = row.get(0);
                if self.config.accepts(zid) {
                    self.tally.visited += 1;
                    if self.process(zid)? {
                        published += 1;
                        self.tally.published += 1;
                    }
                }
                after = zid;
            }
            if rows.len() < self.config.page_size as usize {
                return Ok(published);
            }
        }
    }
}
