//! Database-free legacy-browser redirect. HTML fetching stays with Node.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/user_login_page.rs"]
mod contract;
pub fn matches(path: &str) -> bool {
    // Node anchors this route: suffixes must start with a slash.
    path == contract::PREFIX
        || path
            .strip_prefix(contract::PREFIX)
            .is_some_and(|tail| tail.starts_with('/'))
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if !app.user_login_page_reads
        || !matches(req.path())
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some_and(|q| !q.is_empty())
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("authorization").is_some()
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let path = req.path();
    if path.len() > 2048
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
    {
        return None;
    }
    let host = req.headers.get("host")?;
    if host.is_empty()
        || host.len() > 255
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b))
    {
        return None;
    }
    let ua = req.headers.get("user-agent")?;
    // Reproduce both case-sensitive regexes, including strings containing
    // multiple versions: unsupported browsers take the earlier HTML branch.
    if ua
        .as_bytes()
        .windows(6)
        .any(|w| w.starts_with(b"MSIE ") && b"234567".contains(&w[5]))
        || !ua
            .as_bytes()
            .windows(6)
            .any(|w| w.starts_with(b"MSIE ") && b"89".contains(&w[5]))
    {
        return None;
    }
    Some(contract::Request {
        host: host.into(),
        path: path.into(),
    })
}
pub fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    route::redirect(req, res, &query.response().location)
}
