//! Existing, conversation-scoped participant votes. Handoff is possible only
//! before the append is dispatched. Every subsequent failure is terminal.
use crate::post_votes_contract::{self as contract, ParsedFields};
use crate::{
    comments, config, db,
    http::{Outgoing, Request},
    js::{self, Js},
    next_comment,
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use contract::{AcceptedVote, DurableSuccess, FollowOn, FollowOnState, NotificationState};
use polis_auth::{Zid, participant};
use postgres::Client;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

pub const PATH: &str = contract::PATH;
pub(crate) const MAX_BODY_BYTES: usize = 65536;
const REJECTED_COMMENT_MOD: i32 = -1;
const ADMISSION_DEADLINE: Duration = Duration::from_millis(250);
const DISPATCH_DEADLINE: Duration = Duration::from_secs(1);

pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    background: Arc<NotificationPool>,
    verifier: participant::Verifier,
    reads: Arc<db::Pool>,
    admins: Vec<i32>,
}

impl Writer {
    pub(crate) fn set_revocations(&mut self, snapshot: Arc<polis_auth::revocation::Revocations>) {
        self.verifier.set_revocations(snapshot);
    }
    pub(crate) fn check_revocation(&self, raw: &str, now: u64) -> Result<(), polis_auth::Refusal> {
        self.verifier.check_revocation(raw, now)
    }

    pub(crate) fn from_env() -> Result<Option<Self>> {
        if std::env::var("POLIS_API_POST_VOTES").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        // Topical selection and translation providers cannot be part of this
        // admitted slice. An absent setting does not imply ordinary selection.
        anyhow::ensure!(
            std::env::var("TOPICAL_COMMENT_RATIO").ok().as_deref() == Some("0"),
            "post votes requires explicit ordinary next-statement selection"
        );
        let dsn = std::env::var("POLIS_API_POST_VOTES_DATABASE_URL")
            .context("post votes requires an explicit primary database")?;
        let key = std::fs::read(std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")?)?;
        let verifier = participant::Verifier::new(
            &key,
            &std::env::var("POLIS_JWT_ISSUER")?,
            &std::env::var("POLIS_JWT_AUDIENCE")?,
        )
        .context("invalid participant verifier configuration")?;
        let admins =
            serde_json::from_str(&std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()))?;
        Ok(Some(Self {
            pool: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-post-votes/1")?,
                db::Limits {
                    size: 4,
                    acquire_timeout: Duration::from_millis(100),
                    statement_timeout: Duration::from_millis(1000),
                    max_lifetime: Duration::from_secs(300),
                },
            ),
            background: NotificationPool::new(db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-vote-notifications/1")?,
                db::Limits {
                    size: 2,
                    acquire_timeout: Duration::from_millis(100),
                    statement_timeout: Duration::from_millis(1000),
                    max_lifetime: Duration::from_secs(300),
                },
            )),
            verifier,
            reads: db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-reads/1")?,
                read_limits(),
            ),
            admins,
        }))
    }
}

fn request(req: &Request) -> Option<(String, contract::Request)> {
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
    let obj = value.as_object()?;
    if obj.keys().any(|k| {
        !matches!(
            k.as_str(),
            "conversation_id" | "tid" | "vote" | "starred" | "high_priority" | "lang"
        )
    }) {
        return None;
    }
    let raw: contract::Request = serde_json::from_value(value).ok()?;
    let cid = contract::string(raw.conversation_id.as_ref()?, 100)?;
    if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some((cid, raw))
}

pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    app.post_votes.is_some()
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
}

fn read_limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

// Fetch only the selection weights. Large projection/cluster payloads never
// cross this boundary or consume a writer connection. No cross-request cache:
// each read observes the currently published generation, as an independent read.
fn priorities(c: &mut Client, zid: i32, env: &str) -> Result<Option<Js>> {
    let row = c.query_opt(
        "select jsonb_typeof(data), (data->'comment-priorities')::text
         from math_main where zid=$1 and math_env=$2 and math_tick>=0",
        &[&zid, &env],
    )?;
    let Some(row) = row else { return Ok(None) };
    anyhow::ensure!(
        row.try_get::<_, Option<String>>(0)?.as_deref() == Some("object"),
        "unsupported math shape"
    );
    row.try_get::<_, Option<String>>(1)?
        .map(|text| js::parse(&text))
        .transpose()
}

fn admit(
    c: &mut Client,
    cid: &str,
    identity: &participant::Verified,
    env: &str,
) -> Result<Option<Admitted>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(None);
    };
    let Some(pid) = participant::resolve(c, Zid(zid), identity)? else {
        return Ok(None);
    };
    let row = c.query_one(
        "select c.is_active, c.xid_required, c.use_xid_whitelist,
         u.site_id is not null and u.site_id = owner_user.site_id
         from conversations c left join users owner_user on owner_user.uid=c.owner
         left join users u on u.uid=$2 where c.zid=$1",
        &[&zid, &identity.uid().0],
    )?;
    if (identity.kind == participant::Kind::StandardUser
        && row.try_get::<_, Option<bool>>(3)?.unwrap_or(false))
        || row.try_get::<_, Option<bool>>(1)?.unwrap_or(false)
        || row.try_get::<_, Option<bool>>(2)?.unwrap_or(false)
    {
        return Ok(None);
    }
    // Validate the math branch before mutation. A later read failure is still
    // possible; committed votes return durable acceptance, never a handoff.
    if let Some(priorities) = priorities(c, zid, env)? {
        let Some(priorities) = priorities.as_obj() else {
            return Ok(None);
        };
        if priorities.iter().any(|(_, p)| {
            !matches!(p, Js::Null | Js::Bool(false))
                && !matches!(p, Js::Num(n) if n.is_finite() && *n >= 0.0)
        }) {
            return Ok(None);
        }
    }
    Ok(Some(Admitted {
        zid,
        pid: pid.0 as i32,
        uid: identity.uid().0,
        active: row.try_get::<_, Option<bool>>(0)?.unwrap_or(false),
    }))
}

fn next(c: &mut Client, a: &Admitted, env: &str, unit: f64) -> Result<Option<Js>> {
    let strict = c
        .query_one(
            "select strict_moderation from conversations where zid=$1",
            &[&a.zid],
        )?
        .try_get::<_, Option<bool>>(0)?
        .unwrap_or(false);
    let moderation = if strict {
        "mod = 1".to_owned()
    } else {
        format!("mod != {REJECTED_COMMENT_MOD}")
    };
    let rows = c.query(
        &format!(
            "select * from comments where zid=$1
         and tid not in (select tid from votes_latest_unique where zid=$1 and pid=$2)
         and active=true and {moderation} and velocity>0
         order by created limit 999"
        ),
        &[&a.zid, &a.pid],
    )?;
    let tids = rows
        .iter()
        .map(|row| row.try_get::<_, i32>("tid"))
        .collect::<Result<Vec<_>, _>>()?;
    let rows = rows
        .iter()
        .map(comments::project)
        .collect::<Result<Vec<_>>>()?;
    let data = priorities(c, a.zid, env)?;
    let counts = c.query_one(
        "with v as (select * from votes_latest_unique where zid=$1 and pid=$2),
         c as (select * from get_visible_comments($1)),
         remaining as (select count(*) as n from c left join v on c.tid=v.tid where v.vote is null),
         total as (select count(*) as n from c)
         select remaining.n,total.n from remaining,total",
        &[&a.zid, &a.pid],
    )?;
    if rows.is_empty() {
        return Ok(None);
    }
    let priorities = data.as_ref().and_then(Js::as_obj);
    let (index, random) = next_comment::select(&tids, priorities, unit)?;
    let mut row = rows[index].as_obj().cloned().context("invalid statement")?;
    row.set("randomN", Js::Num(random));
    row.set("remaining", Js::Num(counts.try_get::<_, i64>(0)? as f64));
    row.set("total", Js::Num(counts.try_get::<_, i64>(1)? as f64));
    row.set("translations", Js::Arr(vec![]));
    Ok(Some(Js::Obj(row)))
}

enum Outcome {
    Success(DurableSuccess),
    Failure(u16, &'static str),
}

fn append(c: &mut Client, a: &Admitted, fields: &ParsedFields) -> Result<AcceptedVote> {
    let mut tx = c
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::ReadCommitted)
        .start()?;
    // Keep the writer pool's statement bound (one second in production),
    // with local lock and idle bounds for the whole vote transaction.
    tx.batch_execute(
        "SET LOCAL lock_timeout='100ms';
         SET LOCAL statement_timeout FROM CURRENT;
         SET LOCAL idle_in_transaction_session_timeout='1s'",
    )?;
    let vote = append_in_transaction(&mut tx, a, fields)?;
    // A failed acknowledgement cannot authorize a Node replay. Keep commit
    // errors distinct from statement rejections even if they carry SQLSTATE.
    tx.commit()
        .map_err(|error| anyhow::anyhow!("vote commit acknowledgement unavailable: {error}"))?;
    Ok(vote)
}

fn append_in_transaction(
    tx: &mut postgres::Transaction<'_>,
    a: &Admitted,
    fields: &ParsedFields,
) -> Result<AcceptedVote> {
    let storage = i16::try_from(contract::stored_vote(fields.vote))?;
    let tid = fields.tid as i32;
    // Establish a missing key so concurrent first votes serialize too. This
    // provisional row is invisible until commit and rolls back on any failure.
    let inserted = tx.execute(
        "insert into votes_latest_unique(zid,pid,tid,vote,weight_x_32767,modified)
         values($1,$2,$3,$4,0,now_as_millis())
         on conflict (zid,pid,tid) do nothing",
        &[&a.zid, &a.pid, &tid, &storage],
    )?;
    let latest = tx.query_one(
        "select vote,modified from votes_latest_unique
         where zid=$1 and pid=$2 and tid=$3 for update",
        &[&a.zid, &a.pid, &tid],
    )?;
    let replayed = inserted == 0 && latest.try_get::<_, Option<i16>>(0)? == Some(storage);
    let created = if replayed {
        latest.try_get(1)?
    } else {
        // The existing INSERT rule updates latest choice/time and retains its
        // weight. No history scan, participant lock or conversation lock.
        tx.query_one(
            "insert into votes(pid,zid,tid,vote,weight_x_32767,high_priority)
             values($1,$2,$3,$4,0,$5) returning created",
            &[&a.pid, &a.zid, &tid, &storage, &fields.high_priority],
        )?
        .try_get(0)?
    };
    Ok(AcceptedVote {
        tid,
        vote: fields.vote.wire(),
        created,
        replayed,
    })
}

fn star(c: &mut Client, a: &Admitted, fields: &ParsedFields, created: i64) -> Result<()> {
    if let Some(starred) = fields.starred {
        c.execute(
            "insert into stars(pid,zid,tid,starred,created) values($1,$2,$3,$4,$5)",
            &[
                &a.pid,
                &a.zid,
                &(fields.tid as i32),
                &i32::from(starred),
                &created,
            ],
        )?;
    }
    Ok(())
}

fn complete(c: &mut Client, a: &Admitted, env: &str, unit: f64) -> Result<contract::Success> {
    let next_comment = next(c, a, env, unit)?
        .map(|next| {
            serde_json::value::RawValue::from_string(js::stringify(&next))
                .map(contract::NextComment)
        })
        .transpose()?;
    Ok(contract::Success {
        next_comment,
        current_pid: a.pid,
        auth: None,
    })
}

#[cfg(test)]
#[path = "post_votes_tests.rs"]
mod tests;

fn notification_state(c: &mut Client, a: &Admitted) -> Result<()> {
    c.execute(
        "update participants set last_interaction=now_as_millis(),nsli=0 where zid=$1 and uid=$2",
        &[&a.zid, &a.uid],
    )?;
    Ok(())
}

pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let (Some(writer), Some((cid, raw))) = (&app.post_votes, request(req)) else {
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
    let env = app.math_env.clone();
    let admission = tokio::time::timeout(
        ADMISSION_DEADLINE,
        writer.reads.with(move |c| admit(c, &cid, &identity, &env)),
    )
    .await;
    let Ok(Ok(Some(admitted))) = admission else {
        return route::bad_gateway();
    };
    let fields = match raw.parse_fields() {
        Ok(fields) => fields,
        Err(_) => return route::parameter_error(app, req, res),
    };
    if fields.lang.as_ref().is_some_and(|s| !s.is_empty())
        || !(i32::MIN as f64..=i32::MAX as f64).contains(&fields.tid)
    {
        return route::bad_gateway();
    }
    if !admitted.active {
        return route::fail_json(
            req,
            res,
            403,
            Js::Str("polis_err_conversation_is_closed".into()),
        );
    }
    // Publish a receipt immediately after SQL acknowledges the vote transaction commit. A
    // disconnected caller cannot cancel the task. A deadline without a receipt
    // is explicitly unknown (202), never a failure that nginx may replay.
    let receipt = Arc::new(Mutex::new(None));
    let fallback_pid = admitted.pid;
    let fallback_star = fields.starred.is_some();
    let active_dispatch = ActiveDispatch::new();
    let task = tokio::spawn(dispatch(
        writer.pool.clone(),
        writer.reads.clone(),
        writer.background.clone(),
        admitted,
        fields,
        app.math_env.clone(),
        next_comment::draw(req),
        receipt.clone(),
        active_dispatch,
    ));
    match tokio::time::timeout(DISPATCH_DEADLINE, task).await {
        Ok(Ok(Ok(Outcome::Success(body)))) => accepted(req, res, body),
        Ok(Ok(Ok(Outcome::Failure(status, code)))) => {
            route::fail_json(req, res, status, Js::Str(code.into()))
        }
        _ => {
            let vote = receipt.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(vote) = vote {
                accepted(req, res, degraded(fallback_pid, vote, fallback_star))
            } else {
                route::json_text(
                    req,
                    res,
                    202,
                    r#"{"acceptance":"unknown","retry":"same_vote"}"#.into(),
                )
            }
        }
    }
}

fn degraded(pid: i32, vote: AcceptedVote, star: bool) -> DurableSuccess {
    DurableSuccess {
        next_comment: None,
        current_pid: pid,
        vote,
        follow_on: FollowOn {
            star: if star {
                FollowOnState::Degraded
            } else {
                FollowOnState::Absent
            },
            next_comment: FollowOnState::Degraded,
            notifications: NotificationState::BestEffort,
        },
    }
}

fn accepted(req: &Request, res: Res, body: DurableSuccess) -> Outgoing {
    // A fixed receipt of integers/bool is always serializable. Even a future
    // optional-body codec error must retain this receipt with HTTP 200.
    let fallback = format!(
        "{{\"currentPid\":{},\"vote\":{{\"tid\":{},\"vote\":{},\"created\":{},\"replayed\":{}}},\"followOn\":{{\"star\":\"{}\",\"nextComment\":\"degraded\",\"notifications\":\"best_effort\"}}}}",
        body.current_pid,
        body.vote.tid,
        body.vote.vote,
        body.vote.created,
        body.vote.replayed,
        if body.follow_on.star == FollowOnState::Absent {
            "absent"
        } else {
            "degraded"
        }
    );
    let encoded = serde_json::to_string(&body);
    if encoded.is_err()
        || body.follow_on.star == FollowOnState::Degraded
        || body.follow_on.next_comment == FollowOnState::Degraded
        || body.follow_on.notifications == NotificationState::Degraded
    {
        let count = DEGRADED.fetch_add(1, Ordering::Relaxed) + 1;
        if count.is_power_of_two() {
            eprintln!(
                "{{\"event\":\"post_votes_durable_accepted_with_degraded_follow_on\",\"count\":{count}}}"
            );
        }
    }
    route::json_text(req, res, 200, encoded.unwrap_or(fallback))
}

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    pool: Arc<db::Pool>,
    reads: Arc<db::Pool>,
    background: Arc<NotificationPool>,
    admitted: Admitted,
    fields: ParsedFields,
    env: String,
    unit: f64,
    receipt: Arc<Mutex<Option<AcceptedVote>>>,
    _active_dispatch: ActiveDispatch,
) -> Result<Outcome> {
    let a = admitted.clone();
    let f = fields.clone();
    let created = pool
        .with(move |c| {
            match append(c, &a, &f) {
                Ok(vote) => Ok(Ok(vote)),
                Err(error) => match error
                    .downcast_ref::<postgres::Error>()
                    .and_then(postgres::Error::code)
                {
                    Some(&postgres::error::SqlState::UNIQUE_VIOLATION) => {
                        Ok(Err(Outcome::Failure(406, "polis_err_vote_duplicate")))
                    }
                    Some(_) => Ok(Err(Outcome::Failure(500, "polis_err_vote"))),
                    // A broken connection or commit failure can hide a committed vote.
                    None => Err(error),
                },
            }
        })
        .await?;
    let created = match created {
        Ok(created) => created,
        Err(outcome) => return Ok(outcome),
    };
    *receipt.lock().unwrap_or_else(|e| e.into_inner()) = Some(created.clone());
    let notified = schedule_notification(background.clone(), admitted.clone());
    let mut body = degraded(admitted.pid, created.clone(), fields.starred.is_some());
    if !notified {
        body.follow_on.notifications = NotificationState::Degraded;
    }
    if fields.starred.is_some() {
        let a = admitted.clone();
        if pool
            .with(move |c| star(c, &a, &fields, created.created))
            .await
            .is_err()
        {
            return Ok(Outcome::Success(body));
        }
        body.follow_on.star = FollowOnState::Complete;
    }
    let a = admitted.clone();
    if let Ok(completed) = reads.with(move |c| complete(c, &a, &env, unit)).await {
        body.next_comment = completed.next_comment;
        body.follow_on.next_comment = if body.next_comment.is_some() {
            FollowOnState::Complete
        } else {
            FollowOnState::Absent
        };
        if body.next_comment.is_none()
            && !background.schedule(move |c| {
                c.execute(
                    "insert into event_ptpt_no_more_comments(zid,pid,votes_placed)
                values($1,$2,(select count(*) from votes where zid=$1 and pid=$2))",
                    &[&admitted.zid, &admitted.pid],
                )?;
                Ok(())
            })
        {
            body.follow_on.notifications = NotificationState::Degraded;
        }
    }
    Ok(Outcome::Success(body))
}

/// A separate admission bound covers both active work and tasks waiting for
/// the two database connections. Admission never waits or spawns on overflow.
struct NotificationPool {
    pool: Arc<db::Pool>,
    admitted: Arc<tokio::sync::Semaphore>,
    dropped: std::sync::atomic::AtomicU64,
}

impl NotificationPool {
    fn new(pool: Arc<db::Pool>) -> Arc<Self> {
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
            eprintln!("{{\"event\":\"vote_notification_dropped\",\"count\":{dropped}}}");
        }
    }
}

fn schedule_notification(pool: Arc<NotificationPool>, admitted: Admitted) -> bool {
    // Best effort: capacity, acquisition, lock/statement failures and shutdown
    // may drop work. No durable queue, retry or flush guarantee. Later votes
    // may refresh state but cannot repair every missed suppression decision.
    pool.schedule(move |c| notification_state(c, &admitted))
}

static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
struct ActiveDispatch;
impl ActiveDispatch {
    fn new() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        Self
    }
}
impl Drop for ActiveDispatch {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
static SERVED: AtomicU64 = AtomicU64::new(0);
static HANDED_BACK: AtomicU64 = AtomicU64::new(0);
static DEGRADED: AtomicU64 = AtomicU64::new(0);
static UNKNOWN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn observe(out: &Outgoing) {
    let (counter, event) = if out.status == 502 {
        (&HANDED_BACK, "post_votes_handed_back")
    } else {
        (&SERVED, "post_votes_served")
    };
    let count = counter.fetch_add(1, Ordering::Relaxed) + 1;
    if count.is_power_of_two() {
        eprintln!("{{\"event\":\"{event}\",\"count\":{count}}}");
    }
    if out.status == 202 {
        UNKNOWN.fetch_add(1, Ordering::Relaxed);
    }
}

pub(crate) fn health(app: &App) -> Js {
    let mut body = js::Obj::new();
    body.set("enabled", Js::Bool(app.post_votes.is_some()));
    for (key, value) in [
        ("served", &SERVED),
        ("handedBack", &HANDED_BACK),
        ("durableAcceptedWithDegradedFollowOn", &DEGRADED),
        ("unknown", &UNKNOWN),
        ("inFlight", &IN_FLIGHT),
    ] {
        body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
    }
    body.set(
        "notificationsInFlight",
        Js::Num(
            app.post_votes
                .as_ref()
                .map_or(0, |w| 64 - w.background.admitted.available_permits()) as f64,
        ),
    );
    body.set(
        "notificationDropped",
        Js::Num(
            app.post_votes
                .as_ref()
                .map_or(0, |w| w.background.dropped.load(Ordering::Relaxed)) as f64,
        ),
    );
    Js::Obj(body)
}

/// A future gateway can distinguish explicit pre-dispatch hand-back from its
/// own transport 502. Never emit this marker after dispatch begins.
pub(crate) fn mark_handback(out: &mut Outgoing) {
    out.headers
        .push(("X-Polis-Vote-Dispatch".into(), "not-started".into()));
}
