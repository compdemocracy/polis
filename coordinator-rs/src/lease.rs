//! CO03 lease state and heartbeat renewal.
//!
//! Rev5 requires three distinguishable outcomes instead of one refusal, and
//! renewal during compute that can never resurrect an expired or transferred
//! epoch. `Unavailable` and `Expired` are recoverable: the daemon defers the
//! conversation and keeps working. `Fenced` means this owner's publication
//! authority is gone for good, so the process stops instead of retrying.
use crate::config::Config;
use anyhow::Result;
use postgres::{Client, NoTls};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    /// Another owner holds an unexpired lease on this (math_env,zid).
    Unavailable,
    /// The lease row is still ours, but our own lease elapsed in database time.
    Expired,
    /// Owner or epoch superseded; this owner may never publish this generation.
    Fenced,
}
impl LeaseState {
    pub fn token(self) -> &'static str {
        match self {
            Self::Unavailable => "LEASE-UNAVAILABLE",
            Self::Expired => "LEASE-EXPIRED",
            Self::Fenced => "FENCED",
        }
    }
    /// Distinct process exit codes; see README "Ownership outcomes".
    pub fn exit_code(self) -> i32 {
        match self {
            Self::Fenced => 3,
            Self::Unavailable => 4,
            Self::Expired => 5,
        }
    }
    /// Recoverable outcomes defer one conversation; they never kill the daemon.
    pub fn recoverable(self) -> bool {
        !matches!(self, Self::Fenced)
    }
    /// The typed outcome carried by an error, if any.
    pub fn of(error: &anyhow::Error) -> Option<Self> {
        error.downcast_ref::<Self>().copied()
    }
}
impl std::fmt::Display for LeaseState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.token())
    }
}
impl std::error::Error for LeaseState {}

/// Conditional renewal. Never extends a lease that is not currently ours and
/// unexpired, so an expired or transferred epoch cannot be resurrected.
fn renew(client: &mut Client, c: &Config, zid: i32, epoch: i64) -> Result<Option<LeaseState>> {
    let mut tx = client.transaction()?;
    if !tx
        .query_one(
            "SELECT public.pc_writer_allowed($1,$2)",
            &[&c.math_env, &zid],
        )?
        .get::<_, bool>(0)
    {
        tx.rollback()?;
        return Ok(Some(LeaseState::Unavailable));
    }
    let renewed = tx.execute("UPDATE polis_coordinator_leases SET expires_at=clock_timestamp()+make_interval(secs=>$5::int) WHERE math_env=$1 AND zid=$2 AND owner_id=$3 AND owner_epoch=$4 AND expires_at>clock_timestamp()", &[&c.math_env,&zid,&c.owner,&epoch,&c.lease_seconds])?;
    if renewed == 1 {
        tx.commit()?;
        return Ok(None);
    }
    let observed = tx.query_opt("SELECT owner_id,owner_epoch,expires_at>clock_timestamp() FROM polis_coordinator_leases WHERE math_env=$1 AND zid=$2", &[&c.math_env,&zid])?;
    tx.commit()?;
    match classify(observed.as_ref(), c, epoch) {
        Some(state) => Ok(Some(state)),
        // Still ours and unexpired, yet the identical conditional update matched
        // nothing: uncertain, and an uncertain renewal is not ownership proof.
        None => anyhow::bail!("uncertain lease renewal"),
    }
}

/// Classify an observed lease row for this owner and epoch.
/// `None` means the row is still ours and unexpired.
pub fn classify(row: Option<&postgres::Row>, c: &Config, epoch: i64) -> Option<LeaseState> {
    let Some(r) = row else {
        return Some(LeaseState::Fenced);
    };
    if r.get::<_, String>(0) != c.owner || r.get::<_, i64>(1) != epoch {
        Some(LeaseState::Fenced)
    } else if r.get::<_, bool>(2) {
        None
    } else {
        Some(LeaseState::Expired)
    }
}

/// Heartbeat on the lease row, on its own connection, for the life of one
/// compute. The publication transaction is never held open across it.
pub struct Renewal {
    lost: Arc<Mutex<Option<LeaseState>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}
impl Renewal {
    pub fn start(config: &Config, zid: i32, epoch: i64) -> Result<Self> {
        let mut client = Client::connect(&config.database_url, NoTls)?;
        client.batch_execute("SET statement_timeout='5s'; SET lock_timeout='1s'; SET application_name='p026-lease-renewal'")?;
        let lost: Arc<Mutex<Option<LeaseState>>> = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (config, thread_lost, thread_stop) = (config.clone(), lost.clone(), stop.clone());
        let handle = thread::spawn(move || {
            let lease = Duration::from_secs(config.lease_seconds.max(1) as u64);
            // Renew well inside the window so one lost round trip is survivable.
            let interval = (lease / 3).max(Duration::from_millis(50));
            let mut confirmed = Instant::now();
            let set = |state: LeaseState| {
                if let Ok(mut slot) = thread_lost.lock() {
                    *slot = Some(state);
                }
            };
            while !thread_stop.load(Ordering::SeqCst) {
                let wake = Instant::now() + interval;
                while Instant::now() < wake {
                    if thread_stop.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(
                        Duration::from_millis(10)
                            .min(wake.saturating_duration_since(Instant::now())),
                    );
                }
                match renew(&mut client, &config, zid, epoch) {
                    Ok(None) => confirmed = Instant::now(),
                    Ok(Some(state)) => {
                        set(state);
                        return;
                    }
                    // An uncertain renewal is not ownership proof: once a full
                    // lease has passed without a confirmed renewal, stop.
                    Err(_) if confirmed.elapsed() >= lease => {
                        set(LeaseState::Expired);
                        return;
                    }
                    Err(_) => {}
                }
            }
        });
        Ok(Self {
            lost,
            stop,
            handle: Some(handle),
        })
    }
    /// The last definite loss observed by the heartbeat, if any.
    pub fn state(&self) -> Option<LeaseState> {
        self.lost.lock().ok().and_then(|slot| *slot)
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
impl Drop for Renewal {
    fn drop(&mut self) {
        self.stop();
    }
}
