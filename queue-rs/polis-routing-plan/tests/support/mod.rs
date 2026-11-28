//! Constructed conversations for the plan tests: named, unsigned counts;
//! no vote value anywhere, and no real conversation's ids.
#![allow(dead_code)]

use polis_routing_equation::{
    ConsensusForm, FloorParams, GicParams, MetaPolicy, ParamSet, SymmetricGicParams,
    SymmetricParams,
};
use polis_routing_plan::{Frames, Projection, RowIdentity, RuleConfig, SourceLimits};
use serde_json::{Map, Value, json};

/// The largest unit below 1: 1 - 2^-53.
pub const LARGEST_BELOW_ONE: f64 = 1.0 - f64::EPSILON / 2.0;

pub struct XorShift(pub u64);

impl XorShift {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

pub fn row() -> RowIdentity {
    RowIdentity {
        zid: 7,
        math_env: "example".into(),
        math_tick: 41,
        last_vote_timestamp: Some(1_700_000_000_000),
        db_now_ms: 1_700_000_100_000,
    }
}

/// A constructed conversation and the ids it holds.
pub struct Convo {
    pub value: Value,
    /// Every comment of `tids`, in creation order.
    pub tids: Vec<i32>,
    /// The meta comments: some of `tids`, then some in no other key.
    pub meta: Vec<i32>,
}

/// How the stored weights of a constructed conversation are written.
#[derive(Clone, Copy)]
pub enum Priorities {
    /// A mix of numbers, `null`, `false`, 0 and absent entries.
    Mixed,
    /// The first comment 1e150, every other 1: each 1 is absorbed.
    Absorbing,
    /// None at all.
    Absent,
}

/// `n` comments, `groups` opinion groups, every `meta_every`-th comment
/// meta (0: none) and `meta_only` more meta comments in no other key.
pub fn conversation(
    seed: u64,
    n: usize,
    groups: u32,
    meta_every: usize,
    meta_only: usize,
    priorities: Priorities,
) -> Convo {
    let mut rng = XorShift(seed | 1);
    let tids: Vec<i32> = (0..n)
        .map(|i| (5 * i + 1) as i32 + rng.below(4) as i32)
        .collect();
    let extremity: Vec<f64> = tids.iter().map(|_| 3.0 * rng.unit()).collect();
    let mut meta: Vec<i32> = tids
        .iter()
        .enumerate()
        .filter(|(i, _)| meta_every > 0 && i % meta_every == 0)
        .map(|(_, t)| *t)
        .collect();
    meta.extend((0..meta_only).map(|j| (5 * n + 10 + 5 * j) as i32));
    let mut group_votes = Map::new();
    let mut group_clusters = vec![];
    let mut base_ids = vec![];
    let mut base_members = vec![];
    for g in 0..groups {
        let members = 30 + 7 * g;
        let mut votes = Map::new();
        for t in &tids {
            if rng.below(10) < 9 {
                let seen = rng.below(u64::from(members) + 1);
                let agreed = rng.below(seen + 1);
                let disagreed = rng.below(seen - agreed + 1);
                votes.insert(
                    t.to_string(),
                    json!({"A": agreed, "D": disagreed, "S": seen}),
                );
            }
        }
        group_votes.insert(
            g.to_string(),
            json!({"id": g, "n-members": members, "votes": votes}),
        );
        group_clusters.push(json!({"id": g, "members": [100 + g], "center": [0.0, 0.0]}));
        base_ids.push(100 + g);
        base_members.push((0..members).map(|k| g * 1000 + k).collect::<Vec<u32>>());
    }
    let mut value = json!({
        "tids": tids,
        "pca": {"comment-extremity": extremity},
        "meta-tids": meta,
        "group-votes": group_votes,
        "group-clusters": group_clusters,
        "base-clusters": {
            "id": base_ids,
            "members": base_members,
            "count": vec![0; groups as usize],
            "x": vec![0.0; groups as usize],
            "y": vec![0.0; groups as usize]
        }
    });
    let stored = match priorities {
        Priorities::Absent => None,
        Priorities::Mixed => {
            let mut m = Map::new();
            for t in &tids {
                let v = match rng.below(10) {
                    0 => Value::Null,
                    1 => Value::Bool(false),
                    2 => json!(0),
                    3 => continue,
                    _ => json!(10.0 * rng.unit() + 0.01),
                };
                m.insert(t.to_string(), v);
            }
            Some(m)
        }
        Priorities::Absorbing => Some(
            tids.iter()
                .enumerate()
                .map(|(i, t)| (t.to_string(), json!(if i == 0 { 1e150 } else { 1.0 })))
                .collect(),
        ),
    };
    if let (Some(m), Some(obj)) = (stored, value.as_object_mut()) {
        obj.insert("comment-priorities".into(), Value::Object(m));
    }
    Convo { value, tids, meta }
}

pub fn bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}

/// The frames `config` needs, read from a constructed conversation.
pub fn frames(v: &Value, config: &RuleConfig) -> Frames {
    Projection::parse(&bytes(v), row(), &SourceLimits::default())
        .unwrap()
        .frames(config.needs())
        .unwrap()
}

pub fn floor_params(policy: MetaPolicy, share: f64) -> FloorParams {
    let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
    FloorParams::new(
        SymmetricGicParams::new(base, ConsensusForm::GicGeomean1, GicParams::default()),
        share,
    )
    .unwrap()
}

pub fn floor(policy: MetaPolicy, share: f64) -> RuleConfig {
    let plain = ParamSet::SymmetricGicFloor2(floor_params(policy, share)).to_plain();
    RuleConfig::parse(&plain, Some("base-counts:lag-0")).unwrap()
}

pub fn stored() -> RuleConfig {
    RuleConfig::parse(&ParamSet::StoredWeights1.to_plain(), None).unwrap()
}

pub fn uniform() -> RuleConfig {
    RuleConfig::parse(&ParamSet::Uniform1.to_plain(), None).unwrap()
}

/// Three comments 10, 20, 30 in two groups, every cell present, with the
/// meta comments given; `meta_policy = exclude`.
pub fn tiny(meta: &[i32]) -> Value {
    let cell = json!({"A": 2, "D": 1, "S": 4});
    let votes = json!({"10": cell, "20": cell, "30": cell});
    json!({
        "tids": [10, 20, 30],
        "pca": {"comment-extremity": [0.5, 1.0, 1.5]},
        "meta-tids": meta,
        "group-votes": {
            "0": {"id": 0, "n-members": 5, "votes": votes},
            "1": {"id": 1, "n-members": 6, "votes": votes}
        },
        "group-clusters": [
            {"id": 0, "members": [100], "center": [0.0, 0.0]},
            {"id": 1, "members": [101], "center": [1.0, 1.0]}
        ],
        "base-clusters": {
            "id": [100, 101],
            "members": [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]],
            "count": [5, 6],
            "x": [0.0, 0.0],
            "y": [0.0, 0.0]
        }
    })
}
