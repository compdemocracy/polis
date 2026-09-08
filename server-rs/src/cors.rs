//! `addCorsHeader` (`server/src/utils/domain.ts:96-151`) reproduced.
//!
//! Node does not emit a static origin. It reflects the request's `Origin` (falling
//! back to `Referer`), emits the four CORS headers ONLY when that reflection is
//! non-empty, and — outside dev/test and without a `DOMAIN_OVERRIDE` — refuses a
//! non-whitelisted origin through `next(...)` rather than answering the route.
//!
//! This cell is on the P-032 exclusion list: the recording ran with
//! `DOMAIN_OVERRIDE=localhost`, which pins `origin` to `${protocol}://localhost`
//! for every recorded request and so cannot see the reflection, the absence rule
//! or the whitelist. The behaviour below is read from the source on both sides.
use axum::http::HeaderMap;
/// The whitelist refusal. Node's `next("unauthorized domain: " + origin)` reaches
/// connect's final handler, which has no status to respect and defaults to 500.
#[derive(Debug)]
pub struct UnauthorizedDomain {
    pub origin: String,
}
pub struct Cors {
    domain_override: Option<String>,
    dev_mode: bool,
    testing: bool,
    /// `whitelistedDomains` minus the trailing `""`, which `hasWhitelistMatches`
    /// discards on every comparison anyway.
    whitelist: Vec<String>,
}
fn is_true(value: Option<String>) -> bool {
    // `boolean`'s isTrue: the string forms Node treats as true.
    matches!(
        value
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "true" | "t" | "yes" | "y" | "on" | "1"
    )
}
impl Cors {
    pub fn from_env() -> Self {
        let domain_override = std::env::var("DOMAIN_OVERRIDE")
            .ok()
            .filter(|s| !s.is_empty());
        let dev_mode = is_true(std::env::var("DEV_MODE").ok());
        // Config.getServerHostname()
        let hostname = if dev_mode {
            std::env::var("API_DEV_HOSTNAME").unwrap_or("localhost:5000".into())
        } else if let Some(domain) = &domain_override {
            domain.clone()
        } else {
            std::env::var("API_PROD_HOSTNAME").unwrap_or("pol.is".into())
        };
        let mut whitelist = vec![hostname];
        for i in 1..=8 {
            if let Ok(item) = std::env::var(format!("DOMAIN_WHITELIST_ITEM_{i:02}"))
                && !item.is_empty()
            {
                whitelist.push(item);
            }
        }
        whitelist.extend([
            "localhost:5000".into(),
            "localhost:5001".into(),
            "localhost:5010".into(),
        ]);
        Self {
            domain_override,
            dev_mode,
            testing: std::env::var("NODE_ENV").ok().as_deref() == Some("test")
                || is_true(std::env::var("TESTING").ok()),
            whitelist,
        }
    }
    /// Express `req.protocol` under `app.set("trust proxy", 1)`: the first
    /// `X-Forwarded-Proto` entry, else the connection scheme (always plain here).
    fn protocol(headers: &HeaderMap) -> &str {
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').next().unwrap_or(v).trim())
            .filter(|v| !v.is_empty())
            .unwrap_or("http")
    }
    /// `origin.replace(/#.*$/, "").replace(/^([^\/]*\/\/[^\/]*).*/, "$1")`
    fn clean(raw: &str) -> String {
        let s = raw.split('#').next().unwrap_or_default();
        let Some(scheme_end) = s.find("//") else {
            return s.to_string();
        };
        if s[..scheme_end].contains('/') {
            return s.to_string();
        }
        let host = &s[scheme_end + 2..];
        let end = host.find('/').map_or(s.len(), |i| scheme_end + 2 + i);
        s[..end].to_string()
    }
    fn whitelisted(&self, origin: &str) -> bool {
        let host = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"))
            .unwrap_or(origin);
        self.whitelist
            .iter()
            .any(|p| host == p || host.ends_with(&format!(".{p}")))
    }
    #[cfg(test)]
    pub fn for_test(whitelist: &[&str]) -> Self {
        Self {
            domain_override: None,
            dev_mode: false,
            testing: false,
            whitelist: whitelist.iter().map(|s| s.to_string()).collect(),
        }
    }
    /// `Ok(None)` means Node emits no CORS header at all for this request.
    pub fn resolve(&self, headers: &HeaderMap) -> Result<Option<String>, UnauthorizedDomain> {
        let origin = if let Some(domain) = &self.domain_override {
            format!("{}://{}", Self::protocol(headers), domain)
        } else {
            Self::clean(
                headers
                    .get("origin")
                    .or_else(|| headers.get("referer"))
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default(),
            )
        };
        if origin.is_empty() {
            return Ok(None);
        }
        let skip = self.domain_override.is_some()
            || self.testing
            || (self.dev_mode && origin.contains("localhost"));
        if !skip && !self.whitelisted(&origin) {
            return Err(UnauthorizedDomain { origin });
        }
        Ok(Some(origin))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }
    fn cors(whitelist: &[&str]) -> Cors {
        Cors::for_test(whitelist)
    }
    #[test]
    fn absent_origin_emits_no_cors_header() {
        assert_eq!(
            cors(&["pol.is"]).resolve(&headers(&[])).ok().flatten(),
            None
        );
    }
    #[test]
    fn present_and_whitelisted_origin_is_reflected() {
        let c = cors(&["pol.is"]);
        let got = c.resolve(&headers(&[("origin", "https://embed.pol.is")]));
        assert_eq!(got.ok().flatten().as_deref(), Some("https://embed.pol.is"));
        // Exact match, not only the subdomain rule.
        let got = c.resolve(&headers(&[("origin", "https://pol.is")]));
        assert_eq!(got.ok().flatten().as_deref(), Some("https://pol.is"));
    }
    #[test]
    fn non_whitelisted_origin_is_refused() {
        let e = cors(&["pol.is"])
            .resolve(&headers(&[("origin", "https://evil.example")]))
            .expect_err("refusal");
        assert_eq!(e.origin, "https://evil.example");
        // A suffix that is not a dot-boundary subdomain must not match.
        assert!(
            cors(&["pol.is"])
                .resolve(&headers(&[("origin", "https://notpol.is")]))
                .is_err()
        );
    }
    #[test]
    fn referer_is_the_fallback_and_is_trimmed_to_scheme_and_host() {
        let c = cors(&["pol.is"]);
        let got = c.resolve(&headers(&[(
            "referer",
            "https://embed.pol.is/x/y?q=1#frag",
        )]));
        assert_eq!(got.ok().flatten().as_deref(), Some("https://embed.pol.is"));
    }
    #[test]
    fn domain_override_pins_the_origin_to_the_forwarded_protocol() {
        let mut c = cors(&["pol.is"]);
        c.domain_override = Some("localhost".into());
        let got = c.resolve(&headers(&[("x-forwarded-proto", "https")]));
        assert_eq!(got.ok().flatten().as_deref(), Some("https://localhost"));
        // No forwarded protocol: the connection is plain, so Express reports http.
        let got = c.resolve(&headers(&[("origin", "https://evil.example")]));
        assert_eq!(got.ok().flatten().as_deref(), Some("http://localhost"));
    }
    #[test]
    fn dev_mode_and_test_mode_skip_validation() {
        let mut c = cors(&["pol.is"]);
        c.dev_mode = true;
        let got = c.resolve(&headers(&[("origin", "http://localhost:3000")]));
        assert_eq!(got.ok().flatten().as_deref(), Some("http://localhost:3000"));
        // Dev mode alone does not license a non-localhost origin.
        assert!(
            c.resolve(&headers(&[("origin", "https://evil.example")]))
                .is_err()
        );
        c.testing = true;
        let got = c.resolve(&headers(&[("origin", "https://evil.example")]));
        assert_eq!(got.ok().flatten().as_deref(), Some("https://evil.example"));
    }
}
