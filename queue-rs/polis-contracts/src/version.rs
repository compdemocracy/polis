//! Public build identity. Field order matches Node's build_identity.py output.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/api/v3/version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub version_base: String,
    pub version_display: String,
    pub commit: String,
    pub distance: Option<u64>,
    pub channel: String,
    pub source: String,
}

impl Response {
    /// Source-only builds use VERSION, without Git or environment overrides.
    pub fn unverified(version: &str) -> Self {
        let version = version.trim();
        Self {
            version_base: version.into(),
            version_display: format!("{version}+dev.unknown.unknown"),
            commit: "unknown".into(),
            distance: None,
            channel: "development".into(),
            source: "unverified-archive".into(),
        }
    }
}
