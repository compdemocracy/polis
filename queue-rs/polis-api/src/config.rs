//! Configuration, read once at startup. Anything the Node route reads from its
//! environment is read here under the same name, so one env file configures
//! both processes identically; the Rust-only settings are `POLIS_API_*`.

use anyhow::{Context, Result, bail};
use polis_queue_adapter::jobs::config::TransportKind;
use polis_queue_adapter::jobs::transport::Connector;
use postgres::config::{Config as PgConfig, Host, SslMode};
use std::{path::PathBuf, time::Duration};

pub struct Config {
    pub listen: String,
    /// `Config.mathEnv` (`MATH_ENV`). The served label and the row filter.
    pub math_env: String,
    /// `CACHE_MATH_RESULTS`: 300-entry caches when true or blank, else 1.
    pub cache_size: usize,
    pub dev_mode: bool,
    pub use_network_host: bool,
    pub production: bool,
    pub pool_size: usize,
    pub acquire_timeout: Duration,
}

/// The `boolean` package's `isTrue`, which the Node config uses.
pub fn is_true(value: Option<&str>) -> bool {
    matches!(
        value
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "true" | "t" | "yes" | "y" | "on" | "1"
    )
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // Node's Config.mathEnv has no default: unset, it matches no row and
        // labels every tag "undefined". Serving under a guessed label would
        // answer with another engine's rows, so the process refuses to start.
        let math_env =
            env("MATH_ENV").context("MATH_ENV is required (the Node server's math_env)")?;
        // P-038: with this flag Node routes parameter errors to a JSON error
        // handler instead of the default HTML one. This process implements the
        // default only, so it refuses to run where the flag would differ.
        if is_true(
            std::env::var("POLIS_REACHABLE_ERROR_HANDLER")
                .ok()
                .as_deref(),
        ) {
            bail!(
                "POLIS_REACHABLE_ERROR_HANDLER is set; polis-api implements only the default error path"
            );
        }
        let cache = std::env::var("CACHE_MATH_RESULTS").ok();
        let cache_size = if cache.as_deref().is_none_or(str::is_empty) || is_true(cache.as_deref())
        {
            300
        } else {
            1
        };
        let pool_size = match env("POLIS_API_DB_POOL") {
            Some(v) => v.parse().context("POLIS_API_DB_POOL")?,
            None => 8,
        };
        if !(1..=64).contains(&pool_size) {
            bail!("POLIS_API_DB_POOL must be 1..=64");
        }
        let acquire_ms: u64 = match env("POLIS_API_DB_ACQUIRE_TIMEOUT_MS") {
            Some(v) => v.parse().context("POLIS_API_DB_ACQUIRE_TIMEOUT_MS")?,
            None => 5000,
        };
        Ok(Self {
            listen: env("POLIS_API_LISTEN").unwrap_or_else(|| "127.0.0.1:5100".into()),
            math_env,
            cache_size,
            dev_mode: is_true(std::env::var("DEV_MODE").ok().as_deref()),
            use_network_host: is_true(std::env::var("USE_NETWORK_HOST").ok().as_deref()),
            production: std::env::var("NODE_ENV").ok().as_deref() == Some("production"),
            pool_size,
            acquire_timeout: Duration::from_millis(acquire_ms),
        })
    }
}

/// How the process reaches Postgres. The first three are the shared rules of
/// this workspace's transport (`polis_queue_adapter::jobs::transport`):
/// verify-full TLS to allowlisted hosts, a Unix socket, or plain TCP to a
/// literal loopback address. `docker-internal` is plain TCP to named hosts
/// on a private container network (the dev and test compose stacks, whose
/// Postgres has no TLS); it is refused unless the hosts are listed.
pub fn db_connector() -> Result<Connector> {
    let dsn = env("POLIS_API_DATABASE_URL")
        .or_else(|| env("DATABASE_URL"))
        .context("POLIS_API_DATABASE_URL or DATABASE_URL is required")?;
    let password_file = env("POLIS_API_DB_PASSWORD_FILE").map(PathBuf::from);
    let name = "polis-api/1";
    let list = |var: &str| -> Vec<String> {
        env(var)
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let kind = env("POLIS_API_DB_TRANSPORT").unwrap_or_else(|| "tls".into());
    let shared = match kind.as_str() {
        "tls" => TransportKind::Tls {
            ca_file: PathBuf::from(
                env("POLIS_API_DB_CA_FILE").context("POLIS_API_DB_CA_FILE is required for tls")?,
            ),
            host_allowlist: {
                let hosts = list("POLIS_API_DB_HOST_ALLOWLIST");
                if hosts.is_empty() {
                    bail!("POLIS_API_DB_HOST_ALLOWLIST is required for tls");
                }
                hosts
            },
        },
        "local" => TransportKind::Local,
        "loopback" => TransportKind::Loopback,
        "docker-internal" => {
            let hosts = list("POLIS_API_DB_PLAIN_HOSTS");
            if hosts.is_empty() {
                bail!("POLIS_API_DB_PLAIN_HOSTS is required for docker-internal");
            }
            return docker_internal(&dsn, &hosts, password_file, name);
        }
        other => {
            bail!("POLIS_API_DB_TRANSPORT {other:?} is not tls, local, loopback or docker-internal")
        }
    };
    Connector::from_parts(&dsn, &shared, password_file.as_deref(), name)
}

fn docker_internal(
    dsn: &str,
    hosts: &[String],
    password_file: Option<PathBuf>,
    name: &str,
) -> Result<Connector> {
    let mut config: PgConfig = dsn.parse().context("unparseable DSN")?;
    if config.get_hosts().is_empty() || !config.get_hostaddrs().is_empty() {
        bail!("docker-internal needs a host name and no hostaddr");
    }
    for host in config.get_hosts() {
        match host {
            Host::Tcp(h) if hosts.iter().any(|allowed| allowed == h) => {}
            _ => bail!("host not in POLIS_API_DB_PLAIN_HOSTS"),
        }
    }
    if let Some(path) = password_file {
        let bytes = std::fs::read(&path).context("unreadable password file")?;
        let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes).to_vec();
        config.password(bytes);
    }
    config
        .ssl_mode(SslMode::Disable)
        .connect_timeout(Duration::from_secs(10))
        .application_name(name);
    Ok(Connector::Plain(Box::new(config)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_matches_the_boolean_package() {
        for v in ["true", "TRUE", " yes ", "1", "on", "t", "y"] {
            assert!(is_true(Some(v)), "{v}");
        }
        for v in ["", "false", "0", "no", "2"] {
            assert!(!is_true(Some(v)), "{v}");
        }
        assert!(!is_true(None));
    }

    #[test]
    fn docker_internal_only_reaches_listed_hosts() {
        let hosts = vec!["postgres".to_string()];
        assert!(docker_internal("postgres://u@postgres:5432/d", &hosts, None, "n").is_ok());
        assert!(docker_internal("postgres://u@db.example:5432/d", &hosts, None, "n").is_err());
        assert!(docker_internal("host=/tmp user=u", &hosts, None, "n").is_err());
        assert!(
            docker_internal("host=postgres hostaddr=10.0.0.1 user=u", &hosts, None, "n").is_err()
        );
    }
}
