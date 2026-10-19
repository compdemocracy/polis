//! `polis delphi show`: the end of a Delphi run as the report pages show it.
//!
//! Reads the six routes the report pages read, in their order: the report, its
//! comments with vote counts, the PCA presentation, the Delphi runs, topic
//! statistics and the stored collective statements. Prints the collective
//! statements (the carousel, newest first) and the topic statistics table
//! (layers coarse to fine, rows by comment count), each with the job and model
//! that produced it. The numbers are computed as the page computes them
//! (client-report TopicStats.jsx and TopicTables.jsx). `--json` carries every
//! route body byte for byte.
use crate::{client, collective_read, profiles, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{envelope, Error, Result};
use serde::Serialize;
use serde_json::{json, value::RawValue, Map, Value};
use std::collections::HashMap;

fn invalid() -> Error {
    Error::new(
        "invalid_response",
        "The site returned an incomplete or mismatched report read.",
        "Check the report ID and selected site; ask the operator to check API compatibility. Nothing was written or generated.",
        1,
    )
}

/// One GET, kept as the exact response text beside its parsed value.
fn read(
    c: &Client,
    reads: &mut Vec<Value>,
    path: &str,
    query: &[(&str, &str)],
    math: bool,
) -> Result<Value> {
    let query: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let bytes = if math {
        c.math_presentation_bytes(&query)?
    } else {
        c.operation_bytes("GET", path, &query, None, false)?
    };
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let value: Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    let line: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
    reads.push(json!({"route": format!("GET {path}?{}", line.join("&")), "body": text}));
    Ok(value)
}

/// JavaScript's `Number.prototype.toFixed`, which the page uses: an exact tie
/// rounds away from zero, where Rust's formatter rounds it to even.
pub fn to_fixed(x: f64, digits: usize) -> String {
    let x = if x == 0.0 { 0.0 } else { x };
    let exact = format!("{:.1100}", x.abs());
    let fraction = exact.split('.').nth(1).unwrap_or("");
    let tie = fraction.as_bytes().get(digits) == Some(&b'5')
        && fraction[digits + 1..].bytes().all(|b| b == b'0');
    let x = if tie {
        f64::from_bits(x.to_bits() + 1)
    } else {
        x
    };
    format!("{x:.digits$}")
}

/// The run's topic keys are `job#layer#cluster`; the job is the first part.
fn job_of(topic_key: &str) -> Option<&str> {
    topic_key
        .split_once('#')
        .map(|(job, _)| job)
        .filter(|job| !job.is_empty())
}

/// A stored statement's id is `zid#topic_key#statement_job`.
fn statement_job(row: &Value) -> Value {
    let id = row["zid_topic_jobid"].as_str().unwrap_or("");
    let prefix = format!(
        "{}#{}#",
        row["zid"].as_str().unwrap_or(""),
        row["topic_key"].as_str().unwrap_or("")
    );
    match id.strip_prefix(prefix.as_str()) {
        Some(job) if !job.is_empty() => json!(job),
        _ => Value::Null,
    }
}

fn layer_name(layer: i64, total: usize) -> (&'static str, &'static str) {
    if layer == 0 {
        ("Finer Grained", "(Specific insights)")
    } else if layer == total as i64 - 1 {
        ("Coarse", "(Big picture themes)")
    } else {
        ("Medium", "(Balanced overview)")
    }
}

/// The page's per-topic row: Comments, Total Votes, Avg Votes/Comment and
/// Group Consensus, from topicStats' comment_tids, the comments' vote counts
/// and the math's group consensus.
fn topic_row(
    topic: &Value,
    stats: &Map<String, Value>,
    comments: &HashMap<String, &Value>,
    math: &Value,
) -> Value {
    let key = topic["topic_key"].as_str().unwrap_or("");
    let consensus = math
        .get("group-consensus-normalized")
        .filter(|v| !v.is_null() && *v != &json!(false))
        .or_else(|| math.get("group-aware-consensus"))
        .and_then(Value::as_object);
    let Some(tids) = stats.get(key).and_then(|s| s["comment_tids"].as_array()) else {
        return json!({"topic_key": key, "topic_name": topic["topic_name"], "comment_count": 0,
            "total_votes": 0, "vote_density": null, "group_consensus": null});
    };
    let (mut count, mut votes) = (0u64, 0u64);
    let mut values = Vec::new();
    for tid in tids {
        let id = tid.to_string();
        if let Some(c) = comments.get(&id) {
            count += 1;
            votes += ["agree_count", "disagree_count", "pass_count"]
                .iter()
                .map(|k| c[k].as_u64().unwrap_or(0))
                .sum::<u64>();
        }
        if let Some(v) = consensus.and_then(|m| m.get(&id)).and_then(Value::as_f64) {
            values.push(v);
        }
    }
    let density = if count > 0 {
        votes as f64 / count as f64
    } else {
        0.0
    };
    let group = (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64);
    json!({"topic_key": key, "topic_name": topic["topic_name"], "comment_count": count,
        "total_votes": votes, "vote_density": to_fixed(density, 1),
        "group_consensus": group.map(|g| to_fixed(g, 2))})
}

pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let report = str_arg(m, "report");
    if report.is_empty() || report.len() > 300 || !report.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(Error::input("Use an alphanumeric public report ID."));
    }
    let model = m.get_one::<String>("model").map(String::as_str);
    if model.is_some_and(|name| {
        name.trim().is_empty() || name.len() > 200 || name.chars().any(char::is_control)
    }) {
        return Err(Error::input(
            "Model name must be 1–200 bytes without control characters, exactly as stored.",
        ));
    }
    let c = client(config, site, timeout, false)?;
    let mut reads = Vec::new();
    let reports = read(
        &c,
        &mut reads,
        "/api/v3/reports",
        &[("report_id", report)],
        false,
    )?;
    let conversation = reports[0]["conversation_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?
        .to_owned();
    let level = reports[0]["mod_level"].as_i64().unwrap_or(-2).to_string();
    let comments = read(
        &c,
        &mut reads,
        "/api/v3/comments",
        &[
            ("conversation_id", conversation.as_str()),
            ("report_id", report),
            ("moderation", "true"),
            ("mod_gt", level.as_str()),
            ("include_voting_patterns", "true"),
        ],
        false,
    )?;
    let math = read(
        &c,
        &mut reads,
        "/api/v3/math/pca2",
        &[
            ("lastVoteTimestamp", "0"),
            ("conversation_id", conversation.as_str()),
        ],
        true,
    )?;
    let delphi = read(
        &c,
        &mut reads,
        "/api/v3/delphi",
        &[("report_id", report)],
        false,
    )?;
    let stats = read(
        &c,
        &mut reads,
        "/api/v3/topicStats",
        &[("report_id", report)],
        false,
    )?;
    let stored = read(
        &c,
        &mut reads,
        "/api/v3/collectiveStatement",
        &[("report_id", report)],
        false,
    )?;
    // collectiveStatement keeps only the newest statement per layer and cluster,
    // across models; one model's versions come from the per-version route.
    let versions = match model {
        Some(_) => read(
            &c,
            &mut reads,
            "/api/v3/delphi/collective/results",
            &[("report_id", report)],
            false,
        )
        .map_err(crate::collective::unserved(
            "per-model collective statements",
        ))?,
        None => stored.clone(),
    };
    let comments: HashMap<String, &Value> = comments
        .as_array()
        .or_else(|| comments["comments"].as_array())
        .ok_or_else(invalid)?
        .iter()
        .map(|c| (c["tid"].to_string(), c))
        .collect();
    if [&delphi, &stats, &stored, &versions]
        .iter()
        .any(|v| v["status"] != "success")
    {
        return Err(invalid());
    }
    let empty = Map::new();
    let runs = delphi["runs"].as_object().unwrap_or(&empty);
    let stats = stats["stats"].as_object().ok_or_else(invalid)?;
    let rows = versions["statements"].as_array().ok_or_else(invalid)?;

    let mut models: Vec<&str> = runs
        .values()
        .filter_map(|r| r["model_name"].as_str())
        .collect();
    models.sort();
    models.dedup();
    // The page shows the run whose key sorts last; --model narrows to that model's runs.
    let chosen = runs
        .iter()
        .filter(|(_, run)| model.is_none_or(|name| run["model_name"] == name))
        .max_by(|a, b| a.0.cmp(b.0));
    if model.is_some() && chosen.is_none() {
        return Err(Error::new(
            "model_run_unavailable",
            "This report has no stored Delphi run by that model.",
            "Run polis delphi show REPORT without --model; it lists the stored models.",
            1,
        ));
    }

    let mut layers = Vec::new();
    let mut jobs = Vec::new();
    if let Some((_, run)) = chosen {
        let by_layer = run["topics_by_layer"].as_object().unwrap_or(&empty);
        let mut ids: Vec<(&String, &Value)> = by_layer.iter().collect();
        ids.sort_by_key(|(id, _)| std::cmp::Reverse(id.parse::<i64>().unwrap_or(i64::MIN)));
        for (id, topics) in ids {
            let mut clusters: Vec<(&String, &Value)> = topics
                .as_object()
                .map(|t| t.iter().collect())
                .unwrap_or_default();
            clusters.sort_by_key(|(c, _)| c.parse::<i64>().unwrap_or(i64::MAX));
            let mut topic_rows: Vec<Value> = clusters
                .iter()
                .map(|(_, t)| topic_row(t, stats, &comments, &math))
                .collect();
            for (_, t) in &clusters {
                if let Some(job) = t["topic_key"].as_str().and_then(job_of) {
                    if !jobs.contains(&job) {
                        jobs.push(job);
                    }
                }
            }
            // Stable, like the page's default sort: comment count, descending.
            topic_rows.sort_by_key(|r| std::cmp::Reverse(r["comment_count"].as_u64().unwrap_or(0)));
            let layer = id.parse::<i64>().unwrap_or(-1);
            let (name, description) = layer_name(layer, by_layer.len());
            layers.push(
                json!({"layer": id, "name": name, "description": description,
                "topics": topic_rows}),
            );
        }
        // Every topic of every stored run is a topicStats key. A run missing from a
        // non-empty answer means the store changed between the two reads.
        let keys = layers
            .iter()
            .flat_map(|l| l["topics"].as_array().unwrap().iter())
            .filter_map(|t| t["topic_key"].as_str());
        if !stats.is_empty()
            && keys.clone().count() > 0
            && keys.clone().all(|k| !stats.contains_key(k))
        {
            let mut e = Error::new(
                "reads_disagree",
                "The topic statistics do not include the chosen run's topics; a Delphi run may have changed between reads.",
                "Read again. Which run these numbers describe is unknown.",
                7,
            );
            e.outcome = "unknown";
            return Err(e);
        }
    }

    // The carousel: newest first (stable on equal times). For one model, its
    // newest version of each topic (the per-version route is newest first).
    let mut seen = Vec::new();
    let mut carousel: Vec<&Value> = rows
        .iter()
        .filter(|r| match model {
            None => true,
            Some(name) => {
                let row: &Value = r;
                row["model"] == name && {
                    let first = !seen.contains(&&row["topic_key"]);
                    seen.push(&row["topic_key"]);
                    first
                }
            }
        })
        .collect();
    carousel.sort_by(|a, b| {
        b["created_at"]
            .as_str()
            .unwrap_or("")
            .cmp(a["created_at"].as_str().unwrap_or(""))
    });
    let carousel: Vec<Value> = carousel
        .into_iter()
        .map(|r| {
            json!({"topic_name": r["topic_name"], "topic_key": r["topic_key"],
                "topic_job": r["topic_key"].as_str().and_then(job_of),
                "statement_job": statement_job(r), "model": r["model"],
                "created_at": r["created_at"], "statement_data": r["statement_data"]})
        })
        .collect();

    Ok(json!({
        "report_id": report,
        "conversation_id": conversation,
        "model_requested": model,
        "models": models,
        "run": chosen.map(|(key, run)| json!({"key": key, "model_name": run["model_name"],
            "created_date": run["created_date"], "job_uuid": run["job_uuid"], "jobs": jobs})),
        "collective_statements": carousel,
        "other_statements": rows.len() - carousel.len(),
        "topic_stats": layers,
        "reads": reads,
    }))
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "-".into(),
        other => other.to_string(),
    }
}

/// The terminal view: the carousel's statements, then the topic statistics.
pub fn text(v: &Value) -> String {
    let mut out = format!(
        "Report {} (conversation {})\n",
        show(&v["report_id"]),
        show(&v["conversation_id"])
    );
    let run = &v["run"];
    if run.is_null() {
        out.push_str("No Delphi run is stored for this report.\n");
    } else {
        let jobs: Vec<String> = run["jobs"].as_array().unwrap().iter().map(show).collect();
        out.push_str(&format!(
            "Run: model {}, created {}, job {}\n",
            show(&run["model_name"]),
            show(&run["created_date"]),
            if jobs.is_empty() {
                "-".into()
            } else {
                jobs.join(", ")
            }
        ));
    }
    let models: Vec<String> = v["models"].as_array().unwrap().iter().map(show).collect();
    if !models.is_empty() {
        out.push_str(&format!("Stored models: {}\n", models.join(", ")));
    }

    let statements = v["collective_statements"].as_array().unwrap();
    out.push_str(&format!("\nCOLLECTIVE STATEMENTS ({})\n", statements.len()));
    if v["other_statements"].as_u64().unwrap_or(0) > 0 {
        out.push_str(&format!(
            "{} other stored statements (other models or older versions) not shown.\n",
            v["other_statements"]
        ));
    }
    if statements.is_empty() {
        out.push_str("No stored collective statements.\n");
    }
    for (i, s) in statements.iter().enumerate() {
        out.push_str(&format!(
            "\n{} of {}: {}\nTopic {} (job {}); statement job {}; model {}; created {}\n\n",
            i + 1,
            statements.len(),
            show(&s["topic_name"]),
            show(&s["topic_key"]),
            show(&s["topic_job"]),
            show(&s["statement_job"]),
            show(&s["model"]),
            show(&s["created_at"]),
        ));
        out.push_str(&collective_read::body(&s["statement_data"]));
    }

    out.push_str("\nTOPIC STATISTICS");
    if !run.is_null() {
        out.push_str(&format!(" (model {})", show(&run["model_name"])));
    }
    out.push('\n');
    let layers = v["topic_stats"].as_array().unwrap();
    if layers.is_empty() {
        out.push_str("No topics.\n");
    }
    for layer in layers {
        let topics = layer["topics"].as_array().unwrap();
        out.push_str(&format!(
            "\n{}: {} Topics {} (layer {})\n",
            show(&layer["name"]),
            topics.len(),
            show(&layer["description"]),
            show(&layer["layer"])
        ));
        out.push_str("Comments  Total Votes  Avg Votes/Comment  Group Consensus  Topic\n");
        for t in topics {
            out.push_str(&format!(
                "{:>8}  {:>11}  {:>17}  {:>15}  {} [{}]\n",
                show(&t["comment_count"]),
                show(&t["total_votes"]),
                show(&t["vote_density"]),
                show(&t["group_consensus"]),
                show(&t["topic_name"]),
                show(&t["topic_key"]),
            ));
        }
    }
    out
}

#[derive(Serialize)]
struct Read<'a> {
    route: &'a str,
    body: &'a RawValue,
}

/// The `--json` document: the usual envelope, with each route's response body
/// carried byte for byte under `data.reads`.
pub fn json(site: &str, v: &Value) -> String {
    let mut data = v.clone();
    let raw = data["reads"].take();
    let raw = raw.as_array().unwrap();
    let bodies: Vec<&RawValue> = raw
        .iter()
        .map(|r| serde_json::from_str(r["body"].as_str().unwrap()).expect("validated JSON"))
        .collect();
    let reads: Vec<Read> = raw
        .iter()
        .zip(bodies)
        .map(|(r, body)| Read {
            route: r["route"].as_str().unwrap(),
            body,
        })
        .collect();
    data.as_object_mut().unwrap().remove("reads");
    let mut out = envelope(site, &Ok(Value::Null));
    out.as_object_mut().unwrap().remove("data");
    #[derive(Serialize)]
    struct Data<'a> {
        #[serde(flatten)]
        summary: &'a Value,
        reads: Vec<Read<'a>>,
    }
    #[derive(Serialize)]
    struct Envelope<'a> {
        #[serde(flatten)]
        head: &'a Value,
        data: Data<'a>,
    }
    serde_json::to_string_pretty(&Envelope {
        head: &out,
        data: Data {
            summary: &data,
            reads,
        },
    })
    .expect("serializable")
}
