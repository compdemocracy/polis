//! Latest/history reads. Unsupported identities, ambiguity and resource pressure
//! hand back before any response; the two read-only pools never use writer slots.
use crate::{
    http::{Outgoing, Request},
    js::{Js, Obj},
    route::{self, App, Res},
    shadow::reads,
};
// Legacy participant lookup sentinel used by resolve_pidThing.
const SELF_PID: i32 = -1;

#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/votes_read.rs"]
mod contract;
pub use contract::{ME_PATH, PATH};
pub fn matches(path: &str) -> bool {
    path == PATH || path == ME_PATH
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    parse_reasoned(app, req).ok()
}

/// `parse`, with the reason a request is handed back: one word of a closed
/// set, never a key or a value of the request. The checks and their results
/// are the same; a copy's observation records the reason.
pub(crate) fn parse_reasoned(app: &App, req: &Request) -> Result<contract::Request, &'static str> {
    if app.votes_read_db.is_none() {
        return Err("unconfigured");
    }
    if !matches(req.path()) {
        return Err("shape_path");
    }
    if !matches!(req.method.as_str(), "GET" | "HEAD") {
        return Err("shape_method");
    }
    if !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
    {
        return Err("shape_body");
    }
    if req.headers.get("cookie").is_some() {
        return Err("cookie");
    }
    let mine = req.path() == ME_PATH;
    if mine && req.headers.get("authorization").is_none() {
        return Err("me_no_token");
    }
    let raw = req.query().ok_or("no_query")?;
    if raw.len() > 4096 {
        return Err("query_size");
    }
    let (mut cid, mut pid, mut tid) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        match k.as_ref() {
            "conversation_id" if cid.is_none() => cid = Some(v.into_owned()),
            "pid" if !mine && pid.is_none() => {
                let n = v.parse::<i32>().map_err(|_| "param_pid")?;
                if n.to_string() != v {
                    return Err("param_pid");
                }
                pid = Some(n);
            }
            "tid" if !mine && tid.is_none() => {
                let n = v.parse::<i32>().map_err(|_| "param_tid")?;
                if n.to_string() != v {
                    return Err("param_tid");
                }
                tid = Some(n);
            }
            // A key sent twice, an external id, or a key this route does not
            // model. The key itself is never the reason.
            "conversation_id" => return Err("query_repeated"),
            "pid" | "tid" if !mine => return Err("query_repeated"),
            "xid" => return Err("xid"),
            _ => return Err("query_key"),
        }
    }
    let cid = cid.ok_or("no_conversation_id")?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("shape_conversation_id");
    }
    Ok(contract::Request {
        conversation_id: cid,
        pid,
        tid,
        mine,
    })
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
/// The total deadline of one read.
const DEADLINE: std::time::Duration = std::time::Duration::from_millis(75);

/// Why a request that parsed is handed back.
enum Handback {
    Reason(&'static str),
    /// The participant has more than one row. No order is promised by either
    /// Node query, so the live handler hands these back.
    ManyRows {
        zid: i32,
        pid: i32,
    },
}
impl From<&'static str> for Handback {
    fn from(reason: &'static str) -> Self {
        Self::Reason(reason)
    }
}

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let query = match parse_reasoned(app, req) {
        Ok(query) => query,
        Err(reason) => return reads::handback(reason),
    };
    let (Some(pool), Some(auth_pool)) = (&app.votes_read_db, &app.votes_read_auth_db) else {
        return reads::handback("unconfigured");
    };
    // Kept only for a copy the shadow is observing (`observe_many`).
    let asked = reads::observing().then(|| query.clone());
    let result = tokio::time::timeout(DEADLINE, async {
        let identity = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await
        .ok_or_else(|| {
            reads::credential_reason(|| {
                crate::hybrid_read::handoff_class(
                    req.headers.get("authorization"),
                    app.participant_verifier.is_some(),
                    app.read_oidc.is_some(),
                    Some(&query.conversation_id),
                )
            })
        })?;
        let verified = req.headers.get("authorization").and_then(|raw| {
            app.participant_verifier.as_deref()?.verify_unobserved(
                raw,
                &query.conversation_id,
                (crate::clock::now_ms() / 1000.0) as u64,
            )
        });
        let cid = query.conversation_id.clone();
        let (zid, member_pid) = pool
            .with(move |c| {
                let Some(zid) = crate::db::zid_for_conversation_id(c, &cid)? else {
                    return Ok(Err("unknown_conversation"));
                };
                if zid <= 0 {
                    return Ok(Err("unknown_conversation"));
                }
                let pid = if let Some(ref v) = verified {
                    let Some(pid) = polis_auth::participant::resolve(c, polis_auth::Zid(zid), v)?
                    else {
                        return Ok(Err("not_a_participant"));
                    };
                    Some(pid.0 as i32)
                } else {
                    None
                };
                Ok(Ok((zid, pid)))
            })
            .await
            .map_err(|e| reads::database_reason(&e))??;
        reads::record(|record| record.zid = Some(zid));
        let pid = if query.mine {
            // Node checks getPid(uid), but still queries req.p.pid. Existing
            // OIDC membership therefore produces [], not that member's history.
            let uid = identity.uid().ok_or("me_no_user")?;
            let found = pool
                .with(move |c| {
                    Ok(c.query(
                        "SELECT pid FROM participants WHERE zid=$1 AND uid=$2 LIMIT 2",
                        &[&zid, &uid.0],
                    )?)
                })
                .await
                .map_err(|e| reads::database_reason(&e))?;
            if found.len() != 1 {
                return Err("me_membership".into());
            }
            if found[0].try_get::<_, i32>(0).map_err(|_| "database")? < 0 {
                return Err("me_membership".into());
            }
            member_pid
        } else if member_pid.is_some_and(|p| p > 0) {
            member_pid
        } else if query.pid == Some(SELF_PID) {
            if let Some(uid) = identity.uid() {
                let rows = pool
                    .with(move |c| {
                        Ok(c.query(
                            "SELECT pid FROM participants WHERE zid=$1 AND uid=$2 LIMIT 2",
                            &[&zid, &uid.0],
                        )?)
                    })
                    .await
                    .map_err(|e| reads::database_reason(&e))?;
                if rows.len() > 1 {
                    return Err("ambiguous_membership".into());
                }
                match rows.first() {
                    Some(row) => {
                        let p = row.try_get::<_, i32>(0).map_err(|_| "database")?;
                        if p < 0 {
                            return Err("ambiguous_membership".into());
                        }
                        Some(p)
                    }
                    None => member_pid,
                }
            } else {
                member_pid
            }
        } else {
            query.pid.or(member_pid)
        };
        // No PID is an unconditional empty latest response; SQL pid=NULL is
        // likewise empty for the OIDC /me branch after getPid succeeded.
        let Some(pid) = pid else {
            return Ok(Js::Arr(vec![]));
        };
        match pool
            .with(move |c| {
                read_reasoned(c, zid, pid, query.tid, query.mine, &query.conversation_id)
            })
            .await
            .map_err(|e| reads::database_reason(&e))?
        {
            Ok(value) => Ok(value),
            Err(MANY_ROWS) => Err(Handback::ManyRows { zid, pid }),
            Err(reason) => Err(reason.into()),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => {
            if let Js::Arr(rows) = &value {
                reads::record(|record| record.rows = Some(reads::Rows::of(rows.len())));
            }
            route::json(req, res, &value)
        }
        Ok(Err(Handback::Reason(reason))) => reads::handback(reason),
        Ok(Err(Handback::ManyRows { zid, pid })) => {
            if let Some(asked) = asked {
                observe_many(pool, zid, pid, asked).await;
            }
            reads::handback(MANY_ROWS)
        }
        Err(_) => reads::handback("deadline"),
    }
}

/// Only for a copy the shadow is observing, after the live path has handed
/// it back for having more than one row: reads every row and builds and
/// serializes the answer Node gives, under the deadline a read has, then
/// drops it. The line says `rows: many` when that answer was built; nothing
/// of it, and no count or length, leaves this function. A live request never
/// reaches this.
async fn observe_many(
    pool: &std::sync::Arc<crate::db::Pool>,
    zid: i32,
    pid: i32,
    q: contract::Request,
) {
    let built = tokio::time::timeout(
        DEADLINE,
        pool.with(move |c| {
            let value = read_many(c, zid, pid, q.tid, q.mine, &q.conversation_id)?;
            Ok(value.map(|value| {
                std::hint::black_box(crate::js::stringify(&value));
            }))
        }),
    )
    .await;
    if matches!(built, Ok(Ok(Ok(())))) {
        reads::record(|record| record.rows = Some(reads::Rows::Many));
    }
}

const MANY_ROWS: &str = "many_rows";

/// No order is promised by either Node query. More than one row is therefore
/// handed back, as are noncanonical capability aliases and schema extensions
/// (a column added or missing). The order of the columns is not an extension:
/// the keys of the answer follow it, as Node's do.
/// A LIMIT bounds materialization without inventing a page or a sort order.
#[cfg(all(test, feature = "db-tests"))]
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    pid: i32,
    tid: Option<i32>,
    mine: bool,
    cid: &str,
) -> anyhow::Result<Option<Js>> {
    Ok(read_reasoned(c, zid, pid, tid, mine, cid)?.ok())
}

/// `read`, with the reason an answer is handed back.
fn read_reasoned(
    c: &mut postgres::Client,
    zid: i32,
    pid: i32,
    tid: Option<i32>,
    mine: bool,
    cid: &str,
) -> anyhow::Result<Result<Js, &'static str>> {
    let rows = if mine {
        c.query(
            "SELECT * FROM votes WHERE zid=$1 AND pid=$2 LIMIT 2",
            &[&zid, &pid],
        )?
    } else {
        c.query("SELECT * FROM votes_latest_unique WHERE zid=$1 AND pid=$2 AND ($3::integer IS NULL OR tid=$3) LIMIT 2",&[&zid,&pid,&tid])?
    };
    if rows.len() > 1 {
        return Ok(Err(MANY_ROWS));
    }
    if rows.is_empty() {
        return Ok(Ok(Js::Arr(vec![])));
    }
    if !canonical_code(c, zid, cid)? {
        return Ok(Err("conversation_code"));
    }
    let row = &rows[0];
    let Some(stored) = modelled_columns(row, mine) else {
        return Ok(Err("schema"));
    };
    Ok(project(row, &stored, mine, cid)?.map(|row| Js::Arr(vec![row])))
}

/// Every row of the participant, as Node answers them: the same rows, keys
/// and values as `read_reasoned` gives for one, in the order the database
/// returns them. Used only to observe a copy (`observe_many`).
fn read_many(
    c: &mut postgres::Client,
    zid: i32,
    pid: i32,
    tid: Option<i32>,
    mine: bool,
    cid: &str,
) -> anyhow::Result<Result<Js, &'static str>> {
    let rows = if mine {
        c.query("SELECT * FROM votes WHERE zid=$1 AND pid=$2", &[&zid, &pid])?
    } else {
        c.query(
            "SELECT * FROM votes_latest_unique WHERE zid=$1 AND pid=$2 AND ($3::integer IS NULL OR tid=$3)",
            &[&zid, &pid, &tid],
        )?
    };
    let Some(first) = rows.first() else {
        return Ok(Ok(Js::Arr(vec![])));
    };
    if !canonical_code(c, zid, cid)? {
        return Ok(Err("conversation_code"));
    }
    let Some(stored) = modelled_columns(first, mine) else {
        return Ok(Err("schema"));
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        match project(row, &stored, mine, cid)? {
            Ok(row) => out.push(row),
            Err(reason) => return Ok(Err(reason)),
        }
    }
    Ok(Ok(Js::Arr(out)))
}

/// Whether `cid` is the conversation's one code: a noncanonical alias is
/// handed back.
fn canonical_code(c: &mut postgres::Client, zid: i32, cid: &str) -> anyhow::Result<bool> {
    let codes = c.query("SELECT zinvite FROM zinvites WHERE zid=$1 LIMIT 2", &[&zid])?;
    Ok(codes.len() == 1 && codes[0].try_get::<_, String>(0)? == cid)
}

/// The row's columns in their stored order, when their set is exactly the
/// one modelled.
// Node answers with its `SELECT *` rows: the keys are the table's columns
// in their stored order, without `zid`, followed by the keys Node adds. A
// database built from the migrations and an installation older than them
// store the columns of `votes` in different orders, and Node's bytes
// differ accordingly, so the keys here follow the stored order too. The
// set of columns must still be exactly the one modelled.
fn modelled_columns(row: &postgres::Row, mine: bool) -> Option<Vec<&str>> {
    let time = if mine { "created" } else { "modified" };
    let mut expected = vec!["zid", "pid", "tid", "vote", "weight_x_32767", time];
    if mine {
        expected.push("high_priority");
    }
    expected.sort_unstable();
    let stored: Vec<&str> = row.columns().iter().map(|c| c.name()).collect();
    let mut sorted = stored.clone();
    sorted.sort_unstable();
    (sorted == expected).then_some(stored)
}

/// One row as Node answers it.
fn project(
    row: &postgres::Row,
    stored: &[&str],
    mine: bool,
    cid: &str,
) -> anyhow::Result<Result<Js, &'static str>> {
    let mut out = Obj::new();
    for name in stored.iter().copied() {
        let value = match name {
            // Node removes it before it answers.
            "zid" => continue,
            "pid" | "tid" => Js::Num(f64::from(row.try_get::<_, i32>(name)?)),
            "vote" => {
                let raw = row.try_get::<_, Option<i16>>(name)?;
                let wire = crate::votes::StorageConvention::CURRENT.wire_preserving_invalid(raw);
                wire.map(|v| Js::Num(f64::from(v))).unwrap_or(Js::Null)
            }
            "weight_x_32767" => row
                .try_get::<_, Option<i16>>(name)?
                .map(|v| Js::Num(f64::from(v)))
                .unwrap_or(Js::Null),
            "created" | "modified" => row
                .try_get::<_, Option<i64>>(name)?
                .map(|v| Js::Str(v.to_string()))
                .unwrap_or(Js::Null),
            "high_priority" => Js::Bool(row.try_get(name)?),
            _ => return Ok(Err("schema")),
        };
        out.set(name, value);
    }
    if mine {
        out.set("weight", Js::Null);
    }
    out.set("conversation_id", Js::Str(cid.into()));
    Ok(Ok(Js::Obj(out)))
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "votes_read_tests.rs"]
mod tests;

#[cfg(all(test, feature = "db-tests"))]
#[path = "votes_read_many_tests.rs"]
mod many_tests;
