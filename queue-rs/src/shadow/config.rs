//! Environment → the scheduler's `Config`. Off unless
//! `DELPHI_SHADOW_ENABLED=1`; an invalid setting refuses to start with one
//! line and exit code 2, as `polis-jobs` does.
use crate::jobs::config::TransportKind;
use std::{path::PathBuf, time::Duration};

/// The result env every shadow run is admitted under unless
/// `DELPHI_SHADOW_ENV` names another. No reader serves it.
pub const DEFAULT_ENV: &str = "shadow-delphi-1";
/// Every shadow env starts with this. A name without it is refused, so a
/// shadow run can never be admitted under the env a reader serves.
pub const ENV_PREFIX: &str = "shadow-";
/// The publication scope inside the shadow env (production's full runs use the
/// same name inside their own env).
pub const SCOPE: &str = "delphi";
/// The admission's actor.
pub const ACTOR: &str = "delphi-shadow";

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// The queue login (a member of `polis_queue_executor`): admission, job
    /// status, run records and the shadow env's current result rows.
    pub queue_dsn: String,
    /// The login whose reads the scheduler makes on `comments`,
    /// `conversations`, `math_main` and the newest vote's time, each in one
    /// read-only transaction on a connection opened for it and closed after.
    pub read_dsn: String,
    pub transport: TransportKind,
    pub password_file: Option<PathBuf>,
    pub env: String,
    /// The code version admissions carry (40 to 64 lowercase hex).
    pub code_version: String,
    /// The label the math engine writes, for its lag.
    pub math_env: String,
    pub live_days: u64,
    pub min_comments: i64,
    pub max_comments: i64,
    pub daily_runs: u32,
    pub rerun_after: Duration,
    pub poll: Duration,
    pub job_poll: Duration,
    pub job_deadline: Duration,
    /// Every Nth first run on a comment set is repeated once on the same set;
    /// 0 is off.
    pub twin_every: u32,
    /// The share of wall time spent running: after a run of length d the
    /// scheduler rests d·(1−duty)/duty before the next admission.
    pub duty_cycle: f64,
    /// Pause while the median of three `SELECT 1` round trips exceeds this;
    /// resume below half of it.
    pub probe_max: Duration,
    /// Pause while the math engine trails the newest vote by more than this.
    pub math_lag_max: Duration,
    /// The filesystem whose free space bounds the shadow (the container's root,
    /// which is the host's Docker disk).
    pub disk_path: PathBuf,
    pub disk_free_min_mb: u64,
    pub disk_used_max_pct: f64,
    /// While this file exists, nothing is admitted (the operator's pause).
    pub pause_file: PathBuf,
    pub state_path: PathBuf,
    pub statement_timeout: Duration,
}

#[derive(Debug)]
pub enum Load {
    Disabled,
    Ready(Box<Config>),
}

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "polis-delphi-shadow: {}", self.0)
    }
}

fn err<T>(m: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(m.into()))
}

fn number<F: Fn(&str) -> Option<String>>(
    get: &F,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, ConfigError> {
    let Some(raw) = get(key).filter(|v| !v.trim().is_empty()) else {
        return Ok(default);
    };
    match raw.trim().parse::<u64>() {
        Ok(v) if (min..=max).contains(&v) => Ok(v),
        _ => err(format!("{key} must be an integer in {min}..={max}")),
    }
}

fn fraction<F: Fn(&str) -> Option<String>>(
    get: &F,
    key: &str,
    default: f64,
    min: f64,
    max: f64,
) -> Result<f64, ConfigError> {
    let Some(raw) = get(key).filter(|v| !v.trim().is_empty()) else {
        return Ok(default);
    };
    match raw.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v >= min && v <= max => Ok(v),
        _ => err(format!("{key} must be a number in {min}..={max}")),
    }
}

/// A shadow env: the prefix, then 1 to 57 characters of `[a-z0-9_-]`.
pub fn valid_env(env: &str) -> bool {
    env.strip_prefix(ENV_PREFIX).is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 57
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    })
}

pub fn load<F: Fn(&str) -> Option<String>>(get: F) -> Result<Load, ConfigError> {
    if get("DELPHI_SHADOW_ENABLED").as_deref() != Some("1") {
        return Ok(Load::Disabled);
    }
    let queue_dsn = match get("QUEUE_DATABASE_URL") {
        Some(v) if !v.trim().is_empty() => v,
        _ => return err("QUEUE_DATABASE_URL is required"),
    };
    let read_dsn = match get("DELPHI_SHADOW_READ_DATABASE_URL") {
        Some(v) if !v.trim().is_empty() => v,
        _ => return err("DELPHI_SHADOW_READ_DATABASE_URL is required"),
    };
    let env = get("DELPHI_SHADOW_ENV")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_ENV.into());
    if !valid_env(&env) {
        return err(format!(
            "DELPHI_SHADOW_ENV must be {ENV_PREFIX} then 1-57 characters of [a-z0-9_-]: a shadow run is never admitted under a served env"
        ));
    }
    // The daemon this scheduler feeds claims QUEUE_ENV; both must name the
    // shadow env, so a misconfigured pair refuses instead of queueing work no
    // daemon will run (or, worse, a production daemon would).
    if let Some(queue_env) = get("QUEUE_ENV").filter(|v| !v.is_empty())
        && queue_env != env
    {
        return err("QUEUE_ENV, when set, must equal DELPHI_SHADOW_ENV");
    }
    let code_version = get("DELPHI_SHADOW_CODE_VERSION").unwrap_or_default();
    if !(40..=64).contains(&code_version.len())
        || !code_version
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return err("DELPHI_SHADOW_CODE_VERSION must be 40-64 lowercase hex (the source commit)");
    }
    let transport = match get("POLIS_JOBS_TRANSPORT").as_deref().unwrap_or("tls") {
        "tls" => {
            let Some(ca) = get("POLIS_JOBS_CA_FILE").filter(|s| !s.is_empty()) else {
                return err("tls transport requires POLIS_JOBS_CA_FILE");
            };
            let hosts: Vec<String> = get("POLIS_JOBS_HOST_ALLOWLIST")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            if hosts.is_empty() {
                return err("tls transport requires POLIS_JOBS_HOST_ALLOWLIST");
            }
            TransportKind::Tls {
                ca_file: PathBuf::from(ca),
                host_allowlist: hosts,
            }
        }
        "local" => TransportKind::Local,
        "loopback" => TransportKind::Loopback,
        _ => return err("POLIS_JOBS_TRANSPORT must be tls, local or loopback"),
    };
    let math_env = get("DELPHI_SHADOW_MATH_ENV")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "python".into());
    let min_comments = number(&get, "DELPHI_SHADOW_MIN_COMMENTS", 20, 5, 100_000)?;
    let max_comments = number(&get, "DELPHI_SHADOW_MAX_COMMENTS", 5000, 5, 1_000_000)?;
    if min_comments > max_comments {
        return err("DELPHI_SHADOW_MIN_COMMENTS must not exceed DELPHI_SHADOW_MAX_COMMENTS");
    }
    let state_dir = PathBuf::from("/var/lib/delphi-shadow");
    Ok(Load::Ready(Box::new(Config {
        queue_dsn,
        read_dsn,
        transport,
        password_file: get("POLIS_JOBS_PASSWORD_FILE")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
        env,
        code_version,
        math_env,
        live_days: number(&get, "DELPHI_SHADOW_LIVE_DAYS", 30, 1, 36500)?,
        min_comments: min_comments as i64,
        max_comments: max_comments as i64,
        daily_runs: number(&get, "DELPHI_SHADOW_DAILY_RUNS", 200, 1, 100_000)? as u32,
        rerun_after: Duration::from_secs(number(
            &get,
            "DELPHI_SHADOW_RERUN_AFTER_SECONDS",
            86400,
            0,
            365 * 86400,
        )?),
        poll: Duration::from_secs(number(&get, "DELPHI_SHADOW_POLL_SECONDS", 60, 1, 86400)?),
        job_poll: Duration::from_secs(number(&get, "DELPHI_SHADOW_JOB_POLL_SECONDS", 5, 1, 3600)?),
        job_deadline: Duration::from_secs(number(
            &get,
            "DELPHI_SHADOW_JOB_DEADLINE_SECONDS",
            4 * 3600,
            60,
            7 * 86400,
        )?),
        twin_every: number(&get, "DELPHI_SHADOW_TWIN_EVERY", 0, 0, 1_000_000)? as u32,
        duty_cycle: fraction(&get, "DELPHI_SHADOW_DUTY_CYCLE", 0.5, 0.05, 1.0)?,
        probe_max: Duration::from_millis(number(
            &get,
            "DELPHI_SHADOW_PROBE_MAX_MS",
            250,
            1,
            600_000,
        )?),
        math_lag_max: Duration::from_secs(number(
            &get,
            "DELPHI_SHADOW_MATH_LAG_MAX_SECONDS",
            180,
            1,
            86400,
        )?),
        disk_path: PathBuf::from(get("DELPHI_SHADOW_DISK_PATH").unwrap_or_else(|| "/".into())),
        disk_free_min_mb: number(&get, "DELPHI_SHADOW_DISK_FREE_MIN_MB", 10240, 0, 1 << 40)?,
        disk_used_max_pct: fraction(&get, "DELPHI_SHADOW_DISK_USED_MAX_PCT", 85.0, 1.0, 100.0)?,
        pause_file: get("DELPHI_SHADOW_PAUSE_FILE")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| state_dir.join("pause")),
        state_path: get("DELPHI_SHADOW_STATE_PATH")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| state_dir.join("state.json")),
        statement_timeout: Duration::from_millis(number(
            &get,
            "DELPHI_SHADOW_STATEMENT_TIMEOUT_MS",
            30_000,
            100,
            600_000,
        )?),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn base() -> HashMap<&'static str, String> {
        [
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
        .map(|(k, v)| (k, v.to_owned()))
        .collect()
    }

    fn with(changes: &[(&'static str, Option<&str>)]) -> Result<Load, ConfigError> {
        let mut m = base();
        for (k, v) in changes {
            match v {
                Some(v) => m.insert(k, (*v).to_owned()),
                None => m.remove(k),
            };
        }
        load(|k| m.get(k).cloned())
    }

    fn ready(changes: &[(&'static str, Option<&str>)]) -> Config {
        match with(changes) {
            Ok(Load::Ready(c)) => *c,
            other => panic!("not ready: {other:?}"),
        }
    }

    #[test]
    fn off_unless_exactly_one() {
        for v in [None, Some(""), Some("0"), Some("true"), Some(" 1")] {
            assert!(matches!(
                with(&[("DELPHI_SHADOW_ENABLED", v)]),
                Ok(Load::Disabled)
            ));
        }
    }

    #[test]
    fn the_defaults_are_the_shadow_env_and_the_paced_bounds() {
        let c = ready(&[]);
        assert_eq!(c.env, "shadow-delphi-1");
        assert_eq!(c.math_env, "python");
        assert_eq!((c.min_comments, c.max_comments), (20, 5000));
        assert_eq!(c.twin_every, 0, "twin runs are off unless asked");
        assert_eq!(c.duty_cycle, 0.5);
        assert_eq!(c.disk_free_min_mb, 10240);
        assert_eq!(c.pause_file, PathBuf::from("/var/lib/delphi-shadow/pause"));
    }

    #[test]
    fn a_served_env_is_refused() {
        for env in [
            "import-dynamo-prod-3",
            "prod",
            "local",
            "shadow-",
            "shadow-UPPER",
            "shadowdelphi",
            "xshadow-delphi",
        ] {
            assert!(with(&[("DELPHI_SHADOW_ENV", Some(env))]).is_err(), "{env}");
        }
        assert_eq!(
            ready(&[("DELPHI_SHADOW_ENV", Some("shadow-twin-1"))]).env,
            "shadow-twin-1"
        );
        assert!(
            with(&[("QUEUE_ENV", Some("import-dynamo-prod-3"))]).is_err(),
            "a daemon env that is not the shadow env is refused"
        );
        assert!(matches!(
            with(&[("QUEUE_ENV", Some("shadow-delphi-1"))]),
            Ok(Load::Ready(_))
        ));
    }

    #[test]
    fn required_settings_and_bounds() {
        assert!(with(&[("QUEUE_DATABASE_URL", None)]).is_err());
        assert!(with(&[("DELPHI_SHADOW_READ_DATABASE_URL", None)]).is_err());
        assert!(with(&[("DELPHI_SHADOW_CODE_VERSION", Some("abc"))]).is_err());
        assert!(with(&[("DELPHI_SHADOW_CODE_VERSION", Some(&"G".repeat(40)))]).is_err());
        assert!(
            with(&[("POLIS_JOBS_TRANSPORT", None)]).is_err(),
            "tls needs a CA"
        );
        assert!(with(&[("DELPHI_SHADOW_DUTY_CYCLE", Some("0"))]).is_err());
        assert!(with(&[("DELPHI_SHADOW_DUTY_CYCLE", Some("NaN"))]).is_err());
        assert!(
            with(&[
                ("DELPHI_SHADOW_MIN_COMMENTS", Some("100")),
                ("DELPHI_SHADOW_MAX_COMMENTS", Some("50"))
            ])
            .is_err()
        );
        assert!(with(&[("DELPHI_SHADOW_MIN_COMMENTS", Some("4"))]).is_err());
    }
}
