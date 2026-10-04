//! `polis-jobs`: the daemon that runs Delphi jobs on the `polis-queue/2`
//! Postgres queue (migration 000023). It claims with a worker class, holds a
//! 120 s lease renewed every 30 s, runs the unchanged pipeline as a child in
//! its own process group, records the child's output in `polis_queue_logs`,
//! and ends every attempt through the `/2` exit-proof forms. It is off unless
//! `POLIS_JOBS_ENABLED=1`; nothing in compose, hooks or deploys starts it.
pub mod child;
pub mod claim;
pub mod config;
pub mod journal;
pub mod lease;
pub mod logs;
pub mod manifest;
pub mod outcome;
pub mod readiness;
pub mod reaper;
pub mod rpc;
pub mod shutdown;
pub mod task;
pub mod transport;

use sha2::{Digest, Sha256};

/// Lowercase hex sha256 of exact bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// RFC 3339 UTC timestamp with millisecond precision, without a date crate.
pub fn now_rfc3339() -> String {
    rfc3339(std::time::SystemTime::now())
}

pub fn rfc3339(t: std::time::SystemTime) -> String {
    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        d.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc3339_known_instants() {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_759_449_600_123);
        assert_eq!(rfc3339(t), "2025-10-03T00:00:00.123Z");
        assert_eq!(rfc3339(std::time::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
