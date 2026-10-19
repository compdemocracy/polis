//! Operations catch-all response: no database or provider work.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/ops_catchall.rs"]
mod contract;
pub fn matches(path: &str) -> bool {
    let Some(suffix) = path.strip_prefix(contract::PREFIX) else {
        return false;
    };
    if !suffix.is_empty() && !suffix.starts_with('/') {
        return false;
    }
    let first = suffix
        .strip_prefix('/')
        .unwrap_or(suffix)
        .split('/')
        .next()
        .unwrap_or("");
    // Preserve the independent switches and precedence of registered endpoints.
    !first.eq_ignore_ascii_case("whoami") && !first.eq_ignore_ascii_case("page")
}
fn admitted_path(path: &str) -> bool {
    if !matches(path) || path.len() > 256 {
        return false;
    }
    let suffix = &path[contract::PREFIX.len()..];
    suffix.is_empty()
        || suffix == "/"
        || suffix[1..].split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if !app.ops_catchall_reads
        || !admitted_path(req.path())
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
        path: req.path().into(),
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
    fn catchall_preserves_registered_paths_and_segment_boundaries() {
        for path in [
            "/api/v3/ops",
            "/api/v3/ops/",
            "/api/v3/ops/unknown",
            "/api/v3/ops/a-b_C9/child",
        ] {
            assert!(admitted_path(path), "{path}");
        }
        for path in [
            "/api/v3/opsOther",
            "/api/v3/ops/whoami",
            "/api/v3/ops/whoami/",
            "/api/v3/ops/WHOAMI",
            "/api/v3/ops/page/fixture",
            "/api/v3/ops/Page",
            "/api/v3/ops/unknown/",
            "/api/v3/ops/a//b",
            "/api/v3/ops/%75nknown",
            "/api/v3/ops/..",
            "/api/v3/ops/é",
        ] {
            assert!(!admitted_path(path), "{path}");
        }
        assert!(!admitted_path(&format!("/api/v3/ops/{}", "a".repeat(257))));
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
