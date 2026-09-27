//! Durable full-sweep completion, consumed by an independent read-only observer.
use crate::store::{PgStore, digest};
use anyhow::Result;
use serde_json::json;

impl PgStore {
    pub fn poll_scope(&self) -> Result<String> {
        let mut allowlist = self.config.allowlist.clone();
        allowlist.sort_unstable();
        allowlist.dedup();
        Ok(digest(&serde_json::to_vec(&json!([
            self.config.shard_count,
            allowlist
        ]))?))
    }
    pub fn poll_clock(&mut self) -> Result<f64> {
        Ok(self
            .client
            .query_one("SELECT extract(epoch FROM clock_timestamp())::float8", &[])?
            .get(0))
    }
    pub fn poll_completed(&mut self, started: f64, healthy: bool) -> Result<()> {
        let name = format!(
            "poll-health-{}-{}",
            self.config.shard_index, self.config.shard_count
        );
        let value = json!({"schema":"polis-poll-health/1", "scope":self.poll_scope()?,
            "started":started, "healthy":healthy});
        self.client.execute("INSERT INTO polis_coordinator_cursors(math_env,consumer,position)
            VALUES($1,$2,$3) ON CONFLICT(math_env,consumer) DO UPDATE SET position=excluded.position",
            &[&self.config.math_env,&name,&value])?;
        Ok(())
    }
}
