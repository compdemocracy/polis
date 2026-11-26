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
pub use namer::{Model, Namer, NamerError, PROMPT_VERSION, Provider, Thinking, Usage};

use serde::Serialize;
use std::collections::BTreeMap;

/// The `schema` string of `names.json`.
pub const NAMES_SCHEMA: &str = "polis-topic-names.names/1";
/// The environment variable the key is read from.
pub const KEY_ENV: &str = "DELPHI_NAMING_ANTHROPIC_API_KEY";
/// The environment variable the Bedrock region is read from.
pub const REGION_ENV: &str = "AWS_REGION";
/// The environment variable the per-run cap is read from.
pub const RUN_MAX_ENV: &str = "DELPHI_NAMING_RUN_MAX_USD";
/// The per-run cap when none is set.
pub const DEFAULT_RUN_MAX_USD: f64 = 0.50;
/// Version 1 names at most this many topics in its one call.
pub const MAX_TOPICS: usize = 400;
/// The most counted input tokens (the body's UTF-8 bytes) of a call.
pub const MAX_COUNTED_INPUT: u64 = 120_000;

/// How a naming ended. [`Outcome::word`] is what `names.json` records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Named,
    NoKey,
    /// Bedrock: no AWS credentials from the chain, or none that could sign.
    NoCredentials,
    /// Bedrock: `AWS_REGION` unset or not a region name.
    NoRegion,
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
            Self::NoCredentials => "no_credentials".into(),
            Self::NoRegion => "no_region".into(),
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
    /// Present only through Bedrock (`"bedrock"`), so the Claude API's file is
    /// the file it was before the provider existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<&'static str>,
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

/// What authenticates the call.
#[derive(Debug, Clone, Copy)]
pub enum Access<'a> {
    /// The Claude API key, when one is set.
    Key(Option<&'a str>),
    /// Amazon Bedrock: the region (when set) and where credentials come from.
    Bedrock {
        region: Option<&'a str>,
        credentials: &'a client::AwsCredentials,
    },
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
    name_topics_with(h, namer, Access::Key(key), cap, settings)
}

/// Names the hierarchy through the namer's provider. A Claude API namer
/// needs [`Access::Key`], a Bedrock namer [`Access::Bedrock`]; the other kind
/// is `no_key` or `no_credentials`, with no call made.
pub fn name_topics_with(
    h: &Hierarchy,
    namer: &Namer,
    access: Access<'_>,
    cap: RunCap,
    settings: &client::Settings,
) -> NamesFile {
    let body = prompt::body_v1(h, namer);
    let counted = body.len() as u64;
    let worst = namer.worst_case_usd(counted, prompt::MAX_TOKENS);
    let run = decide_and_call(
        h,
        namer.provider,
        access,
        cap,
        settings,
        &body,
        counted,
        worst,
    );
    let outcome = run.outcome.word();
    let dollars = run.usage.map(|u| namer.dollars(&u));
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
            provider: match namer.provider {
                Provider::Anthropic => None,
                Provider::Bedrock => Some(Provider::Bedrock.word()),
            },
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

#[allow(clippy::too_many_arguments)]
fn decide_and_call(
    h: &Hierarchy,
    provider: Provider,
    access: Access<'_>,
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
    let auth = match (provider, access) {
        (Provider::Anthropic, Access::Key(key)) => {
            let Some(key) = key.filter(|k| !k.is_empty()) else {
                return Run::failed(Outcome::NoKey, format!("{KEY_ENV} is not set"));
            };
            client::Auth::ApiKey(key)
        }
        (Provider::Anthropic, Access::Bedrock { .. }) => {
            return Run::failed(
                Outcome::NoKey,
                "a Claude API namer was given AWS credentials, not a key",
            );
        }
        (
            Provider::Bedrock,
            Access::Bedrock {
                region,
                credentials,
            },
        ) => {
            let Some(region) = region.map(str::trim).filter(|r| !r.is_empty()) else {
                return Run::failed(Outcome::NoRegion, format!("{REGION_ENV} is not set"));
            };
            if !client::valid_region(region) {
                return Run::failed(
                    Outcome::NoRegion,
                    format!("{REGION_ENV} is not a region name"),
                );
            }
            client::Auth::Bedrock {
                region,
                credentials,
            }
        }
        (Provider::Bedrock, Access::Key(_)) => {
            return Run::failed(
                Outcome::NoCredentials,
                "a Bedrock namer needs AWS credentials, not a key",
            );
        }
    };
    // An unsuccessful attempt may still have been billed. Reserve the same
    // estimate for both attempts before permitting a second request.
    let allow_retry = matches!(cap, RunCap::Usd(max) if worst <= max / 2.0);
    let call = client::call_with_auth(settings, auth, body, allow_retry);
    let mut run = match call.ended {
        client::Ended::Answered(bytes) => judge_reply(h, &bytes),
        client::Ended::Oversize => Run::failed(
            Outcome::BadJson,
            format!("the reply body is over {} bytes", client::MAX_REPLY_BYTES),
        ),
        client::Ended::Status(403) if provider == Provider::Bedrock => Run::failed(
            Outcome::Http(403),
            "Amazon Bedrock answered HTTP 403: model access not granted, or the role may not call bedrock-mantle:CreateInference",
        ),
        client::Ended::Status(s) => {
            Run::failed(Outcome::Http(s), format!("the provider answered HTTP {s}"))
        }
        client::Ended::NoCredentials => Run::failed(
            Outcome::NoCredentials,
            "no AWS credentials from the default credential chain",
        ),
        client::Ended::CannotSign => Run::failed(
            Outcome::NoCredentials,
            "the AWS credentials could not sign the request",
        ),
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
    let usage = match read_usage(&v) {
        Ok(u) => u,
        Err(()) => return Run::failed(Outcome::BadJson, "the reply's usage counts are not valid"),
    };
    // Only the provider's known stop words are kept; any other string, which
    // could be anything, is recorded as `unknown`.
    let stop =
        v.get("stop_reason")
            .and_then(|x| x.as_str())
            .map(|s| match s {
                "end_turn" | "refusal" | "max_tokens" | "stop_sequence" | "tool_use"
                | "pause_turn" => s.to_string(),
                _ => "unknown".to_string(),
            });
    let mut run = judge_message(h, &v, stop.as_deref());
    run.usage = usage;
    run.stop_reason = stop;
    run
}

/// The reply's usage: absent is `None`; present, it must be an object whose
/// four counts, each absent or a non-negative integer, have a prompt total
/// that fits in a `u64`.
fn read_usage(v: &serde_json::Value) -> Result<Option<Usage>, ()> {
    let Some(usage) = v.get("usage") else {
        return Ok(None);
    };
    let usage = usage.as_object().ok_or(())?;
    let count = |k: &str| match usage.get(k) {
        None => Ok(0),
        Some(x) => x.as_u64().ok_or(()),
    };
    let u = Usage {
        input_tokens: count("input_tokens")?,
        output_tokens: count("output_tokens")?,
        cache_creation_input_tokens: count("cache_creation_input_tokens")?,
        cache_read_input_tokens: count("cache_read_input_tokens")?,
    };
    u.input_tokens
        .checked_add(u.cache_creation_input_tokens)
        .and_then(|x| x.checked_add(u.cache_read_input_tokens))
        .ok_or(())?;
    Ok(Some(u))
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

#[cfg(test)]
mod tests {
    //! The reply parser over replies no provider should send: a few thousand
    //! random edits of a saved reply. Each must end as an outcome, and a marker
    //! planted anywhere but a name must never reach the result.
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::{Value, json};

    const MARKER: &str = "PLANTED-MARKER-7F3A";

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn base() -> (Hierarchy, Value) {
        let h = Hierarchy::from_json(include_str!("../tests/fixtures/hierarchies/vtaiwan.json"))
            .unwrap();
        let reply: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/replies/vtaiwan/sonnet-default-r1.json"
        ))
        .unwrap();
        (h, reply)
    }

    fn deep(depth: usize) -> Value {
        (0..depth).fold(json!(MARKER), |v, _| json!([v]))
    }

    fn evil(rng: &mut Rng) -> Value {
        match rng.below(12) {
            0 => json!(MARKER),
            1 => json!(MARKER.repeat(5_000)),
            2 => json!(format!("\u{0}{MARKER}\u{202E}\u{7}")),
            3 => json!(u64::MAX),
            4 => json!(-1),
            5 => json!(1.5),
            6 => Value::Null,
            7 => json!(true),
            8 => json!([MARKER]),
            9 => json!({ "k": MARKER }),
            10 => deep(200),
            _ => json!(format!("{MARKER}\u{d7ff}\u{10ffff}")),
        }
    }

    /// Every JSON pointer under `v`, skipping the paths `skip` refuses.
    fn paths(v: &Value, at: String, skip: &dyn Fn(&str) -> bool, out: &mut Vec<String>) {
        if skip(&at) {
            return;
        }
        out.push(at.clone());
        match v {
            Value::Object(m) => m
                .iter()
                .for_each(|(k, x)| paths(x, format!("{at}/{k}"), skip, out)),
            Value::Array(a) => a
                .iter()
                .enumerate()
                .for_each(|(i, x)| paths(x, format!("{at}/{i}"), skip, out)),
            _ => {}
        }
    }

    fn set(v: &mut Value, pointer: &str, to: Value) {
        if pointer.is_empty() {
            *v = to;
        } else if let Some(slot) = v.pointer_mut(pointer) {
            *slot = to;
        }
    }

    fn text_block(reply: &Value) -> usize {
        reply["content"]
            .as_array()
            .unwrap()
            .iter()
            .position(|b| b["type"] == "text")
            .unwrap()
    }

    /// One random reply body, and whether the marker was put inside a name
    /// (always with a control character or past 50 characters, though a later
    /// byte edit can make that name a valid one).
    fn mutate(rng: &mut Rng, reply: &Value) -> (Vec<u8>, bool) {
        let mut in_name = false;
        let mut r = reply.clone();
        let t = text_block(&r);
        let text_path = format!("/content/{t}/text");
        let mut inner: Value =
            serde_json::from_str(r.pointer(&text_path).unwrap().as_str().unwrap()).unwrap();
        for _ in 0..=rng.below(3) {
            match rng.below(3) {
                0 => {
                    let mut ps = Vec::new();
                    paths(&r, String::new(), &|p: &str| p == text_path, &mut ps);
                    let p = ps[rng.below(ps.len())].clone();
                    set(&mut r, &p, evil(rng));
                }
                1 => {
                    let mut ps = Vec::new();
                    let skip = |p: &str| p.starts_with("/topics/") && p.ends_with("/name");
                    paths(&inner, String::new(), &skip, &mut ps);
                    let p = ps[rng.below(ps.len())].clone();
                    set(&mut inner, &p, evil(rng));
                }
                _ => {
                    let n = inner["topics"].as_array().map_or(0, Vec::len);
                    if n > 0 {
                        in_name = true;
                        let bad = match rng.below(3) {
                            0 => format!("{MARKER}\u{7}"),
                            1 => format!("\u{202E}{MARKER}"),
                            _ => MARKER.repeat(3),
                        };
                        set(
                            &mut inner,
                            &format!("/topics/{}/name", rng.below(n)),
                            json!(bad),
                        );
                    }
                }
            }
        }
        if r.pointer(&text_path).is_some_and(Value::is_string) {
            set(&mut r, &text_path, json!(inner.to_string()));
        }
        let mut bytes = r.to_string().into_bytes();
        match rng.below(4) {
            0 if !bytes.is_empty() => {
                let i = rng.below(bytes.len());
                bytes[i] = (rng.next() & 0xff) as u8;
            }
            1 if !bytes.is_empty() => {
                let i = rng.below(bytes.len());
                bytes.truncate(i);
            }
            2 => {
                let i = rng.below(bytes.len() + 1);
                bytes.splice(i..i, [0xE4, 0xB8]);
            }
            _ => {}
        }
        (bytes, in_name)
    }

    fn assert_bounded(run: &Run, planted_in_name: bool) {
        let reason = run.reason.as_deref().unwrap_or("");
        assert!(!reason.contains(MARKER), "{reason}");
        assert!(reason.chars().count() <= 200, "{reason}");
        assert!(!reason.chars().any(char::is_control), "{reason:?}");
        if let Some(s) = &run.stop_reason {
            assert!(
                [
                    "end_turn",
                    "refusal",
                    "max_tokens",
                    "stop_sequence",
                    "tool_use",
                    "pause_turn",
                    "unknown"
                ]
                .contains(&s.as_str()),
                "{s}"
            );
        }
        if !planted_in_name {
            for n in run.names.values() {
                assert!(!n.contains(MARKER), "{n}");
            }
        }
        if run.outcome == Outcome::Named {
            for n in run.names.values() {
                let k = n.chars().count();
                assert!((1..=check::MAX_NAME_CHARS).contains(&k), "{n}");
                assert!(!check::has_control(n), "{n:?}");
            }
        }
    }

    #[test]
    fn random_edits_of_a_saved_reply_are_outcomes_that_copy_nothing() {
        let (h, reply) = base();
        assert_eq!(
            judge_reply(&h, reply.to_string().as_bytes()).outcome,
            Outcome::Named
        );
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut seen = BTreeMap::new();
        for _ in 0..3_000 {
            let (bytes, in_name) = mutate(&mut rng, &reply);
            let run = judge_reply(&h, &bytes);
            assert_bounded(&run, in_name);
            *seen.entry(run.outcome.word()).or_insert(0u32) += 1;
        }
        // The edits reach the parser's every refusal, not only its first.
        for word in ["bad_json", "bad_cover", "wrong_language", "bad_length"] {
            assert!(seen.contains_key(word), "{seen:?}");
        }
    }

    #[test]
    fn arbitrary_bytes_are_outcomes() {
        let (h, _) = base();
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        for _ in 0..2_000 {
            let n = rng.below(64);
            let bytes: Vec<u8> = (0..n).map(|_| (rng.next() & 0xff) as u8).collect();
            let run = judge_reply(&h, &bytes);
            assert_eq!(run.outcome, Outcome::BadJson);
            assert_bounded(&run, false);
        }
    }
}
