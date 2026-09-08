//! The content coding `express.compress()` selects, reproduced from the middleware
//! the route actually resolves.
//!
//! Round 3 pinned this to the top-level `compression@1.8.0` over
//! `negotiator@0.6.4` and was wrong. `app.ts:310` calls `express.compress()`,
//! which is `connect/lib/middleware/compress.js`, whose bare
//! `require('compression')` resolves against `connect/` and finds the NESTED
//! `connect/node_modules/compression@1.5.2`; its `accepts@1.2.13` likewise
//! resolves the nested `negotiator@0.5.3`. `tools/negotiation-parity.cjs` asserts
//! that `express.compress` IS that module and measures the table over real HTTP,
//! so the resolution is checked rather than assumed.
//!
//! Two consequences. 1.5.2 offers `['gzip','deflate','identity']` and has no
//! brotli branch at all, so **no Accept-Encoding can make this middleware select
//! br** — `br` alone negotiates to identity and a browser's `gzip, deflate, br`
//! to gzip. And 0.5.3's `preferredEncodings` takes no preferred list, so ordering
//! falls to `compareSpecs` alone; 1.5.2 then applies its own "we really don't
//! prefer deflate" step on top.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coding {
    Identity,
    Gzip,
    Deflate,
}
impl Coding {
    fn name(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Gzip => "gzip",
            Self::Deflate => "deflate",
        }
    }
}
/// `accept.encoding(['gzip', 'deflate', 'identity'])` (`compression/index.js:163`).
const PROVIDED: [Coding; 3] = [Coding::Gzip, Coding::Deflate, Coding::Identity];
/// One parsed `Accept-Encoding` element, plus the synthesized identity.
struct Spec {
    encoding: String,
    q: f64,
    i: usize,
}
/// One `provided` encoding's best match, mirroring `getEncodingPriority`.
struct Priority {
    coding: Coding,
    /// The provided-list index (`i`).
    i: usize,
    /// The accept-header order of the matching spec (`o`).
    o: i64,
    q: f64,
    /// Specificity: 1 for a named match, 0 for `*`.
    s: i64,
}
/// JS `parseFloat`: parses the longest numeric prefix, NaN when there is none.
/// `q=abc` therefore yields NaN, which `isQuality` filters out, and `q=0.5junk`
/// yields 0.5 — neither of which `str::parse` reproduces on its own.
fn parse_float(text: &str) -> f64 {
    let bytes = text.as_bytes();
    let mut end = 0;
    let mut seen_digit = false;
    while end < bytes.len() {
        let c = bytes[end] as char;
        let ok = match c {
            '+' | '-' => end == 0 || matches!(bytes[end - 1] as char, 'e' | 'E'),
            '.' | 'e' | 'E' | '0'..='9' => true,
            _ => false,
        };
        if !ok {
            break;
        }
        seen_digit |= c.is_ascii_digit();
        end += 1;
    }
    if !seen_digit {
        return f64::NAN;
    }
    // Shrink to the longest prefix Rust can parse, which is JS's prefix rule.
    let mut candidate = &text[..end];
    while !candidate.is_empty() && candidate.parse::<f64>().is_err() {
        candidate = &candidate[..candidate.len() - 1];
    }
    candidate.parse().unwrap_or(f64::NAN)
}
/// negotiator 0.5.3's `/^\s*(\S+?)\s*(?:;(.*))?$/`.
///
/// The token is LAZY, so it is the shortest run of non-space characters that
/// leaves a tail of optional whitespace followed by either nothing or `;params`.
/// That differs from a `[^\s;]+` reading: `";q=1"` has no such short token, and
/// the lazy group grows until it swallows the whole string as the encoding name.
fn parse_encoding(text: &str, i: usize) -> Option<Spec> {
    let rest = text.trim_start();
    let mut token_end = None;
    for (offset, c) in rest.char_indices() {
        if c.is_whitespace() {
            break;
        }
        let end = offset + c.len_utf8();
        let tail = rest[end..].trim_start();
        if tail.is_empty() || tail.starts_with(';') {
            token_end = Some(end);
            break;
        }
    }
    let token_end = token_end?;
    let encoding = &rest[..token_end];
    let tail = rest[token_end..].trim_start();
    let mut q = 1.0;
    if let Some(params) = tail.strip_prefix(';') {
        for param in params.split(';') {
            let mut parts = param.trim().split('=');
            if parts.next() == Some("q") {
                q = parse_float(parts.next().unwrap_or(""));
                break;
            }
        }
    }
    Some(Spec {
        encoding: encoding.to_string(),
        q,
        i,
    })
}
/// `specify`: a named match scores 1, `*` scores 0, anything else does not match.
fn specificity(coding: Coding, spec: &Spec) -> Option<i64> {
    if spec.encoding.eq_ignore_ascii_case(coding.name()) {
        Some(1)
    } else if spec.encoding == "*" {
        Some(0)
    } else {
        None
    }
}
fn parse_accept(accept: &str) -> Vec<Spec> {
    let parts: Vec<&str> = accept.split(',').collect();
    let mut specs = Vec::new();
    let mut has_identity = false;
    let mut min_quality: f64 = 1.0;
    for (i, part) in parts.iter().enumerate() {
        if let Some(spec) = parse_encoding(part.trim(), i) {
            has_identity = has_identity
                || spec.encoding.eq_ignore_ascii_case("identity")
                || spec.encoding == "*";
            // `Math.min(minQuality, encoding.q || 1)`: a zero or NaN q is falsy in
            // JS, so it contributes 1 here rather than 0.
            let q = if spec.q == 0.0 || spec.q.is_nan() {
                1.0
            } else {
                spec.q
            };
            min_quality = min_quality.min(q);
            specs.push(spec);
        }
    }
    if !has_identity {
        specs.push(Spec {
            encoding: "identity".into(),
            q: min_quality,
            i: parts.len(),
        });
    }
    specs
}
fn priority(coding: Coding, accepts: &[Spec], index: usize) -> Priority {
    let mut best = Priority {
        coding,
        i: index,
        o: -1,
        q: 0.0,
        s: 0,
    };
    for spec in accepts {
        let Some(s) = specificity(coding, spec) else {
            continue;
        };
        // `(priority.s - spec.s || priority.q - spec.q || priority.o - spec.o) < 0`
        let better = if best.s != s {
            best.s < s
        } else if best.q != spec.q {
            best.q < spec.q
        } else {
            best.o < spec.i as i64
        };
        if better {
            best = Priority {
                coding,
                i: index,
                o: spec.i as i64,
                q: spec.q,
                s,
            };
        }
    }
    best
}
/// `accepts.encoding(list)`: `negotiator.encodings(list)[0] || false`.
fn best(accepts: &[Spec], provided: &[Coding]) -> Option<Coding> {
    let mut priorities: Vec<Priority> = provided
        .iter()
        .enumerate()
        .map(|(index, coding)| priority(*coding, accepts, index))
        .filter(|p| p.q > 0.0)
        .collect();
    // `compareSpecs`: 0.5.3 takes no preferred list, so this is the whole order.
    priorities.sort_by(|a, b| {
        b.q.total_cmp(&a.q)
            .then(b.s.cmp(&a.s))
            .then(a.o.cmp(&b.o))
            .then(a.i.cmp(&b.i))
    });
    priorities.first().map(|p| p.coding)
}
/// The coding `express.compress()` would apply. `None` is an absent header, which
/// negotiator treats as the empty string.
pub fn encoding(accept: Option<&str>) -> Coding {
    let accepts = parse_accept(accept.unwrap_or_default());
    let mut method = best(&accepts, &PROVIDED);
    // compression/index.js:166-168 — "we really don't prefer deflate".
    if method == Some(Coding::Deflate) && best(&accepts, &[Coding::Gzip]).is_some() {
        method = best(&accepts, &[Coding::Gzip, Coding::Identity]);
    }
    match method {
        Some(Coding::Gzip) => Coding::Gzip,
        Some(Coding::Deflate) => Coding::Deflate,
        // `!method || method === 'identity'` is nocompress.
        _ => Coding::Identity,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    /// Every row is an observed `Content-Encoding` from a real HTTP response
    /// through the resolved `express.compress()`, regenerated by
    /// `tools/negotiation-parity.cjs` and pinned in `contract/negotiation.json`.
    /// A divergence from the installed middleware fails here, not on the wire.
    #[test]
    fn selection_matches_the_resolved_middleware() {
        #[derive(serde::Deserialize)]
        struct Versions {
            compression: String,
            negotiator: String,
        }
        #[derive(serde::Deserialize)]
        struct Resolution {
            compression: String,
            negotiator: String,
        }
        #[derive(serde::Deserialize)]
        struct Pinned {
            resolution: Resolution,
            versions: Versions,
            provided: Vec<String>,
            #[serde(rename = "absentAcceptEncoding")]
            absent: String,
            table: Vec<(String, String)>,
        }
        let pinned: Pinned = serde_json::from_str(include_str!("../contract/negotiation.json"))
            .expect("pinned table");
        // The profile pins the resolution, not merely the answers.
        assert_eq!(pinned.versions.compression, "1.5.2");
        assert_eq!(pinned.versions.negotiator, "0.5.3");
        assert!(
            pinned
                .resolution
                .compression
                .contains("connect/node_modules/compression"),
            "the nested middleware is the one the route resolves: {}",
            pinned.resolution.compression
        );
        assert!(
            pinned
                .resolution
                .negotiator
                .contains("connect/node_modules/negotiator")
        );
        assert_eq!(pinned.provided, ["gzip", "deflate", "identity"]);
        assert_eq!(encoding(None).name(), pinned.absent);
        assert!(pinned.table.len() >= 28, "the table must cover the profile");
        for (accept, expected) in pinned.table {
            assert_eq!(
                encoding(Some(&accept)).name(),
                expected,
                "Accept-Encoding: {accept:?}"
            );
        }
    }
    /// The four rows the round-3 pin got wrong, and the two that show why the
    /// brotli refusal was answering a case this middleware cannot produce.
    #[test]
    fn the_corrected_rows() {
        assert_eq!(encoding(Some("gzip, br")), Coding::Gzip);
        assert_eq!(encoding(Some("br, gzip")), Coding::Gzip);
        assert_eq!(encoding(Some("*")), Coding::Gzip);
        assert_eq!(encoding(Some("*, gzip;q=0")), Coding::Deflate);
        assert_eq!(encoding(Some("gzip, deflate, br")), Coding::Gzip);
        assert_eq!(encoding(Some("br")), Coding::Identity);
    }
    #[test]
    fn quality_rules() {
        assert_eq!(encoding(Some("gzip;q=1")), Coding::Gzip);
        assert_eq!(encoding(Some("gzip;q=0")), Coding::Identity);
        assert_eq!(encoding(Some("gzip;q=abc")), Coding::Identity);
        // "we really don't prefer deflate": deflate wins the sort, gzip is checked,
        // and here it is unavailable, so deflate stands.
        assert_eq!(encoding(Some("gzip;q=0, deflate")), Coding::Deflate);
        assert_eq!(encoding(None), Coding::Identity);
    }
    #[test]
    fn js_parse_float_prefixes() {
        assert_eq!(parse_float("1.0"), 1.0);
        assert_eq!(parse_float("0.5junk"), 0.5);
        assert!(parse_float("abc").is_nan());
        assert!(parse_float("").is_nan());
        assert_eq!(parse_float("1e-1"), 0.1);
    }
    /// The lazy `\S+?` token: with no short token that leaves `;params`, the group
    /// grows until the whole element is the encoding name.
    #[test]
    fn the_token_is_lazy_not_semicolon_delimited() {
        let spec = parse_encoding(";q=1", 0).expect("the whole element is the token");
        assert_eq!(spec.encoding, ";q=1");
        assert_eq!(spec.q, 1.0);
        let spec = parse_encoding("gzip;q=0.5", 0).expect("ordinary element");
        assert_eq!(spec.encoding, "gzip");
        assert_eq!(spec.q, 0.5);
        assert!(
            parse_encoding("gzip x", 0).is_none(),
            "an interior space fails the anchor"
        );
    }
}
