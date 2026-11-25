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
/// The most conversation codes `DELPHI_SHADOW_BENCHMARK` may list.
pub const BENCHMARK_MAX: usize = 10_000;
/// The most conversation codes each comment-rule list may name.
pub const RULE_LIST_MAX: usize = BENCHMARK_MAX;
/// The settings that add a comment rule's runs for the conversations they
/// list, each with the rule it adds, in the order they are read. Every
/// conversation the shadow runs is run under `participant_visible/1`, what
/// participants are shown, as without them; a listed one is also run under
/// the list's rule, each (conversation, rule) its own job. A conversation may
/// be on both lists.
pub const RULE_LISTS: [(&str, &str); 2] = [
    (
        "DELPHI_SHADOW_ALL_COMMENTS",
        crate::jobs::inputs::contract::ALL_COMMENTS,
    ),
    (
        "DELPHI_SHADOW_ALL_BUT_MODERATED_OUT",
        crate::jobs::inputs::contract::ALL_BUT_MODERATED_OUT,
    ),
];

/// One comment-rule list: its setting, the rule it adds, its codes, and how
/// many entries repeated an earlier one (kept once).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleList {
    pub key: &'static str,
    pub selection: &'static str,
    pub codes: Vec<String>,
    pub repeated: usize,
}
/// Settings an earlier build of this scheduler read, refused when set so a
/// stale line is never silently ignored: the benchmark list's old name, and
/// the participant-count source, which is removed.
pub const RETIRED: [(&str, &str); 2] = [
    (
        "DELPHI_SHADOW_IMPORTANT",
        "DELPHI_SHADOW_IMPORTANT is retired: the list is DELPHI_SHADOW_BENCHMARK",
    ),
    (
        "DELPHI_SHADOW_LARGE_PARTICIPANTS",
        "DELPHI_SHADOW_LARGE_PARTICIPANTS is retired: no conversation is selected by its participant count",
    ),
];

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
    /// The floor: of the comments a run lays out (the selection's, with text).
    pub min_comments: i64,
    /// The cap: of the comments a run embeds (every comment with text).
    pub max_comments: i64,
    pub daily_runs: u32,
    pub rerun_after: Duration,
    pub poll: Duration,
    pub job_poll: Duration,
    pub job_deadline: Duration,
    /// Every Nth first run on a comment set is repeated once on the same set;
    /// 0 is off.
    pub twin_every: u32,
    /// The benchmark set: conversation codes (`zinvites.zinvite`, the code in
    /// a conversation's URL) read whatever their recent activity, before the
    /// featured and current sets, highest priority first
    /// (`DELPHI_SHADOW_BENCHMARK`, in the order it lists them; empty by
    /// default). Each is still held to the comment bounds, the rerun window,
    /// the pacing and the storage budget. (The featured set, the open-data
    /// conversations, and the current set, the live ones, need no setting.)
    pub benchmark: Vec<String>,
    /// The conversations whose runs under another comment rule are added to
    /// their run under what participants are shown
    /// (`contract::PARTICIPANT_VISIBLE`, which every conversation keeps): one
    /// list per rule, in [`RULE_LISTS`] order, conversation codes as the
    /// benchmark list names them, each empty by default:
    /// `DELPHI_SHADOW_ALL_COMMENTS` (every comment, `all_comments/1`) and
    /// `DELPHI_SHADOW_ALL_BUT_MODERATED_OUT` (every comment but the
    /// moderated-out ones, `all_but_moderated_out/1`). A code may be on both.
    /// They add runs, not candidates: a listed conversation is run only when
    /// one of the three sets picks it, under the same bounds.
    pub rule_lists: Vec<RuleList>,
    /// An explicit public-comment allowlist. Empty means no graph work.
    pub graph: Option<super::graph::Config>,
    /// How often the roster (the benchmark and featured sets, read once a UTC
    /// day) is read again at most after a read that failed.
    pub roster_retry: Duration,
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
    /// Nothing is admitted once the shadow has added this many bytes to the
    /// database in all (`DELPHI_SHADOW_STORAGE_BUDGET_MB`, 3 GiB by default),
    /// or would with the next run (`storage`).
    pub storage_budget_bytes: u64,
    /// Nor, when set, once it has added this many in the current UTC day
    /// (`DELPHI_SHADOW_STORAGE_DAILY_MB`). `None`, the default (the setting
    /// unset, empty or 0), is no daily limit: only the total holds.
    pub storage_daily_bytes: Option<u64>,
    /// Of the budget, this many bytes are kept for the current set, the live
    /// conversations (`DELPHI_SHADOW_LIVE_RESERVE_MB`, 1 GiB by default; 0
    /// keeps none): the benchmark and featured sets together, and twin runs,
    /// stop once the shadow's bytes would pass the budget less this; current
    /// runs may spend the whole budget.
    pub storage_live_reserve_bytes: u64,
    /// While this file exists, nothing is admitted (the operator's pause).
    pub pause_file: PathBuf,
    pub state_path: PathBuf,
    pub statement_timeout: Duration,
    /// The derived-map backfill (`backfill`), off by default.
    pub derived: super::backfill::Settings,
}

/// The part of the storage budget a run may spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Share {
    /// The whole budget: a run of the current set (a live conversation).
    Whole,
    /// The budget less the live reserve: a run of the benchmark or the
    /// featured set, or a twin.
    Shared,
}

impl Config {
    /// The bytes in all that runs of `share` may bring the shadow to.
    pub fn storage_limit_bytes(&self, share: Share) -> u64 {
        match share {
            Share::Whole => self.storage_budget_bytes,
            Share::Shared => self
                .storage_budget_bytes
                .saturating_sub(self.storage_live_reserve_bytes),
        }
    }

    /// The most one run of `share` may add and still be admitted some day:
    /// its limit in all, or the daily limit when there is one and it is
    /// smaller.
    pub fn storage_run_max_bytes(&self, share: Share) -> u64 {
        let total = self.storage_limit_bytes(share);
        self.storage_daily_bytes
            .map_or(total, |daily| daily.min(total))
    }

    /// The daily limit as the log states it: its bytes, or "no daily limit".
    pub fn storage_daily_log(&self) -> serde_json::Value {
        match self.storage_daily_bytes {
            Some(bytes) => bytes.into(),
            None => "no daily limit".into(),
        }
    }
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

/// The backfill's settings: the switch is `1`, `0` or unset; each number
/// within its bounds, whether the switch is on or not.
fn derived_settings<F: Fn(&str) -> Option<String>>(
    get: &F,
) -> Result<super::backfill::Settings, ConfigError> {
    let key = super::backfill::SWITCH;
    let enabled = match get(key).as_deref().map(str::trim) {
        None | Some("") | Some("0") => false,
        Some("1") => true,
        Some(_) => return err(format!("{key} must be 0 or 1")),
    };
    Ok(super::backfill::Settings {
        enabled,
        per_cycle: number(get, "DELPHI_SHADOW_DERIVED_PER_CYCLE", 2, 1, 20)? as u32,
        daily: number(get, "DELPHI_SHADOW_DERIVED_DAILY", 100, 1, 2000)? as u32,
        every: Duration::from_secs(number(
            get,
            "DELPHI_SHADOW_DERIVED_EVERY_SECONDS",
            3600,
            60,
            86400,
        )?),
    })
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

/// A conversation code as `zinvites.zinvite` holds it: 1 to 64 letters and
/// digits (the server writes lowercase ones; an imported one may differ).
pub fn valid_code(code: &str) -> bool {
    (1..=64).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `DELPHI_SHADOW_BENCHMARK`: codes separated by commas or white space, highest
/// priority first. A repeated code keeps its first place. An entry that is not
/// a code is refused by its position, never its text: the list is the
/// operator's, and the log carries no conversation's name.
pub fn benchmark_codes(raw: &str) -> Result<Vec<String>, ConfigError> {
    conversation_codes("DELPHI_SHADOW_BENCHMARK", raw, BENCHMARK_MAX)
}

/// A list of conversation codes in the setting `key`, read as
/// `DELPHI_SHADOW_BENCHMARK` is ([`benchmark_codes`]): separated by commas or
/// white space, a repeat kept at its first place, an entry that is not a code
/// refused by its position (never its text), and at most `max` of them.
pub fn conversation_codes(key: &str, raw: &str, max: usize) -> Result<Vec<String>, ConfigError> {
    let mut out: Vec<String> = Vec::new();
    for (i, entry) in entries(raw).enumerate() {
        if !valid_code(entry) {
            return err(format!(
                "{key} entry {} is not a conversation code (1-64 letters and digits)",
                i + 1
            ));
        }
        if !out.iter().any(|c| c == entry) {
            out.push(entry.to_owned());
        }
    }
    if out.len() > max {
        return err(format!("{key} lists more than {max} conversations"));
    }
    Ok(out)
}

/// A list setting's entries, in order: separated by commas or white space.
fn entries(raw: &str) -> impl Iterator<Item = &str> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|e| !e.is_empty())
}

/// The comment-rule lists ([`RULE_LISTS`]), each read as the benchmark list
/// is: an entry that is not a code is refused by its list and position; a
/// repeated code is kept once (and counted, for the log). A code on both
/// lists is on both: its conversation runs under both rules.
pub fn rule_lists<F: Fn(&str) -> Option<String>>(get: &F) -> Result<Vec<RuleList>, ConfigError> {
    let mut out: Vec<RuleList> = Vec::new();
    for (key, selection) in RULE_LISTS {
        let raw = get(key).unwrap_or_default();
        let codes = conversation_codes(key, &raw, RULE_LIST_MAX)?;
        let repeated = entries(&raw).count() - codes.len();
        out.push(RuleList {
            key,
            selection,
            codes,
            repeated,
        });
    }
    Ok(out)
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
    let storage_budget_mb = number(&get, "DELPHI_SHADOW_STORAGE_BUDGET_MB", 3072, 1, 1 << 20)?;
    // Unset, empty or 0: no daily limit.
    let storage_daily_mb = number(&get, "DELPHI_SHADOW_STORAGE_DAILY_MB", 0, 0, 1 << 20)?;
    let storage_daily_mb = (storage_daily_mb > 0).then_some(storage_daily_mb);
    if storage_daily_mb.is_some_and(|mb| mb > storage_budget_mb) {
        return err(
            "DELPHI_SHADOW_STORAGE_DAILY_MB must not exceed DELPHI_SHADOW_STORAGE_BUDGET_MB",
        );
    }
    let live_reserve_mb = number(&get, "DELPHI_SHADOW_LIVE_RESERVE_MB", 1024, 0, 1 << 20)?;
    if live_reserve_mb > storage_budget_mb {
        return err(
            "DELPHI_SHADOW_LIVE_RESERVE_MB must not exceed DELPHI_SHADOW_STORAGE_BUDGET_MB",
        );
    }
    for (key, why) in RETIRED {
        if get(key).is_some_and(|v| !v.trim().is_empty()) {
            return err(why);
        }
    }
    let graph = super::graph::Config::load(&get, &env)?;
    let benchmark = benchmark_codes(&get("DELPHI_SHADOW_BENCHMARK").unwrap_or_default())?;
    let rule_lists = rule_lists(&get)?;
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
        benchmark,
        rule_lists,
        graph,
        roster_retry: Duration::from_secs(number(
            &get,
            "DELPHI_SHADOW_ROSTER_RETRY_SECONDS",
            3600,
            1,
            86400,
        )?),
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
        storage_budget_bytes: storage_budget_mb * crate::shadow::storage::MIB,
        storage_daily_bytes: storage_daily_mb.map(|mb| mb * crate::shadow::storage::MIB),
        storage_live_reserve_bytes: live_reserve_mb * crate::shadow::storage::MIB,
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
        derived: derived_settings(&get)?,
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
        assert_eq!(
            c.storage_budget_bytes,
            3 * 1024 * 1024 * 1024,
            "3 GiB in all"
        );
        assert_eq!(c.storage_daily_bytes, None, "no daily limit");
        assert_eq!(
            c.storage_live_reserve_bytes,
            1024 << 20,
            "1 GiB kept for live"
        );
        assert_eq!(c.storage_limit_bytes(Share::Whole), 3072 << 20);
        assert_eq!(c.storage_limit_bytes(Share::Shared), 2048 << 20);
        assert!(
            c.benchmark.is_empty(),
            "no conversation is a benchmark unless listed"
        );
        assert_eq!(c.roster_retry, Duration::from_secs(3600));
        assert_eq!(c.pause_file, PathBuf::from("/var/lib/delphi-shadow/pause"));
    }

    #[test]
    fn the_benchmark_list_keeps_its_order_and_refuses_what_is_not_a_code() {
        let c = ready(&[(
            "DELPHI_SHADOW_BENCHMARK",
            Some(" 3abcd2efgh, 2xyz\n9Mixed7 ,,2xyz 3abcd2efgh\t4last "),
        )]);
        assert_eq!(c.benchmark, ["3abcd2efgh", "2xyz", "9Mixed7", "4last"]);
        assert!(
            ready(&[("DELPHI_SHADOW_BENCHMARK", Some(" , "))])
                .benchmark
                .is_empty()
        );
        for bad in [
            "2abc,https://pol.is/2abc",
            "2abc;3def",
            "2ab-c",
            &"a".repeat(65),
        ] {
            let Err(e) = with(&[("DELPHI_SHADOW_BENCHMARK", Some(bad))]) else {
                panic!("{bad} was accepted");
            };
            assert!(e.0.contains("DELPHI_SHADOW_BENCHMARK entry"), "{bad}: {e}");
            assert!(
                !e.0.contains("pol.is") && !e.0.contains("2ab"),
                "never the entry's text: {e}"
            );
        }
        let Err(e) = with(&[("DELPHI_SHADOW_BENCHMARK", Some("2abc,3def;"))]) else {
            panic!("a list with a bad second entry was accepted");
        };
        assert!(e.0.contains("entry 2"), "{e}");
        let many: Vec<String> = (0..=BENCHMARK_MAX).map(|i| format!("c{i}")).collect();
        assert!(with(&[("DELPHI_SHADOW_BENCHMARK", Some(&many.join(",")))]).is_err());
        assert_eq!(
            ready(&[(
                "DELPHI_SHADOW_BENCHMARK",
                Some(&many[..BENCHMARK_MAX].join(","))
            )])
            .benchmark
            .len(),
            BENCHMARK_MAX
        );
    }

    fn codes(c: &Config, key: &str) -> Vec<String> {
        c.rule_lists
            .iter()
            .find(|l| l.key == key)
            .map(|l| l.codes.clone())
            .unwrap_or_else(|| panic!("{key} is not a rule list"))
    }

    #[test]
    fn the_comment_rule_lists_are_read_as_the_benchmark_list_and_refuse_what_is_not_a_code() {
        assert_eq!(
            RULE_LISTS,
            [
                ("DELPHI_SHADOW_ALL_COMMENTS", "all_comments/1"),
                (
                    "DELPHI_SHADOW_ALL_BUT_MODERATED_OUT",
                    "all_but_moderated_out/1"
                ),
            ]
        );
        for (key, _) in RULE_LISTS {
            // Unset or empty: no conversation has that rule.
            for v in [None, Some(""), Some(" , \n")] {
                assert!(codes(&ready(&[(key, v)]), key).is_empty(), "{key} {v:?}");
            }
            let c = ready(&[(key, Some(" 69abcd, 2xyz\n9Mixed7 ,,2xyz 69abcd\t4last "))]);
            assert_eq!(codes(&c, key), ["69abcd", "2xyz", "9Mixed7", "4last"]);
            assert!(c.benchmark.is_empty(), "the lists are separate");
            for (bad, position) in [
                ("https://pol.is/2abc", "entry 1"),
                ("2abc;3def", "entry 1"),
                ("2abc,2ab-c", "entry 2"),
                ("2abc 3def \u{e9}9", "entry 3"),
            ] {
                let Err(e) = with(&[(key, Some(bad))]) else {
                    panic!("{key}: {bad} was accepted");
                };
                assert!(e.0.contains(&format!("{key} {position} ")), "{bad}: {e}");
                assert!(
                    !e.0.contains("pol.is") && !e.0.contains("2ab") && !e.0.contains("3def"),
                    "never the entry's text: {e}"
                );
            }
            let Err(e) = with(&[(key, Some(&"a".repeat(65)))]) else {
                panic!("a 65-character code was accepted");
            };
            assert!(e.0.contains("entry 1"), "{e}");
            let many: Vec<String> = (0..=RULE_LIST_MAX).map(|i| format!("c{i}")).collect();
            assert!(with(&[(key, Some(&many.join(",")))]).is_err());
        }
        // Both lists at once, and a code on both: valid, on both.
        let c = ready(&[
            ("DELPHI_SHADOW_ALL_COMMENTS", Some("69abcd,2xyz")),
            ("DELPHI_SHADOW_ALL_BUT_MODERATED_OUT", Some("3def 2xyz")),
        ]);
        assert_eq!(codes(&c, "DELPHI_SHADOW_ALL_COMMENTS"), ["69abcd", "2xyz"]);
        assert_eq!(
            codes(&c, "DELPHI_SHADOW_ALL_BUT_MODERATED_OUT"),
            ["3def", "2xyz"]
        );
        // A code repeated within one list is one entry, counted.
        let c = ready(&[(
            "DELPHI_SHADOW_ALL_COMMENTS",
            Some("69abcd 69abcd,2xyz 69abcd"),
        )]);
        let list = &c.rule_lists[0];
        assert_eq!((list.codes.len(), list.repeated), (2, 2));
        assert_eq!(c.rule_lists[1].repeated, 0);
        // The benchmark list's own messages are what they were.
        let Err(e) = with(&[("DELPHI_SHADOW_BENCHMARK", Some("2abc,3def;"))]) else {
            panic!("a bad benchmark entry was accepted");
        };
        assert_eq!(
            e.0,
            "DELPHI_SHADOW_BENCHMARK entry 2 is not a conversation code (1-64 letters and digits)"
        );
        // A benchmark conversation may have any rule.
        assert!(matches!(
            with(&[
                ("DELPHI_SHADOW_BENCHMARK", Some("69abcd")),
                ("DELPHI_SHADOW_ALL_COMMENTS", Some("69abcd")),
            ]),
            Ok(Load::Ready(_))
        ));
    }

    #[test]
    fn the_retired_settings_refuse_to_start_when_set_naming_no_value() {
        // Unset or empty, they are as if absent.
        for key in [
            "DELPHI_SHADOW_IMPORTANT",
            "DELPHI_SHADOW_LARGE_PARTICIPANTS",
        ] {
            assert!(matches!(with(&[(key, Some(""))]), Ok(Load::Ready(_))));
            assert!(matches!(with(&[(key, Some("  "))]), Ok(Load::Ready(_))));
        }
        let Err(e) = with(&[("DELPHI_SHADOW_IMPORTANT", Some("2abc"))]) else {
            panic!("the old name of the benchmark list was accepted");
        };
        assert!(e.0.contains("DELPHI_SHADOW_BENCHMARK"), "{e}");
        assert!(!e.0.contains("2abc"), "never the value: {e}");
        let Err(e) = with(&[("DELPHI_SHADOW_LARGE_PARTICIPANTS", Some("200"))]) else {
            panic!("the participant-count source's setting was accepted");
        };
        assert!(e.0.contains("retired"), "{e}");
        // The new name alone is the list.
        assert_eq!(
            ready(&[("DELPHI_SHADOW_BENCHMARK", Some("2abc"))]).benchmark,
            ["2abc"]
        );
    }

    #[test]
    fn a_served_env_is_refused() {
        for env in [
            "import-example-1",
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
            with(&[("QUEUE_ENV", Some("import-example-1"))]).is_err(),
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
        assert!(with(&[("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("0"))]).is_err());
        assert!(with(&[("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("-1"))]).is_err());
        assert!(
            with(&[
                ("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("50")),
                ("DELPHI_SHADOW_LIVE_RESERVE_MB", Some("0")),
                ("DELPHI_SHADOW_STORAGE_DAILY_MB", Some("51"))
            ])
            .is_err(),
            "a day may not hold more than the whole budget"
        );
        assert!(
            with(&[
                ("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("50")),
                ("DELPHI_SHADOW_LIVE_RESERVE_MB", Some("51"))
            ])
            .is_err(),
            "the live reserve may not be more than the whole budget"
        );
        assert!(with(&[("DELPHI_SHADOW_LIVE_RESERVE_MB", Some("-1"))]).is_err());
        let c = ready(&[
            ("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("50")),
            ("DELPHI_SHADOW_LIVE_RESERVE_MB", Some("50")),
        ]);
        assert_eq!(
            c.storage_limit_bytes(Share::Shared),
            0,
            "all of it for live"
        );
        let c = ready(&[
            ("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("50")),
            ("DELPHI_SHADOW_LIVE_RESERVE_MB", Some("0")),
        ]);
        assert_eq!(
            c.storage_limit_bytes(Share::Shared),
            c.storage_limit_bytes(Share::Whole),
            "none kept"
        );
        let c = ready(&[
            ("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("2048")),
            ("DELPHI_SHADOW_STORAGE_DAILY_MB", Some("2048")),
        ]);
        assert_eq!(
            (c.storage_budget_bytes, c.storage_daily_bytes),
            (2048 << 20, Some(2048 << 20))
        );
        assert!(with(&[("DELPHI_SHADOW_STORAGE_DAILY_MB", Some("-1"))]).is_err());
    }

    #[test]
    fn no_daily_limit_unless_one_is_set() {
        // Unset, empty or 0: no daily limit, whatever the total; the log says so.
        for v in [None, Some(""), Some("0"), Some(" 0 ")] {
            let c = ready(&[
                ("DELPHI_SHADOW_STORAGE_BUDGET_MB", Some("50")),
                ("DELPHI_SHADOW_LIVE_RESERVE_MB", Some("20")),
                ("DELPHI_SHADOW_STORAGE_DAILY_MB", v),
            ]);
            assert_eq!(c.storage_daily_bytes, None, "{v:?}");
            assert_eq!(c.storage_daily_log(), "no daily limit");
            // The total bounds one run: the whole of it for a live one, the
            // total less the reserve for the others.
            assert_eq!(c.storage_run_max_bytes(Share::Whole), 50 << 20);
            assert_eq!(c.storage_run_max_bytes(Share::Shared), 30 << 20);
        }
        // Set: a limit, bounding one run, and the log states its bytes.
        let c = ready(&[("DELPHI_SHADOW_STORAGE_DAILY_MB", Some("300"))]);
        assert_eq!(c.storage_daily_bytes, Some(300 << 20));
        assert_eq!(c.storage_daily_log(), serde_json::json!(300u64 << 20));
        assert_eq!(c.storage_run_max_bytes(Share::Whole), 300 << 20);
        assert_eq!(c.storage_run_max_bytes(Share::Shared), 300 << 20);
    }
}
