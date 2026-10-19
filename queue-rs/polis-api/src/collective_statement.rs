//! Missing/unknown report validation only, on a separate bounded replica pool.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/collective_statement.rs"]
mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.collective_statement_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("authorization").is_some()
        || req.headers.get("cookie").is_some()
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
    let status = if query.report_id.is_some() { 404 } else { 400 };
    let value = match query.report_id {
        None => contract::Request::missing(),
        Some(id) => {
            let Some(pool) = &app.collective_statement_db else {
                return route::bad_gateway();
            };
            let report_id = id.clone();
            // The Node resolver is uncached. Only absence qualifies: every existing
            // report (including unusual/null/zero identifiers) stays with Node.
            let Ok(Ok(false)) = tokio::time::timeout(
                std::time::Duration::from_millis(75),
                pool.with(move |c| {
                    Ok(!c
                        .query(
                            "SELECT zid FROM reports WHERE report_id=$1 LIMIT 1",
                            &[&report_id],
                        )?
                        .is_empty())
                }),
            )
            .await
            else {
                return route::bad_gateway();
            };
            contract::Request::unknown()
        }
    };
    let Ok(encoded) = serde_json::to_string(&value) else {
        return route::bad_gateway();
    };
    let Ok(value) = crate::js::parse(&encoded) else {
        return route::bad_gateway();
    };
    route::json_status(req, res, status, &value)
}
