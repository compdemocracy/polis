//! `Date.now()`. The Node route stamps `lastVoteTimestamp` on a conversation
//! with no math, and times its 3 s caches, with it.
//!
//! Conformance builds (`--features fixture-clock`) honour
//! `POLIS_API_FIXTURE_CLOCK=<ms>`, the counterpart of the characterization
//! harness's frozen `Date.now()`; other builds always read the system clock.

pub fn now_ms() -> f64 {
    #[cfg(feature = "fixture-clock")]
    {
        static FIXED: std::sync::OnceLock<Option<f64>> = std::sync::OnceLock::new();
        if let Some(ms) = FIXED.get_or_init(|| {
            std::env::var("POLIS_API_FIXTURE_CLOCK")
                .ok()
                .and_then(|v| v.parse::<f64>().ok())
        }) {
            return *ms;
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or_default()
}
