//! `GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id>][&source=served|shadow][&selection=<rule>]`:
//! the topic map of one Delphi run of a report's conversation, as the
//! document `polis-topic-map/1`, read as the run stored it.
//!
//! A run that makes a map stores it as one result family,
//! [`FAMILY`] (key `conversation_id`, `part`), one row per part: the
//! document ([`PART_DOCUMENT`]), its gzip ([`PART_GZIP`]) and its SHA-256
//! ([`PART_SHA256`]); or, when there is no map to draw, one row
//! [`PART_NO_MAP`] with the reason ([`StoredNoMap`]); every row names the
//! job that stored it ([`JOB_ID`]). The route sends the
//! stored bytes as they are: the gzip to a client that accepts gzip, the
//! document otherwise, with the stored SHA-256 as the ETag. It never builds
//! a map; the one rewrite is the form sent to a reader who may not see the
//! comments moderated out now (below).
//!
//! A Rust-only route: Node has no handler for this path, so a request
//! polis-api hands back reaches Node's 404.
//!
//! Who may read what: anyone who holds the report id, as for the report's
//! other Delphi reads (`GET /api/v3/delphi`, `/api/v3/delphi/reports`,
//! `/api/v3/delphi/visualizations` take no sign-in: knowing the report id is
//! what reads them), for every query below. What a reader receives depends
//! on who they are and on the comments' moderation at the time of the read:
//!
//! - The conversation's moderators and the site administrators, with a
//!   bearer token: the map as the run stored it, `Cache-Control: private,
//!   no-store`.
//! - Everyone else: each comment moderated out now is a bare point (its
//!   position only; see [`Points::moderated_out`]), and a topic with no
//!   member left to show is not sent. A map holding no moderated-out comment
//!   is the stored bytes. A token that does not verify is such a reader.
//!
//! Which map:
//!
//! - Without `job_id`: the map of the run the conversation's results are
//!   served from under `selection` (what participants are shown,
//!   `participant_visible/1`, when absent).
//! - `job_id`: that one stored run of the report's conversation, whichever
//!   comment rule it ran under; a past run's map may later be removed to save
//!   storage, and then answers `not_stored`, as a run that never stored one
//!   does.
//! - `source=served` reads the runs the deployment serves; `source=shadow`
//!   the shadow's. Without `source`, the served side is read first, and when
//!   it has nothing stored for the query (no served run, a run that stored
//!   no map, or no such job) the shadow's side is read; if the shadow has
//!   nothing stored either, the served side's answer is given. The answer
//!   says which side it is from ([`HEADER_SOURCE`], [`NoMap::source`]).
//!
//! - `list=jobs`: not a map but the list of the conversation's finished
//!   full pipeline runs ([`JobList`]), newest first, at most [`MAX_LISTED`],
//!   with the one a read without `job_id` would answer marked `current`. A
//!   listed run may have stored no map: that is in its run record only, and
//!   the list reads no run record per run; reading the run says. With
//!   `source` and `selection` it lists that side's or that rule's runs only
//!   (and `current` is the run that read would answer); with `job_id` it is
//!   400. It is read from the runs' rows only, never from a map, so it is
//!   the same for every reader and moderating a comment never changes it.
//!
//! A run that stored no map of its own may have one made later from its
//! stored layout, clusters and names by a derived job, with nothing
//! recomputed: that job's map is this run's map. Every query above names the
//! run (`job_id`, `selection`, `source` keep their meaning), never the job
//! that made the map. A map so made says which job made it
//! ([`HEADER_MADE_BY`]); its document, and [`HEADER_JOB`], name the run its
//! layout, clusters and names are from. A map the run stored itself is sent
//! exactly as before, with no such header. While the derived job has not
//! finished the answer is [`NoMapReason::MapPending`]; when it ended without
//! a map, the reason it stored ([`NoMap::map_job_id`] names the job); when it
//! failed, [`NoMapReason::MapFailed`]. A listed run with such a job says so
//! ([`ListedJob::map`]). A query naming the derived job itself (`job_id`)
//! is answered as the same query naming its run: [`HEADER_JOB`] the run,
//! [`HEADER_MADE_BY`] the job, the run's selection. The route only reads: it
//! never asks for a map to be made. A deployment reads derived maps only when
//! it turns them on; until then every answer is as it was before them.
//!
//! Every answer is one of the types below:
//!
//! - 200, the document (`TopicMap`: the stored bytes, or the reader's form),
//!   with the run it is from in the headers [`HEADER_JOB`], [`HEADER_SOURCE`],
//!   [`HEADER_SCOPE`] and [`HEADER_SELECTION`]; 304 when the client's ETag is
//!   the one this reader would be sent.
//! - 200, [`NoMap`]: the report exists and there is nothing to draw, with the
//!   reason from a closed set ([`NoMapReason`]).
//! - 400, 404, 422, 500, 503: the closed set of refusals
//!   ([`Refused`]).
//!   503 is the route shedding its own load: nothing is wrong with the
//!   conversation and asking again after `Retry-After` is safe.
//!
//! The document carries no comment text: `points.text` is empty. A page that
//! shows the text in the tooltip fills `points.text` from the comments it
//! already holds, one entry per `points.id`, before it hands the document to
//! the browser component. `title` and `attribution` are empty for the same
//! reason: the document depends only on the run, never on the report.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/api/v3/delphi/topicMap";
/// The document's `schema`.
pub const SCHEMA: &str = "polis-topic-map/1";

/// The result family a run stores its map in, in its own result batch
/// (`queue-rs/polis-topic-map/src/stored.rs` writes it). Every row carries
/// [`JOB_ID`], the producing run's job: a read that follows a publication to
/// earlier batches can meet an earlier run's map, and a reader checks it.
pub const FAMILY: &str = "Delphi_TopicMapDocument";
/// The document's part: attribute [`BODY`], `S` (the JSON text, UTF-8).
pub const PART_DOCUMENT: &str = "document";
/// The document's gzip: attribute [`BODY`], `B` (base64 of the gzip of the
/// document's UTF-8 bytes).
pub const PART_GZIP: &str = "document.gz";
/// The document's digest: attribute [`BODY`], `S` (64 lowercase hex digits,
/// the SHA-256 of the document's UTF-8 bytes).
pub const PART_SHA256: &str = "sha256";
/// No map: attribute [`REASON`], `S`, one of [`StoredNoMap`]. When this row
/// is present it is the family's only row.
pub const PART_NO_MAP: &str = "no_map";
/// The attribute that holds a part's bytes.
pub const BODY: &str = "body";
/// The attribute that holds a stored no-map reason.
pub const REASON: &str = "reason";
/// The attribute that names the job that stored the row.
pub const JOB_ID: &str = "job_id";
/// The longest a stored row's line is (the writer stores `no_map`,
/// `too_large` above it).
pub const ROW_LIMIT: usize = 1_048_576;

/// The fact of a `topic_names` step in a map's provenance naming the
/// provider its namer named (`bedrock`); absent for the default, the Claude
/// API (`anthropic`).
pub const NAMER_PROVIDER: &str = "namer_provider";
/// The provider a namer names when it names none.
pub const DEFAULT_NAMER_PROVIDER: &str = "anthropic";

/// Response headers naming the run a map is from.
pub const HEADER_JOB: &str = "X-Polis-Topic-Map-Job";
pub const HEADER_SOURCE: &str = "X-Polis-Topic-Map-Source";
pub const HEADER_SCOPE: &str = "X-Polis-Topic-Map-Scope";
pub const HEADER_SELECTION: &str = "X-Polis-Topic-Map-Selection";
/// The derived job that made the map from the run's stored layout, clusters
/// and names; sent only with such a map, never with a map the run stored.
pub const HEADER_MADE_BY: &str = "X-Polis-Topic-Map-Made-By";

/// Which runs are read: the ones the deployment serves, or the shadow's.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Served,
    Shadow,
}

impl Source {
    pub fn word(self) -> &'static str {
        match self {
            Self::Served => "served",
            Self::Shadow => "shadow",
        }
    }
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "served" => Some(Self::Served),
            "shadow" => Some(Self::Shadow),
            _ => None,
        }
    }
}

/// The comment rule a run laid out, clustered and named. Each publishes in
/// its own scope ([`Selection::scope`]), so a reader names the one it reads
/// and never merges two.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Selection {
    /// What participants are shown.
    #[default]
    ParticipantVisible,
    /// Every comment: unmoderated, moderated in and moderated out.
    AllComments,
    /// Every comment but the moderated-out ones.
    AllButModeratedOut,
}

impl Selection {
    /// The word a query names it by.
    pub fn word(self) -> &'static str {
        match self {
            Self::ParticipantVisible => "participant_visible",
            Self::AllComments => "all_comments",
            Self::AllButModeratedOut => "all_but_moderated_out",
        }
    }
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "participant_visible" => Some(Self::ParticipantVisible),
            "all_comments" => Some(Self::AllComments),
            "all_but_moderated_out" => Some(Self::AllButModeratedOut),
            _ => None,
        }
    }
    /// The publication scope its runs are served from under `base` (the
    /// deployment's result scope): `base` itself for what participants are
    /// shown, `base:<word>` for each other rule.
    pub fn scope(self, base: &str) -> String {
        match self {
            Self::ParticipantVisible => base.to_owned(),
            other => format!("{base}:{}", other.word()),
        }
    }
}

/// The query. Without `job_id`, the run the conversation's results are
/// served from under `selection` (what participants are shown when absent).
/// Without `source`, the served side and then the shadow's (module docs).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub report_id: Option<String>,
    pub job_id: Option<String>,
    pub source: Option<Source>,
    pub selection: Option<Selection>,
    /// `list=jobs`: the runs a page may choose from ([`JobList`]), not a map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<List>,
}

/// What `list` names.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum List {
    Jobs,
}

impl List {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "jobs" => Some(Self::Jobs),
            _ => None,
        }
    }
}

/// Runs a list names at most, both sides together; older runs are not
/// listed (a page still reads one by its `job_id`).
pub const MAX_LISTED: usize = 50;

/// 200 for `list=jobs`: the report's conversation's finished full pipeline
/// runs, newest first (by `created_at`, then `job_id`, both descending).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct JobList {
    pub report_id: String,
    pub jobs: Vec<ListedJob>,
}

/// One finished run, as its job row describes it. Nothing here is read from
/// the map, so nothing depends on moderation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ListedJob {
    pub job_id: String,
    pub source: Source,
    /// The comment rule the run's configuration names; null when it names
    /// none this route knows.
    pub selection: Option<Selection>,
    /// When the run was created (RFC 3339, UTC).
    pub created_at: Option<String>,
    /// Comments the run laid out: in its run record only (the row count of
    /// its cluster assignments), which the list does not read, so always
    /// null here; the map read gives the points.
    pub points: Option<u64>,
    /// Topics per level, finest first: not in the run record (only in the
    /// map), so always null here; the map read gives `levels`.
    pub levels: Option<Vec<u64>>,
    pub names: Names,
    /// The run a read with this `report_id` (and this `source` and
    /// `selection`, if given) and no `job_id` answers.
    pub current: bool,
    /// The derived job that makes this run's map from its stored layout,
    /// when there is one; absent otherwise (a map the run stored itself is in
    /// its run record only, which the list does not read).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<ListedMap>,
}

/// A listed run's derived map: which job makes it and how far it is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ListedMap {
    pub job_id: String,
    pub status: MapStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MapStatus {
    /// Finished: it stored the run's map, or the reason there is none
    /// (reading the run says which).
    Stored,
    /// Waiting or running.
    Pending,
    /// Ended without storing anything.
    Failed,
}

/// How the run's topics were named: what the run stored, never what its
/// configuration asked for. The list says the keyword fallback for every run
/// until the naming outcome (the manifest's `models.topic`) is readable in
/// the list's own statement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Names {
    pub by: NamedBy,
    /// The model that named them, when a model did.
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NamedBy {
    /// The keyword fallback.
    Keywords,
    /// A model wrote them (the run's manifest says so, not its
    /// configuration). The list does not say it yet.
    Model,
    /// The run stored no topic names. The list never says it: whether a run
    /// stored names is in its run record only.
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Success {
    Success,
}

/// A refusal body, in the shape of the report's other Delphi reads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    pub status: Status,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
    /// The query key a 400 is about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter: Option<String>,
}

/// The closed set of refusals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// 400: no `report_id`, or an empty one (as `/delphi/visualizations`).
    MissingReport,
    /// 400: `source` or `selection` names nothing this route knows, or
    /// `selection` is given with `job_id` (a stored run has its own rule).
    BadParameter(&'static str),
    /// 404: no report with this id, or a report without a conversation (as
    /// `/delphi/visualizations` and `/api/v3/delphi`).
    UnknownReport(String),
    /// 404: `job_id` names no run of this report's conversation: not a
    /// canonical job id, no such run, or another conversation's run. One
    /// answer for all three (as `/delphi/runs/:job_id`).
    JobNotFound,
    /// 404: `source=shadow`, and this deployment reads no shadow.
    SourceUnavailable,
    /// 422: the run stored no map because it was too large, or a stored part
    /// is larger than this route sends. The map is refused, never truncated.
    TooLarge,
    /// 500: the run's stored map cannot be served: a part missing, a row
    /// naming another job, a digest that is not the document's, a gzip that
    /// is not the document; or the route's database login may not read what
    /// it needs (a missing grant). The map is refused, never served
    /// unchecked, and the answer names nothing more.
    Unreadable,
    /// 503 with `Retry-After`: the route is full (as many map reads in flight
    /// as it admits, all its connections in use, or its reads slower than
    /// their deadlines or unanswered). Nothing is wrong
    /// with the conversation; asking again later is safe.
    Busy,
}

/// The codes the refusals carry as their messages.
pub const TOO_LARGE: &str = "polis_err_topic_map_too_large";
pub const BUSY: &str = "polis_err_topic_map_busy";
pub const BAD_PARAMETER: &str = "polis_err_topic_map_parameter";
pub const NO_SOURCE: &str = "polis_err_topic_map_no_source";
pub const UNREADABLE: &str = "polis_err_topic_map_unreadable";
/// The seconds a busy refusal asks the client to wait.
pub const RETRY_AFTER: &str = "1";

impl Refused {
    pub fn status(&self) -> u16 {
        match self {
            Self::MissingReport | Self::BadParameter(_) => 400,
            Self::UnknownReport(_) | Self::JobNotFound | Self::SourceUnavailable => 404,
            Self::TooLarge => 422,
            Self::Unreadable => 500,
            Self::Busy => 503,
        }
    }
    pub fn body(&self) -> Refusal {
        let (message, report_id, parameter) = match self {
            Self::MissingReport => ("report_id is required", None, None),
            Self::BadParameter(key) => (BAD_PARAMETER, None, Some((*key).to_owned())),
            Self::UnknownReport(id) => (
                "Could not find conversation for report_id",
                Some(id.clone()),
                None,
            ),
            Self::JobNotFound => ("Job not found", None, None),
            Self::SourceUnavailable => (NO_SOURCE, None, None),
            Self::TooLarge => (TOO_LARGE, None, None),
            Self::Unreadable => (UNREADABLE, None, None),
            Self::Busy => (BUSY, None, None),
        };
        Refusal {
            status: Status::Error,
            message: message.into(),
            report_id,
            parameter,
        }
    }
}

/// The reasons a run stores instead of a map ([`PART_NO_MAP`]).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StoredNoMap {
    /// The document would be larger than a stored row: answered 422.
    TooLarge,
    NoPositions,
    NoTopics,
    TooFewComments,
}

impl StoredNoMap {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "too_large" => Some(Self::TooLarge),
            "no_positions" => Some(Self::NoPositions),
            "no_topics" => Some(Self::NoTopics),
            "too_few_comments" => Some(Self::TooFewComments),
            _ => None,
        }
    }
}

/// Why a report that exists has no map to draw.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NoMapReason {
    /// The conversation serves no Delphi run under this source and comment
    /// rule (and no `job_id` was given).
    NoRun,
    /// The named run has not succeeded (queued, running, failed or cancelled).
    RunNotReady,
    /// The run has no stored map: it ran before runs stored maps or with the
    /// map step off, or its map has been removed since (to save storage).
    NotStored,
    /// The run stored no comment positions.
    NoPositions,
    /// The run stored no topics: no topic names, or no cluster layers.
    NoTopics,
    /// The first view has no area: always so for one or two comments, and
    /// when the comments it keeps sit on one point or one line.
    TooFewComments,
    /// The run stored no map, and the derived job making one from its stored
    /// results has not finished ([`NoMap::map_job_id`]).
    MapPending,
    /// The run stored no map, and the derived job that was to make one ended
    /// without storing anything ([`NoMap::map_job_id`]).
    MapFailed,
}

impl NoMapReason {
    pub fn message(self) -> &'static str {
        match self {
            Self::NoRun => "No Delphi run found for this report",
            Self::RunNotReady => "The Delphi run has not finished",
            Self::NotStored => "The Delphi run has no stored topic map",
            Self::NoPositions => "The Delphi run stored no comment positions",
            Self::NoTopics => "The Delphi run stored no topics",
            Self::TooFewComments => "Too few comments to draw a topic map",
            Self::MapPending => "The topic map of this Delphi run is being made",
            Self::MapFailed => "The topic map of this Delphi run could not be made",
        }
    }
}

/// 200 without a map: which run was considered and why there is nothing to
/// draw.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NoMap {
    pub status: Success,
    pub message: String,
    pub report_id: String,
    /// The run considered; null when the conversation serves none.
    pub job_id: Option<String>,
    pub source: Source,
    /// The publication scope read; null for a named run.
    pub scope: Option<String>,
    pub reason: NoMapReason,
    /// The derived job whose outcome this is, when the run stored no map of
    /// its own; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_job_id: Option<String>,
}

impl NoMap {
    pub fn new(
        report_id: String,
        job_id: Option<String>,
        source: Source,
        scope: Option<String>,
        reason: NoMapReason,
    ) -> Self {
        Self {
            status: Success::Success,
            message: reason.message().into(),
            report_id,
            job_id,
            source,
            scope,
            reason,
            map_job_id: None,
        }
    }
}

/// The document `polis-topic-map/1`, field for field and in the order the
/// generator writes it. Closed: an unknown field is refused.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TopicMap {
    pub schema: String,
    /// Empty: the page names the map.
    pub title: String,
    /// Empty: the page carries the attribution.
    pub attribution: String,
    pub run: RunInfo,
    /// `[xmin, xmax, ymin, ymax]` of the first view.
    pub bounds: [f64; 4],
    #[serde(rename = "pointRadius")]
    pub point_radius: f64,
    /// Finest first.
    pub levels: Vec<Level>,
    pub topics: Vec<Topic>,
    pub points: Points,
    /// How the run made the map (its steps, models, comment rule and
    /// counts), written by the step that stored it; absent from documents
    /// made before the step wrote one. Who named the topics is
    /// `models.topic` (the model, or `keywords` for the keyword fallback);
    /// the namer a model-named run was given is in its `topic_names` steps
    /// (`execution.steps`), whose facts carry [`NAMER_PROVIDER`] only when
    /// the namer named a provider other than the default: absent, the namer
    /// was the Claude API's, and every map stored before the provider existed
    /// reads that way. Sent as stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RunInfo {
    #[serde(rename = "jobId")]
    pub job_id: String,
    /// The model that named the topics, when every stored name agrees on one.
    #[serde(rename = "topicModel")]
    pub topic_model: Option<String>,
    /// When the run was created.
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Level {
    pub level: u32,
    pub topics: u64,
    pub unclustered: u64,
    #[serde(rename = "cmapPalette")]
    pub cmap_palette: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Topic {
    /// `<level>_<cluster>`.
    pub id: String,
    pub level: u32,
    pub cluster: i64,
    pub key: Option<String>,
    pub name: String,
    pub count: u64,
    pub x: f64,
    pub y: f64,
    pub weight: f64,
    pub parent: Option<String>,
    #[serde(rename = "parentShare")]
    pub parent_share: Option<f64>,
    pub color: String,
    #[serde(rename = "labelColor")]
    pub label_color: String,
    #[serde(rename = "colorAll")]
    pub color_all: String,
    #[serde(rename = "labelColorAll")]
    pub label_color_all: String,
}

/// One entry per comment in `id`, `x`, `y` and each row of `topic`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Points {
    /// The comment id; null for a moderated-out comment ([`Self::moderated_out`]).
    pub id: Vec<Option<i64>>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// Per level: the index in `topics` of each comment's topic, or -1.
    pub topic: Vec<Vec<i64>>,
    /// Empty: the stored document carries no comment text.
    pub text: Vec<String>,
    /// How many of the points, the last ones, are comments moderated out:
    /// a position and nothing else (`id` null, `topic` -1 at every level,
    /// `text` empty if present), ordered by position. A view draws them as
    /// moderated out (the browser component draws a point in no topic grey).
    /// Absent, and zero, in every stored document: only a reader's form sets it.
    #[serde(rename = "moderatedOut", default, skip_serializing_if = "is_zero")]
    pub moderated_out: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_keep_the_neighbouring_shapes_and_statuses() {
        let cases = [
            (
                Refused::MissingReport,
                400,
                r#"{"status":"error","message":"report_id is required"}"#,
            ),
            (
                Refused::BadParameter("source"),
                400,
                r#"{"status":"error","message":"polis_err_topic_map_parameter","parameter":"source"}"#,
            ),
            (
                Refused::UnknownReport("r1".into()),
                404,
                r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"r1"}"#,
            ),
            (
                Refused::JobNotFound,
                404,
                r#"{"status":"error","message":"Job not found"}"#,
            ),
            (
                Refused::SourceUnavailable,
                404,
                r#"{"status":"error","message":"polis_err_topic_map_no_source"}"#,
            ),
            (
                Refused::TooLarge,
                422,
                r#"{"status":"error","message":"polis_err_topic_map_too_large"}"#,
            ),
            (
                Refused::Unreadable,
                500,
                r#"{"status":"error","message":"polis_err_topic_map_unreadable"}"#,
            ),
            (
                Refused::Busy,
                503,
                r#"{"status":"error","message":"polis_err_topic_map_busy"}"#,
            ),
        ];
        for (refused, status, body) in cases {
            assert_eq!(refused.status(), status);
            assert_eq!(serde_json::to_string(&refused.body()).unwrap(), body);
        }
    }

    #[test]
    fn a_report_without_a_map_says_why_and_which_run_in_a_closed_set() {
        let body = NoMap::new(
            "r1".into(),
            None,
            Source::Served,
            Some("delphi".into()),
            NoMapReason::NoRun,
        );
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"status":"success","message":"No Delphi run found for this report","report_id":"r1","job_id":null,"source":"served","scope":"delphi","reason":"no_run"}"#
        );
        for (reason, code) in [
            (NoMapReason::RunNotReady, "run_not_ready"),
            (NoMapReason::NotStored, "not_stored"),
            (NoMapReason::NoPositions, "no_positions"),
            (NoMapReason::NoTopics, "no_topics"),
            (NoMapReason::TooFewComments, "too_few_comments"),
        ] {
            let body = NoMap::new("r1".into(), Some("j".into()), Source::Shadow, None, reason);
            let text = serde_json::to_string(&body).unwrap();
            assert!(text.contains(&format!(r#""reason":"{code}""#)), "{text}");
            assert_eq!(serde_json::from_str::<NoMap>(&text).unwrap(), body);
        }
        assert!(serde_json::from_str::<NoMapReason>(r#""too_large""#).is_err());
        for word in ["too_large", "no_positions", "no_topics", "too_few_comments"] {
            assert!(StoredNoMap::parse(word).is_some(), "{word}");
        }
        assert!(StoredNoMap::parse("no_run").is_none());
    }

    #[test]
    fn a_derived_maps_outcome_names_its_job_and_adds_nothing_otherwise() {
        let mut body = NoMap::new(
            "r1".into(),
            Some("x".into()),
            Source::Served,
            None,
            NoMapReason::MapPending,
        );
        assert!(!serde_json::to_string(&body).unwrap().contains("map_job_id"));
        body.map_job_id = Some("y".into());
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"status":"success","message":"The topic map of this Delphi run is being made","report_id":"r1","job_id":"x","source":"served","scope":null,"reason":"map_pending","map_job_id":"y"}"#
        );
        let failed = serde_json::to_string(&NoMapReason::MapFailed).unwrap();
        assert_eq!(failed, r#""map_failed""#);
        let job = ListedJob {
            job_id: "x".into(),
            source: Source::Served,
            selection: None,
            created_at: None,
            points: None,
            levels: None,
            names: Names {
                by: NamedBy::Keywords,
                model: None,
            },
            current: true,
            map: None,
        };
        let plain = serde_json::to_string(&job).unwrap();
        assert!(!plain.contains("\"map\""), "{plain}");
        let job = ListedJob {
            map: Some(ListedMap {
                job_id: "y".into(),
                status: MapStatus::Pending,
            }),
            ..job
        };
        let text = serde_json::to_string(&job).unwrap();
        assert!(
            text.ends_with(r#""current":true,"map":{"job_id":"y","status":"pending"}}"#),
            "{text}"
        );
        assert_eq!(serde_json::from_str::<ListedJob>(&text).unwrap(), job);
        assert_eq!(HEADER_MADE_BY, "X-Polis-Topic-Map-Made-By");
    }

    #[test]
    fn each_comment_rule_names_its_own_scope() {
        assert_eq!(Selection::ParticipantVisible.scope("delphi"), "delphi");
        assert_eq!(
            Selection::AllComments.scope("delphi"),
            "delphi:all_comments"
        );
        assert_eq!(
            Selection::AllButModeratedOut.scope("delphi"),
            "delphi:all_but_moderated_out"
        );
        for s in [
            Selection::ParticipantVisible,
            Selection::AllComments,
            Selection::AllButModeratedOut,
        ] {
            assert_eq!(Selection::parse(s.word()), Some(s));
        }
        assert_eq!(Selection::parse("participant_visible/1"), None);
        assert_eq!(Source::parse("shadow"), Some(Source::Shadow));
        assert_eq!(Source::parse("Shadow"), None);
        // A query that names no source asks for the served side, then the
        // shadow's: it is not the same query as `source=served`.
        let bare = Request {
            report_id: Some("r".into()),
            ..Request::default()
        };
        assert_eq!(bare.source, None);
        let parsed: Request = serde_json::from_str(r#"{"report_id":"r"}"#).unwrap();
        assert_eq!(parsed, bare);
        let served: Request =
            serde_json::from_str(r#"{"report_id":"r","source":"served"}"#).unwrap();
        assert_eq!(served.source, Some(Source::Served));
        assert_ne!(served, bare);
    }

    #[test]
    fn the_document_is_closed_and_may_carry_its_provenance() {
        let doc = r##"{"schema":"polis-topic-map/1","title":"","attribution":"","run":{"jobId":"j","topicModel":null,"createdAt":"2026-11-11T02:48:21Z"},"bounds":[-1.5,1.5,-2.0,2.0],"pointRadius":0.11,"levels":[{"level":0,"topics":1,"unclustered":0,"cmapPalette":false}],"topics":[{"id":"0_0","level":0,"cluster":0,"key":"k","name":"0_0: n","count":3,"x":0.0,"y":0.5,"weight":1.31607,"parent":null,"parentShare":null,"color":"#dd6a94","labelColor":"#734252","colorAll":"#dd6a94","labelColorAll":"#734252"}],"points":{"id":[1,2,3],"x":[-1.0,0.0,1.0],"y":[0.0,1.0,0.5],"topic":[[0,0,0]],"text":[]}}"##;
        let parsed: TopicMap = serde_json::from_str(doc).unwrap();
        assert_eq!(parsed.schema, SCHEMA);
        assert!(parsed.points.text.is_empty());
        assert!(parsed.provenance.is_none());
        // Absent provenance is not written back.
        let written = serde_json::to_string(&parsed).unwrap();
        assert!(!written.contains("provenance"));
        let mut extra: serde_json::Value = serde_json::from_str(doc).unwrap();
        extra["points"]["label"] = serde_json::json!([]);
        assert!(serde_json::from_value::<TopicMap>(extra).is_err());
        let mut missing: serde_json::Value = serde_json::from_str(doc).unwrap();
        missing.as_object_mut().unwrap().remove("bounds");
        assert!(serde_json::from_value::<TopicMap>(missing).is_err());
        let mut with: serde_json::Value = serde_json::from_str(doc).unwrap();
        with["provenance"] = serde_json::json!({"selection": "participant_visible/1"});
        let parsed: TopicMap = serde_json::from_value(with).unwrap();
        assert_eq!(
            parsed.provenance.unwrap()["selection"],
            "participant_visible/1"
        );
    }

    /// A map stored before the provider existed, and one whose namer named
    /// Amazon Bedrock, both parse and are written back byte for byte; the old
    /// one names no provider, which reads as the default.
    #[test]
    fn a_provenance_with_or_without_the_namers_provider_round_trips_unchanged() {
        // Keys in sorted order, so the test holds whether or not serde_json
        // keeps insertion order.
        let doc = |extra: &str| {
            format!(
                r#"{{"schema":"polis-topic-map/1","title":"","attribution":"","run":{{"jobId":"j","topicModel":"claude-haiku-5-5","createdAt":null}},"bounds":[-1.5,1.5,-2.0,2.0],"pointRadius":0.11,"levels":[],"topics":[],"points":{{"id":[],"x":[],"y":[],"topic":[],"text":[]}},"provenance":{{"execution":{{"steps":[{{"layer":0,"model":"claude-haiku-5-5","namer":"n"{extra},"note":"topic_names","outcome":"named","prompt":"polis-topic-names/1","provider":"polis-topic-names","reason":null,"thinking":"default"}}]}},"models":{{"embed":"e","narrative":null,"topic":"claude-haiku-5-5"}},"schema":"polis-topic-map.provenance/1"}}}}"#
            )
        };
        let old = doc("");
        let new = doc(&format!(r#","{NAMER_PROVIDER}":"bedrock""#));
        for (doc, provider) in [(&old, None), (&new, Some("bedrock"))] {
            let parsed: TopicMap = serde_json::from_str(doc).unwrap();
            assert_eq!(&serde_json::to_string(&parsed).unwrap(), doc);
            let step = &parsed.provenance.unwrap()["execution"]["steps"][0];
            assert_eq!(step[NAMER_PROVIDER].as_str(), provider);
            assert_eq!(
                step[NAMER_PROVIDER]
                    .as_str()
                    .unwrap_or(DEFAULT_NAMER_PROVIDER),
                provider.unwrap_or("anthropic")
            );
        }
    }
}
