//! Current participant rows on independent, bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/participants_read.rs"]
mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.participants_read_db.is_none()
        || req.path() != PATH
        || req.headers.get("authorization").is_none()
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let raw = req.query()?;
    if raw.len() > 4096 {
        return None;
    }
    let pairs = url::form_urlencoded::parse(raw.as_bytes()).collect::<Vec<_>>();
    if pairs.len() != 1 || pairs[0].0 != "conversation_id" {
        return None;
    }
    let cid = pairs[0].1.as_ref();
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(contract::Request {
        conversation_id: cid.into(),
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
    let (Some(pool), Some(auth_pool)) = (&app.participants_read_db, &app.participants_read_auth_db)
    else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let uid = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?
        .uid()?;
        let cid = query.conversation_id;
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        pool.with(move |c| read_as_stored(c, zid, uid.0))
            .await
            .ok()
            .flatten()
    })
    .await;
    match result {
        Ok(Some((response, order))) => match body(&response, &order) {
            Ok(body) => route::json_text(req, res, 200, body),
            Err(_) => route::bad_gateway(),
        },
        _ => route::bad_gateway(),
    }
}
/// The keys of a participant in a database built from the migrations: the
/// order of `contract::Participant`.
const MIGRATIONS_ORDER: [&str; 10] = [
    "pid",
    "uid",
    "zid",
    "vote_count",
    "last_interaction",
    "subscribed",
    "last_notified",
    "nsli",
    "mod",
    "created",
];
/// The answer, and the keys of its participant in the order the table stores
/// its columns (none without a participant).
type Stored = (contract::Response, Vec<&'static str>);
/// The answer's bytes. Node answers with its `SELECT p.*` row, so its keys
/// are the columns of `participants` in their stored order. In a database
/// built from the migrations that is the contract's own order and the
/// contract's own encoding; an installation older than the migrations stores
/// the same columns in another order, and the same values are written in that
/// one.
fn body(response: &contract::Response, order: &[&'static str]) -> serde_json::Result<String> {
    let Some(participant) = response else {
        return serde_json::to_string(response);
    };
    if order == MIGRATIONS_ORDER {
        return serde_json::to_string(response);
    }
    let value = serde_json::to_value(participant)?;
    let mut body = String::from("{");
    for (index, key) in order.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(&serde_json::to_string(key)?);
        body.push(':');
        body.push_str(&serde_json::to_string(&value[*key])?);
    }
    body.push('}');
    Ok(body)
}
/// Duplicate projected vote_count replaces its original value without moving
/// that property's position. Multiple rows or schema extensions stay on Node.
/// The handler reads through `read_as_stored`; this is its typed result.
#[cfg(all(test, feature = "db-tests"))]
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    uid: i32,
) -> anyhow::Result<Option<contract::Response>> {
    Ok(read_as_stored(c, zid, uid)?.map(|(response, _)| response))
}
/// `read`, with the order the table stores its columns in. A schema extension
/// is a column added or missing; the order of the columns is not one, and the
/// keys of the answer follow it, as Node's do.
fn read_as_stored(c: &mut postgres::Client, zid: i32, uid: i32) -> anyhow::Result<Option<Stored>> {
    let rows=c.query("SELECT p.*, (SELECT CASE WHEN COUNT(*)=0 AND p.vote_count IS NULL THEN NULL ELSE COUNT(*)::integer END FROM votes v WHERE v.zid=p.zid AND v.pid=p.pid) AS vote_count FROM participants p WHERE uid=$1 AND zid=$2 LIMIT 2",&[&uid,&zid])?;
    if rows.len() > 1 {
        return Ok(None);
    }
    let Some(r) = rows.first() else {
        return Ok(Some((None, vec![])));
    };
    // The table's columns, then the projected count under the name of one of
    // them.
    let names: Vec<&str> = r.columns().iter().map(|c| c.name()).collect();
    let Some((&"vote_count", table)) = names.split_last() else {
        return Ok(None);
    };
    let mut order = Vec::with_capacity(table.len());
    for name in table {
        let Some(known) = MIGRATIONS_ORDER.iter().find(|known| *known == name) else {
            return Ok(None);
        };
        if order.contains(known) {
            return Ok(None);
        }
        order.push(*known);
    }
    if order.len() != MIGRATIONS_ORDER.len() {
        return Ok(None);
    }
    Ok(Some((
        Some(contract::Participant {
            pid: r.try_get("pid")?,
            uid: r.try_get("uid")?,
            zid: r.try_get("zid")?,
            vote_count: r.try_get(table.len())?,
            last_interaction: r
                .try_get::<_, Option<i64>>("last_interaction")?
                .map(|n| n.to_string()),
            subscribed: r.try_get("subscribed")?,
            last_notified: r
                .try_get::<_, Option<i64>>("last_notified")?
                .map(|n| n.to_string()),
            nsli: r.try_get("nsli")?,
            moderation: r.try_get("mod")?,
            created: r
                .try_get::<_, Option<i64>>("created")?
                .map(|n| n.to_string()),
        }),
        order,
    )))
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "participants_read_tests.rs"]
mod tests;
