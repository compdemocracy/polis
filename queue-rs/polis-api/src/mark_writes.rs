//! Existing-member star/trash appends. No identity allocation or automatic retry.
use crate::{
    config, db,
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use polis_auth::participant;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/mark_writes.rs"]
mod contract;
use contract::Kind;
pub(crate) const MAX_BODY_BYTES: usize = 65536;
pub(crate) fn matches(path: &str) -> bool {
    Kind::from_path(path).is_some()
}
pub(crate) struct Writer {
    reads: Arc<db::Pool>,
    writes: Arc<db::Pool>,
    notifications: Arc<db::Pool>,
    verifier: participant::Verifier,
    pending: Arc<tokio::sync::Semaphore>,
    notification_pending: Arc<tokio::sync::Semaphore>,
    notification_dropped: Arc<AtomicU64>,
    #[cfg(all(test, feature = "db-tests"))]
    after_mutation: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
}
impl Writer {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        if std::env::var("POLIS_API_MARK_WRITES").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let dsn = std::env::var("POLIS_API_MARK_WRITES_DATABASE_URL")?;
        let key = std::fs::read(std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")?)?;
        let verifier = participant::Verifier::new(
            &key,
            &std::env::var("POLIS_JWT_ISSUER")?,
            &std::env::var("POLIS_JWT_AUDIENCE")?,
        )
        .context("participant verification configuration")?;
        Ok(Some(Self {
            reads: db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-mark-admission/1")?,
                limits(50),
            ),
            writes: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-mark-writes/1")?,
                limits(1000),
            ),
            notifications: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-mark-notifications/1")?,
                limits(50),
            ),
            verifier,
            pending: Arc::new(tokio::sync::Semaphore::new(8)),
            notification_pending: Arc::new(tokio::sync::Semaphore::new(8)),
            notification_dropped: Arc::new(AtomicU64::new(0)),
            #[cfg(all(test, feature = "db-tests"))]
            after_mutation: None,
        }))
    }
}
fn limits(ms: u64) -> db::Limits {
    db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(25),
        statement_timeout: Duration::from_millis(ms),
        max_lifetime: Duration::from_secs(300),
    }
}
struct Input {
    kind: Kind,
    cid: String,
    tid: i32,
    value: i32,
}
fn parse(req: &Request) -> Option<Input> {
    let kind = Kind::from_path(req.path())?;
    if req.method != "POST"
        || req.query().is_some_and(|q| !q.is_empty())
        || req.body.len() > MAX_BODY_BYTES
        || ["cookie", "content-encoding", "transfer-encoding"]
            .iter()
            .any(|h| req.headers.get(h).is_some())
        || !matches!(
            req.headers.get("content-type"),
            Some("application/json" | "application/json; charset=utf-8")
        )
    {
        return None;
    }
    let body: serde_json::Value = serde_json::from_slice(&req.body).ok()?;
    let obj = body.as_object()?;
    if obj
        .keys()
        .any(|k| k != "conversation_id" && k != "tid" && k != kind.field())
    {
        return None;
    }
    let cid = obj.get("conversation_id")?.as_str()?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let tid = i32::try_from(obj.get("tid")?.as_i64()?).ok()?;
    let value = i32::try_from(obj.get(kind.field())?.as_i64()?).ok()?;
    if !(0..=1).contains(&value) {
        return None;
    }
    Some(Input {
        kind,
        cid: cid.into(),
        tid,
        value,
    })
}
pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    app.mark_writer.is_some()
        && app.production
        && parse(req).is_some()
        && app.cors.resolve(&req.headers).is_ok()
        && (app.dev_mode
            || app.use_network_host
            || req.headers.get("x-forwarded-proto") == Some("https"))
}
fn admit(
    c: &mut postgres::Client,
    cid: &str,
    identity: &participant::Verified,
) -> Result<Option<(i32, i32)>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(None);
    };
    // This resolver is deliberately narrower than Node's UID lookup. A stale
    // scoped PID or a gated membership returns to Node before any mutation.
    Ok(participant::resolve(c, polis_auth::Zid(zid), identity)?.map(|pid| (zid, pid.0 as i32)))
}
struct Written {
    status: u16,
    created: Option<i64>,
}
fn mutate(c: &mut postgres::Client, zid: i32, pid: i32, input: &Input) -> Written {
    let sql = match input.kind {
        Kind::Star => {
            "INSERT INTO stars(pid,zid,tid,starred,created) VALUES($1,$2,$3,$4,default) RETURNING created"
        }
        Kind::Trash => {
            "INSERT INTO trashes(pid,zid,tid,trashed,created) VALUES($1,$2,$3,$4,default) RETURNING created"
        }
    };
    match c.query_one(sql, &[&pid, &zid, &input.tid, &input.value]) {
        Ok(row) => Written {
            status: if input.kind == Kind::Star { 500 } else { 200 },
            created: if input.kind == Kind::Trash {
                row.try_get(0).ok()
            } else {
                None
            },
        },
        Err(e) => Written {
            status: if e.code() == Some(&postgres::error::SqlState::UNIQUE_VIOLATION) {
                406
            } else {
                500
            },
            created: None,
        },
    }
}
pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    if !eligible(app, req) {
        return route::bad_gateway();
    }
    let (Some(writer), Some(input)) = (&app.mark_writer, parse(req)) else {
        return route::bad_gateway();
    };
    let Some(identity) = req.headers.get("authorization").and_then(|h| {
        writer
            .verifier
            .verify(h, &input.cid, (crate::clock::now_ms() / 1000.0) as u64)
    }) else {
        return route::bad_gateway();
    };
    let Ok(pending) = writer.pending.clone().try_acquire_owned() else {
        return route::bad_gateway();
    };
    let cid = input.cid.clone();
    let Ok(Ok(Some((zid, pid)))) = tokio::time::timeout(
        Duration::from_millis(100),
        writer.reads.with(move |c| admit(c, &cid, &identity)),
    )
    .await
    else {
        return route::bad_gateway();
    };
    let pool = writer.writes.clone();
    let notifications = writer.notifications.clone();
    let notification_pending = writer.notification_pending.clone();
    let dropped = writer.notification_dropped.clone();
    #[cfg(all(test, feature = "db-tests"))]
    let after_mutation = writer.after_mutation.clone();
    // The task owns the write and its permit after dispatch, even when the
    // request disappears. No post-dispatch outcome can ask Node to replay it.
    let task = tokio::spawn(async move {
        let _pending = pending;
        let written = pool.with(move |c| Ok(mutate(c, zid, pid, &input))).await?;
        #[cfg(all(test, feature = "db-tests"))]
        if let Some(hook) = after_mutation {
            tokio::task::spawn_blocking(move || hook()).await??;
        }
        if let Some(created) = written.created {
            // Node defers this metadata update. Bound admission before spawning
            // it, use a separate pool, and never hold a writer across the delay.
            if let Ok(permit) = notification_pending.try_acquire_owned() {
                tokio::spawn(async move {
                    let _permit = permit;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if notifications
                        .with(move |c| {
                            Ok(c.execute(
                                "UPDATE conversations SET modified=$2 WHERE zid=$1 AND modified<$2",
                                &[&zid, &created],
                            )?)
                        })
                        .await
                        .is_err()
                    {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                });
            } else {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok::<_, anyhow::Error>(written.status)
    });
    let status = match tokio::time::timeout(Duration::from_millis(1100), task).await {
        Ok(Ok(Ok(status))) => status,
        _ => 500,
    };
    if status == 200 {
        route::json_text(req, res, 200, "{}".into())
    } else {
        route::fail_json(
            req,
            res,
            status,
            crate::js::Js::Str(
                if status == 406 {
                    "polis_err_vote_duplicate"
                } else {
                    "polis_err_vote"
                }
                .into(),
            ),
        )
    }
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "mark_writes_tests.rs"]
mod tests;
