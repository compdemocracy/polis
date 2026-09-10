//! CO01/CO06 observability: the counters the contract names, in a form the
//! P-031 alarm catalog can consume.
//!
//! The contract requires the source pass to "expose scan age, backlog and
//! failures" (CO01), "oldest unrepaired age" (CO06) and "maximum pass age"
//! (CO05). None of that existed. This module emits those, plus per-conversation
//! latency and the typed lease/publication outcome counters, as **CloudWatch
//! Embedded Metric Format** records in namespace `Polis/Math` with P-031's two
//! fixed dimensions `Environment` and `MathEnv` — and no per-conversation,
//! per-run or per-instance dimension, which P-031 forbids.
//!
//! There is no AWS client here and this crate takes no AWS dependency. A
//! [`Sink`] receives finished records; the prototype ships a JSON-lines sink
//! (stderr, stdout or a file) and a null sink. In a deployment the same records
//! reach CloudWatch through the awslogs path P-031 already describes; nothing
//! in this crate publishes a metric itself.
//!
//! Emission is best effort and never fails an operation: a coordinator that
//! cannot write a metric line still must not lose a vote. Failures are logged
//! once per record and counted.
use crate::config::Config;
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::Write,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// P-031 rev2 namespace for every math signal.
pub const NAMESPACE: &str = "Polis/Math";
/// The record shape; pinned so a log metric filter can match on it.
pub const SCHEMA: &str = "polis-metrics/1";

/// CloudWatch units, spelled exactly as the API spells them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Count,
    Seconds,
}
impl Unit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Count => "Count",
            Self::Seconds => "Seconds",
        }
    }
}

/// One metric value in one record.
#[derive(Debug, Clone)]
pub struct Datum {
    pub name: &'static str,
    pub value: f64,
    pub unit: Unit,
}
pub fn count(name: &'static str, value: impl Into<f64>) -> Datum {
    Datum {
        name,
        value: value.into(),
        unit: Unit::Count,
    }
}
pub fn seconds(name: &'static str, value: Duration) -> Datum {
    Datum {
        name,
        value: value.as_secs_f64(),
        unit: Unit::Seconds,
    }
}

/// Every metric this crate can emit, with the P-031 alarm it feeds.
/// `audit_stages.py` and `evidence/metrics-catalog.json` are generated from it,
/// so a metric cannot be added or dropped without the catalog noticing.
pub struct Declared {
    pub name: &'static str,
    pub unit: Unit,
    /// The CloudWatch statistic the alarm should use.
    pub statistic: &'static str,
    /// P-031 catalog row this metric actually satisfies, or `""`. Rev7's
    /// observability admission: none of these *is* A01 `PollHealthy`,
    /// A02 `PublishLagSeconds` or A03 `ObserverHealthy`, so no row claims one.
    pub alarm: &'static str,
    pub meaning: &'static str,
}
pub const CATALOG: &[Declared] = &[
    Declared { name: "SourcePassHealthy", unit: Unit::Count, statistic: "Minimum", alarm: "",
        meaning: "1 only when a whole source pass completed; 0 on a failed pass, missing when the process is gone. This is page-loop liveness. It is NOT P-031 A01 PollHealthy, which requires both the vote and the moderation poll to have succeeded recently: a pass in which every conversation failed still completes" },
    Declared { name: "SourcePassSeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "wall time of one bounded source pass" },
    Declared { name: "SourcePassConversations", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "conversations visited by the pass, before shard/backoff filtering" },
    Declared { name: "SourcePassProbed", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "conversations whose cheap change probe was evaluated" },
    Declared { name: "SourcePassSkipped", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "conversations the probe found unchanged, so no full source read was taken" },
    Declared { name: "SourcePassReconciled", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "conversations that took the authoritative full snapshot this pass" },
    Declared { name: "SourcePassPublished", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "conversations that committed a new generation this pass" },
    Declared { name: "SourcePassDeferred", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "conversations deferred this pass with durable bounded backoff" },
    Declared { name: "OldestReconciliationAgeSeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "CO01 scan age: age of the oldest authoritative full source snapshot for this shard's candidates, measured from before the source read. The incremental fast path is only sound while this is bounded. It is NOT P-031 A02 PublishLagSeconds: a quiet conversation's source age grows toward the ceiling with no pending math at all" },
    Declared { name: "ReconciliationBacklogConversations", unit: Unit::Count, statistic: "Maximum", alarm: "",
        meaning: "CO01 backlog: candidate conversations never reconciled, or overdue for reconciliation" },
    Declared { name: "FailureBacklogConversations", unit: Unit::Count, statistic: "Maximum", alarm: "",
        meaning: "CO01 failures: candidate conversations currently in durable backoff; a conversation this shard/allowlist would never attempt is not counted" },
    Declared { name: "OldestUnrepairedAgeSeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "CO06 oldest unrepaired age: how long the oldest still-failing candidate conversation has been failing. Scoped to this shard and allowlist, like every other gauge here. Not P-031 A02" },
    Declared { name: "ConversationLatencySeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "per-zid probe -> source -> compute -> publish wall time" },
    Declared { name: "SourceReadSeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "per-zid authoritative snapshot read time" },
    Declared { name: "ComputeSeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "per-zid worker compute time, worker process lifetime included" },
    Declared { name: "PublishSeconds", unit: Unit::Seconds, statistic: "Maximum", alarm: "",
        meaning: "per-zid publication transaction time, retries included" },
    Declared { name: "LeaseAcquired", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO03 lease outcome: this owner took or renewed ownership at an epoch" },
    Declared { name: "LeaseUnavailable", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO03 lease outcome: another owner holds an unexpired lease" },
    Declared { name: "LeaseExpired", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO03 lease outcome: this owner's own lease elapsed in database time" },
    Declared { name: "LeaseFenced", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO03 lease outcome: owner or epoch superseded; terminal for this owner" },
    Declared { name: "PublishCommitted", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 publication outcome: one generation committed" },
    Declared { name: "PublishConflict", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 publication outcome: stale expected tick, nothing overwritten" },
    Declared { name: "PublishRefused", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 publication outcome: ownership refused inside the transaction" },
    Declared { name: "PublishRetried", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 publication outcome: whole-transaction retry after 40001/40P01" },
    Declared { name: "PublishUncertain", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 ambiguous COMMIT attempts, counted before readback; not evidence of resolution" },
    Declared { name: "PublishResolvedOwn", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 ambiguous COMMIT resolved by coherent readback of this exact operation, epoch, tick and checkpoint" },
    Declared { name: "PublishUnresolvedLost", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "CO04 ambiguous COMMIT without proof of this operation: missing, inconsistent or superseded identity, or failed reconnect/readback. Does not prove rollback; any nonzero sum requires investigation" },
    Declared { name: "MetricsDropped", unit: Unit::Count, statistic: "Sum", alarm: "",
        meaning: "records this process failed to write; a nonzero value means the other series are incomplete" },
];

/// Per-pass counters. Reset at the start of every source pass and emitted as
/// one record when the pass ends, healthy or not.
#[derive(Debug, Default, Clone, Copy)]
pub struct Tally {
    pub visited: u32,
    pub probed: u32,
    pub skipped: u32,
    pub reconciled: u32,
    pub published: u32,
    pub deferred: u32,
    pub lease_acquired: u32,
    pub lease_unavailable: u32,
    pub lease_expired: u32,
    pub lease_fenced: u32,
    pub publish_committed: u32,
    pub publish_conflict: u32,
    pub publish_refused: u32,
    pub publish_retried: u32,
}
impl Tally {
    pub fn data(&self, elapsed: Duration, healthy: bool) -> Vec<Datum> {
        vec![
            count("SourcePassHealthy", u32::from(healthy)),
            seconds("SourcePassSeconds", elapsed),
            count("SourcePassConversations", self.visited),
            count("SourcePassProbed", self.probed),
            count("SourcePassSkipped", self.skipped),
            count("SourcePassReconciled", self.reconciled),
            count("SourcePassPublished", self.published),
            count("SourcePassDeferred", self.deferred),
            count("LeaseAcquired", self.lease_acquired),
            count("LeaseUnavailable", self.lease_unavailable),
            count("LeaseExpired", self.lease_expired),
            count("LeaseFenced", self.lease_fenced),
            count("PublishCommitted", self.publish_committed),
            count("PublishConflict", self.publish_conflict),
            count("PublishRefused", self.publish_refused),
            count("PublishRetried", self.publish_retried),
        ]
    }
}

/// Where finished records go. Deliberately not an AWS client.
pub trait Sink: Send {
    fn write(&mut self, record: &Value) -> Result<()>;
    /// Human name for logs and evidence.
    fn describe(&self) -> String;
}

/// Discards everything. Used by `--metrics off` and by unit tests.
pub struct NullSink;
impl Sink for NullSink {
    fn write(&mut self, _record: &Value) -> Result<()> {
        Ok(())
    }
    fn describe(&self) -> String {
        "null".into()
    }
}

/// One JSON object per line. This is the shape a CloudWatch Logs EMF ingestion
/// or a metric filter consumes; nothing here talks to AWS.
pub struct JsonLinesSink {
    target: Target,
    name: String,
}
enum Target {
    Stderr,
    Stdout,
    File(std::path::PathBuf),
}
impl JsonLinesSink {
    pub fn stderr() -> Self {
        Self {
            target: Target::Stderr,
            name: "jsonlines:stderr".into(),
        }
    }
    pub fn stdout() -> Self {
        Self {
            target: Target::Stdout,
            name: "jsonlines:stdout".into(),
        }
    }
    pub fn file(path: impl Into<std::path::PathBuf>) -> Self {
        let path = path.into();
        Self {
            name: format!("jsonlines:{}", path.display()),
            target: Target::File(path),
        }
    }
}
impl Sink for JsonLinesSink {
    fn write(&mut self, record: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        match &self.target {
            Target::Stderr => std::io::stderr().write_all(&line)?,
            Target::Stdout => std::io::stdout().write_all(&line)?,
            // Appended whole, so a concurrent reader never sees half a record.
            Target::File(path) => OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?
                .write_all(&line)?,
        }
        Ok(())
    }
    fn describe(&self) -> String {
        self.name.clone()
    }
}

/// Builds records and hands them to a sink.
pub struct Metrics {
    sink: Box<dyn Sink>,
    environment: String,
    math_env: String,
    dropped: u64,
}
impl Metrics {
    pub fn new(sink: Box<dyn Sink>, environment: &str, math_env: &str) -> Self {
        Self {
            sink,
            environment: environment.to_owned(),
            math_env: math_env.to_owned(),
            dropped: 0,
        }
    }
    /// `P026_METRICS` selects the sink: `off` (default), `stderr`, `stdout`, or
    /// a filesystem path. `P026_ENVIRONMENT` is P-031's `Environment` dimension
    /// and defaults to `synthetic`, never to `prod`.
    ///
    /// `off` is the default on purpose: writing records into a pipe that no
    /// reader is draining blocks the writer once the pipe buffer fills, and a
    /// coordinator must not stall because of its own telemetry.
    pub fn from_env(config: &Config) -> Self {
        let sink: Box<dyn Sink> = match config.metrics_sink.as_str() {
            "off" => Box::new(NullSink),
            "stdout" => Box::new(JsonLinesSink::stdout()),
            "stderr" => Box::new(JsonLinesSink::stderr()),
            path => Box::new(JsonLinesSink::file(path)),
        };
        Self::new(sink, &config.environment, &config.math_env)
    }
    pub fn describe(&self) -> String {
        self.sink.describe()
    }
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
    /// Emit one record. `context` is diagnostic only: it is a log property, not
    /// a CloudWatch dimension, so it can carry a zid without creating the
    /// per-conversation dimension P-031 forbids.
    pub fn emit(&mut self, operation: &str, data: &[Datum], context: Value) {
        if data.is_empty() {
            return;
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let mut record = json!({
            "schema": SCHEMA,
            "_aws": {
                "Timestamp": timestamp,
                "CloudWatchMetrics": [{
                    "Namespace": NAMESPACE,
                    "Dimensions": [["Environment", "MathEnv"]],
                    "Metrics": data.iter().map(|d| json!({"Name": d.name, "Unit": d.unit.as_str()}))
                        .collect::<Vec<_>>(),
                }],
            },
            "Environment": self.environment,
            "MathEnv": self.math_env,
            "operation": operation,
            "context": context,
        });
        for d in data {
            record[d.name] = json!(d.value);
        }
        if let Err(error) = self.sink.write(&record) {
            self.dropped += 1;
            tracing::warn!(error=%error, dropped = self.dropped, "metric record not written");
        }
    }
}

/// The declared catalog as JSON, for `polis-coordinator metrics` and for the
/// P-031 evidence file. Generated from [`CATALOG`], never hand-maintained.
pub fn catalog_json() -> Value {
    json!({
        "schema": SCHEMA,
        "namespace": NAMESPACE,
        "dimensions": ["Environment", "MathEnv"],
        "transport": "CloudWatch Embedded Metric Format records on a JSON-lines sink; no AWS client in this crate",
        "publication_readback_alarm": {
            "metric": "PublishUnresolvedLost", "statistic": "Sum", "threshold": 1,
            "comparison": "GreaterThanOrEqualToThreshold", "period_seconds": 60,
            "evaluation_periods": 1, "datapoints_to_alarm": 1,
            "treat_missing_data": "notBreaching", "deployed": false,
            "note": "Sparse outcome events, not a heartbeat. Missing events cannot establish health or resolution; independent producer/sink observation and delivery remain required. A later resolved-own event does not cancel an earlier unresolved-lost operation."
        },
        "p031_status": {
            "coverage_claimed": [],
            "not_implemented": ["A01 PollHealthy", "A02 PublishLagSeconds", "A03 ObserverHealthy"],
            "note": "These are local diagnostics with no deployed publisher and no delivery proof. \
A01 needs both poll loops to have succeeded, A02 needs initiated-but-unpublished work, and A03 needs \
an independent observer; none of the series below is any of those. Scope: every gauge is scoped to \
this shard and allowlist."
        },
        "metrics": CATALOG.iter().map(|d| json!({
            "name": d.name,
            "unit": d.unit.as_str(),
            "statistic": d.statistic,
            "p031_alarm": d.alarm,
            "meaning": d.meaning,
        })).collect::<Vec<_>>(),
    })
}
