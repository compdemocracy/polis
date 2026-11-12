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

#[path = "writer_priorities.rs"]
mod writer_priorities;

#[path = "post_votes_observe.rs"]
pub(crate) mod observe;
pub(crate) use observe::Observer;

#[path = "post_votes_identity.rs"]
pub(crate) mod identity;

pub const PATH: &str = contract::PATH;
// The comment contract is compiled into this crate by path. It names these
// four parsers by their path in the contracts crate, which here is this
// module's path.
pub(crate) use contract::{InvalidField, boolean, integer, string};
pub(crate) const MAX_BODY_BYTES: usize = 65536;
const REJECTED_COMMENT_MOD: i32 = -1;
const ADMISSION_DEADLINE: Duration = Duration::from_millis(250);
const DISPATCH_DEADLINE: Duration = Duration::from_secs(1);
// Accepted work may outlive the HTTP response. Report writer contention while
// preserving queue position until the pool's dispatched-acquisition cutoff.
const DISPATCH_ACQUIRE_ALARM: Duration = Duration::from_secs(1);

pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    background: Arc<NotificationPool>,
    verifier: participant::Verifier,
    reads: Arc<db::Pool>,
    admins: Vec<i32>,
    priorities: Arc<writer_priorities::Cache>,
    follow_on: Arc<FollowOnLane>,
}

impl Writer {
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn startup_pools(&self) -> [&Arc<db::Pool>; 3] {
        // No rest pattern: new fields must be classified for this inventory.
        let Self {
            pool,
            background,
            verifier: _,
            reads,
            admins: _,
            priorities: _,
            follow_on: _,
        } = self;
        let NotificationPool {
            pool: background_pool,
            admitted: _,
            dropped: _,
        } = background.as_ref();
        [pool, background_pool, reads]
    }

    pub(crate) fn set_revocations(&mut self, snapshot: Arc<polis_auth::revocation::Revocations>) {
        self.verifier.set_revocations(snapshot);
    }
    pub(crate) fn check_revocation(&self, raw: &str, now: u64) -> Result<(), polis_auth::Refusal> {
        self.verifier.check_revocation(raw, now)
    }

    /// The live writer `configure` builds in the main role, for the tests of
    /// its startup conditions.
    #[cfg(test)]
    pub(crate) fn from_env() -> Result<Option<Self>> {
        match configure(
            crate::shadow::Role::Main,
            polis_auth::keys::Keys::from_env_optional()?.as_ref(),
        )? {
            Configured::Live(writer) => Ok(Some(writer)),
            Configured::Off => Ok(None),
            Configured::Observe(_) => {
                anyhow::bail!("observe mode is built only by the shadow role")
            }
        }
    }

    fn admission(&self) -> Admission<'_> {
        Admission {
            verifier: &self.verifier,
            reads: &self.reads,
            admins: &self.admins,
            priorities: &self.priorities,
            follow_on: &self.follow_on,
        }
    }
}

/// What `POLIS_API_POST_VOTES` asks for. Unset, empty or `0` is off, as any
/// value but `1` was before observe existed; another value is a startup error
/// rather than a silent off.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Switch {
    Off,
    Live,
    Observe,
}

fn switch() -> Result<Switch> {
    match std::env::var("POLIS_API_POST_VOTES").ok().as_deref() {
        None | Some("" | "0") => Ok(Switch::Off),
        Some("1") => Ok(Switch::Live),
        Some("observe") => Ok(Switch::Observe),
        Some(_) => anyhow::bail!("POLIS_API_POST_VOTES must be unset, 0, 1 or observe"),
    }
}

pub(crate) enum Configured {
    Off,
    Live(Writer),
    Observe(Observer),
}

/// The vote writer this process's role builds. The main role builds the live
/// writer for `1` and refuses `observe`; the shadow role builds the observe
/// writer for `observe` and refuses `1`. Both modes share every startup
/// condition below. Both verify participant tokens with the key in
/// POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE when that is set, and otherwise with
/// the participant keys the process loaded at startup (the container that
/// runs this has no key file; the participant reads use the same keys).
pub(crate) fn configure(
    role: crate::shadow::Role,
    keys: Option<&polis_auth::keys::Keys>,
) -> Result<Configured> {
    let switch = switch()?;
    // Identity is observed only beside the vote observer, in the shadow role.
    // The main role never reads its switch.
    let observe_identity = role == crate::shadow::Role::Shadow && identity::switch()?;
    anyhow::ensure!(
        !observe_identity || switch == Switch::Observe,
        "{}=observe requires POLIS_API_POST_VOTES=observe",
        identity::SWITCH
    );
    match (role, switch) {
        (_, Switch::Off) => return Ok(Configured::Off),
        (crate::shadow::Role::Main, Switch::Observe) => anyhow::bail!(
            "POLIS_API_POST_VOTES=observe is accepted only by the shadow role (POLIS_API_ROLE=shadow)"
        ),
        (crate::shadow::Role::Shadow, Switch::Live) => anyhow::bail!(
            "the shadow role never builds the live vote writer: POLIS_API_POST_VOTES=1 is refused there"
        ),
        _ => {}
    }
    // Topical selection and translation providers cannot be part of this
    // admitted slice. An absent setting does not imply ordinary selection.
    anyhow::ensure!(
        std::env::var("TOPICAL_COMMENT_RATIO").ok().as_deref() == Some("0"),
        "post votes requires explicit ordinary next-statement selection"
    );
    anyhow::ensure!(
        std::env::var("SHOULD_USE_TRANSLATION_API").ok().as_deref() == Some("false"),
        "post votes requires SHOULD_USE_TRANSLATION_API=false"
    );
    let dsn = std::env::var("POLIS_API_POST_VOTES_DATABASE_URL")
        .context("post votes requires an explicit primary database")?;
    let key = match std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")
        .ok()
        .filter(|path| !path.is_empty())
    {
        Some(path) => Some(std::fs::read(path)?),
        None => None,
    };
    let issuer = std::env::var("POLIS_JWT_ISSUER")?;
    let audience = std::env::var("POLIS_JWT_AUDIENCE")?;
    let verifier = match (key, keys) {
        (Some(key), _) => participant::Verifier::new(&key, &issuer, &audience),
        (None, Some(keys)) => keys.verifier(&issuer, &audience),
        (None, None) => anyhow::bail!(
            "post votes requires the participant public key: POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE, or the participant keys the process loads (JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH)"
        ),
    }
    .context("invalid participant verifier configuration")?;
    let admins: Vec<i32> =
        serde_json::from_str(&std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()))?;
    let priorities = Arc::new(writer_priorities::Cache::with_max_bytes(
        writer_priorities::max_bytes_from_env()?,
    ));
    if switch == Switch::Observe {
        // Observe never calls db::Pool::writer: both pools are read-only
        // sessions, and there is no notification pool.
        let mut observer = Observer::new(
            verifier,
            db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-reads/1")?,
                read_limits(),
            ),
            db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-shadow-readback/1")?,
                observe::readback_limits(),
            ),
            admins,
            priorities,
        );
        if observe_identity {
            // A third read-only pool, of its own: an identity decision never
            // takes an admission slot or the vote read-back's connection.
            observer.identity = Some(Box::new(identity::IdentityObserver::new(db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-shadow-identity/1")?,
                identity::limits(),
            ))));
        }
        return Ok(Configured::Observe(observer));
    }
    Ok(Configured::Live(Writer {
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
        priorities,
        follow_on: Arc::new(FollowOnLane::default()),
    }))
}

/// What admission uses, from the live writer or the observe writer.
struct Admission<'a> {
    verifier: &'a participant::Verifier,
    reads: &'a Arc<db::Pool>,
    admins: &'a [i32],
    priorities: &'a Arc<writer_priorities::Cache>,
    follow_on: &'a Arc<FollowOnLane>,
}

fn request(req: &Request) -> Option<(String, contract::Request)> {
    request_reasoned(req).ok()
}

/// `request`, with the reason a request is handed back. The checks and their
/// results are the same; observe mode records the reason.
fn request_reasoned(req: &Request) -> Result<(String, contract::Request), &'static str> {
    if req.method != "POST" {
        return Err("shape_method");
    }
    if req.query().is_some_and(|q| !q.is_empty()) {
        return Err("shape_query");
    }
    if req.body.len() > MAX_BODY_BYTES {
        return Err("shape_size");
    }
    if req.headers.get("content-encoding").is_some() {
        return Err("shape_encoding");
    }
    // The three forms the clients send, each of which Node parses as UTF-8
    // JSON. The upper-case one is the jQuery participation client's
    // `charset=utf-8` as a browser's XMLHttpRequest sends it: for a string
    // body it rewrites the charset value to `UTF-8`.
    if !matches!(
        req.headers.get("content-type"),
        Some(
            "application/json"
                | "application/json; charset=utf-8"
                | "application/json; charset=UTF-8"
        )
    ) {
        return Err("shape_content_type");
    }
    let value: serde_json::Value = serde_json::from_slice(&req.body).map_err(|_| "shape_json")?;
    let obj = value.as_object().ok_or("shape_json")?;
    if obj.keys().any(|k| {
        !matches!(
            k.as_str(),
            "conversation_id"
                | "tid"
                | "vote"
                | "starred"
                | "high_priority"
                | "lang"
                | "pid"
                | "agid"
        )
    }) {
        return Err("shape_keys");
    }
    // Node ignores body pid/agid. The field codec discards them too; only the
    // verified token and resolved membership may identify the voter.
    let raw: contract::Request = serde_json::from_value(value).map_err(|_| "shape_json")?;
    let cid = raw
        .conversation_id
        .as_ref()
        .and_then(|v| contract::string(v, 100))
        .ok_or("shape_conversation_id")?;
    if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("shape_conversation_id");
    }
    Ok((cid, raw))
}

pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    // Cookies neither authenticate nor disqualify a caller. handle still
    // requires a supported verified Bearer and membership before dispatch.
    (app.post_votes.is_some() || app.post_votes_observe.is_some())
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
    // Retain the validated generation until the dispatched work completes.
    _priority_lease: Option<Arc<writer_priorities::Weights>>,
    priorities: Arc<writer_priorities::Cache>,
    follow_on: Arc<FollowOnLane>,
}

fn read_limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

#[cfg(all(test, feature = "db-tests"))]
// The narrow-read isolation test uses the production snapshot query and returns
// its raw representation so its existing byte assertions remain unchanged.
fn priorities(c: &mut Client, zid: i32, env: &str) -> Result<Option<Js>> {
    Arc::new(writer_priorities::Cache::default())
        .snapshot(c, zid, env)?
        .raw_for_test()
}

/// Admission's reads. A refusal is Ok(Err(reason)); live hands every one back.
fn admit(
    c: &mut Client,
    cid: &str,
    identity: &participant::Verified,
    env: &str,
    cache: Arc<writer_priorities::Cache>,
    follow_on: Arc<FollowOnLane>,
) -> Result<Result<(Admitted, writer_priorities::Snapshot), &'static str>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(Err("unknown_conversation"));
    };
    let Some(pid) = participant::resolve(c, Zid(zid), identity)? else {
        return Ok(Err("not_a_participant"));
    };
    let row = c.query_one(
        "select c.is_active, c.xid_required, c.use_xid_whitelist,
         u.site_id is not null and u.site_id = owner_user.site_id
         from conversations c left join users owner_user on owner_user.uid=c.owner
         left join users u on u.uid=$2 where c.zid=$1",
        &[&zid, &identity.uid().0],
    )?;
    // The same three tests, in the same order, as one disjunction before.
    if identity.kind == participant::Kind::StandardUser
        && row.try_get::<_, Option<bool>>(3)?.unwrap_or(false)
    {
        return Ok(Err("site_owner_standard_user"));
    }
    if row.try_get::<_, Option<bool>>(1)?.unwrap_or(false) {
        return Ok(Err("xid_required"));
    }
    if row.try_get::<_, Option<bool>>(2)?.unwrap_or(false) {
        return Ok(Err("xid_allowlist"));
    }
    let snapshot = cache.snapshot(c, zid, env)?;
    Ok(Ok((
        Admitted {
            zid,
            pid: pid.0 as i32,
            uid: identity.uid().0,
            active: row.try_get::<_, Option<bool>>(0)?.unwrap_or(false),
            _priority_lease: None,
            priorities: cache,
            follow_on,
        },
        snapshot,
    )))
}

fn next(
    c: &mut Client,
    a: &Admitted,
    env: &str,
    unit: f64,
    lang: Option<&str>,
) -> Result<Option<Js>> {
    next_selecting(c, a, env, unit, lang, None)
}

/// What observe mode records of a selection, in process. `voted` is the
/// statement the copied vote is on: it counts as voted, as it does after the
/// live writer's commit and after Node's insert, whether or not Node's commit
/// is visible. The statement numbers here (`voted`, `candidates`, `next_tid`)
/// never reach a line: the line carries how many candidates there were and
/// whether a next statement was selected.
#[derive(Debug, Default)]
pub(super) struct Selection {
    pub(super) voted: i32,
    pub(super) candidates: Vec<i32>,
    pub(super) weights_tick: Option<i64>,
    pub(super) next_tid: Option<i32>,
    pub(super) remaining: Option<i64>,
    pub(super) total: Option<i64>,
}

impl Selection {
    pub(super) fn new(voted: i32) -> Self {
        Self {
            voted,
            ..Self::default()
        }
    }
}

/// `next`. With `observed` None (live) the statements, their text and their
/// order are next's own. With Some, the voted statement leaves the candidates
/// and the remaining count, and the selection is recorded.
fn next_selecting(
    c: &mut Client,
    a: &Admitted,
    env: &str,
    unit: f64,
    lang: Option<&str>,
    mut observed: Option<&mut Selection>,
) -> Result<Option<Js>> {
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
            "select tid from comments where zid=$1
         and tid not in (select tid from votes_latest_unique where zid=$1 and pid=$2)
         and active=true and {moderation} and velocity>0
         order by created"
        ),
        &[&a.zid, &a.pid],
    )?;
    let mut tids = rows
        .iter()
        .map(|row| row.try_get::<_, i32>("tid"))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(observed) = observed.as_deref() {
        tids.retain(|tid| *tid != observed.voted);
    }
    let snapshot = a.priorities.snapshot(c, a.zid, env)?;
    let weights_tick = snapshot.tick();
    let weights = snapshot.validate()?;
    let counts = match observed.as_deref() {
        None => c.query_one(
            "with v as (select * from votes_latest_unique where zid=$1 and pid=$2),
         c as (select * from get_visible_comments($1)),
         remaining as (select count(*) as n from c left join v on c.tid=v.tid where v.vote is null),
         total as (select count(*) as n from c)
         select remaining.n,total.n from remaining,total",
            &[&a.zid, &a.pid],
        )?,
        Some(observed) => c.query_one(
            "with v as (select * from votes_latest_unique where zid=$1 and pid=$2),
         c as (select * from get_visible_comments($1)),
         remaining as (select count(*) as n from c left join v on c.tid=v.tid where v.vote is null and c.tid <> $3),
         total as (select count(*) as n from c)
         select remaining.n,total.n from remaining,total",
            &[&a.zid, &a.pid, &observed.voted],
        )?,
    };
    if let Some(observed) = observed.as_deref_mut() {
        observed.candidates.clone_from(&tids);
        observed.weights_tick = weights_tick;
    }
    if tids.is_empty() {
        return Ok(None);
    }
    let (index, random) = weights.select(&tids, unit)?;
    let selected = c.query_one(
        "select * from comments where zid=$1 and tid=$2",
        &[&a.zid, &tids[index]],
    )?;
    let mut row = comments::project(&selected)?
        .as_obj()
        .cloned()
        .context("invalid statement")?;
    row.set("randomN", Js::Num(random));
    let (remaining, total) = (counts.try_get::<_, i64>(0)?, counts.try_get::<_, i64>(1)?);
    row.set("remaining", Js::Num(remaining as f64));
    row.set("total", Js::Num(total as f64));
    if let Some(observed) = observed {
        observed.next_tid = Some(tids[index]);
        observed.remaining = Some(remaining);
        observed.total = Some(total);
    }
    // Node skips the stored read entirely without a requested language. The
    // provider is disabled at startup; this follow-on never authorizes replay
    // of a committed vote.
    let translations = if lang.is_some_and(|lang| !lang.is_empty()) {
        // Optional translation failure keeps the selected statement, as Node
        // does. This SELECT uses the existing reads client/statement deadline,
        // after commit, with no provider, transaction or explicit lock.
        stored_translations(c, a.zid, tids[index]).unwrap_or_default()
    } else {
        vec![]
    };
    row.set("translations", Js::Arr(translations));
    Ok(Some(Js::Obj(row)))
}

// Match next()'s candidate eligibility, not its total/remaining counts (which
// deliberately include muted comments). EXISTS stops at the first eligible row
// without sorting, materializing every id, reading priorities or translations.
fn exhausted(c: &mut Client, a: &Admitted) -> Result<bool> {
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
    Ok(!c
        .query_one(
            &format!(
                "select exists(select 1 from comments where zid=$1
         and tid not in (select tid from votes_latest_unique where zid=$1 and pid=$2)
         and active=true and {moderation} and velocity>0)"
            ),
            &[&a.zid, &a.pid],
        )?
        .try_get::<_, bool>(0)?)
}

// Node's SELECT * returns all languages/sources, in database order. Preserve
// both that row order and column order; int8 values remain strings, as in pg.
fn stored_translations(c: &mut Client, zid: i32, tid: i32) -> Result<Vec<Js>> {
    c.query(
        "select * from comment_translations where zid = ($1) and tid = ($2);",
        &[&zid, &tid],
    )?
    .iter()
    .map(|row| {
        let mut out = js::Obj::new();
        for (index, column) in row.columns().iter().enumerate() {
            let value = match *column.type_() {
                postgres::types::Type::INT4 => row
                    .try_get::<_, Option<i32>>(index)?
                    .map(|n| Js::Num(f64::from(n))),
                postgres::types::Type::INT8 => row
                    .try_get::<_, Option<i64>>(index)?
                    .map(|n| Js::Str(n.to_string())),
                postgres::types::Type::VARCHAR | postgres::types::Type::TEXT => {
                    row.try_get::<_, Option<String>>(index)?.map(Js::Str)
                }
                _ => anyhow::bail!("unsupported translation column"),
            };
            out.set(column.name(), value.unwrap_or(Js::Null));
        }
        Ok(Js::Obj(out))
    })
    .collect()
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

fn complete(
    c: &mut Client,
    a: &Admitted,
    env: &str,
    unit: f64,
    lang: Option<&str>,
) -> Result<contract::Success> {
    let next_comment = next(c, a, env, unit, lang)?
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

/// A request admission accepted: an existing member of an open or closed
/// conversation, with valid fields.
struct Prepared {
    admitted: Admitted,
    fields: ParsedFields,
    res: Res,
    admission: Duration,
}

/// A request handed back or refused before dispatch: the live answer, and the
/// reason observe mode records.
struct Refused {
    out: Outgoing,
    reason: &'static str,
    /// The member (zid, pid) when admission accepted the request.
    member: Option<(i32, i32)>,
    /// The fields, when they parsed and the conversation was closed.
    fields: Option<ParsedFields>,
    admission: Option<Duration>,
}

impl Refused {
    #[cfg_attr(test, track_caller)]
    fn handback(reason: &'static str) -> Box<Self> {
        Box::new(Self {
            out: route::bad_gateway(),
            reason,
            member: None,
            fields: None,
            admission: None,
        })
    }
}

/// Everything before dispatch, for live and observe alike: the request
/// shape, the token, the admin refusal, admission under its deadline, the
/// fields, the tid range and the closed conversation.
async fn prepare(
    app: &App,
    writer: Admission<'_>,
    req: &Request,
    res: Res,
) -> Result<Prepared, Box<Refused>> {
    let (cid, raw) = request_reasoned(req).map_err(Refused::handback)?;
    let auth = req.headers.get("authorization");
    let Some(identity) = auth.and_then(|auth| {
        writer
            .verifier
            .verify(auth, &cid, (crate::clock::now_ms() / 1000.0) as u64)
    }) else {
        return Err(Refused::handback(if auth.is_none() {
            "no_token"
        } else {
            "token_refused"
        }));
    };
    if writer.admins.contains(&identity.uid().0) {
        return Err(Refused::handback("admin"));
    }
    let env = app.math_env.clone();
    let started = tokio::time::Instant::now();
    let admission = tokio::time::timeout(ADMISSION_DEADLINE, async {
        let cache = writer.priorities.clone();
        let follow_on = writer.follow_on.clone();
        let prepared = writer
            .reads
            .with(move |c| admit(c, &cid, &identity, &env, cache, follow_on))
            .await
            .map_err(|_| "admission_unavailable")?;
        let (mut admitted, snapshot) = prepared?;
        // Parsing, coalescing and shape validation hold no admission SQL
        // slot. A timed-out first caller can leave the generation warming,
        // but cannot retain a connection or dispatch a vote afterwards.
        admitted._priority_lease = Some(
            match tokio::task::spawn_blocking(move || snapshot.validate()).await {
                Ok(Ok(weights)) => weights,
                Ok(Err(error)) if error.is::<writer_priorities::CacheBusy>() => {
                    return Err("priorities_busy");
                }
                Ok(Err(_)) => return Err("priorities_invalid"),
                Err(_) => return Err("admission_unavailable"),
            },
        );
        Ok::<_, &'static str>(admitted)
    })
    .await;
    let admission_time = started.elapsed();
    let admitted = match admission {
        Ok(Ok(admitted)) => admitted,
        Ok(Err(reason)) => {
            let mut refused = Refused::handback(reason);
            refused.admission = Some(admission_time);
            return Err(refused);
        }
        Err(_) => {
            let mut refused = Refused::handback("admission_timeout");
            refused.admission = Some(admission_time);
            return Err(refused);
        }
    };
    let member = Some((admitted.zid, admitted.pid));
    let refused = |out, reason| {
        Box::new(Refused {
            out,
            reason,
            member,
            fields: None,
            admission: Some(admission_time),
        })
    };
    let fields = match raw.parse_fields() {
        Ok(fields) => fields,
        Err(_) => return Err(refused(route::parameter_error(app, req, res), "parameter")),
    };
    if !(i32::MIN as f64..=i32::MAX as f64).contains(&fields.tid) {
        return Err(refused(route::bad_gateway(), "tid_range"));
    }
    if !admitted.active {
        let mut closed = refused(
            route::fail_json(
                req,
                res,
                403,
                Js::Str("polis_err_conversation_is_closed".into()),
            ),
            "closed",
        );
        closed.fields = Some(fields);
        return Err(closed);
    }
    Ok(Prepared {
        admitted,
        fields,
        res,
        admission: admission_time,
    })
}

pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    // A process holds one mode. Observe is checked first, so a copy can never
    // reach the live writer's dispatch.
    if let Some(observer) = &app.post_votes_observe {
        return observe::handle(app, observer, req, res).await;
    }
    let Some(writer) = &app.post_votes else {
        return route::bad_gateway();
    };
    let Prepared {
        admitted,
        fields,
        res,
        admission: _,
    } = match prepare(app, writer.admission(), req, res).await {
        Ok(prepared) => prepared,
        Err(refused) => return refused.out,
    };
    // Publish a receipt immediately after SQL acknowledges the vote transaction commit. A
    // disconnected caller cannot cancel the task. A deadline without a receipt
    // is explicitly unknown (202), never a failure that nginx may replay.
    let receipt = Arc::new(Mutex::new(None));
    let fallback_pid = admitted.pid;
    let fallback_star = fields.starred.is_some();
    let active_dispatch = ActiveDispatch::new();
    #[cfg(all(test, feature = "db-tests"))]
    if let Some(observation) = &active_dispatch.observation {
        observation.lock().unwrap().receipt = Some(receipt.clone());
    }
    let reply_deadline = tokio::time::Instant::now() + DISPATCH_DEADLINE;
    let task = tokio::spawn(dispatch(
        writer.pool.clone(),
        writer.reads.clone(),
        writer.background.clone(),
        admitted,
        fields,
        app.math_env.clone(),
        next_comment::draw(req),
        receipt.clone(),
        reply_deadline,
        active_dispatch,
    ));
    match tokio::time::timeout_at(reply_deadline, task).await {
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
    reply_deadline: tokio::time::Instant,
    _active_dispatch: ActiveDispatch,
) -> Result<Outcome> {
    let a = admitted.clone();
    let f = fields.clone();
    let alarm_after = DISPATCH_ACQUIRE_ALARM;
    #[cfg(all(test, feature = "db-tests"))]
    let observation = _active_dispatch.observation.clone();
    #[cfg(all(test, feature = "db-tests"))]
    let alarm_after = observation
        .as_ref()
        .and_then(|o| o.lock().unwrap().acquire_alarm_after)
        .unwrap_or(alarm_after);
    let (zid, tid) = (admitted.zid, fields.tid);
    let created = pool
        .with_acquire_alarm(alarm_after, move || {
            ACQUIRE_ALARM_HITS.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "{{\"event\":\"post_votes_writer_acquire_alarm\",\"alarmMs\":{},\"zid\":{zid},\"tid\":{tid}}}",
                alarm_after.as_millis()
            );
            #[cfg(all(test, feature = "db-tests"))]
            if let Some(observation) = observation {
                observation.lock().unwrap().acquire_alarms += 1;
            }
        }, move |c| {
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
        .await
        .inspect_err(|error| {
            if let Some(timeout) = error.downcast_ref::<db::DispatchedAcquireTimeout>() {
                eprintln!(
                    "{{\"event\":\"post_votes_writer_acquire_cutoff\",\"zid\":{zid},\"tid\":{tid},\"wait_ms\":{}}}",
                    timeout.waited.as_millis()
                );
            }
        })?;
    let created = match created {
        Ok(created) => created,
        Err(outcome) => return Ok(outcome),
    };
    *receipt.lock().unwrap_or_else(|e| e.into_inner()) = Some(created.clone());
    let notified = schedule_notification(background.clone(), admitted.clone());
    #[cfg(all(test, feature = "db-tests"))]
    if let Some(observation) = &_active_dispatch.observation {
        observation.lock().unwrap().notification_scheduled = notified;
    }
    let mut body = degraded(admitted.pid, created.clone(), fields.starred.is_some());
    if !notified {
        body.follow_on.notifications = NotificationState::Degraded;
    }
    let lang = fields.lang.clone();
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
    // Waiting is post-receipt: it owns no database connection and can outlive
    // the unchanged HTTP deadline. At most one follow-on enters the reads
    // pool, leaving the other existing slot for admission.
    let Ok(permits) = admitted.follow_on.acquire_until(reply_deadline).await else {
        return Ok(Outcome::Success(body));
    };
    #[cfg(all(test, feature = "db-tests"))]
    let selection_observation = _active_dispatch.observation.clone();
    let selection_started = tokio::time::Instant::now();
    if let Ok(completed) = reads
        .with_acquire_alarm(
            DISPATCH_ACQUIRE_ALARM,
            || eprintln!("{{\"event\":\"post_votes_follow_on_acquire_alarm\"}}"),
            move |c| {
                // Keep both capacity limits until the blocking work ends,
                // including when its awaiting future has been dropped.
                let _permits = permits;
                if !a.follow_on.can_finish(reply_deadline) {
                    // Too little time remains for a full selection, or the
                    // reply has already gone. Keep exhaustion analytics without
                    // spending the lane on a row unlikely to reach the caller.
                    Ok((None, exhausted(c, &a)?))
                } else {
                    #[cfg(all(test, feature = "db-tests"))]
                    if let Some(observation) = selection_observation {
                        observation.lock().unwrap().selection_started = true;
                    }
                    let completed = complete(c, &a, &env, unit, lang.as_deref());
                    // Include acquiring the reads connection and blocking-task
                    // scheduling, not just SQL, in the next duration estimate.
                    a.follow_on.record_selection(selection_started.elapsed());
                    let completed = completed?;
                    let exhausted = completed.next_comment.is_none();
                    Ok((Some(completed), exhausted))
                }
            },
        )
        .await
    {
        let (completed, exhausted) = completed;
        if let Some(completed) = completed {
            body.next_comment = completed.next_comment;
            body.follow_on.next_comment = if body.next_comment.is_some() {
                FollowOnState::Complete
            } else {
                FollowOnState::Absent
            };
        }
        if exhausted
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

// Bound retained post-receipt work independently of vote admission. Overflow
// or wait expiry degrades only this optional work, never the durable receipt.
// The reads pool separately bounds dispatched acquisition at five seconds;
// neither wait holds a connection. SQL and HTTP deadlines stay unchanged.
const FOLLOW_ON_MAX_PENDING: usize = 64;
const FOLLOW_ON_WAIT: Duration = Duration::from_secs(30);
#[derive(Debug)]
struct FollowOnLane {
    pending: Arc<tokio::sync::Semaphore>,
    running: Arc<tokio::sync::Semaphore>,
    waiting: Mutex<std::collections::BTreeSet<(tokio::time::Instant, u64)>>,
    selection: Mutex<Option<(tokio::time::Instant, Duration)>>,
    sequence: AtomicU64,
    changed: tokio::sync::Notify,
}
impl Default for FollowOnLane {
    fn default() -> Self {
        Self {
            pending: Arc::new(tokio::sync::Semaphore::new(FOLLOW_ON_MAX_PENDING)),
            running: Arc::new(tokio::sync::Semaphore::new(1)),
            waiting: Mutex::default(),
            selection: Mutex::default(),
            sequence: AtomicU64::new(0),
            changed: tokio::sync::Notify::new(),
        }
    }
}
// Cancellation, wait expiry and blocking completion all release capacity and
// wake waiting tasks. The queue lock is held only to choose/remove an entry,
// never while waiting, querying PostgreSQL or selecting a comment.
#[derive(Debug)]
struct FollowOnSlot {
    lane: Arc<FollowOnLane>,
    key: (tokio::time::Instant, u64),
    _pending: tokio::sync::OwnedSemaphorePermit,
    running: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for FollowOnSlot {
    fn drop(&mut self) {
        self.lane
            .waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
        drop(self.running.take());
        self.lane.changed.notify_waiters();
    }
}
impl FollowOnLane {
    fn can_finish(&self, deadline: tokio::time::Instant) -> bool {
        let now = tokio::time::Instant::now();
        let selection = self.selection.lock().unwrap_or_else(|e| e.into_inner());
        // A short-lived estimate recovers after a host pause or a change of
        // conversation size. Without a recent sample, attempt live work.
        let estimate = selection
            .filter(|(at, _)| now.duration_since(*at) < DISPATCH_DEADLINE)
            .map_or(Duration::ZERO, |(_, duration)| duration);
        deadline.saturating_duration_since(now) > estimate
    }

    fn record_selection(&self, elapsed: Duration) {
        let now = tokio::time::Instant::now();
        let mut selection = self.selection.lock().unwrap_or_else(|e| e.into_inner());
        // A recent selection plus 25% headroom reserves time for returning the
        // result. This is a prediction, never an extension of the reply budget.
        *selection = Some((now, elapsed.saturating_add(elapsed / 4)));
    }

    #[cfg(all(test, feature = "db-tests"))]
    async fn acquire(self: &Arc<Self>) -> Result<FollowOnSlot> {
        self.acquire_until(tokio::time::Instant::now() + DISPATCH_DEADLINE)
            .await
    }

    async fn acquire_until(
        self: &Arc<Self>,
        deadline: tokio::time::Instant,
    ) -> Result<FollowOnSlot> {
        let pending = self
            .pending
            .clone()
            .try_acquire_owned()
            .context("follow-on queue full")?;
        let key = (deadline, self.sequence.fetch_add(1, Ordering::Relaxed));
        let mut slot = FollowOnSlot {
            lane: self.clone(),
            key,
            _pending: pending,
            running: None,
        };
        self.waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key);
        tokio::time::timeout(FOLLOW_ON_WAIT, async {
            loop {
                // Register before testing the queue so a completion cannot be
                // missed between checking capacity and waiting for it.
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
                    // Earliest reply deadline first. Entries with insufficient
                    // time run only the exhaustion check in the blocking task;
                    // they cannot consume a full selection ahead of live work.
                    if waiting.first().copied() == Some(key)
                        && let Ok(running) = self.running.clone().try_acquire_owned()
                    {
                        waiting.remove(&key);
                        slot.running = Some(running);
                        return;
                    }
                }
                // Deadline order never changes as time passes. Removal and
                // completion notify all waiters; no expiry timer is needed.
                notified.await;
            }
        })
        .await
        .context("follow-on wait expired")?;
        Ok(slot)
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
struct ActiveDispatch {
    #[cfg(all(test, feature = "db-tests"))]
    observation: Option<tests::DispatchObservation>,
}
impl ActiveDispatch {
    fn new() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        Self {
            #[cfg(all(test, feature = "db-tests"))]
            observation: tests::current_dispatch_observation(),
        }
    }
}
impl Drop for ActiveDispatch {
    fn drop(&mut self) {
        #[cfg(all(test, feature = "db-tests"))]
        if let Some(observation) = &self.observation {
            observation.lock().unwrap().finished = true;
        }
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
static SERVED: AtomicU64 = AtomicU64::new(0);
static HANDED_BACK: AtomicU64 = AtomicU64::new(0);
static DEGRADED: AtomicU64 = AtomicU64::new(0);
static UNKNOWN: AtomicU64 = AtomicU64::new(0);
static ACQUIRE_ALARM_HITS: AtomicU64 = AtomicU64::new(0);

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
    // Enabled means serving participants: the live writer only.
    body.set("enabled", Js::Bool(app.post_votes.is_some()));
    body.set(
        "mode",
        Js::Str(
            if app.post_votes.is_some() {
                "live"
            } else if app.post_votes_observe.is_some() {
                "observe"
            } else {
                "off"
            }
            .into(),
        ),
    );
    for (key, value) in [
        ("served", &SERVED),
        ("handedBack", &HANDED_BACK),
        ("durableAcceptedWithDegradedFollowOn", &DEGRADED),
        ("unknown", &UNKNOWN),
        ("writerAcquireAlarmHits", &ACQUIRE_ALARM_HITS),
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

/// Why the route prelude answered a vote without reaching `handle`, in the
/// prelude's own order (`route::serve`): the revocation snapshot, the
/// writer's eligibility, the HTTPS rule and the body checks. The prelude
/// refuses no request for its origin, so there is no origin reason. Pure: no
/// database work. Observe mode records it when the record has no reason.
pub(crate) fn shape_reason(app: &App, req: &Request) -> Option<&'static str> {
    if let Some(raw) = req.headers.get("authorization")
        && crate::revocation::refusal(app, raw, (crate::clock::now_ms() / 1000.0) as u64).is_some()
    {
        return Some("revoked");
    }
    if app.post_votes.is_none() && app.post_votes_observe.is_none() {
        return Some("unconfigured");
    }
    if !app.production {
        return Some("not_production");
    }
    if let Err(reason) = request_reasoned(req) {
        return Some(reason);
    }
    if !(app.dev_mode
        || app.use_network_host
        || req.headers.get("x-forwarded-proto") == Some("https"))
    {
        return Some("not_https");
    }
    let has_body = req.headers.get("transfer-encoding").is_some()
        || req
            .headers
            .get("content-length")
            .is_some_and(|v| !js::string_to_number(v).is_nan());
    if has_body
        && !crate::params::body_is_modelled(
            req.headers.get("content-type"),
            req.headers.get("content-encoding"),
        )
    {
        return Some("body_unmodelled");
    }
    if matches!(
        crate::params::parse_body(req.headers.get("content-type"), has_body, &req.body),
        crate::params::Body::Invalid
    ) {
        return Some("parameter");
    }
    None
}

/// What a copy says about itself without any database work: whether it
/// carries a star and a language. Never the statement, the vote, the token or
/// the conversation code.
pub(crate) fn copy_facts(req: &Request) -> (bool, bool) {
    let Ok((_, raw)) = request_reasoned(req) else {
        return (false, false);
    };
    let present = |v: &Option<serde_json::Value>| v.as_ref().is_some_and(|v| !v.is_null());
    (present(&raw.starred), present(&raw.lang))
}

/// A future gateway can distinguish explicit pre-dispatch hand-back from its
/// own transport 502. Never emit this marker after dispatch begins.
pub(crate) fn mark_handback(out: &mut Outgoing) {
    out.headers
        .push(("X-Polis-Vote-Dispatch".into(), "not-started".into()));
}
