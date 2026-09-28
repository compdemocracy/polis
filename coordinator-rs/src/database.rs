//! One fail-closed connection policy for startup, recovery and renewal.
//! No error retains its driver/OS cause: those can contain credentials or DSNs.
use native_tls::{Certificate, Protocol, TlsConnector};
use percent_encoding::percent_decode_str;
use postgres::{
    Client, Config as PgConfig,
    config::{Host, SslMode},
};
use postgres_native_tls::MakeTlsConnector;
use std::{env, path::Path, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseError {
    Dsn,
    SslMode,
    Host,
    PasswordConflict,
    PasswordFile,
    CaBundle,
    Connect,
}
impl DatabaseError {
    pub fn token(self) -> &'static str {
        match self {
            Self::Dsn => "DB-DSN-REFUSED",
            Self::SslMode => "DB-SSLMODE-REFUSED",
            Self::Host => "DB-HOST-REFUSED",
            Self::PasswordConflict => "DB-PASSWORD-CONFLICT",
            Self::PasswordFile => "DB-PASSWORD-FILE",
            Self::CaBundle => "DB-CA-BUNDLE",
            Self::Connect => "DB-CONNECTION-REFUSED",
        }
    }
}
impl std::fmt::Display for DatabaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.token())
    }
}
impl std::error::Error for DatabaseError {}
type Result<T> = std::result::Result<T, DatabaseError>;

// Keep credentials private, including from Debug and tracing output.
#[derive(Clone)]
pub struct Database {
    config: PgConfig,
    tls: TlsConnector,
}

fn decode(s: &str) -> Result<String> {
    // percent_decode_str permits malformed escapes; the policy does not.
    let b = s.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'%'
            && (i + 2 >= b.len() || !b[i + 1].is_ascii_hexdigit() || !b[i + 2].is_ascii_hexdigit())
        {
            return Err(DatabaseError::Dsn);
        }
    }
    percent_decode_str(s)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| DatabaseError::Dsn)
}
fn sslmode(value: &str) -> Result<()> {
    if value == "verify-full" {
        Ok(())
    } else {
        Err(DatabaseError::SslMode)
    }
}

/// Normalize just the public verify-full spelling to the driver's Require.
/// Verification is enforced independently by the connector, never DSN options.
fn normalize(dsn: &str) -> Result<String> {
    if dsn.starts_with("postgres://") || dsn.starts_with("postgresql://") {
        let Some((base, query)) = dsn.split_once('?') else {
            return Ok(dsn.into());
        };
        let mut seen = std::collections::HashSet::new();
        let mut fields = Vec::new();
        for field in query.split('&') {
            let (key, value) = field.split_once('=').ok_or(DatabaseError::Dsn)?;
            let key = decode(key)?;
            if !seen.insert(key.clone()) {
                return Err(DatabaseError::Dsn);
            }
            if key == "sslmode" {
                sslmode(&decode(value)?)?;
                fields.push("sslmode=require".to_owned());
            } else {
                fields.push(field.to_owned());
            }
        }
        return Ok(format!("{base}?{}", fields.join("&")));
    }
    // libpq keyword syntax, including escaped/quoted passwords. Do not do a
    // string replacement: password='sslmode=disable' is ordinary password data.
    let mut chars = dsn.chars().peekable();
    let mut fields = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut key = String::new();
        while chars
            .peek()
            .is_some_and(|c| !c.is_whitespace() && *c != '=')
        {
            key.push(chars.next().ok_or(DatabaseError::Dsn)?);
        }
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if key.is_empty() || chars.next() != Some('=') || !seen.insert(key.clone()) {
            return Err(DatabaseError::Dsn);
        }
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let quoted = chars.peek() == Some(&'\'');
        if quoted {
            chars.next();
        }
        let mut value = String::new();
        let mut closed = !quoted;
        while let Some(c) = chars.next() {
            if c == '\\' {
                value.push(chars.next().ok_or(DatabaseError::Dsn)?);
            } else if quoted && c == '\'' {
                closed = true;
                break;
            } else if !quoted && c.is_whitespace() {
                break;
            } else {
                value.push(c);
            }
        }
        if !closed || (quoted && chars.peek().is_some_and(|c| !c.is_whitespace())) {
            return Err(DatabaseError::Dsn);
        }
        if key == "sslmode" {
            sslmode(&value)?;
            value = "require".into();
        }
        fields.push(format!(
            "{key}='{}'",
            value.replace('\\', "\\\\").replace('\'', "\\'")
        ));
    }
    Ok(fields.join(" "))
}

pub fn parse(dsn: &str, hosts: &[String], password_file: bool) -> Result<PgConfig> {
    let mut config: PgConfig = normalize(dsn)?.parse().map_err(|_| DatabaseError::Dsn)?;
    if password_file && config.get_password().is_some() {
        return Err(DatabaseError::PasswordConflict);
    }
    // No implicit localhost, Unix socket, hostaddr bypass, wildcard or fallback.
    if hosts.is_empty()
        || config.get_hosts().is_empty()
        || !config.get_hostaddrs().is_empty()
        || config.get_hosts().iter().any(|h| match h {
            Host::Tcp(name) => name.is_empty() || !hosts.contains(name),
            _ => true,
        })
    {
        return Err(DatabaseError::Host);
    }
    config.ssl_mode(SslMode::Require);
    config.connect_timeout(Duration::from_secs(10));
    Ok(config)
}
impl Database {
    pub fn from_env() -> Result<Self> {
        let dsn = env::var("DATABASE_URL").map_err(|_| DatabaseError::Dsn)?;
        let hosts = env::var("COORDINATOR_DB_HOST_ALLOWLIST")
            .map_err(|_| DatabaseError::Host)?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let ca = env::var_os("COORDINATOR_DB_CA_BUNDLE").ok_or(DatabaseError::CaBundle)?;
        let password = env::var_os("COORDINATOR_DB_PASSWORD_FILE");
        Self::new(
            &dsn,
            &hosts,
            Path::new(&ca),
            password.as_deref().map(Path::new),
        )
    }
    pub fn new(dsn: &str, hosts: &[String], ca: &Path, password: Option<&Path>) -> Result<Self> {
        let mut config = parse(dsn, hosts, password.is_some())?;
        if let Some(path) = password {
            let bytes = std::fs::read(path).map_err(|_| DatabaseError::PasswordFile)?;
            if bytes.is_empty() || bytes.len() > 65536 || bytes.contains(&0) {
                return Err(DatabaseError::PasswordFile);
            }
            config.password(bytes);
        }
        let pem = std::fs::read_to_string(ca).map_err(|_| DatabaseError::CaBundle)?;
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
            if !part.trim_start().starts_with("-----BEGIN CERTIFICATE-----") || !part.ends_with(end)
            {
                return Err(DatabaseError::CaBundle);
            }
            let cert = Certificate::from_pem(part.trim().as_bytes())
                .map_err(|_| DatabaseError::CaBundle)?;
            builder.add_root_certificate(cert);
            count += 1;
        }
        if count == 0 {
            return Err(DatabaseError::CaBundle);
        }
        let tls = builder.build().map_err(|_| DatabaseError::CaBundle)?;
        Ok(Self { config, tls })
    }
    pub fn connect(&self) -> Result<Client> {
        self.config
            .connect(MakeTlsConnector::new(self.tls.clone()))
            .map_err(|_| DatabaseError::Connect)
    }
}
