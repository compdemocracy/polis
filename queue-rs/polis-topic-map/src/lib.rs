//! polis-topic-map: the generation-time half of the first-party topic map.
//!
//! Input: what a Delphi run stores and two server routes already return (the
//! UMAP position and the cluster of every comment at every layer; the topic
//! names). Output: one JSON document the browser component draws. Everything
//! here depends only on the run, never on the size of the window or on the
//! theme, which is why it is computed once.

pub mod ciecam02;
pub mod layout;
pub mod page;
pub mod palette;

use layout::P;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA: &str = "polis-topic-map/1";

/// `GET /api/v3/topicMod/proximity?layer_id=all` (server/src/routes/delphi/topicMod.ts).
#[derive(Deserialize)]
pub struct Proximity {
    pub proximity_data: Vec<ProximityPoint>,
}

#[derive(Deserialize)]
pub struct ProximityPoint {
    pub comment_id: i64,
    pub umap_x: f64,
    pub umap_y: f64,
    /// layer -> cluster id; -1 is "not in any cluster at this layer".
    #[serde(default)]
    pub clusters: BTreeMap<String, i64>,
}

/// `GET /api/v3/delphi` (server/src/routes/delphi/topics.ts).
#[derive(Deserialize)]
pub struct Topics {
    pub runs: BTreeMap<String, Run>,
}

#[derive(Deserialize)]
pub struct Run {
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    pub topics_by_layer: BTreeMap<String, BTreeMap<String, TopicName>>,
}

#[derive(Deserialize)]
pub struct TopicName {
    pub topic_name: Option<String>,
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Serialize)]
pub struct MapData {
    pub schema: &'static str,
    pub title: String,
    pub attribution: String,
    pub run: RunInfo,
    /// [xmin, xmax, ymin, ymax] the first view is fitted to.
    pub bounds: [f64; 4],
    /// Point radius in deck.gl common units (pixels = this * 2^zoom).
    #[serde(rename = "pointRadius")]
    pub point_radius: f64,
    pub levels: Vec<Level>,
    pub topics: Vec<Topic>,
    pub points: Points,
}

#[derive(Serialize)]
pub struct RunInfo {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "topicModel")]
    pub topic_model: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
}

#[derive(Serialize)]
pub struct Level {
    pub level: usize,
    pub topics: usize,
    pub unclustered: usize,
    /// True when Delphi's rule (more than 50 labels) picked the CET-C2s palette.
    #[serde(rename = "cmapPalette")]
    pub cmap_palette: bool,
}

#[derive(Serialize, Clone)]
pub struct Topic {
    pub id: String,
    pub level: usize,
    pub cluster: i64,
    pub key: Option<String>,
    pub name: String,
    pub count: usize,
    pub x: f64,
    pub y: f64,
    /// count^(1/4): the label's weight.
    pub weight: f64,
    pub parent: Option<String>,
    /// Share of this topic's comments that sit in the parent.
    #[serde(rename = "parentShare")]
    pub parent_share: Option<f64>,
    pub color: String,
    #[serde(rename = "labelColor")]
    pub label_color: String,
    /// The same two colours when every level is drawn in one map.
    #[serde(rename = "colorAll")]
    pub color_all: String,
    #[serde(rename = "labelColorAll")]
    pub label_color_all: String,
}

#[derive(Serialize)]
pub struct Points {
    pub id: Vec<i64>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// One row per level: for each point, the index of its topic in `topics`, or -1.
    pub topic: Vec<Vec<i64>>,
    pub text: Vec<String>,
}

fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn round5(v: f64) -> f64 {
    (v * 1e5).round() / 1e5
}

/// What `700_datamapplot_for_layer.py:665-669` does to a stored topic name.
pub fn clean_name(name: &str) -> String {
    name.replace('*', "")
}

/// The two colours of each label of one map: the topic colour and the darker
/// one its label is set in. `labels` are the anchors, in any order.
pub fn map_colors(
    space: &ciecam02::Space,
    coords: &[P],
    labels: &[P],
    cmap: bool,
) -> (Vec<[u8; 3]>, Vec<[u8; 3]>) {
    let base = if cmap {
        palette::from_cmap_and_datamap(space, &palette::cet_c2s(), coords, labels)
    } else {
        palette::from_datamap(space, coords, labels)
    };
    let text = palette::deep(space, &base);
    (
        base.into_iter().map(palette::to_rgb8).collect(),
        text.into_iter().map(palette::to_rgb8).collect(),
    )
}

pub fn build(
    prox: Proximity,
    topics: Topics,
    comments: &BTreeMap<String, String>,
    title: &str,
    attribution: &str,
) -> Result<MapData, String> {
    let mut pts = prox.proximity_data;
    if pts.is_empty() {
        return Err("no points: the run stored no UMAP positions".into());
    }
    pts.sort_by_key(|p| p.comment_id);
    let raw: Vec<P> = pts.iter().map(|p| [p.umap_x, p.umap_y]).collect();
    let coords = layout::standardize(&raw);
    let bounds = layout::view_bounds(&coords);
    let point_radius = layout::point_radius(&bounds, coords.len());

    // The newest run, as the report takes it.
    let (job_id, run) = topics
        .runs
        .iter()
        .max_by(|a, b| a.1.created_at.cmp(&b.1.created_at))
        .ok_or("no topic names: the run stored none")?;

    let n_levels = pts
        .iter()
        .flat_map(|p| p.clusters.keys())
        .filter_map(|k| k.parse::<usize>().ok())
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    if n_levels == 0 {
        return Err("no cluster layers in the run".into());
    }
    let space = ciecam02::Space::new();
    let mut out_topics: Vec<Topic> = Vec::new();
    let mut all_xy: Vec<P> = Vec::new();
    let mut levels = Vec::new();
    let mut topic_rows: Vec<Vec<i64>> = Vec::new();
    for level in 0..n_levels {
        let key = level.to_string();
        let mut members: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
        let mut unclustered = 0;
        for (i, p) in pts.iter().enumerate() {
            match p.clusters.get(&key) {
                Some(&c) if c >= 0 => members.entry(c).or_default().push(i),
                _ => unclustered += 1,
            }
        }
        let anchors: Vec<(P, f64)> = members
            .values()
            .map(|m| layout::label_anchor(&coords, m))
            .collect();
        let label_xy: Vec<P> = anchors.iter().map(|a| a.0).collect();
        // Delphi's rule: the colour-map palette when the map has more than 50
        // distinct labels, "Unclustered" counted among them.
        let cmap = members.len() + usize::from(unclustered > 0) > 50;
        let (base, text) = map_colors(&space, &coords, &label_xy, cmap);
        let first = out_topics.len();
        all_xy.extend(&label_xy);
        let mut row = vec![-1i64; pts.len()];
        for (k, (cluster, m)) in members.iter().enumerate() {
            for &i in m {
                row[i] = (first + k) as i64;
            }
            let stored = run
                .topics_by_layer
                .get(&key)
                .and_then(|l| l.get(&cluster.to_string()));
            let name = stored
                .and_then(|t| t.topic_name.clone())
                .map(|n| clean_name(&n))
                .unwrap_or_else(|| format!("Topic {cluster}"));
            out_topics.push(Topic {
                id: format!("{level}_{cluster}"),
                level,
                cluster: *cluster,
                key: stored.and_then(|t| t.topic_key.clone()),
                name,
                count: m.len(),
                x: round5(anchors[k].0[0]),
                y: round5(anchors[k].0[1]),
                weight: anchors[k].1,
                parent: None,
                parent_share: None,
                color: hex(base[k]),
                label_color: hex(text[k]),
                color_all: String::new(),
                label_color_all: String::new(),
            });
        }
        levels.push(Level {
            level,
            topics: members.len(),
            unclustered,
            cmap_palette: cmap,
        });
        topic_rows.push(row);
    }

    // Every level in one map: one palette over all the labels together.
    let any_unclustered = levels.iter().any(|l| l.unclustered > 0);
    let (base_all, text_all) = map_colors(
        &space,
        &coords,
        &all_xy,
        out_topics.len() + usize::from(any_unclustered) > 50,
    );
    for (k, t) in out_topics.iter_mut().enumerate() {
        t.color_all = hex(base_all[k]);
        t.label_color_all = hex(text_all[k]);
    }

    // The tree: a topic's parent is the topic one level coarser that holds the
    // most of its comments. EVoC's layers are not strictly nested, so the share
    // is recorded.
    for level in 0..n_levels.saturating_sub(1) {
        let mut tally: BTreeMap<i64, BTreeMap<i64, usize>> = BTreeMap::new();
        #[allow(
            clippy::needless_range_loop,
            reason = "one index walks two rows in step"
        )]
        for i in 0..pts.len() {
            let (child, parent) = (topic_rows[level][i], topic_rows[level + 1][i]);
            if child >= 0 && parent >= 0 {
                *tally.entry(child).or_default().entry(parent).or_default() += 1;
            }
        }
        for (child, parents) in tally {
            #[allow(
                clippy::unwrap_used,
                reason = "tally lists a child only with a parent it counted"
            )]
            let (parent, n) = parents
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                .map(|(p, n)| (*p, *n))
                .unwrap();
            let parent_id = out_topics[parent as usize].id.clone();
            let t = &mut out_topics[child as usize];
            t.parent = Some(parent_id);
            t.parent_share = Some(round5(n as f64 / t.count as f64));
        }
    }

    let text = pts
        .iter()
        .map(|p| {
            format!(
                "Comment {}: {}",
                p.comment_id,
                comments
                    .get(&p.comment_id.to_string())
                    .map(String::as_str)
                    .unwrap_or("")
            )
        })
        .collect();
    Ok(MapData {
        schema: SCHEMA,
        title: title.to_string(),
        attribution: attribution.to_string(),
        run: RunInfo {
            job_id: job_id.clone(),
            topic_model: run.model_name.clone(),
            created_at: run.created_at.clone(),
        },
        bounds,
        point_radius,
        levels,
        topics: out_topics,
        points: Points {
            id: pts.iter().map(|p| p.comment_id).collect(),
            x: coords.iter().map(|c| round5(c[0])).collect(),
            y: coords.iter().map(|c| round5(c[1])).collect(),
            topic: topic_rows,
            text,
        },
    })
}
