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
        && (s.ends_with('Z') || s.ends_with('z') || s[19..].contains('+') || s[19..].contains('-'))
}

fn object(v: &Value, name: &'static str) -> Result<(), Invalid> {
    if v.is_object() {
        Ok(())
    } else {
        Err(Invalid::Field(name))
    }
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
    object(&m, "root")?;
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
    let phase = m["phase"].as_str().ok_or(Invalid::Field("phase"))?;
    if !["run", "submit", "recheck"].contains(&phase) {
        return Err(Invalid::Field("phase"));
    }
    let outcome = match m["outcome"].as_str() {
        Some("succeeded") => Outcome::Succeeded,
        Some("parked") => Outcome::Parked,
        _ => return Err(Invalid::Field("outcome")),
    };
    object(&m["inputs"], "inputs")?;
    object(&m["models"], "models")?;
    object(&m["cost"], "cost")?;
    let outputs = m["outputs"].as_array().ok_or(Invalid::Field("outputs"))?;
    for o in outputs {
        let ok = o["store"] == "dynamodb"
            && o["table"].as_str().is_some_and(|t| !t.is_empty())
            && (o["keys"].is_array() || o["key_prefix"].is_object() || o["key_prefix"].is_string())
            && o["rows"].as_u64().is_some();
        if !ok {
            return Err(Invalid::Field("outputs"));
        }
    }
    // P1 is artifact-only: an artifacts list, if present, must be empty.
    if m.get("artifacts")
        .is_some_and(|a| a != &Value::Array(vec![]))
    {
        return Err(Invalid::Field("artifacts"));
    }
    let recheck_after = match &m["recheck_after"] {
        Value::Null => None,
        Value::String(s) if is_timestamp(s) => Some(s.clone()),
        _ => return Err(Invalid::Field("recheck_after")),
    };
    if outcome == Outcome::Parked && recheck_after.is_none() {
        return Err(Invalid::Field("recheck_after"));
    }
    if !m["duration_ms"].is_null() && m["duration_ms"].as_u64().is_none() {
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
