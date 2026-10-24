//! Latest/history reads. Unsupported identities, ambiguity and resource pressure
//! hand back before any response; the two read-only pools never use writer slots.
use crate::{
    http::{Outgoing, Request},
    js::{Js, Obj},
    route::{self, App, Res},
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
    if app.votes_read_db.is_none()
        || !matches(req.path())
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let mine = req.path() == ME_PATH;
    if mine && req.headers.get("authorization").is_none() {
        return None;
    }
    let raw = req.query()?;
    if raw.len() > 4096 {
        return None;
    }
    let (mut cid, mut pid, mut tid) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        match k.as_ref() {
            "conversation_id" if cid.is_none() => cid = Some(v.into_owned()),
            "pid" if !mine && pid.is_none() => {
                let n = v.parse::<i32>().ok()?;
                if n.to_string() != v {
                    return None;
                }
                pid = Some(n);
            }
            "tid" if !mine && tid.is_none() => {
                let n = v.parse::<i32>().ok()?;
                if n.to_string() != v {
                    return None;
                }
                tid = Some(n);
            }
            _ => return None,
        }
    }
    let cid = cid?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(contract::Request {
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
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.votes_read_db, &app.votes_read_auth_db) else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let identity = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?;
        let verified = req.headers.get("authorization").and_then(|raw| {
            app.participant_verifier.as_deref()?.verify(
                raw,
                &query.conversation_id,
                (crate::clock::now_ms() / 1000.0) as u64,
            )
        });
        let cid = query.conversation_id.clone();
        let (zid, member_pid) = pool
            .with(move |c| {
                let Some(zid) = crate::db::zid_for_conversation_id(c, &cid)? else {
                    return Ok(None);
                };
                if zid <= 0 {
                    return Ok(None);
                }
                let pid = if let Some(ref v) = verified {
                    let Some(pid) = polis_auth::participant::resolve(c, polis_auth::Zid(zid), v)?
                    else {
                        return Ok(None);
                    };
                    Some(pid.0 as i32)
                } else {
                    None
                };
                Ok(Some((zid, pid)))
            })
            .await
            .ok()
            .flatten()?;
        let pid = if query.mine {
            // Node checks getPid(uid), but still queries req.p.pid. Existing
            // OIDC membership therefore produces [], not that member's history.
            let uid = identity.uid()?;
            let found = pool
                .with(move |c| {
                    Ok(c.query(
                        "SELECT pid FROM participants WHERE zid=$1 AND uid=$2 LIMIT 2",
                        &[&zid, &uid.0],
                    )?)
                })
                .await
                .ok()?;
            if found.len() != 1 || found[0].try_get::<_, i32>(0).ok()? < 0 {
                return None;
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
                    .ok()?;
                if rows.len() > 1 {
                    return None;
                }
                match rows.first() {
                    Some(row) => {
                        let p = row.try_get::<_, i32>(0).ok()?;
                        if p < 0 {
                            return None;
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
            return Some(Js::Arr(vec![]));
        };
        pool.with(move |c| read(c, zid, pid, query.tid, query.mine, &query.conversation_id))
            .await
            .ok()
            .flatten()
    })
    .await;
    match result {
        Ok(Some(value)) => route::json(req, res, &value),
        _ => route::bad_gateway(),
    }
}
/// No order is promised by either Node query. More than one row is therefore
/// handed back, as are noncanonical capability aliases and schema extensions.
/// A LIMIT bounds materialization without inventing a page or a sort order.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    pid: i32,
    tid: Option<i32>,
    mine: bool,
    cid: &str,
) -> anyhow::Result<Option<Js>> {
    let rows = if mine {
        c.query(
            "SELECT * FROM votes WHERE zid=$1 AND pid=$2 LIMIT 2",
            &[&zid, &pid],
        )?
    } else {
        c.query("SELECT * FROM votes_latest_unique WHERE zid=$1 AND pid=$2 AND ($3::integer IS NULL OR tid=$3) LIMIT 2",&[&zid,&pid,&tid])?
    };
    if rows.len() > 1 {
        return Ok(None);
    }
    if rows.is_empty() {
        return Ok(Some(Js::Arr(vec![])));
    }
    let codes = c.query("SELECT zinvite FROM zinvites WHERE zid=$1 LIMIT 2", &[&zid])?;
    if codes.len() != 1 || codes[0].try_get::<_, String>(0)? != cid {
        return Ok(None);
    }
    let row = &rows[0];
    let expected = if mine {
        vec![
            "zid",
            "pid",
            "tid",
            "vote",
            "weight_x_32767",
            "created",
            "high_priority",
        ]
    } else {
        vec!["zid", "pid", "tid", "vote", "weight_x_32767", "modified"]
    };
    if row.columns().iter().map(|c| c.name()).collect::<Vec<_>>() != expected {
        return Ok(None);
    }
    let mut out = Obj::new();
    out.set("pid", Js::Num(f64::from(row.try_get::<_, i32>("pid")?)));
    out.set("tid", Js::Num(f64::from(row.try_get::<_, i32>("tid")?)));
    let raw = row.try_get::<_, Option<i16>>("vote")?;
    let wire = crate::votes::StorageConvention::CURRENT.wire_preserving_invalid(raw);
    out.set(
        "vote",
        wire.map(|v| Js::Num(f64::from(v))).unwrap_or(Js::Null),
    );
    out.set(
        "weight_x_32767",
        row.try_get::<_, Option<i16>>("weight_x_32767")?
            .map(|v| Js::Num(f64::from(v)))
            .unwrap_or(Js::Null),
    );
    let time = if mine { "created" } else { "modified" };
    out.set(
        time,
        row.try_get::<_, Option<i64>>(time)?
            .map(|v| Js::Str(v.to_string()))
            .unwrap_or(Js::Null),
    );
    if mine {
        out.set("high_priority", Js::Bool(row.try_get("high_priority")?));
        out.set("weight", Js::Null);
    }
    out.set("conversation_id", Js::Str(cid.into()));
    Ok(Some(Js::Arr(vec![Js::Obj(out)])))
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "votes_read_tests.rs"]
mod tests;
