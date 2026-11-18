//! The one graph admission call, after typed/image validation. No model call or
//! file hashing runs while the database session is open.
use crate::job_graph_contract::{Image, ValidatedGraph, registry};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[allow(clippy::too_many_arguments)]
pub fn admit(
    client: &mut postgres::Client,
    env: &str,
    zid: i32,
    scope: &str,
    key: &str,
    spec: Value,
    image: &Image,
    supersedes: Option<&str>,
) -> Result<Value> {
    let mut artifacts = BTreeMap::new();
    for node in spec["nodes"].as_array().into_iter().flatten() {
        for input in node["inputs"].as_array().into_iter().flatten() {
            if let Some(id) = input["artifact_id"].as_str() {
                let sha = input["sha256"].as_str().unwrap_or_default();
                let contract_sha = input["contract_sha256"].as_str().unwrap_or_default();
                // Existing executor views resolve immutable external artifacts.
                // No new table privilege is needed and payloads stay in SQL.
                let row = client.query_opt("WITH graphs AS MATERIALIZED (SELECT DISTINCT (public.pd_run_record(env,job_id::uuid)#>>'{graph,graph_id}')::uuid AS id FROM public.delphi_result_jobs WHERE env=$1 AND conversation_id=$2::text), nodes AS (SELECT n FROM graphs g CROSS JOIN LATERAL jsonb_array_elements(public.pd_graph_view($1,g.id)->'nodes') n WHERE g.id IS NOT NULL) SELECT n#>>'{artifact,schema_version}' FROM nodes WHERE n#>>'{artifact,artifact_id}'=$3 AND n#>>'{artifact,content_sha}'=$4 AND n->>'declared_sha'=$5", &[&env,&zid.to_string(),&id,&sha,&contract_sha])?;
                let schema: String = row
                    .ok_or_else(|| anyhow::anyhow!("graph_artifact_identity"))?
                    .try_get(0)?;
                let step = registry()
                    .map_err(anyhow::Error::msg)?
                    .iter()
                    .find(|r| schema == format!("{}/1", r.stage))
                    .ok_or_else(|| anyhow::anyhow!("graph_producer_schema"))?
                    .step;
                artifacts.insert(id.to_owned(), step);
            }
        }
    }
    let checked =
        ValidatedGraph::with_artifacts(spec, image, &artifacts).map_err(anyhow::Error::msg)?;
    let wire = checked.wire().to_string();
    ensure!(wire.len() <= 1_048_576, "graph_spec_bound");
    let row = client.query_one(
        "SELECT public.pd_graph_admit($1,$2,$3,$4,$5::text::jsonb,$6::text::uuid)",
        &[&env, &zid, &scope, &key, &wire, &supersedes],
    )?;
    Ok(row.try_get(0)?)
}

/// Read only the deployed image's own files. Caller-supplied capability JSON
/// is never accepted by this command.
fn image(app: &Path, python: &str, needs_embedding: bool, environment: &str) -> Result<Image> {
    let mut command = Command::new(python);
    command.arg(app.join("scripts/graph_provenance.py"));
    if !needs_embedding {
        command.arg("--without-embedding");
    }
    command
        .env_clear()
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("DELPHI_RESULT_ENV", environment);
    for key in [
        "PATH",
        "HOME",
        "PYTHONPATH",
        "DELPHI_EMBED_MODEL_PATH",
        "DELPHI_EMBED_MODEL_LOCK",
        "DELPHI_EMBED_MODEL_BY_ENV",
        "QUEUE_ENV",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("image_pipe"))?;
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(16385).read_to_end(&mut bytes).map(|_| bytes);
        let _ = send.send(result);
    });
    let start = Instant::now();
    let mut output = None;
    loop {
        if let Ok(value) = recv.try_recv() {
            output = Some(value);
        }
        if start.elapsed() >= Duration::from_secs(120)
            || matches!(&output,Some(Ok(v)) if v.len()>16384)
        {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("image_report_bound");
        }
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "image_report_failed");
            let bytes = match output {
                Some(value) => value?,
                None => recv.recv_timeout(Duration::from_secs(1))??,
            };
            ensure!(bytes.len() <= 16384, "image_report_bound");
            return Ok(serde_json::from_slice(&bytes)?);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn command() -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin().take(1_100_001).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1_100_000, "graph_request_bound");
    let request: Value = serde_json::from_slice(&bytes)?;
    let env = request["env"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("graph_env"))?;
    let zid = i32::try_from(
        request["zid"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("graph_zid"))?,
    )?;
    let scope = request["scope"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("graph_scope"))?;
    let key = request["request_key"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("graph_request_key"))?;
    let cfg = match super::config::load(|k| match k {
        "POLIS_JOBS_ENABLED" => Some("1".into()),
        "QUEUE_ENV" => Some(env.into()),
        _ => std::env::var(k).ok(),
    })
    .map_err(|_| anyhow::anyhow!("admission_configuration"))?
    {
        super::config::Load::Ready(cfg) => cfg,
        _ => anyhow::bail!("admission_configuration"),
    };
    let specification = request["specification"].clone();
    let needs_embedding = specification["nodes"]
        .as_array()
        .is_some_and(|nodes| nodes.iter().any(|n| n["stage"] == "graph_embed"));
    let image = image(&cfg.app_path, &cfg.python, needs_embedding, env)?;
    // Validate before opening a connection as well as at the shared boundary.
    let external = specification["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|n| {
            n["inputs"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|i| i.get("artifact_id").is_some())
        });
    if !external {
        ValidatedGraph::parse(specification.clone(), &image).map_err(anyhow::Error::msg)?;
    }
    let connector = std::sync::Arc::new(super::transport::Connector::new(&cfg)?);
    {
        let mut rpc = super::rpc::Rpc::new(connector.clone(), env);
        ensure!(rpc.contract()?.is_some(), "queue_contract_missing");
    }
    let mut client = connector.connect()?;
    client.batch_execute("SET statement_timeout='30s'; SET lock_timeout='5s'")?;
    let result = admit(
        &mut client,
        env,
        zid,
        scope,
        key,
        specification,
        &image,
        request["supersedes"].as_str(),
    )?;
    println!("{}", json!(result));
    Ok(())
}
