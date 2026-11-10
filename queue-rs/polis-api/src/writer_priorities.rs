//! Generation-scoped validated weights. Admission materializes the narrow SQL
//! result first, releases its connection, then parses on a blocking CPU task.
use crate::js::{self, Js};
use anyhow::{Context, Result, bail};
use postgres::Client;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 128;
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// Sets the cache's byte bound for a process with a smaller memory limit (the
/// shadow service). Unset, the bound is `MAX_BYTES`, as it has always been.
const MAX_BYTES_SETTING: &str = "POLIS_API_WRITER_PRIORITIES_CACHE_BYTES";
type Key = (i32, String, i64);
/// After the first read of a generation fails, this process does not read
/// that generation's `data` again until this much time has passed (or the
/// generation changes). The reads pool's statement timeout does not bound the
/// read: the server finishes decompressing and scanning the document before
/// it reports the cancel, so a document too large to read in time would
/// otherwise hold one of the two admission connections for that whole time on
/// every vote, with every other conversation's votes waiting behind it.
const FAILED_READ_RETRY: Duration = Duration::from_secs(30);
/// Conversations with a remembered failed read, at most.
const MAX_FAILED_READS: usize = 1024;

/// The first read of this generation failed less than `FAILED_READ_RETRY`
/// ago in this process; `data` is not read again yet.
#[derive(Debug)]
pub(super) struct FirstReadDeferred;
impl std::fmt::Display for FirstReadDeferred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("priority read failed for this generation and is not repeated yet")
    }
}
impl std::error::Error for FirstReadDeferred {}

/// Every resident generation is held by work in progress, so none can be
/// evicted. Its own type lets observe mode report the reason; the message is
/// the one this refusal has always carried.
#[derive(Debug)]
pub(super) struct CacheBusy;
impl std::fmt::Display for CacheBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("priority cache is busy")
    }
}
impl std::error::Error for CacheBusy {}

/// The configured byte bound: `MAX_BYTES` unless the setting names a positive
/// number of bytes.
pub(super) fn max_bytes_from_env() -> Result<usize> {
    match std::env::var(MAX_BYTES_SETTING)
        .ok()
        .filter(|value| !value.is_empty())
    {
        None => Ok(MAX_BYTES),
        Some(value) => {
            let bytes = value
                .parse::<usize>()
                .ok()
                .filter(|bytes| *bytes > 0)
                .with_context(|| {
                    format!("{MAX_BYTES_SETTING} must be a positive number of bytes")
                })?;
            Ok(bytes)
        }
    }
}

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
pub(super) struct Cache {
    entries: Mutex<Entries>,
    max_bytes: usize,
    /// Per conversation and environment: the generation whose first read
    /// last failed here, and when.
    failed: Mutex<HashMap<(i32, String), (i64, Instant)>>,
    retry: Duration,
    /// First reads of `data` this cache has sent, for the tests that count
    /// them.
    #[cfg(test)]
    pub(super) first_reads: std::sync::atomic::AtomicUsize,
}
impl Default for Cache {
    fn default() -> Self {
        Self::with_max_bytes(MAX_BYTES)
    }
}
impl Cache {
    pub(super) fn with_max_bytes(max_bytes: usize) -> Self {
        Self {
            entries: Mutex::default(),
            max_bytes,
            failed: Mutex::default(),
            retry: FAILED_READ_RETRY,
            #[cfg(test)]
            first_reads: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// A cache that repeats a failed first read after `retry`.
    #[cfg(all(test, feature = "db-tests"))]
    fn with_retry(retry: Duration) -> Self {
        Self {
            retry,
            ..Self::default()
        }
    }

    /// Whether the first read of this generation failed here less than
    /// `retry` ago. A failure of another generation, or an older one, is
    /// forgotten.
    fn failed_recently(&self, zid: i32, env: &str, tick: i64) -> bool {
        let Ok(mut failed) = self.failed.lock() else {
            return false;
        };
        let key = (zid, env.to_owned());
        match failed.get(&key) {
            Some((failed_tick, at)) if *failed_tick == tick && at.elapsed() < self.retry => true,
            Some(_) => {
                failed.remove(&key);
                false
            }
            None => false,
        }
    }

    fn remember_failure(&self, zid: i32, env: &str, tick: i64) {
        let Ok(mut failed) = self.failed.lock() else {
            return;
        };
        if failed.len() >= MAX_FAILED_READS {
            let retry = self.retry;
            failed.retain(|_, (_, at)| at.elapsed() < retry);
            if failed.len() >= MAX_FAILED_READS {
                failed.clear();
            }
        }
        failed.insert((zid, env.to_owned()), (tick, Instant::now()));
    }
}

pub(super) struct Snapshot {
    cache: Arc<Cache>,
    key: Option<Key>,
    cached: Option<Arc<Entry>>,
    text: Option<String>,
}
impl Snapshot {
    /// The math generation these weights come from; None without a committed one.
    pub(super) fn tick(&self) -> Option<i64> {
        self.key.as_ref().map(|(_, _, tick)| *tick)
    }

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
                let max_bytes = self.cache.max_bytes;
                anyhow::ensure!(charge <= max_bytes, "priority map exceeds cache budget");
                while entries.values.len() >= MAX_ENTRIES
                    || entries.bytes.saturating_add(charge) > max_bytes
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
                        .ok_or(CacheBusy)?;
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
        // A generation whose first read failed a moment ago is refused here,
        // after the tick-only read and before any expression on data. Any
        // failure counts: a timeout, a statement error, a document that is
        // not an object, a map over the text budget. Two votes can each start
        // the first read of a new generation (one per reads connection)
        // before either has failed; none follows them.
        if self.failed_recently(zid, env, tick) {
            return Err(FirstReadDeferred.into());
        }
        #[cfg(test)]
        self.first_reads
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match read_generation(c, zid, env) {
            Ok(None) => Ok(empty()),
            Ok(Some((tick, text))) => Ok(Snapshot {
                cache: self.clone(),
                key: Some((zid, env.into(), tick)),
                cached: None,
                text,
            }),
            Err(error) => {
                self.remember_failure(zid, env, tick);
                Err(error)
            }
        }
    }
}

/// The first read of a generation: its tick and the text of its priorities
/// (None when the document has none). None when no committed row is there.
fn read_generation(c: &mut Client, zid: i32, env: &str) -> Result<Option<(i64, Option<String>)>> {
    // Publication may advance between the two statements. Use the tick
    // returned WITH the text, so a new map can never enter an older key.
    //
    // `data` is jsonb in a database built from the migrations and json in
    // installations older than them. Nothing here remembers which: the
    // server resolves `->` and the CASE below against the column it is
    // reading, each time the statement runs. Only the arm of the column's
    // own type is evaluated, and its cast is to the type the column
    // already has, so it does nothing; the other arm's cast, which would
    // convert the whole document, never runs. A column of any other type
    // has no `->` and fails the statement.
    let row = c.query_opt(
        "with current as materialized (
             select math_tick,
             case pg_typeof(data)
               when 'pg_catalog.jsonb'::regtype then jsonb_typeof(data::jsonb)
               when 'pg_catalog.json'::regtype then json_typeof(data::json)
             end as shape,
             (data->'comment-priorities')::text as weights
             from math_main where zid=$1 and math_env=$2 and math_tick>=0
         ) select math_tick,shape,octet_length(weights),
           case when octet_length(weights)>$3 then null else weights end from current",
        &[&zid, &env, &(MAX_TEXT_BYTES as i32)],
    )?;
    let Some(row) = row else { return Ok(None) };
    anyhow::ensure!(
        row.try_get::<_, Option<String>>(1)?.as_deref() == Some("object"),
        "unsupported math shape"
    );
    let tick: i64 = row.try_get(0)?;
    anyhow::ensure!(
        row.try_get::<_, Option<i32>>(2)?.unwrap_or(0) as usize <= MAX_TEXT_BYTES,
        "priority map exceeds text budget"
    );
    Ok(Some((tick, row.try_get(3)?)))
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

/// The two types `math_main.data` has: jsonb in a database built from the
/// migrations, json in installations older than them.
#[cfg(all(test, feature = "db-tests"))]
const DATA_TYPES: [&str; 2] = ["jsonb", "json"];

#[cfg(all(test, feature = "db-tests"))]
#[test]
fn resident_generation_reads_only_tick_and_new_generation_reads_data() {
    for data_type in DATA_TYPES {
        resident_generation(data_type);
    }
}

#[cfg(all(test, feature = "db-tests"))]
fn resident_generation(data_type: &str) {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = Client::connect(&url, postgres::NoTls).unwrap();
    let schema = format!("priority_tick_{data_type}_{}", std::process::id());
    c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE published_math(zid integer,math_env text,math_tick bigint,data {data_type});
        INSERT INTO published_math VALUES(1,'test',0,'{{\"comment-priorities\":{{\"0\":3}}}}');
        CREATE FUNCTION read_data(value {data_type}) RETURNS {data_type} LANGUAGE plpgsql STABLE AS
        $$ BEGIN IF current_setting('test.allow_data',true) = 'no' THEN
            RAISE EXCEPTION 'resident generation read data'; END IF; RETURN value; END $$;
        CREATE VIEW math_main AS SELECT zid,math_env,math_tick,read_data(data) AS data FROM published_math;" )).unwrap();
    // This test repeats a refused read of one generation at once; the memory
    // of a failed read has its own test below.
    let cache = Arc::new(Cache::with_retry(Duration::ZERO));
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

/// A generation whose first read failed is not read again by this cache until
/// the generation changes or the retry time has passed, whatever the failure
/// was; the next generation and other conversations are read as before.
#[cfg(all(test, feature = "db-tests"))]
#[test]
fn failed_first_read_of_a_generation_is_not_repeated_at_once() {
    for data_type in DATA_TYPES {
        failed_first_read(data_type);
    }
}

#[cfg(all(test, feature = "db-tests"))]
fn failed_first_read(data_type: &str) {
    use std::sync::atomic::Ordering::SeqCst;
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = Client::connect(&url, postgres::NoTls).unwrap();
    let schema = format!("priority_failed_{data_type}_{}", std::process::id());
    // `test.data`: `timeout` fails a read of data the way the statement
    // timeout does, `no` fails it with another error, anything else reads it.
    c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE published_math(zid integer,math_env text,math_tick bigint,data {data_type});
        INSERT INTO published_math VALUES(1,'test',0,'{{\"comment-priorities\":{{\"0\":3}}}}'),
            (2,'test',0,'{{\"comment-priorities\":{{\"0\":5}}}}'),(3,'test',0,'[1]');
        CREATE FUNCTION read_data(value {data_type}) RETURNS {data_type} LANGUAGE plpgsql STABLE AS
        $$ BEGIN
            IF current_setting('test.data',true) = 'timeout' THEN
                RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = 'query_canceled';
            ELSIF current_setting('test.data',true) = 'no' THEN
                RAISE EXCEPTION 'data was read';
            END IF;
            RETURN value;
        END $$;
        CREATE VIEW math_main AS SELECT zid,math_env,math_tick,read_data(data) AS data FROM published_math;" )).unwrap();
    let refused = |result: Result<Snapshot>| match result {
        Ok(_) => panic!("the read was not refused ({data_type})"),
        Err(error) => error,
    };
    let cache = Arc::new(Cache::default());
    c.batch_execute("SET test.data='timeout'").unwrap();
    let error = refused(cache.snapshot(&mut c, 1, "test"));
    assert_eq!(
        error
            .downcast_ref::<postgres::Error>()
            .and_then(postgres::Error::code),
        Some(&postgres::error::SqlState::QUERY_CANCELED),
        "{data_type}: {error}"
    );
    assert_eq!(cache.first_reads.load(SeqCst), 1);
    // The same generation again: refused without any expression on data (a
    // read of data would fail with the other error), whether or not the data
    // could now be read.
    for setting in ["no", "yes"] {
        c.batch_execute(&format!("SET test.data='{setting}'"))
            .unwrap();
        let error = refused(cache.snapshot(&mut c, 1, "test"));
        assert!(error.is::<FirstReadDeferred>(), "{data_type}: {error}");
    }
    assert_eq!(cache.first_reads.load(SeqCst), 1);
    // Another conversation is read as before.
    let other = cache
        .snapshot(&mut c, 2, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(other.select(&[0], 0.5).unwrap(), (0, 2.5));
    // A document that is not an object is remembered the same way.
    let error = refused(cache.snapshot(&mut c, 3, "test"));
    assert_eq!(error.to_string(), "unsupported math shape");
    c.batch_execute("SET test.data='no'").unwrap();
    let error = refused(cache.snapshot(&mut c, 3, "test"));
    assert!(error.is::<FirstReadDeferred>(), "{data_type}: {error}");
    // The next generation of the first conversation is read.
    c.batch_execute("SET test.data='yes'; UPDATE published_math SET math_tick=1 WHERE zid=1")
        .unwrap();
    let snapshot = cache.snapshot(&mut c, 1, "test").unwrap();
    assert_eq!(snapshot.tick(), Some(1));
    assert_eq!(
        snapshot.validate().unwrap().select(&[0], 0.5).unwrap(),
        (0, 1.5)
    );
    assert_eq!(cache.first_reads.load(SeqCst), 4);
    // Once the retry time has passed, the same generation is read again.
    let cache = Arc::new(Cache::with_retry(Duration::from_millis(50)));
    c.batch_execute("SET test.data='timeout'").unwrap();
    refused(cache.snapshot(&mut c, 2, "test"));
    c.batch_execute("SET test.data='yes'").unwrap();
    let error = refused(cache.snapshot(&mut c, 2, "test"));
    assert!(error.is::<FirstReadDeferred>(), "{data_type}: {error}");
    std::thread::sleep(Duration::from_millis(60));
    let again = cache
        .snapshot(&mut c, 2, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(again.select(&[0], 0.5).unwrap(), (0, 2.5));
    assert_eq!(cache.first_reads.load(SeqCst), 2);
    c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
}

/// What a first read of one stored document gives: where it was refused and
/// why, or the generation, the weights and what they select.
#[cfg(all(test, feature = "db-tests"))]
#[derive(Debug, PartialEq)]
enum FirstRead {
    Refused(&'static str, String),
    Weights(Option<i64>, Vec<(String, Weight)>, Vec<(usize, f64)>),
}

#[cfg(all(test, feature = "db-tests"))]
impl FirstRead {
    fn stage(&self) -> &'static str {
        match self {
            Self::Refused(stage, _) => stage,
            Self::Weights(..) => "weights",
        }
    }
    fn selections(&self) -> Vec<(usize, f64)> {
        match self {
            Self::Weights(_, _, selected) => selected.clone(),
            Self::Refused(..) => vec![],
        }
    }
}

/// A read with an empty cache, so the statement that reads `data` runs.
#[cfg(all(test, feature = "db-tests"))]
fn first_read(c: &mut Client, zid: i32) -> FirstRead {
    let cache = Arc::new(Cache::default());
    let snapshot = match cache.snapshot(c, zid, "test") {
        Ok(snapshot) => snapshot,
        Err(error) => return FirstRead::Refused("snapshot", error.to_string()),
    };
    let tick = snapshot.tick();
    let weights = match snapshot.validate() {
        Ok(weights) => weights,
        Err(error) => return FirstRead::Refused("validate", error.to_string()),
    };
    let mut map: Vec<(String, Weight)> = weights
        .0
        .iter()
        .map(|(tid, weight)| (tid.clone(), *weight))
        .collect();
    map.sort_by(|a, b| a.0.cmp(&b.0));
    let tids: Vec<i32> = (0..12).collect();
    let selected = [0.0, 0.1, 0.4, 0.7, 0.9999]
        .iter()
        .map(|unit| weights.select(&tids, *unit).unwrap())
        .collect();
    FirstRead::Weights(tick, map, selected)
}

/// The same documents stored as jsonb and as json give the same generation,
/// the same weights, the same refusals and the same selections. A json column
/// keeps a document's text as written (spacing, repeated keys, escapes,
/// number spelling); jsonb normalises it.
#[cfg(all(test, feature = "db-tests"))]
#[test]
fn json_and_jsonb_columns_give_the_same_weights_validation_and_selection() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = Client::connect(&url, postgres::NoTls).unwrap();
    let large = format!(
        "{{\"comment-priorities\":{{{}}}}}",
        (0..20000)
            .map(|tid| format!("\"{tid}\":{}", 0.5 + f64::from(tid % 101) / 107.0))
            .collect::<Vec<_>>()
            .join(",")
    );
    let documents: Vec<(&str, &str)> = vec![
        (
            "weights",
            r#"{"comment-priorities":{"0":2,"1":0.5,"2":3,"4":1.5,"9":4}}"#,
        ),
        (
            "weights",
            "{ \"n\" : 5,\n\t\"comment-priorities\" : { \"9\" : 4e0 , \"1\":5E-1,\"0\":2.0, \"2\":0, \"3\":null, \"5\":false } ,\r\n \"tids\":[1,2] }",
        ),
        (
            "weights",
            r#"{"comment-priorities":{"0":1},"comment-priorities":{"0":2,"0":3,"1":7}}"#,
        ),
        ("weights", r#"{"comment-priorities":{"1":6,"10":1.50}}"#),
        ("weights", r#"{"n":1}"#),
        ("weights", "{}"),
        ("weights", r#"{"comment-priorities":{}}"#),
        ("weights", large.as_str()),
        ("validate", r#"{"comment-priorities":null}"#),
        ("validate", r#"{"comment-priorities":[1,2]}"#),
        ("validate", r#"{"comment-priorities":7}"#),
        ("validate", r#"{"comment-priorities":{"0":-1}}"#),
        ("validate", r#"{"comment-priorities":{"0":"2"}}"#),
        ("validate", r#"{"comment-priorities":{"0":true}}"#),
        ("snapshot", "[1]"),
        ("snapshot", "3"),
        ("snapshot", "\"x\""),
        ("snapshot", "null"),
    ];
    let schema = |data_type: &str| format!("priority_types_{data_type}_{}", std::process::id());
    let mut reads: Vec<Vec<FirstRead>> = vec![];
    for data_type in DATA_TYPES {
        c.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path={schema};
             CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data {data_type});",
            schema = schema(data_type)
        ))
        .unwrap();
        for (zid, (_, document)) in documents.iter().enumerate() {
            c.execute(
                &format!("INSERT INTO math_main VALUES($1,'test',$2,$3::text::{data_type})"),
                &[&(zid as i32), &(zid as i64 + 5), document],
            )
            .unwrap();
        }
        reads.push(
            (0..documents.len())
                .map(|zid| first_read(&mut c, zid as i32))
                .collect(),
        );
    }
    for (zid, (stage, document)) in documents.iter().enumerate() {
        let shown = &document[..document.len().min(80)];
        assert_eq!(
            reads[0][zid], reads[1][zid],
            "jsonb and json differ: {shown}"
        );
        assert_eq!(
            reads[0][zid].stage(),
            *stage,
            "{shown}: {:?}",
            reads[0][zid]
        );
        if let FirstRead::Refused("snapshot", reason) = &reads[1][zid] {
            assert_eq!(reason, "unsupported math shape", "{shown}");
        }
        if let FirstRead::Weights(tick, ..) = &reads[1][zid] {
            assert_eq!(*tick, Some(zid as i64 + 5), "{shown}");
        }
    }
    assert_eq!(
        reads[1][2],
        FirstRead::Weights(
            Some(7),
            vec![
                ("0".into(), Weight::Number(3.0)),
                ("1".into(), Weight::Number(7.0))
            ],
            reads[0][2].selections()
        ),
        "the last of a repeated key is the one read, on both types"
    );
    // A json column can hold a document jsonb cannot (a number beyond
    // numeric's range). Its priorities are read: the document is never
    // converted to jsonb.
    let beyond = r#"{"n":1e1000000,"comment-priorities":{"0":2}}"#;
    assert!(c.query("select $1::text::jsonb", &[&beyond]).is_err());
    c.execute(
        "INSERT INTO math_main VALUES(1000,'test',1,$1::text::json)",
        &[&beyond],
    )
    .unwrap();
    assert!(
        matches!(
            first_read(&mut c, 1000),
            FirstRead::Weights(Some(1), map, _) if map == vec![("0".to_string(), Weight::Number(2.0))]
        ),
        "a json document is read without a conversion to jsonb"
    );
    // Nothing remembers the column's type. On this one connection the same
    // statement reads the same weights after the type changes under it, in
    // either direction.
    c.batch_execute(
        "DELETE FROM math_main WHERE zid=1000;
         ALTER TABLE math_main ALTER COLUMN data TYPE jsonb",
    )
    .unwrap();
    assert_eq!(first_read(&mut c, 1), reads[0][1], "json, then jsonb");
    c.batch_execute("ALTER TABLE math_main ALTER COLUMN data TYPE json")
        .unwrap();
    assert_eq!(first_read(&mut c, 1), reads[0][1], "jsonb, then json");
    // A column of any other type is refused by the statement itself.
    c.batch_execute("ALTER TABLE math_main ALTER COLUMN data TYPE text")
        .unwrap();
    assert_eq!(first_read(&mut c, 0).stage(), "snapshot");
    for data_type in DATA_TYPES {
        c.batch_execute(&format!("DROP SCHEMA {} CASCADE", schema(data_type)))
            .unwrap();
    }
}
