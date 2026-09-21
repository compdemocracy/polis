//! Job payload descriptions from the P-063 source map; unused by runtime.
//! These preserve legacy openness. They do not replace admission/lease checks.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// server/src/routes/delphi/jobs.ts:78; delphi/scripts/job_poller.py:1230.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FullPipelineJob {
    pub job_id: String,
    pub conversation_id: String,
    pub report_id: Option<String>,
    /// Serialized JSON string, not an automatically decoded map.
    pub job_config: Option<String>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// server/src/routes/delphi/batchReports.ts:91.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateNarrativeBatchJob {
    pub job_id: String,
    pub conversation_id: String,
    pub report_id: String,
    pub job_config: String,
    pub environment: Option<String>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// delphi/umap_narrative/801_narrative_report_batch.py:1457.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AwaitingNarrativeBatchJob {
    pub job_id: String,
    pub batch_job_id: String,
    pub batch_id: String,
    pub conversation_id: String,
    pub report_id: String,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// New typed discriminator only. Existing unknown-kind fallthrough is untouched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "job_type")]
pub enum DelphiJob {
    #[serde(rename = "FULL_PIPELINE")]
    FullPipeline(FullPipelineJob),
    #[serde(rename = "CREATE_NARRATIVE_BATCH")]
    CreateNarrativeBatch(CreateNarrativeBatchJob),
    #[serde(rename = "AWAITING_NARRATIVE_BATCH")]
    AwaitingNarrativeBatch(AwaitingNarrativeBatchJob),
}
/// server/src/queue/enqueue.ts:68; migration 000019 pq_enqueue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoopJob {
    pub env: String,
    pub zid: i32,
    pub product_key: String,
    pub actor_scope: String,
    pub request_key: String,
    pub priority: Option<i16>,
    pub max_attempts: Option<i32>,
}
/// server/src/routes/math.ts:149; math/src/polismath/tasks.clj:52.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateMathJob {
    pub zid: i32,
    /// Producer currently accepts any JSON value.
    pub math_update_type: Value,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// server/src/routes/math.ts:252; the route has unvalidated rid/math_tick values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerateReportDataJob {
    pub rid: Value,
    pub zid: i32,
    pub math_tick: Value,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// server/src/utils/common.ts:118; math/src/polismath/tasks.clj:35.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerateExportDataJob {
    pub email: String,
    pub zid: i32,
    #[serde(rename = "at-date")]
    pub at_date: i64,
    pub format: String,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// server/src/routes/votes.ts:306; workers/import-processor.ts:34.
/// Email can be omitted by the producer despite the consumer's TS annotation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMappingJob {
    pub job_id: i32,
    pub zid: i32,
    pub s3_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(flatten)]
    pub legacy_fields: BTreeMap<String, Value>,
}
/// server/src/routes/notify.ts:117; it is a row, not a task_type envelope.
pub type NotificationJob = super::NotificationTasksRow;
