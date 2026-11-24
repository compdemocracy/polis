//! Names a Delphi run's topic hierarchy with one model call.
//!
//! [`name_topics`] takes a checked [`Hierarchy`], a [`Namer`], the key (if
//! any) and the per-run cap, and always returns a [`NamesFile`]: the names
//! when the model named every topic and the reply passed every check, and
//! otherwise the outcome word and its reason, so the caller keeps its keyword
//! names. Nothing here panics on a reply, retries more than once, or writes
//! anything but the file the caller asks for.

pub mod check;
pub mod client;
pub mod hierarchy;
pub mod namer;
pub mod prompt;

pub use hierarchy::{Hierarchy, HierarchyError, Topic};
pub use namer::{Model, Namer, NamerError, PROMPT_VERSION, Thinking, Usage};

use serde::Serialize;
use std::collections::BTreeMap;

/// The `schema` string of `names.json`.
pub const NAMES_SCHEMA: &str = "polis-topic-names.names/1";
/// The environment variable the key is read from.
pub const KEY_ENV: &str = "DELPHI_NAMING_ANTHROPIC_API_KEY";
/// The environment variable the per-run cap is read from.
pub const RUN_MAX_ENV: &str = "DELPHI_NAMING_RUN_MAX_USD";
/// The per-run cap when none is set.
pub const DEFAULT_RUN_MAX_USD: f64 = 0.50;
/// Version 1 names at most this many topics in its one call.
pub const MAX_TOPICS: usize = 400;
/// The most counted input tokens (the body's characters) of a call.
pub const MAX_COUNTED_INPUT: u64 = 120_000;

/// How a naming ended. [`Outcome::word`] is what `names.json` records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Named,
    NoKey,
    OverRunCap,
    TooLarge,
    Http(u16),
    Timeout,
    ConnectError,
    Refused,
    Truncated,
    BadJson,
    BadCover,
    WrongLanguage,
    BadLength,
    RepeatedNames,
}

impl Outcome {
    pub fn word(self) -> String {
        match self {
            Self::Named => "named".into(),
            Self::NoKey => "no_key".into(),
            Self::OverRunCap => "over_run_cap".into(),
            Self::TooLarge => "too_large".into(),
            Self::Http(s) => format!("http_{s}"),
            Self::Timeout => "timeout".into(),
            Self::ConnectError => "connect_error".into(),
            Self::Refused => "refused".into(),
            Self::Truncated => "truncated".into(),
            Self::BadJson => "bad_json".into(),
            Self::BadCover => "bad_cover".into(),
            Self::WrongLanguage => "wrong_language".into(),
            Self::BadLength => "bad_length".into(),
            Self::RepeatedNames => "repeated_names".into(),
        }
    }
}

/// The per-run cap as the environment gave it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RunCap {
    Usd(f64),
    /// Set, but not a non-negative number: no call is made.
    Unreadable,
}

impl RunCap {
    /// Reads the cap's setting: absent or empty is [`DEFAULT_RUN_MAX_USD`].
    pub fn from_setting(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            None | Some("") => Self::Usd(DEFAULT_RUN_MAX_USD),
            Some(v) => match v.parse::<f64>() {
                Ok(x) if x.is_finite() && x >= 0.0 => Self::Usd(x),
                _ => Self::Unreadable,
            },
        }
    }
}

/// The record of one naming, as `names.json` holds it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Record {
    pub model: &'static str,
    pub prompt: &'static str,
    pub thinking: &'static str,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub dollars: Option<f64>,
    pub namer: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub attempts: u32,
    pub http_status: Option<u16>,
    pub stop_reason: Option<String>,
    pub worst_case_usd: f64,
    pub run_max_usd: Option<f64>,
}

/// `names.json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NamesFile {
    pub schema: &'static str,
    pub outcome: String,
    pub reason: Option<String>,
    pub names: BTreeMap<String, String>,
    pub record: Record,
}

impl NamesFile {
    /// The file's text: pretty JSON, UTF-8, with a final newline.
    pub fn to_json(&self) -> String {
        let mut s = serde_json::to_string_pretty(self).unwrap_or_default();
        s.push('\n');
        s
    }
}

struct Run {
    outcome: Outcome,
    reason: Option<String>,
    names: BTreeMap<String, String>,
    usage: Option<Usage>,
    attempts: u32,
    http_status: Option<u16>,
    stop_reason: Option<String>,
}

impl Run {
    fn failed(outcome: Outcome, reason: impl Into<String>) -> Self {
        Self {
            outcome,
            reason: Some(reason.into()),
            names: BTreeMap::new(),
            usage: None,
            attempts: 0,
            http_status: None,
            stop_reason: None,
        }
    }
}

/// Names the hierarchy. `key` is the key's value when one is set and not
/// empty. Every way this can end is an outcome in the returned file.
pub fn name_topics(
    h: &Hierarchy,
    namer: &Namer,
    key: Option<&str>,
    cap: RunCap,
    settings: &client::Settings,
) -> NamesFile {
    let body = prompt::body_v1(h, namer);
    let counted = body.chars().count() as u64;
    let worst = namer.model.worst_case_usd(counted, prompt::MAX_TOKENS);
    let run = decide_and_call(h, key, cap, settings, &body, counted, worst);
    let outcome = run.outcome.word();
    let dollars = run.usage.map(|u| namer.model.dollars(&u));
    NamesFile {
        schema: NAMES_SCHEMA,
        outcome: outcome.clone(),
        reason: run.reason.clone(),
        names: if run.outcome == Outcome::Named {
            run.names
        } else {
            BTreeMap::new()
        },
        record: Record {
            model: namer.model.id(),
            prompt: PROMPT_VERSION,
            thinking: namer.thinking.word(),
            tokens_in: run.usage.map(|u| u.input_tokens),
            tokens_out: run.usage.map(|u| u.output_tokens),
            dollars,
            namer: namer.word(),
            outcome,
            reason: run.reason,
            attempts: run.attempts,
            http_status: run.http_status,
            stop_reason: run.stop_reason,
            worst_case_usd: worst,
            run_max_usd: match cap {
                RunCap::Usd(x) => Some(x),
                RunCap::Unreadable => None,
            },
        },
    }
}

fn decide_and_call(
    h: &Hierarchy,
    key: Option<&str>,
    cap: RunCap,
    settings: &client::Settings,
    body: &str,
    counted: u64,
    worst: f64,
) -> Run {
    if h.len() > MAX_TOPICS {
        return Run::failed(
            Outcome::TooLarge,
            format!(
                "{} topics; version 1 names at most {MAX_TOPICS} in one call",
                h.len()
            ),
        );
    }
    if counted > MAX_COUNTED_INPUT {
        return Run::failed(
            Outcome::TooLarge,
            format!("{counted} counted input tokens; at most {MAX_COUNTED_INPUT}"),
        );
    }
    match cap {
        RunCap::Unreadable => {
            return Run::failed(
                Outcome::OverRunCap,
                format!("{RUN_MAX_ENV} is not a non-negative number"),
            );
        }
        RunCap::Usd(max) if worst > max => {
            return Run::failed(
                Outcome::OverRunCap,
                format!("worst case ${worst:.4} is over the per-run cap ${max:.4}"),
            );
        }
        RunCap::Usd(_) => {}
    }
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return Run::failed(Outcome::NoKey, format!("{KEY_ENV} is not set"));
    };
    let call = client::call(settings, key, body);
    let mut run = match call.ended {
        client::Ended::Answered(bytes) => judge_reply(h, &bytes),
        client::Ended::Status(s) => {
            Run::failed(Outcome::Http(s), format!("the provider answered HTTP {s}"))
        }
        client::Ended::Timeout => {
            Run::failed(Outcome::Timeout, "no complete reply within the timeout")
        }
        client::Ended::Connect => {
            Run::failed(Outcome::ConnectError, "no connection to the provider")
        }
        client::Ended::BadKey => Run::failed(
            Outcome::NoKey,
            format!("{KEY_ENV} is not a valid header value"),
        ),
    };
    run.attempts = call.attempts;
    run.http_status = call.http_status;
    run
}

/// Judges an HTTP 200 reply body.
fn judge_reply(h: &Hierarchy, bytes: &[u8]) -> Run {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return Run::failed(Outcome::BadJson, "the reply body is not JSON"),
    };
    let u = |k: &str| {
        v.get("usage")
            .and_then(|x| x.get(k))
            .and_then(|x| x.as_u64())
            .unwrap_or(0)
    };
    let usage = v.get("usage").map(|_| Usage {
        input_tokens: u("input_tokens"),
        output_tokens: u("output_tokens"),
        cache_creation_input_tokens: u("cache_creation_input_tokens"),
        cache_read_input_tokens: u("cache_read_input_tokens"),
    });
    let stop = v
        .get("stop_reason")
        .and_then(|x| x.as_str())
        .map(String::from);
    let mut run = judge_message(h, &v, stop.as_deref());
    run.usage = usage;
    run.stop_reason = stop;
    run
}

fn judge_message(h: &Hierarchy, v: &serde_json::Value, stop: Option<&str>) -> Run {
    match stop {
        Some("end_turn") => {}
        Some("refusal") => return Run::failed(Outcome::Refused, "the model refused"),
        Some("max_tokens") => {
            return Run::failed(Outcome::Truncated, "the reply was cut off at max_tokens");
        }
        Some(other) => return Run::failed(Outcome::BadJson, format!("stop reason {other}")),
        None => return Run::failed(Outcome::BadJson, "the reply has no stop reason"),
    }
    let text: String = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let raw = match check::parse_and_cover(h, &text) {
        check::Parsed::BadJson(why) => return Run::failed(Outcome::BadJson, why),
        check::Parsed::BadCover {
            missing,
            unknown,
            repeated,
        } => {
            return Run::failed(
                Outcome::BadCover,
                format!("{missing} topics missing, {unknown} unknown ids, {repeated} repeated ids"),
            );
        }
        check::Parsed::Covered(raw) => raw,
    };
    let names: BTreeMap<String, String> = raw
        .into_iter()
        .map(|(id, n)| (id, check::clean(&n).unwrap_or_default()))
        .collect();
    if let Err(why) = check::check_language(h, &names) {
        return Run::failed(Outcome::WrongLanguage, why);
    }
    if let Err(why) = check::check_length(&names) {
        return Run::failed(Outcome::BadLength, why);
    }
    if let Err(why) = check::check_repeats(h, &names) {
        return Run::failed(Outcome::RepeatedNames, why);
    }
    Run {
        outcome: Outcome::Named,
        reason: None,
        names,
        usage: None,
        attempts: 0,
        http_status: None,
        stop_reason: None,
    }
}
