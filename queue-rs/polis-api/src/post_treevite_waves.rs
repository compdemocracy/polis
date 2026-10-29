//! Atomic administrative minting, on dedicated primary connections. No
//! participant allocator lock, participation pool, crypto or network calls.
#[path = "../../polis-contracts/src/post_treevite_waves.rs"]
mod contract;
use crate::{
    config, db,
    http::{Outgoing, Request},
    js::Js,
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use contract::{ErrorCode, Request as Fields, Response};
use postgres::{Client, Transaction};
use rand::RngExt;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub const PATH: &str = contract::PATH;
pub(crate) const MAX_BODY_BYTES: usize = 65536;
const DEADLINE: Duration = Duration::from_secs(10);
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
#[derive(Clone, Copy)]
struct Caps {
    conversation: i64,
    owner: i64,
}
pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    auth: Arc<db::Pool>,
    caps: Caps,
}
impl Writer {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        if std::env::var("POLIS_API_POST_TREEVITE_WAVES")
            .ok()
            .as_deref()
            != Some("1")
        {
            return Ok(None);
        }
        let cap = |name, default| -> Result<i64> {
            let n = match std::env::var(name) {
                Ok(v) => v.parse().context("invalid Treevite sanity stop")?,
                Err(std::env::VarError::NotPresent) => default,
                Err(e) => return Err(e.into()),
            };
            anyhow::ensure!(n > 0, "Treevite sanity stops must be positive");
            Ok(n)
        };
        let dsn = std::env::var("POLIS_API_POST_TREEVITE_WAVES_DATABASE_URL")
            .context("wave writer requires explicit primary database")?;
        Ok(Some(Self {
            pool: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-treevite-mint/1")?,
                limits(),
            ),
            auth: db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-treevite-mint-auth/1")?,
                db::Limits {
                    size: 2,
                    acquire_timeout: Duration::from_millis(100),
                    statement_timeout: Duration::from_millis(100),
                    max_lifetime: Duration::from_secs(300),
                },
            ),
            caps: Caps {
                conversation: cap(
                    contract::CONVERSATION_CAP_ENV,
                    contract::DEFAULT_CONVERSATION_CAP,
                )?,
                owner: cap(contract::OWNER_CAP_ENV, contract::DEFAULT_OWNER_CAP)?,
            },
        }))
    }
}
fn limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(500),
        max_lifetime: Duration::from_secs(300),
    }
}
fn raw(req: &Request) -> Option<serde_json::Map<String, serde_json::Value>> {
    if req.method != "POST"
        || req.query().is_some_and(|s| !s.is_empty())
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
    let v: serde_json::Value = serde_json::from_slice(&req.body).ok()?;
    let obj = v.as_object()?;
    if obj.keys().any(|k| {
        !matches!(
            k.as_str(),
            "conversation_id" | "invites_per_user" | "owner_invites" | "parent_wave"
        )
    }) {
        return None;
    }
    Some(obj.clone())
}
pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    app.post_treevite_waves.is_some() && app.production && raw(req).is_some()
}
fn integer(v: &serde_json::Value) -> Option<f64> {
    if let Some(s) = v.as_str() {
        let s = s.trim_start_matches(crate::js::is_js_whitespace);
        let n = s
            .strip_prefix(['+', '-'])
            .unwrap_or(s)
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if n == 0 {
            return None;
        }
        s[..n + usize::from(s.starts_with(['+', '-']))].parse().ok()
    } else {
        v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
    }
}
fn fields(obj: &serde_json::Map<String, serde_json::Value>, cid: String) -> Option<Fields> {
    let get = |key| match obj.get(key) {
        None | Some(serde_json::Value::Null) => Some(None),
        Some(v) => integer(v).map(Some),
    };
    Some(Fields {
        conversation_id: cid,
        invites_per_user: get("invites_per_user")?.unwrap_or(0.0),
        owner_invites: get("owner_invites")?.unwrap_or(0.0),
        parent_wave: get("parent_wave")?,
    })
}
pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let (Some(writer), Some(obj)) = (&app.post_treevite_waves, raw(req)) else {
        return route::bad_gateway();
    };
    let Some(auth) = req.headers.get("authorization") else {
        return route::json_text(
            req,
            res,
            401,
            r#"{"error":"No authentication token found"}"#.into(),
        );
    };
    if polis_auth::observability::credential_hints(auth).is_none() {
        return route::json_text(req, res, 401, r#"{"error":"Invalid token format","details":"Token does not match any supported JWT type"}"#.into());
    }
    // Resolve only already-provisioned identities. Unsupported auth hands back
    // before dispatch. Authority is checked again inside the write transaction.
    let cid = obj
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .filter(|s| {
            !s.is_empty() && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    let payload = polis_auth::observability::credential_hints(auth);
    let uid = if payload.as_ref().is_some_and(|p| {
        p.get("anonymous_participant").is_some() || p.get("standard_user_participant").is_some()
    }) {
        let scope = cid.or_else(|| payload.as_ref()?.get("conversation_id")?.as_str());
        let Some(identity) = scope.and_then(|scope| {
            app.participant_verifier.as_deref()?.verify(
                auth,
                scope,
                (crate::clock::now_ms() / 1000.0) as u64,
            )
        }) else {
            return route::bad_gateway();
        };
        // Administrative authority is UID-based. The read-side participant
        // resolver deliberately excludes Treevite conversations; importing that
        // admission gate here would bypass the required owner/moderator refusal.
        identity.uid()
    } else {
        let identity = tokio::time::timeout(
            Duration::from_millis(250),
            crate::hybrid_read::resolve_scoped(
                Some(auth),
                app.participant_verifier.as_deref(),
                app.read_oidc.as_deref(),
                &writer.auth,
                cid,
            ),
        )
        .await;
        let Ok(Some(identity)) = identity else {
            return route::bad_gateway();
        };
        let Some(uid) = identity.uid() else {
            return route::bad_gateway();
        };
        uid
    };
    let Some(cid) = cid else {
        if !obj.contains_key("conversation_id") {
            return route::parameter_error(app, req, res);
        }
        return route::bad_gateway();
    };
    let Some(fields) = fields(&obj, cid.to_owned()) else {
        return route::parameter_error(app, req, res);
    };
    let cid = cid.to_owned();
    let zid = writer
        .auth
        .with(move |c| db::zid_for_conversation_id(c, &cid))
        .await;
    let Ok(Some(zid)) = zid else {
        return route::bad_gateway();
    };
    let pool = writer.pool.clone();
    let caps = writer.caps;
    let admins = app.legacy_admin_uids.clone();
    // Once dispatched, no error can replay the request through Node. Dropping
    // the HTTP future does not drop the task or free its pool slot early.
    let task = tokio::spawn(async move {
        pool.with(move |c| create(c, zid, uid.0, &admins, &fields, caps, DEADLINE))
            .await
    });
    match tokio::time::timeout(DEADLINE + Duration::from_secs(2), task).await {
        Ok(Ok(Ok(Ok(body)))) => match serde_json::to_string(&body) {
            Ok(text) => route::json_text(req, res, 201, text),
            Err(_) => failure(req, res, ErrorCode::OutcomeUnknown),
        },
        Ok(Ok(Ok(Err(code)))) => failure(req, res, code),
        Ok(Ok(Err(_))) => failure(req, res, ErrorCode::CreateWave),
        _ => failure(req, res, ErrorCode::OutcomeUnknown),
    }
}
fn failure(req: &Request, res: Res, code: ErrorCode) -> Outgoing {
    route::fail_json(req, res, code.status(), Js::Str(code.as_str().into()))
}

/// An owner lock protects the aggregate across conversations; the conversation
/// lock protects MAX(wave) and parent resolution. Neither key is used by votes,
/// comments, next-statement reads, or the participant allocator.
fn create(
    c: &mut Client,
    zid: i32,
    uid: i32,
    admins: &[i32],
    f: &Fields,
    caps: Caps,
    duration: Duration,
) -> Result<Result<Response, ErrorCode>> {
    let end = Instant::now() + duration;
    let mut tx = c
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::ReadCommitted)
        .start()?;
    let allowed = admins.contains(&uid)
        || match tx.query_one(polis_auth::MODERATOR_SQL, &[&zid, &uid]) {
            Ok(row) => row.try_get::<_, i64>(0)? > 0,
            Err(_) => return Ok(Err(ErrorCode::AuthCheck)),
        };
    if !allowed {
        return Ok(Err(ErrorCode::NotOwner));
    }
    if f.invites_per_user <= 0.0 && f.owner_invites <= 0.0 {
        return Ok(Err(ErrorCode::RequiresInvites));
    }
    let owner: i32 = tx
        .query_one("select owner from conversations where zid=$1", &[&zid])?
        .try_get(0)?;
    tx.query_one("select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:owner-codes', $1::int)::text,0))", &[&owner])?;
    tx.query_one("select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:waves', $1::int)::text,0))", &[&zid])?;
    let max: i32 = tx
        .query_one(
            "select coalesce(max(wave),0) from treevite_waves where zid=$1",
            &[&zid],
        )?
        .try_get(0)?;
    let wave = max.checked_add(1).context("wave number overflow")?;
    let Some(parent) = storage_integer(f.parent_wave.unwrap_or(f64::from(max))) else {
        return Ok(Err(ErrorCode::CreateWave));
    };
    let mut parent_size = 1;
    let mut members = Vec::new();
    if parent > 0 {
        let Some(row) = tx.query_opt(
            "select id,size from treevite_waves where zid=$1 and wave=$2",
            &[&zid, &parent],
        )?
        else {
            return Ok(Err(ErrorCode::ParentNotFound));
        };
        parent_size = row.try_get::<_, Option<i32>>(1)?.unwrap_or(0).max(1);
        if f.invites_per_user > 0.0 {
            let id: i64 = row.try_get(0)?;
            // Match Node's encounter order, including repeated members. The
            // count-then-fill helper prevents repeated allowance issuance.
            members = tx.query("select id,invite_used_by_pid from treevite_invites where wave_id=$1 and invite_used_by_pid is not null", &[&id])?;
        }
    }
    // Node validates authority and the parent before PostgreSQL narrows counts.
    let (Some(per), Some(owner_invites)) = (
        storage_integer(f.invites_per_user),
        storage_integer(f.owner_invites),
    ) else {
        return Ok(Err(ErrorCode::CreateWave));
    };
    let size = i64::from(parent_size) * i64::from(per) + i64::from(owner_invites);
    if per < 0 || owner_invites < 0 || parent < 0 {
        return Ok(Err(ErrorCode::CreateWave));
    }
    // Response size is Node's cached-size calculation. Quotas instead reserve
    // actual codes plus every outstanding descendant obligation, even before
    // any parent invite is accepted. Never use cached size as a reservation.
    let rows = tx.query("select w.zid,w.wave,coalesce(w.parent_wave,0),w.invites_per_user,w.owner_invites,count(i.id) from treevite_waves w join conversations c on c.zid=w.zid left join treevite_invites i on i.wave_id=w.id where c.owner=$1 group by w.id order by w.zid,w.wave", &[&owner])?;
    let mut potential = std::collections::BTreeMap::new();
    let mut conversation = 0_u128;
    let mut owned = 0_u128;
    for row in rows {
        check_deadline(end)?;
        let wave_zid: i32 = row.try_get(0)?;
        let wave_number: i32 = row.try_get(1)?;
        let parent_number: i32 = row.try_get(2)?;
        let parent_capacity = if parent_number == 0 {
            1
        } else {
            *potential
                .get(&(wave_zid, parent_number))
                .context("invalid wave ancestry")?
        };
        let per: i32 = row.try_get(3)?;
        let owner_codes: i32 = row.try_get(4)?;
        let actual: i64 = row.try_get(5)?;
        let capacity = reservation(parent_capacity, per, owner_codes).max(actual as u128);
        potential.insert((wave_zid, wave_number), capacity);
        owned = owned.saturating_add(capacity);
        if wave_zid == zid {
            conversation = conversation.saturating_add(capacity);
        }
    }
    let parent_capacity = if parent == 0 {
        1
    } else {
        *potential
            .get(&(zid, parent))
            .context("missing parent reservation")?
    };
    let capacity = reservation(parent_capacity, per, owner_invites);
    if conversation.saturating_add(capacity) > caps.conversation as u128 {
        return Ok(Err(ErrorCode::ConversationCap));
    }
    if owned.saturating_add(capacity) > caps.owner as u128 {
        return Ok(Err(ErrorCode::OwnerCap));
    }
    if i32::try_from(size).is_err() {
        return Ok(Err(ErrorCode::CreateWave));
    }
    check_deadline(end)?;
    let row = tx.query_one("insert into treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size) values($1,$2,$3,$4,$5,$6) returning id,to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),to_char(updated_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')", &[&zid,&wave,&parent,&per,&owner_invites,&(size as i32)])?;
    let id: i64 = row.try_get(0)?;
    for _ in 0..owner_invites {
        insert(&mut tx, zid, id, None, None, end)?;
    }
    if parent == 0 {
        for _ in 0..per {
            insert(&mut tx, zid, id, None, None, end)?;
        }
    }
    for member in members {
        issue(
            &mut tx,
            zid,
            id,
            member.try_get(0)?,
            member.try_get(1)?,
            per,
            end,
        )?;
    }
    let repaired = reconcile(&mut tx, zid, id, end)?;
    let count: i32 = tx
        .query_one(
            "select count(*)::int from treevite_invites where wave_id=$1",
            &[&id],
        )?
        .try_get(0)?;
    let response = Response {
        id: id.to_string(),
        zid,
        wave,
        parent_wave: parent,
        size: size as i32,
        invites_per_user: per,
        owner_invites,
        created_at: row.try_get(1)?,
        updated_at: row.try_get(2)?,
        invites_created: count,
    };
    check_deadline(end)?;
    if tx.commit().is_err() {
        return Ok(Err(ErrorCode::OutcomeUnknown));
    }
    if repaired > 0 {
        eprintln!("{{\"event\":\"treevite_wave_allocations_repaired\",\"codes\":{repaired}}}");
    }
    Ok(Ok(response))
}
/// Select gaps before limiting, rather than revisiting an already-filled prefix.
/// Discovery is only a hint: issue rechecks all states under the same member lock
/// as acceptance. These obligations were already included in the cap reservation.
fn reconcile(tx: &mut Transaction<'_>, zid: i32, new_wave: i64, end: Instant) -> Result<i64> {
    check_deadline(end)?;
    let rows = tx.query(
        "select child.id, parent_invite.id, parent_invite.invite_used_by_pid, child.invites_per_user
         from treevite_waves child
         join treevite_waves parent on parent.zid=child.zid and parent.wave=child.parent_wave
         join treevite_invites parent_invite on parent_invite.wave_id=parent.id
         where child.zid=$1 and child.id<>$2 and child.invites_per_user>0
           and parent_invite.status=1 and parent_invite.invite_used_by_pid is not null
           and (select count(*) from treevite_invites held
                where held.wave_id=child.id
                  and held.invite_owner_pid=parent_invite.invite_used_by_pid)<child.invites_per_user
         order by child.wave,parent_invite.id
         limit $3",
        &[&zid, &new_wave, &contract::RECONCILIATION_ROW_LIMIT],
    )?;
    let mut repaired = 0;
    for row in rows {
        repaired += issue(
            tx,
            zid,
            row.try_get(0)?,
            row.try_get(1)?,
            row.try_get(2)?,
            row.try_get(3)?,
            end,
        )?;
    }
    Ok(repaired)
}
// Saturation is above every configurable i64 cap, so overflow always refuses.
fn reservation(parent: u128, per: i32, owner: i32) -> u128 {
    parent
        .saturating_mul(per.max(0) as u128)
        .saturating_add(owner.max(0) as u128)
}
fn storage_integer(value: f64) -> Option<i32> {
    (value >= f64::from(i32::MIN) && value <= f64::from(i32::MAX)).then_some(value as i32)
}
fn check_deadline(end: Instant) -> Result<()> {
    anyhow::ensure!(Instant::now() < end, "wave transaction deadline");
    Ok(())
}
fn code() -> String {
    let mut rng = rand::rng();
    (0..10)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}
fn insert(
    tx: &mut Transaction<'_>,
    zid: i32,
    wave: i64,
    parent: Option<i64>,
    pid: Option<i32>,
    end: Instant,
) -> Result<()> {
    for _ in 0..5 {
        check_deadline(end)?;
        if tx.query_opt("insert into treevite_invites(zid,wave_id,parent_invite_id,invite_code,invite_owner_pid) values($1,$2,$3,$4,$5) on conflict(zid,invite_code) do nothing returning id", &[&zid,&wave,&parent,&code(),&pid])?.is_some() { return Ok(()); }
    }
    anyhow::bail!("invite code collision")
}
fn issue(
    tx: &mut Transaction<'_>,
    zid: i32,
    wave: i64,
    parent: i64,
    pid: i32,
    amount: i32,
    end: Instant,
) -> Result<i64> {
    check_deadline(end)?;
    tx.query_one("select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:per-user-codes', $1::bigint, $2::int)::text,0))", &[&wave,&pid])?;
    let n: i64 = tx
        .query_one(
            "select count(*) from treevite_invites where wave_id=$1 and invite_owner_pid=$2",
            &[&wave, &pid],
        )?
        .try_get(0)?;
    for _ in n..i64::from(amount) {
        insert(tx, zid, wave, Some(parent), Some(pid), end)?;
    }
    Ok((i64::from(amount) - n).max(0))
}
pub(crate) fn health(app: &App) -> Js {
    let mut obj = crate::js::Obj::new();
    obj.set("enabled", Js::Bool(app.post_treevite_waves.is_some()));
    if let Some(w) = &app.post_treevite_waves {
        obj.set("writerPoolLimit", Js::Num(limits().size as f64));
        obj.set(
            "writerAcquireTimeoutMs",
            Js::Num(limits().acquire_timeout.as_millis() as f64),
        );
        obj.set(
            "writerStatementTimeoutMs",
            Js::Num(limits().statement_timeout.as_millis() as f64),
        );
        obj.set("writerLockTimeoutMs", Js::Num(100.0));
        obj.set("authPoolLimit", Js::Num(2.0));
        obj.set("conversationCodeCap", Js::Num(w.caps.conversation as f64));
        obj.set("ownerCodeCap", Js::Num(w.caps.owner as f64));
        obj.set(
            "transactionDeadlineMs",
            Js::Num(DEADLINE.as_millis() as f64),
        );
    }
    Js::Obj(obj)
}

#[cfg(test)]
#[path = "post_treevite_waves_tests.rs"]
mod tests;
