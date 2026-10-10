//! Versioned sealed-graph boundary. SQL is final authority for content binding.
use super::{
    child::Admission,
    manifest::{Invalid, Manifest, Outcome},
    sha256_hex,
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
pub fn admission(reply: &Value) -> Result<Admission> {
    ensure!(
        reply["schema_version"] == "polis-queue/5"
            && reply["graph_input"]["schema"] == "polis-job-input/1",
        "graph_input_schema"
    );
    let sha = reply["graph_input_sha"].as_str().unwrap_or_default();
    ensure!(
        sha.len() == 64 && sha.bytes().all(|c| c.is_ascii_hexdigit()),
        "graph_input_digest"
    );
    let wire = reply["graph_input_wire"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("graph_input_wire"))?;
    ensure!(
        sha256_hex(wire.as_bytes()) == sha
            && serde_json::from_str::<Value>(wire)? == reply["graph_input"],
        "graph_input_digest"
    );
    Ok(Admission {
        zid: reply["zid"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("graph_zid"))?,
        report_id: None,
        config: json!({"input_sha256":sha,"input_wire":wire}),
        inputs: reply["graph_input"].clone(),
    })
}
pub fn validate(
    bytes: Option<&[u8]>,
    job: &str,
    attempt: &str,
    stage: &str,
) -> Result<Manifest, Invalid> {
    let b = bytes.ok_or(Invalid::Missing)?;
    if b.len() > super::manifest::MAX_BYTES {
        return Err(Invalid::TooLarge);
    }
    let text = std::str::from_utf8(b).map_err(|_| Invalid::NotUtf8)?;
    let m: Value = serde_json::from_str(text).map_err(|_| Invalid::NotJson)?;
    let keys = [
        "schema",
        "job_id",
        "run_id",
        "attempt_id",
        "stage",
        "input_sha256",
        "outcome",
        "output",
    ];
    if m.as_object()
        .is_none_or(|o| o.len() != keys.len() || keys.iter().any(|k| !o.contains_key(*k)))
        || m["schema"] != "polis-job-artifact-manifest/1"
        || m["job_id"] != job
        || m["attempt_id"] != attempt
        || m["stage"] != stage
        || m["outcome"] != "succeeded"
        || m["output"]["role"] != "result"
        || m["output"]["schema"] != format!("{stage}/1")
        || m["output"]["payload"]
            .as_str()
            .is_none_or(|p| p.len() > 524288 || m["output"]["sha256"] != sha256_hex(p.as_bytes()))
    {
        return Err(Invalid::Field("graph_manifest"));
    }
    Ok(Manifest {
        text: text.into(),
        sha256: sha256_hex(b),
        outcome: Outcome::Succeeded,
        phase: "run".into(),
        recheck_after: None,
        batch_id: None,
        batch_ids: vec![],
        tokens_in: None,
        tokens_out: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolved_bytes_are_checked_before_dispatch() {
        let wire = r#"{"schema":"polis-job-input/1","declared":{},"artifacts":{}}"#;
        let mut r = json!({"schema_version":"polis-queue/5","graph_input":serde_json::from_str::<Value>(wire).unwrap_or_else(|e| panic!("{e}")),
            "graph_input_wire":wire,"graph_input_sha":sha256_hex(wire.as_bytes()),"zid":1});
        assert!(admission(&r).is_ok());
        r["graph_input"]["declared"] = json!({"tampered":true});
        assert!(admission(&r).is_err());
        r["schema_version"] = json!("polis-queue/3");
        assert!(admission(&r).is_err());
    }
    #[test]
    fn content_mismatch_and_legacy_receipts_refuse() {
        let mut m = json!({"schema":"polis-job-artifact-manifest/1","job_id":"j","run_id":"r","attempt_id":"a",
          "stage":"graph_embed","input_sha256":"0".repeat(64),"outcome":"succeeded",
          "output":{"role":"result","schema":"graph_embed/1","payload":"{}","sha256":sha256_hex(b"{}")}});
        assert!(validate(Some(m.to_string().as_bytes()), "j", "a", "graph_embed").is_ok());
        m["output"]["payload"] = json!("changed");
        assert!(validate(Some(m.to_string().as_bytes()), "j", "a", "graph_embed").is_err());
        m["schema"] = json!("polis-jobs.output-manifest/1");
        assert!(validate(Some(m.to_string().as_bytes()), "j", "a", "graph_embed").is_err());
    }
}
