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
        pool.with(move |c| read(c, zid, uid.0)).await.ok().flatten()
    })
    .await;
    match result {
        Ok(Some(response)) => match serde_json::to_string(&response) {
            Ok(body) => route::json_text(req, res, 200, body),
            Err(_) => route::bad_gateway(),
        },
        _ => route::bad_gateway(),
    }
}
/// Duplicate projected vote_count replaces its original value without moving
/// that property's position. Multiple rows or schema extensions stay on Node.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    uid: i32,
) -> anyhow::Result<Option<contract::Response>> {
    let rows=c.query("SELECT p.*, (SELECT CASE WHEN COUNT(*)=0 AND p.vote_count IS NULL THEN NULL ELSE COUNT(*)::integer END FROM votes v WHERE v.zid=p.zid AND v.pid=p.pid) AS vote_count FROM participants p WHERE uid=$1 AND zid=$2 LIMIT 2",&[&uid,&zid])?;
    if rows.len() > 1 {
        return Ok(None);
    }
    let Some(r) = rows.first() else {
        return Ok(Some(None));
    };
    let expected = [
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
        "vote_count",
    ];
    if r.columns().iter().map(|c| c.name()).collect::<Vec<_>>() != expected {
        return Ok(None);
    }
    Ok(Some(Some(contract::Participant {
        pid: r.try_get(0)?,
        uid: r.try_get(1)?,
        zid: r.try_get(2)?,
        vote_count: r.try_get(10)?,
        last_interaction: r.try_get::<_, Option<i64>>(4)?.map(|n| n.to_string()),
        subscribed: r.try_get(5)?,
        last_notified: r.try_get::<_, Option<i64>>(6)?.map(|n| n.to_string()),
        nsli: r.try_get(7)?,
        moderation: r.try_get(8)?,
        created: r.try_get::<_, Option<i64>>(9)?.map(|n| n.to_string()),
    })))
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "participants_read_tests.rs"]
mod tests;
