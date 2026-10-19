//! Disabled operations page response: no database or provider work.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/ops_page.rs"]
mod contract;
pub fn matches(path: &str) -> bool {
    path.starts_with(contract::PREFIX)
}
fn page_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix(contract::PREFIX)?;
    (!id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(id)
}

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if !app.ops_page_reads
        || page_id(req.path()).is_none()
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
    Some(contract::Request {
        page: page_id(req.path())?.into(),
    })
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
    fn path_parameters_are_conservative() {
        for id in ["fixture", "a-b_C9", "0"] {
            assert_eq!(page_id(&format!("/api/v3/ops/page/{id}")), Some(id));
        }
        for path in [
            "/api/v3/ops/page/",
            "/api/v3/ops/page/a/b",
            "/api/v3/ops/page/%66ixture",
            "/api/v3/ops/page/..",
            "/api/v3/ops/page/é",
            "/api/v3/ops/whoami",
        ] {
            assert_eq!(page_id(path), None);
        }
        assert_eq!(
            page_id(&format!("/api/v3/ops/page/{}", "a".repeat(129))),
            None
        );
    }
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
