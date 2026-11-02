//! Immutable build identity; no database, provider or participant work.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use std::sync::LazyLock;

#[path = "../../polis-contracts/src/version.rs"]
mod contract;
pub use contract::PATH;

fn load(generated: &str, version: &str) -> Result<contract::Response, serde_json::Error> {
    if generated.is_empty() {
        Ok(contract::Response::unverified(version))
    } else {
        serde_json::from_str(generated)
    }
}

static BODY: LazyLock<String> = LazyLock::new(|| {
    let info = load(
        include_str!(concat!(env!("OUT_DIR"), "/build-info.json")),
        include_str!(concat!(env!("OUT_DIR"), "/version-base")),
    )
    .unwrap_or_else(|e| panic!("invalid build identity: {e}"));
    serde_json::to_string(&info).unwrap_or_else(|e| panic!("invalid build identity: {e}"))
});

pub fn initialize() {
    LazyLock::force(&BODY);
}

pub fn eligible(app: &App, req: &Request) -> bool {
    app.version_reads
        && req.path() == PATH
        && matches!(req.method.as_str(), "GET" | "HEAD")
        && req.body.is_empty()
        && req.headers.get("transfer-encoding").is_none()
        && req.headers.get("content-length").is_none_or(|s| s == "0")
}

pub fn handle(req: &Request, mut res: Res) -> Outgoing {
    res.set("Cache-Control", "no-store");
    route::json_text(req, res, 200, BODY.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_only_fallback_matches_node_recording() {
        let recorded = include_str!("../../polis-contracts/src/fixtures/version-fallback.json");
        let fixture: contract::Response = serde_json::from_str(recorded).unwrap();
        let info = load("", &format!("{}\n", fixture.version_base)).unwrap();
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            include_str!("../../polis-contracts/src/fixtures/version-fallback.json").trim_end()
        );
    }

    #[test]
    fn generated_identity_matches_node_recording() {
        let recorded = include_str!("../../polis-contracts/src/fixtures/version.json").trim_end();
        let info = load(recorded, "ignored").unwrap();
        assert_eq!(serde_json::to_string(&info).unwrap(), recorded);
        // A corrupt generated file must never silently become an archive build.
        assert!(load("{", "2.0.0").is_err());
    }
}
