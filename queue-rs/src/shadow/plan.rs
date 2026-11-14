//! The scheduler's decisions, as pure functions: whether to pause, which
//! conversation is next, and what its admission says.
use super::{
    config::Config,
    db::{Admission, Live, Signals},
    state::State,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Why nothing is admitted now. Closed set; these words are the log's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pause {
    Operator,
    Disk,
    DbLatency,
    MathLag,
    DailyCap,
}

impl Pause {
    pub fn word(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Disk => "disk",
            Self::DbLatency => "db_latency",
            Self::MathLag => "math_lag",
            Self::DailyCap => "daily_cap",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Disk {
    pub free_mb: u64,
    pub used_pct: f64,
}

/// The free space of the filesystem holding `path`.
pub fn disk(path: &std::path::Path) -> std::io::Result<Disk> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::other("path holds NUL"))?;
    // SAFETY: statvfs fills the struct it is given; the path is NUL-terminated.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let block = s.f_frsize as u64;
    let total = s.f_blocks as u64 * block;
    let avail = s.f_bavail as u64 * block;
    let free = s.f_bfree as u64 * block;
    let used_pct = if total == 0 {
        100.0
    } else {
        (total - free) as f64 * 100.0 / total as f64
    };
    Ok(Disk {
        free_mb: avail / (1024 * 1024),
        used_pct,
    })
}

/// The first reason to pause, in a fixed order, with the database-latency
/// hysteresis of the math backfill: once paused for latency, resume only
/// below half the bound.
pub fn pause(
    cfg: &Config,
    state: &State,
    operator: bool,
    disk: Option<Disk>,
    signals: Option<&Signals>,
    paused: Option<Pause>,
) -> Option<Pause> {
    if operator {
        return Some(Pause::Operator);
    }
    match disk {
        // An unreadable disk is a reason to stop, not to guess.
        None => return Some(Pause::Disk),
        Some(d) if d.free_mb < cfg.disk_free_min_mb || d.used_pct > cfg.disk_used_max_pct => {
            return Some(Pause::Disk);
        }
        _ => {}
    }
    let Some(s) = signals else {
        return Some(Pause::DbLatency);
    };
    let bound = cfg.probe_max.as_secs_f64() * 1000.0;
    if s.probe_ms > bound || (paused == Some(Pause::DbLatency) && s.probe_ms > bound / 2.0) {
        return Some(Pause::DbLatency);
    }
    if s.math_lag_ms > cfg.math_lag_max.as_millis() as i64 {
        return Some(Pause::MathLag);
    }
    if state.day_runs >= cfg.daily_runs {
        return Some(Pause::DailyCap);
    }
    None
}

/// What a candidate is, before its comment set is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// Read its comment set: it changed (or was never seen) and may be run.
    Read,
    /// Nothing new since it was last read.
    Unchanged,
    TooSmall,
    TooLarge,
    /// Run within the rerun window.
    Recent,
}

pub fn look(cfg: &Config, state: &State, live: &Live, now_ms: i64) -> Look {
    if live.comments < cfg.min_comments {
        return Look::TooSmall;
    }
    if live.comments > cfg.max_comments {
        return Look::TooLarge;
    }
    let Some(seen) = state.conversations.get(&live.zid) else {
        return Look::Read;
    };
    if let Some(at) = seen.admitted_at_ms
        && now_ms - at < cfg.rerun_after.as_millis() as i64
    {
        return Look::Recent;
    }
    if seen.last_modified == live.last_modified
        && seen.admitted_digest.as_deref() == Some(&seen.digest)
    {
        return Look::Unchanged;
    }
    Look::Read
}

/// The candidates to read, smallest first (then by conversation id), so the
/// first pass learns the cheap sizes before the expensive ones.
pub fn order(cfg: &Config, state: &State, live: &[Live], now_ms: i64) -> Vec<Live> {
    let mut out: Vec<Live> = live
        .iter()
        .filter(|l| look(cfg, state, l, now_ms) == Look::Read)
        .cloned()
        .collect();
    out.sort_by_key(|l| (l.comments, l.zid));
    out
}

/// The size classes of the report (the same bounds as the production counts read).
pub fn size_class(comments: i64) -> &'static str {
    match comments {
        n if n < 20 => "a under 20",
        n if n < 100 => "b 20-99",
        n if n < 1000 => "c 100-999",
        n if n < 5000 => "d 1000-4999",
        _ => "e 5000 up",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The admission of one run. The idempotency key is the comment set itself
/// (with `twin` for its repeat), so a crash and restart within the queue's
/// binding window admits nothing twice; the configuration names the comment
/// set and, on a twin, the run it repeats, and is stored in the job's run
/// record (`config_effective.shadow`).
pub fn admission(zid: i32, digest: &str, comments: i64, twin_of: Option<&str>) -> Admission {
    let config = json!({
        "include_moderation": false,
        "exclude_comment_selections": true,
        "embeddings_table": true,
        "shadow": {
            "schema": "delphi-shadow/1",
            "comment_set_sha256": digest,
            "comments": comments,
            "size_class": size_class(comments),
            "twin_of": twin_of,
            "scheduler": concat!("polis-delphi-shadow ", env!("CARGO_PKG_VERSION")),
        }
    });
    let kind = if twin_of.is_some() { "twin" } else { "first" };
    let key = format!("shadow:{kind}:{zid}:{}", &digest[..digest.len().min(48)]);
    let request = json!({"zid": zid, "kind": kind, "config": config});
    Admission {
        zid,
        key,
        request_sha: sha256_hex(request.to_string().as_bytes()),
        job_id: uuid::Uuid::new_v4(),
        run_id: uuid::Uuid::new_v4(),
        config,
    }
}

/// Rest after a run: d·(1−duty)/duty.
pub fn rest_ms(duty: f64, run_ms: i64) -> i64 {
    ((run_ms.max(0) as f64) * (1.0 - duty) / duty).round() as i64
}

/// Whether the nth first run that succeeded gets a twin.
pub fn twin_due(every: u32, first_runs_succeeded: u64) -> bool {
    every > 0 && first_runs_succeeded.is_multiple_of(u64::from(every))
}

/// The admission outcome's job, when the queue took (or already had) it.
pub fn admitted_job(reply: &Value) -> Option<(String, String)> {
    let outcome = reply.get("outcome")?.as_str()?;
    if !matches!(outcome, "enqueued" | "existing") {
        return None;
    }
    Some((
        outcome.to_owned(),
        reply.get("job_id")?.as_str()?.to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shadow::{config, state::Seen};
    use std::time::Duration;

    fn cfg() -> Config {
        let m: std::collections::HashMap<&str, &str> = [
            ("DELPHI_SHADOW_ENABLED", "1"),
            ("QUEUE_DATABASE_URL", "postgresql://q@127.0.0.1/db"),
            (
                "DELPHI_SHADOW_READ_DATABASE_URL",
                "postgresql://r@127.0.0.1/db",
            ),
            ("POLIS_JOBS_TRANSPORT", "loopback"),
            (
                "DELPHI_SHADOW_CODE_VERSION",
                "0123456789abcdef0123456789abcdef01234567",
            ),
        ]
        .into_iter()
        .collect();
        match config::load(|k| m.get(k).map(|v| (*v).to_owned())) {
            Ok(config::Load::Ready(c)) => *c,
            _ => panic!("config"),
        }
    }

    fn ok_disk() -> Option<Disk> {
        Some(Disk {
            free_mb: 20_000,
            used_pct: 50.0,
        })
    }

    fn signals(probe_ms: f64, lag_ms: i64) -> Signals {
        Signals {
            probe_ms,
            math_lag_ms: lag_ms,
        }
    }

    #[test]
    fn pause_reasons_in_order_with_latency_hysteresis() {
        let c = cfg();
        let mut s = State::new("shadow-delphi-1");
        let fine = signals(5.0, 0);
        assert_eq!(pause(&c, &s, false, ok_disk(), Some(&fine), None), None);
        assert_eq!(pause(&c, &s, true, None, None, None), Some(Pause::Operator));
        assert_eq!(
            pause(&c, &s, false, None, Some(&fine), None),
            Some(Pause::Disk)
        );
        let low = Some(Disk {
            free_mb: 10_000,
            used_pct: 50.0,
        });
        assert_eq!(
            pause(&c, &s, false, low, Some(&fine), None),
            Some(Pause::Disk)
        );
        let full = Some(Disk {
            free_mb: 50_000,
            used_pct: 86.0,
        });
        assert_eq!(
            pause(&c, &s, false, full, Some(&fine), None),
            Some(Pause::Disk)
        );
        assert_eq!(
            pause(&c, &s, false, ok_disk(), None, None),
            Some(Pause::DbLatency)
        );
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&signals(300.0, 0)), None),
            Some(Pause::DbLatency)
        );
        // 200 ms is under the 250 ms bound but over half of it: stay paused.
        let mid = signals(200.0, 0);
        assert_eq!(pause(&c, &s, false, ok_disk(), Some(&mid), None), None);
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&mid), Some(Pause::DbLatency)),
            Some(Pause::DbLatency)
        );
        assert_eq!(
            pause(
                &c,
                &s,
                false,
                ok_disk(),
                Some(&signals(100.0, 0)),
                Some(Pause::DbLatency)
            ),
            None
        );
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&signals(5.0, 181_000)), None),
            Some(Pause::MathLag)
        );
        s.day_runs = c.daily_runs;
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&fine), None),
            Some(Pause::DailyCap)
        );
    }

    #[test]
    fn candidates_are_read_only_when_changed_and_due_smallest_first() {
        let c = cfg();
        let mut s = State::new("shadow-delphi-1");
        let now = 10 * 86_400_000;
        let l = |zid, comments, last_modified| Live {
            zid,
            comments,
            last_modified,
        };
        let live = vec![
            l(1, 300, 9),
            l(2, 25, 9),
            l(3, 19, 9),
            l(4, 6000, 9),
            l(5, 25, 9),
            l(6, 40, 9),
        ];
        // Never seen: read, except outside the size bounds.
        assert_eq!(
            order(&c, &s, &live, now)
                .iter()
                .map(|x| x.zid)
                .collect::<Vec<_>>(),
            vec![2, 5, 6, 1]
        );
        assert_eq!(look(&c, &s, &live[2], now), Look::TooSmall);
        assert_eq!(look(&c, &s, &live[3], now), Look::TooLarge);
        // Admitted a day ago on the same set and nothing changed: unchanged.
        s.conversations.insert(
            2,
            Seen {
                last_modified: 9,
                digest: "d".into(),
                comments: 25,
                admitted_digest: Some("d".into()),
                admitted_at_ms: Some(now - 86_400_000),
                ..Seen::default()
            },
        );
        assert_eq!(look(&c, &s, &live[1], now), Look::Unchanged);
        // Admitted an hour ago: inside the rerun window, whatever changed.
        if let Some(seen) = s.conversations.get_mut(&2) {
            seen.admitted_at_ms = Some(now - 3_600_000);
            seen.last_modified = 1;
        }
        assert_eq!(look(&c, &s, &live[1], now), Look::Recent);
        // A newer comment after the window: read again.
        if let Some(seen) = s.conversations.get_mut(&2) {
            seen.admitted_at_ms = Some(now - 2 * 86_400_000);
        }
        assert_eq!(look(&c, &s, &live[1], now), Look::Read);
        let mut c2 = cfg();
        c2.rerun_after = Duration::ZERO;
        assert_eq!(look(&c2, &s, &live[1], now), Look::Read);
    }

    #[test]
    fn admissions_are_keyed_by_the_comment_set_and_name_it() {
        let digest = "ab".repeat(32);
        let a = admission(7, &digest, 42, None);
        let b = admission(7, &digest, 42, None);
        assert_eq!(a.key, b.key);
        assert_eq!(
            a.request_sha, b.request_sha,
            "the same set is the same request"
        );
        assert_ne!(a.job_id, b.job_id);
        assert!(a.key.len() <= 128);
        assert_eq!(a.config["shadow"]["comment_set_sha256"], digest);
        assert_eq!(a.config["shadow"]["size_class"], "b 20-99");
        assert_eq!(a.config["shadow"]["twin_of"], Value::Null);
        assert_eq!(a.config["include_moderation"], false);
        let t = admission(7, &digest, 42, Some("00000000-0000-4000-8000-000000000001"));
        assert_ne!(t.key, a.key);
        assert_ne!(t.request_sha, a.request_sha);
        assert_eq!(
            t.config["shadow"]["twin_of"],
            "00000000-0000-4000-8000-000000000001"
        );
        assert_ne!(admission(8, &digest, 42, None).key, a.key);
        assert_ne!(admission(7, &"cd".repeat(32), 42, None).key, a.key);
    }

    #[test]
    fn rest_twins_sizes_and_outcomes() {
        assert_eq!(rest_ms(0.5, 60_000), 60_000);
        assert_eq!(rest_ms(1.0, 60_000), 0);
        assert_eq!(rest_ms(0.25, 1000), 3000);
        assert!(!twin_due(0, 0));
        assert!(twin_due(1, 5));
        assert!(twin_due(3, 3) && !twin_due(3, 4));
        assert_eq!(size_class(19), "a under 20");
        assert_eq!(size_class(5000), "e 5000 up");
        assert_eq!(
            admitted_job(&json!({"outcome":"enqueued","job_id":"j"})),
            Some(("enqueued".into(), "j".into()))
        );
        assert_eq!(
            admitted_job(&json!({"outcome":"conflict","job_id":"j"})),
            None
        );
    }

    #[test]
    fn the_disk_of_the_temporary_directory_reads() -> std::io::Result<()> {
        let d = disk(&std::env::temp_dir())?;
        assert!(d.used_pct >= 0.0 && d.used_pct <= 100.0);
        Ok(())
    }
}
