//! The output manifest (`schemas/output-manifest-v1.json`): the one thing the
//! child publishes. The daemon validates it, hashes the exact file bytes, and
//! inserts those bytes unchanged as the attempt's `stream='manifest'` log row
//! (the row the seven-argument `pq_finalize` matches the sha256 against).
use serde_json::Value;

pub const SCHEMA: &str = "polis-jobs.output-manifest/1";
/// `polis_queue_logs.line` CHECK: at most 1 MiB.
pub const MAX_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Parked,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    /// The exact file bytes, never reserialized.
    pub text: String,
    pub sha256: String,
    pub outcome: Outcome,
    pub phase: String,
    pub recheck_after: Option<String>,
    /// First provider batch id named under `cost.provider_batches`.
    pub batch_id: Option<String>,
    /// Every provider batch id, in manifest order.
    pub batch_ids: Vec<String>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Invalid {
    Missing,
    TooLarge,
    NotUtf8,
    Nul,
    NotJson,
    Field(&'static str),
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Field(name) => write!(f, "manifest field {name}"),
            other => write!(f, "manifest {other:?}"),
        }
    }
}

fn is_timestamp(s: &str) -> bool {
    // RFC 3339 date-time with an explicit offset, e.g. 2026-10-03T12:00:00Z.
    let b = s.as_bytes();
    b.len() >= 20
        && b.len() <= 40
        && b[4] == b'-'
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b't')
        && b[13] == b':'
        && b[16] == b':'
        && b[..4].iter().all(u8::is_ascii_digit)
        && (s.ends_with('Z')
            || s.ends_with('z')
            || s.get(19..)
                .is_some_and(|t| t.contains('+') || t.contains('-')))
}

const ROOT_KEYS: [&str; 12] = [
    "schema",
    "job_id",
    "attempt_id",
    "stage",
    "phase",
    "outcome",
    "inputs",
    "outputs",
    "models",
    "cost",
    "recheck_after",
    "duration_ms",
];
const INPUT_KEYS: [&str; 5] = [
    "math_env",
    "math_tick",
    "math_caching_tick",
    "comment_set_sha256",
    "vote_hwm",
];
const MODEL_KEYS: [&str; 3] = ["embed", "topic", "narrative"];
const COST_KEYS: [&str; 3] = ["llm_tokens_in", "llm_tokens_out", "provider_batches"];

/// The object's key set is exactly `keys`: required keys present, unknown
/// keys refused (the schema's `additionalProperties: false`).
fn closed(
    o: &serde_json::Map<String, Value>,
    keys: &[&str],
    name: &'static str,
) -> Result<(), Invalid> {
    if o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)) {
        Ok(())
    } else {
        Err(Invalid::Field(name))
    }
}

fn nullable_str(v: &Value, name: &'static str) -> Result<(), Invalid> {
    if v.is_null() || v.is_string() {
        Ok(())
    } else {
        Err(Invalid::Field(name))
    }
}

/// null or a JSON integer (not a float, string or boolean).
fn nullable_int(v: &Value, name: &'static str) -> Result<(), Invalid> {
    if v.is_null() || v.is_i64() || v.is_u64() {
        Ok(())
    } else {
        Err(Invalid::Field(name))
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Validate exact manifest bytes for this attempt.
pub fn validate(
    bytes: Option<&[u8]>,
    job_id: &str,
    attempt_id: &str,
    stage: &str,
) -> Result<Manifest, Invalid> {
    let bytes = bytes.ok_or(Invalid::Missing)?;
    if bytes.len() > MAX_BYTES {
        return Err(Invalid::TooLarge);
    }
    if bytes.contains(&0) {
        return Err(Invalid::Nul);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Invalid::NotUtf8)?;
    let m: Value = serde_json::from_str(text).map_err(|_| Invalid::NotJson)?;
    let root = m.as_object().ok_or(Invalid::Field("root"))?;
    closed(root, &ROOT_KEYS, "root")?;
    if m["schema"] != SCHEMA {
        return Err(Invalid::Field("schema"));
    }
    if m["job_id"] != job_id {
        return Err(Invalid::Field("job_id"));
    }
    if m["attempt_id"] != attempt_id {
        return Err(Invalid::Field("attempt_id"));
    }
    if m["stage"] != stage {
        return Err(Invalid::Field("stage"));
    }
    // SQL finalize needs a phase; the schema's null phase cannot finalize.
    let phase = m["phase"].as_str().ok_or(Invalid::Field("phase"))?;
    if !["run", "submit", "recheck"].contains(&phase) {
        return Err(Invalid::Field("phase"));
    }
    let outcome = match m["outcome"].as_str() {
        Some("succeeded") => Outcome::Succeeded,
        Some("parked") => Outcome::Parked,
        _ => return Err(Invalid::Field("outcome")),
    };
    // inputs: every provenance key present; null means "unknown", a wrong
    // type or a missing key is invalid.
    let inputs = m["inputs"].as_object().ok_or(Invalid::Field("inputs"))?;
    closed(inputs, &INPUT_KEYS, "inputs")?;
    nullable_str(&inputs["math_env"], "inputs.math_env")?;
    for (key, name) in [
        ("math_tick", "inputs.math_tick"),
        ("math_caching_tick", "inputs.math_caching_tick"),
        ("vote_hwm", "inputs.vote_hwm"),
    ] {
        nullable_int(&inputs[key], name)?;
    }
    match &inputs["comment_set_sha256"] {
        Value::Null => {}
        Value::String(h) if is_hex64(h) => {}
        _ => return Err(Invalid::Field("inputs.comment_set_sha256")),
    }
    let outputs = m["outputs"].as_array().ok_or(Invalid::Field("outputs"))?;
    for o in outputs {
        let o = o.as_object().ok_or(Invalid::Field("outputs"))?;
        let partitions: Vec<&Value> = match (o.get("key_prefix"), o.get("keys")) {
            (Some(p), None) => {
                closed(
                    o,
                    &["store", "family", "table", "rows", "key_prefix"],
                    "outputs",
                )?;
                vec![p]
            }
            (None, Some(Value::Array(ks))) => {
                closed(o, &["store", "family", "table", "rows", "keys"], "outputs")?;
                ks.iter().collect()
            }
            _ => return Err(Invalid::Field("outputs")),
        };
        let ok = o["store"] == "dynamodb"
            && o["family"].as_str().is_some_and(|t| !t.is_empty())
            && o["table"].as_str().is_some_and(|t| !t.is_empty())
            && o["rows"].as_u64().is_some()
            && partitions.iter().all(|p| {
                p.as_object()
                    .is_some_and(|p| !p.is_empty() && p.values().all(Value::is_string))
            });
        if !ok {
            return Err(Invalid::Field("outputs"));
        }
    }
    let models = m["models"].as_object().ok_or(Invalid::Field("models"))?;
    closed(models, &MODEL_KEYS, "models")?;
    for key in MODEL_KEYS {
        nullable_str(&models[key], "models")?;
    }
    let cost = m["cost"].as_object().ok_or(Invalid::Field("cost"))?;
    closed(cost, &COST_KEYS, "cost")?;
    nullable_int(&cost["llm_tokens_in"], "cost.llm_tokens_in")?;
    nullable_int(&cost["llm_tokens_out"], "cost.llm_tokens_out")?;
    match &cost["provider_batches"] {
        Value::Null => {}
        Value::Array(list) => {
            for b in list {
                let b = b
                    .as_object()
                    .ok_or(Invalid::Field("cost.provider_batches"))?;
                closed(
                    b,
                    &["provider", "batch_id", "submitted_at"],
                    "cost.provider_batches",
                )?;
                if !b
                    .values()
                    .all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                {
                    return Err(Invalid::Field("cost.provider_batches"));
                }
            }
        }
        _ => return Err(Invalid::Field("cost.provider_batches")),
    }
    let recheck_after = match &m["recheck_after"] {
        Value::Null => None,
        Value::String(s) if is_timestamp(s) => Some(s.clone()),
        _ => return Err(Invalid::Field("recheck_after")),
    };
    // Set exactly when the outcome is parked.
    if (outcome == Outcome::Parked) != recheck_after.is_some() {
        return Err(Invalid::Field("recheck_after"));
    }
    if m["duration_ms"].as_u64().is_none() {
        return Err(Invalid::Field("duration_ms"));
    }
    let batches = &m["cost"]["provider_batches"];
    if !batches.is_null() && !batches.is_array() {
        return Err(Invalid::Field("cost.provider_batches"));
    }
    let batch_id = batches
        .as_array()
        .and_then(|b| b.first())
        .and_then(|b| b["batch_id"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let batch_ids: Vec<String> = batches
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["batch_id"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(Manifest {
        batch_ids,
        text: text.to_owned(),
        sha256: super::sha256_hex(bytes),
        outcome,
        phase: phase.to_owned(),
        recheck_after,
        batch_id,
        tokens_in: m["cost"]["llm_tokens_in"].as_u64(),
        tokens_out: m["cost"]["llm_tokens_out"].as_u64(),
    })
}

#[cfg(test)]
pub(crate) fn fixture(job: &str, attempt: &str, stage: &str, outcome: &str) -> Value {
    serde_json::json!({
        "schema": SCHEMA, "job_id": job, "attempt_id": attempt, "stage": stage,
        "phase": if stage == "delphi_narrative" { "submit" } else { "run" },
        "outcome": outcome,
        "inputs": {"math_env": "dev", "math_tick": 7, "math_caching_tick": 7,
                    "comment_set_sha256": "0".repeat(64), "vote_hwm": 12},
        "outputs": [{"store": "dynamodb", "family": "Delphi_UMAPGraph", "table": "Delphi_UMAPGraph",
                     "key_prefix": {"conversation_id": "1"}, "rows": 3}],
        "models": {"embed": "fixture-embed", "topic": null, "narrative": null},
        "cost": {"llm_tokens_in": 0, "llm_tokens_out": 0,
                 "provider_batches": if outcome == "parked" {
                    serde_json::json!([{"provider": "anthropic", "batch_id": "batch-1", "submitted_at": "2026-10-03T00:00:00Z"}])
                 } else { serde_json::json!([]) }},
        "recheck_after": if outcome == "parked" { Value::from("2026-10-03T00:10:00Z") } else { Value::Null },
        "duration_ms": 1200
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const J: &str = "00000000-0000-4000-8000-000000000001";
    const A: &str = "00000000-0000-4000-8000-000000000002";

    fn check(v: &Value) -> Result<Manifest, Invalid> {
        let bytes = serde_json::to_vec(v).unwrap_or_default();
        validate(Some(&bytes), J, A, "delphi_full_pipeline")
    }

    #[test]
    fn valid_manifest_keeps_exact_bytes_and_hash() {
        let bytes = b"{\"schema\": \"polis-jobs.output-manifest/1\" }";
        // Not valid (fields missing), but hashing is over the exact bytes:
        assert!(validate(Some(bytes), J, A, "delphi_full_pipeline").is_err());
        let v = fixture(J, A, "delphi_full_pipeline", "succeeded");
        let pretty = serde_json::to_string_pretty(&v).unwrap_or_default();
        let m = validate(Some(pretty.as_bytes()), J, A, "delphi_full_pipeline");
        let m = m.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.text, pretty);
        assert_eq!(m.sha256, crate::jobs::sha256_hex(pretty.as_bytes()));
        assert_eq!(m.outcome, Outcome::Succeeded);
    }

    #[test]
    fn missing_wrong_schema_and_oversized_are_refused() {
        assert_eq!(
            validate(None, J, A, "delphi_full_pipeline").err(),
            Some(Invalid::Missing)
        );
        let mut v = fixture(J, A, "delphi_full_pipeline", "succeeded");
        v["schema"] = "polis-jobs.output-manifest/2".into();
        assert_eq!(check(&v).err(), Some(Invalid::Field("schema")));
        let big = vec![b' '; MAX_BYTES + 1];
        assert_eq!(
            validate(Some(&big), J, A, "delphi_full_pipeline").err(),
            Some(Invalid::TooLarge)
        );
        assert_eq!(
            validate(Some(b"{\"a\":\"\0\"}"), J, A, "x").err(),
            Some(Invalid::Nul)
        );
        assert_eq!(
            validate(Some(&[0xff, 0xfe]), J, A, "x").err(),
            Some(Invalid::NotUtf8)
        );
    }

    #[test]
    fn identity_and_shape_must_match_the_attempt() {
        let v = fixture(J, A, "delphi_full_pipeline", "succeeded");
        for (key, value) in [
            ("job_id", Value::from(A)),
            ("attempt_id", Value::from(J)),
            ("stage", Value::from("delphi_narrative")),
            ("phase", Value::from("finish")),
            ("outcome", Value::from("failed")),
            (
                "outputs",
                serde_json::json!([{"store": "s3", "table": "t", "keys": [], "rows": 1}]),
            ),
            ("artifacts", serde_json::json!(["x"])),
            ("recheck_after", Value::from("tomorrow")),
        ] {
            let mut bad = v.clone();
            bad[key] = value;
            assert!(check(&bad).is_err(), "{key}");
        }
    }

    #[test]
    fn malformed_recheck_after_is_invalid_not_a_panic() {
        let mut v = fixture(J, A, "delphi_full_pipeline", "parked");
        for bad in [
            "2026-10-03T12:00:0é+00:00",
            "2026-10-03T12:00:00é",
            "éééééééééééé",
        ] {
            v["recheck_after"] = bad.into();
            assert_eq!(
                check(&v).err(),
                Some(Invalid::Field("recheck_after")),
                "{bad}"
            );
        }
    }

    #[test]
    fn schema_complete_refusals_include_the_second_review_witnesses() {
        let good = fixture(J, A, "delphi_full_pipeline", "succeeded");
        assert!(check(&good).is_ok());
        type Mutation = fn(&mut Value);
        let cases: Vec<(&str, Mutation)> = vec![
            ("empty inputs", |m| m["inputs"] = serde_json::json!({})),
            ("non-numeric math_tick", |m| {
                m["inputs"]["math_tick"] = "unusable".into()
            }),
            ("empty models", |m| m["models"] = serde_json::json!({})),
            ("missing duration_ms", |m| {
                m.as_object_mut().map(|o| o.remove("duration_ms"));
            }),
            ("undeclared root key", |m| m["unexpected"] = true.into()),
            ("missing inputs key", |m| {
                m["inputs"].as_object_mut().map(|o| o.remove("vote_hwm"));
            }),
            ("float tick", |m| {
                m["inputs"]["math_caching_tick"] = 3.5.into()
            }),
            ("bad comment digest", |m| {
                m["inputs"]["comment_set_sha256"] = "ABC".into()
            }),
            ("extra inputs key", |m| m["inputs"]["extra"] = 1.into()),
            ("model not a string", |m| m["models"]["embed"] = 1.into()),
            ("missing cost key", |m| {
                m["cost"].as_object_mut().map(|o| o.remove("llm_tokens_in"));
            }),
            ("string tokens", |m| {
                m["cost"]["llm_tokens_out"] = "20".into()
            }),
            (
                "batch extra key",
                |m| m["cost"]["provider_batches"] = serde_json::json!([{"provider": "a", "batch_id": "b", "submitted_at": "c", "x": 1}]),
            ),
            ("output without family", |m| {
                m["outputs"][0].as_object_mut().map(|o| o.remove("family"));
            }),
            ("output with keys and key_prefix", |m| {
                m["outputs"][0]["keys"] = serde_json::json!([])
            }),
            ("output extra key", |m| m["outputs"][0]["extra"] = 1.into()),
            ("empty partition", |m| {
                m["outputs"][0]["key_prefix"] = serde_json::json!({})
            }),
            ("negative rows", |m| m["outputs"][0]["rows"] = (-1).into()),
            ("null duration", |m| m["duration_ms"] = Value::Null),
            ("recheck_after on success", |m| {
                m["recheck_after"] = "2026-10-03T00:10:00Z".into()
            }),
            ("artifacts", |m| m["artifacts"] = serde_json::json!([])),
        ];
        for (name, mutate) in cases {
            let mut m = good.clone();
            mutate(&mut m);
            assert!(check(&m).is_err(), "{name} must be refused");
        }
        // Explicit nulls stay allowed where the contract permits unknowns.
        let mut m = good.clone();
        for k in [
            "math_env",
            "math_tick",
            "math_caching_tick",
            "comment_set_sha256",
            "vote_hwm",
        ] {
            m["inputs"][k] = Value::Null;
        }
        m["models"]["embed"] = Value::Null;
        m["cost"] = serde_json::json!({"llm_tokens_in": null, "llm_tokens_out": null, "provider_batches": null});
        assert!(check(&m).is_ok());
    }

    #[test]
    fn parked_needs_recheck_after() {
        let v = fixture(J, A, "delphi_full_pipeline", "parked");
        let m = check(&v).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.outcome, Outcome::Parked);
        assert_eq!(m.batch_id.as_deref(), Some("batch-1"));
        let mut bad = v.clone();
        bad["recheck_after"] = Value::Null;
        assert!(check(&bad).is_err());
        // The 803 checker parks while a batch runs; it may name no new batch.
        let mut ok = v;
        ok["cost"]["provider_batches"] = Value::Null;
        assert!(check(&ok).is_ok());
    }
}
