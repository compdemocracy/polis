//! What the scheduler remembers between cycles and restarts: one JSON file,
//! written whole and renamed into place.
//!
//! The database is the record of what ran (every admission is a job with its
//! run record); this file only says what the scheduler last saw and admitted
//! per conversation, so an unchanged comment set is not run again, and holds
//! the counts of the report. Losing it costs at most one more run per live
//! conversation: an admission's idempotency key is the comment set's digest,
//! and the queue answers `existing` to the same key for a day.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

pub const SCHEMA: &str = "polis-delphi-shadow-state/1";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Seen {
    /// The newest `comments.modified` of the conversation when last read.
    pub last_modified: i64,
    /// The comment set's digest (`polis-jobs.comment-set/1`) when last read.
    pub digest: String,
    pub comments: i64,
    /// The digest of the last admitted run, and when (ms since the epoch).
    pub admitted_digest: Option<String>,
    pub admitted_at_ms: Option<i64>,
    pub job_id: Option<String>,
    /// The last run's terminal state (`succeeded`, `dead`, ...).
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InFlight {
    pub zid: i32,
    pub job_id: String,
    pub digest: String,
    pub comments: i64,
    pub admitted_at_ms: i64,
    /// Set on a twin run: the job it repeats.
    pub twin_of: Option<String>,
}

/// A twin waiting to be admitted, with what the first run's clustering was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingTwin {
    pub zid: i32,
    pub first_job_id: String,
    pub digest: String,
    pub comments: i64,
    /// The first run's assignments: comment id → one cluster id per layer.
    pub assignments: BTreeMap<i64, Vec<i64>>,
    /// The twin's job, once admitted.
    #[serde(default)]
    pub twin_job_id: Option<String>,
}

/// How many twin comparisons the state file keeps (the newest).
pub const TWIN_RESULTS_KEPT: usize = 500;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Totals {
    pub admitted: u64,
    pub succeeded: u64,
    pub failed: u64,
    /// A conversation whose comments changed in time but whose comment set did
    /// not, or a rerun window that elapsed on an unchanged set: a run here would
    /// have recomputed what is already stored.
    pub unchanged: u64,
    /// At the last cycle that found nothing to run: how many live
    /// conversations were below the comment floor, and above the cap.
    pub too_small: u64,
    pub too_large: u64,
    pub twins_admitted: u64,
    pub twins_compared: u64,
    pub twins_identical: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub schema: String,
    pub env: String,
    pub conversations: BTreeMap<i32, Seen>,
    pub in_flight: Option<InFlight>,
    pub pending_twin: Option<PendingTwin>,
    /// The UTC day (days since the epoch) the daily count is for.
    pub day: i64,
    pub day_runs: u32,
    /// First runs that succeeded, for the twin sample.
    pub first_runs_succeeded: u64,
    pub totals: Totals,
    /// The newest twin comparisons (`twin::Comparison` with both job ids).
    #[serde(default)]
    pub twin_results: Vec<serde_json::Value>,
    /// The bytes the shadow has added to the database (`storage`). A state
    /// file without it lists the shadow's jobs from the database again.
    #[serde(default)]
    pub storage: crate::shadow::storage::Ledger,
}

impl State {
    pub fn new(env: &str) -> Self {
        Self {
            schema: SCHEMA.into(),
            env: env.into(),
            conversations: BTreeMap::new(),
            in_flight: None,
            pending_twin: None,
            day: 0,
            day_runs: 0,
            first_runs_succeeded: 0,
            totals: Totals::default(),
            twin_results: Vec::new(),
            storage: Default::default(),
        }
    }

    /// The file's state, or a new one when there is no file. A file for another
    /// env, another schema or one that does not parse is an error: the operator
    /// decides, the scheduler does not overwrite it.
    pub fn load(path: &Path, env: &str) -> anyhow::Result<Self> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::new(env)),
            Err(e) => return Err(e.into()),
        };
        let state: Self = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(state.schema == SCHEMA, "state file schema {}", state.schema);
        anyhow::ensure!(state.env == env, "state file is for env {}", state.env);
        Ok(state)
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Start a new daily count when the UTC day changes.
    pub fn roll_day(&mut self, now_ms: i64) {
        let day = now_ms.div_euclid(86_400_000);
        if day != self.day {
            self.day = day;
            self.day_runs = 0;
        }
        self.storage.roll_day(now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_refusals() -> anyhow::Result<()> {
        let dir =
            std::env::temp_dir().join(format!("delphi-shadow-state-{}", uuid::Uuid::new_v4()));
        let path = dir.join("state.json");
        assert_eq!(
            State::load(&path, "shadow-delphi-1")?,
            State::new("shadow-delphi-1")
        );
        let mut s = State::new("shadow-delphi-1");
        s.conversations.insert(
            7,
            Seen {
                last_modified: 5,
                digest: "d".into(),
                comments: 30,
                ..Seen::default()
            },
        );
        s.pending_twin = Some(PendingTwin {
            zid: 7,
            first_job_id: "j".into(),
            digest: "d".into(),
            comments: 30,
            assignments: [(1, vec![0, 1]), (2, vec![-1, 1])].into_iter().collect(),
            twin_job_id: None,
        });
        s.save(&path)?;
        assert_eq!(State::load(&path, "shadow-delphi-1")?, s);
        assert!(State::load(&path, "shadow-other-1").is_err());
        std::fs::write(&path, b"{")?;
        assert!(State::load(&path, "shadow-delphi-1").is_err());
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn the_daily_count_restarts_each_utc_day() {
        let mut s = State::new("shadow-delphi-1");
        s.roll_day(86_400_000 * 3 + 5);
        s.day_runs = 9;
        s.roll_day(86_400_000 * 4 - 1);
        assert_eq!(s.day_runs, 9);
        s.roll_day(86_400_000 * 4);
        assert_eq!((s.day, s.day_runs), (4, 0));
    }
}
