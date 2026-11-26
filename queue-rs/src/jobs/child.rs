//! Child dispatch (build spec §1.4): the unchanged pipeline scripts run in a
//! new session and process group, with the job frame on stdin and in
//! `DELPHI_FRAME`, stdout/stderr piped to the log writer. The process-group
//! handling is ported from `coordinator-rs/src/bridge.rs` and
//! `delphi/scripts/job_poller.py` (`start_new_session`, signal the group,
//! grace, SIGKILL), and adds "reap until the group is empty", which is the
//! only state in which the daemon passes exit proof `true`.
use anyhow::{Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub const FRAME_SCHEMA: &str = "polis-jobs.frame/1";
pub const ADMISSION_SCHEMA: &str = "polis-jobs.admission/1";
const FRAME_PREFIX: &str = "frame://inline/";

/// The admission frame carried by the run's `input_uri`: `frame://inline/`
/// followed by base64url of the JSON bytes; `input_sha256` is the sha256 of
/// those bytes. The executor cannot read `polis_queue_runs.zid`, so the zid and
/// report id reach the daemon only through this bound frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Admission {
    pub zid: i64,
    pub report_id: Option<String>,
    pub config: Value,
    pub inputs: Value,
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..=chunk.len() {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub fn base64url_decode(text: &str) -> Result<Vec<u8>> {
    ensure!(text.len() % 4 != 1, "frame_base64");
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = B64
            .iter()
            .position(|&b| b == c)
            .ok_or_else(|| anyhow::anyhow!("frame_base64"))? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

pub fn encode_admission(bytes: &[u8]) -> String {
    format!("{FRAME_PREFIX}{}", base64url_encode(bytes))
}

/// Decode and bind the admission frame to the run's digest.
pub fn decode_admission(uri: &str, sha256: &str) -> Result<Admission> {
    let Some(payload) = uri.strip_prefix(FRAME_PREFIX) else {
        bail!("frame_uri");
    };
    let bytes = base64url_decode(payload)?;
    ensure!(super::sha256_hex(&bytes) == sha256, "frame_digest");
    let v: Value = serde_json::from_slice(&bytes)?;
    ensure!(v["schema"] == ADMISSION_SCHEMA, "frame_schema");
    let zid = v["zid"]
        .as_i64()
        .filter(|z| *z > 0 && *z <= i32::MAX as i64)
        .ok_or_else(|| anyhow::anyhow!("frame_zid"))?;
    let report_id = match &v["report_id"] {
        Value::Null => None,
        Value::String(s) if !s.is_empty() && s.len() <= 512 => Some(s.clone()),
        _ => bail!("frame_report_id"),
    };
    let config = if v["config"].is_null() {
        json!({})
    } else {
        v["config"].clone()
    };
    ensure!(config.is_object(), "frame_config");
    let inputs = if v["inputs"].is_null() {
        json!({})
    } else {
        v["inputs"].clone()
    };
    ensure!(inputs.is_object(), "frame_inputs");
    Ok(Admission {
        zid,
        report_id,
        config,
        inputs,
    })
}

/// The typed math config a `math_rebuild` admission carries across the
/// daemon boundary (P-073 r2): what the child checks before it computes, and
/// what an operator reads on the row. Every key is required and typed; the
/// daemon refuses a frame without them before any child runs
/// (`math_config_invalid`, permanent), so the child never sees a config it
/// cannot check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MathConfig {
    /// The label the child stages under; equals the admission's `inputs.math_env`.
    pub staged_label: String,
    /// The small poller's own (served) label, which the child never writes.
    pub target_label: String,
    /// The estimated bytes the rebuild needs above the base (the child refuses
    /// what its own capacity cannot give).
    pub need_bytes: u64,
    /// The input watermark the small poller admitted the job for (ms), or null.
    pub input_through_ms: Option<i64>,
    /// The sizing binding the estimate was made under.
    pub binding: String,
    /// The small poller's source commit: the child refuses another one.
    pub source_commit: String,
}

pub const MATH_CONFIG_KEYS: [&str; 6] = [
    "staged_label",
    "target_label",
    "need_bytes",
    "input_through_ms",
    "binding",
    "source_commit",
];

fn label(v: &Value, key: &str) -> Result<String> {
    let s = v.as_str().ok_or_else(|| anyhow!("math_config:{key}"))?;
    ensure!(
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-'),
        "math_config:{key}"
    );
    Ok(s.to_owned())
}

impl MathConfig {
    /// The admission's `config` as the typed math config, or why it is not one.
    pub fn from_admission(adm: &Admission) -> Result<Self> {
        let keys = adm
            .config
            .as_object()
            .ok_or_else(|| anyhow!("math_config:object"))?;
        for key in keys.keys() {
            ensure!(
                MATH_CONFIG_KEYS.contains(&key.as_str()),
                "math_config:unknown_key"
            );
        }
        // `Value` indexing never panics: a missing key reads as null.
        let c = &adm.config;
        let staged_label = label(&c["staged_label"], "staged_label")?;
        let target_label = label(&c["target_label"], "target_label")?;
        ensure!(staged_label != target_label, "math_config:labels_equal");
        ensure!(
            adm.inputs.get("math_env").and_then(Value::as_str) == Some(staged_label.as_str()),
            "math_config:staged_label_is_not_the_input_label"
        );
        let need_bytes = c["need_bytes"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| anyhow!("math_config:need_bytes"))?;
        let input_through_ms = match &c["input_through_ms"] {
            Value::Null => None,
            v => Some(
                v.as_i64()
                    .filter(|ms| *ms >= 0)
                    .ok_or_else(|| anyhow!("math_config:input_through_ms"))?,
            ),
        };
        let binding = c["binding"]
            .as_str()
            .filter(|b| !b.is_empty() && b.len() <= 128)
            .ok_or_else(|| anyhow!("math_config:binding"))?
            .to_owned();
        let source_commit = c["source_commit"]
            .as_str()
            .filter(|h| (7..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| anyhow!("math_config:source_commit"))?
            .to_owned();
        Ok(Self {
            staged_label,
            target_label,
            need_bytes,
            input_through_ms,
            binding,
            source_commit,
        })
    }

    /// The frame's `config` object for a rebuild: exactly these six keys.
    pub fn to_json(&self) -> Value {
        json!({
            "staged_label": self.staged_label,
            "target_label": self.target_label,
            "need_bytes": self.need_bytes,
            "input_through_ms": self.input_through_ms,
            "binding": self.binding,
            "source_commit": self.source_commit,
        })
    }
}

/// Identity of the claimed attempt.
#[derive(Debug, Clone)]
pub struct Claim {
    pub env: String,
    pub job_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_id: String,
    pub lease_epoch: String,
    pub stage: String,
}

/// The job frame (`schemas/job-frame-v1.json`). A rebuild's `config` is the
/// typed math config, carried whole; the Delphi stages keep their four keys.
pub fn frame(claim: &Claim, adm: &Admission, phase: &str, batch_id: Option<&str>) -> Result<Value> {
    if claim.stage.starts_with("graph_") {
        return Ok(
            json!({"schema":"polis-job-stage-frame/1", "env":claim.env, "zid":adm.zid,
            "job_id":claim.job_id,"run_id":claim.run_id,"attempt_id":claim.attempt_id,
            "lease_epoch":claim.lease_epoch,"stage":claim.stage,"input":adm.inputs,
            "input_sha256":adm.config["input_sha256"],"input_json":adm.config["input_wire"]}),
        );
    }
    let mut config = if claim.stage == "math_rebuild" {
        MathConfig::from_admission(adm)?.to_json()
    } else {
        json!({
            "include_moderation": adm.config.get("include_moderation").cloned().unwrap_or(Value::Bool(false)),
            "exclude_comment_selections": adm.config.get("exclude_comment_selections").cloned().unwrap_or(Value::Bool(true)),
            "model": adm.config.get("model").cloned().unwrap_or(Value::Null),
            "batch_size": adm.config.get("batch_size").cloned().unwrap_or(Value::Null),
        })
    };
    if adm.config["result_backend"] == "postgres" {
        config["result_backend"] = json!("postgres");
        config["result_scope"] = adm.config["result_scope"].clone();
    }
    Ok(json!({
        "schema": FRAME_SCHEMA, "env": claim.env, "zid": adm.zid, "report_id": adm.report_id,
        "job_id": claim.job_id, "run_id": claim.run_id, "attempt_id": claim.attempt_id,
        "lease_epoch": claim.lease_epoch, "stage": claim.stage, "phase": phase,
        "config": config,
        "inputs": {
            "math_env": adm.inputs.get("math_env").cloned().unwrap_or(Value::Null),
            "requested_math_tick": adm.inputs.get("requested_math_tick").cloned().unwrap_or(Value::Null),
        },
        "provider": {"batch_id": batch_id},
    }))
}

/// The selection the admission names (`config.selection`), when it names
/// one: the run then embeds every comment and lays out, clusters and names
/// only the comments the selection keeps (`run_pipeline.py --selection`; the
/// selections are the input bundle contract's, `SELECTIONS`). Absent or null,
/// the run is what it was and its arguments are byte for byte today's. Any
/// other value is refused before a child starts.
pub fn selection(adm: &Admission) -> Result<Option<&'static str>> {
    match adm.config.get("selection") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) => super::inputs::contract::SELECTIONS
            .into_iter()
            .find(|n| n == name)
            .map(Some)
            .ok_or_else(|| anyhow!("selection_unknown")),
        Some(_) => bail!("selection_not_a_string"),
    }
}

/// The one comment rule a namer is named for in this version: its layout
/// holds only comments participants are shown, so no moderated-out comment's
/// text is ever sent to a model.
pub const NAMER_SELECTION: &str = "participant_visible/1";
/// The namers this version knows (`polis-topic-names`'s price table and
/// prompt versions).
pub const NAMER_MODELS: [&str; 2] = ["claude-haiku-5-5", "claude-sonnet-5-5"];
pub const NAMER_PROMPTS: [&str; 1] = ["polis-topic-names/1"];
pub const NAMER_THINKING: [&str; 2] = ["default", "off"];

/// The providers a namer may name (`polis-topic-names --namer`'s
/// `provider`): `anthropic`, the Claude API and the default when absent, and
/// `bedrock`, Amazon Bedrock.
pub const NAMER_PROVIDERS: [&str; 2] = ["anthropic", "bedrock"];

/// The provider of a `config.naming` object, as the child passes it on:
/// `None` when it is absent or `anthropic` (the default, which is passed on
/// as no `provider` at all, so every namer written before the provider
/// existed keeps its argument, word, key and scope), `Some("bedrock")`
/// otherwise. Refused (`naming_unknown_provider`) when it is any other word
/// or not a string.
pub fn namer_provider(
    naming: &serde_json::Map<String, Value>,
) -> std::result::Result<Option<&'static str>, &'static str> {
    match naming.get("provider") {
        None => Ok(None),
        Some(Value::String(p)) if p == NAMER_PROVIDERS[0] => Ok(None),
        Some(Value::String(p)) if p == NAMER_PROVIDERS[1] => Ok(Some(NAMER_PROVIDERS[1])),
        Some(_) => Err("naming_unknown_provider"),
    }
}

/// The namer the admission names (`config.naming`), as the one compact JSON
/// argument `run_delphi.py --namer=` takes (`{"model":..,"prompt":..,
/// "thinking":..}`, keys in that order; through Amazon Bedrock
/// `{"provider":"bedrock","model":..,"prompt":..,"thinking":..}`, the shape
/// `polis-topic-names --namer` reads). Absent, null or `{"by":"keywords"}`,
/// the run is today's and its arguments are byte for byte today's; a namer
/// with no `provider`, or `anthropic`, is today's argument. A namer is
/// refused before a child starts when its provider, model, prompt or
/// thinking is unknown, when it carries any other key, or when the run's
/// selection is not `participant_visible/1`.
pub fn namer(adm: &Admission) -> Result<Option<String>> {
    let naming = match adm.config.get("naming") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(naming)) => naming,
        Some(_) => bail!("naming_not_an_object"),
    };
    match naming.get("by").and_then(Value::as_str) {
        Some("keywords") if naming.len() == 1 => return Ok(None),
        Some("keywords") => bail!("naming_unknown_key"),
        Some("model") => {}
        _ => bail!("naming_unknown_by"),
    }
    if naming.keys().any(|k| {
        !matches!(
            k.as_str(),
            "by" | "provider" | "model" | "prompt" | "thinking"
        )
    }) {
        bail!("naming_unknown_key");
    }
    let provider = namer_provider(naming).map_err(|refusal| anyhow!(refusal))?;
    let field = |key: &str, known: &[&'static str], refusal: &'static str| {
        naming
            .get(key)
            .and_then(Value::as_str)
            .and_then(|v| known.iter().copied().find(|k| *k == v))
            .ok_or_else(|| anyhow!(refusal))
    };
    let model = field("model", &NAMER_MODELS, "naming_unknown_model")?;
    let prompt = field("prompt", &NAMER_PROMPTS, "naming_unknown_prompt")?;
    let thinking = field("thinking", &NAMER_THINKING, "naming_unknown_thinking")?;
    if selection(adm)? != Some(NAMER_SELECTION) {
        bail!("naming_selection_not_named");
    }
    // Every value is one of the closed words above: no escaping is needed.
    let provider = provider.map_or(String::new(), |p| format!(r#""provider":"{p}","#));
    Ok(Some(format!(
        r#"{{{provider}"model":"{model}","prompt":"{prompt}","thinking":"{thinking}"}}"#
    )))
}

fn py_bool(v: Option<&Value>, default: bool) -> &'static str {
    // The scripts parse Python's str(bool), as job_poller.py passes it today.
    if v.and_then(Value::as_bool).unwrap_or(default) {
        "True"
    } else {
        "False"
    }
}

/// Script and arguments per stage/phase (today's `job_poller.py:1243-1258`
/// for the Delphi stages; the math poller's job entry for a rebuild, which
/// reads the one zid from the frame and runs the cold rebuild for it).
pub fn command_args(
    app: &Path,
    claim: &Claim,
    adm: &Admission,
    phase: &str,
) -> Result<(PathBuf, Vec<String>)> {
    let c = &adm.config;
    Ok(match (claim.stage.as_str(), phase) {
        ("delphi_full_pipeline", "run") => {
            let mut args = vec![
                format!("--zid={}", adm.zid),
                format!(
                    "--include_moderation={}",
                    py_bool(c.get("include_moderation"), false)
                ),
                format!(
                    "--exclude_comment_selections={}",
                    py_bool(c.get("exclude_comment_selections"), true)
                ),
            ];
            if let Some(name) = selection(adm)? {
                args.push(format!("--selection={name}"));
            }
            if let Some(namer) = namer(adm)? {
                args.push(format!("--namer={namer}"));
            }
            if let Some(rid) = &adm.report_id {
                args.push(format!("--rid={rid}"));
            }
            if let Some(region) = c.get("region").and_then(Value::as_str) {
                args.push(format!("--region={region}"));
            }
            (app.join("run_delphi.py"), args)
        }
        ("delphi_narrative", "submit") => {
            let model = c
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| std::env::var("ANTHROPIC_MODEL").ok())
                .ok_or_else(|| anyhow::anyhow!("narrative_model_missing"))?;
            let mut args = vec![
                format!("--conversation_id={}", adm.zid),
                format!("--model={model}"),
                format!(
                    "--include_moderation={}",
                    py_bool(c.get("include_moderation"), false)
                ),
                format!(
                    "--exclude_comment_selections={}",
                    py_bool(c.get("exclude_comment_selections"), true)
                ),
                format!(
                    "--max-batch-size={}",
                    c.get("batch_size").and_then(Value::as_u64).unwrap_or(20)
                ),
            ];
            if c.get("no_cache").and_then(Value::as_bool) == Some(true) {
                args.push("--no-cache".into());
            }
            (
                app.join("umap_narrative/801_narrative_report_batch.py"),
                args,
            )
        }
        ("delphi_narrative", "recheck") => (
            app.join("umap_narrative/803_check_batch_status.py"),
            vec![format!("--job-id={}", claim.job_id)],
        ),
        ("graph_embed" | "graph_cluster" | "graph_topics" | "graph_narrative", "run") => {
            (app.join("scripts/job_graph_stage.py"), vec![])
        }
        ("math_rebuild", "run") => (app.join("scripts/math_poller.py"), vec!["--job".to_owned()]),
        (stage, phase) => bail!("no command for stage {stage} phase {phase}"),
    })
}

pub struct Spawned {
    pub child: Child,
    pub pgid: i32,
}

const GRAPH_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "PYTHONPATH",
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMBA_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "TOKENIZERS_PARALLELISM",
    "HF_HOME",
    "HF_HUB_OFFLINE",
    "TRANSFORMERS_OFFLINE",
    "XDG_CACHE_HOME",
    "NUMBA_CACHE_DIR",
    "DELPHI_EMBED_MODEL_PATH",
    "DELPHI_EMBED_MODEL_LOCK",
    // Existing process-boundary proof fixture paths; neither carries credentials.
    "GRAPH_PROOF_ROOT",
    "GRAPH_STAGE_SOURCE",
];

fn child_environment(
    command: &mut Command,
    stage: &str,
    inherited: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) {
    if stage.starts_with("graph_") {
        command.env_clear();
        for (key, value) in inherited {
            if key
                .to_str()
                .is_some_and(|key| GRAPH_ENVIRONMENT.contains(&key))
            {
                command.env(key, value);
            }
        }
    }
    command
        .env_remove("QUEUE_DATABASE_URL")
        .env_remove("POLIS_JOBS_PASSWORD_FILE");
}

/// Spawn in a new session (pgid = pid). Queue credentials never reach the child.
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    python: &str,
    app: &Path,
    script: &Path,
    args: &[String],
    claim: &Claim,
    adm: &Admission,
    phase: &str,
    manifest: &Path,
    frame_path: &Path,
    batch_id: Option<&str>,
) -> Result<Spawned> {
    let mut command = Command::new(python);
    child_environment(&mut command, &claim.stage, std::env::vars_os());
    command
        .arg(script)
        .args(args)
        .current_dir(app)
        .env("DELPHI_JOB_ID", &claim.job_id)
        .env("DELPHI_RUN_ID", &claim.run_id)
        .env("DELPHI_ATTEMPT_ID", &claim.attempt_id)
        .env("DELPHI_LEASE_EPOCH", &claim.lease_epoch)
        .env("DELPHI_STAGE", &claim.stage)
        .env("DELPHI_PHASE", phase)
        .env("DELPHI_OUTPUT_MANIFEST", manifest)
        .env("DELPHI_FRAME", frame_path)
        .env(
            "DELPHI_REPORT_ID",
            adm.report_id.clone().unwrap_or_else(|| adm.zid.to_string()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if adm.config["result_backend"] == "postgres" {
        command
            .env("DELPHI_RESULT_BACKEND", "postgres")
            .env("DELPHI_RESULT_ENV", &claim.env)
            .env(
                "DELPHI_RESULT_SCOPE",
                adm.config["result_scope"].as_str().unwrap_or_default(),
            );
    }
    if let Some(batch) = batch_id {
        command.env("DELPHI_PROVIDER_BATCH_ID", batch);
    }
    // SAFETY: setsid is async-signal-safe and touches only the new child.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    let pgid = i32::try_from(child.id())?;
    Ok(Spawned { child, pgid })
}

/// Become the reaper of orphaned descendants on Linux even when not PID 1,
/// so a grandchild whose parent died can still be waited for.
pub fn become_subreaper() {
    #[cfg(target_os = "linux")]
    // SAFETY: prctl with PR_SET_CHILD_SUBREAPER takes plain integer arguments.
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
    }
}

/// Whether any process is still a member of the group (`kill(-pgid, 0)`).
pub fn group_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only checks existence/permission.
    let rc = unsafe { libc::kill(-pgid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn signal_group(pgid: i32, sig: libc::c_int) {
    if pgid > 1 {
        // SAFETY: plain kill(2) on a negative pgid.
        unsafe {
            libc::kill(-pgid, sig);
        }
    }
}

/// Reap any of the group's members that are our children (grandchildren
/// re-parented to us as PID 1 or subreaper), without blocking.
fn reap_members(pgid: i32) {
    loop {
        let mut status = 0;
        // SAFETY: waitpid on a negative pgid with WNOHANG.
        let pid = unsafe { libc::waitpid(-pgid, &mut status, libc::WNOHANG) };
        if pid <= 0 {
            break;
        }
    }
}

/// Wait for the group leader (bounded), recording its status.
pub fn wait_leader(child: &mut Child, until: Instant) -> Option<std::process::ExitStatus> {
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Make the group empty: SIGTERM, `grace`, SIGKILL, then wait until no member
/// remains. Returns the leader's status and whether the group is empty. The
/// caller passes exit proof `true` only when the group is empty.
pub fn kill_and_reap(
    child: &mut Child,
    pgid: i32,
    grace: Duration,
) -> (Option<std::process::ExitStatus>, bool) {
    let mut status = child.try_wait().ok().flatten();
    if status.is_none() || group_alive(pgid) {
        signal_group(pgid, libc::SIGTERM);
        let deadline = Instant::now() + grace;
        loop {
            if status.is_none() {
                status = child.try_wait().ok().flatten();
            }
            if status.is_some() {
                reap_members(pgid);
                if !group_alive(pgid) {
                    break;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    if status.is_none() || group_alive(pgid) {
        signal_group(pgid, libc::SIGKILL);
        let _ = child.kill();
    }
    if status.is_none() {
        status = wait_leader(child, Instant::now() + Duration::from_secs(30));
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        reap_members(pgid);
        if !group_alive(pgid) {
            return (status, status.is_some());
        }
        if Instant::now() >= deadline {
            return (status, false);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_children_receive_only_model_and_runtime_environment() -> Result<()> {
        let inherited: Vec<(std::ffi::OsString, std::ffi::OsString)> = [
            "DATABASE_URL",
            "DELPHI_RESULT_DATABASE_URL",
            "MATH_CAPACITY_QUEUE_DSN",
            "QUEUE_DATABASE_URL",
            "PGHOST",
            "PGPORT",
            "PGDATABASE",
            "PGUSER",
            "PGPASSWORD",
            "PGPASSFILE",
            "PGSERVICE",
            "PGSERVICEFILE",
            "POSTGRES_PASSWORD",
            "DB_PASSWORD",
            "POLIS_JOBS_PASSWORD_FILE",
            "UNRECOGNIZED_DATABASE_DSN",
            "DELPHI_EMBED_MODEL_PATH",
            "DELPHI_EMBED_MODEL_LOCK",
            "OMP_NUM_THREADS",
            "PATH",
        ]
        .into_iter()
        .map(|key| (key.into(), format!("generated-{key}").into()))
        .collect();
        let mut command = Command::new("/usr/bin/env");
        command.envs(inherited.clone());
        child_environment(&mut command, "graph_embed", inherited);
        let output = command.output()?;
        assert!(output.status.success());
        let lines = String::from_utf8(output.stdout)?;
        let keys: Vec<&str> = lines
            .lines()
            .filter_map(|line| line.split_once('=').map(|(key, _)| key))
            .collect();
        assert_eq!(keys.len(), 4);
        assert!(keys.iter().all(|key| {
            [
                "DELPHI_EMBED_MODEL_PATH",
                "DELPHI_EMBED_MODEL_LOCK",
                "OMP_NUM_THREADS",
                "PATH",
            ]
            .contains(key)
        }));
        Ok(())
    }
    #[test]
    fn math_environment_keeps_its_database_access() {
        let mut command = Command::new("python");
        command
            .env("DATABASE_URL", "generated-main")
            .env("MATH_CAPACITY_QUEUE_DSN", "generated-capacity")
            .env("QUEUE_DATABASE_URL", "generated-queue")
            .env("POLIS_JOBS_PASSWORD_FILE", "generated-file");
        child_environment(&mut command, "math_rebuild", std::iter::empty());
        let actual: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(
            actual.get(std::ffi::OsStr::new("DATABASE_URL")),
            Some(&Some(std::ffi::OsStr::new("generated-main")))
        );
        assert_eq!(
            actual.get(std::ffi::OsStr::new("MATH_CAPACITY_QUEUE_DSN")),
            Some(&Some(std::ffi::OsStr::new("generated-capacity")))
        );
        assert_eq!(
            actual.get(std::ffi::OsStr::new("QUEUE_DATABASE_URL")),
            Some(&None)
        );
        assert_eq!(
            actual.get(std::ffi::OsStr::new("POLIS_JOBS_PASSWORD_FILE")),
            Some(&None)
        );
    }
    #[test]
    fn base64url_round_trip() {
        for input in [
            &b""[..],
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"fooba",
            b"foobar",
            &[0xff, 0xfe, 0x00],
        ] {
            let enc = base64url_encode(input);
            assert!(!enc.contains('='));
            assert_eq!(base64url_decode(&enc).unwrap_or_default(), input.to_vec());
        }
        assert_eq!(base64url_encode(b"foobar"), "Zm9vYmFy");
        assert!(base64url_decode("a").is_err());
        assert!(base64url_decode("a+b/").is_err());
    }

    #[test]
    fn admission_is_bound_to_the_run_digest() {
        let bytes = br#"{"schema":"polis-jobs.admission/1","zid":7,"report_id":"r1","config":{"include_moderation":true}}"#;
        let sha = crate::jobs::sha256_hex(bytes);
        let uri = encode_admission(bytes);
        let adm = decode_admission(&uri, &sha).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(adm.zid, 7);
        assert_eq!(adm.report_id.as_deref(), Some("r1"));
        assert!(decode_admission(&uri, &"0".repeat(64)).is_err());
        assert!(decode_admission("frame://elsewhere/x", &sha).is_err());
    }

    fn claim(stage: &str) -> Claim {
        Claim {
            env: "dev".into(),
            job_id: "j".into(),
            run_id: "r".into(),
            attempt_id: "a".into(),
            owner_id: "o".into(),
            lease_epoch: "1".into(),
            stage: stage.into(),
        }
    }

    #[test]
    fn commands_match_todays_poller() {
        let adm = Admission {
            zid: 42,
            report_id: Some("r9".into()),
            config: json!({"include_moderation": true, "model": "m1", "batch_size": 5}),
            inputs: json!({}),
        };
        let app = Path::new("/app");
        let (script, args) =
            command_args(app, &claim("delphi_full_pipeline"), &adm, "run").unwrap_or_default();
        assert_eq!(script, PathBuf::from("/app/run_delphi.py"));
        assert_eq!(
            args,
            vec![
                "--zid=42",
                "--include_moderation=True",
                "--exclude_comment_selections=True",
                "--rid=r9"
            ]
        );
        let (script, args) =
            command_args(app, &claim("delphi_narrative"), &adm, "submit").unwrap_or_default();
        assert!(script.ends_with("umap_narrative/801_narrative_report_batch.py"));
        assert!(args.contains(&"--conversation_id=42".to_owned()));
        assert!(args.contains(&"--model=m1".to_owned()));
        assert!(args.contains(&"--max-batch-size=5".to_owned()));
        let (script, args) =
            command_args(app, &claim("delphi_narrative"), &adm, "recheck").unwrap_or_default();
        assert!(script.ends_with("umap_narrative/803_check_batch_status.py"));
        assert_eq!(args, vec!["--job-id=j"]);
        assert!(command_args(app, &claim("delphi_full_pipeline"), &adm, "recheck").is_err());
    }

    /// The shadow's admission names its selection: the pipeline is told, and
    /// the bundle carries the two columns it reads. An admission that names
    /// none (every served one) runs with today's arguments; one that names a
    /// selection the contract does not define starts no child.
    #[test]
    fn a_named_selection_reaches_the_pipeline_and_nothing_else_does() -> Result<()> {
        let shadow = |selection: Value| Admission {
            zid: 42,
            report_id: None,
            config: json!({"selection": selection, "exclude_comment_selections": false,
                "embeddings_table": true, "shadow": {"schema": "delphi-shadow/2"}}),
            inputs: json!({}),
        };
        let app = Path::new("/app");
        let named = shadow(json!("participant_visible/1"));
        assert_eq!(selection(&named)?, Some("participant_visible/1"));
        let (_, args) = command_args(app, &claim("delphi_full_pipeline"), &named, "run")?;
        assert_eq!(
            args,
            vec![
                "--zid=42",
                "--include_moderation=False",
                "--exclude_comment_selections=False",
                "--selection=participant_visible/1"
            ]
        );
        let none = shadow(Value::Null);
        assert_eq!(selection(&none)?, None);
        let (_, args) = command_args(app, &claim("delphi_full_pipeline"), &none, "run")?;
        assert!(!args.iter().any(|a| a.starts_with("--selection")));
        for refused in [json!("all/1"), json!(1), json!(["participant_visible/1"])] {
            let adm = shadow(refused);
            assert!(selection(&adm).is_err());
            assert!(command_args(app, &claim("delphi_full_pipeline"), &adm, "run").is_err());
        }
        Ok(())
    }

    /// The two report rules are selections like the first: each reaches the
    /// pipeline by its name, and nothing else changes in the arguments.
    #[test]
    fn the_report_rules_reach_the_pipeline_by_name() -> Result<()> {
        let app = Path::new("/app");
        for name in ["all_comments/1", "all_but_moderated_out/1"] {
            let adm = Admission {
                zid: 42,
                report_id: None,
                config: json!({"selection": name, "exclude_comment_selections": false,
                    "embeddings_table": true, "shadow": {"schema": "delphi-shadow/2"}}),
                inputs: json!({}),
            };
            assert_eq!(selection(&adm)?, Some(name));
            let (_, args) = command_args(app, &claim("delphi_full_pipeline"), &adm, "run")?;
            assert_eq!(
                args,
                vec![
                    "--zid=42".to_owned(),
                    "--include_moderation=False".to_owned(),
                    "--exclude_comment_selections=False".to_owned(),
                    format!("--selection={name}"),
                ]
            );
        }
        Ok(())
    }

    fn shadow_with(selection: Value, naming: Option<Value>) -> Admission {
        let mut config = json!({"selection": selection, "exclude_comment_selections": false,
            "embeddings_table": true, "shadow": {"schema": "delphi-shadow/2"}});
        if let Some(naming) = naming {
            config["naming"] = naming;
        }
        Admission {
            zid: 42,
            report_id: None,
            config,
            inputs: json!({}),
        }
    }

    /// A run whose configuration names no namer, or names keywords, has
    /// today's arguments exactly; a named namer reaches the pipeline as one
    /// compact argument after the selection.
    #[test]
    fn a_namer_reaches_the_pipeline_only_when_the_configuration_names_one() -> Result<()> {
        let app = Path::new("/app");
        let today = vec![
            "--zid=42",
            "--include_moderation=False",
            "--exclude_comment_selections=False",
            "--selection=participant_visible/1",
        ];
        for naming in [None, Some(Value::Null), Some(json!({"by": "keywords"}))] {
            let adm = shadow_with(json!("participant_visible/1"), naming);
            assert_eq!(namer(&adm)?, None);
            let (_, args) = command_args(app, &claim("delphi_full_pipeline"), &adm, "run")?;
            assert_eq!(args, today);
        }
        for (model, thinking) in [
            ("claude-haiku-5-5", "default"),
            ("claude-sonnet-5-5", "off"),
        ] {
            let adm = shadow_with(
                json!("participant_visible/1"),
                Some(
                    json!({"by": "model", "model": model, "prompt": "polis-topic-names/1",
                    "thinking": thinking}),
                ),
            );
            let (_, args) = command_args(app, &claim("delphi_full_pipeline"), &adm, "run")?;
            let mut want: Vec<String> = today.iter().map(|s| (*s).to_owned()).collect();
            want.push(format!(
                r#"--namer={{"model":"{model}","prompt":"polis-topic-names/1","thinking":"{thinking}"}}"#
            ));
            assert_eq!(args, want);
            let json_part = args[4].strip_prefix("--namer=").unwrap_or_default();
            let parsed: Value = serde_json::from_str(json_part)?;
            assert_eq!(
                parsed,
                json!({"model": model, "prompt": "polis-topic-names/1", "thinking": thinking})
            );
        }
        Ok(())
    }

    /// The provider: absent or `anthropic`, the argument is exactly today's
    /// (no `provider` key); `bedrock` reaches the program as the first key of
    /// the namer argument, the shape `polis-topic-names --namer` reads.
    #[test]
    fn a_namer_names_its_provider_only_when_it_is_bedrock() -> Result<()> {
        let app = Path::new("/app");
        let namer_of = |provider: Option<&str>| {
            let mut n = json!({"by": "model", "model": "claude-sonnet-5-5",
                "prompt": "polis-topic-names/1", "thinking": "default"});
            if let Some(p) = provider {
                n["provider"] = json!(p);
            }
            shadow_with(json!("participant_visible/1"), Some(n))
        };
        let today = r#"--namer={"model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#;
        for provider in [None, Some("anthropic")] {
            let (_, args) = command_args(
                app,
                &claim("delphi_full_pipeline"),
                &namer_of(provider),
                "run",
            )?;
            assert_eq!(args[4], today);
            assert_eq!(args.len(), 5);
        }
        let (_, args) = command_args(
            app,
            &claim("delphi_full_pipeline"),
            &namer_of(Some("bedrock")),
            "run",
        )?;
        assert_eq!(
            args[4],
            r#"--namer={"provider":"bedrock","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#
        );
        assert_eq!(
            args[..4],
            command_args(app, &claim("delphi_full_pipeline"), &namer_of(None), "run")?.1[..4]
        );
        Ok(())
    }

    /// The Amazon Bedrock price settings `polis-topic-names` reads are passed
    /// to a Delphi child when they are set: the child strips only the queue's
    /// own credentials from a Delphi stage.
    #[test]
    fn the_bedrock_price_settings_reach_a_delphi_child() {
        let mut command = Command::new("python");
        command
            .env("DELPHI_NAMING_BEDROCK_INPUT_USD_PER_MTOK", "2.2")
            .env("DELPHI_NAMING_BEDROCK_OUTPUT_USD_PER_MTOK", "11")
            .env(
                "DELPHI_NAMING_BEDROCK_PRICE_SOURCE",
                "made-up figures for a test",
            )
            .env("QUEUE_DATABASE_URL", "generated-queue");
        child_environment(&mut command, "delphi_full_pipeline", std::iter::empty());
        let actual: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        for (key, value) in [
            ("DELPHI_NAMING_BEDROCK_INPUT_USD_PER_MTOK", "2.2"),
            ("DELPHI_NAMING_BEDROCK_OUTPUT_USD_PER_MTOK", "11"),
            (
                "DELPHI_NAMING_BEDROCK_PRICE_SOURCE",
                "made-up figures for a test",
            ),
        ] {
            assert_eq!(
                actual.get(std::ffi::OsStr::new(key)),
                Some(&Some(std::ffi::OsStr::new(value))),
                "{key}"
            );
        }
        assert_eq!(
            actual.get(std::ffi::OsStr::new("QUEUE_DATABASE_URL")),
            Some(&None)
        );
    }

    /// An unknown model, prompt, thinking or key, a namer that is not an
    /// object, and a namer under any comment rule but the participants' own
    /// start no child.
    #[test]
    fn a_namer_this_version_does_not_name_starts_no_child() {
        let app = Path::new("/app");
        let good = json!({"by": "model", "model": "claude-haiku-5-5",
            "prompt": "polis-topic-names/1", "thinking": "default"});
        let with = |key: &str, value: Value| {
            let mut n = good.clone();
            n[key] = value;
            n
        };
        let refused = [
            (
                json!("participant_visible/1"),
                with("model", json!("claude-opus-5-5")),
                "naming_unknown_model",
            ),
            (
                json!("participant_visible/1"),
                with("prompt", json!("polis-topic-names/2")),
                "naming_unknown_prompt",
            ),
            (
                json!("participant_visible/1"),
                with("thinking", json!("high")),
                "naming_unknown_thinking",
            ),
            (
                json!("participant_visible/1"),
                with("names_of", json!("j")),
                "naming_unknown_key",
            ),
            (
                json!("participant_visible/1"),
                with("by", json!("people")),
                "naming_unknown_by",
            ),
            (
                json!("participant_visible/1"),
                json!({"by": "keywords", "model": "claude-haiku-5-5"}),
                "naming_unknown_key",
            ),
            (
                json!("participant_visible/1"),
                json!("claude-haiku-5-5"),
                "naming_not_an_object",
            ),
            (
                json!("all_comments/1"),
                good.clone(),
                "naming_selection_not_named",
            ),
            (
                json!("all_but_moderated_out/1"),
                good.clone(),
                "naming_selection_not_named",
            ),
            (Value::Null, good.clone(), "naming_selection_not_named"),
            (
                json!("participant_visible/1"),
                with("provider", json!("vertex")),
                "naming_unknown_provider",
            ),
            (
                json!("participant_visible/1"),
                with("provider", json!("Bedrock")),
                "naming_unknown_provider",
            ),
            (
                json!("participant_visible/1"),
                with("provider", Value::Null),
                "naming_unknown_provider",
            ),
            (
                json!("participant_visible/1"),
                with("provider", json!(["bedrock"])),
                "naming_unknown_provider",
            ),
        ];
        for (selection, naming, word) in refused {
            let adm = shadow_with(selection, Some(naming));
            let err = namer(&adm).err().map(|e| e.to_string());
            assert_eq!(err.as_deref(), Some(word));
            assert!(command_args(app, &claim("delphi_full_pipeline"), &adm, "run").is_err());
        }
    }

    fn math_config() -> Value {
        json!({"staged_label": "python-large", "target_label": "python", "need_bytes": 850_000_000u64,
            "input_through_ms": 1_790_000_000_000i64, "binding": "0000000000000000",
            "source_commit": "0123456789abcdef0123456789abcdef01234567"})
    }

    fn rebuild(config: Value, math_env: &str) -> Admission {
        Admission {
            zid: 22154,
            report_id: None,
            config,
            inputs: json!({"math_env": math_env, "requested_math_tick": null}),
        }
    }

    #[test]
    fn the_rebuild_runs_the_math_poller_for_one_job() {
        let adm = rebuild(math_config(), "python-large");
        let app = Path::new("/app");
        let (script, args) =
            command_args(app, &claim("math_rebuild"), &adm, "run").unwrap_or_default();
        assert_eq!(script, PathBuf::from("/app/scripts/math_poller.py"));
        // The zid travels in the frame (DELPHI_FRAME and stdin), never argv.
        assert_eq!(args, vec!["--job"]);
        for phase in ["submit", "recheck", "none"] {
            assert!(
                command_args(app, &claim("math_rebuild"), &adm, phase).is_err(),
                "{phase}"
            );
        }
        let frame = frame(&claim("math_rebuild"), &adm, "run", None).unwrap_or_default();
        assert_eq!(frame["stage"], "math_rebuild");
        assert_eq!(frame["zid"], 22154);
        assert!(frame["report_id"].is_null());
        // The typed math config crosses the boundary whole, nothing else.
        assert_eq!(frame["config"], math_config());
        assert_eq!(frame["inputs"]["math_env"], "python-large");
    }

    /// The frame a rebuild's child receives is pinned to the golden the math
    /// poller's tests drive their child with
    /// (`delphi/tests/poller/fixtures/queue/math_rebuild_frame.json`): one
    /// file, both sides of the boundary.
    #[test]
    fn the_rebuild_frame_matches_the_pollers_golden() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../delphi/tests/poller/fixtures/queue/math_rebuild_frame.json");
        let golden: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_default())
                .unwrap_or_default();
        let c = Claim {
            env: "test".into(),
            job_id: "00000000-0000-4000-8000-000000000001".into(),
            run_id: "00000000-0000-4000-8000-000000000002".into(),
            attempt_id: "00000000-0000-4000-8000-000000000003".into(),
            owner_id: "o".into(),
            lease_epoch: "1".into(),
            stage: "math_rebuild".into(),
        };
        let adm = rebuild(math_config(), "python-large");
        let written = frame(&c, &adm, "run", None).unwrap_or_default();
        assert_eq!(written, golden, "{}", path.display());
    }

    #[test]
    fn a_rebuild_without_the_typed_math_config_makes_no_frame() {
        let c = claim("math_rebuild");
        let ok = rebuild(math_config(), "python-large");
        assert!(MathConfig::from_admission(&ok).is_ok());
        let cases: Vec<(&str, Value, &str)> = vec![
            (
                "the old untyped shape",
                json!({"need_bytes": 1, "staged_label": "python-large"}),
                "python-large",
            ),
            ("empty", json!({}), "python-large"),
            (
                "a Delphi config",
                json!({"include_moderation": false}),
                "python-large",
            ),
            (
                "a missing source commit",
                {
                    let mut c = math_config();
                    c.as_object_mut().map(|o| o.remove("source_commit"));
                    c
                },
                "python-large",
            ),
            (
                "a null source commit",
                {
                    let mut c = math_config();
                    c["source_commit"] = Value::Null;
                    c
                },
                "python-large",
            ),
            (
                "a non-hex source commit",
                {
                    let mut c = math_config();
                    c["source_commit"] = "not-a-commit".into();
                    c
                },
                "python-large",
            ),
            (
                "need_bytes zero",
                {
                    let mut c = math_config();
                    c["need_bytes"] = 0.into();
                    c
                },
                "python-large",
            ),
            (
                "need_bytes as text",
                {
                    let mut c = math_config();
                    c["need_bytes"] = "850".into();
                    c
                },
                "python-large",
            ),
            (
                "a negative watermark",
                {
                    let mut c = math_config();
                    c["input_through_ms"] = (-1).into();
                    c
                },
                "python-large",
            ),
            (
                "an empty binding",
                {
                    let mut c = math_config();
                    c["binding"] = "".into();
                    c
                },
                "python-large",
            ),
            (
                "equal labels",
                {
                    let mut c = math_config();
                    c["target_label"] = "python-large".into();
                    c
                },
                "python-large",
            ),
            (
                "a served target label spelled with a slash",
                {
                    let mut c = math_config();
                    c["target_label"] = "py/thon".into();
                    c
                },
                "python-large",
            ),
            (
                "an extra key",
                {
                    let mut c = math_config();
                    c["manifest_uri"] = "s3://x".into();
                    c
                },
                "python-large",
            ),
            (
                "a staged label that is not the input label",
                math_config(),
                "python",
            ),
        ];
        for (name, config, math_env) in cases {
            let adm = rebuild(config, math_env);
            assert!(MathConfig::from_admission(&adm).is_err(), "{name}");
            assert!(frame(&c, &adm, "run", None).is_err(), "{name}");
        }
        // A null watermark is a watermark the small poller did not have.
        let mut c0 = math_config();
        c0["input_through_ms"] = Value::Null;
        let m = MathConfig::from_admission(&rebuild(c0, "python-large"))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.input_through_ms, None);
        // The Delphi stages never carry the math keys, and still frame.
        let delphi = Admission {
            zid: 1,
            report_id: Some("r".into()),
            config: json!({}),
            inputs: json!({}),
        };
        let f = frame(&claim("delphi_full_pipeline"), &delphi, "run", None).unwrap_or_default();
        assert_eq!(f["config"]["include_moderation"], false);
    }

    #[test]
    fn kill_and_reap_empties_a_group_with_a_grandchild() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & sleep 30; wait"]);
        // SAFETY: as in spawn().
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap_or_else(|e| panic!("{e}"));
        let pgid = child.id() as i32;
        std::thread::sleep(Duration::from_millis(200));
        assert!(group_alive(pgid));
        let (status, empty) = kill_and_reap(&mut child, pgid, Duration::from_secs(2));
        assert!(status.is_some());
        assert!(empty);
        assert!(!group_alive(pgid));
    }
}
