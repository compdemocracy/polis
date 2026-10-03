//! Observability lines (build spec §1.8). Transition lines are bare JSON on
//! their own stderr line; the readiness line uses the math poller's family:
//! `polis_jobs readiness/1 role=<role> progress=<p> {json}`.
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Default)]
pub struct Counters {
    pub claimed: AtomicU64,
    pub finalized: AtomicU64,
    pub failed: AtomicU64,
    pub parked: AtomicU64,
    pub fenced: AtomicU64,
    pub poison: AtomicU64,
    pub exit_unconfirmed: AtomicU64,
}

impl Counters {
    pub fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

static STDERR: Mutex<()> = Mutex::new(());

/// One whole line to stderr, never interleaved with another line.
pub fn emit(line: &str) {
    let _guard = STDERR.lock();
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{line}");
    let _ = err.flush();
}

#[derive(Debug, Clone, Default)]
pub struct Transition {
    pub env: String,
    pub job_id: String,
    pub run_id: Option<String>,
    pub attempt_id: Option<String>,
    pub stage: Option<String>,
    pub phase: Option<String>,
    pub from: String,
    pub to: String,
    pub reason: Option<String>,
    pub exit_code: Option<i32>,
    pub dur_ms: Option<u64>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub owner: String,
}

impl Transition {
    pub fn to_json(&self) -> Value {
        json!({
            "schema": "polis_jobs.transition/1", "env": self.env, "job_id": self.job_id,
            "run_id": self.run_id, "attempt_id": self.attempt_id, "stage": self.stage,
            "phase": self.phase, "from": self.from, "to": self.to, "reason": self.reason,
            "exit_code": self.exit_code, "dur_ms": self.dur_ms, "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out, "owner": self.owner,
        })
    }
    pub fn emit(&self) {
        emit(&self.to_json().to_string());
    }
}

#[derive(Debug, Clone)]
pub struct InFlight {
    pub job_id: String,
    pub stage: String,
    pub started_at: String,
    pub last_heartbeat: Option<String>,
}

pub struct Snapshot<'a> {
    pub env: &'a str,
    pub owner: &'a str,
    pub identity: &'a str,
    pub progress: &'a str,
    pub in_flight: Vec<InFlight>,
    pub counters: &'a Counters,
    pub transport: &'a str,
}

pub fn readiness_line(s: &Snapshot) -> String {
    let c = |a: &AtomicU64| a.load(Ordering::Relaxed);
    let body = json!({
        "schema": "polis_jobs.readiness/1", "env": s.env, "owner": s.owner,
        "identity": s.identity,
        "in_flight": s.in_flight.iter().map(|f| json!({"job_id": f.job_id, "stage": f.stage,
            "started_at": f.started_at, "last_heartbeat": f.last_heartbeat})).collect::<Vec<_>>(),
        "claimed_total": c(&s.counters.claimed), "finalized_total": c(&s.counters.finalized),
        "failed_total": c(&s.counters.failed), "parked_total": c(&s.counters.parked),
        "fenced_total": c(&s.counters.fenced), "poison_total": c(&s.counters.poison),
        "exit_unconfirmed_total": c(&s.counters.exit_unconfirmed),
        "contract": super::rpc::CONTRACT, "transport": s.transport,
    });
    format!(
        "polis_jobs readiness/1 role=worker progress={} {}",
        s.progress, body
    )
}

/// Parse a readiness line back (the shape the ops page reads).
pub fn parse_readiness(line: &str) -> Option<(String, String, Value)> {
    let rest = line.strip_prefix("polis_jobs readiness/1 ")?;
    let (role, rest) = rest.split_once(' ')?;
    let (progress, json) = rest.split_once(' ')?;
    Some((
        role.strip_prefix("role=")?.to_owned(),
        progress.strip_prefix("progress=")?.to_owned(),
        serde_json::from_str(json).ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_round_trips_with_the_closed_field_set() {
        let t = Transition {
            env: "dev".into(),
            job_id: "j".into(),
            from: "running".into(),
            to: "succeeded".into(),
            owner: "o".into(),
            exit_code: Some(0),
            ..Default::default()
        };
        let line = t.to_json().to_string();
        assert!(!line.contains('\n'));
        let back: Value = serde_json::from_str(&line).unwrap_or_default();
        let mut keys: Vec<_> = back
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        let mut expected = vec![
            "schema",
            "env",
            "job_id",
            "run_id",
            "attempt_id",
            "stage",
            "phase",
            "from",
            "to",
            "reason",
            "exit_code",
            "dur_ms",
            "tokens_in",
            "tokens_out",
            "owner",
        ];
        expected.sort();
        assert_eq!(keys, expected);
        assert_eq!(back["schema"], "polis_jobs.transition/1");
    }

    #[test]
    fn readiness_line_parses_next_to_a_prefixed_logger_line() {
        let counters = Counters::default();
        Counters::bump(&counters.exit_unconfirmed);
        let line = readiness_line(&Snapshot {
            env: "dev",
            owner: "o",
            identity: "host:1",
            progress: "idle",
            in_flight: vec![],
            counters: &counters,
            transport: "loopback",
        });
        let log = format!("2026-10-03 INFO polis_jobs claimed job\n{line}\n");
        let found: Vec<_> = log.lines().filter_map(parse_readiness).collect();
        assert_eq!(found.len(), 1);
        let (role, progress, body) = &found[0];
        assert_eq!((role.as_str(), progress.as_str()), ("worker", "idle"));
        assert_eq!(body["schema"], "polis_jobs.readiness/1");
        assert_eq!(body["exit_unconfirmed_total"], 1);
        assert_eq!(body["contract"], "polis-queue/2");
        for key in [
            "claimed_total",
            "finalized_total",
            "failed_total",
            "parked_total",
            "fenced_total",
            "poison_total",
            "in_flight",
            "transport",
            "owner",
            "env",
        ] {
            assert!(body.get(key).is_some(), "{key}");
        }
    }
}
