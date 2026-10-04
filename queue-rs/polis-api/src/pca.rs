//! The math read behind the route: `getPca`, `processMathObject`,
//! `ensureCompletePcaStructure` and `presentPca` from the Node server
//! (`server/src/utils/pca.ts`, `server/src/utils/pcaPresentation.ts`),
//! including their 3-second caches, so the same request sequence issues the
//! same reads and serves the same bytes.

use crate::lru::Lru;
use crate::{
    clock::now_ms,
    compress,
    db::{self, Pool},
    js::{self, Js, Obj, number_to_string, string_to_number},
};
use anyhow::{Result, bail};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// One cache entry: the engine-facing structure and its stored gzip body
/// (`PcaCacheItem.asPOJO` and `asBufferOfGzippedJson`).
#[derive(Debug)]
pub struct PcaItem {
    pub pojo: Obj,
    pub gzip: Vec<u8>,
    pub expiration: f64,
    /// The empty presentation made up for a conversation with no row. It has
    /// no generation, so the route gives it no generation tag.
    pub synthesized: bool,
}

impl PcaItem {
    pub fn math_tick(&self) -> f64 {
        self.pojo.get("math_tick").map_or(f64::NAN, js_number)
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

pub struct Pca {
    db: Arc<Pool>,
    math_env: String,
    cache: Mutex<Lru<i32, Arc<PcaItem>>>,
    presentations: Mutex<Lru<i32, Presentation>>,
    /// `pcaResultsExistForZid` (routes/math.ts).
    results_exist: Mutex<HashMap<i32, bool>>,
}

const TTL_MS: f64 = 3000.0;

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| anyhow::anyhow!("cache lock poisoned"))
}

impl Pca {
    pub fn new(db: Arc<Pool>, math_env: String, cache_size: usize) -> Self {
        Self {
            db,
            math_env,
            cache: Mutex::new(Lru::new(cache_size)),
            presentations: Mutex::new(Lru::new(cache_size)),
            results_exist: Mutex::new(HashMap::new()),
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
        if let Some(item) = cached.filter(|c| c.expiration > now_ms()) {
            if math_tick == -1.0 {
                return Ok(Some(item));
            }
            // Only a generation newer than the one asked about is an answer.
            if item.math_tick() <= math_tick {
                return Ok(None);
            }
            return Ok(Some(item));
        }
        let env = self.math_env.clone();
        let row = self.db.with(move |c| db::math_main(c, zid, &env)).await?;
        let Some(row) = row else {
            if math_tick == -1.0 {
                // No row at all: the empty presentation, so reports render.
                let pojo = ensure_complete(None, now_ms());
                return Ok(Some(self.store(zid, pojo, true)?));
            }
            return Ok(None);
        };
        let mut parsed = js::parse(&row.data)?;
        let Some(item) = parsed.as_obj_mut() else {
            // Every writer stores an object; Node would fail differently on a
            // scalar and reshape an array. Neither is served here.
            bail!("math_main.data is not a JSON object");
        };
        // The column is authoritative, including a committed tick of 0.
        let tick = row.math_tick as f64;
        item.set("math_tick", Js::Num(tick));
        if tick <= math_tick {
            return Ok(None);
        }
        let mut item = std::mem::take(item);
        process_math_object(&mut item)?;
        let mut pojo = ensure_complete(Some(item), now_ms());
        // `Object.assign(data, {zid})` then `delete item.zid`: never served.
        pojo.remove("zid");
        Ok(Some(self.store(zid, pojo, false)?))
    }

    /// `updatePcaCache`.
    fn store(&self, zid: i32, pojo: Obj, synthesized: bool) -> Result<Arc<PcaItem>> {
        let json = js::stringify(&Js::Obj(pojo.clone()));
        let gzip = compress::gzip(json.as_bytes())?;
        let item = Arc::new(PcaItem {
            pojo,
            gzip,
            expiration: now_ms() + TTL_MS,
            synthesized,
        });
        lock(&self.cache)?.set(zid, item.clone());
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
        let cached = lock(&self.presentations)?.get(&zid);
        if let Some(p) = cached
            && Arc::ptr_eq(&p.source, &item)
            && p.expiration > now_ms()
        {
            return Ok(p.presented);
        }
        let tids = if fill_tids || fill_count || fill_extremity {
            // Node serves an empty list when this read fails, not an error.
            match self.db.with(move |c| db::approved_tids(c, zid)).await {
                Ok(t) => t,
                Err(e) => {
                    eprintln!(
                        "{{\"event\":\"pca2_backfill_tids_failed\",\"zid\":{zid},\"detail\":{:?}}}",
                        e.to_string()
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let mut pojo = item.pojo.clone();
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
        let presented = Arc::new(PcaItem {
            pojo,
            gzip: compress::gzip(json.as_bytes())?,
            expiration: item.expiration,
            synthesized: item.synthesized,
        });
        lock(&self.presentations)?.set(
            zid,
            Presentation {
                source: item,
                presented: presented.clone(),
                expiration: now_ms() + TTL_MS,
            },
        );
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
}
