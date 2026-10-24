//! Legacy report validation and bounded narrative reads on independent pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/delphi_reports.rs"]
pub(crate) mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.delphi_reports_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || (app.delphi_narratives_db.is_none()
            && (req.headers.get("authorization").is_some() || req.headers.get("cookie").is_some()))
    {
        return None;
    }
    let raw = req.query().unwrap_or("");
    // Express 3 keeps a value verbatim when decodeURIComponent throws.
    // Malformed escapes, invalid UTF-8 and raw non-ASCII stay on Node.
    let b = raw.as_bytes();
    if raw.len() > 1024
        || !raw.is_ascii()
        || (0..b.len()).any(|i| {
            b[i] == b'%'
                && !(i + 2 < b.len()
                    && b[i + 1].is_ascii_hexdigit()
                    && b[i + 2].is_ascii_hexdigit())
        })
    {
        return None;
    }
    let mut query = contract::Request::default();
    let mut seen = std::collections::HashSet::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if !seen.insert(k.to_string()) || v.len() > 256 || v.contains(['\0', '\u{FFFD}']) {
            return None;
        }
        if k == "report_id" {
            if v.len() > 100
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return None;
            }
            query.report_id = (!v.is_empty()).then(|| v.into_owned());
        } else {
            app.delphi_narratives_db.as_ref()?;
            let value = (!v.is_empty()).then(|| v.into_owned());
            match k.as_ref() {
                "section" => query.section = value,
                "topic_key" => query.topic_key = value,
                "job_id" => query.job_id = value,
                _ => return None,
            }
        }
    }
    Some(query)
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
    let Ok(Some(body)) = tokio::time::timeout(
        std::time::Duration::from_millis(if app.delphi_narratives_db.is_some() {
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
    route::json_text(req, res, 200, body)
}
async fn answer(app: &App, query: contract::Request) -> Option<String> {
    let Some(id) = &query.report_id else {
        return crate::wire::to_json(&contract::Request::missing()).ok();
    };
    let rid = id.clone();
    let row = app
        .delphi_reports_db
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
    if row.is_some() && app.delphi_narratives_db.is_none() {
        return None;
    }
    if row.flatten().is_none() {
        return crate::wire::to_json(&contract::Request::unknown(id.clone())).ok();
    }
    crate::delphi_narratives::answer(app, query).await
}
