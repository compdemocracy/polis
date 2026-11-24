//! The topic map a Delphi run stores with its own results.
//!
//! A run that is told to (the Delphi daemon's `DELPHI_TOPIC_MAP_DOCUMENT=1`)
//! hands this module the three families it has just written, as their codec
//! files (`delphi-storage-codec/1`): the UMAP positions
//! (`Delphi_UMAPGraph`, its node rows), the clusters at every layer
//! (`Delphi_CommentHierarchicalClusterAssignments`) and the topic names
//! (`Delphi_CommentClustersLLMTopicNames`). [`store`] draws the map from
//! them with [`crate::build`] and returns the codec file of one more family,
//! `Delphi_TopicMapDocument`, which the run stores in the same result batch
//! through the same writer: the map publishes with the run or not at all.
//!
//! The family is keyed (`conversation_id` S, `part` S). A run's batch holds
//! either the three parts of a map:
//!
//! - `document`: `body` S, the `polis-topic-map/1` document; `bytes` N, its
//!   length in bytes; `schema` S, `polis-topic-map/1`;
//! - `document.gz`: `body` B, the document gzipped; `bytes` N, that length;
//! - `sha256`: `body` S, the SHA-256 of the document's bytes (64 lowercase
//!   hex digits);
//!
//! or the one row `no_map`: `reason` S, one of `too_large`, `no_positions`,
//! `no_topics`, `too_few_comments`, and for `too_large` the document's length
//! in `bytes` N. Beside either, the row `execution`: `body` S, the run's own
//! record of its steps as JSON ([`RunIdentity::execution`]). A run whose
//! generator failed holds only the row `no_map` with `reason`
//! `generator_failed` and `failure` S, one of [`DRAW_FAILURES`]; the
//! pipeline's step writes that row itself ([`NoMap::GeneratorFailed`]), and
//! the run's other results publish as they would without the map. Every row also
//! carries `job_id` S, the run's own job id, so a reader can tell the run's own
//! map from one carried forward from an earlier batch of the same publication.
//!
//! The document holds no comment text: `points.text` is empty, `title` and
//! `attribution` are empty (the document depends only on the run; a page joins
//! the text it already holds by comment id), and topic names pass
//! [`safe_name`], which keeps a name the run recorded as written by its model
//! as the model wrote it, keeps generic names and the keyword fallback's
//! keywords, never its example comment, and shows every other name as
//! `Topic <n>`. Its `provenance` names the run, its
//! publication scope and comment rule, its models, how its names were taken,
//! the three families it was drawn from (each by SHA-256 and row count) and
//! the run's execution record: its selection and counts, every step with its
//! seconds, and the parameters of UMAP, the clustering, the keywords and the
//! naming. Every stored row is at most [`ROW_LIMIT`] bytes as a codec line; a
//! map whose document or gzip row would be longer is stored as `no_map` /
//! `too_large`.
//!
//! Nothing here calls a model or reads a database: the same function serves
//! the pipeline's step and the backfill of runs stored before it (`from-run`),
//! so the two write the same bytes for one run.
use crate::{MapData, Proximity, ProximityPoint, Run, TopicName, Topics};
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;

/// The family's `delphi_result_catalog` name (migration 000049).
pub const FAMILY: &str = "Delphi_TopicMapDocument";
/// The family's key, in order.
pub const KEY: [&str; 2] = ["conversation_id", "part"];
pub const CODEC: &str = "delphi-storage-codec/1";
pub const POSITIONS: &str = "Delphi_UMAPGraph";
pub const ASSIGNMENTS: &str = "Delphi_CommentHierarchicalClusterAssignments";
pub const NAMES: &str = "Delphi_CommentClustersLLMTopicNames";
/// The families a map is drawn from, in the order provenance lists them.
pub const INPUTS: [&str; 3] = [POSITIONS, ASSIGNMENTS, NAMES];
/// The longest stored row, as its codec line in bytes (1 MiB).
pub const ROW_LIMIT: usize = 1_048_576;
pub const PROVENANCE_SCHEMA: &str = "polis-topic-map.provenance/1";

/// The parts a batch can hold.
pub mod part {
    pub const DOCUMENT: &str = "document";
    pub const EXECUTION: &str = "execution";
    pub const GZIP: &str = "document.gz";
    pub const SHA256: &str = "sha256";
    pub const NO_MAP: &str = "no_map";
}

/// Why a run stored no map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoMap {
    /// The document or its gzip would be a row over [`ROW_LIMIT`].
    TooLarge,
    /// The run stored no comment positions.
    NoPositions,
    /// The run stored no cluster layers or no topic names.
    NoTopics,
    /// The first view has no area (one or two comments, or the comments the
    /// generator keeps sit on one point or one horizontal or vertical line).
    TooFewComments,
    /// The generator did not draw the run's map (it was not installed, did not
    /// run, timed out, refused the run's families or wrote something else).
    /// The pipeline's step stores this row, never [`store`]; its `failure` is
    /// one of [`DRAW_FAILURES`], never the generator's message.
    GeneratorFailed,
}

/// The `failure` of a `generator_failed` row, as the pipeline's step names it
/// (`DRAW_FAILURES` in `delphi/polismath/delphi_storage/topic_map.py`).
pub const DRAW_FAILURES: [&str; 5] = [
    "not_installed",
    "did_not_run",
    "timed_out",
    "refused",
    "wrong_output",
];

impl NoMap {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            Self::NoPositions => "no_positions",
            Self::NoTopics => "no_topics",
            Self::TooFewComments => "too_few_comments",
            Self::GeneratorFailed => "generator_failed",
        }
    }
}

/// The run a map belongs to: what the pipeline's step knows from its job
/// frame and environment, and what the run record names for a stored run.
#[derive(Clone, Debug, PartialEq)]
pub struct RunIdentity {
    /// The result environment (`delphi_jobs.env`).
    pub env: String,
    pub job_id: String,
    pub run_id: String,
    /// The attempt whose result batch holds the run's families.
    pub batch_id: String,
    /// The conversation (`zid`).
    pub conversation_id: i64,
    /// The publication scope (`result_scope`): one per comment rule, so two
    /// runs of one conversation under different rules never share one.
    pub scope: String,
    /// The comment rule the run laid out (`participant_visible/1`, ...), or
    /// none for a run that names none.
    pub selection: Option<String>,
    /// The run's models, as its output manifest names them.
    pub models: Value,
    /// What the run's steps did, as the run recorded it while it ran (schema
    /// `delphi-run-execution/1`: its comment selection and counts, each step
    /// with its seconds and facts, the parameters of UMAP, the clustering, the
    /// keywords and the topic naming, and what the run could not know). Stored
    /// as the family's `execution` row, so the backfill reads the same object
    /// back; [`execution_unavailable`] for a run that recorded none.
    pub execution: Value,
}

pub const EXECUTION_SCHEMA: &str = "delphi-run-execution/1";

/// The execution object of a run that recorded none (stored before the step,
/// or made without one), saying so instead of guessing.
pub fn execution_unavailable(reason: &str) -> Value {
    serde_json::json!({"schema": EXECUTION_SCHEMA, "available": false, "reason": reason})
}

/// The rule that keeps comment text out of the stored topic names
/// ([`safe_name`]); provenance names it and counts what it did.
pub const NAMES_RULE: &str = "polis-topic-map.names/3";

/// How a map was made (the document's `provenance`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Provenance {
    pub schema: &'static str,
    pub env: String,
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "batchId")]
    pub batch_id: String,
    pub scope: String,
    pub selection: Option<String>,
    pub models: Value,
    /// How each topic's name was taken from the stored names.
    pub names: NameCounts,
    /// The stored families the map was drawn from.
    pub inputs: Vec<Input>,
    /// The run's own record of its steps ([`RunIdentity::execution`]).
    pub execution: Value,
    pub generator: Generator,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct NameCounts {
    pub rule: &'static str,
    /// Names the run recorded as written by its model, kept as written.
    pub written_by_model: usize,
    /// Generic names (`Topic <n>`, with or without its prefix), kept.
    pub generic: usize,
    /// Keyword labels, kept without any example comment.
    pub keywords: usize,
    /// Every other name (of a fallback, or of no recorded origin), since it
    /// might hold comment text: shown as `Topic <n>`.
    pub replaced: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Input {
    pub family: &'static str,
    pub sha256: String,
    pub rows: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Generator {
    pub name: &'static str,
    pub version: &'static str,
}

/// The three families' codec files, as the run stored (or is storing) them.
pub struct Wires<'a> {
    pub positions: &'a str,
    pub assignments: &'a str,
    pub names: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Map {
        document: usize,
        gzip: usize,
        sha256: String,
    },
    NoMap {
        reason: NoMap,
        /// The document's length, when it was made.
        document: Option<usize>,
    },
}

/// The family's codec file, what it holds, and the document when there is one.
#[derive(Debug)]
pub struct Stored {
    pub wire: String,
    pub outcome: Outcome,
    pub document: Option<String>,
}

/// The map of one run, as the codec file of `Delphi_TopicMapDocument`.
/// An error is a family that is not what the pipeline writes (a wrong codec
/// header, a row of another conversation, positions and clusters that name
/// different comments); a run with nothing to draw stores a `no_map` row.
pub fn store(run: &RunIdentity, wires: &Wires) -> Result<Stored, String> {
    store_with_limit(run, wires, ROW_LIMIT)
}

/// [`store`] with another row limit, for the tests of the limit.
#[doc(hidden)]
pub fn store_with_limit(run: &RunIdentity, wires: &Wires, limit: usize) -> Result<Stored, String> {
    let conversation = run.conversation_id.to_string();
    let positions = Codec::read(wires.positions, POSITIONS)?;
    let assignments = Codec::read(wires.assignments, ASSIGNMENTS)?;
    let names = Codec::read(wires.names, NAMES)?;
    let nodes = node_positions(&positions, &conversation)?;
    let clusters = cluster_rows(&assignments, &conversation)?;
    let (topics_by_layer, model, name_counts) =
        topic_names(&names, &conversation, &model_written(&run.execution))?;
    let execution = serde_json::to_string(&run.execution).map_err(|e| e.to_string())?;
    let mut execution_row = Item::new();
    execution_row.s("conversation_id", &conversation);
    execution_row.s("part", part::EXECUTION);
    execution_row.s("job_id", &run.job_id);
    execution_row.s("body", &execution);
    let execution_line = execution_row.line();
    if execution_line.len() > limit {
        return Err("the run's execution record is over the row limit".into());
    }
    let provenance = Provenance {
        schema: PROVENANCE_SCHEMA,
        env: run.env.clone(),
        job_id: run.job_id.clone(),
        run_id: run.run_id.clone(),
        batch_id: run.batch_id.clone(),
        scope: run.scope.clone(),
        selection: run.selection.clone(),
        models: run.models.clone(),
        names: name_counts,
        inputs: [
            (POSITIONS, &positions),
            (ASSIGNMENTS, &assignments),
            (NAMES, &names),
        ]
        .into_iter()
        .map(|(family, c)| Input {
            family,
            sha256: c.sha256.clone(),
            rows: c.rows,
        })
        .collect(),
        execution: run.execution.clone(),
        generator: Generator {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
        },
    };
    let no_map = |reason| Stored::no_map(run, reason, None, &execution_line);
    if nodes.is_empty() {
        return Ok(no_map(NoMap::NoPositions));
    }
    if nodes.len() != clusters.len() || nodes.keys().any(|t| !clusters.contains_key(t)) {
        return Err("the run's positions and clusters name different comments".into());
    }
    let layered = clusters.values().any(|layers| !layers.is_empty());
    if !layered || topics_by_layer.is_empty() {
        return Ok(no_map(NoMap::NoTopics));
    }
    let points = nodes
        .iter()
        .map(|(tid, (x, y))| ProximityPoint {
            comment_id: *tid,
            umap_x: *x,
            umap_y: *y,
            clusters: clusters
                .get(tid)
                .map(|layers| {
                    layers
                        .iter()
                        .map(|(layer, cluster)| (layer.to_string(), *cluster))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect();
    let mut data = crate::build(
        Proximity {
            proximity_data: points,
        },
        Topics {
            runs: BTreeMap::from([(
                run.job_id.clone(),
                Run {
                    created_at: None,
                    model_name: model,
                    topics_by_layer,
                },
            )]),
        },
        &BTreeMap::new(),
        "",
        "",
    )?;
    if !drawable(&data) {
        return Ok(no_map(NoMap::TooFewComments));
    }
    data.points.text = Vec::new();
    data.provenance = Some(provenance);
    let document = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    let gzip = gzip(document.as_bytes())?;
    let sha256 = hex(&Sha256::digest(document.as_bytes()));
    let base = |name: &str| -> Item {
        let mut item = Item::new();
        item.s("conversation_id", &conversation);
        item.s("part", name);
        item.s("job_id", &run.job_id);
        item
    };
    let mut doc_row = base(part::DOCUMENT);
    doc_row.s("body", &document);
    doc_row.n("bytes", document.len());
    doc_row.s("schema", crate::SCHEMA);
    let mut gz_row = base(part::GZIP);
    gz_row.b("body", &gzip);
    gz_row.n("bytes", gzip.len());
    let mut sha_row = base(part::SHA256);
    sha_row.s("body", &sha256);
    let lines = [doc_row.line(), gz_row.line(), sha_row.line()];
    if lines.iter().any(|l| l.len() > limit) {
        return Ok(Stored::no_map(
            run,
            NoMap::TooLarge,
            Some(document.len()),
            &execution_line,
        ));
    }
    let mut lines = lines.to_vec();
    lines.push(execution_line);
    Ok(Stored {
        wire: family_file(&conversation, lines),
        outcome: Outcome::Map {
            document: document.len(),
            gzip: gzip.len(),
            sha256,
        },
        document: Some(document),
    })
}

/// The execution record a stored map family holds (its `execution` row), if
/// it holds one.
pub fn stored_execution(wire: &str) -> Result<Option<Value>, String> {
    let family = Codec::read(wire, FAMILY)?;
    let mut found = None;
    family.each(|row| {
        if text(&row, "part") == Some(part::EXECUTION) {
            let body = text(&row, "body").ok_or("an execution row without a body")?;
            found = Some(serde_json::from_str(body).map_err(|e| format!("execution: {e}"))?);
        }
        Ok(())
    })?;
    Ok(found)
}

impl Stored {
    fn no_map(
        run: &RunIdentity,
        reason: NoMap,
        document: Option<usize>,
        execution_line: &str,
    ) -> Self {
        let conversation = run.conversation_id.to_string();
        let mut item = Item::new();
        item.s("conversation_id", &conversation);
        item.s("part", part::NO_MAP);
        item.s("job_id", &run.job_id);
        item.s("reason", reason.as_str());
        if let Some(bytes) = document {
            item.n("bytes", bytes);
        }
        Self {
            wire: family_file(&conversation, vec![item.line(), execution_line.to_owned()]),
            outcome: Outcome::NoMap { reason, document },
            document: None,
        }
    }
}

/// Every number of the document is finite and the first view has an area.
/// The generator keeps the 99.9% of comments nearest the middle (all but one
/// below 1,000 comments): with one or two comments, or when the comments it
/// keeps sit on one point, its standard size divides by zero; when they sit
/// on one horizontal or vertical line, the first view has no height or width.
pub fn drawable(data: &MapData) -> bool {
    let [x0, x1, y0, y1] = data.bounds;
    if !(x1 > x0 && y1 > y0) {
        return false;
    }
    let topics = data
        .topics
        .iter()
        .flat_map(|t| [t.x, t.y, t.weight].into_iter().chain(t.parent_share));
    data.bounds
        .iter()
        .copied()
        .chain([data.point_radius])
        .chain(data.points.x.iter().copied())
        .chain(data.points.y.iter().copied())
        .chain(topics)
        .all(f64::is_finite)
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // The header's time is 0 and it names no file, so the bytes depend only
    // on the document (and this crate's pinned flate2).
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::best());
    encoder.write_all(bytes).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One family's codec file, read line by line.
struct Codec<'a> {
    family: &'static str,
    body: &'a str,
    rows: u64,
    sha256: String,
}

impl<'a> Codec<'a> {
    fn read(wire: &'a str, family: &'static str) -> Result<Self, String> {
        let bad = |why: &str| format!("{family}: {why}");
        let body = wire
            .strip_suffix('\n')
            .ok_or_else(|| bad("the file does not end with a newline"))?;
        let (head, rest) = body.split_once('\n').unwrap_or((body, ""));
        let head: Value = serde_json::from_str(head).map_err(|_| bad("unreadable header"))?;
        if head.get("codec").and_then(Value::as_str) != Some(CODEC)
            || head.get("family").and_then(Value::as_str) != Some(family)
        {
            return Err(bad("not this family's codec header"));
        }
        let rows = if rest.is_empty() {
            0
        } else {
            rest.split('\n').count() as u64
        };
        Ok(Self {
            family,
            body: rest,
            rows,
            sha256: hex(&Sha256::digest(wire.as_bytes())),
        })
    }

    /// Each row, decoded one at a time (the positions family holds every
    /// UMAP edge beside the nodes, so it is never decoded whole).
    fn each(
        &self,
        mut row: impl FnMut(BTreeMap<String, Value>) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.body.is_empty() {
            return Ok(());
        }
        for line in self.body.split('\n') {
            row(serde_json::from_str(line)
                .map_err(|_| format!("{}: an unreadable row", self.family))?)?;
        }
        Ok(())
    }
}

fn tagged<'v>(row: &'v BTreeMap<String, Value>, key: &str, tag: &str) -> Option<&'v Value> {
    let map = row.get(key)?.as_object()?;
    if map.len() != 1 {
        return None;
    }
    map.get(tag)
}

fn is_null(row: &BTreeMap<String, Value>, key: &str) -> bool {
    tagged(row, key, "NULL") == Some(&Value::Bool(true))
}

fn text<'v>(row: &'v BTreeMap<String, Value>, key: &str) -> Option<&'v str> {
    tagged(row, key, "S")?.as_str()
}

fn number_text(value: &Value) -> Option<&str> {
    let map = value.as_object()?;
    if map.len() != 1 {
        return None;
    }
    map.get("N")?.as_str()
}

/// A canonical integer (`N` holds DynamoDB's canonical text).
fn integer(value: Option<&Value>) -> Option<i64> {
    let raw = number_text(value?)?;
    let n: i64 = raw.parse().ok()?;
    (n.to_string() == raw).then_some(n)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    let n: f64 = number_text(value?)?.parse().ok()?;
    n.is_finite().then_some(n)
}

fn own_conversation(
    row: &BTreeMap<String, Value>,
    conversation: &str,
    family: &str,
) -> Result<(), String> {
    if text(row, "conversation_id") == Some(conversation) {
        Ok(())
    } else {
        Err(format!("{family}: a row of another conversation"))
    }
}

/// tid -> (x, y), from the node rows (a node is the edge from a comment to
/// itself, with its position); edges are skipped.
fn node_positions(c: &Codec, conversation: &str) -> Result<BTreeMap<i64, (f64, f64)>, String> {
    let bad = || format!("{POSITIONS}: a node row without a comment id or a position");
    let mut out = BTreeMap::new();
    c.each(|row| {
        own_conversation(&row, conversation, POSITIONS)?;
        let (source, target) = (
            integer(row.get("source_id")).ok_or_else(bad)?,
            integer(row.get("target_id")).ok_or_else(bad)?,
        );
        if source != target {
            return Ok(());
        }
        let position = tagged(&row, "position", "M")
            .and_then(Value::as_object)
            .filter(|p| p.len() == 2)
            .ok_or_else(bad)?;
        let xy = (
            finite(position.get("x")).ok_or_else(bad)?,
            finite(position.get("y")).ok_or_else(bad)?,
        );
        if source < 0 || out.insert(source, xy).is_some() {
            return Err(format!("{POSITIONS}: two nodes for comment {source}"));
        }
        Ok(())
    })?;
    Ok(out)
}

/// tid -> layer -> cluster (-1: in no cluster at that layer). A layer stored
/// null has no assignment for that comment.
fn cluster_rows(
    c: &Codec,
    conversation: &str,
) -> Result<BTreeMap<i64, BTreeMap<u32, i64>>, String> {
    let bad = || format!("{ASSIGNMENTS}: an unreadable assignment");
    let mut out = BTreeMap::new();
    c.each(|row| {
        own_conversation(&row, conversation, ASSIGNMENTS)?;
        let tid = integer(row.get("comment_id"))
            .filter(|t| *t >= 0)
            .ok_or_else(bad)?;
        let mut layers = BTreeMap::new();
        for (key, value) in &row {
            let Some(layer) = key
                .strip_prefix("layer")
                .and_then(|k| k.strip_suffix("_cluster_id"))
            else {
                continue;
            };
            let layer_id: u32 = layer.parse().map_err(|_| bad())?;
            if layer_id.to_string() != layer {
                return Err(bad());
            }
            if value == &serde_json::json!({"NULL": true}) {
                continue;
            }
            let cluster = integer(Some(value)).filter(|n| *n >= -1).ok_or_else(bad)?;
            layers.insert(layer_id, cluster);
        }
        if out.insert(tid, layers).is_some() {
            return Err(format!("{ASSIGNMENTS}: two rows for comment {tid}"));
        }
        Ok(())
    })?;
    Ok(out)
}

type Names = BTreeMap<String, BTreeMap<String, TopicName>>;

/// How a stored topic name enters the map ([`NAMES_RULE`]). A name the run
/// recorded as written by its model (`written_by_model`: the naming decided
/// it when it made the name, and the run's execution record lists its topic,
/// [`model_written`]) is kept as the model wrote it. Of every other name, a
/// name of a fallback or of no recorded origin, only two shapes are stored,
/// because only these can be checked to hold no comment text:
///
/// - a generic name, `Topic <cluster>`, `<layer>_<cluster>: Topic <cluster>`
///   or `<layer>_<cluster>:`, kept as it is;
/// - the keyword fallback's label (`_conventional_labels` in
///   `umap_narrative/topic_naming.py`): `Keywords: ` and one to five keywords
///   joined by `, `, each as the keyword vectorizer makes them (lower case
///   letters, digits and `_`, two or more), then optionally ` | Example: ...`,
///   the whole cut to 50 characters ending `...`. Only its keywords are kept
///   (`Keywords: <words>`); the example, a participant's comment, never is.
///   Every word must have that shape, so a sentence or an `Example:` written
///   where the keywords go is not a keyword label.
///
/// Every other name is shown as `Topic <cluster>`. A `<layer>_<cluster>:`
/// prefix says which topic a name is for, never who wrote it nor what it
/// holds: the pipeline prefixes its `Topic <n>` fallback too. Who wrote a name
/// is only ever the run's own record, never its shape or prefix, and a model's
/// name is not checked here to be free of a comment's words. A change to
/// these rules is a new rule.
pub fn safe_name(
    layer: i64,
    cluster: i64,
    name: &str,
    written_by_model: bool,
) -> (Option<String>, NameKind) {
    if written_by_model {
        return (Some(name.to_owned()), NameKind::Model);
    }
    let generic = format!("Topic {cluster}");
    let prefix = format!("{layer}_{cluster}:");
    if name == generic || name == prefix || name == format!("{prefix} {generic}") {
        return (Some(name.to_owned()), NameKind::Generic);
    }
    if let Some(words) = keyword_words(name) {
        return (Some(format!("Keywords: {words}")), NameKind::Keywords);
    }
    (None, NameKind::Replaced)
}

/// The keywords of a keyword fallback label, if `name` has exactly that shape
/// ([`safe_name`]).
fn keyword_words(name: &str) -> Option<&str> {
    const CUT: usize = 50;
    const MARKER: &str = " Example: ";
    let rest = name.strip_prefix("Keywords: ")?;
    // The fallback cuts a label over 50 characters to 47 and `...`.
    let (rest, cut) = match rest.strip_suffix("...") {
        Some(r) if name.chars().count() == CUT => (r, true),
        _ => (rest, false),
    };
    let (words, example) = match rest.split_once(" |") {
        Some((w, e)) => (w, Some(e)),
        // A cut can fall inside the ` | ` before the example.
        None if cut => (rest.strip_suffix(' ').unwrap_or(rest), None),
        None => (rest, None),
    };
    // What follows the keywords is the example, or what the cut left of its
    // ` Example: `.
    if let Some(e) = example
        && !e.starts_with(MARKER)
        && !(cut && MARKER.starts_with(e))
    {
        return None;
    }
    let open_end = cut && example.is_none();
    let words = if open_end {
        words.trim_end_matches([',', ' '])
    } else {
        words
    };
    let list: Vec<&str> = words.split(", ").collect();
    if list.len() > 5 {
        return None;
    }
    let last = list.len() - 1;
    for (i, w) in list.iter().enumerate() {
        // The cut may end inside the last keyword when no example follows.
        let shortest = if open_end && i == last { 1 } else { 2 };
        let ok = w.chars().count() >= shortest
            && w.chars()
                .all(|c| (c.is_alphanumeric() || c == '_') && !c.is_uppercase());
        if !ok {
            return None;
        }
    }
    Some(words)
}

/// How a stored name was taken ([`safe_name`]): by its recorded origin, or
/// else by its shape, which is not who wrote it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameKind {
    /// The run recorded its model as the name's writer: kept as written.
    Model,
    /// `Topic <n>`, with or without its topic's prefix, or the prefix alone.
    Generic,
    /// A keyword fallback label, kept as its keywords.
    Keywords,
    /// Any other name: shown as `Topic <n>`.
    Replaced,
}

/// The topics (layer, cluster) whose names the run recorded as written by its
/// model: each `topic_names` entry of the execution record's `algorithms`
/// lists them as `model_clusters` for its `layer`. A record that is
/// unavailable, or an entry without that list, names none, so those names are
/// of no recorded origin.
pub fn model_written(execution: &Value) -> BTreeSet<(i64, i64)> {
    let mut out = BTreeSet::new();
    if execution.get("available") != Some(&Value::Bool(true)) {
        return out;
    }
    let entries = execution
        .pointer("/algorithms/topic_names")
        .and_then(Value::as_array);
    for entry in entries.into_iter().flatten() {
        let (Some(layer), Some(clusters)) = (
            entry.get("layer").and_then(Value::as_i64),
            entry.get("model_clusters").and_then(Value::as_array),
        ) else {
            continue;
        };
        out.extend(
            clusters
                .iter()
                .filter_map(Value::as_i64)
                .map(|c| (layer, c)),
        );
    }
    out
}

/// layer -> cluster -> name, the one model that named them all, if one, and
/// how the names were taken ([`safe_name`]).
fn topic_names(
    c: &Codec,
    conversation: &str,
    model_written: &BTreeSet<(i64, i64)>,
) -> Result<(Names, Option<String>, NameCounts), String> {
    let bad = || format!("{NAMES}: an unreadable topic name");
    let optional = |row: &BTreeMap<String, Value>, key: &str| -> Result<Option<String>, String> {
        if !row.contains_key(key) || is_null(row, key) {
            return Ok(None);
        }
        text(row, key).map(|s| Some(s.to_owned())).ok_or_else(bad)
    };
    let mut out = Names::new();
    let mut models = BTreeSet::new();
    let mut counts = NameCounts {
        rule: NAMES_RULE,
        ..NameCounts::default()
    };
    c.each(|row| {
        own_conversation(&row, conversation, NAMES)?;
        let layer = integer(row.get("layer_id"))
            .filter(|l| *l >= 0)
            .ok_or_else(bad)?;
        let cluster = integer(row.get("cluster_id"))
            .filter(|n| *n >= -1)
            .ok_or_else(bad)?;
        let stored = optional(&row, "topic_name")?;
        let topic_key = Some(text(&row, "topic_key").ok_or_else(bad)?.to_owned());
        models.insert(optional(&row, "model_name")?);
        if cluster < 0 {
            return Ok(());
        }
        let (topic_name, kind) = match stored {
            Some(s) => safe_name(
                layer,
                cluster,
                &s,
                model_written.contains(&(layer, cluster)),
            ),
            None => (None, NameKind::Replaced),
        };
        match kind {
            NameKind::Model => counts.written_by_model += 1,
            NameKind::Generic => counts.generic += 1,
            NameKind::Keywords => counts.keywords += 1,
            NameKind::Replaced => counts.replaced += 1,
        }
        let name = TopicName {
            topic_name,
            topic_key,
        };
        if out
            .entry(layer.to_string())
            .or_default()
            .insert(cluster.to_string(), name)
            .is_some()
        {
            return Err(format!("{NAMES}: two names for topic {layer}_{cluster}"));
        }
        Ok(())
    })?;
    let model = match models.len() {
        1 => models.into_iter().next().flatten(),
        _ => None,
    };
    Ok((out, model, counts))
}

/// One stored row, written as the frozen codec writes it: attribute names in
/// byte order, each value one tag, canonical JSON.
struct Item(BTreeMap<&'static str, String>);

impl Item {
    fn new() -> Self {
        Self(BTreeMap::new())
    }
    fn s(&mut self, name: &'static str, value: &str) {
        self.0
            .insert(name, format!("{{\"S\":{}}}", canonical_string(value)));
    }
    fn n(&mut self, name: &'static str, value: usize) {
        self.0.insert(name, format!("{{\"N\":\"{value}\"}}"));
    }
    fn b(&mut self, name: &'static str, value: &[u8]) {
        let text = base64::engine::general_purpose::STANDARD.encode(value);
        self.0.insert(name, format!("{{\"B\":\"{text}\"}}"));
    }
    fn line(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(name, value)| format!("{}:{value}", canonical_string(name)))
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

/// The codec's string: `"` and `\` escaped, `\b \f \n \r \t` short, every
/// other character below U+0020 as `\u00xx`, everything else as it is.
pub fn canonical_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The codec file of the family: the header, then the rows in the byte order
/// of their key values' canonical JSON.
fn family_file(conversation: &str, lines: Vec<String>) -> String {
    let key = |line: &str| -> String {
        // Every row here has the same conversation; its part orders it.
        let part = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v["part"]["S"].as_str().map(str::to_owned))
            .unwrap_or_default();
        format!(
            "[{{\"S\":{}}},{{\"S\":{}}}]",
            canonical_string(conversation),
            canonical_string(&part)
        )
    };
    let mut keyed: Vec<(String, String)> = lines.into_iter().map(|l| (key(&l), l)).collect();
    keyed.sort();
    let mut out = format!(
        "{{\"codec\":\"{CODEC}\",\"family\":\"{FAMILY}\",\"key\":[\"{}\",\"{}\"]}}\n",
        KEY[0], KEY[1]
    );
    for (_, line) in keyed {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    fn the_codec_string_escapes_as_the_frozen_codec_does() {
        assert_eq!(
            canonical_string("a\"b\\c\u{8}\u{c}\n\r\t\u{0}\u{1f}\u{7f}é \u{2028}/"),
            "\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0000\\u001f\u{7f}é \u{2028}/\""
        );
    }

    /// The record a run given a namer writes for each layer
    /// (`_name_with_namer` in `delphi/umap_narrative/run_pipeline.py`): named,
    /// every cluster is the model's; on any other outcome it is recorded
    /// under `keywords` with no model cluster, so its labels are taken by
    /// their shape.
    #[test]
    fn the_namers_record_names_the_models_clusters_only_when_it_named() {
        let entry = |layer: i64, model: &str, outcome: &str, clusters: Value| {
            serde_json::json!({"layer": layer, "provider": "polis-topic-names", "model": model,
                "namer": "{\"model\":\"claude-haiku-5-5\",\"prompt\":\"polis-topic-names/1\",\"thinking\":\"default\"}",
                "prompt": "polis-topic-names/1", "thinking": "default", "outcome": outcome,
                "reason": null, "clusters": 2, "written_by_model": 2, "fallback": 0,
                "origin_unknown": 0, "model_clusters": clusters})
        };
        let record = |entries: Value| {
            serde_json::json!({"schema": EXECUTION_SCHEMA, "available": true,
                "algorithms": {"topic_names": entries}})
        };
        let named = record(serde_json::json!([
            entry(0, "claude-haiku-5-5", "named", serde_json::json!([0, 1])),
            entry(1, "claude-haiku-5-5", "named", serde_json::json!([0])),
        ]));
        assert_eq!(
            model_written(&named),
            BTreeSet::from([(0, 0), (0, 1), (1, 0)])
        );
        assert_eq!(
            safe_name(0, 1, "0_1: Parks, Roads, and Housing", true),
            (
                Some("0_1: Parks, Roads, and Housing".to_owned()),
                NameKind::Model
            )
        );
        let failed = record(serde_json::json!([entry(
            0,
            "keywords",
            "http_429",
            serde_json::json!([])
        )]));
        assert!(model_written(&failed).is_empty());
        assert_eq!(
            safe_name(0, 1, "0_1: Parks, Roads, and Housing", false),
            (None, NameKind::Replaced)
        );
        assert!(model_written(&execution_unavailable("none")).is_empty());
    }

    #[test]
    fn rows_are_in_key_order_with_names_in_byte_order() {
        let mut a = Item::new();
        a.s("part", "sha256");
        a.s("conversation_id", "7");
        a.s("body", "x");
        let mut b = Item::new();
        b.s("part", "document.gz");
        b.s("conversation_id", "7");
        let mut c = Item::new();
        c.s("part", "document");
        c.s("conversation_id", "7");
        c.n("bytes", 12);
        let wire = family_file("7", vec![a.line(), b.line(), c.line()]);
        assert_eq!(
            wire,
            concat!(
                "{\"codec\":\"delphi-storage-codec/1\",\"family\":\"Delphi_TopicMapDocument\",\"key\":[\"conversation_id\",\"part\"]}\n",
                "{\"bytes\":{\"N\":\"12\"},\"conversation_id\":{\"S\":\"7\"},\"part\":{\"S\":\"document\"}}\n",
                "{\"conversation_id\":{\"S\":\"7\"},\"part\":{\"S\":\"document.gz\"}}\n",
                "{\"body\":{\"S\":\"x\"},\"conversation_id\":{\"S\":\"7\"},\"part\":{\"S\":\"sha256\"}}\n",
            )
        );
    }
}
