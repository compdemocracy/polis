//! Child dispatch (build spec §1.4): the unchanged pipeline scripts run in a
//! new session and process group, with the job frame on stdin and in
//! `DELPHI_FRAME`, stdout/stderr piped to the log writer. The process-group
//! handling is ported from `coordinator-rs/src/bridge.rs` and
//! `delphi/scripts/job_poller.py` (`start_new_session`, signal the group,
//! grace, SIGKILL), and adds "reap until the group is empty", which is the
//! only state in which the daemon passes exit proof `true`.
use anyhow::{Result, bail, ensure};
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

/// The job frame (`schemas/job-frame-v1.json`).
pub fn frame(claim: &Claim, adm: &Admission, phase: &str, batch_id: Option<&str>) -> Value {
    json!({
        "schema": FRAME_SCHEMA, "env": claim.env, "zid": adm.zid, "report_id": adm.report_id,
        "job_id": claim.job_id, "run_id": claim.run_id, "attempt_id": claim.attempt_id,
        "lease_epoch": claim.lease_epoch, "stage": claim.stage, "phase": phase,
        "config": {
            "include_moderation": adm.config.get("include_moderation").cloned().unwrap_or(Value::Bool(false)),
            "exclude_comment_selections": adm.config.get("exclude_comment_selections").cloned().unwrap_or(Value::Bool(true)),
            "model": adm.config.get("model").cloned().unwrap_or(Value::Null),
            "batch_size": adm.config.get("batch_size").cloned().unwrap_or(Value::Null),
        },
        "inputs": {
            "math_env": adm.inputs.get("math_env").cloned().unwrap_or(Value::Null),
            "requested_math_tick": adm.inputs.get("requested_math_tick").cloned().unwrap_or(Value::Null),
        },
        "provider": {"batch_id": batch_id},
    })
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
        ("math_rebuild", "run") => (app.join("scripts/math_poller.py"), vec!["--job".to_owned()]),
        (stage, phase) => bail!("no command for stage {stage} phase {phase}"),
    })
}

pub struct Spawned {
    pub child: Child,
    pub pgid: i32,
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
    command
        .arg(script)
        .args(args)
        .current_dir(app)
        .env_remove("QUEUE_DATABASE_URL")
        .env_remove("POLIS_JOBS_PASSWORD_FILE")
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

    #[test]
    fn the_rebuild_runs_the_math_poller_for_one_job() {
        let adm = Admission {
            zid: 22154,
            report_id: None,
            config: json!({"need_bytes": 1, "staged_label": "python-large"}),
            inputs: json!({}),
        };
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
        let frame = frame(&claim("math_rebuild"), &adm, "run", None);
        assert_eq!(frame["stage"], "math_rebuild");
        assert_eq!(frame["zid"], 22154);
        assert!(frame["report_id"].is_null());
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
