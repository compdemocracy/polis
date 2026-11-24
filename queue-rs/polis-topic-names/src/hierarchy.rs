//! `hierarchy.json`: the topics the naming step hands the program.
//!
//! Python writes it; this module reads and checks it. Only the fields below
//! are read, and only the first five keywords and three sample comments of a
//! topic are ever sent, whatever the file holds.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fmt;

/// The `schema` string a `hierarchy.json` must carry.
pub const HIERARCHY_SCHEMA: &str = "polis-topic-names.hierarchy/1";
/// At most this many keywords of a topic are sent.
pub const MAX_KEYWORDS: usize = 5;
/// At most this many sample comments of a topic are sent.
pub const MAX_SAMPLES: usize = 3;

/// One topic as the file gives it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Topic {
    pub id: String,
    pub layer: u32,
    pub cluster: u32,
    pub size: u64,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub samples3: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawHierarchy {
    schema: String,
    topics: BTreeMap<String, Topic>,
}

/// A checked hierarchy, its topics in prompt order: broadest layer first, then
/// by cluster (the study's sort, `(-layer, cluster)`).
#[derive(Debug, Clone, PartialEq)]
pub struct Hierarchy {
    topics: Vec<Topic>,
}

/// Why a `hierarchy.json` was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HierarchyError(pub String);

impl fmt::Display for HierarchyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HierarchyError {}

impl Hierarchy {
    /// Parses and checks the file's text.
    pub fn from_json(text: &str) -> Result<Self, HierarchyError> {
        let raw: RawHierarchy = serde_json::from_str(text).map_err(|e| {
            HierarchyError(format!("hierarchy.json is not the expected shape: {e}"))
        })?;
        if raw.schema != HIERARCHY_SCHEMA {
            return Err(HierarchyError(format!(
                "hierarchy.json schema is {:?}, expected {HIERARCHY_SCHEMA:?}",
                raw.schema
            )));
        }
        Self::from_topics(raw.topics)
    }

    /// Checks topics keyed by id.
    pub fn from_topics(topics: BTreeMap<String, Topic>) -> Result<Self, HierarchyError> {
        if topics.is_empty() {
            return Err(HierarchyError("hierarchy.json has no topics".into()));
        }
        for (key, t) in &topics {
            if *key != t.id {
                return Err(HierarchyError(format!(
                    "topic keyed {key:?} has id {:?}",
                    t.id
                )));
            }
            if t.id != format!("{}_{}", t.layer, t.cluster) {
                return Err(HierarchyError(format!(
                    "topic id {:?} is not <layer>_<cluster> ({}_{})",
                    t.id, t.layer, t.cluster
                )));
            }
            if let Some(p) = &t.parent {
                match topics.get(p) {
                    Some(pt) if pt.layer == t.layer + 1 => {}
                    Some(_) => {
                        return Err(HierarchyError(format!(
                            "topic {:?} has parent {p:?}, which is not one layer up",
                            t.id
                        )));
                    }
                    None => {
                        return Err(HierarchyError(format!(
                            "topic {:?} has parent {p:?}, which is not a topic",
                            t.id
                        )));
                    }
                }
            }
        }
        let mut list: Vec<Topic> = topics.into_values().collect();
        list.sort_by(|a, b| b.layer.cmp(&a.layer).then(a.cluster.cmp(&b.cluster)));
        Ok(Self { topics: list })
    }

    /// The topics in prompt order.
    pub fn topics(&self) -> &[Topic] {
        &self.topics
    }

    /// The number of topics.
    pub fn len(&self) -> usize {
        self.topics.len()
    }

    /// Never true for a checked hierarchy; here for clippy's sake.
    pub fn is_empty(&self) -> bool {
        self.topics.is_empty()
    }

    /// Every sample comment that is sent, in prompt order (a comment that is a
    /// sample of several topics is counted each time).
    pub fn sent_samples(&self) -> impl Iterator<Item = &str> {
        self.topics
            .iter()
            .flat_map(|t| t.samples3.iter().take(MAX_SAMPLES).map(String::as_str))
    }
}
