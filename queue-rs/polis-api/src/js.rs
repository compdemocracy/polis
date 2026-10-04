//! JavaScript value semantics for the stored math blob.
//!
//! The Node route reads `math_main.data` with `JSON.parse`, reshapes it with
//! plain object operations (spread, assignment, `delete`) and serves
//! `JSON.stringify` of the result, gzipped. Three JavaScript rules decide the
//! served bytes, and this module reproduces them exactly:
//!
//! * **Property order.** An object lists its array-index keys (`"0"`, `"17"`,
//!   ... up to 2^32 - 2) first, in ascending numeric order, then every other
//!   key in the order it was first created. Re-assigning an existing key keeps
//!   its position; deleting and re-adding moves it to the end.
//! * **Number spelling.** `JSON.stringify` prints numbers the way
//!   `Number.prototype.toString` does (`1e+21`, `1e-7`, `0.000001`, `-0` as
//!   `0`); NaN and infinities print as `null`.
//! * **String escaping.** Only `"`, `\`, and control characters are escaped;
//!   everything else, including `/` and non-ASCII, is written as is.
//!
//! The blob is otherwise opaque: its typed boundary is the row (`db.rs`), and
//! its shape rules are the Node route's own (`pca.rs`).

use anyhow::{Result, bail};

#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Js>),
    Obj(Obj),
}

/// An ordinary JavaScript object: own enumerable string-keyed properties in
/// JavaScript's property order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj {
    entries: Vec<(String, Js)>,
}

/// `Some(n)` when `key` is an array index: the canonical decimal spelling of
/// an integer in 0..=2^32-2.
pub fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    if value <= 4_294_967_294 {
        u32::try_from(value).ok()
    } else {
        None
    }
}

impl Obj {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Js)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Js> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// `obj[key] = value`.
    pub fn set(&mut self, key: &str, value: Js) {
        if let Some(slot) = self.get_mut(key) {
            *slot = value;
            return;
        }
        match array_index(key) {
            Some(index) => {
                // Index keys sit before every other key, in ascending order.
                let at = self
                    .entries
                    .iter()
                    .position(|(k, _)| array_index(k).is_none_or(|other| other > index))
                    .unwrap_or(self.entries.len());
                self.entries.insert(at, (key.to_string(), value));
            }
            None => self.entries.push((key.to_string(), value)),
        }
    }

    /// `delete obj[key]`.
    pub fn remove(&mut self, key: &str) -> Option<Js> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(at).1)
    }

    /// `{...self, ...other}` applied in place: `Object.assign(self, other)`.
    pub fn assign(&mut self, other: &Obj) {
        for (k, v) in &other.entries {
            self.set(k, v.clone());
        }
    }
}

impl Js {
    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            Js::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_obj_mut(&mut self) -> Option<&mut Obj> {
        match self {
            Js::Obj(o) => Some(o),
            _ => None,
        }
    }

    /// `v !== null && typeof v === "object" && !Array.isArray(v)`.
    pub fn is_plain_object(&self) -> bool {
        matches!(self, Js::Obj(_))
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Js::Null => false,
            Js::Bool(b) => *b,
            Js::Num(n) => *n != 0.0 && !n.is_nan(),
            Js::Str(s) => !s.is_empty(),
            Js::Arr(_) | Js::Obj(_) => true,
        }
    }

    /// The own enumerable properties `{...value}` copies, in order. Strings
    /// spread their UTF-16 code units as index keys; numbers, booleans and null
    /// spread nothing.
    pub fn spread_entries(&self) -> Vec<(String, Js)> {
        match self {
            Js::Obj(o) => o.entries.clone(),
            Js::Arr(a) => a
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect(),
            Js::Str(s) => s
                .chars()
                .enumerate()
                .map(|(i, c)| (i.to_string(), Js::Str(c.to_string())))
                .collect(),
            Js::Null | Js::Bool(_) | Js::Num(_) => Vec::new(),
        }
    }

    /// `String(v)` for the values a request parameter can hold.
    pub fn to_js_string(&self) -> String {
        match self {
            Js::Null => "null".into(),
            Js::Bool(b) => b.to_string(),
            Js::Num(n) => number_to_string(*n),
            Js::Str(s) => s.clone(),
            Js::Arr(a) => a
                .iter()
                .map(|v| match v {
                    Js::Null => String::new(),
                    other => other.to_js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            Js::Obj(_) => "[object Object]".into(),
        }
    }
}

/// `Number.prototype.toString()` / `String(n)`.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    ryu_js::Buffer::new().format(n).to_string()
}

/// `Number(s)` for a string: whitespace-trimmed decimal, `0x`/`0o`/`0b`
/// integers, `Infinity`, and `""` as 0; anything else is NaN.
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'-' => (-1.0, &t[1..]),
        b'+' => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits [. digits] [e[+-]digits], or . digits.
    let bytes = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let f = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

// ---------------------------------------------------------------- JSON.parse

const MAX_DEPTH: usize = 512;

/// `JSON.parse(text)` for well-formed JSON (Postgres `jsonb` output or a
/// request body). Duplicate keys keep the first position and the last value.
pub fn parse(text: &str) -> Result<Js> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        bail!("unexpected trailing input at {}", p.i);
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn expect(&mut self, b: u8) -> Result<()> {
        if self.peek() != Some(b) {
            bail!("expected {:?} at {}", b as char, self.i);
        }
        self.i += 1;
        Ok(())
    }

    fn literal(&mut self, word: &[u8], value: Js) -> Result<Js> {
        if self.s[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(value)
        } else {
            bail!("invalid literal at {}", self.i)
        }
    }

    fn value(&mut self, depth: usize) -> Result<Js> {
        if depth > MAX_DEPTH {
            bail!("JSON nesting too deep");
        }
        match self.peek() {
            Some(b'{') => {
                self.i += 1;
                let mut obj = Obj::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Js::Obj(obj));
                }
                loop {
                    self.ws();
                    let key = self.string()?;
                    self.ws();
                    self.expect(b':')?;
                    self.ws();
                    let v = self.value(depth + 1)?;
                    obj.set(&key, v);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Js::Obj(obj));
                        }
                        _ => bail!("expected , or }} at {}", self.i),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut arr = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Js::Arr(arr));
                }
                loop {
                    self.ws();
                    arr.push(self.value(depth + 1)?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Js::Arr(arr));
                        }
                        _ => bail!("expected , or ] at {}", self.i),
                    }
                }
            }
            Some(b'"') => Ok(Js::Str(self.string()?)),
            Some(b't') => self.literal(b"true", Js::Bool(true)),
            Some(b'f') => self.literal(b"false", Js::Bool(false)),
            Some(b'n') => self.literal(b"null", Js::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => bail!("unexpected input at {}", self.i),
        }
    }

    fn number(&mut self) -> Result<Js> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => bail!("invalid number at {start}"),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            let f = self.i;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.i += 1;
            }
            if self.i == f {
                bail!("invalid number at {start}");
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            let e = self.i;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.i += 1;
            }
            if self.i == e {
                bail!("invalid number at {start}");
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i])?;
        // Rust's float parsing is correctly rounded, as JavaScript's is.
        Ok(Js::Num(text.parse::<f64>()?))
    }

    fn hex4(&mut self) -> Result<u32> {
        let Some(digits) = self.s.get(self.i..self.i + 4) else {
            bail!("truncated \\u escape");
        };
        let value = u32::from_str_radix(std::str::from_utf8(digits)?, 16)?;
        self.i += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' && self.s[self.i] != b'\\' {
                if self.s[self.i] < 0x20 {
                    bail!("control character in string at {}", self.i);
                }
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[start..self.i])?);
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(c) = self.peek() else {
                        bail!("truncated escape");
                    };
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&first)
                                && self.s.get(self.i..self.i + 2) == Some(b"\\u")
                            {
                                let save = self.i;
                                self.i += 2;
                                let second = self.hex4()?;
                                if (0xDC00..0xE000).contains(&second) {
                                    0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                                } else {
                                    self.i = save;
                                    first
                                }
                            } else {
                                first
                            };
                            // A lone surrogate has no UTF-8 form. Postgres jsonb
                            // refuses to store one, so this cannot come from math_main.
                            let Some(ch) = char::from_u32(code) else {
                                bail!("lone surrogate escape");
                            };
                            out.push(ch);
                        }
                        _ => bail!("invalid escape"),
                    }
                }
                _ => bail!("unterminated string"),
            }
        }
    }
}

// ------------------------------------------------------------ JSON.stringify

/// `JSON.stringify(value)` with no replacer and no indentation.
pub fn stringify(value: &Js) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Js) {
    match value {
        Js::Null => out.push_str("null"),
        Js::Bool(true) => out.push_str("true"),
        Js::Bool(false) => out.push_str("false"),
        Js::Num(n) if n.is_finite() => out.push_str(ryu_js::Buffer::new().format(*n)),
        Js::Num(_) => out.push_str("null"),
        Js::Str(s) => write_string(out, s),
        Js::Arr(a) => {
            out.push('[');
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, v);
            }
            out.push(']');
        }
        Js::Obj(o) => {
            out.push('{');
            for (i, (k, v)) in o.entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, v);
            }
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(text: &str) -> String {
        stringify(&parse(text).unwrap())
    }

    #[test]
    fn index_keys_come_first_in_numeric_order() {
        assert_eq!(
            round(
                r#"{"b": 1, "10": 2, "a": 3, "2": 4, "01": 5, "4294967295": 6, "4294967294": 7}"#
            ),
            r#"{"2":4,"10":2,"4294967294":7,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
    }

    #[test]
    fn reassignment_keeps_position_and_delete_readd_moves_to_end() {
        let mut o = parse(r#"{"a":1,"b":2,"c":3}"#).unwrap();
        let obj = o.as_obj_mut().unwrap();
        obj.set("a", Js::Num(9.0));
        assert_eq!(stringify(&o), r#"{"a":9,"b":2,"c":3}"#);
        let obj = o.as_obj_mut().unwrap();
        obj.remove("a");
        obj.set("a", Js::Num(1.0));
        assert_eq!(stringify(&o), r#"{"b":2,"c":3,"a":1}"#);
    }

    #[test]
    fn duplicate_keys_keep_first_position_last_value() {
        assert_eq!(round(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(
            round(
                "[1.0, -0, 1e21, 1e-7, 0.000001, 123456789012345680000, 0.1, 1.5e300, -2.5E-5, 100]"
            ),
            "[1,0,1e+21,1e-7,0.000001,123456789012345680000,0.1,1.5e+300,-0.000025,100]"
        );
        assert_eq!(stringify(&Js::Num(f64::NAN)), "null");
        assert_eq!(stringify(&Js::Num(f64::INFINITY)), "null");
    }

    #[test]
    fn strings_escape_like_javascript() {
        assert_eq!(
            round(r#"["a\"b\\c\/dé\u0001\b\f\n\r\t😀"]"#),
            "[\"a\\\"b\\\\c/d\u{e9}\\u0001\\b\\f\\n\\r\\t\u{1F600}\"]"
        );
    }

    #[test]
    fn number_conversion_matches_number_constructor() {
        assert_eq!(string_to_number("17"), 17.0);
        assert_eq!(string_to_number(" 3 "), 3.0);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("0x1f"), 31.0);
        assert_eq!(string_to_number("1e3"), 1000.0);
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(string_to_number("1a").is_nan());
        assert!(string_to_number("abc").is_nan());
        assert!(string_to_number(".").is_nan());
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(number_to_string(-0.0), "0");
    }

    #[test]
    fn spread_of_strings_and_arrays_yields_index_keys() {
        let entries = Js::Str("ab".into()).spread_entries();
        assert_eq!(entries[1], ("1".into(), Js::Str("b".into())));
        assert_eq!(Js::Num(3.0).spread_entries(), vec![]);
        assert_eq!(Js::Arr(vec![Js::Null]).spread_entries()[0].0, "0");
    }

    #[test]
    fn deep_nesting_is_refused_not_overflowed() {
        let text = "[".repeat(10_000) + &"]".repeat(10_000);
        assert!(parse(&text).is_err());
    }
}
