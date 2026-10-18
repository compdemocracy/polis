//! Byte-stable JSON for the Delphi contracts (`delphi-job-result/1`,
//! `delphi-run/1`).
//!
//! Node's `JSON.stringify` is the reference encoder. For the same value these
//! types give the same bytes:
//!
//! - [`JsNumber`]: a finite double written as `Number.prototype.toString`
//!   writes it (`1`, never `1.0`; `0.0000015`; `1e-7`; `1e+21`).
//! - [`JsMap`]: a record in JavaScript's own key order: canonical array-index
//!   keys first, ascending, then the other keys in insertion order. A
//!   duplicate key is refused (`JSON.parse` would keep the last one).
//! - [`Json`]: any JSON value, keeping key order, for the objects a contract
//!   leaves open.
//! - [`to_json`] is `JSON.stringify(value)`; [`to_json_pretty`] is
//!   `JSON.stringify(value, null, 2)`. Strings escape as both do: `"`, `\`,
//!   and control characters only.
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;
use std::marker::PhantomData;

/// A value a contract type refuses, with the rule it broke.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid(pub String);
impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Invalid {}

pub(crate) fn invalid<T>(message: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid(message.into()))
}

/// `JSON.stringify(value)`: the bytes a route serves.
pub fn to_json<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    serde_json::to_string(value)
}

/// `JSON.stringify(value, null, 2)`: the bytes a fixture file holds (plus a
/// final newline).
pub fn to_json_pretty<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    serde_json::to_string_pretty(value)
}

// --- numbers ------------------------------------------------------------------

/// 2^53: every integer up to here is exact in a double, and JavaScript
/// writes it as its plain digits.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

/// A finite JSON number, written as JavaScript writes it.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct JsNumber(f64);

impl JsNumber {
    pub fn new(value: f64) -> Result<Self, Invalid> {
        if value.is_finite() {
            Ok(Self(value))
        } else {
            invalid("a JSON number is finite")
        }
    }
    pub fn get(self) -> f64 {
        self.0
    }
}
impl From<u32> for JsNumber {
    fn from(value: u32) -> Self {
        Self(f64::from(value))
    }
}
impl From<i32> for JsNumber {
    fn from(value: i32) -> Self {
        Self(f64::from(value))
    }
}
impl fmt::Display for JsNumber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&js_number(self.0))
    }
}

/// ECMAScript `Number::toString(x)` for a finite `x` (ECMA-262 §6.1.6.1.20).
/// Rust's shortest round-trip digits (`{:e}`) are the same digits JavaScript
/// chooses; only the layout differs, and the layout is the spec's.
pub fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_owned(); // also -0, as JSON.stringify writes it
    }
    if x < 0.0 {
        return format!("-{}", js_number(-x));
    }
    let scientific = format!("{x:e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .unwrap_or((scientific.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(n as usize);
        format!("{whole}.{fraction}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{rest}e{sign}{}", e.abs())
    }
}

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let x = self.0;
        if x.fract() == 0.0 && x.abs() <= MAX_SAFE_INTEGER {
            return serializer.serialize_i64(x as i64);
        }
        let raw = serde_json::value::RawValue::from_string(js_number(x))
            .map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(f64::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

// --- records --------------------------------------------------------------------

/// A record key: written as a JSON object key, read back with its own rule.
pub trait MapKey: Sized {
    fn to_key(&self) -> String;
    fn from_key(key: String) -> Result<Self, Invalid>;
}
impl MapKey for String {
    fn to_key(&self) -> String {
        self.clone()
    }
    fn from_key(key: String) -> Result<Self, Invalid> {
        Ok(key)
    }
}

/// The ECMAScript array index a key spells, if it spells one: a canonical
/// decimal (no sign, no leading zero) from 0 to 2^32 - 2. JavaScript lists
/// these keys first, in ascending order, whatever order they were added in.
pub fn array_index(key: &str) -> Option<u32> {
    let canonical = !key.is_empty()
        && key.bytes().all(|b| b.is_ascii_digit())
        && (key == "0" || !key.starts_with('0'));
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// A JSON object whose key order is JavaScript's: array-index keys first,
/// ascending, then every other key in insertion order. Keys are unique.
#[derive(Clone, Debug)]
pub struct JsMap<K, V> {
    entries: Vec<(K, V)>,
    seen: HashSet<String>,
    indexed: usize,
}
impl<K, V> Default for JsMap<K, V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            seen: HashSet::new(),
            indexed: 0,
        }
    }
}
impl<K: PartialEq, V: PartialEq> PartialEq for JsMap<K, V> {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}
impl<K: MapKey, V> JsMap<K, V> {
    pub fn new() -> Self {
        Self::default()
    }
    /// Adds an entry where JavaScript would enumerate it; a key already
    /// present is refused.
    pub fn insert(&mut self, key: K, value: V) -> Result<(), Invalid> {
        let text = key.to_key();
        if !self.seen.insert(text.clone()) {
            return invalid(format!("duplicate key {text:?}"));
        }
        match array_index(&text) {
            Some(n) => {
                let at = self.entries[..self.indexed]
                    .partition_point(|(k, _)| array_index(&k.to_key()).is_some_and(|m| m < n));
                self.entries.insert(at, (key, value));
                self.indexed += 1;
            }
            None => self.entries.push((key, value)),
        }
        Ok(())
    }
    pub fn try_from_entries(entries: impl IntoIterator<Item = (K, V)>) -> Result<Self, Invalid> {
        let mut map = Self::new();
        for (k, v) in entries {
            map.insert(k, v)?;
        }
        Ok(map)
    }
    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries
            .iter()
            .find(|(k, _)| k.to_key() == key)
            .map(|(_, v)| v)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.seen.contains(key)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<K: MapKey, V: Serialize> Serialize for JsMap<K, V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            map.serialize_entry(&k.to_key(), v)?;
        }
        map.end()
    }
}
impl<'de, K: MapKey, V: Deserialize<'de>> Deserialize<'de> for JsMap<K, V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MapVisitor<K, V>(PhantomData<(K, V)>);
        impl<'de, K: MapKey, V: Deserialize<'de>> Visitor<'de> for MapVisitor<K, V> {
            type Value = JsMap<K, V>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut map = JsMap::new();
                while let Some(key) = access.next_key::<String>()? {
                    let key = K::from_key(key).map_err(de::Error::custom)?;
                    let value = access.next_value::<V>()?;
                    map.insert(key, value).map_err(de::Error::custom)?;
                }
                Ok(map)
            }
        }
        deserializer.deserialize_map(MapVisitor(PhantomData))
    }
}

// --- any value ------------------------------------------------------------------

/// Any JSON value, keeping object key order (JavaScript's) and number spelling.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(JsNumber),
    String(String),
    Array(Vec<Json>),
    Object(JsMap<String, Json>),
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => serializer.serialize_unit(),
            Json::Bool(b) => serializer.serialize_bool(*b),
            Json::Number(n) => n.serialize(serializer),
            Json::String(s) => serializer.serialize_str(s),
            Json::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(map) => map.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            fn visit_u64<E: de::Error>(self, n: u64) -> Result<Json, E> {
                JsNumber::new(n as f64).map(Json::Number).map_err(E::custom)
            }
            fn visit_i64<E: de::Error>(self, n: i64) -> Result<Json, E> {
                JsNumber::new(n as f64).map(Json::Number).map_err(E::custom)
            }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<Json, E> {
                JsNumber::new(n).map(Json::Number).map_err(E::custom)
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::String(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::String(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = access.next_element::<Json>()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Json, A::Error> {
                let mut map = JsMap::new();
                while let Some(key) = access.next_key::<String>()? {
                    let value = access.next_value::<Json>()?;
                    map.insert(key, value).map_err(de::Error::custom)?;
                }
                Ok(Json::Object(map))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

/// The keys an open object types itself; [`Extra`] carries the others.
pub trait Fields {
    const NAMES: &'static [&'static str];
}

/// The additional keys of an open object (the contract allows them and the
/// value is kept byte for byte), after its typed fields. A key the object
/// types itself is refused here, and so is an array-index key (`"7"`):
/// JavaScript would list it before the typed fields, an order a struct with
/// fixed fields cannot write.
#[derive(Clone, Debug)]
pub struct Extra<P> {
    map: JsMap<String, Json>,
    owner: PhantomData<P>,
}
impl<P> Default for Extra<P> {
    fn default() -> Self {
        Self {
            map: JsMap::new(),
            owner: PhantomData,
        }
    }
}
impl<P> PartialEq for Extra<P> {
    fn eq(&self, other: &Self) -> bool {
        self.map == other.map
    }
}
impl<P: Fields> Extra<P> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, key: impl Into<String>, value: Json) -> Result<(), Invalid> {
        let key = key.into();
        extra_key::<P>(&key)?;
        self.map.insert(key, value)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Json)> {
        self.map.iter()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
fn extra_key<P: Fields>(key: &str) -> Result<(), Invalid> {
    if P::NAMES.contains(&key) {
        return invalid(format!("{key:?} is a typed field, not an additional key"));
    }
    if array_index(key).is_some() {
        return invalid(format!(
            "additional key {key:?} is an array index, which JavaScript lists first"
        ));
    }
    Ok(())
}
impl<P> Serialize for Extra<P> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.map.serialize(serializer)
    }
}
impl<'de, P: Fields> Deserialize<'de> for Extra<P> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = JsMap::<String, Json>::deserialize(deserializer)?;
        for (key, _) in map.iter() {
            extra_key::<P>(key).map_err(de::Error::custom)?;
        }
        Ok(Self {
            map,
            owner: PhantomData,
        })
    }
}

// --- presence ---------------------------------------------------------------------

/// A field that is always present and may be `null`. serde would otherwise
/// read a missing `Option` field as `None`; the contracts require the key.
pub(crate) fn required<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// A field that may be absent and is never `null` when present.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// JSON `null`, required: the key must be there and its value must be `null`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Null;
impl Serialize for Null {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_unit()
    }
}
impl<'de> Deserialize<'de> for Null {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        <()>::deserialize(deserializer).map(|()| Null)
    }
}

/// A JSON string that has exactly one value (`contract_version`, `status`).
macro_rules! literal {
    ($(#[$doc:meta])* $name:ident, $value:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
        pub struct $name;
        impl $name {
            pub const VALUE: &'static str = $value;
        }
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str($value)
            }
        }
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <String as serde::Deserialize>::deserialize(deserializer)?;
                if value == $value {
                    Ok($name)
                } else {
                    Err(serde::de::Error::custom(format!(
                        "expected {:?}, found {value:?}",
                        $value
                    )))
                }
            }
        }
    };
}
pub(crate) use literal;

/// A string with a name and a rule; it cannot hold a value its rule refuses.
macro_rules! text {
    ($(#[$doc:meta])* $name:ident, $check:path) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, $crate::wire::Invalid> {
                let value = value.into();
                $check(stringify!($name), &value)?;
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::new(<String as serde::Deserialize>::deserialize(deserializer)?)
                    .map_err(serde::de::Error::custom)
            }
        }
        impl $crate::wire::MapKey for $name {
            fn to_key(&self) -> String {
                self.0.clone()
            }
            fn from_key(key: String) -> Result<Self, $crate::wire::Invalid> {
                Self::new(key)
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}
pub(crate) use text;

/// A non-negative integer id used as a record key (tid, layer id, group id).
/// As a key it is the canonical decimal JavaScript would write; `"07"`,
/// `"+7"` and `"7.0"` are refused, because they would come back as `"7"`.
macro_rules! index {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(u32);
        impl $name {
            pub const fn new(value: u32) -> Self {
                Self(value)
            }
            pub const fn get(self) -> u32 {
                self.0
            }
        }
        impl $crate::wire::MapKey for $name {
            fn to_key(&self) -> String {
                self.0.to_string()
            }
            fn from_key(key: String) -> Result<Self, $crate::wire::Invalid> {
                let canonical = !key.is_empty()
                    && key.bytes().all(|b| b.is_ascii_digit())
                    && (key == "0" || !key.starts_with('0'));
                match key.parse::<u32>() {
                    Ok(n) if canonical => Ok(Self(n)),
                    _ => Err($crate::wire::Invalid(format!(
                        "{} key {key:?} is not a canonical decimal",
                        stringify!($name)
                    ))),
                }
            }
        }
    };
}
pub(crate) use index;

// --- string rules -------------------------------------------------------------------

pub(crate) fn any_text(_: &str, _: &str) -> Result<(), Invalid> {
    Ok(())
}

pub(crate) fn non_empty(name: &str, value: &str) -> Result<(), Invalid> {
    if value.is_empty() {
        invalid(format!("{name} is not empty"))
    } else {
        Ok(())
    }
}

/// A lowercase canonical uuid, as PostgreSQL writes one.
pub(crate) fn uuid(name: &str, value: &str) -> Result<(), Invalid> {
    let ok = value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        });
    if ok {
        Ok(())
    } else {
        invalid(format!("{name} is a lowercase uuid, not {value:?}"))
    }
}

/// 64 lowercase hex digits.
pub(crate) fn sha256_hex(name: &str, value: &str) -> Result<(), Invalid> {
    let ok = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(())
    } else {
        invalid(format!("{name} is 64 lowercase hex digits"))
    }
}

/// The contracts' timestamp: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`
/// (delphi-job-result/1's `ISO_8601`), checked without a regex engine.
pub(crate) fn timestamp(name: &str, value: &str) -> Result<(), Invalid> {
    let b = value.as_bytes();
    let digits = |from: usize, to: usize| {
        b.get(from..to)
            .is_some_and(|s| s.iter().all(u8::is_ascii_digit))
    };
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let mut ok = digits(0, 4)
        && at(4, b'-')
        && digits(5, 7)
        && at(7, b'-')
        && digits(8, 10)
        && at(10, b'T')
        && digits(11, 13)
        && at(13, b':')
        && digits(14, 16)
        && at(16, b':')
        && digits(17, 19);
    let mut i = 19;
    if ok && at(i, b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        ok = i > start;
    }
    ok = ok
        && match b.get(i) {
            Some(b'Z') => b.len() == i + 1,
            Some(b'+' | b'-') => {
                b.len() == i + 6 && digits(i + 1, i + 3) && at(i + 3, b':') && digits(i + 4, i + 6)
            }
            _ => false,
        };
    if ok {
        Ok(())
    } else {
        invalid(format!(
            "{name} is an ISO 8601 time with a zone, not {value:?}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        // Expected strings are String(x) in Node 22.
        for (x, js) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (100.0, "100"),
            (-5.0, "-5"),
            (0.5, "0.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.456, "123.456"),
            (0.000015, "0.000015"),
            (0.0000015, "0.0000015"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (-1.5e-7, "-1.5e-7"),
            (5e-324, "5e-324"),
            (9007199254740994.0, "9007199254740994"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e300, "1.5e+300"),
            (f64::MAX, "1.7976931348623157e+308"),
        ] {
            assert_eq!(js_number(x), js, "{x:e}");
            let n = JsNumber::new(x).unwrap();
            assert_eq!(to_json(&n).unwrap(), js, "{x:e}");
            let back: JsNumber = serde_json::from_str(js).unwrap();
            assert_eq!(
                back.get().to_bits(),
                if x == 0.0 {
                    0.0f64.to_bits()
                } else {
                    x.to_bits()
                }
            );
        }
        assert!(JsNumber::new(f64::NAN).is_err());
        assert!(JsNumber::new(f64::INFINITY).is_err());
        assert!(serde_json::from_str::<JsNumber>("null").is_err());
    }

    #[test]
    fn records_keep_javascript_key_order_and_refuse_duplicates() {
        let mut m = JsMap::<String, u8>::new();
        for (k, v) in [
            ("b", 1),
            ("10", 2),
            ("a", 3),
            ("2", 4),
            ("01", 5),
            ("4294967295", 6),
        ] {
            m.insert(k.to_owned(), v).unwrap();
        }
        assert_eq!(
            to_json(&m).unwrap(),
            r#"{"2":4,"10":2,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
        assert!(m.insert("a".to_owned(), 9).is_err());
        assert!(serde_json::from_str::<JsMap<String, u8>>(r#"{"a":1,"a":2}"#).is_err());
        let read: JsMap<String, u8> = serde_json::from_str(r#"{"z":1,"y":2}"#).unwrap();
        assert_eq!(to_json(&read).unwrap(), r#"{"z":1,"y":2}"#);
    }

    #[test]
    fn any_value_round_trips_with_its_key_order() {
        let text = r#"{"z":[1,0.25,{"b":null,"a":true}],"y":"\u0007\"\\é","1":-1e-7}"#;
        let value: Json = serde_json::from_str(text).unwrap();
        assert_eq!(
            to_json(&value).unwrap(),
            r#"{"1":-1e-7,"z":[1,0.25,{"b":null,"a":true}],"y":"\u0007\"\\é"}"#
        );
    }

    #[test]
    fn string_rules() {
        for ok in [
            "2026-10-03T12:00:00Z",
            "2026-10-03T12:00:00.000Z",
            "2026-10-03T12:00:01.000001+00:00",
            "2026-10-03T12:00:01-07:00",
        ] {
            assert!(timestamp("t", ok).is_ok(), "{ok}");
        }
        for bad in [
            "2023-11-14T19:20:01.000000",
            "2026-10-03 12:00:00Z",
            "2026-10-03T12:00:00.Z",
            "2026-10-03T12:00:00+0000",
            "2026-10-03T12:00:00Z\n",
            "",
        ] {
            assert!(timestamp("t", bad).is_err(), "{bad}");
        }
        assert!(uuid("u", "0000a001-0000-4000-8000-000000000001").is_ok());
        assert!(uuid("u", "0000A001-0000-4000-8000-000000000001").is_err());
        assert!(uuid("u", "batch_report_r1_1_x").is_err());
        assert!(sha256_hex("s", &"a".repeat(64)).is_ok());
        assert!(sha256_hex("s", &"A".repeat(64)).is_err());
        assert!(array_index("0").is_some() && array_index("4294967294").is_some());
        assert!(array_index("4294967295").is_none() && array_index("-1").is_none());
    }
}
