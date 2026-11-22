//! The public fixtures as a run stores them: the three families' codec files
//! in the row shapes the Delphi pipeline writes (its converter's UMAP node and
//! edge rows, cluster assignment rows with one `layer<N>_cluster_id` per layer
//! and topic-name rows), so the stored map can be made from them as a run's
//! step and the backfill command make it.
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use polis_topic_map::stored::{ASSIGNMENTS, CODEC, NAMES, POSITIONS, RunIdentity};
use serde_json::{Value, json};
use std::path::PathBuf;

pub fn fixture(set: &str, file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(set)
        .join(file);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A decimal as DynamoDB's canonical number text (no exponent, no trailing
/// zeros), to six places: what the pipeline's Decimal conversion gives for a
/// position, near enough for a fixture.
pub fn number(v: f64) -> String {
    let text = format!("{v:.6}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" || text.is_empty() {
        "0".into()
    } else {
        text.to_owned()
    }
}

fn header(family: &str, key: &[&str]) -> String {
    serde_json::to_string(&json!({"codec": CODEC, "family": family, "key": key})).unwrap()
}

fn file(family: &str, key: &[&str], rows: Vec<Value>) -> String {
    let mut out = header(family, key);
    out.push('\n');
    for row in rows {
        // serde_json writes object keys in byte order, as the codec does.
        out.push_str(&serde_json::to_string(&row).unwrap());
        out.push('\n');
    }
    out
}

pub struct Run {
    pub positions: String,
    pub assignments: String,
    pub names: String,
    pub comments: usize,
}

/// The three codec files of a public fixture, stored as conversation `zid`.
/// `keep` limits the comments (by order of id) to make degenerate runs.
pub fn run(set: &str, zid: i64, keep: Option<usize>) -> Run {
    let proximity = fixture(set, "proximity.json");
    let topics = fixture(set, "topics.json");
    let z = zid.to_string();
    let mut points: Vec<&Value> = proximity["proximity_data"]
        .as_array()
        .unwrap()
        .iter()
        .collect();
    points.sort_by_key(|p| p["comment_id"].as_i64().unwrap());
    if let Some(n) = keep {
        points.truncate(n);
    }
    let layers = points
        .iter()
        .flat_map(|p| p["clusters"].as_object().unwrap().keys())
        .map(|k| k.parse::<u32>().unwrap())
        .max()
        .map_or(0, |m| m + 1);
    let mut nodes = Vec::new();
    let mut assignments = Vec::new();
    for (i, p) in points.iter().enumerate() {
        let tid = p["comment_id"].as_i64().unwrap();
        let (x, y) = (p["umap_x"].as_f64().unwrap(), p["umap_y"].as_f64().unwrap());
        nodes.push(json!({
            "conversation_id": {"S": z}, "edge_id": {"S": format!("{tid}_{tid}")},
            "source_id": {"N": tid.to_string()}, "target_id": {"N": tid.to_string()},
            "weight": {"N": "1"}, "distance": {"N": "0"}, "is_nearest_neighbor": {"BOOL": false},
            "shared_layers": {"L": []},
            "position": {"M": {"x": {"N": number(x)}, "y": {"N": number(y)}}},
        }));
        // An edge to the next comment: skipped by the map, as every UMAP edge is.
        if let Some(next) = points.get(i + 1) {
            let other = next["comment_id"].as_i64().unwrap();
            nodes.push(json!({
                "conversation_id": {"S": z}, "edge_id": {"S": format!("{tid}_{other}")},
                "source_id": {"N": tid.to_string()}, "target_id": {"N": other.to_string()},
                "weight": {"N": "0.5"}, "distance": {"N": "0.5"}, "is_nearest_neighbor": {"BOOL": true},
                "shared_layers": {"L": [{"N": "0"}]},
            }));
        }
        let mut row = json!({"conversation_id": {"S": z}, "comment_id": {"N": tid.to_string()}});
        for layer in 0..layers.max(5) {
            let value = p["clusters"]
                .get(layer.to_string())
                .and_then(Value::as_i64)
                .map_or(json!({"NULL": true}), |c| json!({"N": c.to_string()}));
            row[format!("layer{layer}_cluster_id")] = value;
        }
        row["umap_x"] = json!({"N": number(x)});
        assignments.push(row);
    }
    let mut names = Vec::new();
    for (job, r) in topics["runs"].as_object().unwrap() {
        let model = r["model_name"].as_str().unwrap_or("none");
        for (layer, clusters) in r["topics_by_layer"].as_object().unwrap() {
            for (cluster, t) in clusters.as_object().unwrap() {
                names.push(json!({
                    "conversation_id": {"S": z},
                    "topic_key": {"S": t["topic_key"].as_str().map_or(format!("{job}#{layer}#{cluster}"), str::to_owned)},
                    "layer_id": {"N": layer}, "cluster_id": {"N": cluster},
                    "topic_name": {"S": t["topic_name"].as_str().unwrap()},
                    "model_name": {"S": model}, "job_id": {"S": job},
                    "created_at": {"S": "2026-11-11T02:48:21.639910"},
                }));
            }
        }
    }
    Run {
        positions: file(POSITIONS, &["conversation_id", "edge_id"], nodes),
        assignments: file(ASSIGNMENTS, &["conversation_id", "comment_id"], assignments),
        names: file(NAMES, &["conversation_id", "topic_key"], names),
        comments: points.len(),
    }
}

pub const JOB: &str = "0000a001-0000-4000-8000-000000000001";

pub fn identity(zid: i64) -> RunIdentity {
    RunIdentity {
        env: "shadow-delphi-1".into(),
        job_id: JOB.into(),
        run_id: "0000a001-0000-4000-8000-0000000000a1".into(),
        batch_id: "0000a001-0000-4000-8000-0000000000b1".into(),
        conversation_id: zid,
        scope: "delphi".into(),
        selection: Some("participant_visible/1".into()),
        models: models(),
        execution: execution(),
    }
}

/// A run's execution record, in the shape the pipeline's step writes it.
pub fn execution() -> Value {
    json!({
        "schema": "delphi-run-execution/1",
        "available": true,
        "selection": {"rule": "participant_visible/1", "strict_moderation": false,
                      "comments_read": 160, "comments_embedded": 158, "comments_selected": 154,
                      "left_out": {"rejected": 4}},
        "steps": [
            {"step": "inputs", "status": "ok", "seconds": 0.21},
            {"step": "umap", "status": "ok", "seconds": 6.012, "n_comments": 154},
            {"step": "evoc", "status": "ok", "seconds": 3.2, "layers": 2, "clusters": [7, 3], "fallback": false},
        ],
        "algorithms": {
            "umap": {"package_version": "0.5.7", "n_components": 2, "metric": "cosine", "n_neighbors": 15,
                     "min_dist": 0.1, "random_state": 42},
            "clustering": {"algorithm": "evoc", "min_samples": 5, "seed": 42},
        },
        "unavailable": {"code_version": "not passed to the run; the run record's code_version names it"},
    })
}

/// A run's models, as run_delphi.py's output manifest names them.
pub fn models() -> Value {
    json!({
        "embed": "ibm-granite/granite-embedding-311m-multilingual-r2@44399559930365213510b1ee2eb15ded83374f0e:384",
        "topic": "none",
        "narrative": null,
        "cluster": "delphi-umap-evoc/1",
        "cluster_seed": 42,
    })
}
