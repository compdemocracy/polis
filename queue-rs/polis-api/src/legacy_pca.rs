//! Retired math-poll response: no database, provider or participant work.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/legacy_pca.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if !app.legacy_pca_reads
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some_and(|q| q.len() > 4096)
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
    route::empty_end(req, res, query.response().status)
}
