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

/// Hydrate only immutable, digest-bound result bytes; queue credentials stay in daemon.
/// With the embeddings table on, graph_cluster reads its set as a spool file the
/// frame points at (digest-checked), and graph_embed is handed the prior served
/// set so it re-embeds only the comments missing from it. Both leave the flag-off
/// codec-family path exactly as it was.
pub fn hydrate(
    rpc: &mut super::rpc::Rpc,
    frame: &mut Value,
    directory: &std::path::Path,
    embeddings_table: bool,
) -> Result<()> {
    if frame["stage"] == "graph_cluster"
        && frame["input"]["declared"]["model"] == "delphi-umap-evoc/1"
    {
        return hydrate_cluster(rpc, frame, directory, embeddings_table);
    }
    if embeddings_table && frame["stage"] == "graph_embed" {
        return hydrate_embed_prior(rpc, frame, directory);
    }
    Ok(())
}

fn hydrate_cluster(
    rpc: &mut super::rpc::Rpc,
    frame: &mut Value,
    directory: &std::path::Path,
    embeddings_table: bool,
) -> Result<()> {
    let artifact = frame["input"]["artifacts"]["embeddings"].clone();
    let payload: Value = serde_json::from_str(artifact["payload"].as_str().unwrap_or_default())?;
    if payload.get("family_files").is_some() {
        return Ok(());
    }
    if embeddings_table {
        // The embeddings live in delphi_comment_embeddings, reached through the
        // producing artifact. Resolve the set, stream it out, write a spool file.
        let receipt = rpc.committed(
            "pd_embedding_set",
            &[
                frame["env"].clone(),
                artifact["artifact_id"].clone(),
                json!(super::embedding::MODEL_MINILM),
            ],
        )?;
        ensure!(!receipt.is_null(), "embedding_set_missing");
        frame["embedding_spool"] = hydrate_set(rpc, &receipt, directory, "embeddings.set.spool")?;
        return Ok(());
    }
    let family = "Delphi_CommentEmbeddings";
    let reply = rpc.committed(
        "pd_result_artifact_wire",
        &[
            frame["env"].clone(),
            artifact["artifact_id"].clone(),
            json!(family),
        ],
    )?;
    let wire = reply["wire"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("result_wire_missing"))?;
    ensure!(
        wire.len() <= 67_108_864
            && reply["sha256"] == sha256_hex(wire.as_bytes())
            && reply["batch_id"] == payload["results"]["batch_id"]
            && reply["batch_sha256"] == payload["results"]["sha256"],
        "result_wire_binding"
    );
    frame["result_families"] = json!({"embeddings": {family: wire}});
    Ok(())
}

/// Hand graph_embed the conversation's currently served embedding set (if any)
/// so it only computes vectors for comments not already stored. Absent set, or
/// the conversation's first run: nothing is injected and graph_embed embeds all.
fn hydrate_embed_prior(
    rpc: &mut super::rpc::Rpc,
    frame: &mut Value,
    directory: &std::path::Path,
) -> Result<()> {
    let view = rpc.committed(
        "pd_job_view",
        &[frame["env"].clone(), frame["job_id"].clone()],
    )?;
    let Some(scope) = view["scope_key"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let receipt = rpc.committed(
        "pd_embedding_served",
        &[
            frame["env"].clone(),
            frame["zid"].clone(),
            json!(scope),
            json!(super::embedding::MODEL_MINILM),
        ],
    )?;
    if receipt.is_null() || receipt["batch_id"].is_null() {
        return Ok(());
    }
    frame["embedding_prior"] = hydrate_set(rpc, &receipt, directory, "embeddings.prior.spool")?;
    Ok(())
}

/// Stream one closed set out by binary COPY, check it against the set receipt's
/// digest, row count and dimensions, and rewrite it as a spool file for the
/// child. Returns the frame descriptor `{file, sha256, model, dims, rows}`.
fn hydrate_set(
    rpc: &mut super::rpc::Rpc,
    receipt: &Value,
    directory: &std::path::Path,
    filename: &str,
) -> Result<Value> {
    let batch = receipt["batch_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("embedding_set_batch"))?;
    let model = receipt["model"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("embedding_set_model"))?;
    let dims = u16::try_from(
        receipt["dims"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("embedding_set_dims"))?,
    )?;
    let row_count = receipt["row_count"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("embedding_set_rows"))?;
    let bytes = rpc.embedding_copy(batch, model)?;
    let set = super::embedding::set_from_copy_binary(&bytes, model, dims)?;
    ensure!(
        set.rows.len() as u64 == row_count && receipt["sha256"] == set.content_sha,
        "embedding_set_digest"
    );
    let spool = super::embedding::write_spool(model, dims, &set.rows)?;
    std::fs::create_dir_all(directory)?;
    let temporary = directory.join(format!("{filename}.tmp"));
    std::fs::write(&temporary, &spool)?;
    std::fs::rename(temporary, directory.join(filename))?;
    Ok(json!({
        "file": filename,
        "sha256": sha256_hex(&spool),
        "model": model,
        "dims": dims,
        "rows": row_count,
    }))
}

/// Route one embeddings spool the child wrote into the per-row table: chunked
/// `pd_embedding_put`, then `pd_embedding_close`, both before `pd_result_seal`.
/// The spool is a bounded regular file whose sha256 the manifest pins.
fn stage_embeddings(
    rpc: &mut super::rpc::Rpc,
    claim: &super::child::Claim,
    directory: &std::path::Path,
    descriptor: &Value,
) -> Result<()> {
    ensure!(
        descriptor["file"] == "embeddings.spool",
        "embedding_spool_path"
    );
    let bytes = super::manifest::read_regular_file(
        &directory.join("embeddings.spool"),
        super::embedding::MAX_SPOOL_BYTES,
    )
    .map_err(|error| anyhow::anyhow!("embedding_spool_file:{error}"))?;
    ensure!(
        descriptor["sha256"] == sha256_hex(&bytes),
        "embedding_spool_digest"
    );
    let (model, dims, rows) = super::embedding::read_spool(&bytes)?;
    ensure!(
        descriptor["model"] == model.as_str()
            && descriptor["dims"] == dims
            && descriptor["rows"].as_u64() == Some(rows.len() as u64),
        "embedding_spool_descriptor"
    );
    let identity = super::task::identity(claim);
    for chunk in rows.chunks(super::embedding::PUT_CHUNK) {
        let tids: Vec<i32> = chunk.iter().map(|r| r.tid).collect();
        let shas: Vec<&[u8]> = chunk.iter().map(|r| r.text_sha.as_slice()).collect();
        let matrix: Vec<f32> = chunk
            .iter()
            .flat_map(|r| r.vector.iter().copied())
            .collect();
        let reply = rpc.embedding_put(&identity, &model, &tids, &shas, dims as usize, &matrix)?;
        ensure!(
            reply["rows"].as_u64() == Some(chunk.len() as u64),
            "embedding_put_receipt"
        );
    }
    let mut close = identity;
    close.push(json!(model));
    let receipt = rpc.committed("pd_embedding_close", &close)?;
    ensure!(
        receipt["schema"] == "delphi-embedding-set/1" && receipt["batch_id"] == claim.attempt_id,
        "embedding_close_receipt"
    );
    Ok(())
}

/// Read only a bounded regular spool file; a FIFO must never block the daemon.
fn read_family_spool(
    directory: &std::path::Path,
    family: &str,
    value: &Value,
    total: &mut u64,
) -> Result<String> {
    ensure!(
        !family.is_empty()
            && family
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_'),
        "result_family_name"
    );
    let filename = format!("{family}.jsonl");
    ensure!(value["file"] == filename, "result_spool_path");
    let bytes = super::manifest::read_regular_file(&directory.join(filename), 67_108_864)
        .map_err(|error| anyhow::anyhow!("result_spool_file:{error}"))?;
    let wire = String::from_utf8(bytes)?;
    let next_total = total
        .checked_add(wire.len() as u64)
        .ok_or_else(|| anyhow::anyhow!("result_spool_bound"))?;
    ensure!(next_total <= 268_435_456, "result_spool_bound");
    ensure!(
        value["sha256"] == sha256_hex(wire.as_bytes()),
        "result_spool_digest"
    );
    *total = next_total;
    Ok(wire)
}

/// Persist detached family bytes after process exit and before artifact finalize.
/// The daemon creates the final manifest linking the attempt's sealed batch.
pub fn stage_results(
    rpc: &mut super::rpc::Rpc,
    claim: &super::child::Claim,
    directory: &std::path::Path,
    manifest: Manifest,
    embeddings_table: bool,
) -> Result<Manifest> {
    let mut document: Value = serde_json::from_str(&manifest.text)?;
    let mut payload: Value =
        serde_json::from_str(document["output"]["payload"].as_str().unwrap_or_default())?;
    let Some(spool) = payload.get("family_spool") else {
        return Ok(manifest);
    };
    // With the flag on, graph_embed routes embeddings to the table and leaves no
    // codec family, so an otherwise-empty family spool is expected then (only).
    let embedding_spool = if embeddings_table {
        payload.get("embedding_spool").cloned()
    } else {
        None
    };
    let files = spool
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("result_spool_shape"))?;
    ensure!(
        (embedding_spool.is_some() || !files.is_empty()) && files.len() <= 18,
        "result_spool_count"
    );
    let mut total = 0_u64;
    for (family, value) in files {
        let wire = read_family_spool(directory, family, value, &mut total)?;
        let mut args = super::task::identity(claim);
        args.extend([json!(family), json!(wire)]);
        let reply = rpc.committed("pd_result_put_family", &args)?;
        ensure!(reply["sha256"] == value["sha256"], "result_stage_receipt");
    }
    if let Some(descriptor) = &embedding_spool {
        stage_embeddings(rpc, claim, directory, descriptor)?;
    }
    let results = rpc.committed("pd_result_seal", &super::task::identity(claim))?;
    ensure!(
        results["schema"] == "delphi-result-batch/1" && results["batch_id"] == claim.attempt_id,
        "result_batch_receipt"
    );
    let object = payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("result_payload"))?;
    object.remove("family_spool");
    object.remove("embedding_spool");
    payload["results"] = results;
    let wire = serde_json::to_string(&payload)?;
    document["output"]["sha256"] = json!(sha256_hex(wire.as_bytes()));
    document["output"]["payload"] = json!(wire);
    let bytes = serde_json::to_vec(&document)?;
    let result = validate(Some(&bytes), &claim.job_id, &claim.attempt_id, &claim.stage)
        .map_err(|_| anyhow::anyhow!("result_manifest_invalid"))?;
    let temporary = directory.join("output-manifest.sealed.tmp");
    std::fs::write(&temporary, &bytes)?;
    std::fs::rename(temporary, directory.join("output-manifest.json"))?;
    Ok(result)
}

/// The legacy provider lifecycle uses the same bounded, fenced family spool.
pub fn stage_writer_results(
    rpc: &mut super::rpc::Rpc,
    claim: &super::child::Claim,
    directory: &std::path::Path,
    manifest: Manifest,
    embeddings_table: bool,
) -> Result<Manifest> {
    let mut document: Value = serde_json::from_str(&manifest.text)?;
    ensure!(
        document["schema"] == "polis-jobs.output-manifest/2",
        "writer_manifest_schema"
    );
    let embedding_spool = if embeddings_table {
        document.get("embedding_spool").cloned()
    } else {
        None
    };
    let files = document["family_spool"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("writer_spool_shape"))?;
    ensure!(
        (embedding_spool.is_some() || !files.is_empty()) && files.len() <= 18,
        "writer_spool_count"
    );
    let mut total = 0_u64;
    for (family, value) in files {
        let wire = read_family_spool(directory, family, value, &mut total)?;
        let mut args = super::task::identity(claim);
        args.extend([json!(family), json!(wire)]);
        let reply = rpc.committed("pd_result_put_family", &args)?;
        ensure!(reply["sha256"] == value["sha256"], "writer_stage_receipt");
    }
    if let Some(descriptor) = &embedding_spool {
        stage_embeddings(rpc, claim, directory, descriptor)?;
    }
    let results = rpc.committed("pd_result_seal", &super::task::identity(claim))?;
    ensure!(
        results["schema"] == "delphi-result-batch/1" && results["batch_id"] == claim.attempt_id,
        "writer_batch_receipt"
    );
    let object = document
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("writer_manifest"))?;
    object.remove("family_spool");
    object.remove("embedding_spool");
    document["results"] = results;
    let bytes = serde_json::to_vec(&document)?;
    let result =
        super::manifest::validate(Some(&bytes), &claim.job_id, &claim.attempt_id, &claim.stage)
            .map_err(|_| anyhow::anyhow!("writer_manifest_invalid"))?;
    let temporary = directory.join("output-manifest.sealed.tmp");
    std::fs::write(&temporary, &bytes)?;
    std::fs::rename(temporary, directory.join("output-manifest.json"))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct SpoolDirectory(std::path::PathBuf);
    impl SpoolDirectory {
        fn new() -> Result<Self> {
            let path =
                std::env::temp_dir().join(format!("polis-graph-spool-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path)?;
            Ok(Self(path))
        }
    }
    impl Drop for SpoolDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn spool_description(bytes: &[u8]) -> Value {
        json!({"file":"Family.jsonl","sha256":sha256_hex(bytes)})
    }
    #[test]
    fn spool_regular_file_preserves_exact_bytes_and_counts() -> Result<()> {
        let dir = SpoolDirectory::new()?;
        let wire = b"{\"number\":1}\n";
        std::fs::write(dir.0.join("Family.jsonl"), wire)?;
        let mut total = 4;
        assert_eq!(
            read_family_spool(&dir.0, "Family", &spool_description(wire), &mut total)?.as_bytes(),
            wire
        );
        assert_eq!(total, 4 + wire.len() as u64);
        Ok(())
    }
    #[test]
    fn spool_symlink_is_refused() -> Result<()> {
        let dir = SpoolDirectory::new()?;
        std::fs::write(dir.0.join("target"), b"data")?;
        std::os::unix::fs::symlink(dir.0.join("target"), dir.0.join("Family.jsonl"))?;
        assert!(read_family_spool(&dir.0, "Family", &spool_description(b"data"), &mut 0).is_err());
        Ok(())
    }
    #[test]
    fn spool_fifo_is_refused_without_waiting_for_writer() -> Result<()> {
        let dir = SpoolDirectory::new()?;
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(dir.0.join("Family.jsonl").as_os_str().as_bytes())?;
        // SAFETY: name is a live, NUL-terminated path; mkfifo retains no pointer.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let path = dir.0.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx
                .send(read_family_spool(&path, "Family", &spool_description(b""), &mut 0).is_err());
        });
        assert!(rx.recv_timeout(std::time::Duration::from_secs(2))?);
        Ok(())
    }
    #[test]
    fn spool_digest_mismatch_is_refused() -> Result<()> {
        let dir = SpoolDirectory::new()?;
        std::fs::write(dir.0.join("Family.jsonl"), b"changed")?;
        assert!(
            read_family_spool(&dir.0, "Family", &spool_description(b"original"), &mut 0).is_err()
        );
        Ok(())
    }
    #[test]
    fn spool_sparse_oversize_is_refused_without_reading() -> Result<()> {
        let dir = SpoolDirectory::new()?;
        std::fs::File::create(dir.0.join("Family.jsonl"))?.set_len(67_108_865)?;
        let error = read_family_spool(&dir.0, "Family", &spool_description(b""), &mut 0).err();
        assert_eq!(
            error.map(|e| e.to_string()),
            Some("result_spool_file:manifest TooLarge".into())
        );
        Ok(())
    }
    #[test]
    fn spool_path_and_total_bound_are_refused() -> Result<()> {
        let dir = SpoolDirectory::new()?;
        std::fs::write(dir.0.join("Family.jsonl"), b"data")?;
        assert!(
            read_family_spool(&dir.0, "../Family", &spool_description(b"data"), &mut 0).is_err()
        );
        assert!(
            read_family_spool(&dir.0, "Family", &json!({"file":"../Family.jsonl"}), &mut 0)
                .is_err()
        );
        assert!(
            read_family_spool(
                &dir.0,
                "Family",
                &spool_description(b"data"),
                &mut 268_435_456
            )
            .is_err()
        );
        let mut total = u64::MAX;
        assert!(
            read_family_spool(&dir.0, "Family", &spool_description(b"data"), &mut total).is_err()
        );
        Ok(())
    }
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
