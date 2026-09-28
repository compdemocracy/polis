//! Dynamo storage views, not an AWS client or new admission boundary.
//! Key declarations: delphi/create_dynamodb_tables.py; producer variants are
//! documented in P-063. Missing attributes differ from explicit Dynamo NULL.
//! Decimal values retain their exact text; open legacy fields are never f64.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Exact Dynamo decimal token. Validation belongs to the existing SDK boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DynamoNumber(pub String);

/// Tagged AttributeValue representation; binary data stays bytes internally.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DynamoValue {
    S(String),
    N(DynamoNumber),
    B(Vec<u8>),
    #[serde(rename = "BOOL")]
    Bool(bool),
    #[serde(rename = "NULL")]
    Null(bool),
    M(BTreeMap<String, DynamoValue>),
    L(Vec<DynamoValue>),
    #[serde(rename = "SS")]
    StringSet(Vec<String>),
    #[serde(rename = "NS")]
    NumberSet(Vec<DynamoNumber>),
    #[serde(rename = "BS")]
    BinarySet(Vec<Vec<u8>>),
}

/// delphi/create_dynamodb_tables.py:44; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiPCAConversationConfigItem {
    pub zid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_math_tick: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_count: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:57; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiPCAResultsItem {
    pub zid: String,
    pub math_tick: DynamoNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consensus_comments: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pca: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:78; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiKMeansClustersItem {
    pub zid_tick: String,
    pub group_id: DynamoNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zid: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:100; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentRoutingItem {
    pub zid_tick: String,
    pub comment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consensus_score: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zid: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:122; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiRepresentativeCommentsItem {
    pub zid_tick_gid: String,
    pub comment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repness: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zid: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:144; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiPCAParticipantProjectionsItem {
    pub zid_tick: String,
    pub participant_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zid: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:191; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiJobQueueItem {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_job_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checker_schedule_failed: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_config: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_results: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_type: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_expires_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logs: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_exit_confirmed: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn_reason: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:255; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiJobActiveGuardItem {
    pub guard_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_expires_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_hash: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_kind: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_type: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_guard_key: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:291; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentExtremityItem {
    pub conversation_id: String,
    pub comment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calculation_method: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calculation_timestamp: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_values: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extremity_value: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:322; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiNarrativeReportsItem {
    pub rid_section_model: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_data: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:347; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiUMAPConversationConfigItem {
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_layers: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evoc_parameters: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_comments: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_participants: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processed_date: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub umap_parameters: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:356; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentEmbeddingsItem {
    pub conversation_id: String,
    pub comment_id: DynamoNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:367; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentHierarchicalClusterAssignmentsItem {
    pub conversation_id: String,
    pub comment_id: DynamoNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_confidence: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_to_centroid: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_outlier: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer0_cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer1_cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer2_cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer3_cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer4_cluster_id: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:378; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentClustersStructureKeywordsItem {
    pub conversation_id: String,
    pub cluster_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub centroid_coordinates: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_clusters: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_cluster: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_comments: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_tfidf_scores: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_words: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_label: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:389; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiUMAPGraphItem {
    pub conversation_id: String,
    pub edge_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_nearest_neighbor: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_cluster_layers: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:402; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentClustersFeaturesItem {
    pub conversation_id: String,
    pub cluster_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_comments: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_tfidf_scores: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_words: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:413; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCommentClustersLLMTopicNamesItem {
    pub conversation_id: String,
    pub topic_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_name: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:425; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiTopicAgendaSelectionsItem {
    pub conversation_id: String,
    pub participant_id: String,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// delphi/create_dynamodb_tables.py:437; non-key variants remain optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelphiCollectiveStatementItem {
    pub zid_topic_jobid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments_data: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statement_data: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_key: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_name: Option<DynamoValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zid: Option<DynamoValue>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, DynamoValue>,
}

/// server/src/utils/storage.ts:111; separate from Delphi_NarrativeReports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportNarrativeStoreItem {
    pub rid_section_model: String,
    pub timestamp: String,
    #[serde(flatten)]
    pub attributes: BTreeMap<String, DynamoValue>,
}
/// Attempted consumer contract only; no table bootstrap is present.
/// delphi/umap_narrative/802_process_batch_results.py:75.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyBatchJobItem {
    pub batch_id: String,
    #[serde(flatten)]
    pub attributes: BTreeMap<String, DynamoValue>,
}
/// Attempted Node contract, not a claim that this table was provisioned.
/// server/src/routes/delphi/topicMod.ts:148.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopicModerationStatusItem {
    pub conversation_id: String,
    pub topic_key: String,
    #[serde(flatten)]
    pub attributes: BTreeMap<String, DynamoValue>,
}
/// Attempted Node table read; consumer keys are not an authoritative schema.
/// server/src/routes/delphi/topicMod.ts:286.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyCommentClustersItem {
    #[serde(flatten)]
    pub attributes: BTreeMap<String, DynamoValue>,
}
