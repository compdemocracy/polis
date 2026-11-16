//! `polis-delphi-shadow daemon`: the shadow's job daemon, started only on a
//! shadow env.
//!
//! The shadow's daemon is the ordinary `polis-jobs`, which accepts any env:
//! given the env a reader serves, it would claim that env's jobs and publish
//! under it, a second production daemon. So the shadow's container does not
//! run `polis-jobs` directly. It runs this check, which refuses to start
//! (exit 2, one line, no value printed) unless the daemon's queue env and its
//! result env are the same shadow env, and only then replaces itself with
//! `polis-jobs` (exec: the same process, so the daemon's own signal handling
//! and drain are unchanged). The production `delphi` service never runs it.
//!
//! Before it replaces itself it also decides the thread counts of the
//! pipeline's libraries (`thread_settings`). None of torch, Numba or the BLAS
//! libraries reads a CPU quota, so when the container is fenced (a CPU quota,
//! Compose's `cpus:`, 2 by default for the shadow, or a CPU set narrower than
//! the box) it sets one thread per CPU the container may use. Unfenced
//! (`DELPHI_SHADOW_CONTAINER_CPUS=0`) it sets nothing, and each library
//! counts the box's CPUs itself.
use super::config::{ConfigError, ENV_PREFIX, valid_env};
use std::path::Path;

/// The daemon this check starts, looked up on `PATH` as the image installs it.
pub const DAEMON: &str = "polis-jobs";

/// The thread-count settings the pipeline's libraries read when they load:
/// OpenMP (torch's intra-op pool on Linux), MKL (torch on x86), OpenBLAS
/// (NumPy, scikit-learn) and Numba (UMAP, EVoC).
pub const THREAD_VARS: [&str; 4] = [
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMBA_NUM_THREADS",
];

/// What the container may use: the box's online CPUs, the CPUs in its
/// affinity set, and its CPU quota in CPUs (`None`: no quota).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cpus {
    pub online: usize,
    pub affinity: usize,
    pub quota: Option<f64>,
}

impl Cpus {
    /// The CPUs the container may keep busy at once: its affinity set, or
    /// fewer when a quota allows less (a fractional quota rounds up, so 1.5
    /// CPUs run two threads); at least one.
    pub fn usable(&self) -> usize {
        let quota = self.quota.map_or(usize::MAX, |q| {
            q.ceil().clamp(1.0, usize::MAX as f64) as usize
        });
        self.affinity.min(quota).max(1)
    }

    /// Whether anything fences the container below the box's CPUs.
    pub fn fenced(&self) -> bool {
        self.usable() < self.online
    }
}

/// A CPU quota as cgroup v2's `cpu.max` states it ("max 100000" is none,
/// "200000 100000" is two CPUs), in CPUs. Unreadable text is no quota: the
/// libraries then keep their own defaults, as they do today.
pub fn quota_from_cpu_max(text: &str) -> Option<f64> {
    let mut parts = text.split_whitespace();
    let quota = parts.next()?.parse::<f64>().ok()?;
    let period = parts
        .next()
        .map_or(Some(100_000.0), |p| p.parse::<f64>().ok())?;
    (quota > 0.0 && period > 0.0).then_some(quota / period)
}

/// The same from cgroup v1's `cpu.cfs_quota_us` and `cpu.cfs_period_us`
/// (a quota of -1 is none).
pub fn quota_from_cfs(quota_us: &str, period_us: &str) -> Option<f64> {
    let quota = quota_us.trim().parse::<f64>().ok()?;
    let period = period_us.trim().parse::<f64>().ok()?;
    (quota > 0.0 && period > 0.0).then_some(quota / period)
}

/// The container's CPU quota, read from the cgroup file system mounted at
/// `root` (`/sys/fs/cgroup` in a container): cgroup v2 first, then v1.
pub fn read_quota(root: &Path) -> Option<f64> {
    if let Ok(text) = std::fs::read_to_string(root.join("cpu.max")) {
        return quota_from_cpu_max(&text);
    }
    for dir in ["cpu", "cpu,cpuacct"] {
        let d = root.join(dir);
        if let (Ok(q), Ok(p)) = (
            std::fs::read_to_string(d.join("cpu.cfs_quota_us")),
            std::fs::read_to_string(d.join("cpu.cfs_period_us")),
        ) {
            return quota_from_cfs(&q, &p);
        }
    }
    None
}

/// This process's CPUs: the box's online count, its affinity set, and the
/// quota of the cgroup it runs in.
pub fn read_cpus() -> Cpus {
    // SAFETY: sysconf takes a plain integer name.
    let online = usize::try_from(unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) })
        .unwrap_or(1)
        .max(1);
    Cpus {
        online,
        affinity: affinity(online).clamp(1, online),
        quota: read_quota(Path::new("/sys/fs/cgroup")),
    }
}

/// The CPUs in this process's affinity set (Linux; elsewhere every online CPU).
#[cfg(target_os = "linux")]
fn affinity(online: usize) -> usize {
    // SAFETY: sched_getaffinity fills the zeroed set it is given; pid 0 is
    // this process.
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) == 0 {
            usize::try_from(libc::CPU_COUNT(&set)).unwrap_or(online)
        } else {
            online
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn affinity(online: usize) -> usize {
    online
}

/// The settings the daemon adds to its environment: one thread per usable
/// CPU for every library in `THREAD_VARS` that has no setting yet, and only
/// when the container is fenced. Unfenced, nothing: every library already
/// counts the box's CPUs. A setting already present is never replaced.
pub fn thread_settings<F: Fn(&str) -> Option<String>>(
    cpus: &Cpus,
    get: F,
) -> Vec<(&'static str, String)> {
    if !cpus.fenced() {
        return Vec::new();
    }
    let n = cpus.usable().to_string();
    THREAD_VARS
        .iter()
        .filter(|k| get(k).is_none_or(|v| v.trim().is_empty()))
        .map(|k| (*k, n.clone()))
        .collect()
}

/// The daemon's envs: `QUEUE_ENV` (the jobs it claims) and
/// `DELPHI_RESULT_ENV` (where the pipeline child writes its results) must
/// both be set, equal, and a shadow env.
pub fn check<F: Fn(&str) -> Option<String>>(get: F) -> Result<String, ConfigError> {
    let queue = get("QUEUE_ENV").unwrap_or_default();
    if !valid_env(&queue) {
        return Err(ConfigError(format!(
            "daemon: QUEUE_ENV must be {ENV_PREFIX} then 1-57 characters of [a-z0-9_-]: the shadow's daemon never claims a served env's jobs"
        )));
    }
    let result = get("DELPHI_RESULT_ENV").unwrap_or_default();
    if result != queue {
        return Err(ConfigError(
            "daemon: DELPHI_RESULT_ENV must equal QUEUE_ENV: the shadow's runs never write results under another env"
                .into(),
        ));
    }
    Ok(queue)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(pairs: &[(&'static str, &str)]) -> Result<String, ConfigError> {
        let m: HashMap<&str, String> = pairs.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
        check(|k| m.get(k).cloned())
    }

    #[test]
    fn the_daemon_starts_only_on_one_shadow_env() {
        assert_eq!(
            with(&[
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "shadow-delphi-1")
            ]),
            Ok("shadow-delphi-1".into())
        );
        assert_eq!(
            with(&[
                ("QUEUE_ENV", "shadow-twin-1"),
                ("DELPHI_RESULT_ENV", "shadow-twin-1")
            ]),
            Ok("shadow-twin-1".into())
        );
        for served in [
            "import-example-1",
            "prod",
            "",
            "shadow-",
            "shadow-UPPER",
            "xshadow-delphi",
        ] {
            assert!(
                with(&[("QUEUE_ENV", served), ("DELPHI_RESULT_ENV", served)]).is_err(),
                "{served:?}"
            );
        }
        // A shadow queue env publishing under a served env, or under none.
        assert!(
            with(&[
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "import-example-1")
            ])
            .is_err()
        );
        assert!(with(&[("QUEUE_ENV", "shadow-delphi-1")]).is_err());
        assert!(
            with(&[
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "shadow-twin-1")
            ])
            .is_err()
        );
        // A served queue env with a shadow result env.
        assert!(
            with(&[
                ("QUEUE_ENV", "import-example-1"),
                ("DELPHI_RESULT_ENV", "shadow-delphi-1")
            ])
            .is_err()
        );
        assert!(with(&[]).is_err());
    }

    fn cpus(online: usize, affinity: usize, quota: Option<f64>) -> Cpus {
        Cpus {
            online,
            affinity,
            quota,
        }
    }

    #[test]
    fn a_quota_reads_from_either_cgroup_version() {
        assert_eq!(quota_from_cpu_max("max 100000\n"), None);
        assert_eq!(quota_from_cpu_max("200000 100000\n"), Some(2.0));
        assert_eq!(quota_from_cpu_max("150000 100000"), Some(1.5));
        assert_eq!(
            quota_from_cpu_max("50000"),
            Some(0.5),
            "the period defaults"
        );
        for unreadable in ["", "max", "x 100000", "200000 0", "-1 100000"] {
            assert_eq!(quota_from_cpu_max(unreadable), None, "{unreadable:?}");
        }
        assert_eq!(quota_from_cfs("-1\n", "100000\n"), None);
        assert_eq!(quota_from_cfs("400000\n", "100000\n"), Some(4.0));
        assert_eq!(quota_from_cfs("x", "100000"), None);
    }

    #[test]
    fn the_quota_is_read_from_the_cgroup_files() -> std::io::Result<()> {
        let root = std::env::temp_dir().join(format!("shadow-cgroup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("cpu"))?;
        assert_eq!(read_quota(&root), None, "no cgroup file: no quota");
        std::fs::write(root.join("cpu/cpu.cfs_quota_us"), "300000\n")?;
        std::fs::write(root.join("cpu/cpu.cfs_period_us"), "100000\n")?;
        assert_eq!(read_quota(&root), Some(3.0), "cgroup v1");
        std::fs::write(root.join("cpu.max"), "max 100000\n")?;
        assert_eq!(read_quota(&root), None, "cgroup v2 wins, and says none");
        std::fs::write(root.join("cpu.max"), "200000 100000\n")?;
        assert_eq!(read_quota(&root), Some(2.0));
        std::fs::remove_dir_all(&root)
    }

    #[test]
    fn unfenced_the_libraries_keep_their_own_defaults() {
        // No quota, every CPU in the affinity set: whatever the box's size.
        for n in [1, 2, 8, 12, 64] {
            let c = cpus(n, n, None);
            assert!(!c.fenced());
            assert_eq!(c.usable(), n);
            assert!(thread_settings(&c, |_| None).is_empty(), "{n}");
        }
        // A quota at or above the box is no fence either.
        assert!(thread_settings(&cpus(8, 8, Some(8.0)), |_| None).is_empty());
        assert!(thread_settings(&cpus(8, 8, Some(16.0)), |_| None).is_empty());
    }

    #[test]
    fn fenced_one_thread_per_cpu_the_container_may_use() {
        let all = |c: &Cpus| -> Vec<(&str, String)> {
            THREAD_VARS
                .iter()
                .map(|k| (*k, c.usable().to_string()))
                .collect()
        };
        // Compose's cpus: 2 on an 8-CPU box.
        let two = cpus(8, 8, Some(2.0));
        assert!(two.fenced());
        assert_eq!(thread_settings(&two, |_| None), all(&two));
        assert_eq!(
            thread_settings(&two, |_| None)[0],
            ("OMP_NUM_THREADS", "2".into())
        );
        // A fractional quota rounds up; a tiny one still runs one thread.
        assert_eq!(cpus(8, 8, Some(1.5)).usable(), 2);
        assert_eq!(cpus(8, 8, Some(0.25)).usable(), 1);
        // A CPU set narrower than the box fences too, and the smaller wins.
        assert_eq!(cpus(12, 4, None).usable(), 4);
        assert!(cpus(12, 4, None).fenced());
        assert_eq!(cpus(12, 4, Some(6.0)).usable(), 4);
        assert_eq!(cpus(12, 6, Some(3.0)).usable(), 3);
        // A setting already present is kept; an empty one is filled.
        let set = thread_settings(&two, |k| match k {
            "OMP_NUM_THREADS" => Some("6".into()),
            "NUMBA_NUM_THREADS" => Some(" ".into()),
            _ => None,
        });
        assert_eq!(
            set,
            vec![
                ("MKL_NUM_THREADS", "2".into()),
                ("OPENBLAS_NUM_THREADS", "2".into()),
                ("NUMBA_NUM_THREADS", "2".into()),
            ]
        );
    }

    #[test]
    fn this_process_reads_its_own_cpus() {
        let c = read_cpus();
        assert!(
            c.online >= 1 && c.affinity >= 1 && c.affinity <= c.online,
            "{c:?}"
        );
        assert!(c.usable() <= c.online);
    }

    #[test]
    fn a_refusal_prints_no_value() {
        for pairs in [
            [
                ("QUEUE_ENV", "import-example-1"),
                ("DELPHI_RESULT_ENV", "import-example-1"),
            ],
            [
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "import-example-1"),
            ],
        ] {
            let Err(e) = with(&pairs) else {
                panic!("accepted {pairs:?}");
            };
            assert!(!e.to_string().contains("import-example-1"), "{e}");
        }
    }
}
