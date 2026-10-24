//! Disabled in-memory metrics read: no database, provider or participant work.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/perf_stats.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if !app.perf_stats_reads
        || req.path() != PATH
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
    Some(contract::Request::default())
}
pub fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Ok(encoded) = serde_json::to_string(&query.response()) else {
        return route::bad_gateway();
    };
    let Ok(value) = crate::js::parse(&encoded) else {
        return route::bad_gateway();
    };
    route::json(req, res, &value)
}
