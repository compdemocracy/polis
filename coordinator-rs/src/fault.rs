//! Process-external file latches; entirely absent from release control flow.
use anyhow::{Result, ensure};
use postgres::Client;

pub const STAGES: &[&str] = &[
    "after_source_selection",
    "after_input_checkpoint",
    "before_worker_apply",
    "after_worker_compute",
    "after_lease",
    "before_ticks",
    "after_ticks",
    "before_bidtopid",
    "after_bidtopid",
    "before_ptptstats",
    "after_ptptstats",
    "before_main",
    "after_main",
    "before_commit",
    "after_commit",
    "after_ack",
    "before_restore",
    "after_restore",
    "before_cursor",
    "after_cursor",
    "before_sweep",
    "after_sweep",
    "bundle_pinned",
    "before_companion_join",
    "cache_eviction_contends_with_same_zid_update",
];
#[derive(Default)]
pub struct Fault {
    #[cfg(feature = "fault-injection")]
    directory: Option<std::path::PathBuf>,
}
impl Fault {
    pub fn reject_release_control() -> Result<()> {
        #[cfg(not(feature = "fault-injection"))]
        ensure!(
            std::env::var_os("P026_FAULT_DIR").is_none(),
            "FAULT-CONTROL-REFUSED"
        );
        Ok(())
    }
    pub fn new(client: &mut Client, namespace: &str) -> Result<Self> {
        Self::reject_release_control()?;
        #[cfg(feature = "fault-injection")]
        {
            let directory = std::env::var_os("P026_FAULT_DIR").map(std::path::PathBuf::from);
            if directory.is_some() {
                ensure!(
                    !matches!(namespace, "prod" | "preprod" | "dev"),
                    "test namespace refused"
                );
                let marker: bool = client
                    .query_one(
                        "SELECT EXISTS(SELECT 1 FROM p026_test_marker WHERE namespace=$1)",
                        &[&namespace],
                    )?
                    .get(0);
                ensure!(marker, "synthetic database/namespace marker required");
            }
            Ok(Self { directory })
        }
        #[cfg(not(feature = "fault-injection"))]
        {
            let _ = (client, namespace);
            Ok(Self {})
        }
    }
    /// Only the fault build may enable Python's synthetic-database latches.
    pub fn bridge_control(&self) -> Result<serde_json::Value> {
        #[cfg(feature = "fault-injection")]
        if let Some(dir) = &self.directory {
            let arm = dir.join("arm.json");
            if arm.exists() {
                return Ok(serde_json::from_slice(&std::fs::read(arm)?)?);
            }
        }
        Ok(serde_json::Value::Null)
    }
    pub fn bridge_resumed(&self, stage: &str, worker_pid: u32) -> Result<()> {
        #[cfg(feature = "fault-injection")]
        if let Some(dir) = &self.directory {
            std::fs::write(
                dir.join("bridge-resumed.tmp"),
                serde_json::to_vec(&serde_json::json!({"stage":stage,"worker_pid":worker_pid}))?,
            )?;
            std::fs::rename(
                dir.join("bridge-resumed.tmp"),
                dir.join("bridge-resumed.json"),
            )?;
        }
        let _ = (stage, worker_pid);
        Ok(())
    }
    pub fn hit(&self, stage: &str, context: &serde_json::Value) -> Result<()> {
        #[cfg(feature = "fault-injection")]
        if let Some(dir) = &self.directory {
            use std::{
                fs, thread,
                time::{Duration, Instant},
            };
            let arm = dir.join("arm.json");
            if arm.exists() {
                let request: serde_json::Value = serde_json::from_slice(&fs::read(&arm)?)?;
                if request["stage"] == stage {
                    ensure!(
                        request["protocol"] == "polis-fault-control/1",
                        "invalid fault protocol"
                    );
                    let ack = serde_json::json!({"protocol":"polis-fault-control/1", "stage":stage,
                        "run_id":request["run_id"], "operation_id":request["operation_id"],
                        "pid":std::process::id(), "state":"reached-and-blocked", "context":context});
                    fs::write(dir.join("ack.tmp"), serde_json::to_vec(&ack)?)?;
                    fs::rename(dir.join("ack.tmp"), dir.join("ack.json"))?;
                    let start = Instant::now();
                    while !dir.join("release").exists() {
                        ensure!(
                            start.elapsed() < Duration::from_secs(180),
                            "fault latch timeout"
                        );
                        thread::sleep(Duration::from_millis(10));
                    }
                    fs::remove_file(arm)?;
                }
            }
        }
        let _ = (stage, context);
        Ok(())
    }
}
