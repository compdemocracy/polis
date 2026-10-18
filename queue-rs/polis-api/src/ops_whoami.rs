//! Disabled operations identity response: no database or provider work.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/ops_whoami.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if !app.ops_whoami_reads
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
    Some(contract::Request {})
}
pub fn configured(reads: Option<&str>, ops_enabled: Option<&str>) -> bool {
    // Require an explicit disabled setting shared with Node. Missing, enabled,
    // or unrecognised settings hand off; no ops startup policy is inferred.
    reads == Some("1") && ops_enabled == Some("false")
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
    route::ops_not_found(req, res, &value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_disabled_ops_can_be_staged() {
        assert!(configured(Some("1"), Some("false")));
        for value in [
            None,
            Some("true"),
            Some("TRUE"),
            Some("0"),
            Some("False"),
            Some(""),
            Some(" false "),
        ] {
            assert!(!configured(Some("1"), value));
        }
        for value in [None, Some("0"), Some("true"), Some("")] {
            assert!(!configured(value, Some("false")));
        }
    }
}
