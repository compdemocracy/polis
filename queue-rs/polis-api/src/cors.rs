//! `addCorsHeader` (`server/src/utils/domain.ts`) reproduced.
//!
//! The API reads no cookie and authenticates with a bearer token, so it answers
//! a request from any origin and refuses none. When the request names an
//! origin (`Origin`, else `Referer`) or `DOMAIN_OVERRIDE` is set, Node writes
//! one constant set of CORS headers: `Access-Control-Allow-Origin: *` with the
//! allowed headers and methods, never `Access-Control-Allow-Credentials`, and
//! no `Vary`, since the value never depends on the request. A request with
//! neither header gets none. This module decides only whether the headers are
//! written; `route::default_head` writes them.
use crate::http::Headers;

/// `Access-Control-Allow-Origin`: any page may read the answer, and browsers
/// never send a credentialed request to it.
pub const ALLOW_ORIGIN: &str = "*";
pub const ALLOW_HEADERS: &str =
    "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With";
pub const ALLOW_METHODS: &str = "GET, PUT, POST, DELETE, OPTIONS";

pub struct Cors {
    /// `Config.domainOverride`: a non-empty `DOMAIN_OVERRIDE`.
    domain_override: bool,
}
impl Cors {
    pub fn from_env() -> Self {
        Self {
            domain_override: std::env::var("DOMAIN_OVERRIDE").is_ok_and(|s| !s.is_empty()),
        }
    }
    #[cfg(test)]
    pub fn for_test(domain_override: bool) -> Self {
        Self { domain_override }
    }
    /// `req.get(name)` with Node's falsiness: an EMPTY header value is falsy in
    /// `req.get("Origin") || req.get("Referer")`, so it falls through.
    /// `req.get("Referer")` is an alias that prefers the `referrer` spelling
    /// (`express/lib/request.js:50-58`).
    fn named(headers: &Headers, name: &str) -> bool {
        headers.get(name).is_some_and(|v| !v.is_empty())
    }
    /// `Config.domainOverride || req.get("Origin") || req.get("Referer")`:
    /// whether Node writes the CORS headers for this request.
    pub fn applies(&self, headers: &Headers) -> bool {
        self.domain_override
            || Self::named(headers, "origin")
            || Self::named(headers, "referrer")
            || Self::named(headers, "referer")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn headers(pairs: &[(&str, &str)]) -> Headers {
        Headers::from_raw(pairs.iter().copied())
    }
    #[test]
    fn a_request_that_names_no_origin_gets_no_cors_headers() {
        assert!(!Cors::for_test(false).applies(&headers(&[])));
    }
    #[test]
    fn every_origin_is_answered_none_is_refused() {
        let c = Cors::for_test(false);
        for origin in [
            "https://pol.is",
            "https://embed.pol.is",
            "https://news.example.org",
            "https://notpol.is",
            "http://localhost:3000",
            "null",
        ] {
            assert!(c.applies(&headers(&[("origin", origin)])), "{origin}");
        }
    }
    #[test]
    fn a_referer_alone_names_the_origin() {
        let c = Cors::for_test(false);
        assert!(c.applies(&headers(&[(
            "referer",
            "https://news.example.org/x/y?q=1#frag"
        )])));
        // `req.get("Referer")` prefers the `referrer` spelling.
        assert!(c.applies(&headers(&[("referrer", "https://news.example.org")])));
    }
    /// An empty `Origin` is falsy in Node, so the Referer still decides; both
    /// empty is no origin, and so no CORS header.
    #[test]
    fn empty_headers_fall_through_as_in_node() {
        let c = Cors::for_test(false);
        assert!(c.applies(&headers(&[
            ("origin", ""),
            ("referer", "https://news.example.org/path"),
        ])));
        assert!(c.applies(&headers(&[
            ("referrer", ""),
            ("referer", "https://news.example.org"),
        ])));
        assert!(!c.applies(&headers(&[("origin", ""), ("referer", "")])));
        assert!(!c.applies(&headers(&[("origin", ""), ("referrer", "")])));
    }
    #[test]
    fn domain_override_writes_the_headers_on_every_request() {
        let c = Cors::for_test(true);
        assert!(c.applies(&headers(&[])));
        assert!(c.applies(&headers(&[("origin", "https://news.example.org")])));
    }
}
