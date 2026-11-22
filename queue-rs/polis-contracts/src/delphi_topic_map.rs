//! `GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id>]`: the topic map
//! of one Delphi run of a report's conversation, as the document
//! `polis-topic-map/1` that the generator `polis-topic-map` writes.
//!
//! A Rust-only route: Node has no handler for this path, so a request
//! polis-api hands back reaches Node's 404. It is as public as the report's
//! other Delphi reads (`GET /api/v3/delphi`, `/api/v3/delphi/reports` and
//! `/api/v3/delphi/visualizations` take no sign-in: knowing the report id is
//! what reads them), and its refusals keep their shapes.
//!
//! Every answer is one of the types below:
//!
//! - 200, [`TopicMap`]: the document of the run.
//! - 200, [`NoMap`]: the report exists and there is nothing to draw, with the
//!   reason from a closed set ([`NoMapReason`]); the neighbouring reads answer
//!   200 with an empty set for a conversation with no run.
//! - 400, 404, 404, 422, 503: the closed set of refusals ([`Refused`]).
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

/// The query: a report, and optionally one run of its conversation. Without
/// `job_id`, the run the conversation's Delphi results are served from.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub report_id: Option<String>,
    pub job_id: Option<String>,
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
}

/// The closed set of refusals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// 400: no `report_id`, or an empty one (as `/delphi/visualizations`).
    MissingReport,
    /// 404: no report with this id, or a report without a conversation (as
    /// `/delphi/visualizations` and `/api/v3/delphi`).
    UnknownReport(String),
    /// 404: `job_id` names no run of this report's conversation: not a
    /// canonical job id, no such run, or another conversation's run. One
    /// answer for all three (as `/delphi/runs/:job_id`).
    JobNotFound,
    /// 422: the run is larger than this route computes or serves. The map is
    /// refused, never truncated.
    TooLarge,
    /// 503 with `Retry-After: 1`: the route is full (another run's map is
    /// being read or computed and this one is not in memory, or all the
    /// route's connections are in use). Nothing was read for this run;
    /// asking again later is safe.
    Busy,
}

/// The code a too-large refusal carries as its message.
pub const TOO_LARGE: &str = "polis_err_topic_map_too_large";
/// The code a busy refusal carries as its message.
pub const BUSY: &str = "polis_err_topic_map_busy";
/// The seconds a busy refusal asks the client to wait.
pub const RETRY_AFTER: &str = "1";

impl Refused {
    pub fn status(&self) -> u16 {
        match self {
            Self::MissingReport => 400,
            Self::UnknownReport(_) | Self::JobNotFound => 404,
            Self::TooLarge => 422,
            Self::Busy => 503,
        }
    }
    pub fn body(&self) -> Refusal {
        let (message, report_id) = match self {
            Self::MissingReport => ("report_id is required", None),
            Self::UnknownReport(id) => (
                "Could not find conversation for report_id",
                Some(id.clone()),
            ),
            Self::JobNotFound => ("Job not found", None),
            Self::TooLarge => (TOO_LARGE, None),
            Self::Busy => (BUSY, None),
        };
        Refusal {
            status: Status::Error,
            message: message.into(),
            report_id,
        }
    }
}

/// Why a report that exists has no map to draw.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NoMapReason {
    /// The conversation serves no Delphi run (and no `job_id` was given).
    NoRun,
    /// The named run has not succeeded (queued, running, failed or cancelled).
    RunNotReady,
    /// The run stored no comment positions.
    NoPositions,
    /// The run stored no topics: no topic names, or no cluster layers.
    NoTopics,
    /// The first view has no area: always so for one or two comments, and
    /// when the comments it keeps (the 99.9% nearest the middle) sit on one
    /// point or one horizontal or vertical line.
    TooFewComments,
}

impl NoMapReason {
    pub fn message(self) -> &'static str {
        match self {
            Self::NoRun => "No Delphi run found for this report",
            Self::RunNotReady => "The Delphi run has not finished",
            Self::NoPositions => "The Delphi run stored no comment positions",
            Self::NoTopics => "The Delphi run stored no topics",
            Self::TooFewComments => "Too few comments to draw a topic map",
        }
    }
}

/// 200 without a map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NoMap {
    pub status: Success,
    pub message: String,
    pub report_id: String,
    /// The run considered; null when the conversation serves none.
    pub job_id: Option<String>,
    pub reason: NoMapReason,
}

impl NoMap {
    pub fn new(report_id: String, job_id: Option<String>, reason: NoMapReason) -> Self {
        Self {
            status: Success::Success,
            message: reason.message().into(),
            report_id,
            job_id,
            reason,
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
    pub id: Vec<i64>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// Per level: the index in `topics` of each comment's topic, or -1.
    pub topic: Vec<Vec<i64>>,
    /// Empty: this route carries no comment text.
    pub text: Vec<String>,
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
                Refused::TooLarge,
                422,
                r#"{"status":"error","message":"polis_err_topic_map_too_large"}"#,
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
    fn a_report_without_a_map_says_why_in_a_closed_set() {
        let body = NoMap::new("r1".into(), None, NoMapReason::NoRun);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"status":"success","message":"No Delphi run found for this report","report_id":"r1","job_id":null,"reason":"no_run"}"#
        );
        for (reason, code) in [
            (NoMapReason::RunNotReady, "run_not_ready"),
            (NoMapReason::NoPositions, "no_positions"),
            (NoMapReason::NoTopics, "no_topics"),
            (NoMapReason::TooFewComments, "too_few_comments"),
        ] {
            let body = NoMap::new("r1".into(), Some("j".into()), reason);
            let text = serde_json::to_string(&body).unwrap();
            assert!(text.contains(&format!(r#""reason":"{code}""#)), "{text}");
            assert_eq!(serde_json::from_str::<NoMap>(&text).unwrap(), body);
        }
        assert!(serde_json::from_str::<NoMapReason>(r#""too_large""#).is_err());
    }

    #[test]
    fn the_document_is_closed() {
        let doc = r##"{"schema":"polis-topic-map/1","title":"","attribution":"","run":{"jobId":"j","topicModel":null,"createdAt":"2026-11-11T02:48:21Z"},"bounds":[-1.5,1.5,-2.0,2.0],"pointRadius":0.11,"levels":[{"level":0,"topics":1,"unclustered":0,"cmapPalette":false}],"topics":[{"id":"0_0","level":0,"cluster":0,"key":"k","name":"0_0: n","count":3,"x":0.0,"y":0.5,"weight":1.31607,"parent":null,"parentShare":null,"color":"#dd6a94","labelColor":"#734252","colorAll":"#dd6a94","labelColorAll":"#734252"}],"points":{"id":[1,2,3],"x":[-1.0,0.0,1.0],"y":[0.0,1.0,0.5],"topic":[[0,0,0]],"text":[]}}"##;
        let parsed: TopicMap = serde_json::from_str(doc).unwrap();
        assert_eq!(parsed.schema, SCHEMA);
        assert!(parsed.points.text.is_empty());
        let mut extra: serde_json::Value = serde_json::from_str(doc).unwrap();
        extra["points"]["label"] = serde_json::json!([]);
        assert!(serde_json::from_value::<TopicMap>(extra).is_err());
        let mut missing: serde_json::Value = serde_json::from_str(doc).unwrap();
        missing.as_object_mut().unwrap().remove("bounds");
        assert!(serde_json::from_value::<TopicMap>(missing).is_err());
    }
}
