//! DSN → connection factory (build spec §1.2, G13).
//!
//! * `tls`: verify-full TLS 1.2+ against the CA file only (built-in roots off),
//!   every host in the exact allowlist, no Unix socket and no `hostaddr`
//!   bypass. Same rules as `coordinator-rs/src/database.rs`.
//! * `local`: every host is a Unix socket directory; peer auth; no network.
//! * `loopback`: NoTls to literal loopback IPs only (`queue-rs` rule).
use super::config::{Config, TransportKind};
use anyhow::{Result, bail, ensure};
use native_tls::{Certificate, Protocol, TlsConnector};
use postgres::{
    Client, NoTls,
    config::{Config as PgConfig, Host, SslMode},
};
use postgres_native_tls::MakeTlsConnector;
use std::time::Duration;

pub enum Connector {
    Tls(Box<PgConfig>, TlsConnector),
    Plain(Box<PgConfig>),
}

fn refuse(reason: &str) -> anyhow::Error {
    anyhow::anyhow!("transport refused: {reason}")
}

pub fn parse(dsn: &str, kind: &TransportKind) -> Result<PgConfig> {
    let mut config: PgConfig = dsn.parse().map_err(|_| refuse("unparseable DSN"))?;
    ensure!(!config.get_hosts().is_empty(), refuse("DSN names no host"));
    ensure!(
        config.get_hostaddrs().is_empty(),
        refuse("hostaddr is not allowed")
    );
    match kind {
        TransportKind::Tls { host_allowlist, .. } => {
            for host in config.get_hosts() {
                match host {
                    Host::Tcp(name) if !name.is_empty() && host_allowlist.contains(name) => {}
                    Host::Tcp(_) => bail!(refuse("host not in POLIS_JOBS_HOST_ALLOWLIST")),
                    #[cfg(unix)]
                    Host::Unix(_) => {
                        bail!(refuse("a Unix socket needs POLIS_JOBS_TRANSPORT=local"))
                    }
                }
            }
            config.ssl_mode(SslMode::Require);
        }
        TransportKind::Local => {
            for host in config.get_hosts() {
                match host {
                    #[cfg(unix)]
                    Host::Unix(path) if path.is_absolute() => {}
                    _ => bail!(refuse(
                        "local transport takes only absolute Unix socket directories"
                    )),
                }
            }
            config.ssl_mode(SslMode::Disable);
        }
        TransportKind::Loopback => {
            for host in config.get_hosts() {
                match host {
                    Host::Tcp(name)
                        if name
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|a| a.is_loopback()) => {}
                    _ => bail!(refuse(
                        "loopback transport takes only literal 127.0.0.1/::1; use tls for any other host"
                    )),
                }
            }
            config.ssl_mode(SslMode::Disable);
        }
    }
    config
        .connect_timeout(Duration::from_secs(10))
        .application_name("polis-jobs/1");
    Ok(config)
}

impl Connector {
    pub fn new(cfg: &Config) -> Result<Self> {
        let mut config = parse(&cfg.dsn, &cfg.transport)?;
        if let Some(path) = &cfg.password_file {
            ensure!(
                config.get_password().is_none(),
                refuse("password in both DSN and POLIS_JOBS_PASSWORD_FILE")
            );
            let bytes = std::fs::read(path).map_err(|_| refuse("unreadable password file"))?;
            let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes).to_vec();
            ensure!(
                !bytes.is_empty() && bytes.len() <= 65536 && !bytes.contains(&0),
                refuse("invalid password file")
            );
            config.password(bytes);
        }
        match &cfg.transport {
            TransportKind::Tls { ca_file, .. } => {
                let pem =
                    std::fs::read_to_string(ca_file).map_err(|_| refuse("unreadable CA file"))?;
                let mut builder = TlsConnector::builder();
                builder
                    .disable_built_in_roots(true)
                    .min_protocol_version(Some(Protocol::Tlsv12));
                let end = "-----END CERTIFICATE-----";
                let mut count = 0;
                for part in pem.split_inclusive(end) {
                    if part.trim().is_empty() {
                        continue;
                    }
                    ensure!(
                        part.trim_start().starts_with("-----BEGIN CERTIFICATE-----")
                            && part.ends_with(end),
                        refuse("CA file is not a PEM certificate bundle")
                    );
                    builder.add_root_certificate(
                        Certificate::from_pem(part.trim().as_bytes())
                            .map_err(|_| refuse("CA certificate does not parse"))?,
                    );
                    count += 1;
                }
                ensure!(count > 0, refuse("CA file holds no certificate"));
                let tls = builder.build().map_err(|_| refuse("TLS connector"))?;
                Ok(Self::Tls(Box::new(config), tls))
            }
            TransportKind::Local | TransportKind::Loopback => Ok(Self::Plain(Box::new(config))),
        }
    }

    pub fn connect(&self) -> Result<Client> {
        Ok(match self {
            Self::Tls(config, tls) => config.connect(MakeTlsConnector::new(tls.clone()))?,
            Self::Plain(config) => config.connect(NoTls)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tls() -> TransportKind {
        TransportKind::Tls {
            ca_file: "/nonexistent".into(),
            host_allowlist: vec!["db.internal".into()],
        }
    }

    #[test]
    fn loopback_takes_only_literal_loopback_ips() {
        for dsn in [
            "postgresql://u@127.0.0.1:5/d",
            "postgresql://u@[::1]:5/d",
            "host=127.0.0.1 user=u",
        ] {
            assert!(parse(dsn, &TransportKind::Loopback).is_ok(), "{dsn}");
        }
        for dsn in [
            "postgresql://u@localhost:5/d",
            "postgresql://u@10.0.0.5:5/d",
            "postgresql://u@db.internal/d",
            "host=/tmp user=u",
            "host=127.0.0.1 hostaddr=10.0.0.5 user=u",
        ] {
            assert!(parse(dsn, &TransportKind::Loopback).is_err(), "{dsn}");
        }
    }

    #[test]
    fn tls_is_required_for_non_loopback_hosts() {
        assert!(parse("postgresql://u@db.internal/d", &tls()).is_ok());
        assert!(parse("postgresql://u@db.other/d", &tls()).is_err());
        // A Unix socket is refused under tls: local must be chosen explicitly.
        assert!(parse("host=/var/run/postgresql user=u", &tls()).is_err());
        let c = parse("postgresql://u@db.internal/d?sslmode=disable", &tls());
        assert!(matches!(c.map(|c| c.get_ssl_mode()), Ok(SslMode::Require)));
    }

    #[test]
    fn local_takes_only_unix_socket_directories() {
        assert!(parse("host=/var/run/postgresql user=u", &TransportKind::Local).is_ok());
        assert!(parse("postgresql://u@127.0.0.1/d", &TransportKind::Local).is_err());
        assert!(parse("host=relative/dir user=u", &TransportKind::Local).is_err());
    }
}
