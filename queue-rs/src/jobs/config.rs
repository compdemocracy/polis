//! Environment → `Config`, with validation and redaction (build spec §1.2).
//! An invalid combination refuses to start with one line and exit code 2.
use std::{collections::BTreeSet, path::PathBuf, time::Duration};

/// The stages of class `delphi`, which `polis-queue/2` admits (000023
/// `polis_queue_jobs_stage_check`).
pub const KNOWN_STAGES: [&str; 2] = ["delphi_full_pipeline", "delphi_narrative"];
/// The stages of class `large`, which `polis-queue/3` admits (000024).
pub const LARGE_STAGES: [&str; 1] = ["math_rebuild"];

/// The worker class the daemon claims as (`POLIS_JOBS_WORKER_CLASS`). Each
/// class has its own closed stage list and the contracts it may run on:
/// `delphi` runs on `/2` or `/3` (its stages and RPCs are the same under
/// both), `large` exists only from `/3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerClass {
    Delphi,
    Large,
}

impl WorkerClass {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "delphi" => Some(Self::Delphi),
            "large" => Some(Self::Large),
            _ => None,
        }
    }

    /// The value `pq_claim` and `pq_reap` take.
    pub fn name(self) -> &'static str {
        match self {
            Self::Delphi => "delphi",
            Self::Large => "large",
        }
    }

    /// The stages a worker of this class may admit.
    pub fn stages(self) -> &'static [&'static str] {
        match self {
            Self::Delphi => &KNOWN_STAGES,
            Self::Large => &LARGE_STAGES,
        }
    }

    /// The installed contracts (`polis_queue_install.contract_version`) a
    /// worker of this class may start on.
    pub fn contracts(self) -> &'static [&'static str] {
        match self {
            Self::Delphi => &["polis-queue/2", "polis-queue/3"],
            Self::Large => &["polis-queue/3"],
        }
    }

    pub fn admits_contract(self, installed: &str) -> bool {
        self.contracts().contains(&installed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportKind {
    /// Verify-full TLS against a pinned CA file and an exact host allowlist.
    Tls {
        ca_file: PathBuf,
        host_allowlist: Vec<String>,
    },
    /// Unix socket (peer auth). Refused unless `POLIS_JOBS_TRANSPORT=local`.
    Local,
    /// NoTls to a literal loopback IP only (dev/test).
    Loopback,
}

impl TransportKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Tls { .. } => "tls",
            Self::Local => "local",
            Self::Loopback => "loopback",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub dsn: String,
    pub env: String,
    pub transport: TransportKind,
    pub password_file: Option<PathBuf>,
    pub worker_class: WorkerClass,
    pub stages: BTreeSet<String>,
    pub lease_seconds: u32,
    pub heartbeat_seconds: u32,
    pub child_timeout: Duration,
    pub max_attempts: u32,
    pub poll: Duration,
    pub log_max_lines: u64,
    pub log_max_bytes: u64,
    pub log_batch_lines: usize,
    pub log_batch_interval: Duration,
    pub concurrency: usize,
    pub app_path: PathBuf,
    pub python: String,
    pub readiness: Duration,
    pub identity: String,
    pub journal_dir: PathBuf,
    pub work_dir: PathBuf,
    pub shutdown_grace: Duration,
    pub kill_grace: Duration,
    pub reap_interval: Duration,
    /// The built-in queue sweep (000026, P-083): off unless
    /// `POLIS_JOBS_SWEEP=1`; at most `sweep_max_pages` pages per sweep; page 1
    /// asked every `sweep_check` while idle (the SQL answers not_due within
    /// 24 h of the last sweep).
    pub sweep: bool,
    pub sweep_max_pages: u32,
    pub sweep_check: Duration,
    pub boot_id: String,
    pub container_id: String,
}

#[derive(Debug)]
pub enum Load {
    /// `POLIS_JOBS_ENABLED` is not `1`: exit 0 immediately.
    Disabled,
    Ready(Box<Config>),
}

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "polis_jobs config refused: {}", self.0)
    }
}

fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

fn number<F: Fn(&str) -> Option<String>>(
    get: &F,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, ConfigError> {
    let Some(raw) = get(key) else {
        return Ok(default);
    };
    match raw.trim().parse::<u64>() {
        Ok(v) if (min..=max).contains(&v) => Ok(v),
        _ => err(format!("{key} must be an integer in {min}..={max}")),
    }
}

/// Load from a key lookup (the process environment in production, a map in tests).
pub fn load<F: Fn(&str) -> Option<String>>(get: F) -> Result<Load, ConfigError> {
    if get("POLIS_JOBS_ENABLED").as_deref() != Some("1") {
        return Ok(Load::Disabled);
    }
    let dsn = match get("QUEUE_DATABASE_URL") {
        Some(v) if !v.trim().is_empty() => v,
        _ => return err("QUEUE_DATABASE_URL is required"),
    };
    let env = get("QUEUE_ENV").unwrap_or_default();
    if env.is_empty()
        || env.len() > 64
        || !env
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return err("QUEUE_ENV must be 1-64 characters of [a-z0-9_-]");
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
    let worker_class = get("POLIS_JOBS_WORKER_CLASS").unwrap_or_else(|| "delphi".into());
    let Some(worker_class) = WorkerClass::parse(&worker_class) else {
        return err("POLIS_JOBS_WORKER_CLASS must be delphi or large");
    };
    let stages: BTreeSet<String> = get("POLIS_JOBS_STAGES")
        .unwrap_or_else(|| worker_class.stages().join(","))
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if stages.is_empty()
        || stages
            .iter()
            .any(|s| !worker_class.stages().contains(&s.as_str()))
    {
        return err(format!(
            "POLIS_JOBS_STAGES must be a non-empty subset of {} (the stages of class {})",
            worker_class.stages().join(","),
            worker_class.name()
        ));
    }
    let lease = number(&get, "POLIS_JOBS_LEASE_SECONDS", 120, 10, 900)?;
    let heartbeat = number(&get, "POLIS_JOBS_HEARTBEAT_SECONDS", 30, 1, 900)?;
    if heartbeat * 3 >= lease {
        return err("POLIS_JOBS_HEARTBEAT_SECONDS must be less than lease/3");
    }
    let child_timeout = number(
        &get,
        "POLIS_JOBS_CHILD_TIMEOUT_SECONDS",
        14400,
        1,
        7 * 86400,
    )?;
    let max_attempts = number(&get, "POLIS_JOBS_MAX_ATTEMPTS", 3, 1, 100)?;
    let poll = number(&get, "POLIS_JOBS_POLL_SECONDS", 5, 1, 3600)?;
    let log_max_lines = number(&get, "POLIS_JOBS_LOG_MAX_LINES", 20000, 1, 100_000_000)?;
    let log_max_bytes = number(&get, "POLIS_JOBS_LOG_MAX_BYTES", 8_388_608, 1024, 1 << 34)?;
    let log_batch = number(&get, "POLIS_JOBS_LOG_BATCH", 50, 1, 10_000)?;
    let log_batch_ms = number(&get, "POLIS_JOBS_LOG_BATCH_MS", 2000, 10, 600_000)?;
    let concurrency = number(&get, "POLIS_JOBS_CONCURRENCY", 1, 1, 64)?;
    let readiness = number(&get, "POLIS_JOBS_READINESS_SECONDS", 60, 1, 86400)?;
    let shutdown_grace = number(&get, "POLIS_JOBS_SHUTDOWN_GRACE_SECONDS", 30, 0, 3600)?;
    let kill_grace = number(&get, "POLIS_JOBS_KILL_GRACE_SECONDS", 10, 0, 3600)?;
    let reap = number(&get, "POLIS_JOBS_REAP_SECONDS", lease, 1, 3600)?;
    let sweep = match get("POLIS_JOBS_SWEEP").as_deref() {
        None | Some("0") => false,
        Some("1") => true,
        Some(_) => return err("POLIS_JOBS_SWEEP must be 0 or 1"),
    };
    let sweep_max_pages = number(&get, "POLIS_JOBS_SWEEP_MAX_PAGES", 100, 1, 1000)?;
    let sweep_check = number(&get, "POLIS_JOBS_SWEEP_CHECK_SECONDS", 900, 1, 86400)?;
    let journal_dir = PathBuf::from(
        get("POLIS_JOBS_JOURNAL_DIR").unwrap_or_else(|| "/var/lib/polis-jobs/journal".into()),
    );
    let work_dir = PathBuf::from(get("POLIS_JOBS_WORK_DIR").unwrap_or_else(|| {
        std::env::temp_dir()
            .join("polis-jobs")
            .to_string_lossy()
            .into_owned()
    }));
    let identity = get("POLIS_JOBS_IDENTITY")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}:{}", hostname(), std::process::id()));
    let boot_id = get("POLIS_JOBS_BOOT_ID")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(read_boot_id);
    let container_id = get("POLIS_JOBS_CONTAINER_ID")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(hostname);
    Ok(Load::Ready(Box::new(Config {
        dsn,
        env,
        transport,
        password_file: get("POLIS_JOBS_PASSWORD_FILE")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
        worker_class,
        stages,
        lease_seconds: lease as u32,
        heartbeat_seconds: heartbeat as u32,
        child_timeout: Duration::from_secs(child_timeout),
        max_attempts: max_attempts as u32,
        poll: Duration::from_secs(poll),
        log_max_lines,
        log_max_bytes,
        log_batch_lines: log_batch as usize,
        log_batch_interval: Duration::from_millis(log_batch_ms),
        concurrency: concurrency as usize,
        app_path: PathBuf::from(get("DELPHI_APP_PATH").unwrap_or_else(|| "/app".into())),
        python: get("POLIS_JOBS_PYTHON").unwrap_or_else(|| "python".into()),
        readiness: Duration::from_secs(readiness),
        identity,
        journal_dir,
        work_dir,
        shutdown_grace: Duration::from_secs(shutdown_grace),
        kill_grace: Duration::from_secs(kill_grace),
        reap_interval: Duration::from_secs(reap),
        sweep,
        sweep_max_pages: sweep_max_pages as u32,
        sweep_check: Duration::from_secs(sweep_check),
        boot_id,
        container_id,
    })))
}

impl Config {
    /// The DSN with any password removed, for logs.
    pub fn redacted_dsn(&self) -> String {
        redact(&self.dsn)
    }
}

/// Only host(s), port(s), database and user, parsed by the driver; no
/// password form (URL userinfo, `?password=`, quoted key/value) can leak.
pub fn redact(dsn: &str) -> String {
    let Ok(c) = dsn.parse::<postgres::Config>() else {
        return "<unparseable DSN>".into();
    };
    let hosts = c
        .get_hosts()
        .iter()
        .map(|h| match h {
            postgres::config::Host::Tcp(s) => s.clone(),
            #[cfg(unix)]
            postgres::config::Host::Unix(p) => p.display().to_string(),
        })
        .collect::<Vec<_>>()
        .join(",");
    let ports = c
        .get_ports()
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "host={hosts} port={} dbname={} user={}",
        if ports.is_empty() { "-".into() } else { ports },
        c.get_dbname().unwrap_or("-"),
        c.get_user().unwrap_or("-")
    )
}

pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: buf is valid for its length; gethostname NUL-terminates on success.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return "unknown-host".into();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

fn read_boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|s| s.trim().to_owned())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown-boot".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(pairs: &[(&str, &str)]) -> Result<Load, ConfigError> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        load(|k| map.get(k).cloned())
    }

    fn ready(pairs: &[(&str, &str)]) -> Config {
        match with(pairs) {
            Ok(Load::Ready(c)) => *c,
            other => panic!("expected ready config, got {other:?}"),
        }
    }

    const BASE: [(&str, &str); 4] = [
        ("POLIS_JOBS_ENABLED", "1"),
        ("QUEUE_DATABASE_URL", "postgresql://jobs@127.0.0.1:5432/db"),
        ("QUEUE_ENV", "dev"),
        ("POLIS_JOBS_TRANSPORT", "loopback"),
    ];

    #[test]
    fn disabled_unless_exactly_one() {
        for value in [None, Some("0"), Some("true"), Some("yes"), Some("")] {
            let mut pairs = vec![];
            if let Some(v) = value {
                pairs.push(("POLIS_JOBS_ENABLED", v));
            }
            assert!(matches!(with(&pairs), Ok(Load::Disabled)), "{value:?}");
        }
    }

    #[test]
    fn defaults_match_the_spec_table() {
        let c = ready(&BASE);
        assert_eq!(c.lease_seconds, 120);
        assert_eq!(c.heartbeat_seconds, 30);
        assert_eq!(c.child_timeout, Duration::from_secs(14400));
        assert_eq!(c.max_attempts, 3);
        assert_eq!(c.poll, Duration::from_secs(5));
        assert_eq!((c.log_max_lines, c.log_max_bytes), (20000, 8_388_608));
        assert_eq!(c.log_batch_lines, 50);
        assert_eq!(c.log_batch_interval, Duration::from_secs(2));
        assert_eq!(c.concurrency, 1);
        assert_eq!(c.worker_class, WorkerClass::Delphi);
        assert_eq!(c.app_path, PathBuf::from("/app"));
        assert_eq!(c.python, "python");
        assert_eq!(c.readiness, Duration::from_secs(60));
        assert_eq!(c.journal_dir, PathBuf::from("/var/lib/polis-jobs/journal"));
        assert_eq!(c.shutdown_grace, Duration::from_secs(30));
        assert_eq!(c.kill_grace, Duration::from_secs(10));
        assert_eq!(c.reap_interval, Duration::from_secs(120));
        assert!(!c.sweep);
        assert_eq!(c.sweep_max_pages, 100);
        assert_eq!(c.sweep_check, Duration::from_secs(900));
        assert_eq!(
            c.stages.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["delphi_full_pipeline", "delphi_narrative"]
        );
    }

    #[test]
    fn the_sweep_is_off_unless_exactly_one_and_bounded() {
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_SWEEP", "1"));
        pairs.push(("POLIS_JOBS_SWEEP_MAX_PAGES", "7"));
        pairs.push(("POLIS_JOBS_SWEEP_CHECK_SECONDS", "2"));
        let c = ready(&pairs);
        assert!(c.sweep);
        assert_eq!((c.sweep_max_pages, c.sweep_check), (7, Duration::from_secs(2)));
        for (k, v, msg) in [
            ("POLIS_JOBS_SWEEP", "true", "POLIS_JOBS_SWEEP must be 0 or 1"),
            (
                "POLIS_JOBS_SWEEP_MAX_PAGES",
                "0",
                "POLIS_JOBS_SWEEP_MAX_PAGES must be an integer in 1..=1000",
            ),
            (
                "POLIS_JOBS_SWEEP_CHECK_SECONDS",
                "0",
                "POLIS_JOBS_SWEEP_CHECK_SECONDS must be an integer in 1..=86400",
            ),
        ] {
            let mut pairs = BASE.to_vec();
            pairs.push((k, v));
            assert_eq!(with(&pairs).err().map(|e| e.0), Some(msg.into()), "{k}={v}");
        }
    }

    #[test]
    fn transport_defaults_to_tls_and_needs_ca_and_allowlist() {
        let base = &BASE[..3];
        assert_eq!(
            with(base).err().map(|e| e.0),
            Some("tls transport requires POLIS_JOBS_CA_FILE".into())
        );
        let mut pairs = base.to_vec();
        pairs.push(("POLIS_JOBS_CA_FILE", "/ca.pem"));
        assert!(with(&pairs).is_err());
        pairs.push(("POLIS_JOBS_HOST_ALLOWLIST", "db.internal, other"));
        let c = ready(&pairs);
        assert_eq!(
            c.transport,
            TransportKind::Tls {
                ca_file: "/ca.pem".into(),
                host_allowlist: vec!["db.internal".into(), "other".into()]
            }
        );
    }

    #[test]
    fn heartbeat_must_be_below_a_third_of_the_lease() {
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_LEASE_SECONDS", "90"));
        pairs.push(("POLIS_JOBS_HEARTBEAT_SECONDS", "30"));
        assert!(with(&pairs).is_err());
        pairs.pop();
        pairs.push(("POLIS_JOBS_HEARTBEAT_SECONDS", "29"));
        assert_eq!(ready(&pairs).heartbeat_seconds, 29);
    }

    #[test]
    fn lease_bounds_are_000019s() {
        for (lease, ok) in [("9", false), ("10", true), ("901", false), ("900", true)] {
            let mut pairs = BASE.to_vec();
            pairs.push(("POLIS_JOBS_LEASE_SECONDS", lease));
            pairs.push(("POLIS_JOBS_HEARTBEAT_SECONDS", "3"));
            assert_eq!(with(&pairs).is_ok(), ok, "{lease}");
        }
    }

    #[test]
    fn unknown_stage_or_worker_class_refused() {
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_STAGES", "delphi_full_pipeline,embed"));
        assert!(with(&pairs).is_err());
        for class in ["noop", "", "Large", "delphi,large"] {
            let mut pairs = BASE.to_vec();
            pairs.push(("POLIS_JOBS_WORKER_CLASS", class));
            assert!(with(&pairs).is_err(), "{class:?}");
        }
    }

    #[test]
    fn class_large_admits_only_the_rebuild_stage() {
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_WORKER_CLASS", "large"));
        let c = ready(&pairs);
        assert_eq!(c.worker_class, WorkerClass::Large);
        assert_eq!(c.worker_class.name(), "large");
        assert_eq!(
            c.stages.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["math_rebuild"]
        );
        // A class never admits another class's stage, in either direction.
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_WORKER_CLASS", "large"));
        pairs.push(("POLIS_JOBS_STAGES", "delphi_full_pipeline"));
        assert_eq!(
            with(&pairs).err().map(|e| e.0),
            Some("POLIS_JOBS_STAGES must be a non-empty subset of math_rebuild (the stages of class large)".into())
        );
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_STAGES", "math_rebuild"));
        assert!(with(&pairs).is_err(), "class delphi with the rebuild stage");
        let mut pairs = BASE.to_vec();
        pairs.push(("POLIS_JOBS_WORKER_CLASS", "large"));
        pairs.push(("POLIS_JOBS_STAGES", "math_rebuild,delphi_narrative"));
        assert!(with(&pairs).is_err());
    }

    #[test]
    fn the_large_class_needs_the_third_contract_and_delphi_runs_on_either() {
        assert!(WorkerClass::Large.admits_contract("polis-queue/3"));
        assert!(!WorkerClass::Large.admits_contract("polis-queue/2"));
        assert!(WorkerClass::Delphi.admits_contract("polis-queue/2"));
        assert!(WorkerClass::Delphi.admits_contract("polis-queue/3"));
        for class in [WorkerClass::Delphi, WorkerClass::Large] {
            assert!(!class.admits_contract("polis-queue/1"));
            assert!(!class.admits_contract(""));
            assert_eq!(WorkerClass::parse(class.name()), Some(class));
        }
    }

    #[test]
    fn env_and_transport_values_are_closed() {
        let mut pairs = BASE.to_vec();
        pairs[2] = ("QUEUE_ENV", "Prod Env");
        assert!(with(&pairs).is_err());
        let mut pairs = BASE.to_vec();
        pairs[3] = ("POLIS_JOBS_TRANSPORT", "notls");
        assert!(with(&pairs).is_err());
        let mut pairs = BASE.to_vec();
        pairs[1] = ("QUEUE_DATABASE_URL", "");
        assert!(with(&pairs).is_err());
    }

    #[test]
    fn redaction_hides_passwords() {
        for dsn in [
            "postgresql://jobs:secret@db:5432/x",
            "postgresql://jobs@db:5432/x?password=secret",
            "postgresql://jobs:se%40cret@db:5432/x",
            "host=/run/pg user=jobs password='sec ret' dbname=x",
            "host=/run/pg user=jobs password=secret dbname=x",
        ] {
            let r = redact(dsn);
            assert!(!r.contains("sec"), "{dsn} -> {r}");
            assert!(r.contains("user=jobs") && r.contains("dbname=x"), "{r}");
        }
        assert_eq!(
            redact("postgresql://jobs:secret@db:5432/x"),
            "host=db port=5432 dbname=x user=jobs"
        );
        assert_eq!(redact("postgresql://u:p@[bad"), "<unparseable DSN>");
    }
}
