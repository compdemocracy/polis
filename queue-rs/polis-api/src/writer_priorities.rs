//! Generation-scoped validated weights. Admission materializes the narrow SQL
//! result first, releases its connection, then parses on a blocking CPU task.
use crate::js::{self, Js};
use anyhow::{Context, Result, bail};
use postgres::Client;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

const MAX_ENTRIES: usize = 128;
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
type Key = (i32, String, i64);

#[derive(Clone, Copy, Debug, PartialEq)]
enum Weight {
    Null,
    False,
    Number(f64),
}
#[derive(Default)]
pub(super) struct Weights(HashMap<String, Weight>);
impl Weights {
    fn parse(text: Option<&str>) -> Result<Self> {
        let Some(text) = text else {
            return Ok(Self::default());
        };
        let value = js::parse(text)?;
        let object = value.as_obj().context("unsupported priority shape")?;
        let mut weights = HashMap::new();
        for (key, value) in object.iter() {
            let weight = match value {
                Js::Null => Weight::Null,
                Js::Bool(false) => Weight::False,
                Js::Num(n) if n.is_finite() && *n >= 0.0 => Weight::Number(*n),
                _ => bail!("unsupported priority value"),
            };
            weights.insert(key.clone(), weight);
        }
        Ok(Self(weights))
    }
    pub(super) fn select(&self, tids: &[i32], unit: f64) -> Result<(usize, f64)> {
        let mut cumulative = Vec::with_capacity(tids.len());
        let mut total = 0.0;
        for tid in tids {
            total += match self.0.get(&tid.to_string()) {
                Some(Weight::Number(n)) if *n != 0.0 => *n,
                _ => 1.0,
            };
            cumulative.push(total);
        }
        let random = unit * total;
        let selected = cumulative
            .iter()
            .position(|n| *n > random)
            .context("no weighted candidate")?;
        Ok((selected, random))
    }
}

struct Entry {
    text: Mutex<Option<String>>,
    parsed: OnceLock<std::result::Result<Arc<Weights>, String>>,
    charge: usize,
}
impl Entry {
    fn value(&self) -> Result<Arc<Weights>> {
        self.parsed
            .get_or_init(|| {
                let text = self
                    .text
                    .lock()
                    .map_err(|_| "priority text lock poisoned".to_owned())?
                    .take();
                Weights::parse(text.as_deref())
                    .map(Arc::new)
                    .map_err(|e| e.to_string())
            })
            .clone()
            .map_err(anyhow::Error::msg)
    }
}
#[derive(Default)]
struct Entries {
    values: HashMap<Key, Arc<Entry>>,
    bytes: usize,
}
#[derive(Default)]
pub(super) struct Cache {
    entries: Mutex<Entries>,
}

pub(super) struct Snapshot {
    cache: Arc<Cache>,
    key: Option<Key>,
    cached: Option<Arc<Entry>>,
    text: Option<String>,
}
impl Snapshot {
    #[cfg(all(test, feature = "db-tests"))]
    pub(super) fn raw_for_test(self) -> Result<Option<Js>> {
        self.text.map(|text| js::parse(&text)).transpose()
    }

    pub(super) fn validate(self) -> Result<Arc<Weights>> {
        let Some(key) = self.key else {
            return Ok(Arc::new(Weights::default()));
        };
        if let Some(cached) = self.cached {
            return cached.value();
        }
        let entry = {
            let mut entries = self
                .cache
                .entries
                .lock()
                .map_err(|_| anyhow::anyhow!("priority cache lock poisoned"))?;
            if let Some(entry) = entries.values.get(&key) {
                entry.clone()
            } else {
                // Charge text plus a conservative upper bound for the retained
                // hash table, strings and entry metadata before publishing it.
                let charge = self
                    .text
                    .as_ref()
                    .map_or(0, String::len)
                    .saturating_mul(32)
                    .saturating_add(4096);
                anyhow::ensure!(charge <= MAX_BYTES, "priority map exceeds cache budget");
                while entries.values.len() >= MAX_ENTRIES
                    || entries.bytes.saturating_add(charge) > MAX_BYTES
                {
                    let expired = entries
                        .values
                        .iter()
                        .find(|(_, entry)| {
                            Arc::strong_count(entry) == 1
                                && entry.parsed.get().is_none_or(|result| {
                                    result
                                        .as_ref()
                                        .map_or(true, |weights| Arc::strong_count(weights) == 1)
                                })
                        })
                        .map(|(key, _)| key.clone())
                        .context("priority cache is busy")?;
                    let removed = entries
                        .values
                        .remove(&expired)
                        .context("priority cache entry missing")?;
                    entries.bytes -= removed.charge;
                }
                let entry = Arc::new(Entry {
                    text: Mutex::new(self.text),
                    parsed: OnceLock::new(),
                    charge,
                });
                entries.bytes += charge;
                entries.values.insert(key, entry.clone());
                entry
            }
        };
        entry.value()
    }
}
impl Cache {
    pub(super) fn snapshot(
        self: &Arc<Self>,
        c: &mut Client,
        zid: i32,
        env: &str,
    ) -> Result<Snapshot> {
        // A hit reads only the committed tick, never any expression on data:
        // even jsonb_typeof would decompress the entire math result.
        let row = c.query_opt(
            "select math_tick from math_main where zid=$1 and math_env=$2 and math_tick>=0",
            &[&zid, &env],
        )?;
        let empty = || Snapshot {
            cache: self.clone(),
            key: None,
            cached: None,
            text: None,
        };
        let Some(row) = row else { return Ok(empty()) };
        let tick: i64 = row.try_get(0)?;
        let key = (zid, env.to_owned(), tick);
        let cached = self
            .entries
            .lock()
            .map_err(|_| anyhow::anyhow!("priority cache lock poisoned"))?
            .values
            .get(&key)
            .cloned();
        if let Some(cached) = cached {
            return Ok(Snapshot {
                cache: self.clone(),
                key: Some(key),
                cached: Some(cached),
                text: None,
            });
        }
        // Publication may advance between the two statements. Use the tick
        // returned WITH the text, so a new map can never enter an older key.
        let row = c.query_opt(
            "with current as materialized (
                 select math_tick,jsonb_typeof(data) as shape,
                 (data->'comment-priorities')::text as weights
                 from math_main where zid=$1 and math_env=$2 and math_tick>=0
             ) select math_tick,shape,octet_length(weights),
               case when octet_length(weights)>$3 then null else weights end from current",
            &[&zid, &env, &(MAX_TEXT_BYTES as i32)],
        )?;
        let Some(row) = row else { return Ok(empty()) };
        anyhow::ensure!(
            row.try_get::<_, Option<String>>(1)?.as_deref() == Some("object"),
            "unsupported math shape"
        );
        let tick: i64 = row.try_get(0)?;
        anyhow::ensure!(
            row.try_get::<_, Option<i32>>(2)?.unwrap_or(0) as usize <= MAX_TEXT_BYTES,
            "priority map exceeds text budget"
        );
        Ok(Snapshot {
            cache: self.clone(),
            key: Some((zid, env.into(), tick)),
            cached: None,
            text: row.try_get(3)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_weights_keep_node_fallbacks_and_reject_unsupported_values() {
        let weights = Weights::parse(Some(r#"{"0":null,"1":false,"2":0,"3":3}"#)).unwrap();
        let source = js::parse(r#"{"0":null,"1":false,"2":0,"3":3}"#).unwrap();
        for unit in [0.0, 0.1, 0.4, 0.7, 0.9999] {
            assert_eq!(
                weights.select(&[0, 1, 2, 3, 4], unit).unwrap(),
                crate::next_comment::select(&[0, 1, 2, 3, 4], source.as_obj(), unit).unwrap()
            );
        }
        for bad in [
            "null",
            "false",
            "[]",
            r#"{"0":true}"#,
            r#"{"0":-0.5}"#,
            r#"{"unused":1e999}"#,
            r#"{"0":"2"}"#,
        ] {
            assert!(Weights::parse(Some(bad)).is_err(), "{bad}");
        }
        assert!(Weights::parse(None).is_ok());
    }
    #[test]
    fn concurrent_validation_shares_one_generation_and_caches_invalid_shape() {
        let cache = Arc::new(Cache::default());
        let snapshot = || Snapshot {
            cache: cache.clone(),
            key: Some((1, "test".into(), 0)),
            cached: None,
            text: Some(r#"{"1":3}"#.into()),
        };
        let pending = (0..8)
            .map(|_| {
                let s = snapshot();
                std::thread::spawn(move || s.validate().unwrap())
            })
            .collect::<Vec<_>>();
        let maps = pending
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert!(maps.iter().all(|m| Arc::ptr_eq(&maps[0], m)));
        let invalid = Snapshot {
            cache: cache.clone(),
            key: Some((1, "test".into(), 1)),
            cached: None,
            text: Some("null".into()),
        };
        assert!(invalid.validate().is_err());
        let same = Snapshot {
            cache: cache.clone(),
            key: Some((1, "test".into(), 1)),
            cached: None,
            text: Some("{}".into()),
        };
        assert!(
            same.validate().is_err(),
            "same generation must retain its invalid result"
        );
        for tick in 2..260 {
            Snapshot {
                cache: cache.clone(),
                key: Some((1, "test".into(), tick)),
                cached: None,
                text: Some("{}".into()),
            }
            .validate()
            .unwrap();
        }
        let entries = cache.entries.lock().unwrap();
        assert!(
            entries.values.contains_key(&(1, "test".into(), 0)),
            "a generation used by active work must remain resident"
        );
        assert!(entries.values.len() <= MAX_ENTRIES);
        assert!(entries.bytes <= MAX_BYTES);
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[test]
fn resident_generation_reads_only_tick_and_new_generation_reads_data() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = Client::connect(&url, postgres::NoTls).unwrap();
    let schema = format!("priority_tick_{}", std::process::id());
    c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE published_math(zid integer,math_env text,math_tick bigint,data jsonb);
        INSERT INTO published_math VALUES(1,'test',0,'{{\"comment-priorities\":{{\"0\":3}}}}');
        CREATE FUNCTION read_data(value jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS
        $$ BEGIN IF current_setting('test.allow_data',true) = 'no' THEN
            RAISE EXCEPTION 'resident generation read data'; END IF; RETURN value; END $$;
        CREATE VIEW math_main AS SELECT zid,math_env,math_tick,read_data(data) AS data FROM published_math;" )).unwrap();
    let cache = Arc::new(Cache::default());
    let first = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    c.batch_execute("SET test.allow_data='no'").unwrap();
    let hit = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert!(Arc::ptr_eq(&first, &hit));
    c.batch_execute("UPDATE published_math SET math_tick=1")
        .unwrap();
    assert!(
        cache.snapshot(&mut c, 1, "test").is_err(),
        "a new generation must read its data"
    );
    c.batch_execute("SET test.allow_data='yes'; UPDATE published_math SET data='{\"comment-priorities\":{\"0\":7}}'").unwrap();
    let second = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(second.select(&[0], 0.5).unwrap(), (0, 3.5));
    c.batch_execute("SET test.allow_data='no'; UPDATE published_math SET math_tick=0")
        .unwrap();
    let older = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert!(
        Arc::ptr_eq(&first, &older),
        "a retained older tick also avoids reading data"
    );
    c.batch_execute("DELETE FROM published_math").unwrap();
    let missing = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(missing.select(&[0], 0.5).unwrap(), (0, 0.5));
    c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
}
