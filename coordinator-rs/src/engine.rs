//! Sequential framed worker client. Fresh process on every rebuilt source prefix.
use crate::{
    config::Config,
    fault::Fault,
    store::{Bundle, Payloads, digest},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

pub struct Source {
    pub votes: Vec<Value>,
    pub moderation: Value,
    pub fingerprint: String,
}
fn write_file(root: &Path, name: &str, data: &[u8]) -> Result<Value> {
    fs::write(root.join(name), data)?;
    Ok(json!({"path":name,"bytes":data.len(),"sha256":digest(data)}))
}
fn read_file(root: &Path, descriptor: &Value) -> Result<Value> {
    let name = descriptor["path"]
        .as_str()
        .context("missing descriptor path")?;
    ensure!(
        !Path::new(name).is_absolute()
            && Path::new(name)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
        "unsafe worker output path"
    );
    let path = root.join(name);
    let mut check = root.to_path_buf();
    for c in Path::new(name).components() {
        check.push(c);
        ensure!(!check.is_symlink(), "symlink in worker output");
    }
    ensure!(
        fs::metadata(&path)?.len() <= 256 * 1024 * 1024,
        "worker output too large"
    );
    let data = fs::read(path)?;
    ensure!(
        descriptor["bytes"] == data.len() && descriptor["sha256"] == digest(&data),
        "worker output checksum mismatch"
    );
    Ok(crate::wire::parse(&data)?)
}
struct Worker {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Result<Value>>,
    request: i64,
    run: String,
    session: String,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Worker {
    fn start(c: &Config, input: &Path, output: &Path) -> Result<Self> {
        let mut child = Command::new(&c.python)
            .args(["-m", "polismath.engine_adapter", "--input-root"])
            .arg(input)
            .arg("--output-root")
            .arg(output)
            .env("OMP_NUM_THREADS", "1")
            .env("OPENBLAS_NUM_THREADS", "1")
            .env("MKL_NUM_THREADS", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child.stdin.take().context("worker stdin missing")?;
        let stdout = child.stdout.take().context("worker stdout missing")?;
        let (sender, responses) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let result = (|| -> Result<Value> {
                    use std::io::Read;
                    let count = reader.by_ref().take(65537).read_until(b'\n', &mut line)?;
                    ensure!(
                        count > 0 && count <= 65536 && line.last() == Some(&b'\n'),
                        "malformed/EOF worker response"
                    );
                    Ok(crate::wire::parse(&line)?)
                })();
                let stop = result.is_err();
                if sender.send(result).is_err() || stop {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input: stdin,
            responses,
            request: 0,
            run: uuid::Uuid::new_v4().to_string(),
            session: uuid::Uuid::new_v4().to_string(),
        })
    }
    fn call(&mut self, op: &str, payload: Value) -> Result<Value> {
        self.request += 1;
        let req = json!({"protocol":"polis-engine/1","run_id":self.run,"session_id":self.session,"request_id":self.request,"op":op,"payload":payload});
        let bytes = serde_json::to_vec(&req)?;
        ensure!(bytes.len() < 65536, "control request too large");
        self.input.write_all(&bytes)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        let response = self
            .responses
            .recv_timeout(Duration::from_secs(120))
            .context("worker timeout/exit")??;
        ensure!(
            response.as_object().is_some_and(|m| m.len() == 6
                && m.keys().all(|k| matches!(
                    k.as_str(),
                    "protocol" | "run_id" | "session_id" | "request_id" | "ok" | "result" | "error"
                ))),
            "invalid response envelope"
        );
        ensure!(
            response["protocol"] == "polis-engine/1"
                && response["run_id"] == self.run
                && response["session_id"] == self.session
                && response["request_id"] == self.request,
            "worker identity mismatch"
        );
        ensure!(
            response["ok"] == true,
            "worker rejected operation: {}",
            response["error"]
        );
        Ok(response["result"].clone())
    }
}
pub fn compute(
    c: &Config,
    fault: &Fault,
    zid: i32,
    source: &Source,
    prior: Option<&Bundle>,
) -> Result<(Payloads, Value)> {
    let input = tempfile::tempdir()?;
    let output = tempfile::tempdir()?;
    let mut vote_bytes = Vec::new();
    for (i, v) in source.votes.iter().enumerate() {
        let row = json!({"slot":i+1,"source_ordinal":i,"stream_ordinal":i,"created_ms":v["created"],"pid":v["pid"],"tid":v["tid"],"raw_vote":v["vote"],"weight_x_32767":v["weight_x_32767"]});
        serde_json::to_writer(&mut vote_bytes, &row)?;
        vote_bytes.push(b'\n');
    }
    let votes = write_file(input.path(), "votes.jsonl", &vote_bytes)?;
    let mut mod_bytes = serde_json::to_vec(&json!({"slot":1,"state":source.moderation}))?;
    mod_bytes.push(b'\n');
    let mods = write_file(input.path(), "moderation.jsonl", &mod_bytes)?;
    let parent = prior.map(|b| json!({"profile":"rebuild-prefix/1","source_fingerprint":b.checkpoint["source_fingerprint"],"math_tick":b.math_tick,"payload_digests":b.checkpoint["payload_digests"]}));
    let manifest = json!({"schema":"polis-input/1","fixture_id":zid,"storage_agree_value":c.storage_agree_value,
        "ordering":"live-tid-pid-created-semantic-value-weight/1","votes":votes,"moderation":mods,"parent":parent});
    let manifest_desc = write_file(input.path(), "input.json", &serde_json::to_vec(&manifest)?)?;
    let mut ops = Vec::new();
    if let Some(p) = prior {
        let desc = write_file(
            input.path(),
            "restore.json",
            &serde_json::to_vec(&p.payloads.main)?,
        )?;
        ops.push(json!({"op":"restore","payload":{"profile":"rebuild-prefix/1","parent":parent,"payload":desc,"vote_cursor":source.votes.len(),"moderation_cursor":1}}));
    } else {
        if !source.votes.is_empty() {
            ops.push(json!({"op":"apply_votes","payload":{"from_slot_exclusive":0,"to_slot_inclusive":source.votes.len()}}));
        }
        ops.push(json!({"op":"apply_moderation","payload":{"from_slot_exclusive":0,"to_slot_inclusive":1}}));
    }
    ops.extend([
        json!({"op":"compute","payload":{"compute_id":"compute-0","logical_clock":0}}),
        json!({"op":"snapshot","payload":{"checkpoint_id":"checkpoint-0"}}),
        json!({"op":"close","payload":{}}),
    ]);
    let schedule_desc = write_file(
        input.path(),
        "schedule.json",
        &serde_json::to_vec(&json!({"schema":"polis-schedule/1","operations":ops}))?,
    )?;
    let mut worker = Worker::start(c, input.path(), output.path())?;
    worker.call("initialize",json!({"input_manifest":manifest_desc,"resolved_schedule":schedule_desc,
        "required_capabilities":["rebuild-prefix/1","snapshot-moderation/1"],
        "config":{"profile":"candidate-profile","seed":42,"pca_mode":"powerit","empty_contract":true,"init_vector":"engine-default"}}))?;
    let context = json!({"zid":zid,"math_env":c.math_env,"fingerprint":source.fingerprint,"worker_pid":worker.child.id()});
    fault.hit("before_worker_apply", &context)?;
    let mut checkpoint = Value::Null;
    for op in ops {
        let name = op["op"].as_str().context("operation name")?;
        if name == "restore" {
            fault.hit("before_restore", &context)?;
        }
        let result = worker.call(name, op["payload"].clone())?;
        if name == "restore" {
            fault.hit("after_restore", &context)?;
        }
        if name == "compute" {
            fault.hit("after_worker_compute", &context)?;
        }
        if name == "snapshot" {
            checkpoint = read_file(output.path(), &result["manifest"])?;
        }
    }
    ensure!(worker.child.wait()?.success(), "nonzero worker exit");
    ensure!(
        checkpoint["fixture_id"] == zid
            && checkpoint["run_id"] == worker.run
            && checkpoint["session_id"] == worker.session
            && checkpoint["persistence"] == false,
        "invalid checkpoint identity"
    );
    let cursors = json!({"votes":{"slot":source.votes.len(),"sha256":digest(&vote_bytes)},"moderation":{"slot":1,"sha256":digest(&mod_bytes)}});
    ensure!(
        checkpoint["observed_state_cursors"] == cursors
            && checkpoint["math_input_cursors"] == cursors,
        "worker prefix mismatch"
    );
    let files = &checkpoint["files"];
    let payloads = Payloads {
        main: read_file(output.path(), &files["main"])?,
        bidtopid: read_file(output.path(), &files["bidtopid"])?,
        ptptstats: read_file(output.path(), &files["ptptstats"])?,
    };
    payloads.validate(zid)?;
    Ok((
        payloads,
        json!({"schema":"polis-coordinator/1","source_fingerprint":source.fingerprint,
        "profile":"candidate-profile","lifecycle":"rebuild-prefix/1","cursors":cursors,"event_count":source.votes.len(),
        "storage_agree_value":c.storage_agree_value}),
    ))
}
