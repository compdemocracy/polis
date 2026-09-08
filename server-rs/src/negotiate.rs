//! `negotiator.encoding(SUPPORTED_ENCODING, PREFERRED_ENCODING)` reproduced.
//!
//! The round-2 route recognized only the bare token `gzip`, so `gzip;q=1` — which
//! the real negotiator selects — was served identity, and `gzip;q=0`, `*` and
//! ordering were not modelled at all. `p032-subset-gzip/1` declares negotiated
//! gzip, and negotiation is part of the profile, not a detail below it.
//!
//! Pinned to the versions in `server/package-lock.json`: `compression@1.8.0`
//! (`node_modules/compression`, lock line 9489) over `negotiator@0.6.4` (lock line
//! 13712), running on Node v22.x. `compression/index.js:37-45` selects its lists
//! from `'createBrotliCompress' in zlib`, which is true on that runtime, so
//! `SUPPORTED_ENCODING` is `['br','gzip','deflate','identity']` and
//! `PREFERRED_ENCODING` is `['br','gzip']`. Both facts belong to the profile: a
//! Node without brotli negotiates differently, and would be a contract change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coding {
    Identity,
    Gzip,
    Deflate,
    Brotli,
}
impl Coding {
    fn name(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Gzip => "gzip",
            Self::Deflate => "deflate",
            Self::Brotli => "br",
        }
    }
}
/// `SUPPORTED_ENCODING`, in the order compression passes it as `provided`.
const SUPPORTED: [Coding; 4] = [
    Coding::Brotli,
    Coding::Gzip,
    Coding::Deflate,
    Coding::Identity,
];
/// `PREFERRED_ENCODING`.
const PREFERRED: [Coding; 2] = [Coding::Brotli, Coding::Gzip];
/// One parsed `Accept-Encoding` element, plus the synthesized identity.
struct Spec {
    encoding: String,
    q: f64,
    i: usize,
}
/// One `provided` encoding's best match, mirroring `getEncodingPriority`.
struct Priority {
    coding: Coding,
    /// The provided-list index (`i` in negotiator).
    i: usize,
    /// The accept-header order of the matching spec (`o`).
    o: i64,
    q: f64,
    /// Specificity: 1 for a named match, 0 for `*`.
    s: i64,
}
/// JS `parseFloat`: parses the longest numeric prefix, NaN when there is none.
/// `q=abc` therefore yields NaN, which `isQuality` filters out, and `q=1.0junk`
/// yields 1.0 — neither of which `str::parse` reproduces on its own.
fn parse_float(text: &str) -> f64 {
    let bytes = text.as_bytes();
    let mut end = 0;
    let mut seen_digit = false;
    let mut seen_dot = false;
    let mut seen_exp = false;
    while end < bytes.len() {
        let c = bytes[end] as char;
        let ok = match c {
            '+' | '-' => end == 0 || matches!(bytes[end - 1] as char, 'e' | 'E'),
            '.' => !seen_dot && !seen_exp,
            'e' | 'E' => seen_digit && !seen_exp,
            '0'..='9' => true,
            _ => false,
        };
        if !ok {
            break;
        }
        seen_digit |= c.is_ascii_digit();
        seen_dot |= c == '.';
        seen_exp |= c == 'e' || c == 'E';
        end += 1;
    }
    if !seen_digit {
        return f64::NAN;
    }
    // Trim a trailing exponent marker or sign the loop admitted but never completed.
    let mut candidate = &text[..end];
    while !candidate.is_empty() && candidate.parse::<f64>().is_err() {
        candidate = &candidate[..candidate.len() - 1];
    }
    candidate.parse().unwrap_or(f64::NAN)
}
/// `simpleEncodingRegExp` = `/^\s*([^\s;]+)\s*(?:;(.*))?$/`.
fn parse_encoding(text: &str, i: usize) -> Option<Spec> {
    let rest = text.trim_start();
    let token_end = rest.find([' ', '\t', ';']).unwrap_or(rest.len());
    if token_end == 0 {
        return None;
    }
    let encoding = &rest[..token_end];
    let after = rest[token_end..].trim_start();
    let mut q = 1.0;
    if !after.is_empty() {
        // Anything between the token and the end that is not `;params` fails the
        // anchored regex, and an unparsed element is dropped rather than accepted.
        let params = after.strip_prefix(';')?;
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
/// `specify`: named match scores 1, `*` scores 0, anything else does not match.
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
/// The coding `compression` would select for this `Accept-Encoding`.
///
/// `None` means the header is absent, where compression falls back to
/// `enforceEncoding` (`identity`) and does not transform.
pub fn encoding(accept: Option<&str>) -> Coding {
    let Some(accept) = accept else {
        return Coding::Identity;
    };
    let accepts = parse_accept(accept);
    let mut priorities: Vec<Priority> = SUPPORTED
        .iter()
        .enumerate()
        .map(|(index, coding)| priority(*coding, &accepts, index))
        .filter(|p| p.q > 0.0)
        .collect();
    // `preferredEncodings`'s comparator, over JS's stable sort.
    priorities.sort_by(|a, b| {
        if a.q != b.q {
            return b.q.total_cmp(&a.q);
        }
        let rank = |c: Coding| PREFERRED.iter().position(|p| *p == c);
        match (rank(a.coding), rank(b.coding)) {
            (None, None) => (b.s.cmp(&a.s)).then(a.o.cmp(&b.o)).then(a.i.cmp(&b.i)),
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
        }
    });
    priorities.first().map_or(Coding::Identity, |p| p.coding)
}
#[cfg(test)]
mod tests {
    use super::*;
    /// Every row is the actual `negotiator@0.6.4` answer, regenerated by
    /// `tools/negotiation-parity.cjs` against `server/node_modules` and pinned in
    /// `contract/negotiation.json`. This test is the same table, so a divergence
    /// from the middleware fails here rather than on the wire.
    #[test]
    fn selection_matches_the_pinned_negotiator() {
        #[derive(serde::Deserialize)]
        struct Pinned {
            compression: String,
            negotiator: String,
            #[serde(rename = "hasBrotliSupport")]
            has_brotli_support: bool,
            table: Vec<(String, String)>,
        }
        let pinned: Pinned = serde_json::from_str(include_str!("../contract/negotiation.json"))
            .expect("pinned table");
        // The profile pins the middleware, not just its answers.
        assert_eq!(pinned.compression, "1.8.0");
        assert_eq!(pinned.negotiator, "0.6.4");
        assert!(
            pinned.has_brotli_support,
            "SUPPORTED/PREFERRED assume brotli"
        );
        assert!(pinned.table.len() >= 20, "the table must cover the profile");
        for (accept, expected) in pinned.table {
            let got = encoding(Some(&accept)).name();
            assert_eq!(got, expected, "Accept-Encoding: {accept:?}");
        }
    }
    #[test]
    fn the_defect_cases_select_what_node_selects() {
        // The round-2 code compared the bare token, so this was identity.
        assert_eq!(encoding(Some("gzip;q=1")), Coding::Gzip);
        // A zero quality is a refusal, not a request.
        assert_eq!(encoding(Some("gzip;q=0")), Coding::Identity);
        // A wildcard reaches brotli, which this candidate cannot produce.
        assert_eq!(encoding(Some("*")), Coding::Brotli);
        assert_eq!(encoding(Some("gzip, br")), Coding::Brotli);
        // Quality outranks the preferred order.
        assert_eq!(encoding(Some("br;q=0.5, gzip;q=0.9")), Coding::Gzip);
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
}
