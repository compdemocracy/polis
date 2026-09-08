//! CO05 metadata-first reader: independent keyset sweep + paginated window.
//! Durable positions are hints. No durable payload cache is claimed: every page
//! is a cache miss in this command-line consumer, so it loads complete Bundles.
use crate::store::{Bundle, Current, PgStore, ResultsStore};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
impl PgStore {
    pub fn reader_page(&mut self, consumer: &str) -> Result<Vec<Bundle>> {
        ensure!(
            !consumer.is_empty() && consumer.len() < 128,
            "invalid consumer"
        );
        let key = format!("reader-{consumer}");
        let position = self
            .client
            .query_opt(
                "SELECT position FROM coordinator_cursors WHERE math_env=$1 AND consumer=$2",
                &[&self.config.math_env, &key],
            )?
            .map(|r| r.get::<_, Value>(0))
            .unwrap_or(json!({}));
        let high = position["high"].as_i64().unwrap_or(0);
        let after_tick = position["after_tick"].as_i64().unwrap_or(-1);
        let after_zid = position["after_zid"].as_i64().unwrap_or(0) as i32;
        let sweep = position["sweep"].as_i64().unwrap_or(0) as i32;
        let maximum = position["maximum"].as_i64().unwrap_or(high);
        self.fault.hit("before_cursor", &position)?;
        let fast = self.poll_changes(
            high,
            self.config.window,
            (after_tick, after_zid),
            self.config.page_size,
        )?;
        let maximum = fast
            .iter()
            .map(|m| m.caching_tick)
            .max()
            .unwrap_or(maximum)
            .max(maximum);
        let next_fast = if fast.len() == self.config.page_size as usize {
            fast.last().map(|m| (m.caching_tick, m.zid))
        } else {
            None
        };
        self.fault.hit("before_sweep", &position)?;
        let scanned = self.scan_current(sweep, self.config.page_size)?;
        let next_sweep = if scanned.len() == self.config.page_size as usize {
            scanned.last().map_or(0, |m| m.zid)
        } else {
            0
        };
        self.fault.hit(
            "after_sweep",
            &json!({"rows":scanned,"next_sweep":next_sweep}),
        )?;
        let mut ids = std::collections::BTreeSet::new();
        let mut bundles = Vec::new();
        for meta in fast.iter().chain(scanned.iter()) {
            if ids.insert(meta.zid) {
                match self.load_current(meta.zid)? {
                    Current::Coherent(bundle) => {
                        ensure!(bundle.math_tick >= meta.math_tick, "generation regressed");
                        bundles.push(*bundle);
                    }
                    _ => {
                        anyhow::bail!("reader found incomplete generation; retry page after repair")
                    }
                }
            }
        }
        let next = json!({"high":if next_fast.is_some(){high}else{maximum},"maximum":maximum,
            "after_tick":next_fast.map_or(-1,|p|p.0),"after_zid":next_fast.map_or(0,|p|p.1),"sweep":next_sweep});
        self.client.execute("INSERT INTO coordinator_cursors(math_env,consumer,position) VALUES($1,$2,$3) ON CONFLICT(math_env,consumer) DO UPDATE SET position=excluded.position",&[&self.config.math_env,&key,&next])?;
        self.fault.hit("after_cursor", &next)?;
        Ok(bundles)
    }
}
