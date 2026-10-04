//! Request parameters the way Express 3 sees them: `connect.query()` (qs),
//! `bodyParser()` (JSON and urlencoded bodies) and the server's `moveToBody`,
//! which copies query values over body values into one `req.body`.
//!
//! Only the value's JavaScript type and contents matter to this route
//! (`conversation_id`, `zid`, `math_tick`, `keys`): a string, an array of
//! values, or an object. Nested qs forms (`a[b][c]=1`) are reduced to an
//! object, which every parameter here rejects exactly as a nested object does.

use crate::js::{self, Js, Obj, array_index};

/// qs `decode`: `+` is a space, then `decodeURIComponent`; on a malformed
/// escape the original text is kept unchanged.
fn decode(s: &str) -> String {
    let spaced = s.replace('+', " ");
    let bytes = spaced.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok());
            match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(b) => {
                    out.push(b);
                    i += 3;
                    continue;
                }
                None => return s.to_string(),
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

enum Slot {
    Plain(String),
    Push(String),
    Index(u32, String),
    Nested(String, String),
}

/// `qs.parse(query)` reduced to the top-level types this route reads.
pub fn parse_query(query: &str) -> Obj {
    let mut order: Vec<String> = Vec::new();
    let mut slots: Vec<(String, Slot)> = Vec::new();
    for part in query.split('&').filter(|p| !p.is_empty()).take(1000) {
        let at = match part.find("]=") {
            Some(p) => Some(p + 1),
            None => part.find('='),
        };
        let (raw_key, value) = match at {
            Some(p) => (&part[..p], decode(&part[p + 1..])),
            None => (part, String::new()),
        };
        let key = decode(raw_key);
        let (base, slot) = match key.find('[') {
            Some(open) if open > 0 && key.ends_with(']') => {
                let base = key[..open].to_string();
                let inner = &key[open + 1..key.len() - 1];
                let slot = if inner.is_empty() {
                    Slot::Push(value)
                } else if let Some(i) = array_index(inner).filter(|i| *i <= 20) {
                    Slot::Index(i, value)
                } else {
                    Slot::Nested(inner.to_string(), value)
                };
                (base, slot)
            }
            _ => (key, Slot::Plain(value)),
        };
        if !order.contains(&base) {
            order.push(base.clone());
        }
        slots.push((base, slot));
    }
    let mut out = Obj::new();
    for base in order {
        let mine: Vec<&Slot> = slots
            .iter()
            .filter(|(b, _)| *b == base)
            .map(|(_, s)| s)
            .collect();
        let value = if let [Slot::Plain(v)] = mine.as_slice() {
            Js::Str(v.clone())
        } else if mine.iter().any(|s| matches!(s, Slot::Nested(..))) {
            let mut o = Obj::new();
            let mut next = 0u32;
            for s in mine {
                match s {
                    Slot::Plain(v) | Slot::Push(v) => {
                        o.set(&next.to_string(), Js::Str(v.clone()));
                        next += 1;
                    }
                    Slot::Index(i, v) => o.set(&i.to_string(), Js::Str(v.clone())),
                    Slot::Nested(k, v) => o.set(k, Js::Str(v.clone())),
                }
            }
            Js::Obj(o)
        } else {
            // Plain repeats and `[]` pushes append in order; explicit indices
            // land in index order, holes compacted away.
            let mut indexed: Vec<(u32, String)> = Vec::new();
            let mut appended: Vec<String> = Vec::new();
            for s in mine {
                match s {
                    Slot::Plain(v) | Slot::Push(v) => appended.push(v.clone()),
                    Slot::Index(i, v) => indexed.push((*i, v.clone())),
                    Slot::Nested(..) => {}
                }
            }
            indexed.sort_by_key(|(i, _)| *i);
            Js::Arr(
                indexed
                    .into_iter()
                    .map(|(_, v)| v)
                    .chain(appended)
                    .map(Js::Str)
                    .collect(),
            )
        };
        out.set(&base, value);
    }
    out
}

/// What `bodyParser` made of the request body.
pub enum Body {
    Parsed(Js),
    /// A JSON body that fails to parse: body-parser answers 400 before any
    /// route middleware has run.
    Invalid,
}

fn media_type(content_type: Option<&str>) -> String {
    content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// `express.bodyParser()`: JSON (strict: an object or array) and urlencoded
/// bodies; any other body leaves `req.body` empty.
pub fn parse_body(content_type: Option<&str>, has_body: bool, body: &[u8]) -> Body {
    let empty = Body::Parsed(Js::Obj(Obj::new()));
    if !has_body {
        return empty;
    }
    let media = media_type(content_type);
    if media == "application/json" || media.ends_with("+json") {
        if body.is_empty() {
            return empty;
        }
        let Ok(text) = std::str::from_utf8(body) else {
            return Body::Invalid;
        };
        let first = text
            .trim_start_matches([' ', '\t', '\n', '\r'])
            .chars()
            .next();
        if !matches!(first, Some('{' | '[')) {
            return Body::Invalid;
        }
        return match js::parse(text) {
            Ok(v) => Body::Parsed(v),
            Err(_) => Body::Invalid,
        };
    }
    if media == "application/x-www-form-urlencoded" {
        return Body::Parsed(Js::Obj(parse_query(&String::from_utf8_lossy(body))));
    }
    empty
}

/// `moveToBody`: `Object.assign(req.body, req.query)`.
pub fn merged(body: &Js, query: &Obj) -> Obj {
    let mut out = Obj::new();
    for (k, v) in body.spread_entries() {
        out.set(&k, v);
    }
    out.assign(query);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_take_qs_types() {
        let q = parse_query(
            "conversation_id=2abc&keys=tids%2Cn&k[]=a&k[]=b&o[x]=1&r=1&r=2&i[1]=b&i[0]=a&e",
        );
        assert_eq!(q.get("conversation_id"), Some(&Js::Str("2abc".into())));
        assert_eq!(q.get("keys"), Some(&Js::Str("tids,n".into())));
        assert_eq!(
            q.get("k"),
            Some(&Js::Arr(vec![Js::Str("a".into()), Js::Str("b".into())]))
        );
        assert!(matches!(q.get("o"), Some(Js::Obj(_))));
        assert!(matches!(q.get("r"), Some(Js::Arr(a)) if a.len() == 2));
        assert_eq!(
            q.get("i"),
            Some(&Js::Arr(vec![Js::Str("a".into()), Js::Str("b".into())]))
        );
        assert_eq!(q.get("e"), Some(&Js::Str(String::new())));
    }

    #[test]
    fn decoding_keeps_malformed_escapes() {
        assert_eq!(decode("a+b%21"), "a b!");
        assert_eq!(decode("%zz+x"), "%zz+x");
        assert_eq!(decode("%E2%82"), "%E2%82");
    }

    #[test]
    fn json_bodies_are_strict() {
        assert!(matches!(
            parse_body(Some("application/json"), true, b"{\"keys\":[]}"),
            Body::Parsed(Js::Obj(_))
        ));
        assert!(matches!(
            parse_body(Some("application/json"), true, b"\"x\""),
            Body::Invalid
        ));
        assert!(matches!(
            parse_body(Some("application/json"), true, b"{bad"),
            Body::Invalid
        ));
        assert!(matches!(
            parse_body(Some("text/plain"), true, b"{bad"),
            Body::Parsed(_)
        ));
    }

    #[test]
    fn query_wins_over_body() {
        let body = js::parse(r#"{"math_tick": 1, "keys": ["a"]}"#).unwrap();
        let q = parse_query("math_tick=2");
        let m = merged(&body, &q);
        assert_eq!(m.get("math_tick"), Some(&Js::Str("2".into())));
        assert!(matches!(m.get("keys"), Some(Js::Arr(_))));
    }
}
