//! A participant's topic priorities over the existing Node route, saved in the
//! request shape the participation page sends.
use crate::{listing, participation, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{topic_selections::PATH, Error, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// The participation page keeps a topic's three statements nearest its centre.
const REPRESENTATIVES: usize = 3;
const MAX_TOPICS: usize = 1000;
/// 2^53: integral doubles up to here are written by JavaScript as plain digits.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;
const PARTICIPATION: &str = "Check this conversation's participation requirements; an invite may require polis join. No anonymous fallback or retry was made.";

struct Topic {
    key: String,
    layer: u32,
    cluster: String,
}
struct Point {
    tid: u64,
    x: f64,
    y: f64,
}

fn input(message: &str) -> Error {
    Error::input(format!("{message} Nothing was sent."))
}
/// Keys are RUN#LAYER#CLUSTER, as polis topic list prints them. Errors never
/// echo the typed value.
fn parse(raw: &str) -> Result<(String, Vec<Topic>)> {
    const FORMAT: &str = "Use --topics with 1–1000 comma-separated topic keys copied from polis topic list, each RUN#LAYER#CLUSTER.";
    let mut run: Option<&str> = None;
    let mut seen = HashSet::new();
    let mut topics = Vec::new();
    for key in raw.split(',').map(|k| k.trim_matches(' ')) {
        let parts = key.split('#').collect::<Vec<_>>();
        let &[r, layer, cluster] = &parts[..] else {
            return Err(input(FORMAT));
        };
        let layer = layer
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= i32::MAX as u32 && n.to_string() == layer)
            .ok_or_else(|| input(FORMAT))?;
        if r.is_empty()
            || r.len() > 256
            || !r
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || cluster.parse::<i32>().map(|n| n.to_string()) != Ok(cluster.to_owned())
        {
            return Err(input(FORMAT));
        }
        if run.is_some_and(|first| first != r) {
            return Err(input("Choose topics from one analysis run: every key must begin with the same RUN, as one polis topic list --job RUN prints them."));
        }
        run = Some(r);
        if !seen.insert(key) {
            return Err(input("List each topic once."));
        }
        topics.push(Topic {
            key: key.to_owned(),
            layer,
            cluster: cluster.to_owned(),
        });
    }
    if topics.len() > MAX_TOPICS {
        return Err(input(FORMAT));
    }
    Ok((run.expect("split yields one key").to_owned(), topics))
}

/// Correlation metadata is untrusted; never return it with a participant's request.
fn quiet(e: &mut Error) {
    if let Some(upstream) = e.upstream.as_object_mut() {
        upstream.insert("request_id".into(), Value::Null);
    }
}
fn safe(mut e: Error) -> Error {
    quiet(&mut e);
    if e.exit == 3 || e.exit == 4 {
        e.action = PARTICIPATION;
    }
    e
}
fn preflight(e: Error) -> Error {
    let mut e = safe(e);
    if e.exit != 3 && e.exit != 4 {
        e.action = "Nothing was sent. Check the conversation and its stored topics; no automatic retry was made.";
    }
    e
}
fn incompatible() -> Error {
    Error::new(
        "invalid_response",
        "The site returned an incompatible topic response.",
        "Nothing was sent. Check site compatibility; no automatic retry was made.",
        1,
    )
}
fn unavailable(position: usize, reason: &str) -> Error {
    Error::new(
        "topic_unavailable",
        format!("Topic key {position} {reason}."),
        "Nothing was sent. Copy keys from polis topic list --conversation CONVERSATION --job RUN; do not substitute another topic automatically.",
        5,
    )
}
/// Once the POST may have been stored, no failure may suggest that repeating it is safe.
fn uncertain(mut e: Error) -> Error {
    if e.code != "participant_credentials_not_saved" {
        e.code = "outcome_unknown";
        e.message = "The topic priorities could not be confirmed.".into();
    }
    e.action = "Run polis topic prioritize CONVERSATION --show before saving again; no automatic retry was made.";
    e.exit = 7;
    e.outcome = "unknown";
    e.retryable = false;
    quiet(&mut e);
    e
}
fn unconfirmed() -> Error {
    uncertain(incompatible())
}

/// The keys of every stored topic in the requested run.
fn listed(v: &Value) -> Result<HashSet<String>> {
    if v["status"] != "success" {
        return Err(incompatible());
    }
    let rows: Vec<&Value> = if let Some(layers) = v.get("topics_by_layer") {
        let layers = layers.as_object().ok_or_else(incompatible)?;
        layers
            .values()
            .map(|l| l.as_array().ok_or_else(incompatible))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect()
    } else {
        v["topics"]
            .as_array()
            .ok_or_else(incompatible)?
            .iter()
            .collect()
    };
    rows.into_iter()
        .map(|t| {
            t["topic_key"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(incompatible)
        })
        .collect()
}
/// JavaScript parseInt on a cluster-map key: its leading decimal digits.
fn layer_key(key: &str) -> Option<u32> {
    let digits: String = key
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}
/// JavaScript String(value) for a stored cluster label.
fn label(v: &Value) -> Option<String> {
    v.as_i64()
        .map(|n| n.to_string())
        .or_else(|| v.as_str().map(str::to_owned))
}
/// Each topic's statements, in stored order, as the page groups the topic map.
fn placed(v: &Value, topics: &[Topic]) -> Result<Vec<Vec<Point>>> {
    if v["status"] != "success" {
        return Err(incompatible());
    }
    let rows = v["proximity_data"].as_array().ok_or_else(incompatible)?;
    let mut groups: Vec<Vec<Point>> = topics.iter().map(|_| Vec::new()).collect();
    for row in rows {
        let Some(clusters) = row.get("clusters").and_then(Value::as_object) else {
            continue;
        };
        for (layer, cluster) in clusters {
            let (Some(layer), Some(cluster)) = (layer_key(layer), label(cluster)) else {
                continue;
            };
            for (i, t) in topics.iter().enumerate() {
                if t.layer != layer || t.cluster != cluster {
                    continue;
                }
                let coordinate = |k: &str| row[k].as_f64().filter(|n| n.is_finite());
                let (Some(tid), Some(x), Some(y)) = (
                    row["comment_id"].as_u64().filter(|n| *n <= i32::MAX as u64),
                    coordinate("umap_x"),
                    coordinate("umap_y"),
                ) else {
                    return Err(incompatible());
                };
                groups[i].push(Point { tid, x, y });
            }
        }
    }
    Ok(groups)
}
fn texts(v: &Value) -> Result<HashMap<u64, String>> {
    v.as_array()
        .ok_or_else(incompatible)?
        .iter()
        .map(|c| match (c["tid"].as_u64(), c["txt"].as_str()) {
            (Some(tid), Some(txt)) => Ok((tid, txt.to_owned())),
            _ => Err(incompatible()),
        })
        .collect()
}
/// A double as JavaScript writes it to JSON: integral values as integers.
fn number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() <= MAX_SAFE_INTEGER {
        json!(x as i64)
    } else {
        json!(x)
    }
}
/// The page's selection entry: the statements nearest the mean of the topic's
/// coordinates (Euclidean distance, stable order on ties), at most three.
fn selection(t: &Topic, points: &[Point], texts: &HashMap<u64, String>) -> Result<Value> {
    let n = points.len() as f64;
    let cx = points.iter().fold(0.0, |s, p| s + p.x) / n;
    let cy = points.iter().fold(0.0, |s, p| s + p.y) / n;
    let mut nearest = points
        .iter()
        .map(|p| {
            let (dx, dy) = (p.x - cx, p.y - cy);
            (p, (dx * dx + dy * dy).sqrt())
        })
        .collect::<Vec<_>>();
    if nearest.iter().any(|(_, d)| !d.is_finite()) {
        return Err(incompatible());
    }
    nearest.sort_by(|a, b| a.1.total_cmp(&b.1));
    nearest.truncate(REPRESENTATIVES);
    let comments = nearest
        .into_iter()
        .map(|(p, d)| {
            let text = texts
                .get(&p.tid)
                .filter(|t| !t.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("[Comment {}]", p.tid));
            json!({"comment_id":p.tid,"comment_text":text,
                "coordinates":{"x":number(p.x),"y":number(p.y)},"distance_to_centroid":number(d)})
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"layer_id":t.layer,"cluster_id":t.cluster,"topic_key":t.key,"archetypal_comments":comments}),
    )
}
fn without_auth(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("auth");
    }
    v
}
fn read(c: &Client, conversation: &str, effect: bool) -> Result<Value> {
    let v = c
        .request(
            "GET",
            PATH,
            &[("conversation_id".into(), conversation.into())],
            None,
            false,
        )
        .map_err(if effect { uncertain } else { safe })?;
    let data = &v["data"];
    if v["status"] != "success" || !(data.is_null() || data["archetypal_selections"].is_array()) {
        return Err(if effect {
            unconfirmed()
        } else {
            incompatible()
        });
    }
    Ok(without_auth(v))
}

pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let choice = m
        .get_one::<String>("topics")
        .map(|raw| parse(raw))
        .transpose()?;
    let origin = config.url(site)?;
    let scope = profiles::participant_scope(origin, conversation)?;
    // Serializes first saves with votes and comments so one identity is issued;
    // held only across these bounded requests, never while waiting for a person.
    let _lock = profiles::credential_lock(site, &scope)?;
    let saved = profiles::participant_load(site, &scope)?;
    let ca = config.auth(site)?.ca_file.clone();
    let client = |token: Option<String>| Client::with_ca(origin, token, timeout, ca.as_deref());
    if m.get_flag("show") {
        return read(&client(saved.map(|s| s.token))?, conversation, false);
    }
    if m.get_flag("clear") {
        let Some(saved) = saved else {
            return Err(Error::new(
                "participant_credentials_missing",
                "No participant credentials are saved for this conversation in this profile.",
                "Nothing was sent. Topic priorities belong to the participant identity saved by an earlier vote, comment, join or topic prioritize.",
                3,
            ));
        };
        let c = client(Some(saved.token))?;
        let receipt = c
            .request(
                "DELETE",
                PATH,
                &[],
                Some(json!({"conversation_id":conversation})),
                true,
            )
            .map_err(safe)?;
        return (|| {
            if receipt["status"] != "success" {
                return Err(unconfirmed());
            }
            let readback = read(&c, conversation, true)?;
            if !readback["data"].is_null() {
                return Err(unconfirmed());
            }
            Ok(json!({"receipt":without_auth(receipt),"readback":readback}))
        })()
        .map_err(uncertain);
    }
    let (run, topics) = choice.expect("parser requires one mode");
    let c = client(saved.as_ref().map(|s| s.token.clone()))?;
    let q = |extra: (&str, &str)| {
        vec![
            ("conversation_id".to_owned(), conversation.to_owned()),
            (extra.0.to_owned(), extra.1.to_owned()),
        ]
    };
    let stored = listed(
        &c.request(
            "GET",
            "/api/v3/topicMod/topics",
            &q(("job_id", &run)),
            None,
            false,
        )
        .map_err(preflight)?,
    )?;
    if let Some(i) = topics.iter().position(|t| !stored.contains(&t.key)) {
        return Err(unavailable(
            i + 1,
            "is not among this conversation's stored topics for its analysis run",
        ));
    }
    let groups = placed(
        &c.request(
            "GET",
            "/api/v3/topicMod/proximity",
            &q(("layer_id", "all")),
            None,
            false,
        )
        .map_err(preflight)?,
        &topics,
    )?;
    if let Some(i) = groups.iter().position(Vec::is_empty) {
        return Err(unavailable(i + 1, "has no comments in the conversation's stored topic coordinates, so its representative comments cannot be chosen"));
    }
    // The page reads comment text from the moderation listing; its vote
    // counts are not needed for the text, so they are not requested.
    let texts = texts(
        &c.request(
            "GET",
            "/api/v3/comments",
            &q(("moderation", "true")),
            None,
            false,
        )
        .map_err(preflight)?,
    )?;
    let selections = topics
        .iter()
        .zip(&groups)
        .map(|(t, points)| selection(t, points, &texts))
        .collect::<Result<Vec<_>>>()?;
    let receipt = c
        .request(
            "POST",
            PATH,
            &[],
            Some(json!({"conversation_id":conversation,"selections":selections})),
            true,
        )
        .map_err(safe)?;
    let issued = participation::issued_token(&receipt, true).map_err(|_| unconfirmed())?;
    // Keep an issued identity even when the rest of the receipt is unusable:
    // the selection may already be stored under it.
    if let Some(token) = &issued {
        profiles::participant_store(
            site,
            &scope,
            token,
            saved.as_ref().and_then(|s| s.login_code.clone()),
        )
        .map_err(|_| {
            uncertain(Error::new(
                "participant_credentials_not_saved",
                "The response arrived, but participant credentials could not be saved.",
                "",
                7,
            ))
        })?;
    }
    let receipt = without_auth(receipt);
    (|| {
        let token = issued.or(saved.map(|s| s.token)).ok_or_else(unconfirmed)?;
        let d = &receipt["data"];
        if receipt["status"] != "success"
            || d["selections_count"].as_u64() != Some(topics.len() as u64)
            || !d["participant_id"].is_string()
            || !(d["job_id"].is_null() || d["job_id"].is_string())
        {
            return Err(unconfirmed());
        }
        let readback = read(&client(Some(token))?, conversation, true)?;
        let r = &readback["data"];
        if r["archetypal_selections"] != json!(selections)
            || r["total_selections"].as_u64() != Some(topics.len() as u64)
            || r["participant_id"] != d["participant_id"]
            || r["conversation_id"] != d["conversation_id"]
            || r["delphi_job_id"] != d["job_id"]
        {
            return Err(unconfirmed());
        }
        Ok(json!({"receipt":receipt,"readback":readback}))
    })()
    .map_err(uncertain)
}

/// Site text is untrusted: never let it move the cursor or hide characters.
fn clean(v: &Value) -> String {
    v.as_str()
        .unwrap_or("")
        .chars()
        .filter(|&c| !c.is_control() && !listing::invisible(c))
        .collect()
}
fn count(n: usize) -> String {
    format!(
        "{n} topic {}",
        if n == 1 { "priority" } else { "priorities" }
    )
}
/// The terminal receipt; --json returns the site's responses instead.
pub fn human(v: &Value) -> String {
    let Some(readback) = v.get("readback") else {
        let d = &v["data"];
        let Some(rows) = d["archetypal_selections"].as_array() else {
            return "No topic priorities are saved for you in this conversation.\n".into();
        };
        let run = if d["delphi_job_id"].is_string() {
            format!("analysis run {}", clean(&d["delphi_job_id"]))
        } else {
            "no analysis run recorded".into()
        };
        let mut out = format!(
            "{} saved ({run}, updated {}):\n",
            count(rows.len()),
            clean(&d["updated_at"])
        );
        for row in rows {
            out.push_str(&format!("  {}\n", clean(&row["topic_key"])));
        }
        return out;
    };
    let d = &readback["data"];
    let Some(rows) = d["archetypal_selections"].as_array() else {
        return "Cleared. No topic priorities are saved for you in this conversation.\n".into();
    };
    let run = rows
        .first()
        .and_then(|r| r["topic_key"].as_str())
        .and_then(|k| k.split('#').next())
        .unwrap_or("");
    let mut out = format!("Saved {} from analysis run {run}.\n", count(rows.len()));
    match d["delphi_job_id"].as_str() {
        Some(recorded) if recorded == run => {}
        Some(_) => out.push_str(&format!(
            "The site recorded analysis run {} for this choice, not {run}; topic keys from another run can name different topics. Choose from polis topic list --job {} and save again.\n",
            clean(&d["delphi_job_id"]),
            clean(&d["delphi_job_id"])
        )),
        None => out.push_str("The site recorded no analysis run for this choice.\n"),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_are_exact_run_layer_cluster_triples_from_one_run() {
        let (run, topics) = parse("job-1#2#0, job-1#0#-1").unwrap();
        assert_eq!(run, "job-1");
        assert_eq!(topics[1].key, "job-1#0#-1");
        assert_eq!((topics[1].layer, topics[1].cluster.as_str()), (0, "-1"));
        for bad in [
            "",
            "job",
            "job#1",
            "job#1#2#3",
            "#1#2",
            "job#01#2",
            "job#1#02",
            "job#-1#2",
            "job#1#+2",
            "job#2147483648#0",
            "jo b#1#2",
            "job#1#2,",
            "job#1#2,other#1#3",
            "job#1#2,job#1#2",
        ] {
            assert_eq!(parse(bad).err().map(|e| e.exit), Some(2), "{bad}");
        }
        let many = (0..1001).map(|i| format!("j#0#{i}")).collect::<Vec<_>>();
        assert!(parse(&many.join(",")).is_err());
        assert!(parse(&many[..1000].join(",")).is_ok());
    }
    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        assert_eq!(number(0.0).to_string(), "0");
        assert_eq!(number(-0.0).to_string(), "0");
        assert_eq!(number(-2.0).to_string(), "-2");
        assert_eq!(number(1.5).to_string(), "1.5");
        assert_eq!(number(2f64.sqrt()).to_string(), "1.4142135623730951");
    }
    #[test]
    fn cluster_labels_match_as_javascript_strings() {
        assert_eq!(layer_key("12"), Some(12));
        assert_eq!(layer_key("x"), None);
        assert_eq!(label(&json!(3)).as_deref(), Some("3"));
        assert_eq!(label(&json!(-1)).as_deref(), Some("-1"));
        assert_eq!(label(&json!("3")).as_deref(), Some("3"));
        assert_eq!(label(&json!(null)), None);
    }
}
