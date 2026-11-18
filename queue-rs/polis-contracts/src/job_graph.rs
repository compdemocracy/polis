//! Typed graph admission policy. SQL retains the atomic seal and stored lineage.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::OnceLock};

type Result<T> = std::result::Result<T, String>;

/// Output kinds, independent of the algorithm that produced them. Positions,
/// aligned layouts and topic maps have no runnable model in this release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Embeddings,
    Positions,
    Clusters,
    Keywords,
    Labels,
    AlignedLayout,
    TopicMap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Model {
    Granite,
    MiniLm,
    UmapEvoc,
    TfidfKeywords,
    KeywordLabels,
    LegacyImport,
    #[cfg(feature = "graph-test-models")]
    TokenCount,
    #[cfg(feature = "graph-test-models")]
    NearestCentroid,
    #[cfg(feature = "graph-test-models")]
    ClusterSummary,
    #[cfg(feature = "graph-test-models")]
    NarrativeFixture,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputRule {
    pub role: String,
    pub producer: Step,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub id: Model,
    pub step: Step,
    pub stage: String,
    pub model: String,
    pub adapter: String,
    pub inputs: Vec<InputRule>,
    pub classes: Vec<String>,
    pub memory_bytes: u64,
    pub work_units_max: u64,
    pub max_attempts: u32,
}
pub fn registry() -> Result<&'static [Definition]> {
    static REGISTRY: OnceLock<Result<Vec<Definition>>> = OnceLock::new();
    match REGISTRY.get_or_init(|| {
        let rows: Vec<Definition> =
            serde_json::from_str(include_str!("../job-models.json")).map_err(|e| e.to_string())?;
        #[cfg(feature = "graph-test-models")]
        let rows = {
            let mut rows = rows;
            rows.extend(
                serde_json::from_str::<Vec<Definition>>(include_str!("../job-test-models.json"))
                    .map_err(|e| e.to_string())?,
            );
            rows
        };
        Ok(rows)
    }) {
        Ok(rows) => Ok(rows),
        Err(e) => Err(e.clone()),
    }
}
impl Model {
    pub fn definition(self) -> Result<&'static Definition> {
        registry()?
            .iter()
            .find(|r| r.id == self)
            .ok_or_else(|| "model_definition_missing".into())
    }
    pub fn named(name: &str) -> Result<Self> {
        registry()?
            .iter()
            .find(|r| r.model == name)
            .map(|r| r.id)
            .ok_or_else(|| "unknown_graph_model".into())
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub step: Step,
    pub model: String,
    pub adapter_sha256: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Image {
    pub code: String,
    pub runtime: String,
    pub implementations: Vec<Capability>,
}

/// An admission value can be obtained only by checking the typed model, all
/// producing steps, and the exact image that will execute the node.
#[derive(Debug)]
pub struct ValidatedGraph(Value);
impl ValidatedGraph {
    pub fn wire(&self) -> &Value {
        &self.0
    }
    pub fn parse(value: Value, image: &Image) -> Result<Self> {
        Self::with_artifacts(value, image, &BTreeMap::new())
    }
    pub fn with_artifacts(
        value: Value,
        image: &Image,
        artifacts: &BTreeMap<String, Step>,
    ) -> Result<Self> {
        if value["schema"] != "polis-job-graph/1" {
            return Err("graph_schema".into());
        }
        let nodes = value["nodes"].as_array().ok_or("graph_nodes")?;
        if nodes.is_empty() || nodes.len() > 32 {
            return Err("graph_node_count".into());
        }
        let mut producers = BTreeMap::new();
        for node in nodes {
            let key = node["key"].as_str().ok_or("graph_key")?;
            if producers.insert(key, definition(node)?).is_some() {
                return Err("duplicate_graph_key".into());
            }
        }
        for node in nodes {
            let def = definition(node)?;
            let d = &node["declared"];
            let matching: Vec<_> = image
                .implementations
                .iter()
                .filter(|c| c.model == def.model && c.step == def.step)
                .collect();
            if matching.len() != 1 {
                return Err("image_model_unavailable".into());
            }
            let adapter = &matching[0].adapter_sha256;
            if !hex(adapter) || d["code"] != image.code || d["runtime"] != image.runtime {
                return Err("image_provenance_mismatch".into());
            }
            let adapter_key = if def.adapter == "import" {
                "importer_sha256"
            } else {
                "adapter_sha256"
            };
            // Reference adapters consist of the entry script whose digest is
            // already in declared.code; numerical/import adapters name theirs.
            if def.adapter != "reference" && d["config"][adapter_key] != *adapter {
                return Err("image_adapter_mismatch".into());
            }
            if d["mode"] != "full" {
                return Err("graph_mode".into());
            }
            let texts = d["snapshot"]["data"]["texts"]
                .as_array()
                .ok_or("graph_texts")?;
            if texts.is_empty() || texts.len() > 2000 {
                return Err("graph_text_count".into());
            }
            let cls = node["class"].as_str().ok_or("graph_class")?;
            if !def.classes.iter().any(|c| c == cls) {
                return Err("graph_class".into());
            }
            let memory_max = def.memory_bytes.min(if cls == "large" {
                2_147_483_648
            } else {
                4_294_967_296
            });
            if !bounded(&d["memory_bytes"], memory_max)
                || !bounded(&d["work_units"], def.work_units_max)
                || !bounded(&node["max_attempts"], def.max_attempts.into())
            {
                return Err("graph_resources".into());
            }
            let inputs = node["inputs"].as_array().ok_or("graph_inputs")?;
            if inputs.len() != def.inputs.len() {
                return Err("graph_input_count".into());
            }
            for rule in &def.inputs {
                let matched: Vec<_> = inputs.iter().filter(|i| i["role"] == rule.role).collect();
                if matched.len() != 1 {
                    return Err("graph_input_role".into());
                }
                if let Some(source) = matched[0]["node"].as_str() {
                    let producer = producers.get(source).ok_or("graph_producer_missing")?;
                    if producer.step != rule.producer {
                        return Err("graph_producer_type".into());
                    }
                    if source == node["key"].as_str().ok_or("graph_key")? {
                        return Err("graph_self_input".into());
                    }
                } else {
                    let artifact = matched[0]["artifact_id"].as_str().ok_or("graph_artifact")?;
                    if artifacts.get(artifact) != Some(&rule.producer) {
                        return Err("graph_producer_type".into());
                    }
                }
            }
        }
        Ok(Self(value))
    }
}
fn hex(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn bounded(v: &Value, max: u64) -> bool {
    v.as_u64().is_some_and(|n| n > 0 && n <= max)
}
fn definition(node: &Value) -> Result<&'static Definition> {
    let def =
        Model::named(node["declared"]["model"].as_str().ok_or("graph_model")?)?.definition()?;
    if node["stage"] != def.stage {
        return Err("graph_step_model".into());
    }
    Ok(def)
}
/// Typed constructor used by the shadow. Compatibility stage names are derived
/// here; callers cannot choose a different stage for an algorithm.
pub fn node(
    key: &str,
    model: Model,
    mut declared: Value,
    inputs: Value,
    attempts: u32,
) -> Result<Value> {
    let def = model.definition()?;
    declared["model"] = json!(def.model);
    Ok(
        json!({"key":key,"stage":def.stage,"class":"delphi","declared":declared,"inputs":inputs,"max_attempts":attempts}),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Image) {
        let def = Model::Granite.definition().unwrap();
        let image = Image {
            code: "a".repeat(64),
            runtime: "python-3.12.0".into(),
            implementations: vec![Capability {
                step: def.step,
                model: def.model.clone(),
                adapter_sha256: "b".repeat(64),
            }],
        };
        let n=node("e",Model::Granite,json!({"snapshot":{"data":{"texts":["one"]}},"code":image.code,"runtime":image.runtime,"config":{"adapter_sha256":"b".repeat(64)},"mode":"full","memory_bytes":4294967296_u64,"work_units":5}),json!([]),3).unwrap();
        (json!({"schema":"polis-job-graph/1","nodes":[n]}), image)
    }
    #[test]
    fn image_and_registry_agree_before_admission() {
        let (v, i) = fixture();
        assert!(ValidatedGraph::parse(v, &i).is_ok());
    }
    #[test]
    fn model_typo_and_absent_image_model_refuse() {
        let (mut v, mut i) = fixture();
        v["nodes"][0]["declared"]["model"] = json!("unknown");
        assert!(ValidatedGraph::parse(v, &i).is_err());
        let (v, _) = fixture();
        i.implementations.clear();
        assert!(ValidatedGraph::parse(v, &i).is_err());
    }
    #[test]
    fn wrong_producer_refuses() {
        let (mut v, mut i) = fixture();
        let def = Model::TfidfKeywords.definition().unwrap();
        i.implementations.push(Capability {
            step: def.step,
            model: def.model.clone(),
            adapter_sha256: "b".repeat(64),
        });
        let n = node(
            "t",
            Model::TfidfKeywords,
            v["nodes"][0]["declared"].clone(),
            json!([{"node":"e","role":"clusters"}]),
            3,
        )
        .unwrap();
        v["nodes"].as_array_mut().unwrap().push(n);
        assert!(matches!(ValidatedGraph::parse(v,&i),Err(e) if e=="graph_producer_type"));
    }
    #[test]
    fn test_models_are_a_build_choice() {
        assert_eq!(
            Model::named("local-token-count/1").is_ok(),
            cfg!(feature = "graph-test-models")
        );
        assert_eq!(
            Model::named("local-narrative-fixture/1").is_ok(),
            cfg!(feature = "graph-test-models")
        );
    }
}
