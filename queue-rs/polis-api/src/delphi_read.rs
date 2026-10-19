//! Missing/unknown report validation only, on a separate bounded replica pool.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/delphi_read.rs"]
pub(crate) mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.delphi_read_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || (app.delphi_topics_db.is_none()
            && (req.headers.get("authorization").is_some() || req.headers.get("cookie").is_some()))
    {
        return None;
    }
    let raw = req.query().unwrap_or("");
    if raw.len() > 1024 {
        return None;
    }
    let mut report_id = None;
    let mut seen = false;
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if k != "report_id"
            || seen
            || v.len() > 100
            || !v
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        seen = true;
        if !v.is_empty() {
            report_id = Some(v.into_owned());
        }
    }
    Some(contract::Request { report_id })
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
    let Ok(Some((status, body))) = tokio::time::timeout(
        std::time::Duration::from_millis(if app.delphi_topics_db.is_some() {
            750
        } else {
            75
        }),
        answer(app, query),
    )
    .await
    else {
        return route::bad_gateway();
    };
    route::json_text(req, res, status, body)
}
async fn answer(app: &App, query: contract::Request) -> Option<(u16, String)> {
    let Some(id) = query.report_id else {
        return Some((
            400,
            crate::wire::to_json(&contract::Request::missing()).ok()?,
        ));
    };
    let rid = id.clone();
    let zid = app
        .delphi_read_db
        .as_ref()?
        .with(move |c| {
            Ok(c.query_opt(
                "SELECT zid FROM reports WHERE report_id=$1 LIMIT 1",
                &[&rid],
            )?
            .map(|r| r.try_get::<_, Option<i32>>(0))
            .transpose()?)
        })
        .await
        .ok()?;
    // Validation-only mode still hands every existing row to Node, including
    // null and zero. PostgreSQL mode follows the handler's falsy-zid response.
    if zid.is_some() && app.delphi_topics_db.is_none() {
        return None;
    }
    let Some(zid) = zid.flatten().filter(|z| *z != 0) else {
        return Some((
            404,
            crate::wire::to_json(&contract::Request::unknown(id)).ok()?,
        ));
    };
    Some((200, crate::delphi_topics::answer(app, zid, id).await?))
}
