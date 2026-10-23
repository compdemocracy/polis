//! Public conversation links, resolved per request on independently bounded
//! read-only pools. Missing, ambiguous or expensive reads hand back to Node.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/link_pages.rs"]
mod contract;
use contract::{Page, Response};
pub fn page(path: &str) -> Option<Page> {
    if path.starts_with("/iip/") {
        Some(Page::Participation)
    } else if path.starts_with("/iim/") {
        Some(Page::Moderation)
    } else {
        None
    }
}
pub fn matches(path: &str) -> bool {
    page(path).is_some()
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    let page = page(req.path())?;
    let pool = match page {
        Page::Participation => &app.iip_db,
        Page::Moderation => &app.iim_db,
    };
    if pool.is_none()
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
        || req.headers.get("authorization").is_some()
        || req.query().is_some_and(|q| !q.is_empty())
    {
        return None;
    }
    let cid = req.path()[5..]
        .strip_suffix('/')
        .unwrap_or(&req.path()[5..]);
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(contract::Request {
        page,
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
pub fn read(
    c: &mut postgres::Client,
    query: &contract::Request,
) -> anyhow::Result<Option<Response>> {
    let Some(zid) = crate::db::zid_for_conversation_id(c, &query.conversation_id)? else {
        return Ok(None);
    };
    if zid <= 0 {
        return Ok(None);
    }
    if query.page == Page::Participation {
        return Ok(Some(Response::participation(&query.conversation_id)));
    }
    // Bound transfer before allocating the source strings. Node's bigint comes
    // through pg as text, including values outside JavaScript's integer range.
    let rows = c.query("SELECT topic,description,created FROM conversations WHERE zid=$1 AND coalesce(octet_length(topic),0)+coalesce(octet_length(description),0)<=16384 LIMIT 2", &[&zid])?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let row = &rows[0];
    let topic: Option<String> = row.try_get(0)?;
    let description: Option<String> = row.try_get(1)?;
    let created: Option<i64> = row.try_get(2)?;
    let title = topic.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        created
            .map(|n| n.to_string())
            .unwrap_or_else(|| "null".into())
    });
    Ok(Some(Response::moderation(
        &query.conversation_id,
        &title,
        description.as_deref(),
    )))
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let pool = match query.page {
        Page::Participation => &app.iip_db,
        Page::Moderation => &app.iim_db,
    };
    let Some(pool) = pool else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(75),
        pool.with(move |c| read(c, &query)),
    )
    .await;
    match result {
        Ok(Ok(Some(response))) => route::html(req, res, &response.html),
        _ => route::bad_gateway(),
    }
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "link_pages_tests.rs"]
mod tests;
