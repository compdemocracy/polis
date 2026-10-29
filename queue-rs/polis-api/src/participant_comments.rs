//! Participant-visible comment text on independent, bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/participant_comments.rs"]
mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.participant_comments_db.is_none()
        || req.path() != PATH
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
    let (Some(pool), Some(auth_pool)) = (
        &app.participant_comments_db,
        &app.participant_comments_auth_db,
    ) else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?;
        let cid = query.conversation_id;
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        pool.with(move |c| read(c, zid)).await.ok()
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
/// Match the plain Node list's visibility, created-only order and 999-row cap.
/// There is no author exception and no moderator expansion.
pub fn read(c: &mut postgres::Client, zid: i32) -> anyhow::Result<contract::Response> {
    let rows = c.query(
        "SELECT cm.* FROM comments cm JOIN conversations cv ON cv.zid=cm.zid
         WHERE cm.zid=$1 AND cm.active=true AND cm.velocity>0
         AND CASE WHEN cv.strict_moderation IS TRUE THEN cm.mod=1 ELSE cm.mod != -1 END
         ORDER BY cm.created LIMIT 999",
        &[&zid],
    )?;
    rows.iter()
        .map(|r| {
            Ok(contract::Comment {
                txt: r.try_get("txt")?,
                tid: r.try_get("tid")?,
            })
        })
        .collect()
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "participant_comments_tests.rs"]
mod tests;
