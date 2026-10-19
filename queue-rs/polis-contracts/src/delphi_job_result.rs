//! `delphi-job-result/1`: one Delphi job's outputs as one versioned envelope.
//!
//! A port of the Node contract (server/src/contracts/delphiJobResult.ts) with
//! no field change. [`schema_document`] renders the same JSON Schema bytes as
//! the committed server/src/contracts/delphiJobResult.schema.json and its
//! client copies, and a value encodes ([`crate::wire::to_json`]) to the bytes
//! Node's `JSON.stringify` writes for it with its keys in the schema's
//! property order. The typed assignments route serves this contract. The README section of the same
//! name is the plain-language contract.
//!
//! Five states share one envelope, discriminated by `status`: `ready`,
//! `pending`, `running`, `failed`, `empty`. Each state is its own Rust type,
//! so a `ready` value cannot carry an attempt and a `failed` one cannot lack
//! its failure; `omitted` is computed from `outputs`, never stored.
use crate::delphi_run::RunFamily;
use crate::schema::{
    array, boolean, integer, literal, literal_bool, null, nullable, number, object, optional,
    record, required as prop, string, union, Prop, Schema,
};
use crate::wire::{
    self, index, literal, present, required, text, Extra, Fields, Invalid, JsMap, JsNumber, Json,
    Null,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::num::NonZeroU32;

/// The contract's serialized name and version.
pub const CONTRACT_VERSION: &str = "delphi-job-result/1";

literal!(
    /// `contract_version`: always `delphi-job-result/1`.
    ContractVersion,
    "delphi-job-result/1"
);
literal!(ReadyStatus, "ready");
literal!(PendingStatus, "pending");
literal!(RunningStatus, "running");
literal!(FailedStatus, "failed");
literal!(EmptyStatus, "empty");

text!(
    /// Public job id: a uuid, or the frozen alias of a legacy import.
    PublicJobId,
    wire::non_empty
);
text!(
    /// Queue execution identity (`polis_queue_runs.run_id`).
    RunId,
    wire::non_empty
);
text!(
    /// The conversation's zinvite, never zid.
    ConversationId,
    wire::non_empty
);
text!(ReportId, wire::non_empty);
text!(
    /// `<job_id>#<layer>#<cluster>`; the format is itself part of the contract.
    TopicKey,
    wire::non_empty
);
text!(
    /// A narrative section name (`group_informed_consensus`, `<job>_<layer>_<cluster>`, …).
    SectionKey,
    wire::any_text
);
text!(StatementId, wire::non_empty);
text!(
    /// An ISO 8601 time with a zone: `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`.
    Timestamp,
    wire::timestamp
);
text!(ModelName, wire::any_text);
text!(TopicName, wire::any_text);
text!(
    /// The math engine label of the snapshot (`math_main.math_env`).
    MathEnv,
    wire::any_text
);
text!(PromptVersion, wire::any_text);
text!(Label, wire::any_text);
text!(Keyword, wire::any_text);
text!(
    /// For example `interactive` or `static_png`.
    VisualizationKind,
    wire::any_text
);
text!(Url, wire::any_text);
text!(ObjectKey, wire::any_text);
text!(
    /// The step that failed, e.g. `topic_naming`.
    StageName,
    wire::non_empty
);
text!(
    /// pca2's `repful-for` (`agree` or `disagree` today; pca2/1 leaves it open).
    Repful,
    wire::any_text
);

index!(
    /// A comment id.
    Tid
);
index!(
    /// A hierarchy layer (0 is the finest).
    LayerId
);
index!(
    /// A math group id (pca2).
    GroupId
);

/// A comment's cluster in one layer: `-1` is unassigned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Cluster {
    Unassigned,
    Id(u32),
}
impl Serialize for Cluster {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Cluster::Unassigned => serializer.serialize_i64(-1),
            Cluster::Id(n) => serializer.serialize_u32(*n),
        }
    }
}
impl<'de> Deserialize<'de> for Cluster {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match i64::deserialize(deserializer)? {
            -1 => Ok(Cluster::Unassigned),
            n => u32::try_from(n).map(Cluster::Id).map_err(|_| {
                serde::de::Error::custom(format!("cluster {n} is neither -1 nor a cluster id"))
            }),
        }
    }
}

/// An attempt number: the first attempt is 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AttemptNumber(NonZeroU32);
impl AttemptNumber {
    pub fn new(n: u32) -> Result<Self, Invalid> {
        NonZeroU32::new(n)
            .map(Self)
            .ok_or_else(|| Invalid("an attempt number is at least 1".into()))
    }
    pub fn get(self) -> u32 {
        self.0.get()
    }
}

/// `inputs.math_tick`: the math generation the root captured.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MathTick(pub u64);

// --- families ---------------------------------------------------------------------

/// The nine result families, in the contract's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelphiFamily {
    TopicsByLayer,
    Assignments,
    Keywords,
    Umap,
    Visualizations,
    Narratives,
    CollectiveStatements,
    TopicStats,
    ConsensusInputs,
}
impl DelphiFamily {
    pub const ALL: [Self; 9] = [
        Self::TopicsByLayer,
        Self::Assignments,
        Self::Keywords,
        Self::Umap,
        Self::Visualizations,
        Self::Narratives,
        Self::CollectiveStatements,
        Self::TopicStats,
        Self::ConsensusInputs,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TopicsByLayer => "topics_by_layer",
            Self::Assignments => "assignments",
            Self::Keywords => "keywords",
            Self::Umap => "umap",
            Self::Visualizations => "visualizations",
            Self::Narratives => "narratives",
            Self::CollectiveStatements => "collective_statements",
            Self::TopicStats => "topic_stats",
            Self::ConsensusInputs => "consensus_inputs",
        }
    }
    /// The run-record families (`delphi-run/1`) this family is read from.
    /// `topic_stats` and `consensus_inputs` also read the run's math
    /// snapshot, and `consensus_inputs` reads nothing else.
    pub const fn sources(self) -> &'static [RunFamily] {
        use RunFamily as R;
        match self {
            Self::TopicsByLayer => &[
                R::CommentClustersLlmTopicNames,
                R::CommentHierarchicalClusterAssignments,
            ],
            Self::Assignments => &[R::CommentHierarchicalClusterAssignments],
            Self::Keywords => &[R::CommentClustersStructureKeywords],
            Self::Umap => &[R::UmapGraph, R::CommentHierarchicalClusterAssignments],
            Self::Visualizations => &[R::Visualizations],
            Self::Narratives => &[R::NarrativeReports],
            Self::CollectiveStatements => &[R::CollectiveStatement],
            Self::TopicStats => &[R::TopicStats],
            Self::ConsensusInputs => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Topic {
    pub topic_key: TopicKey,
    pub layer_id: LayerId,
    pub cluster_id: Cluster,
    pub topic_name: TopicName,
    pub model_name: ModelName,
    pub comment_count: u64,
    pub member_tids: Vec<Tid>,
}

/// Keyed by layer id.
pub type TopicsByLayer = JsMap<LayerId, Vec<Topic>>;
/// tid → layer id → cluster.
pub type Assignments = JsMap<Tid, JsMap<LayerId, Cluster>>;
/// Keyed by topic_key.
pub type Keywords = JsMap<TopicKey, Vec<Keyword>>;

/// A comment position. Participant-safe: never carries comment text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UmapNode {
    pub tid: Tid,
    pub x: JsNumber,
    pub y: JsNumber,
    pub layer_cluster: JsMap<LayerId, Cluster>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub weight: Option<JsNumber>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UmapEdge {
    pub source: Tid,
    pub target: Tid,
    pub weight: JsNumber,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub distance: Option<JsNumber>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub is_nearest_neighbor: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Umap {
    pub nodes: Vec<UmapNode>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub edges: Option<Vec<UmapEdge>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Visualization {
    #[serde(rename = "type")]
    pub kind: VisualizationKind,
    pub layer_id: LayerId,
    pub url: Url,
    pub key: ObjectKey,
}

// Narrative and statement documents are what the LLM produced, parsed and
// validated server-side; they allow additional keys, kept in `extra`.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NarrativeClause {
    pub text: String,
    pub citations: Vec<Tid>,
    #[serde(flatten)]
    pub extra: Extra<NarrativeClause>,
}
impl Fields for NarrativeClause {
    const NAMES: &'static [&'static str] = &["text", "citations"];
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NarrativeSentence {
    pub clauses: Vec<NarrativeClause>,
    #[serde(flatten)]
    pub extra: Extra<NarrativeSentence>,
}
impl Fields for NarrativeSentence {
    const NAMES: &'static [&'static str] = &["clauses"];
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NarrativeParagraph {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub title: Option<String>,
    pub sentences: Vec<NarrativeSentence>,
    #[serde(flatten)]
    pub extra: Extra<NarrativeParagraph>,
}
impl Fields for NarrativeParagraph {
    const NAMES: &'static [&'static str] = &["id", "title", "sentences"];
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NarrativeDocument {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub title: Option<String>,
    pub paragraphs: Vec<NarrativeParagraph>,
    #[serde(flatten)]
    pub extra: Extra<NarrativeDocument>,
}
impl Fields for NarrativeDocument {
    const NAMES: &'static [&'static str] = &["id", "title", "paragraphs"];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrativeInvalidReason {
    TruncatedJson,
    UnparseableJson,
    SchemaMismatch,
}
impl NarrativeInvalidReason {
    pub const ALL: [Self; 3] = [
        Self::TruncatedJson,
        Self::UnparseableJson,
        Self::SchemaMismatch,
    ];
}

/// A section's stored output parsed (`valid`), or the closed reason it did
/// not (`invalid`). Listed, never dropped and never repaired.
#[derive(Clone, Debug, PartialEq)]
pub enum NarrativeOutcome {
    Valid(NarrativeDocument),
    Invalid(NarrativeInvalidReason),
}

/// One narrative section. The raw model output is never served; `raw_len`
/// is its length.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(try_from = "SectionIn")]
pub struct NarrativeSection {
    pub model: ModelName,
    pub created_at: Timestamp,
    pub source_topic_job_id: Option<PublicJobId>,
    pub raw_len: u64,
    pub outcome: NarrativeOutcome,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Validity {
    Valid,
    Invalid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SectionIn {
    model: ModelName,
    created_at: Timestamp,
    #[serde(deserialize_with = "required")]
    source_topic_job_id: Option<PublicJobId>,
    raw_len: u64,
    validity: Validity,
    #[serde(deserialize_with = "required")]
    invalid_reason: Option<NarrativeInvalidReason>,
    #[serde(deserialize_with = "required")]
    parsed: Option<NarrativeDocument>,
}
impl TryFrom<SectionIn> for NarrativeSection {
    type Error = Invalid;
    fn try_from(s: SectionIn) -> Result<Self, Invalid> {
        let outcome = match (s.validity, s.invalid_reason, s.parsed) {
            (Validity::Valid, None, Some(doc)) => NarrativeOutcome::Valid(doc),
            (Validity::Invalid, Some(reason), None) => NarrativeOutcome::Invalid(reason),
            (Validity::Valid, _, _) => {
                return wire::invalid("a valid section has parsed and no invalid_reason")
            }
            (Validity::Invalid, _, _) => {
                return wire::invalid("an invalid section has an invalid_reason and no parsed")
            }
        };
        Ok(Self {
            model: s.model,
            created_at: s.created_at,
            source_topic_job_id: s.source_topic_job_id,
            raw_len: s.raw_len,
            outcome,
        })
    }
}
impl Serialize for NarrativeSection {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Out<'a> {
            model: &'a ModelName,
            created_at: &'a Timestamp,
            source_topic_job_id: &'a Option<PublicJobId>,
            raw_len: u64,
            validity: Validity,
            invalid_reason: Option<NarrativeInvalidReason>,
            parsed: Option<&'a NarrativeDocument>,
        }
        let (validity, invalid_reason, parsed) = match &self.outcome {
            NarrativeOutcome::Valid(doc) => (Validity::Valid, None, Some(doc)),
            NarrativeOutcome::Invalid(reason) => (Validity::Invalid, Some(*reason), None),
        };
        Out {
            model: &self.model,
            created_at: &self.created_at,
            source_topic_job_id: &self.source_topic_job_id,
            raw_len: self.raw_len,
            validity,
            invalid_reason,
            parsed,
        }
        .serialize(serializer)
    }
}

/// Keyed by section.
pub type Narratives = JsMap<SectionKey, NarrativeSection>;

/// What a collective statement was computed against; `null` where a legacy
/// statement did not record it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectiveStatementInputs {
    pub topic_job_id: PublicJobId,
    #[serde(deserialize_with = "required")]
    pub assignments_job_id: Option<PublicJobId>,
    #[serde(deserialize_with = "required")]
    pub math_tick: Option<MathTick>,
}

/// A stored statement. Reads list stored statements and never generate one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectiveStatement {
    pub statement_id: StatementId,
    pub topic_key: TopicKey,
    pub topic_name: TopicName,
    pub created_at: Timestamp,
    pub model: ModelName,
    pub inputs: CollectiveStatementInputs,
    pub statement: NarrativeDocument,
}

/// A topic's vote totals over every voter, from the captured math snapshot.
/// `seen` is not stored: it is `agree + disagree + pass`, written on encode
/// and checked on decode.
#[derive(Clone, Debug, PartialEq)]
pub struct TopicStatsEntry {
    pub comment_tids: Vec<Tid>,
    pub agree: u64,
    pub disagree: u64,
    pub pass: u64,
    pub group_aware_consensus: Option<JsNumber>,
    pub normalized_consensus: Option<JsNumber>,
}
impl TopicStatsEntry {
    pub fn seen(&self) -> Option<u64> {
        self.agree
            .checked_add(self.disagree)?
            .checked_add(self.pass)
    }
}
#[derive(Serialize)]
struct TopicStatsOut<'a> {
    comment_tids: &'a [Tid],
    agree: u64,
    disagree: u64,
    pass: u64,
    seen: u64,
    group_aware_consensus: &'a Option<JsNumber>,
    normalized_consensus: &'a Option<JsNumber>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TopicStatsIn {
    comment_tids: Vec<Tid>,
    agree: u64,
    disagree: u64,
    pass: u64,
    seen: u64,
    #[serde(deserialize_with = "required")]
    group_aware_consensus: Option<JsNumber>,
    #[serde(deserialize_with = "required")]
    normalized_consensus: Option<JsNumber>,
}
impl Serialize for TopicStatsEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let seen = self
            .seen()
            .ok_or_else(|| serde::ser::Error::custom("seen overflows"))?;
        TopicStatsOut {
            comment_tids: &self.comment_tids,
            agree: self.agree,
            disagree: self.disagree,
            pass: self.pass,
            seen,
            group_aware_consensus: &self.group_aware_consensus,
            normalized_consensus: &self.normalized_consensus,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for TopicStatsEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let w = TopicStatsIn::deserialize(deserializer)?;
        let entry = TopicStatsEntry {
            comment_tids: w.comment_tids,
            agree: w.agree,
            disagree: w.disagree,
            pass: w.pass,
            group_aware_consensus: w.group_aware_consensus,
            normalized_consensus: w.normalized_consensus,
        };
        if entry.seen() != Some(w.seen) {
            return Err(serde::de::Error::custom("seen is agree + disagree + pass"));
        }
        Ok(entry)
    }
}

/// Keyed by topic_key.
pub type TopicStats = JsMap<TopicKey, TopicStatsEntry>;

/// One comment's vote counts over every voter (the `/comments`
/// agree_count, disagree_count, pass_count).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommentVotes {
    pub agree_count: u64,
    pub disagree_count: u64,
    pub pass_count: u64,
}

/// pca2/1 objects allow additional keys (the Python engine publishes extra
/// ones); they are kept in `extra`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pca2VoteCounts {
    /// Agree votes.
    #[serde(rename = "A")]
    pub agree: JsNumber,
    /// Disagree votes.
    #[serde(rename = "D")]
    pub disagree: JsNumber,
    /// Seen: every vote cast on the comment by the group, agree, disagree and pass.
    #[serde(rename = "S")]
    pub seen: JsNumber,
    #[serde(flatten)]
    pub extra: Extra<Pca2VoteCounts>,
}
impl Fields for Pca2VoteCounts {
    const NAMES: &'static [&'static str] = &["A", "D", "S"];
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pca2GroupVoteEntry {
    /// Keyed by tid.
    pub votes: JsMap<Tid, Pca2VoteCounts>,
    #[serde(
        rename = "n-members",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub n_members: Option<JsNumber>,
    #[serde(flatten)]
    pub extra: Extra<Pca2GroupVoteEntry>,
}
impl Fields for Pca2GroupVoteEntry {
    const NAMES: &'static [&'static str] = &["votes", "n-members"];
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pca2RepnessEntry {
    pub tid: JsNumber,
    #[serde(
        rename = "repful-for",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub repful_for: Option<Repful>,
    #[serde(
        rename = "p-success",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub p_success: Option<JsNumber>,
    #[serde(flatten)]
    pub extra: Extra<Pca2RepnessEntry>,
}
impl Fields for Pca2RepnessEntry {
    const NAMES: &'static [&'static str] = &["tid", "repful-for", "p-success"];
}

/// Keyed by group id.
pub type Pca2GroupVotes = JsMap<GroupId, Pca2GroupVoteEntry>;
/// Representative comments, keyed by group id.
pub type Pca2Repness = JsMap<GroupId, Vec<Pca2RepnessEntry>>;

/// The per-comment math the topic pages read, from the captured snapshot
/// (`inputs.math_tick`). On a zero-vote root every map is present and empty.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsensusInputs {
    pub group_votes: Pca2GroupVotes,
    pub repness: Pca2Repness,
    /// Keyed by tid: pca2 group-aware-consensus at the captured tick.
    pub group_aware_consensus: JsMap<Tid, JsNumber>,
    /// Keyed by tid: group-aware consensus normalized server-side.
    pub group_consensus_normalized: JsMap<Tid, JsNumber>,
    /// Keyed by tid.
    pub comment_votes: JsMap<Tid, CommentVotes>,
}

/// The families an envelope serves. A family absent here is listed in
/// `omitted`, so a client never reads "not requested" or "not produced" as
/// "empty".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DelphiJobOutputs {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub topics_by_layer: Option<TopicsByLayer>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub assignments: Option<Assignments>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub keywords: Option<Keywords>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub umap: Option<Umap>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub visualizations: Option<Vec<Visualization>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub narratives: Option<Narratives>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub collective_statements: Option<Vec<CollectiveStatement>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub topic_stats: Option<TopicStats>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub consensus_inputs: Option<ConsensusInputs>,
}
impl DelphiJobOutputs {
    pub fn has(&self, family: DelphiFamily) -> bool {
        match family {
            DelphiFamily::TopicsByLayer => self.topics_by_layer.is_some(),
            DelphiFamily::Assignments => self.assignments.is_some(),
            DelphiFamily::Keywords => self.keywords.is_some(),
            DelphiFamily::Umap => self.umap.is_some(),
            DelphiFamily::Visualizations => self.visualizations.is_some(),
            DelphiFamily::Narratives => self.narratives.is_some(),
            DelphiFamily::CollectiveStatements => self.collective_statements.is_some(),
            DelphiFamily::TopicStats => self.topic_stats.is_some(),
            DelphiFamily::ConsensusInputs => self.consensus_inputs.is_some(),
        }
    }
    /// The families not served, in the contract's order.
    pub fn omitted(&self) -> Vec<DelphiFamily> {
        DelphiFamily::ALL
            .into_iter()
            .filter(|f| !self.has(*f))
            .collect()
    }
}

/// The empty `outputs` of a state that carries none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoOutputs {}

/// `omitted` of a state that carries no outputs: every family.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AllOmitted;
impl Serialize for AllOmitted {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        DelphiFamily::ALL.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for AllOmitted {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut families = Vec::<DelphiFamily>::deserialize(deserializer)?;
        families.sort();
        if families == DelphiFamily::ALL {
            Ok(AllOmitted)
        } else {
            Err(serde::de::Error::custom(
                "this state omits every family, each once",
            ))
        }
    }
}

// --- envelope ---------------------------------------------------------------------

/// The math snapshot the root captured at start, and the models and prompt
/// versions it ran with. `null` leaves mean the root did not record it
/// (legacy imports).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobInputs {
    #[serde(deserialize_with = "required")]
    pub math_tick: Option<MathTick>,
    #[serde(deserialize_with = "required")]
    pub math_env: Option<MathEnv>,
    #[serde(deserialize_with = "required")]
    pub vote_count: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub comment_count: Option<u64>,
    pub model: JobModels,
    pub prompt_version: JobPromptVersions,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobModels {
    pub topic_names: ModelName,
    #[serde(deserialize_with = "required")]
    pub narrative: Option<ModelName>,
    #[serde(deserialize_with = "required")]
    pub statement: Option<ModelName>,
    #[serde(deserialize_with = "required")]
    pub embedding: Option<ModelName>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobPromptVersions {
    #[serde(deserialize_with = "required")]
    pub topic_names: Option<PromptVersion>,
    #[serde(deserialize_with = "required")]
    pub narrative: Option<PromptVersion>,
    #[serde(deserialize_with = "required")]
    pub statement: Option<PromptVersion>,
}

/// Why a run failed: a closed code, never log text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    StageFailed,
    ManifestInvalid,
    Timeout,
    LeaseExpired,
    UnknownStage,
    ProviderFailed,
    Cancelled,
}
impl FailureCode {
    pub const ALL: [Self; 7] = [
        Self::StageFailed,
        Self::ManifestInvalid,
        Self::Timeout,
        Self::LeaseExpired,
        Self::UnknownStage,
        Self::ProviderFailed,
        Self::Cancelled,
    ];
}

/// Never carries log text, an exception message or a stack trace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub code: FailureCode,
    #[serde(deserialize_with = "required")]
    pub stage: Option<StageName>,
    pub attempt: AttemptNumber,
    pub at: Timestamp,
}

/// The wire order of every state's envelope; each state fixes some of these
/// to a literal. Every key is required (`field`), including the nullable ones.
#[derive(Serialize, Deserialize)]
#[serde(
    deny_unknown_fields,
    bound(
        deserialize = "S: Deserialize<'de>, J: Deserialize<'de>, R: Deserialize<'de>, \
                       P: Deserialize<'de>, A: Deserialize<'de>, I: Deserialize<'de>, \
                       T: Deserialize<'de>, F: Deserialize<'de>, B: Deserialize<'de>, \
                       L: Deserialize<'de>, O: Deserialize<'de>, M: Deserialize<'de>"
    )
)]
struct Envelope<S, J, R, P, A, I, T, F, B, L, O, M> {
    contract_version: ContractVersion,
    #[serde(deserialize_with = "field")]
    job_id: J,
    #[serde(deserialize_with = "field")]
    run_id: R,
    conversation_id: ConversationId,
    #[serde(deserialize_with = "field")]
    report_id: P,
    #[serde(deserialize_with = "field")]
    status: S,
    #[serde(deserialize_with = "field")]
    as_of: A,
    #[serde(deserialize_with = "field")]
    inputs: I,
    #[serde(deserialize_with = "field")]
    attempt: T,
    #[serde(deserialize_with = "field")]
    failure: F,
    #[serde(deserialize_with = "field")]
    pinned: B,
    #[serde(deserialize_with = "field")]
    label: L,
    #[serde(deserialize_with = "field")]
    outputs: O,
    #[serde(deserialize_with = "field")]
    omitted: M,
}

/// A required key of any type (serde would read a missing `Option` as `None`).
fn field<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<T, D::Error> {
    T::deserialize(deserializer)
}

/// A completed root. `as_of` is its completed_at.
#[derive(Clone, Debug, PartialEq)]
pub struct Ready {
    pub job_id: PublicJobId,
    pub run_id: Option<RunId>,
    pub conversation_id: ConversationId,
    pub report_id: Option<ReportId>,
    pub as_of: Timestamp,
    pub inputs: JobInputs,
    pub pinned: bool,
    pub label: Option<Label>,
    pub outputs: DelphiJobOutputs,
}

/// Queued and not started.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub job_id: PublicJobId,
    pub run_id: Option<RunId>,
    pub conversation_id: ConversationId,
    pub report_id: Option<ReportId>,
    pub as_of: Option<Timestamp>,
    pub inputs: Option<JobInputs>,
    pub pinned: bool,
    pub label: Option<Label>,
}

/// Started. `as_of` is its started_at; `attempt` is the current attempt.
#[derive(Clone, Debug, PartialEq)]
pub struct Running {
    pub job_id: PublicJobId,
    pub run_id: Option<RunId>,
    pub conversation_id: ConversationId,
    pub report_id: Option<ReportId>,
    pub as_of: Timestamp,
    pub inputs: Option<JobInputs>,
    pub attempt: AttemptNumber,
    pub pinned: bool,
    pub label: Option<Label>,
}

/// Terminal. `as_of` is its started_at; `attempt` is the attempt that ended
/// the run. A rerun is a new root.
#[derive(Clone, Debug, PartialEq)]
pub struct Failed {
    pub job_id: PublicJobId,
    pub run_id: Option<RunId>,
    pub conversation_id: ConversationId,
    pub report_id: Option<ReportId>,
    pub as_of: Timestamp,
    pub inputs: Option<JobInputs>,
    pub attempt: AttemptNumber,
    pub failure: Failure,
    pub pinned: bool,
    pub label: Option<Label>,
}

/// No root exists for the scope (never run): every id is null.
#[derive(Clone, Debug, PartialEq)]
pub struct Empty {
    pub conversation_id: ConversationId,
    pub report_id: Option<ReportId>,
}

/// `pinned` of an empty scope: always `false`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct False;
impl Serialize for False {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}
impl<'de> Deserialize<'de> for False {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Err(serde::de::Error::custom("an empty scope is never pinned"))
        } else {
            Ok(False)
        }
    }
}

type ReadyIn = Envelope<
    ReadyStatus,
    PublicJobId,
    Option<RunId>,
    Option<ReportId>,
    Timestamp,
    JobInputs,
    Null,
    Null,
    bool,
    Option<Label>,
    DelphiJobOutputs,
    Vec<DelphiFamily>,
>;
type PendingIn = Envelope<
    PendingStatus,
    PublicJobId,
    Option<RunId>,
    Option<ReportId>,
    Option<Timestamp>,
    Option<JobInputs>,
    Null,
    Null,
    bool,
    Option<Label>,
    NoOutputs,
    AllOmitted,
>;
type RunningIn = Envelope<
    RunningStatus,
    PublicJobId,
    Option<RunId>,
    Option<ReportId>,
    Timestamp,
    Option<JobInputs>,
    AttemptNumber,
    Null,
    bool,
    Option<Label>,
    NoOutputs,
    AllOmitted,
>;
type FailedIn = Envelope<
    FailedStatus,
    PublicJobId,
    Option<RunId>,
    Option<ReportId>,
    Timestamp,
    Option<JobInputs>,
    AttemptNumber,
    Failure,
    bool,
    Option<Label>,
    NoOutputs,
    AllOmitted,
>;
type EmptyIn = Envelope<
    EmptyStatus,
    Null,
    Null,
    Option<ReportId>,
    Null,
    Null,
    Null,
    Null,
    False,
    Null,
    NoOutputs,
    AllOmitted,
>;

impl Serialize for Ready {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Envelope {
            contract_version: ContractVersion,
            job_id: &self.job_id,
            run_id: &self.run_id,
            conversation_id: self.conversation_id.clone(),
            report_id: &self.report_id,
            status: ReadyStatus,
            as_of: &self.as_of,
            inputs: &self.inputs,
            attempt: Null,
            failure: Null,
            pinned: self.pinned,
            label: &self.label,
            outputs: &self.outputs,
            omitted: self.outputs.omitted(),
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Ready {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let e = ReadyIn::deserialize(deserializer)?;
        let mut omitted = e.omitted;
        omitted.sort();
        if omitted != e.outputs.omitted() {
            return Err(serde::de::Error::custom(
                "omitted lists exactly the families outputs does not carry, each once",
            ));
        }
        Ok(Ready {
            job_id: e.job_id,
            run_id: e.run_id,
            conversation_id: e.conversation_id,
            report_id: e.report_id,
            as_of: e.as_of,
            inputs: e.inputs,
            pinned: e.pinned,
            label: e.label,
            outputs: e.outputs,
        })
    }
}

impl Serialize for Pending {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Envelope {
            contract_version: ContractVersion,
            job_id: &self.job_id,
            run_id: &self.run_id,
            conversation_id: self.conversation_id.clone(),
            report_id: &self.report_id,
            status: PendingStatus,
            as_of: &self.as_of,
            inputs: &self.inputs,
            attempt: Null,
            failure: Null,
            pinned: self.pinned,
            label: &self.label,
            outputs: NoOutputs {},
            omitted: AllOmitted,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Pending {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let e = PendingIn::deserialize(deserializer)?;
        Ok(Pending {
            job_id: e.job_id,
            run_id: e.run_id,
            conversation_id: e.conversation_id,
            report_id: e.report_id,
            as_of: e.as_of,
            inputs: e.inputs,
            pinned: e.pinned,
            label: e.label,
        })
    }
}

impl Serialize for Running {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Envelope {
            contract_version: ContractVersion,
            job_id: &self.job_id,
            run_id: &self.run_id,
            conversation_id: self.conversation_id.clone(),
            report_id: &self.report_id,
            status: RunningStatus,
            as_of: &self.as_of,
            inputs: &self.inputs,
            attempt: self.attempt,
            failure: Null,
            pinned: self.pinned,
            label: &self.label,
            outputs: NoOutputs {},
            omitted: AllOmitted,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Running {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let e = RunningIn::deserialize(deserializer)?;
        Ok(Running {
            job_id: e.job_id,
            run_id: e.run_id,
            conversation_id: e.conversation_id,
            report_id: e.report_id,
            as_of: e.as_of,
            inputs: e.inputs,
            attempt: e.attempt,
            pinned: e.pinned,
            label: e.label,
        })
    }
}

impl Serialize for Failed {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Envelope {
            contract_version: ContractVersion,
            job_id: &self.job_id,
            run_id: &self.run_id,
            conversation_id: self.conversation_id.clone(),
            report_id: &self.report_id,
            status: FailedStatus,
            as_of: &self.as_of,
            inputs: &self.inputs,
            attempt: self.attempt,
            failure: &self.failure,
            pinned: self.pinned,
            label: &self.label,
            outputs: NoOutputs {},
            omitted: AllOmitted,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Failed {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let e = FailedIn::deserialize(deserializer)?;
        Ok(Failed {
            job_id: e.job_id,
            run_id: e.run_id,
            conversation_id: e.conversation_id,
            report_id: e.report_id,
            as_of: e.as_of,
            inputs: e.inputs,
            attempt: e.attempt,
            failure: e.failure,
            pinned: e.pinned,
            label: e.label,
        })
    }
}

impl Serialize for Empty {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Envelope {
            contract_version: ContractVersion,
            job_id: Null,
            run_id: Null,
            conversation_id: self.conversation_id.clone(),
            report_id: &self.report_id,
            status: EmptyStatus,
            as_of: Null,
            inputs: Null,
            attempt: Null,
            failure: Null,
            pinned: False,
            label: Null,
            outputs: NoOutputs {},
            omitted: AllOmitted,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Empty {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let e = EmptyIn::deserialize(deserializer)?;
        Ok(Empty {
            conversation_id: e.conversation_id,
            report_id: e.report_id,
        })
    }
}

/// One Delphi job's outputs as one versioned envelope, discriminated by status.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DelphiJobResult {
    Ready(Box<Ready>),
    Pending(Pending),
    Running(Running),
    Failed(Failed),
    Empty(Empty),
}

impl DelphiJobResult {
    pub const fn status(&self) -> &'static str {
        match self {
            Self::Ready(_) => ReadyStatus::VALUE,
            Self::Pending(_) => PendingStatus::VALUE,
            Self::Running(_) => RunningStatus::VALUE,
            Self::Failed(_) => FailedStatus::VALUE,
            Self::Empty(_) => EmptyStatus::VALUE,
        }
    }
    /// Decodes bytes, reading `status` first so a refusal names the field
    /// that broke the state's rule (the untagged `Deserialize` cannot).
    pub fn from_json(text: &str) -> serde_json::Result<Self> {
        #[derive(Deserialize)]
        struct Peek {
            status: String,
        }
        let peek: Peek = serde_json::from_str(text)?;
        match peek.status.as_str() {
            ReadyStatus::VALUE => serde_json::from_str(text).map(|r| Self::Ready(Box::new(r))),
            PendingStatus::VALUE => serde_json::from_str(text).map(Self::Pending),
            RunningStatus::VALUE => serde_json::from_str(text).map(Self::Running),
            FailedStatus::VALUE => serde_json::from_str(text).map(Self::Failed),
            EmptyStatus::VALUE => serde_json::from_str(text).map(Self::Empty),
            other => Err(serde::de::Error::custom(format!(
                "status {other:?} is not a delphi-job-result/1 state"
            ))),
        }
    }
}

// --- schema -----------------------------------------------------------------------

/// The Node generator's `$comment`, kept so the documents are byte-equal.
const SOURCE_NOTE: &str = "Generated by `npm run contract:generate` in server/ from server/src/contracts/*.ts. Do not edit; edit the TypeBox source and regenerate.";
const ISO_8601: &str = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$";

fn timestamp() -> Schema {
    string().pattern(ISO_8601)
}
fn id() -> Schema {
    string().min_length(1)
}
fn id_described(description: &'static str) -> Schema {
    id().description(description)
}
fn tid() -> Schema {
    integer().minimum(0)
}
fn count() -> Schema {
    integer().minimum(0)
}

fn delphi_family() -> Schema {
    union(
        DelphiFamily::ALL
            .iter()
            .map(|f| literal(f.as_str()))
            .collect(),
    )
    .title("DelphiFamily")
}

fn topic() -> Schema {
    object(vec![
        prop("topic_key", id_described("`<job_id>#<layer>#<cluster>`.")),
        prop("layer_id", integer().minimum(0)),
        prop("cluster_id", integer()),
        prop("topic_name", string()),
        prop("model_name", string()),
        prop("comment_count", count()),
        prop("member_tids", array(tid())),
    ])
    .strict()
    .title("Topic")
}

fn umap() -> Schema {
    let node = object(vec![
        prop("tid", tid()),
        prop("x", number()),
        prop("y", number()),
        prop(
            "layer_cluster",
            record(integer()).description("Layer id -> cluster id (-1 is unassigned)."),
        ),
        optional("weight", number()),
    ])
    .strict()
    .title("UmapNode")
    .description("A comment position. Participant-safe: never carries comment text.");
    let edge = object(vec![
        prop("source", tid()),
        prop("target", tid()),
        prop("weight", number()),
        optional("distance", number()),
        optional("is_nearest_neighbor", boolean()),
    ])
    .strict()
    .title("UmapEdge");
    object(vec![
        prop("nodes", array(node)),
        optional("edges", array(edge)),
    ])
    .strict()
    .title("Umap")
}

fn visualization() -> Schema {
    object(vec![
        prop(
            "type",
            string().description("For example `interactive` or `static_png`."),
        ),
        prop("layer_id", integer().minimum(0)),
        prop("url", string()),
        prop("key", string()),
    ])
    .strict()
    .title("Visualization")
}

fn narrative_document() -> Schema {
    let clause = object(vec![
        prop("text", string()),
        prop("citations", array(tid())),
    ])
    .title("NarrativeClause");
    let sentence = object(vec![prop("clauses", array(clause))]).title("NarrativeSentence");
    let paragraph = object(vec![
        optional("id", string()),
        optional("title", string()),
        prop("sentences", array(sentence)),
    ])
    .title("NarrativeParagraph");
    object(vec![
        optional("id", string()),
        optional("title", string()),
        prop("paragraphs", array(paragraph)),
    ])
    .title("NarrativeDocument")
}

fn narrative_common() -> Vec<Prop> {
    vec![
        prop("model", string()),
        prop("created_at", timestamp()),
        prop(
            "source_topic_job_id",
            nullable(id_described(
                "The topic root this narrative was built over.",
            )),
        ),
        prop(
            "raw_len",
            integer()
                .minimum(0)
                .description("Length of the stored model output. The raw text is never served."),
        ),
    ]
}

fn narratives() -> Schema {
    let mut valid = narrative_common();
    valid.extend([
        prop("validity", literal("valid")),
        prop("invalid_reason", null()),
        prop("parsed", narrative_document()),
    ]);
    let reason = union(
        NarrativeInvalidReason::ALL
            .iter()
            .map(|r| literal(reason_name(*r)))
            .collect(),
    )
    .title("NarrativeInvalidReason");
    let mut invalid = narrative_common();
    invalid.extend([
        prop("validity", literal("invalid")),
        prop("invalid_reason", reason),
        prop("parsed", null()),
    ]);
    let section = union(vec![
        object(valid).strict().title("NarrativeSectionValid"),
        object(invalid)
            .strict()
            .title("NarrativeSectionInvalid")
            .description(
                "A section whose stored output failed parsing or validation. Listed, never dropped and never repaired.",
            ),
    ])
    .title("NarrativeSection");
    record(section)
        .title("Narratives")
        .description("Keyed by section.")
}

const fn reason_name(r: NarrativeInvalidReason) -> &'static str {
    match r {
        NarrativeInvalidReason::TruncatedJson => "truncated_json",
        NarrativeInvalidReason::UnparseableJson => "unparseable_json",
        NarrativeInvalidReason::SchemaMismatch => "schema_mismatch",
    }
}

const fn failure_name(c: FailureCode) -> &'static str {
    match c {
        FailureCode::StageFailed => "stage_failed",
        FailureCode::ManifestInvalid => "manifest_invalid",
        FailureCode::Timeout => "timeout",
        FailureCode::LeaseExpired => "lease_expired",
        FailureCode::UnknownStage => "unknown_stage",
        FailureCode::ProviderFailed => "provider_failed",
        FailureCode::Cancelled => "cancelled",
    }
}
impl FailureCode {
    pub const fn as_str(self) -> &'static str {
        failure_name(self)
    }
}
impl NarrativeInvalidReason {
    pub const fn as_str(self) -> &'static str {
        reason_name(self)
    }
}

fn collective_statement() -> Schema {
    object(vec![
        prop("statement_id", id()),
        prop("topic_key", id()),
        prop("topic_name", string()),
        prop("created_at", timestamp()),
        prop("model", string()),
        prop(
            "inputs",
            object(vec![
                prop("topic_job_id", id()),
                prop("assignments_job_id", nullable(id())),
                prop("math_tick", nullable(integer().minimum(0))),
            ])
            .strict()
            .title("CollectiveStatementInputs")
            .description(
                "What the statement was computed against; null where a legacy statement did not record it.",
            ),
        ),
        prop("statement", narrative_document()),
    ])
    .strict()
    .title("CollectiveStatement")
    .description("A stored statement. Reads list stored statements and never generate one.")
}

fn topic_stats() -> Schema {
    let entry = object(vec![
        prop("comment_tids", array(tid())),
        prop("agree", count()),
        prop("disagree", count()),
        prop("pass", count()),
        prop(
            "seen",
            integer()
                .minimum(0)
                .description("agree + disagree + pass, summed over the topic's comments."),
        ),
        prop("group_aware_consensus", nullable(number())),
        prop("normalized_consensus", nullable(number())),
    ])
    .strict()
    .title("TopicStatsEntry")
    .description(
        "Computed server-side from the captured math snapshot; vote counts are over every voter, not only clustered participants.",
    );
    record(entry)
        .title("TopicStats")
        .description("Keyed by topic_key.")
}

fn consensus_inputs() -> Schema {
    let counts = object(vec![
        prop("A", number().description("Agree votes.")),
        prop("D", number().description("Disagree votes.")),
        prop(
            "S",
            number().description(
                "Seen: every vote cast on the comment by the group, agree, disagree and pass.",
            ),
        ),
    ])
    .title("Pca2VoteCounts");
    let group_votes = record(
        object(vec![
            prop("votes", record(counts).description("Keyed by tid.")),
            optional("n-members", number()),
        ])
        .title("Pca2GroupVoteEntry"),
    )
    .title("Pca2GroupVotes")
    .description("Keyed by group id.");
    let repness = record(array(
        object(vec![
            prop("tid", number()),
            optional("repful-for", string()),
            optional("p-success", number()),
        ])
        .title("Pca2RepnessEntry"),
    ))
    .title("Pca2Repness")
    .description("Representative comments, keyed by group id.");
    let comment_votes = object(vec![
        prop("agree_count", count()),
        prop("disagree_count", count()),
        prop("pass_count", count()),
    ])
    .strict()
    .title("CommentVotes")
    .description(
        "One comment's vote counts over every voter (the /comments agree_count, disagree_count, pass_count).",
    );
    object(vec![
        prop("group_votes", group_votes),
        prop("repness", repness),
        prop(
            "group_aware_consensus",
            record(number())
                .description("Keyed by tid: pca2 group-aware-consensus at the captured tick."),
        ),
        prop(
            "group_consensus_normalized",
            record(number()).description(
                "Keyed by tid: group-aware consensus normalized server-side (the client's group-consensus-normalized).",
            ),
        ),
        prop(
            "comment_votes",
            record(comment_votes).description("Keyed by tid."),
        ),
    ])
    .strict()
    .title("ConsensusInputs")
    .description(
        "The per-comment math the topic pages read, from the captured snapshot (inputs.math_tick), so a page never mixes live pca2 or live comment counts with an older topic set. On a zero-vote root every map is present and empty.",
    )
}

fn outputs() -> Schema {
    object(vec![
        optional(
            "topics_by_layer",
            record(array(topic()))
                .title("TopicsByLayer")
                .description("Keyed by layer id."),
        ),
        optional(
            "assignments",
            record(record(integer())).title("Assignments").description(
                "tid -> layer id -> cluster id (-1 is unassigned). Topic membership is carried by Topic.member_tids and topic_stats[*].comment_tids.",
            ),
        ),
        optional(
            "keywords",
            record(array(string()))
                .title("Keywords")
                .description("Keyed by topic_key."),
        ),
        optional("umap", umap()),
        optional("visualizations", array(visualization())),
        optional("narratives", narratives()),
        optional("collective_statements", array(collective_statement())),
        optional("topic_stats", topic_stats()),
        optional("consensus_inputs", consensus_inputs()),
    ])
    .strict()
    .title("DelphiJobOutputs")
    .description("Every family present here is absent from `omitted`, and the reverse.")
}

fn no_outputs() -> Schema {
    object(vec![]).strict().title("DelphiJobNoOutputs")
}

fn job_inputs() -> Schema {
    object(vec![
        prop("math_tick", nullable(integer().minimum(0))),
        prop("math_env", nullable(string())),
        prop("vote_count", nullable(count())),
        prop("comment_count", nullable(count())),
        prop(
            "model",
            object(vec![
                prop("topic_names", string()),
                prop("narrative", nullable(string())),
                prop("statement", nullable(string())),
                prop("embedding", nullable(string())),
            ])
            .strict()
            .title("JobModels"),
        ),
        prop(
            "prompt_version",
            object(vec![
                prop("topic_names", nullable(string())),
                prop("narrative", nullable(string())),
                prop("statement", nullable(string())),
            ])
            .strict()
            .title("JobPromptVersions"),
        ),
    ])
    .strict()
    .title("JobInputs")
    .description(
        "The math snapshot the root captured at start, and the models and prompt versions it ran with. Null leaves mean the root did not record it (legacy imports).",
    )
}

fn failure() -> Schema {
    object(vec![
        prop(
            "code",
            union(
                FailureCode::ALL
                    .iter()
                    .map(|c| literal(c.as_str()))
                    .collect(),
            )
            .title("FailureCode"),
        ),
        prop("stage", nullable(string().min_length(1))),
        prop("attempt", integer().minimum(1)),
        prop("at", timestamp()),
    ])
    .strict()
    .title("Failure")
    .description("Never carries log text, an exception message or a stack trace.")
}

fn all_families_omitted() -> Schema {
    array(delphi_family())
        .min_items(DelphiFamily::ALL.len() as u64)
        .max_items(DelphiFamily::ALL.len() as u64)
        .unique()
        .description("Every family: this state carries no outputs.")
}

struct StateFields {
    job_id: Schema,
    run_id: Schema,
    as_of: Schema,
    inputs: Schema,
    attempt: Schema,
    failure: Schema,
    pinned: Schema,
    label: Schema,
    outputs: Schema,
    omitted: Schema,
}

fn envelope(
    status: &'static str,
    title: &'static str,
    description: &'static str,
    f: StateFields,
) -> Schema {
    object(vec![
        prop("contract_version", literal(CONTRACT_VERSION)),
        prop("job_id", f.job_id),
        prop("run_id", f.run_id),
        prop(
            "conversation_id",
            id_described("The conversation's zinvite, never zid."),
        ),
        prop("report_id", nullable(id())),
        prop("status", literal(status)),
        prop("as_of", f.as_of),
        prop("inputs", f.inputs),
        prop("attempt", f.attempt),
        prop("failure", f.failure),
        prop("pinned", f.pinned),
        prop("label", f.label),
        prop("outputs", f.outputs),
        prop("omitted", f.omitted),
    ])
    .strict()
    .title(title)
    .description(description)
}

fn job_id_schema() -> Schema {
    id_described("Public job id: a uuid, or the frozen alias of a legacy import.")
}
fn run_id_schema() -> Schema {
    nullable(id_described("Queue execution identity; null for imports."))
}

/// The `delphi-job-result/1` JSON Schema document.
pub fn schema_document() -> Schema {
    let ready = envelope(
        "ready",
        "DelphiJobResultReady",
        "A completed root. as_of is its completed_at.",
        StateFields {
            job_id: job_id_schema(),
            run_id: run_id_schema(),
            as_of: timestamp(),
            inputs: job_inputs(),
            attempt: null(),
            failure: null(),
            pinned: boolean(),
            label: nullable(string()),
            outputs: outputs(),
            omitted: array(delphi_family()).unique(),
        },
    );
    let pending = envelope(
        "pending",
        "DelphiJobResultPending",
        "Queued and not started.",
        StateFields {
            job_id: job_id_schema(),
            run_id: run_id_schema(),
            as_of: nullable(timestamp()),
            inputs: nullable(job_inputs()),
            attempt: null(),
            failure: null(),
            pinned: boolean(),
            label: nullable(string()),
            outputs: no_outputs(),
            omitted: all_families_omitted(),
        },
    );
    let running = envelope(
        "running",
        "DelphiJobResultRunning",
        "Started. as_of is its started_at; attempt is the current attempt.",
        StateFields {
            job_id: job_id_schema(),
            run_id: run_id_schema(),
            as_of: timestamp(),
            inputs: nullable(job_inputs()),
            attempt: integer().minimum(1),
            failure: null(),
            pinned: boolean(),
            label: nullable(string()),
            outputs: no_outputs(),
            omitted: all_families_omitted(),
        },
    );
    let failed = envelope(
        "failed",
        "DelphiJobResultFailed",
        "Terminal. as_of is its started_at; attempt is the attempt that ended the run. A rerun is a new root.",
        StateFields {
            job_id: job_id_schema(),
            run_id: run_id_schema(),
            as_of: timestamp(),
            inputs: nullable(job_inputs()),
            attempt: integer().minimum(1),
            failure: failure(),
            pinned: boolean(),
            label: nullable(string()),
            outputs: no_outputs(),
            omitted: all_families_omitted(),
        },
    );
    let empty = envelope(
        "empty",
        "DelphiJobResultEmpty",
        "No root exists for the scope (never run).",
        StateFields {
            job_id: null(),
            run_id: null(),
            as_of: null(),
            inputs: null(),
            attempt: null(),
            failure: null(),
            pinned: literal_bool(false),
            label: null(),
            outputs: no_outputs(),
            omitted: all_families_omitted(),
        },
    );
    union(vec![ready, pending, running, failed, empty])
        .title("DelphiJobResult")
        .description("One Delphi job's outputs as one versioned envelope, discriminated by status.")
        .document(CONTRACT_VERSION, SOURCE_NOTE)
}

/// The document as server/src/contracts/delphiJobResult.schema.json and
/// client-report/src/contract/delphiJobResult.schema.json hold it.
pub fn schema_json() -> String {
    crate::schema::render(&schema_document().to_json())
}

/// The document as client-participation-alpha/src/api/contract/delphiJobResult.schema.json
/// holds it (prettier, print width 100).
pub fn schema_json_alpha() -> Option<String> {
    crate::schema::render_prettier(&schema_document().to_json(), 100)
}

/// The JSON value of the schema document, for validators.
pub fn schema_value() -> Json {
    schema_document().to_json()
}
