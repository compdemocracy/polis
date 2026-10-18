//! `delphi-run/1`: one Delphi job's run record, as the executor knows it.
//!
//! Identity (`job_id`, `run_id`, `root_job_id`, `parent_job_id`, `graph_id`),
//! the job's stage, state and attempt, the other nodes of its graph, the
//! math snapshot it was admitted against, the inputs it read and their
//! digest, each result family it touches (its own state, producing run,
//! upstream runs and publication), cost and timestamps. The closed sets are
//! the executor's own: [`StageState`] is `polis_queue_jobs.state`,
//! [`AttemptOutcome`] is `polis_queue_attempts.outcome`, [`Stage`] is
//! `polis_queue_jobs.stage` without the test-only `noop`, [`JobKind`] is
//! `delphi_jobs.kind`; [`RunFamily`] and [`LegacyFamily`] together name
//! `delphi_result_catalog.family`.
//!
//! A [`DelphiRun`] can only be built through [`DelphiRun::new`] (or decoded),
//! which refuses the combinations the database or the contract rules out;
//! the README section of the same name lists them. No route serves it yet.
use crate::delphi_job_result::{
    AttemptNumber, ConversationId, Failure, FailureCode, JobPromptVersions, Label, MathEnv,
    MathTick, ModelName, ReportId, Timestamp,
};
use crate::wire::{self, literal, present, required, text, Invalid, JsMap, Json};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256 as Sha256Hasher};
use std::collections::{BTreeMap, HashSet};
use std::num::NonZeroU64;

/// The contract's serialized name and version.
pub const CONTRACT_VERSION: &str = "delphi-run/1";

literal!(
    /// `contract_version`: always `delphi-run/1`.
    ContractVersion,
    "delphi-run/1"
);

text!(
    /// `delphi_jobs.job_id`.
    JobId,
    wire::uuid
);
text!(
    /// `polis_queue_runs.run_id`: the queue execution identity.
    RunId,
    wire::uuid
);
text!(
    /// `delphi_graphs.graph_id`.
    GraphId,
    wire::uuid
);
text!(
    /// `polis_queue_attempts.attempt_id`; also the id of the result batch the
    /// attempt seals (`delphi_result_batches.batch_id`).
    AttemptId,
    wire::uuid
);
text!(
    /// `delphi_provider_requests.request_id`.
    RequestId,
    wire::uuid
);
text!(
    /// A sha256 digest: 64 lowercase hex digits.
    Sha256,
    wire::sha256_hex
);
text!(
    /// The publication scope (`delphi_graph_served.scope_key`), 1 to 128 characters.
    ScopeKey,
    scope_key
);
text!(
    /// `delphi_jobs.code_version`: the code pin the job was admitted with.
    CodeVersion,
    wire::non_empty
);
text!(
    /// `delphi_provider_requests.provider`, e.g. `anthropic`.
    ProviderName,
    wire::non_empty
);
text!(
    /// The provider's own batch id.
    ProviderBatchId,
    wire::non_empty
);

fn scope_key(name: &str, value: &str) -> Result<(), Invalid> {
    let n = value.chars().count();
    if (1..=128).contains(&n) {
        Ok(())
    } else {
        wire::invalid(format!("{name} has 1 to 128 characters"))
    }
}

/// A lease epoch (`polis_queue_attempts.lease_epoch`, at least 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LeaseEpoch(NonZeroU64);
impl LeaseEpoch {
    pub fn new(n: u64) -> Result<Self, Invalid> {
        NonZeroU64::new(n)
            .map(Self)
            .ok_or_else(|| Invalid("a lease epoch is at least 1".into()))
    }
    pub fn get(self) -> u64 {
        self.0.get()
    }
}

/// A publication generation (`delphi_graph_served.generation`, at least 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Generation(NonZeroU64);
impl Generation {
    pub fn new(n: u64) -> Result<Self, Invalid> {
        NonZeroU64::new(n)
            .map(Self)
            .ok_or_else(|| Invalid("a generation is at least 1".into()))
    }
    pub fn get(self) -> u64 {
        self.0.get()
    }
}

/// `polis_queue_jobs.max_attempts`: 1 to 100.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct MaxAttempts(u8);
impl MaxAttempts {
    pub fn new(n: u8) -> Result<Self, Invalid> {
        if (1..=100).contains(&n) {
            Ok(Self(n))
        } else {
            wire::invalid("max_attempts is 1 to 100")
        }
    }
    pub fn get(self) -> u8 {
        self.0
    }
}
impl<'de> Deserialize<'de> for MaxAttempts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(u8::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// The newest vote's `created` (milliseconds) when the run read its inputs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VoteHighWaterMark(pub u64);

/// Declares a closed string enum with its exact wire spellings and `ALL`.
macro_rules! closed {
    ($(#[$doc:meta])* $name:ident { $($variant:ident = $wire:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant),+
        }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }
        }
    };
}

closed!(
    /// `delphi_jobs.origin`.
    Origin {
        Queued = "queued",
        LegacyImport = "legacy_import",
    }
);

closed!(
    /// `delphi_jobs.kind` (000029).
    JobKind {
        FullPipeline = "full_pipeline",
        Embed = "embed",
        Snapshot = "snapshot",
        Umap = "umap",
        Cluster = "cluster",
        Keywords = "keywords",
        Topics = "topics",
        TopicName = "topic_name",
        Narrative = "narrative",
        CollectiveStatement = "collective_statement",
        Visualize = "visualize",
        MathRebuild = "math_rebuild",
        LegacyImport = "legacy_import",
        LegacyQueueRecord = "legacy_queue_record",
    }
);

closed!(
    /// `polis_queue_jobs.stage` (000029), without the test-only `noop`.
    Stage {
        DelphiFullPipeline = "delphi_full_pipeline",
        DelphiNarrative = "delphi_narrative",
        MathRebuild = "math_rebuild",
        GraphEmbed = "graph_embed",
        GraphCluster = "graph_cluster",
        GraphTopics = "graph_topics",
        GraphNarrative = "graph_narrative",
    }
);

closed!(
    /// A job's state: `polis_queue_jobs.state`, mirrored in `delphi_jobs.status`.
    StageState {
        Queued = "queued",
        Running = "running",
        RetryWait = "retry_wait",
        Parked = "parked",
        Succeeded = "succeeded",
        Dead = "dead",
        Cancelled = "cancelled",
    }
);

closed!(
    /// How an attempt ended: `polis_queue_attempts.outcome`.
    AttemptOutcome {
        Running = "running",
        Succeeded = "succeeded",
        RetryWait = "retry_wait",
        Parked = "parked",
        Dead = "dead",
        Cancelled = "cancelled",
        Expired = "expired",
    }
);

closed!(
    /// `delphi_provider_requests.state`.
    ProviderRequestState {
        Intent = "intent",
        SubmissionUnknown = "submission_unknown",
        Submitted = "submitted",
        Completed = "completed",
        Failed = "failed",
    }
);

closed!(
    /// A family a Delphi run produces: the EVoC and UMAP output, keywords
    /// and features, topic names, topic stats, narratives, collective
    /// statements and visualizations, after the embeddings they start from.
    /// Stored families keep their `delphi_result_catalog` names (the
    /// DynamoDB table names); `topic_stats` and `visualizations` (the
    /// datamapplot pages, S3 `visualizations/{report_id}/{job_id}/`) have no
    /// catalog row yet.
    RunFamily {
        CommentEmbeddings = "Delphi_CommentEmbeddings",
        CommentHierarchicalClusterAssignments = "Delphi_CommentHierarchicalClusterAssignments",
        UmapGraph = "Delphi_UMAPGraph",
        UmapConversationConfig = "Delphi_UMAPConversationConfig",
        CommentClustersStructureKeywords = "Delphi_CommentClustersStructureKeywords",
        CommentClustersFeatures = "Delphi_CommentClustersFeatures",
        CommentClustersLlmTopicNames = "Delphi_CommentClustersLLMTopicNames",
        TopicStats = "topic_stats",
        NarrativeReports = "Delphi_NarrativeReports",
        CollectiveStatement = "Delphi_CollectiveStatement",
        Visualizations = "visualizations",
    }
);

closed!(
    /// A catalog family no Delphi run produces: Delphi's own math stage (its
    /// PCA, k-means, representative comments, participant projections and
    /// comment routing, whose priorities its stage 4 wrote), retired for the
    /// math engine's `math_main`; extremity; the topic agenda picks; the
    /// server's report-narrative cache. A record lists one only as published
    /// (the DynamoDB import carries them), never as computed by a run.
    LegacyFamily {
        PcaConversationConfig = "Delphi_PCAConversationConfig",
        PcaResults = "Delphi_PCAResults",
        KMeansClusters = "Delphi_KMeansClusters",
        CommentRouting = "Delphi_CommentRouting",
        RepresentativeComments = "Delphi_RepresentativeComments",
        PcaParticipantProjections = "Delphi_PCAParticipantProjections",
        CommentExtremity = "Delphi_CommentExtremity",
        TopicAgendaSelections = "Delphi_TopicAgendaSelections",
        ReportNarrativeStore = "report_narrative_store",
    }
);

/// A result family, by its wire name: one a run produces, or a legacy one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ResultFamily {
    Run(RunFamily),
    Legacy(LegacyFamily),
}

impl ResultFamily {
    pub fn all() -> impl Iterator<Item = ResultFamily> {
        RunFamily::ALL
            .iter()
            .map(|f| Self::Run(*f))
            .chain(LegacyFamily::ALL.iter().map(|f| Self::Legacy(*f)))
    }
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Run(f) => f.as_str(),
            Self::Legacy(f) => f.as_str(),
        }
    }
    pub fn parse(name: &str) -> Option<Self> {
        Self::all().find(|f| f.as_str() == name)
    }
    /// Whether `delphi_result_catalog` holds the family.
    pub const fn in_catalog(self) -> bool {
        !matches!(
            self,
            Self::Run(RunFamily::TopicStats | RunFamily::Visualizations)
        )
    }
    /// The families this family is computed from ([`RunFamily::upstream`]);
    /// none for a legacy family.
    pub const fn upstream(self) -> &'static [RunFamily] {
        match self {
            Self::Run(f) => f.upstream(),
            Self::Legacy(_) => &[],
        }
    }
}
impl From<RunFamily> for ResultFamily {
    fn from(f: RunFamily) -> Self {
        Self::Run(f)
    }
}
impl From<LegacyFamily> for ResultFamily {
    fn from(f: LegacyFamily) -> Self {
        Self::Legacy(f)
    }
}
impl Serialize for ResultFamily {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for ResultFamily {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let name = String::deserialize(deserializer)?;
        Self::parse(&name)
            .ok_or_else(|| serde::de::Error::custom(format!("{name:?} is not a result family")))
    }
}

impl RunFamily {
    /// The families this family is computed from. When the publication of
    /// one of these changes, this family is recomputed; a run record names,
    /// for each, the run it was computed from. The math snapshot every run
    /// is admitted against is the record's `math_snapshot`, not a family.
    pub const fn upstream(self) -> &'static [RunFamily] {
        use RunFamily as F;
        match self {
            // UMAP and EVoC run on the embeddings.
            F::UmapGraph | F::UmapConversationConfig | F::CommentHierarchicalClusterAssignments => {
                &[F::CommentEmbeddings]
            }
            // Keywords and TF-IDF features are per cluster.
            F::CommentClustersStructureKeywords | F::CommentClustersFeatures => {
                &[F::CommentHierarchicalClusterAssignments]
            }
            // Topics name the clusters, from the comments nearest each
            // centroid in the UMAP map.
            F::CommentClustersLlmTopicNames => {
                &[F::CommentHierarchicalClusterAssignments, F::UmapGraph]
            }
            // Topic stats count the votes on each topic's comments.
            F::TopicStats => &[
                F::CommentClustersLlmTopicNames,
                F::CommentHierarchicalClusterAssignments,
            ],
            // Narratives and statements are written over the topics run
            // that named the topics.
            F::NarrativeReports | F::CollectiveStatement => &[F::CommentClustersLlmTopicNames],
            // The datamapplot draws the UMAP run's map.
            F::Visualizations => &[F::UmapGraph],
            F::CommentEmbeddings => &[],
        }
    }
}

impl Stage {
    /// A node of a sealed job graph (`pd_graph_admit`), as opposed to a
    /// writer run (`pd_writer_admit`) or a math rebuild.
    pub const fn is_graph(self) -> bool {
        matches!(
            self,
            Self::GraphEmbed | Self::GraphCluster | Self::GraphTopics | Self::GraphNarrative
        )
    }
    /// The `delphi_jobs.kind` a queued job of this stage is admitted with:
    /// `pd_enqueue` (000024:253) for writer runs and rebuilds, the stage name
    /// without `graph_` for graph nodes (000027:279, 000029:66).
    pub const fn kind(self) -> JobKind {
        match self {
            Self::DelphiFullPipeline => JobKind::FullPipeline,
            Self::DelphiNarrative | Self::GraphNarrative => JobKind::Narrative,
            Self::MathRebuild => JobKind::MathRebuild,
            Self::GraphEmbed => JobKind::Embed,
            Self::GraphCluster => JobKind::Cluster,
            Self::GraphTopics => JobKind::Topics,
        }
    }
}

impl StageState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Dead | Self::Cancelled)
    }
}

/// One lease of a job (`polis_queue_attempts` plus the job's `max_attempts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub attempt_id: AttemptId,
    /// The attempt's number: the first is 1.
    pub number: AttemptNumber,
    pub lease_epoch: LeaseEpoch,
    pub max_attempts: MaxAttempts,
    pub outcome: AttemptOutcome,
    pub started_at: Timestamp,
    #[serde(deserialize_with = "required")]
    pub ended_at: Option<Timestamp>,
    /// When the executor proved the child's process group had exited.
    #[serde(deserialize_with = "required")]
    pub process_exit_confirmed_at: Option<Timestamp>,
}

/// Another node of the job's sealed graph (listed on the root's record).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphNode {
    pub job_id: JobId,
    pub run_id: RunId,
    pub stage: Stage,
    pub state: StageState,
    #[serde(deserialize_with = "required")]
    pub attempt: Option<Attempt>,
}

/// The math snapshot a run is computed against: the math engine's
/// published `math_main` row for the conversation, captured when the run is
/// admitted. `math_env`, `math_tick` and `caching_tick` are the row's own
/// names; `data_sha256` is the sha256 of the captured `data` blob
/// (`delphi_jobs.math_snapshot_key`). A tick of -1 (`math_main`'s default
/// for a row never ticked) is not a published generation and is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MathSnapshot {
    pub math_env: MathEnv,
    pub math_tick: MathTick,
    pub caching_tick: MathTick,
    #[serde(deserialize_with = "required")]
    pub data_sha256: Option<Sha256>,
}

/// What the run read before any stage ran (output-manifest/2 `inputs`).
/// `inputs_sha256` is not stored: it is the sha256 of these five values'
/// compact JSON in this order, written on encode and checked on decode.
#[derive(Clone, Debug, PartialEq)]
pub struct RunInputs {
    pub math_env: Option<MathEnv>,
    pub math_tick: Option<MathTick>,
    pub math_caching_tick: Option<MathTick>,
    pub comment_set_sha256: Option<Sha256>,
    pub vote_hwm: Option<VoteHighWaterMark>,
}

#[derive(Serialize)]
struct InputsCanonical<'a> {
    math_env: &'a Option<MathEnv>,
    math_tick: &'a Option<MathTick>,
    math_caching_tick: &'a Option<MathTick>,
    comment_set_sha256: &'a Option<Sha256>,
    vote_hwm: &'a Option<VoteHighWaterMark>,
}

impl RunInputs {
    fn canonical(&self) -> InputsCanonical<'_> {
        InputsCanonical {
            math_env: &self.math_env,
            math_tick: &self.math_tick,
            math_caching_tick: &self.math_caching_tick,
            comment_set_sha256: &self.comment_set_sha256,
            vote_hwm: &self.vote_hwm,
        }
    }
    /// sha256 over `{"math_env":…,"math_tick":…,"math_caching_tick":…,"comment_set_sha256":…,"vote_hwm":…}`.
    pub fn digest(&self) -> Sha256 {
        let bytes = wire::to_json(&self.canonical()).unwrap_or_default();
        let hex: String = Sha256Hasher::digest(bytes.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Sha256(hex)
    }
}
impl Serialize for RunInputs {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Out<'a> {
            #[serde(flatten)]
            values: InputsCanonical<'a>,
            inputs_sha256: Sha256,
        }
        Out {
            values: self.canonical(),
            inputs_sha256: self.digest(),
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for RunInputs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct In {
            #[serde(deserialize_with = "required")]
            math_env: Option<MathEnv>,
            #[serde(deserialize_with = "required")]
            math_tick: Option<MathTick>,
            #[serde(deserialize_with = "required")]
            math_caching_tick: Option<MathTick>,
            #[serde(deserialize_with = "required")]
            comment_set_sha256: Option<Sha256>,
            #[serde(deserialize_with = "required")]
            vote_hwm: Option<VoteHighWaterMark>,
            inputs_sha256: Sha256,
        }
        let w = In::deserialize(deserializer)?;
        let inputs = RunInputs {
            math_env: w.math_env,
            math_tick: w.math_tick,
            math_caching_tick: w.math_caching_tick,
            comment_set_sha256: w.comment_set_sha256,
            vote_hwm: w.vote_hwm,
        };
        if inputs.digest() != w.inputs_sha256 {
            return Err(serde::de::Error::custom(
                "inputs_sha256 is the digest of the five inputs",
            ));
        }
        Ok(inputs)
    }
}

/// The models the run used. `cluster_seed` is the clustering seed (UMAP and
/// EVoC); `null` while the clustering is unseeded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunModels {
    /// e.g. `sentence-transformers/all-MiniLM-L6-v2`.
    #[serde(deserialize_with = "required")]
    pub embedding: Option<ModelName>,
    /// e.g. `delphi-umap-evoc/1`.
    #[serde(deserialize_with = "required")]
    pub cluster: Option<ModelName>,
    #[serde(deserialize_with = "required")]
    pub cluster_seed: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub topic_names: Option<ModelName>,
    #[serde(deserialize_with = "required")]
    pub narrative: Option<ModelName>,
    #[serde(deserialize_with = "required")]
    pub statement: Option<ModelName>,
}

/// A run: the job and its queue run (`run_id` is `null` only for a legacy
/// import's job, never an invented id).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRef {
    pub job_id: JobId,
    #[serde(deserialize_with = "required")]
    pub run_id: Option<RunId>,
}

/// The run of one upstream family a family was computed from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpstreamInput {
    pub family: RunFamily,
    pub job_id: JobId,
    #[serde(deserialize_with = "required")]
    pub run_id: Option<RunId>,
}

/// The stored batch holding a family (`delphi_result_families`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyBatch {
    /// A batch id is the id of the attempt that sealed it.
    pub batch_id: AttemptId,
    pub content_sha256: Sha256,
    pub row_count: u64,
}

/// A family's own publication: the pointer generation that published it.
/// `scope` is the pointer it belongs to (`delphi_graph_served.scope_key`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyPublication {
    pub scope: ScopeKey,
    pub generation: Generation,
}

/// Why a family failed: a closed code, never log text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyFailure {
    pub reason: FailureCode,
    pub at: Timestamp,
}

/// Who computes a family, and from which upstream runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Computation {
    /// The run that produced (or is producing) the family.
    pub producer: RunRef,
    /// One entry per upstream family ([`ResultFamily::upstream`]), each the
    /// run whose output this family was computed from.
    pub upstream: Vec<UpstreamInput>,
}

/// A family's state in this run. Each family is published on its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FamilyState {
    /// The run will produce it and has not begun.
    NotStarted,
    Running(Computation),
    /// Published, and the publication is the one served now.
    Succeeded {
        computation: Computation,
        batch: FamilyBatch,
        publication: FamilyPublication,
    },
    Failed {
        computation: Computation,
        failure: FamilyFailure,
    },
    /// Published, and a later publication of the family replaced it.
    Superseded {
        computation: Computation,
        batch: FamilyBatch,
        publication: FamilyPublication,
    },
}

/// One family of the run record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyOutput {
    pub family: ResultFamily,
    pub state: FamilyState,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FamilyStateName {
    NotStarted,
    Running,
    Succeeded,
    Failed,
    Superseded,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FamilyWire {
    family: ResultFamily,
    state: FamilyStateName,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    producer: Option<RunRef>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    upstream: Option<Vec<UpstreamInput>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    batch: Option<FamilyBatch>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    publication: Option<FamilyPublication>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    failure: Option<FamilyFailure>,
}

impl FamilyState {
    pub fn computation(&self) -> Option<&Computation> {
        match self {
            Self::NotStarted => None,
            Self::Running(c)
            | Self::Succeeded { computation: c, .. }
            | Self::Failed { computation: c, .. }
            | Self::Superseded { computation: c, .. } => Some(c),
        }
    }
    pub fn batch(&self) -> Option<&FamilyBatch> {
        match self {
            Self::Succeeded { batch, .. } | Self::Superseded { batch, .. } => Some(batch),
            _ => None,
        }
    }
}

impl Serialize for FamilyOutput {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (state, computation, batch, publication, failure) = match &self.state {
            FamilyState::NotStarted => (FamilyStateName::NotStarted, None, None, None, None),
            FamilyState::Running(c) => (FamilyStateName::Running, Some(c), None, None, None),
            FamilyState::Succeeded {
                computation,
                batch,
                publication,
            } => (
                FamilyStateName::Succeeded,
                Some(computation),
                Some(batch),
                Some(publication),
                None,
            ),
            FamilyState::Failed {
                computation,
                failure,
            } => (
                FamilyStateName::Failed,
                Some(computation),
                None,
                None,
                Some(failure),
            ),
            FamilyState::Superseded {
                computation,
                batch,
                publication,
            } => (
                FamilyStateName::Superseded,
                Some(computation),
                Some(batch),
                Some(publication),
                None,
            ),
        };
        FamilyWire {
            family: self.family,
            state,
            producer: computation.map(|c| c.producer.clone()),
            upstream: computation.map(|c| c.upstream.clone()),
            batch: batch.cloned(),
            publication: publication.cloned(),
            failure: failure.cloned(),
        }
        .serialize(serializer)
    }
}

impl TryFrom<FamilyWire> for FamilyOutput {
    type Error = Invalid;
    fn try_from(w: FamilyWire) -> Result<Self, Invalid> {
        let computation = match (w.producer, w.upstream) {
            (Some(producer), Some(upstream)) => Some(Computation { producer, upstream }),
            (None, None) => None,
            _ => return wire::invalid("producer and upstream come together"),
        };
        let state = match (w.state, computation, w.batch, w.publication, w.failure) {
            (FamilyStateName::NotStarted, None, None, None, None) => FamilyState::NotStarted,
            (FamilyStateName::Running, Some(c), None, None, None) => FamilyState::Running(c),
            (
                FamilyStateName::Succeeded,
                Some(computation),
                Some(batch),
                Some(publication),
                None,
            ) => FamilyState::Succeeded {
                computation,
                batch,
                publication,
            },
            (FamilyStateName::Failed, Some(computation), None, None, Some(failure)) => {
                FamilyState::Failed {
                    computation,
                    failure,
                }
            }
            (
                FamilyStateName::Superseded,
                Some(computation),
                Some(batch),
                Some(publication),
                None,
            ) => FamilyState::Superseded {
                computation,
                batch,
                publication,
            },
            _ => {
                return wire::invalid(
                    "not_started carries nothing; running carries producer and upstream; \
                     succeeded and superseded add batch and publication; failed adds failure",
                )
            }
        };
        Ok(FamilyOutput {
            family: w.family,
            state,
        })
    }
}
impl<'de> Deserialize<'de> for FamilyOutput {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        FamilyWire::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

/// The run's families, each at most once, written in [`ResultFamily`] order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FamilyOutputs(BTreeMap<ResultFamily, FamilyOutput>);
impl FamilyOutputs {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, output: FamilyOutput) -> Result<(), Invalid> {
        if self.0.contains_key(&output.family) {
            return wire::invalid(format!("family {} listed twice", output.family.as_str()));
        }
        self.0.insert(output.family, output);
        Ok(())
    }
    pub fn get(&self, family: ResultFamily) -> Option<&FamilyOutput> {
        self.0.get(&family)
    }
    pub fn iter(&self) -> impl Iterator<Item = &FamilyOutput> {
        self.0.values()
    }
}
impl Serialize for FamilyOutputs {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.values())
    }
}
impl<'de> Deserialize<'de> for FamilyOutputs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut outputs = FamilyOutputs::new();
        for output in Vec::<FamilyOutput>::deserialize(deserializer)? {
            outputs.insert(output).map_err(serde::de::Error::custom)?;
        }
        Ok(outputs)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunOutputs {
    /// `delphi_jobs.output_manifest_digest`: the sha256 of the manifest bytes
    /// the queue finalized.
    #[serde(deserialize_with = "required")]
    pub manifest_sha256: Option<Sha256>,
    pub families: FamilyOutputs,
}

/// A paid provider call the executor recorded before submitting it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRequest {
    pub request_id: RequestId,
    pub provider: ProviderName,
    #[serde(deserialize_with = "required")]
    pub batch_id: Option<ProviderBatchId>,
    pub state: ProviderRequestState,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunCost {
    #[serde(deserialize_with = "required")]
    pub llm_tokens_in: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub llm_tokens_out: Option<u64>,
    pub provider_requests: Vec<ProviderRequest>,
}

/// Every field of a run record, in wire order. Build a [`DelphiRun`] from it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DelphiRunFields {
    pub contract_version: ContractVersion,
    pub job_id: JobId,
    /// `null` only for a legacy import, never an invented id.
    #[serde(deserialize_with = "required")]
    pub run_id: Option<RunId>,
    pub root_job_id: JobId,
    #[serde(deserialize_with = "required")]
    pub parent_job_id: Option<JobId>,
    #[serde(deserialize_with = "required")]
    pub graph_id: Option<GraphId>,
    pub conversation_id: ConversationId,
    #[serde(deserialize_with = "required")]
    pub report_id: Option<ReportId>,
    pub origin: Origin,
    pub kind: JobKind,
    #[serde(deserialize_with = "required")]
    pub stage: Option<Stage>,
    pub state: StageState,
    /// The current attempt (`running`) or the last one.
    #[serde(deserialize_with = "required")]
    pub attempt: Option<Attempt>,
    /// The graph's other nodes, on the root's record; empty otherwise.
    pub nodes: Vec<GraphNode>,
    /// The math snapshot the run was admitted against; `null` until the
    /// admission captures one.
    #[serde(deserialize_with = "required")]
    pub math_snapshot: Option<MathSnapshot>,
    /// What the run read when it started (its manifest's `inputs`).
    #[serde(deserialize_with = "required")]
    pub inputs: Option<RunInputs>,
    pub config_effective: JsMap<String, Json>,
    #[serde(deserialize_with = "required")]
    pub code_version: Option<CodeVersion>,
    pub models: RunModels,
    pub prompt_versions: JobPromptVersions,
    pub outputs: RunOutputs,
    pub cost: RunCost,
    pub pinned: bool,
    #[serde(deserialize_with = "required")]
    pub label: Option<Label>,
    pub created_at: Timestamp,
    #[serde(deserialize_with = "required")]
    pub completed_at: Option<Timestamp>,
    #[serde(deserialize_with = "required")]
    pub failure: Option<Failure>,
}

/// A run record that keeps every rule in [`DelphiRun::new`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DelphiRun(DelphiRunFields);

impl<'de> Deserialize<'de> for DelphiRun {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(DelphiRunFields::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl std::ops::Deref for DelphiRun {
    type Target = DelphiRunFields;
    fn deref(&self) -> &DelphiRunFields {
        &self.0
    }
}

fn check(ok: bool, rule: &str) -> Result<(), Invalid> {
    if ok {
        Ok(())
    } else {
        wire::invalid(rule)
    }
}

/// The attempt agrees with the state that owns it.
fn check_attempt(
    state: StageState,
    attempt: Option<&Attempt>,
    queued: bool,
) -> Result<(), Invalid> {
    let outcome = attempt.map(|a| a.outcome);
    check(
        (state == StageState::Running) == (outcome == Some(AttemptOutcome::Running)),
        "a running job has a running attempt, and only a running job does",
    )?;
    check(
        !queued || state != StageState::Succeeded || outcome == Some(AttemptOutcome::Succeeded),
        "a succeeded job's attempt succeeded",
    )?;
    check(
        attempt.is_none_or(|a| a.outcome != AttemptOutcome::Running || a.ended_at.is_none()),
        "a running attempt has not ended",
    )
}

/// Each family's computation names the runs it came from, consistently.
fn check_families(f: &DelphiRunFields) -> Result<(), Invalid> {
    // The jobs of this record: the job itself and, on a root, its nodes.
    let own: Vec<(&JobId, Option<&RunId>, StageState, Option<&Attempt>)> =
        std::iter::once((&f.job_id, f.run_id.as_ref(), f.state, f.attempt.as_ref()))
            .chain(
                f.nodes
                    .iter()
                    .map(|n| (&n.job_id, Some(&n.run_id), n.state, n.attempt.as_ref())),
            )
            .collect();
    let mine = |r: &RunRef| own.iter().find(|(j, _, _, _)| **j == r.job_id);
    for output in f.outputs.families.iter() {
        let published = matches!(
            output.state,
            FamilyState::Succeeded { .. } | FamilyState::Superseded { .. }
        );
        if let ResultFamily::Legacy(_) = output.family {
            check(
                published,
                "a legacy family is listed only as published, never as computed",
            )?;
        }
        let Some(c) = output.state.computation() else {
            continue;
        };
        let mut listed: Vec<RunFamily> = c.upstream.iter().map(|u| u.family).collect();
        listed.sort();
        let mut declared = output.family.upstream().to_vec();
        declared.sort();
        check(
            listed == declared,
            "a family names one upstream run for each family it depends on, and no other",
        )?;
        let job = mine(&c.producer);
        if let Some((_, run_id, state, attempt)) = job {
            check(
                c.producer.run_id.as_ref() == *run_id,
                "a family produced here names this job's run id",
            )?;
            check(
                !matches!(output.family, ResultFamily::Legacy(_))
                    || f.origin == Origin::LegacyImport,
                "no new run produces a legacy family; only the import carries one",
            )?;
            if let Some(batch) = output.state.batch() {
                check(
                    *state == StageState::Succeeded,
                    "only a succeeded job has published a family",
                )?;
                check(
                    attempt.is_none_or(|a| a.attempt_id == batch.batch_id),
                    "a family produced here is in the batch its last attempt sealed",
                )?;
            }
        } else {
            check(
                published,
                "a family another run produced is listed only as published",
            )?;
        }
    }
    if let (Some(snapshot), Some(inputs)) = (&f.math_snapshot, &f.inputs) {
        check(
            inputs.math_env.as_ref() == Some(&snapshot.math_env)
                && inputs.math_tick == Some(snapshot.math_tick)
                && inputs.math_caching_tick == Some(snapshot.caching_tick),
            "a run reads the math snapshot it was admitted against",
        )?;
    }
    Ok(())
}

impl DelphiRun {
    /// Builds a record, refusing what the database or the contract rules out.
    pub fn new(f: DelphiRunFields) -> Result<Self, Invalid> {
        let queued = f.origin == Origin::Queued;
        // Origin.
        if queued {
            check(f.run_id.is_some(), "a queued job has a run id")?;
            check(f.stage.is_some(), "a queued job has a stage")?;
        } else {
            check(
                f.run_id.is_none(),
                "a legacy import has no run id (never an invented one)",
            )?;
            check(
                f.stage.is_none() && f.attempt.is_none() && f.nodes.is_empty(),
                "a legacy import has no queue stage, attempt or nodes",
            )?;
            check(f.state.is_terminal(), "a legacy import is terminal")?;
        }
        // Graph position.
        check(
            f.parent_job_id.as_ref() != Some(&f.job_id),
            "a job is not its own parent",
        )?;
        match &f.parent_job_id {
            Some(parent) => {
                check(f.graph_id.is_some(), "a job with a parent is a graph node")?;
                check(
                    *parent == f.root_job_id && f.root_job_id != f.job_id,
                    "a graph node's parent is its graph's root",
                )?;
                check(
                    f.nodes.is_empty(),
                    "only the root's record lists the graph's nodes",
                )?;
            }
            None => check(
                f.root_job_id == f.job_id,
                "a job without a parent is its own root",
            )?,
        }
        if let Some(stage) = f.stage {
            check(
                stage.is_graph() == f.graph_id.is_some(),
                "a graph stage runs in a graph, and only a graph stage does",
            )?;
            check(
                f.kind == stage.kind(),
                "a queued job's kind follows from its stage",
            )?;
        }
        check(
            f.nodes.is_empty() || f.graph_id.is_some(),
            "nodes belong to a graph",
        )?;
        let mut seen = HashSet::from([f.job_id.as_str()]);
        for node in &f.nodes {
            check(node.stage.is_graph(), "a node runs a graph stage")?;
            check(seen.insert(node.job_id.as_str()), "a node is listed once")?;
            check_attempt(node.state, node.attempt.as_ref(), true)?;
        }
        // State, attempt, failure.
        check_attempt(f.state, f.attempt.as_ref(), queued)?;
        check(
            f.completed_at.is_none() || f.state.is_terminal(),
            "only a terminal job has completed_at",
        )?;
        if let Some(failure) = &f.failure {
            check(
                matches!(f.state, StageState::Dead | StageState::Cancelled),
                "only a dead or cancelled job has a failure",
            )?;
            check(
                (failure.code == FailureCode::Cancelled) == (f.state == StageState::Cancelled),
                "the failure code is cancelled exactly when the job was cancelled",
            )?;
            check(
                f.attempt.as_ref().map(|a| a.number) == Some(failure.attempt),
                "a failure names the job's last attempt",
            )?;
        }
        check_families(&f)?;
        // Models and cost.
        check(
            f.models.cluster_seed.is_none() || f.models.cluster.is_some(),
            "a clustering seed belongs to a clustering model",
        )?;
        let mut requests = HashSet::new();
        for r in &f.cost.provider_requests {
            check(
                requests.insert(r.request_id.as_str()),
                "a provider request is listed once",
            )?;
            check(
                !matches!(
                    r.state,
                    ProviderRequestState::Submitted | ProviderRequestState::Completed
                ) || r.batch_id.is_some(),
                "a submitted or completed provider request has a batch id",
            )?;
        }
        Ok(Self(f))
    }

    pub fn fields(&self) -> &DelphiRunFields {
        &self.0
    }
    pub fn into_fields(self) -> DelphiRunFields {
        self.0
    }
}
