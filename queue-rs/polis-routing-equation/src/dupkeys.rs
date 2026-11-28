//! A walk over raw JSON that refuses a key given twice in one object, before
//! any map is built (a parsed map would keep only the last).

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::collections::BTreeSet;
use std::fmt;

struct Checked;

impl<'de> Deserialize<'de> for Checked {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(Walk)
    }
}

struct Walk;

impl<'de> Visitor<'de> for Walk {
    type Value = Checked;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, _: bool) -> Result<Checked, E> {
        Ok(Checked)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Checked, E> {
        Ok(Checked)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Checked, E> {
        Ok(Checked)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Checked, E> {
        Ok(Checked)
    }
    fn visit_str<E>(self, _: &str) -> Result<Checked, E> {
        Ok(Checked)
    }
    fn visit_unit<E>(self) -> Result<Checked, E> {
        Ok(Checked)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Checked, A::Error> {
        while seq.next_element::<Checked>()?.is_some() {}
        Ok(Checked)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Checked, A::Error> {
        let mut seen = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if seen.contains(&key) {
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            map.next_value::<Checked>()?;
            seen.insert(key);
        }
        Ok(Checked)
    }
}

/// `Ok` when the text is JSON with no key repeated within one object.
pub(crate) fn check(json: &str) -> Result<(), String> {
    serde_json::from_str::<Checked>(json)
        .map(|_| ())
        .map_err(|e| e.to_string())
}
