//! Characterization tests: the Rust port against what datamapplot 0.6.4 itself
//! computed for the same stored run. `tests/fixtures/<set>/expected.json` holds
//! the label and point tables datamapplot handed to its page renderer, captured
//! by calling it the way Delphi does (one map per layer) and once with every
//! layer in one map; `proximity.json` and `topics.json` are the run as stored.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use polis_topic_map::ciecam02::Space;
use polis_topic_map::layout::{self, P};
use polis_topic_map::{Proximity, Topics, clean_name, map_colors};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

const SETS: [&str; 2] = ["bg2050", "biodiversity"];
const NOISE: [u8; 3] = [170, 170, 170];

fn dir(set: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(set)
}

fn json(set: &str, file: &str) -> Value {
    let path = dir(set).join(file);
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap()
}

struct Run {
    ids: Vec<i64>,
    coords: Vec<P>,
    /// level -> cluster -> (name, member point indexes)
    levels: Vec<BTreeMap<i64, (String, Vec<usize>)>>,
    unclustered: Vec<usize>,
}

fn load(set: &str) -> Run {
    let prox: Proximity = serde_json::from_value(json(set, "proximity.json")).unwrap();
    let topics: Topics = serde_json::from_value(json(set, "topics.json")).unwrap();
    let run = topics.runs.values().next().unwrap();
    let mut pts = prox.proximity_data;
    pts.sort_by_key(|p| p.comment_id);
    let raw: Vec<P> = pts.iter().map(|p| [p.umap_x, p.umap_y]).collect();
    let n_levels = run.topics_by_layer.len();
    let mut levels = Vec::new();
    let mut unclustered = Vec::new();
    for level in 0..n_levels {
        let key = level.to_string();
        let mut m: BTreeMap<i64, (String, Vec<usize>)> = BTreeMap::new();
        let mut none = 0;
        for (i, p) in pts.iter().enumerate() {
            match p.clusters.get(&key) {
                Some(&c) if c >= 0 => {
                    let name = clean_name(
                        run.topics_by_layer[&key][&c.to_string()]
                            .topic_name
                            .as_deref()
                            .unwrap(),
                    );
                    m.entry(c).or_insert_with(|| (name, Vec::new())).1.push(i);
                }
                _ => none += 1,
            }
        }
        levels.push(m);
        unclustered.push(none);
    }
    Run {
        ids: pts.iter().map(|p| p.comment_id).collect(),
        coords: layout::standardize(&raw),
        levels,
        unclustered,
    }
}

/// A label as datamapplot wrapped it, back on one line.
fn unwrap_label(label: &str) -> String {
    label.replace("-\n", "-").replace('\n', " ")
}

fn close(a: f64, b: f64, tol: f64, what: &str) {
    assert!((a - b).abs() <= tol, "{what}: {a} vs datamapplot's {b}");
}

fn rgb_of(v: &Value) -> [u8; 3] {
    [
        v["r"].as_f64().unwrap() as u8,
        v["g"].as_f64().unwrap() as u8,
        v["b"].as_f64().unwrap() as u8,
    ]
}

#[test]
fn ciecam02_matches_colorspacious() {
    let e = json("bg2050", "expected.json");
    let s = &e["jch_samples"];
    let space = Space::new();
    let triple = |v: &Value| {
        [
            v[0].as_f64().unwrap(),
            v[1].as_f64().unwrap(),
            v[2].as_f64().unwrap(),
        ]
    };
    for i in 0..s["jch"].as_array().unwrap().len() {
        let rgb = space.jch_to_srgb(triple(&s["jch"][i]));
        let want = triple(&s["srgb1_unclipped"][i]);
        for k in 0..3 {
            close(rgb[k], want[k], 1e-9, "JCh to sRGB");
        }
        let jch = space.srgb_to_jch(want.map(|c| c.clamp(0.0, 1.0)));
        let want = triple(&s["jch_of_clipped"][i]);
        for k in 0..3 {
            close(jch[k], want[k], 1e-7, "sRGB to JCh");
        }
    }
}

#[test]
fn standard_size_view_bounds_and_point_radius_match() {
    for set in SETS {
        let run = load(set);
        let e = json(set, "expected.json");
        let all = &e["all_layers"];
        let ids: Vec<i64> = all["comment_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        assert_eq!(ids, run.ids, "{set}: same comments in the same order");
        for (i, p) in all["points"].as_array().unwrap().iter().enumerate() {
            close(run.coords[i][0], p[0].as_f64().unwrap(), 2e-6, "x");
            close(run.coords[i][1], p[1].as_f64().unwrap(), 2e-6, "y");
        }
        let bounds = layout::view_bounds(&run.coords);
        for k in 0..4 {
            close(
                bounds[k],
                all["bounds"][k].as_f64().unwrap(),
                1e-9,
                "view bounds",
            );
        }
        close(
            layout::point_radius(&bounds, run.coords.len()),
            all["point_size"].as_f64().unwrap(),
            1e-12,
            "point radius",
        );
        for (level, _) in run.levels.iter().enumerate() {
            let l = &e["layers"][level.to_string()];
            for k in 0..4 {
                close(
                    bounds[k],
                    l["bounds"][k].as_f64().unwrap(),
                    1e-9,
                    "view bounds of a layer",
                );
            }
            close(
                layout::point_radius(&bounds, run.coords.len()),
                l["point_size"].as_f64().unwrap(),
                1e-12,
                "point radius of a layer",
            );
        }
    }
}

/// Anchors, weights and both colours of every label of every one-layer map.
#[test]
fn labels_of_each_layer_match() {
    let space = Space::new();
    for set in SETS {
        let run = load(set);
        let e = json(set, "expected.json");
        for (level, clusters) in run.levels.iter().enumerate() {
            let anchors: Vec<(P, f64)> = clusters
                .values()
                .map(|(_, m)| layout::label_anchor(&run.coords, m))
                .collect();
            let xy: Vec<P> = anchors.iter().map(|a| a.0).collect();
            let cmap = clusters.len() + usize::from(run.unclustered[level] > 0) > 50;
            let (base, text) = map_colors(&space, &run.coords, &xy, cmap);
            let want: BTreeMap<String, &Value> = e["layers"][level.to_string()]["labels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| (unwrap_label(l["label"].as_str().unwrap()), l))
                .collect();
            assert_eq!(
                want.len(),
                clusters.len(),
                "{set} layer {level}: one label per topic"
            );
            let mut colours = BTreeMap::new();
            for (k, (name, members)) in clusters.values().enumerate() {
                let l = want.get(name).unwrap_or_else(|| {
                    panic!("{set} layer {level}: datamapplot has no label {name:?}")
                });
                close(anchors[k].0[0], l["x"].as_f64().unwrap(), 1e-6, "label x");
                close(anchors[k].0[1], l["y"].as_f64().unwrap(), 1e-6, "label y");
                close(
                    anchors[k].1,
                    l["size"].as_f64().unwrap(),
                    1e-9,
                    "label weight",
                );
                assert_eq!(
                    text[k],
                    rgb_of(l),
                    "{set} layer {level}: label colour of {name:?}"
                );
                *colours.entry(base[k]).or_insert(0usize) += members.len();
            }
            *colours.entry(NOISE).or_insert(0usize) += run.unclustered[level];
            colours.retain(|_, n| *n > 0);
            let mut drawn = BTreeMap::new();
            for p in e["layers"][level.to_string()]["points"].as_array().unwrap() {
                let c = [
                    p[2].as_f64().unwrap() as u8,
                    p[3].as_f64().unwrap() as u8,
                    p[4].as_f64().unwrap() as u8,
                ];
                *drawn.entry(c).or_insert(0usize) += 1;
            }
            assert_eq!(
                colours, drawn,
                "{set} layer {level}: how many points have each colour"
            );
        }
    }
}

/// Every layer in one map: one palette over all labels, each point in the
/// colour of the finest layer that puts it in a topic.
#[test]
fn labels_and_points_of_the_all_layers_map_match() {
    let space = Space::new();
    for set in SETS {
        let run = load(set);
        let e = json(set, "expected.json");
        let all = &e["all_layers"];
        let mut xy = Vec::new();
        let mut names = Vec::new();
        for clusters in &run.levels {
            for (name, m) in clusters.values() {
                xy.push(layout::label_anchor(&run.coords, m).0);
                names.push(name.clone());
            }
        }
        let cmap = all["cvd_safer"].as_bool().unwrap();
        assert_eq!(cmap, names.len() + 1 > 50);
        let (base, text) = map_colors(&space, &run.coords, &xy, cmap);
        let want: BTreeMap<String, &Value> = all["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| (unwrap_label(l["label"].as_str().unwrap()), l))
            .collect();
        assert_eq!(
            want.len(),
            names.len(),
            "{set}: topic names are distinct across layers"
        );
        for (k, name) in names.iter().enumerate() {
            assert_eq!(
                text[k],
                rgb_of(want[name]),
                "{set}: label colour of {name:?}"
            );
        }
        let mut colour = vec![NOISE; run.coords.len()];
        let mut k = names.len();
        for clusters in run.levels.iter().rev() {
            k -= clusters.len();
            for (j, (_, members)) in clusters.values().enumerate() {
                for &i in members {
                    colour[i] = base[k + j];
                }
            }
        }
        for (i, p) in all["points"].as_array().unwrap().iter().enumerate() {
            let c = [
                p[2].as_f64().unwrap() as u8,
                p[3].as_f64().unwrap() as u8,
                p[4].as_f64().unwrap() as u8,
            ];
            assert_eq!(colour[i], c, "{set}: colour of comment {}", run.ids[i]);
        }
    }
}

#[test]
fn the_document_holds_every_point_and_a_tree() {
    for set in SETS {
        let prox: Proximity = serde_json::from_value(json(set, "proximity.json")).unwrap();
        let topics: Topics = serde_json::from_value(json(set, "topics.json")).unwrap();
        let n = prox.proximity_data.len();
        let data = polis_topic_map::build(prox, topics, &BTreeMap::new(), "t", "a").unwrap();
        assert_eq!(data.points.id.len(), n);
        assert_eq!(data.points.topic.len(), data.levels.len());
        let top = data.levels.len() - 1;
        for t in &data.topics {
            assert_eq!(
                t.parent.is_none(),
                t.level == top || t.parent_share.is_none()
            );
            if let Some(p) = &t.parent {
                let parent = data.topics.iter().find(|x| &x.id == p).unwrap();
                assert_eq!(parent.level, t.level + 1);
            }
        }
    }
}
