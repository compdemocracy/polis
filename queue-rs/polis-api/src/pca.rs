//! The math read behind the route: `getPca`, `processMathObject`,
//! `ensureCompletePcaStructure` and `presentPca` from the Node server
//! (`server/src/utils/pca.ts`, `server/src/utils/pcaPresentation.ts`),
//! including their 3-second freshness windows and committed-generation reuse.

#[path = "pca_cache.rs"]
mod cache;
use cache::Cache;

use crate::{
    clock::now_ms,
    compress,
    db::{self, Pool},
    js::{self, Js, Obj, number_to_string, string_to_number},
};
use anyhow::{Result, bail};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

pub const DEFAULT_CACHE_BYTES: usize = 192 * 1024 * 1024;

/// One cache entry: the engine-facing structure and its stored gzip body
/// (`PcaCacheItem.asPOJO` and `asBufferOfGzippedJson`).
#[derive(Clone, Debug)]
pub struct PcaItem {
    pub pojo: Arc<Obj>,
    pub gzip: Arc<[u8]>,
    pub expiration: f64,
    /// The empty presentation made up for a conversation with no row. It has
    /// no generation, so the route gives it no generation tag.
    pub synthesized: bool,
    reusable: bool,
    retained_bytes: usize,
}

impl PcaItem {
    pub fn math_tick(&self) -> f64 {
        self.pojo.get("math_tick").map_or(f64::NAN, js_number)
    }
}

// Arc allocation headers are two usize counters. The object charge includes
// Vec/String capacities recursively; JSON serialization is temporary.
fn item_bytes(pojo: &Obj, gzip: usize) -> usize {
    let header = 2 * std::mem::size_of::<usize>();
    js::allocation_bytes(header + std::mem::size_of::<PcaItem>())
        .saturating_add(js::allocation_bytes(header + std::mem::size_of::<Obj>()))
        .saturating_add(pojo.retained_bytes())
        .saturating_add(js::allocation_bytes(header + gzip))
}

fn answer(item: Arc<PcaItem>, requested_tick: f64) -> Option<Arc<PcaItem>> {
    if requested_tick == -1.0 || item.math_tick() > requested_tick {
        Some(item)
    } else {
        None
    }
}

/// `Number(v)` for a JSON value.
fn js_number(v: &Js) -> f64 {
    match v {
        Js::Null => 0.0,
        Js::Bool(b) => f64::from(u8::from(*b)),
        Js::Num(n) => *n,
        Js::Str(s) => string_to_number(s),
        Js::Arr(a) if a.is_empty() => 0.0,
        Js::Arr(a) if a.len() == 1 => js_number(&Js::Str(a[0].to_js_string())),
        Js::Arr(_) | Js::Obj(_) => f64::NAN,
    }
}

#[derive(Clone)]
struct Presentation {
    source: Arc<PcaItem>,
    presented: Arc<PcaItem>,
    expiration: f64,
}

// An uncommitted row still answers existing joiners. Keep its unprocessed
// object because callers can request different ticks; the early no-update
// answer must not process a body that this caller would never have read.
#[derive(Clone)]
enum MathRefresh {
    Ready(Arc<PcaItem>, &'static str),
    Uncommitted { pojo: Arc<Obj>, expiration: f64 },
}

impl MathRefresh {
    fn expiration(&self) -> f64 {
        match self {
            Self::Ready(item, _) => item.expiration,
            Self::Uncommitted { expiration, .. } => *expiration,
        }
    }
}

// Only pca2 callers in this instance can wait on these per-conversation
// flights. Completed errors go to existing joiners, never to a later request.
struct Refreshes<T>(Mutex<HashMap<i32, Weak<Flight<T>>>>);

struct Flight<T> {
    value: Arc<tokio::sync::Mutex<Option<std::result::Result<T, RefreshError>>>>,
    failed: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
struct RefreshError {
    message: String,
    unavailable: bool,
}

impl RefreshError {
    fn error(&self) -> anyhow::Error {
        if self.unavailable {
            db::Unavailable(self.message.clone()).into()
        } else {
            anyhow::anyhow!(self.message.clone())
        }
    }
}

struct Refresh<T> {
    flight: Arc<Flight<T>>,
    value: tokio::sync::OwnedMutexGuard<Option<std::result::Result<T, RefreshError>>>,
}

impl<T: Clone + Send + 'static> Refresh<T> {
    fn shared(&self) -> Result<Option<T>> {
        self.value
            .as_ref()
            .map(|v| v.clone().map_err(|e| e.error()))
            .transpose()
    }

    fn complete(&mut self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => {
                *self.value = Some(Ok(value.clone()));
                Ok(value)
            }
            Err(error) => {
                self.fail(&error, db::is_unavailable(&error));
                Err(error)
            }
        }
    }

    fn fail(&mut self, error: &anyhow::Error, unavailable: bool) {
        *self.value = Some(Err(RefreshError {
            message: format!("{error:#}"),
            unavailable,
        }));
        self.flight
            .failed
            .store(true, std::sync::atomic::Ordering::Release);
    }

    async fn read<R, F>(self, pool: &Arc<Pool>, read: F) -> Result<(Self, R)>
    where
        R: Send + 'static,
        F: FnOnce(&mut postgres::Client) -> Result<R> + Send + 'static,
    {
        // Keep the lease recoverable if acquisition fails before the closure
        // runs. Once it starts, the blocking operation owns the lease until
        // its read ends, even if the HTTP future is cancelled.
        let handoff = Arc::new(Mutex::new(Some(self)));
        let dispatched = handoff.clone();
        let result = pool
            .with(move |c| {
                let mut refresh = lock(&dispatched)?
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("refresh already dispatched"))?;
                match read(c) {
                    Ok(row) => Ok((refresh, row)),
                    Err(error) => {
                        refresh.fail(&error, true);
                        Err(error)
                    }
                }
            })
            .await;
        if let Err(error) = &result
            && let Some(mut refresh) = lock(&handoff)?.take()
        {
            refresh.fail(error, true);
        }
        result
    }
}

impl<T> Refreshes<T> {
    async fn acquire(&self, zid: i32, timeout: std::time::Duration) -> Result<Refresh<T>> {
        let flight = {
            let mut entries = lock(&self.0)?;
            if let Some(flight) = entries
                .get(&zid)
                .and_then(Weak::upgrade)
                .filter(|f| !f.failed.load(std::sync::atomic::Ordering::Acquire))
            {
                flight
            } else {
                entries.retain(|_, entry| entry.strong_count() != 0);
                let flight = Arc::new(Flight {
                    value: Arc::new(tokio::sync::Mutex::new(None)),
                    failed: std::sync::atomic::AtomicBool::new(false),
                });
                entries.insert(zid, Arc::downgrade(&flight));
                flight
            }
        };
        // A joiner can wait for both the leader's pool acquisition and read.
        // A leader still acquires its pool slot under the pool's own shorter
        // limit. The enclosing HTTP deadline cancels either wait if earlier.
        let value = tokio::time::timeout(timeout, flight.value.clone().lock_owned())
            .await
            .map_err(|_| db::Unavailable("pca refresh wait timed out".into()))?;
        Ok(Refresh { flight, value })
    }
}

pub struct Pca {
    db: Arc<Pool>,
    math_env: String,
    cache: Mutex<Cache>,
    refreshes: Refreshes<MathRefresh>,
    presentation_refreshes: Refreshes<Presentation>,
    /// `pcaResultsExistForZid` (routes/math.ts).
    results_exist: Mutex<HashMap<i32, bool>>,
}

const TTL_MS: f64 = 3000.0;

tokio::task_local! {
    /// The first math-cache outcome of the request being served, for the
    /// access log: "hit", "revalidated", "miss", or "none" when math was not read.
    pub static CACHE_OUTCOME: std::cell::Cell<&'static str>;
}

fn record_cache(outcome: &'static str) {
    let _ = CACHE_OUTCOME.try_with(|c| {
        if c.get() == "none" {
            c.set(outcome);
        }
    });
}

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| anyhow::anyhow!("cache lock poisoned"))
}

impl Pca {
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn startup_pools(&self) -> [&Arc<Pool>; 1] {
        // No rest pattern: new fields must be classified for this inventory.
        let Self {
            db,
            math_env: _,
            cache: _,
            results_exist: _,
            refreshes: _,
            presentation_refreshes: _,
        } = self;
        [db]
    }

    #[cfg(test)]
    pub fn new(db: Arc<Pool>, math_env: String, cache_size: usize) -> Self {
        Self::with_budget(db, math_env, cache_size, DEFAULT_CACHE_BYTES)
    }

    pub fn with_budget(db: Arc<Pool>, math_env: String, cache_size: usize, bytes: usize) -> Self {
        Self {
            db,
            math_env,
            cache: Mutex::new(Cache::new(cache_size, bytes)),
            results_exist: Mutex::new(HashMap::new()),
            refreshes: Refreshes(Mutex::new(HashMap::new())),
            presentation_refreshes: Refreshes(Mutex::new(HashMap::new())),
        }
    }

    pub fn health(&self) -> Js {
        match lock(&self.cache) {
            Ok(cache) => cache.health(),
            Err(_) => Js::Null,
        }
    }

    pub fn results_exist(&self, zid: i32) -> Result<Option<bool>> {
        Ok(lock(&self.results_exist)?.get(&zid).copied())
    }

    pub fn set_results_exist(&self, zid: i32, exists: bool) -> Result<()> {
        lock(&self.results_exist)?.insert(zid, exists);
        Ok(())
    }

    /// `getPca(zid, math_tick)`. `math_tick` is -1 for "latest"; `None` is
    /// Node's `undefined` ("nothing newer than that").
    pub async fn get_pca(&self, zid: i32, math_tick: f64) -> Result<Option<Arc<PcaItem>>> {
        let cached = lock(&self.cache)?.get(&zid);
        if let Some(item) = cached.as_ref().filter(|c| c.expiration > now_ms()) {
            record_cache("hit");
            return Ok(answer(item.clone(), math_tick));
        }
        let refresh = self
            .refreshes
            .acquire(zid, self.db.refresh_timeout())
            .await?;
        if let Some(shared) = refresh.shared()?
            && shared.expiration() > now_ms()
        {
            return self.finish_math_refresh(zid, math_tick, refresh, shared);
        }
        // A previous refresh may have finished between the initial lookup
        // and joining this flight.
        let cached = lock(&self.cache)?.get(&zid);
        if let Some(item) = cached.as_ref().filter(|c| c.expiration > now_ms()) {
            record_cache("hit");
            return Ok(answer(item.clone(), math_tick));
        }
        let reusable = cached.filter(|c| c.reusable);
        let held_tick = reusable.as_ref().map(|c| c.math_tick());
        let env = self.math_env.clone();
        // Move ownership into the blocking operation: a cancelled HTTP caller
        // cannot release this conversation while its read is still running.
        // The database permit is released before parsing or compressing.
        let (mut refresh, row) = refresh
            .read(&self.db, move |c| {
                db::math_main_refresh(c, zid, &env, held_tick)
            })
            .await
            .inspect_err(|_| {
                if held_tick.is_none() {
                    record_cache("miss");
                }
            })?;
        let built = (|| {
            let (item, outcome) = if let Some((_, None)) = row.as_ref()
                && let Some(item) = reusable
            {
                let mut renewed = (*item).clone();
                renewed.expiration = now_ms() + TTL_MS;
                (Arc::new(renewed), "revalidated")
            } else if let Some((row_tick, Some(data))) = row {
                record_cache("miss");
                let mut parsed = js::parse(&data)?;
                let Some(item) = parsed.as_obj_mut() else {
                    bail!("math_main.data is not a JSON object");
                };
                let tick = row_tick as f64;
                item.set("math_tick", Js::Num(tick));
                if tick <= -1.0 {
                    return Ok(MathRefresh::Uncommitted {
                        pojo: Arc::new(std::mem::take(item)),
                        expiration: now_ms() + TTL_MS,
                    });
                }
                let reusable = tick >= 0.0
                    && item
                        .get("lastVoteTimestamp")
                        .is_some_and(|v| matches!(v, Js::Num(_)) || v.truthy());
                let mut item = std::mem::take(item);
                process_math_object(&mut item)?;
                let mut pojo = ensure_complete(Some(item), now_ms());
                pojo.remove("zid");
                (Self::build(pojo, false, reusable)?, "miss")
            } else {
                record_cache("miss");
                (
                    Self::build(ensure_complete(None, now_ms()), true, false)?,
                    "miss",
                )
            };
            Ok(MathRefresh::Ready(item, outcome))
        })();
        let shared = refresh.complete(built)?;
        self.finish_math_refresh(zid, math_tick, refresh, shared)
    }

    fn finish_math_refresh(
        &self,
        zid: i32,
        math_tick: f64,
        mut refresh: Refresh<MathRefresh>,
        shared: MathRefresh,
    ) -> Result<Option<Arc<PcaItem>>> {
        let (item, outcome) = match shared {
            MathRefresh::Ready(item, outcome) => (item, outcome),
            MathRefresh::Uncommitted { pojo, .. } => {
                record_cache("miss");
                if pojo.get("math_tick").map_or(f64::NAN, js_number) <= math_tick {
                    return Ok(None);
                }
                let built = (|| {
                    let mut pojo = (*pojo).clone();
                    process_math_object(&mut pojo)?;
                    let mut pojo = ensure_complete(Some(pojo), now_ms());
                    pojo.remove("zid");
                    Ok(MathRefresh::Ready(Self::build(pojo, false, false)?, "miss"))
                })();
                let MathRefresh::Ready(item, outcome) = refresh.complete(built)? else {
                    unreachable!("a processed row has a body");
                };
                (item, outcome)
            }
        };
        record_cache(outcome);
        self.refreshed_answer(zid, item, math_tick)
    }

    fn refreshed_answer(
        &self,
        zid: i32,
        item: Arc<PcaItem>,
        math_tick: f64,
    ) -> Result<Option<Arc<PcaItem>>> {
        if (item.synthesized && math_tick != -1.0)
            || (!item.synthesized && item.math_tick() <= -1.0 && item.math_tick() <= math_tick)
        {
            return Ok(None);
        }
        lock(&self.cache)?.set(zid, item.clone());
        Ok(answer(item, math_tick))
    }

    /// `updatePcaCache`.
    #[cfg(test)]
    fn store(
        &self,
        zid: i32,
        pojo: Obj,
        synthesized: bool,
        reusable: bool,
    ) -> Result<Arc<PcaItem>> {
        let item = Self::build(pojo, synthesized, reusable)?;
        lock(&self.cache)?.set(zid, item.clone());
        Ok(item)
    }

    fn build(pojo: Obj, synthesized: bool, reusable: bool) -> Result<Arc<PcaItem>> {
        let json = js::stringify(&Js::Obj(pojo.clone()));
        let gzip = compress::gzip(json.as_bytes())?;
        let retained_bytes = item_bytes(&pojo, gzip.len());
        let item = Arc::new(PcaItem {
            pojo: Arc::new(pojo),
            gzip: gzip.into(),
            expiration: now_ms() + TTL_MS,
            synthesized,
            reusable,
            retained_bytes,
        });
        Ok(item)
    }

    /// `presentPca`: put the conversation's approved comments back into a
    /// blob that has none, the way the server always has.
    pub async fn present(&self, zid: i32, item: Arc<PcaItem>) -> Result<Arc<PcaItem>> {
        let empty = Obj::new();
        let pca = item.pojo.get("pca").and_then(Js::as_obj).unwrap_or(&empty);
        let no_comments = |v: Option<&Js>| !matches!(v, Some(Js::Arr(a)) if !a.is_empty());
        let fill_tids = no_comments(item.pojo.get("tids"));
        let fill_count = !matches!(item.pojo.get("n-cmts"), Some(Js::Num(n)) if *n != 0.0);
        let fill_center = no_comments(pca.get("center"));
        let fill_extremity = no_comments(pca.get("comment-extremity"));
        let fill_projection = match pca.get("comment-projection") {
            None | Some(Js::Null) => true,
            Some(Js::Arr(columns)) => columns
                .iter()
                .all(|c| matches!(c, Js::Arr(column) if column.is_empty())),
            Some(_) => false,
        };
        if !(fill_tids || fill_count || fill_center || fill_extremity || fill_projection) {
            return Ok(item);
        }
        let cached = lock(&self.cache)?.presentation(&zid);
        if let Some(p) = cached
            && Arc::ptr_eq(&p.source, &item)
            && p.expiration > now_ms()
        {
            return Ok(p.presented);
        }
        let mut refresh = self
            .presentation_refreshes
            .acquire(zid, self.db.refresh_timeout())
            .await?;
        if let Some(p) = refresh.shared()?
            && Arc::ptr_eq(&p.source, &item)
            && p.expiration > now_ms()
        {
            return Ok(p.presented.clone());
        }
        if let Some(p) = lock(&self.cache)?.presentation(&zid)
            && Arc::ptr_eq(&p.source, &item)
            && p.expiration > now_ms()
        {
            return Ok(p.presented);
        }
        let tids = if fill_tids || fill_count || fill_extremity {
            // Node serves an empty list when its own read fails. Here a failed
            // read is a 502, so nginx asks Node, which has its own database
            // connection, instead of this process guessing.
            let (returned, tids) = refresh
                .read(&self.db, move |c| db::approved_tids(c, zid))
                .await?;
            refresh = returned;
            tids
        } else {
            Vec::new()
        };
        let built = (|| {
            let mut pojo = (*item.pojo).clone();
            let mut pca = pca.clone();
            if fill_center {
                pca.set("center", Js::Arr(vec![Js::Num(0.0), Js::Num(0.0)]));
            }
            if fill_extremity {
                pca.set(
                    "comment-extremity",
                    Js::Arr(tids.iter().map(|_| Js::Num(0.0)).collect()),
                );
            }
            if fill_projection {
                pca.set("comment-projection", Js::Obj(Obj::new()));
            }
            pojo.set("pca", Js::Obj(pca));
            if fill_tids {
                pojo.set(
                    "tids",
                    Js::Arr(tids.iter().map(|t| Js::Num(f64::from(*t))).collect()),
                );
            }
            if fill_count {
                pojo.set("n-cmts", Js::Num(tids.len() as f64));
            }
            let json = js::stringify(&Js::Obj(pojo.clone()));
            let gzip = compress::gzip(json.as_bytes())?;
            let retained_bytes = item_bytes(&pojo, gzip.len());
            let presented = Arc::new(PcaItem {
                pojo: Arc::new(pojo),
                gzip: gzip.into(),
                expiration: item.expiration,
                synthesized: item.synthesized,
                reusable: item.reusable,
                retained_bytes,
            });
            let presentation = Presentation {
                source: item.clone(),
                presented: presented.clone(),
                expiration: now_ms() + TTL_MS,
            };
            Ok(presentation)
        })();
        let presentation = refresh.complete(built)?;
        let presented = presentation.presented.clone();
        lock(&self.cache)?.set_presentation(zid, presentation);
        Ok(presented)
    }
}

/// `createEmptyPcaStructure()`, key order included.
fn template(now: f64) -> Obj {
    let arr = || Js::Arr(Vec::new());
    let obj = || Js::Obj(Obj::new());
    let mut base = Obj::new();
    for k in ["x", "y", "id", "count", "members"] {
        base.set(k, arr());
    }
    let mut pca = Obj::new();
    pca.set("comps", Js::Arr(vec![arr(), arr()]));
    pca.set("center", arr());
    pca.set("comment-extremity", arr());
    pca.set("comment-projection", obj());
    let mut consensus = Obj::new();
    consensus.set("agree", arr());
    consensus.set("disagree", arr());
    let mut t = Obj::new();
    t.set("group-clusters", arr());
    t.set("base-clusters", Js::Obj(base));
    t.set("group-votes", obj());
    t.set("group-aware-consensus", obj());
    t.set("user-vote-counts", obj());
    t.set("in-conv", arr());
    t.set("n-cmts", Js::Num(0.0));
    t.set("pca", Js::Obj(pca));
    t.set("tids", arr());
    t.set("n", Js::Num(0.0));
    t.set("repness", obj());
    t.set("consensus", Js::Obj(consensus));
    t.set("votes-base", obj());
    t.set("lastModTimestamp", Js::Null);
    t.set("lastVoteTimestamp", Js::Num(now));
    t.set("comment-priorities", obj());
    t.set("math_tick", Js::Num(0.0));
    t
}

/// `ensureCompletePcaStructure(existing)`.
pub fn ensure_complete(existing: Option<Obj>, now: f64) -> Obj {
    let template = template(now);
    let Some(existing) = existing else {
        return template;
    };
    let mut merged = template.clone();
    merged.assign(&existing);
    for key in ["pca", "consensus", "base-clusters"] {
        let mut nested = template
            .get(key)
            .and_then(Js::as_obj)
            .cloned()
            .unwrap_or_default();
        for (k, v) in existing
            .get(key)
            .map(Js::spread_entries)
            .unwrap_or_default()
        {
            nested.set(&k, v);
        }
        merged.set(key, Js::Obj(nested));
    }
    for key in [
        "group-clusters",
        "in-conv",
        "tids",
        "mod-in",
        "mod-out",
        "meta-tids",
    ] {
        if !matches!(merged.get(key), Some(Js::Arr(_))) {
            merged.set(key, Js::Arr(Vec::new()));
        }
    }
    for key in [
        "group-votes",
        "group-aware-consensus",
        "user-vote-counts",
        "repness",
        "votes-base",
        "comment-priorities",
    ] {
        if !matches!(merged.get(key), Some(Js::Arr(_) | Js::Obj(_))) {
            merged.set(key, Js::Obj(Obj::new()));
        }
    }
    for key in ["n", "n-cmts"] {
        if !matches!(merged.get(key), Some(Js::Num(_))) {
            merged.set(key, Js::Num(0.0));
        }
    }
    // `existing.x || fallback`
    for (key, fallback) in [("math_tick", 0.0), ("lastVoteTimestamp", now)] {
        if !matches!(merged.get(key), Some(Js::Num(_))) {
            let value = existing
                .get(key)
                .filter(|v| v.truthy())
                .cloned()
                .unwrap_or(Js::Num(fallback));
            merged.set(key, value);
        }
    }
    merged
}

fn wrap(id: f64, val: Js) -> Js {
    let mut w = Obj::new();
    w.set("id", Js::Num(id));
    w.set("val", val);
    Js::Obj(w)
}

fn wrapped_id(w: &Js) -> f64 {
    w.as_obj()
        .and_then(|o| o.get("id"))
        .map_or(f64::NAN, js_number)
}

/// `processMathObject(o)`. An error is the TypeError Node would throw.
pub fn process_math_object(o: &mut Obj) -> Result<()> {
    // A malformed group-clusters entry empties the whole field.
    if let Some(Js::Arr(groups)) = o.get("group-clusters")
        && !groups
            .iter()
            .all(|g| matches!(g, Js::Obj(g) if matches!(g.get("id"), Some(Js::Num(_)))))
    {
        eprintln!(
            "{{\"event\":\"polis_err_math_malformed_group_clusters\",\"count\":{}}}",
            groups.len()
        );
        o.set("group-clusters", Js::Arr(Vec::new()));
    }
    // repness and group-votes are keyed objects whose entries must match the
    // producer's shape; a field with any malformed entry is presented empty.
    for field in ["repness", "group-votes"] {
        let valid = match o.get(field) {
            None | Some(Js::Null) => continue,
            Some(Js::Obj(entries)) => entries.iter().all(|(_, v)| match field {
                "repness" => matches!(v, Js::Arr(items) if items.iter().all(Js::is_plain_object)),
                _ => matches!(v, Js::Obj(g) if matches!(g.get("votes"), Some(Js::Obj(_)))),
            }),
            Some(Js::Arr(items)) => items.is_empty(),
            Some(_) => false,
        };
        if !valid {
            eprintln!(
                "{{\"event\":\"polis_err_math_malformed_{}\"}}",
                field.replace('-', "_")
            );
            o.set(field, Js::Obj(Obj::new()));
        }
    }
    if let Some(Js::Arr(groups)) = o.get("group-clusters") {
        let wrapped = groups
            .iter()
            .map(|g| {
                let id = g
                    .as_obj()
                    .and_then(|g| g.get("id"))
                    .map_or(f64::NAN, js_number);
                wrap(id, g.clone())
            })
            .collect();
        o.set("group-clusters", Js::Arr(wrapped));
    }
    for prop in [
        "repness",
        "group-votes",
        "subgroup-repness",
        "subgroup-votes",
        "subgroup-clusters",
    ] {
        if matches!(o.get(prop), Some(Js::Arr(_))) {
            continue;
        }
        let entries = match o.get(prop) {
            Some(Js::Obj(m)) => m
                .iter()
                .map(|(k, v)| wrap(string_to_number(k), v.clone()))
                .collect(),
            _ => Vec::new(),
        };
        o.set(prop, Js::Arr(entries));
    }
    for field in ["repness", "group-votes"] {
        let mut out = Obj::new();
        if let Some(Js::Arr(entries)) = o.get(field) {
            for entry in entries {
                let Some(mut val) = entry.as_obj().and_then(|e| e.get("val")).cloned() else {
                    continue;
                };
                if !matches!(val, Js::Arr(_) | Js::Obj(_)) {
                    continue;
                }
                let id = wrapped_id(entry);
                // An array value takes the `id` property too, but JSON never
                // prints a non-index property of an array.
                if let Js::Obj(v) = &mut val {
                    v.set("id", Js::Num(id));
                }
                out.set(&number_to_string(id), val);
            }
        }
        o.set(field, Js::Obj(out));
    }
    let groups = match o.get("group-clusters") {
        None => Vec::new(),
        Some(v) if !v.truthy() => Vec::new(),
        Some(Js::Arr(entries)) => entries
            .iter()
            .map(|w| {
                let id = wrapped_id(w);
                let mut g = w
                    .as_obj()
                    .and_then(|w| w.get("val"))
                    .cloned()
                    .unwrap_or(Js::Null);
                match &mut g {
                    Js::Obj(g) => g.set("id", Js::Num(id)),
                    Js::Arr(_) => {}
                    _ => bail!("TypeError: cannot set id on a group-clusters value"),
                }
                Ok(g)
            })
            .collect::<Result<_>>()?,
        Some(_) => bail!("TypeError: group-clusters is not an array"),
    };
    o.set("group-clusters", Js::Arr(groups));
    for prop in ["subgroup-repness", "subgroup-votes", "subgroup-clusters"] {
        o.remove(prop);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processed(text: &str) -> String {
        let mut v = js::parse(text).unwrap();
        let o = v.as_obj_mut().unwrap();
        o.set("math_tick", Js::Num(3.0));
        process_math_object(o).unwrap();
        let mut merged = ensure_complete(Some(std::mem::take(o)), 1_700_000_000_000.0);
        merged.remove("zid");
        js::stringify(&Js::Obj(merged))
    }

    #[test]
    fn empty_structure_matches_node_template() {
        assert_eq!(
            js::stringify(&Js::Obj(ensure_complete(None, 1_700_000_000_000.0))),
            r#"{"group-clusters":[],"base-clusters":{"x":[],"y":[],"id":[],"count":[],"members":[]},"group-votes":{},"group-aware-consensus":{},"user-vote-counts":{},"in-conv":[],"n-cmts":0,"pca":{"comps":[[],[]],"center":[],"comment-extremity":[],"comment-projection":{}},"tids":[],"n":0,"repness":{},"consensus":{"agree":[],"disagree":[]},"votes-base":{},"lastModTimestamp":null,"lastVoteTimestamp":1700000000000,"comment-priorities":{},"math_tick":0}"#
        );
    }

    #[test]
    fn keyed_groups_gain_ids_and_missing_lists_are_appended() {
        let out = processed(
            r#"{"n": 4, "zid": 9, "tids": [1, 2], "repness": {"1": [{"tid": 2}], "0": [{"tid": 1}]}, "group-votes": {"0": {"votes": {}, "n-members": 2}}, "group-clusters": [{"id": 0, "center": [0.5, 1]}], "subgroup-votes": {"0": {}}}"#,
        );
        assert_eq!(
            out,
            r#"{"group-clusters":[{"id":0,"center":[0.5,1]}],"base-clusters":{"x":[],"y":[],"id":[],"count":[],"members":[]},"group-votes":{"0":{"votes":{},"n-members":2,"id":0}},"group-aware-consensus":{},"user-vote-counts":{},"in-conv":[],"n-cmts":0,"pca":{"comps":[[],[]],"center":[],"comment-extremity":[],"comment-projection":{}},"tids":[1,2],"n":4,"repness":{"0":[{"tid":1}],"1":[{"tid":2}]},"consensus":{"agree":[],"disagree":[]},"votes-base":{},"lastModTimestamp":null,"lastVoteTimestamp":1700000000000,"comment-priorities":{},"math_tick":3,"mod-in":[],"mod-out":[],"meta-tids":[]}"#
        );
    }

    #[test]
    fn malformed_entries_are_presented_empty() {
        let out = processed(
            r#"{"repness": [null], "group-votes": {"0": {"x": 1}}, "group-clusters": [{"id": "a"}]}"#,
        );
        assert!(out.contains(r#""group-clusters":[]"#), "{out}");
        assert!(out.contains(r#""group-votes":{}"#), "{out}");
        assert!(out.contains(r#""repness":{}"#), "{out}");
    }

    #[test]
    fn a_non_array_group_clusters_is_the_node_type_error() {
        let mut o = js::parse(r#"{"group-clusters": {"0": {"id": 0}}}"#).unwrap();
        assert!(process_math_object(o.as_obj_mut().unwrap()).is_err());
        let mut o = js::parse(r#"{"group-clusters": 0}"#).unwrap();
        assert!(process_math_object(o.as_obj_mut().unwrap()).is_ok());
    }

    #[test]
    fn existing_lists_keep_their_position() {
        let out = processed(r#"{"meta-tids": [5], "mod-in": [], "n": 1}"#);
        assert!(
            out.ends_with(r#""math_tick":3,"meta-tids":[5],"mod-in":[],"mod-out":[]}"#),
            "{out}"
        );
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn no_row_template_never_hides_the_first_generation_at_tick_zero() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("pca_first_generation_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
                 CREATE TABLE math_main(zid integer, math_env text, math_tick bigint, data jsonb);"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let mut cfg: postgres::Config = url.parse().unwrap();
        cfg.options(&format!("-c search_path={schema}"));
        let db = db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg)),
            db::Limits {
                size: 1,
                acquire_timeout: std::time::Duration::from_millis(500),
                statement_timeout: std::time::Duration::from_millis(300),
                max_lifetime: std::time::Duration::from_secs(60),
            },
        );
        let pca = Pca::new(db.clone(), "a".into(), 300);
        let expire = || {
            let mut cache = lock(&pca.cache).unwrap();
            let mut item = (*cache.get(&1).unwrap()).clone();
            item.expiration = 0.0;
            cache.set(1, Arc::new(item));
        };
        let empty = pca.get_pca(1, -1.0).await.unwrap().unwrap();
        assert!(empty.synthesized);
        assert_eq!(empty.math_tick(), 0.0);
        expire();
        let (still_empty, outcome) = CACHE_OUTCOME
            .scope(std::cell::Cell::new("none"), async {
                let item = pca.get_pca(1, -1.0).await.unwrap().unwrap();
                (item, CACHE_OUTCOME.with(|c| c.get()))
            })
            .await;
        assert!(still_empty.synthesized);
        assert_eq!(outcome, "miss");
        let insert_url = url.clone();
        let insert_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&insert_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "INSERT INTO {insert_schema}.math_main VALUES
                 (1,'a',0,'{{\"lastVoteTimestamp\":0,\"n\":2,\"tids\":[7],\"n-cmts\":1}}');"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        expire();
        let (first, outcome) = CACHE_OUTCOME
            .scope(std::cell::Cell::new("none"), async {
                let item = pca.get_pca(1, -1.0).await.unwrap().unwrap();
                (item, CACHE_OUTCOME.with(|c| c.get()))
            })
            .await;
        assert_eq!(outcome, "miss");
        assert!(!first.synthesized);
        assert_eq!(first.math_tick(), 0.0);
        assert!(matches!(first.pojo.get("n"), Some(Js::Num(2.0))));
        assert_ne!(first.gzip, empty.gzip);
        let cold = Pca::new(db, "a".into(), 1)
            .get_pca(1, -1.0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.gzip, cold.gzip);
        expire();
        let (renewed, outcome) = CACHE_OUTCOME
            .scope(std::cell::Cell::new("none"), async {
                let item = pca.get_pca(1, -1.0).await.unwrap().unwrap();
                (item, CACHE_OUTCOME.with(|c| c.get()))
            })
            .await;
        assert_eq!(outcome, "revalidated");
        assert_eq!(renewed.gzip, first.gzip);
        assert!(pca.get_pca(1, 0.0).await.unwrap().is_none());
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }

    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn expired_generations_revalidate_without_rebuilding_and_detect_changes() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("pca_reuse_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
                CREATE TABLE math_main(zid integer, math_env text, math_tick bigint, data jsonb);
                INSERT INTO math_main VALUES(1,'a',0,'{{\"lastVoteTimestamp\":123,\"n\":2}}'),
                    (2,'a',0,'{{\"n\":3}}'), (1,'b',8,'{{\"lastVoteTimestamp\":123,\"n\":4}}');"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let mut cfg: postgres::Config = url.parse().unwrap();
        cfg.options(&format!("-c search_path={schema}"));
        let db = db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg)),
            db::Limits {
                size: 2,
                acquire_timeout: std::time::Duration::from_millis(500),
                statement_timeout: std::time::Duration::from_millis(300),
                max_lifetime: std::time::Duration::from_secs(60),
            },
        );
        let pca = Pca::new(db.clone(), "a".into(), 300);
        let expire = |zid| {
            let mut c = lock(&pca.cache).unwrap();
            let mut item = (*c.get(&zid).unwrap()).clone();
            item.expiration = 0.0;
            c.set(zid, Arc::new(item));
        };
        // Even an up-to-date client leaves the committed row reusable.
        assert!(pca.get_pca(1, 0.0).await.unwrap().is_none());
        let first = pca.get_pca(1, -1.0).await.unwrap().unwrap();
        expire(1);
        let revalidation_started = now_ms();
        let (renewed, outcome) = CACHE_OUTCOME
            .scope(std::cell::Cell::new("none"), async {
                let row = pca.get_pca(1, -1.0).await.unwrap().unwrap();
                (row, CACHE_OUTCOME.with(|c| c.get()))
            })
            .await;
        assert_eq!(outcome, "revalidated");
        assert_eq!(first.gzip, renewed.gzip);
        assert_eq!(
            js::stringify(&Js::Obj((*first.pojo).clone())),
            js::stringify(&Js::Obj((*renewed.pojo).clone()))
        );
        assert!(Arc::ptr_eq(&first.pojo, &renewed.pojo));
        assert!(Arc::ptr_eq(&first.gzip, &renewed.gzip));
        assert!(!Arc::ptr_eq(&first, &renewed));
        assert!(renewed.expiration >= revalidation_started + TTL_MS);
        assert!(renewed.expiration <= now_ms() + TTL_MS);
        assert_eq!(
            Pca::new(db, "b".into(), 300)
                .get_pca(1, -1.0)
                .await
                .unwrap()
                .unwrap()
                .math_tick(),
            8.0
        );
        let unstable = pca.get_pca(2, -1.0).await.unwrap().unwrap();
        assert!(!unstable.reusable);
        let mutate_url = url.clone();
        let mutate_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&mutate_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "UPDATE {mutate_schema}.math_main \
                 SET math_tick=1,data='{{\"lastVoteTimestamp\":124,\"n\":9}}' \
                 WHERE zid=1 AND math_env='a'"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        expire(1);
        let next = pca.get_pca(1, 0.0).await.unwrap().unwrap();
        assert_eq!(next.math_tick(), 1.0);
        assert_ne!(next.gzip, first.gzip);
        let delete_url = url.clone();
        let delete_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&delete_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "DELETE FROM {delete_schema}.math_main WHERE zid=1 AND math_env='a'"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        expire(1);
        assert!(pca.get_pca(1, -1.0).await.unwrap().unwrap().synthesized);
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[test]
    fn app_uses_the_dedicated_pca_cache_capacity() {
        use crate::{config::Config, route::App};
        use std::time::Duration;

        let mut cfg = Config {
            listen: String::new(),
            math_env: "a".into(),
            cache_size: 300,
            pca_cache_size: 2,
            pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
            dev_mode: false,
            use_network_host: false,
            production: true,
            pool: db::Limits {
                size: 1,
                acquire_timeout: Duration::from_millis(100),
                statement_timeout: Duration::from_millis(100),
                max_lifetime: Duration::from_secs(60),
            },
        };
        let pg = "postgresql://u@127.0.0.1:1/d".parse().unwrap();
        let db = db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg)),
            cfg.pool.clone(),
        );
        let app = App::new(&cfg, db.clone());
        for zid in 1..=3 {
            let item = app.pca.store(zid, Obj::new(), false, true).unwrap();
            lock(&app.pca.cache).unwrap().set_presentation(
                zid,
                Presentation {
                    source: item.clone(),
                    presented: item,
                    expiration: 0.0,
                },
            );
        }
        let mut cache = lock(&app.pca.cache).unwrap();
        assert!(cache.get(&1).is_none(), "PCA must use its own capacity");
        assert!(cache.get(&2).is_some());
        assert!(cache.get(&3).is_some());
        drop(cache);
        let mut presentations = lock(&app.pca.cache).unwrap();
        assert!(presentations.presentation(&1).is_none());
        assert!(presentations.presentation(&2).is_some());
        assert!(presentations.presentation(&3).is_some());
        drop(presentations);
        cfg.pca_cache_bytes = 0;
        let app = App::new(&cfg, db);
        let served = app.pca.store(1, Obj::new(), false, true).unwrap();
        assert!(!served.gzip.is_empty());
        assert!(
            lock(&app.pca.cache).unwrap().get(&1).is_none(),
            "PCA must use its configured byte budget"
        );
    }

    #[test]
    fn retained_generations_have_a_per_process_conversation_bound() {
        let cfg = "postgresql://u@127.0.0.1:1/d".parse().unwrap();
        let db = db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg)),
            db::Limits {
                size: 1,
                acquire_timeout: std::time::Duration::from_millis(100),
                statement_timeout: std::time::Duration::from_millis(100),
                max_lifetime: std::time::Duration::from_secs(60),
            },
        );
        for capacity in [300_usize, 17, 1] {
            let pca = Pca::new(db.clone(), "a".into(), capacity);
            for zid in 0..=capacity as i32 {
                let item = pca.store(zid, Obj::new(), false, true).unwrap();
                lock(&pca.cache).unwrap().set_presentation(
                    zid,
                    Presentation {
                        source: item.clone(),
                        presented: item,
                        expiration: 0.0,
                    },
                );
            }
            let mut cache = lock(&pca.cache).unwrap();
            assert!(cache.get(&0).is_none());
            assert!(cache.get(&(capacity as i32)).is_some());
            drop(cache);
            let mut presentations = lock(&pca.cache).unwrap();
            assert!(presentations.presentation(&0).is_none());
            assert!(presentations.presentation(&(capacity as i32)).is_some());
        }
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "pca_refresh_tests.rs"]
mod refresh_tests;

#[cfg(all(test, feature = "db-tests"))]
#[path = "pca_failure_tests.rs"]
mod failure_tests;

#[cfg(all(test, feature = "db-tests"))]
#[path = "pca_outcome_tests.rs"]
mod outcome_tests;

#[cfg(all(test, feature = "db-tests"))]
#[path = "pca_budget_tests.rs"]
mod budget_tests;
