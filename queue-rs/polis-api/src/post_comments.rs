//! Default-off ordinary comments from existing signed participants.
//! No fallback is possible once insertion has been dispatched.
use crate::post_comments_contract::{self as contract, ParsedFields};
use crate::{
    config, db,
    http::{Outgoing, Request},
    js::Js,
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use polis_auth::{Zid, participant};
use postgres::Client;
use std::{sync::Arc, time::Duration};

pub const PATH: &str = contract::PATH;
pub(crate) const MAX_BODY_BYTES: usize = 65536;

pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    reads: Arc<db::Pool>,
    background: Arc<NotificationPool>,
    verifier: participant::Verifier,
    admins: Vec<i32>,
}
fn limits(size: usize, statement_ms: u64) -> db::Limits {
    db::Limits {
        size,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(statement_ms),
        max_lifetime: Duration::from_secs(300),
    }
}
fn configuration_enabled(switch: Option<&str>, translation: Option<&str>) -> bool {
    switch == Some("1") && translation == Some("false")
}
impl Writer {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        // Providers, including their timeout fallback, stay on Node. Require an
        // explicit disabled setting, never infer it from a missing credential.
        if !configuration_enabled(
            std::env::var("POLIS_API_POST_COMMENTS").ok().as_deref(),
            std::env::var("SHOULD_USE_TRANSLATION_API").ok().as_deref(),
        ) {
            return Ok(None);
        }
        let dsn = std::env::var("POLIS_API_POST_COMMENTS_DATABASE_URL")
            .context("post comments requires an explicit primary database")?;
        let public = std::fs::read(std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")?)?;
        let verifier = participant::Verifier::new(
            &public,
            &std::env::var("POLIS_JWT_ISSUER")?,
            &std::env::var("POLIS_JWT_AUDIENCE")?,
        )
        .context("invalid participant verifier configuration")?;
        Ok(Some(Self {
            pool: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-comment-writes/1")?,
                limits(4, 1000),
                Duration::from_millis(100),
            ),
            reads: db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-comment-reads/1")?,
                limits(2, 100),
            ),
            background: NotificationPool::new(config::connector_for_dsn(
                &dsn,
                "polis-api-comment-notifications/1",
            )?),
            verifier,
            admins: serde_json::from_str(
                &std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()),
            )?,
        }))
    }
}
fn request(req: &Request) -> Option<(String, ParsedFields)> {
    if req.method != "POST"
        || req.query().is_some_and(|q| !q.is_empty())
        || req.body.len() > MAX_BODY_BYTES
        || req.headers.get("cookie").is_some()
        || req.headers.get("content-encoding").is_some()
        || !matches!(
            req.headers.get("content-type"),
            Some("application/json" | "application/json; charset=utf-8")
        )
    {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&req.body).ok()?;
    if value
        .as_object()?
        .keys()
        .any(|k| !matches!(k.as_str(), "conversation_id" | "txt" | "vote" | "is_seed"))
    {
        return None;
    }
    let raw: contract::Request = serde_json::from_value(value).ok()?;
    let cid = crate::post_votes::string(raw.conversation_id.as_ref()?, 100)?;
    if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let fields = raw.parse_fields().ok()?;
    if fields.vote.is_some()
        || fields.is_seed == Some(true)
        || fields.txt.is_empty()
        || fields.txt.contains('\0')
    {
        return None;
    }
    Some((cid, fields))
}
pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    app.post_comments.is_some()
        && app.production
        && request(req).is_some()
        && (app.dev_mode
            || app.use_network_host
            || req.headers.get("x-forwarded-proto") == Some("https"))
}
#[derive(Clone)]
struct Admitted {
    zid: i32,
    pid: i32,
    uid: i32,
    active: bool,
    duplicate: bool,
}
fn admit(
    c: &mut Client,
    cid: &str,
    identity: &participant::Verified,
    txt: &str,
) -> Result<Option<Admitted>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(None);
    };
    let Some(pid) = participant::resolve(c, Zid(zid), identity)? else {
        return Ok(None);
    };
    let row = c.query_one(
        "select c.is_active,c.strict_moderation,c.xid_required,c.use_xid_whitelist,
        u.site_id is not null and u.site_id=owner_user.site_id,
        exists(select 1 from comments where zid=c.zid and txt=$3)
        from conversations c left join users owner_user on owner_user.uid=c.owner
        left join users u on u.uid=$2 where c.zid=$1",
        &[&zid, &identity.uid().0, &txt],
    )?;
    for column in 1..=4 {
        if row.try_get::<_, Option<bool>>(column)?.unwrap_or(false) {
            return Ok(None);
        }
    }
    Ok(Some(Admitted {
        zid,
        pid: pid.0 as i32,
        uid: identity.uid().0,
        active: row.try_get::<_, Option<bool>>(0)?.unwrap_or(false),
        duplicate: row.try_get(5)?,
    }))
}
fn failure(req: &Request, res: Res, status: u16, code: &str) -> Outgoing {
    route::fail_json(req, res, status, Js::Str(code.into()))
}
fn insert(c: &mut Client, a: &Admitted, txt: &str) -> Result<i32> {
    // The existing BEFORE trigger assigns tid and holds its transaction advisory
    // lock through this autocommit statement. No private allocator or SQL function.
    let row = c.query_one(
        "insert into comments
        (pid,zid,txt,velocity,active,mod,uid,anon,is_seed,created,tid,lang,lang_confidence)
        values($1,$2,$3,1,true,0,$4,false,false,default,null,null,null) returning tid",
        &[&a.pid, &a.zid, &txt, &a.uid],
    )?;
    Ok(row.try_get(0)?)
}
fn classify(error: &anyhow::Error) -> (u16, &'static str) {
    if let Some(e) = error
        .downcast_ref::<postgres::Error>()
        .and_then(postgres::Error::as_db_error)
    {
        use postgres::error::SqlState;
        if *e.code() == SqlState::UNIQUE_VIOLATION
            && matches!(
                e.constraint(),
                Some("comments_zid_txt_key" | "comments_txt_unique_constraint")
            )
        {
            return (409, "polis_err_post_comment_duplicate");
        }
        if *e.code() == SqlState::FOREIGN_KEY_VIOLATION {
            return (
                500,
                if e.constraint() == Some("comments_zid_pid_fkey") {
                    "polis_err_post_comment_participant_race_condition"
                } else {
                    "polis_err_post_comment_constraint_violation"
                },
            );
        }
    }
    (500, "polis_err_post_comment")
}
pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let (Some(writer), Some((cid, fields))) = (&app.post_comments, request(req)) else {
        return route::bad_gateway();
    };
    let Some(identity) = req.headers.get("authorization").and_then(|auth| {
        writer
            .verifier
            .verify(auth, &cid, (crate::clock::now_ms() / 1000.0) as u64)
    }) else {
        return route::bad_gateway();
    };
    if writer.admins.contains(&identity.uid().0) {
        return route::bad_gateway();
    }
    let txt = fields.txt.clone();
    let admission = tokio::time::timeout(
        Duration::from_millis(250),
        writer.reads.with(move |c| admit(c, &cid, &identity, &txt)),
    )
    .await;
    let Ok(Ok(Some(a))) = admission else {
        return route::bad_gateway();
    };
    if a.duplicate {
        return failure(req, res, 409, "polis_err_post_comment_duplicate");
    }
    if !a.active {
        return failure(req, res, 403, "polis_err_conversation_is_closed");
    }
    let pool = writer.pool.clone();
    let background = writer.background.clone();
    // Own the operation through completion even after disconnect or deadline.
    // After this boundary a 500 can mean an unknown commit; never proxy-retry.
    let task = tokio::spawn(async move {
        let actor = a.clone();
        let outcome = pool
            .with(move |c| Ok(insert(c, &actor, &fields.txt).map_err(|e| classify(&e))))
            .await?;
        if outcome.is_ok() {
            let zid = a.zid;
            background.schedule(move |c| {c.execute("insert into notification_tasks(zid) values($1) on conflict(zid) do update set modified=now_as_millis()",&[&zid])?;Ok(())});
            background.schedule(move |c| {c.execute("update participants set last_interaction=now_as_millis(),nsli=0 where zid=$1 and uid=$2",&[&a.zid,&a.uid])?;Ok(())});
        }
        Ok::<_, anyhow::Error>(outcome.map(|tid| contract::Success {
            tid,
            current_pid: a.pid,
            auth: None,
        }))
    });
    match tokio::time::timeout(Duration::from_secs(1), task).await {
        Ok(Ok(Ok(Ok(body)))) => match serde_json::to_string(&body) {
            Ok(body) => route::json_text(req, res, 200, body),
            Err(_) => failure(req, res, 500, "polis_err_post_comment"),
        },
        Ok(Ok(Ok(Err((status, code))))) => failure(req, res, status, code),
        _ => failure(req, res, 500, "polis_err_post_comment"),
    }
}

/// A separate admission bound covers both active work and tasks waiting for
/// the two database connections. Admission never waits or spawns on overflow.
struct NotificationPool {
    pool: Arc<db::Pool>,
    admitted: Arc<tokio::sync::Semaphore>,
    dropped: std::sync::atomic::AtomicU64,
}

impl NotificationPool {
    fn new(connector: polis_queue_adapter::jobs::transport::Connector) -> Arc<Self> {
        // Match Node's best-effort notification lane without widening the
        // participation writer's acquisition or lock budgets.
        let pool = db::Pool::writer(
            connector,
            db::Limits {
                acquire_timeout: Duration::from_millis(250),
                ..limits(2, 1000)
            },
            Duration::from_millis(250),
        );
        Arc::new(Self {
            pool,
            admitted: Arc::new(tokio::sync::Semaphore::new(64)),
            dropped: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn schedule<F>(self: &Arc<Self>, work: F) -> bool
    where
        F: FnOnce(&mut Client) -> Result<()> + Send + 'static,
    {
        let Ok(permit) = self.admitted.clone().try_acquire_owned() else {
            self.record_drop();
            return false;
        };
        let lane = self.clone();
        tokio::spawn(async move {
            // Keep admission through the actual blocking operation, even if
            // its awaiting future is dropped. A pool timeout drops the closure
            // and its permit without ever running the work.
            let result = lane
                .pool
                .with(move |c| {
                    let _permit = permit;
                    work(c)
                })
                .await;
            if result.is_err() {
                lane.record_drop();
            }
        });
        true
    }

    fn record_drop(&self) {
        let dropped = self
            .dropped
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        // Report exponentially so overload cannot create an unbounded log stream.
        if dropped.is_power_of_two() {
            eprintln!("{{\"event\":\"comment_notification_dropped\",\"count\":{dropped}}}");
        }
    }
}

#[cfg(test)]
#[path = "post_comments_tests.rs"]
mod tests;
