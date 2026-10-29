//! One primary-backed, read-only connection for background revocation refresh.
use crate::{config, db, route::App};
use anyhow::{Context, Result};
use polis_auth::revocation::{REFRESH_PERIOD, Revocations, Snapshot};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

pub(crate) struct Refresh {
    pool: Arc<db::Pool>,
    pub(crate) snapshot: Arc<Revocations>,
    successes: AtomicU64,
    failures: AtomicU64,
}
impl Refresh {
    pub(crate) async fn load(pool: Arc<db::Pool>) -> Result<Arc<Self>> {
        let snapshot = pool
            .with(|c| {
                Snapshot::load(c).map_err(|_| anyhow::anyhow!("revocation snapshot unavailable"))
            })
            .await?;
        Ok(Arc::new(Self {
            pool,
            snapshot: Revocations::new(snapshot),
            successes: AtomicU64::new(1),
            failures: AtomicU64::new(0),
        }))
    }
    pub(crate) async fn refresh(&self) {
        match self
            .pool
            .with(|c| {
                Snapshot::load(c).map_err(|_| anyhow::anyhow!("revocation snapshot unavailable"))
            })
            .await
        {
            Ok(snapshot) => {
                self.snapshot.replace(snapshot);
                self.successes.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                self.failures.fetch_add(1, Ordering::Relaxed);
                // One attempt and fixed warning per period; never log SQL,
                // connection strings, participant IDs or credential material.
                eprintln!("{{\"event\":\"treevite_revocation_refresh_failed\"}}");
            }
        }
    }
    pub(crate) async fn run(self: Arc<Self>) {
        let mut ticks =
            tokio::time::interval_at(tokio::time::Instant::now() + REFRESH_PERIOD, REFRESH_PERIOD);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            self.refresh().await;
        }
    }
}
pub(crate) fn limits() -> db::Limits {
    db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_secs(5),
        max_lifetime: Duration::from_secs(300),
    }
}
pub(crate) async fn configure(app: &mut App) -> Result<Option<tokio::task::JoinHandle<()>>> {
    if app.participant_verifier.is_none()
        && app.post_votes.is_none()
        && app.topic_selection_writer.is_none()
    {
        return Ok(None);
    }
    // A replica's unbounded lag cannot meet the revocation deadline.
    let dsn = std::env::var("POLIS_API_REVOCATION_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .context("participant routes require a primary revocation database")?;
    let refresh = Refresh::load(db::Pool::new(
        config::connector_for_dsn(&dsn, "polis-api-revocations/1")?,
        limits(),
    ))
    .await?;
    if let Some(verifier) = &mut app.participant_verifier {
        Arc::get_mut(verifier)
            .context("participant verifier already shared at boot")?
            .set_revocations(refresh.snapshot.clone());
    }
    if let Some(writer) = &mut app.post_votes {
        writer.set_revocations(refresh.snapshot.clone());
    }
    if let Some(writer) = &mut app.topic_selection_writer {
        writer.set_revocations(refresh.snapshot.clone());
    }
    app.revocations = Some(refresh.clone());
    Ok(Some(tokio::spawn(refresh.run())))
}

pub(crate) fn refusal(app: &App, raw: &str, now: u64) -> Option<polis_auth::Refusal> {
    app.participant_verifier
        .as_ref()
        .and_then(|v| v.check_revocation(raw, now).err())
        .or_else(|| {
            app.post_votes
                .as_ref()
                .and_then(|w| w.check_revocation(raw, now).err())
        })
        .or_else(|| {
            app.topic_selection_writer
                .as_ref()
                .and_then(|w| w.check_revocation(raw, now).err())
        })
}
pub(crate) fn health(app: &App) -> crate::js::Js {
    let mut out = crate::js::Obj::new();
    out.set("loaded", crate::js::Js::Bool(app.revocations.is_some()));
    if let Some(r) = &app.revocations {
        let snapshot = r.snapshot.snapshot();
        for (key, value) in [
            ("revoked", snapshot.len() as u64),
            ("bytes", snapshot.bytes() as u64),
            ("refreshSuccesses", r.successes.load(Ordering::Relaxed)),
            ("refreshFailures", r.failures.load(Ordering::Relaxed)),
        ] {
            out.set(key, crate::js::Js::Num(value as f64));
        }
    }
    crate::js::Js::Obj(out)
}
