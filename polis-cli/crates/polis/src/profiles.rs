use polis_contracts::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

const DEFAULTS: &str = include_str!("../../../defaults.json");

static NO_INTERACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn noninteractive(enabled: bool) {
    NO_INTERACTIVE.store(enabled, std::sync::atomic::Ordering::Relaxed);
}
fn keychain_allowed() -> bool {
    !NO_INTERACTIVE.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub auth: BTreeMap<String, AuthConfig>,
    pub default: String,
    pub sites: BTreeMap<String, String>,
}
impl Default for Config {
    fn default() -> Self {
        serde_json::from_str(DEFAULTS).expect("shipped profile defaults are valid")
    }
}
pub fn name(raw: &str) -> Result<()> {
    if raw.is_empty()
        || raw.len() > 40
        || !raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(Error::input(
            "Profile names use 1–40 lowercase letters, digits, or underscores.",
        ));
    }
    Ok(())
}
fn path() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("POLIS_CONFIG_DIR") {
        return Ok(PathBuf::from(dir).join("profiles.json"));
    }
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".config/polis/profiles.json"))
        .ok_or_else(|| Error::input("Set HOME or POLIS_CONFIG_DIR."))
}
impl Config {
    pub fn load() -> Result<Self> {
        let mut config = match std::fs::read(path()?) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                Error::input("Invalid profiles.json. Correct the file before continuing.")
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err(Error::input("Cannot read profiles.json.")),
        }?;
        if let Ok(site) = std::env::var("POLIS_SITE") {
            name(&site)?;
            config.default = site;
        }
        for (site, origin) in &mut config.sites {
            if let Ok(value) = std::env::var(format!("POLIS_URL_{}", site.to_ascii_uppercase())) {
                *origin = polis_client::base_url(&value)?.to_string();
            }
        }
        Ok(config)
    }

    pub fn url(&self, site: &str) -> Result<&str> {
        name(site)?;
        let url = self
            .sites
            .get(site)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                Error::new(
                    "site_unconfigured",
                    format!("Site '{site}' needs an origin."),
                    "Set the origin in profiles.json or the matching POLIS_URL_<PROFILE> developer variable.",
                    2,
                )
            })?;
        polis_client::base_url(url)?;
        Ok(url)
    }
}
pub fn token_env(site: &str) -> String {
    format!("POLIS_TOKEN_{}", site.to_ascii_uppercase())
}
fn entry(site: &str, url: &str) -> Result<keyring::Entry> {
    if !keychain_allowed() {
        return Err(Error::new("credential_store_disabled", "Keychain access is disabled by --no-interactive.", "Use the profile-specific token environment variable; omit --no-interactive for Keychain changes.", 3));
    }
    keyring::Entry::new("org.pol.is.cli", &format!("{site}@{url}")).map_err(|_| store_error())
}
fn store_error() -> Error {
    Error::new(
        "credential_store_unavailable",
        "Cannot access macOS Keychain.",
        "Unlock your Keychain or use the profile-specific POLIS_TOKEN_<SITE> environment variable.",
        3,
    )
}
pub fn token(site: &str, url: &str) -> Result<Option<String>> {
    match std::env::var(token_env(site)) {
        Ok(t) => {
            validate_token(&t)?;
            return Ok(Some(t));
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(Error::input(
                "Token environment variable is not valid text.",
            ))
        }
        Err(_) => {}
    }
    if let Some(saved) = file_read(site, url)? {
        return Ok(saved.token);
    }
    if !keychain_allowed() {
        return Ok(None);
    }
    match entry(site, url)?.get_password() {
        Ok(t) => {
            validate_token(&t)?;
            Ok(Some(t))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(store_error()),
    }
}
pub fn validate_token(token: &str) -> Result<()> {
    if token.is_empty()
        || token.len() > 65536
        || token.chars().any(char::is_whitespace)
        || token.chars().any(char::is_control)
    {
        return Err(Error::input(
            "Token is empty, too long, or contains whitespace.",
        ));
    }
    Ok(())
}

pub fn store(site: &str, url: &str, token: &str) -> Result<&'static str> {
    let _lock = credential_lock(site, url)?;
    validate_token(token)?;
    // Existing file credentials stay in that backend; avoid reviving stale Keychain entries.
    if file_read(site, url)?.is_none()
        && keychain_allowed()
        && entry(site, url)?.set_password(token).is_ok()
    {
        return Ok("macOS Keychain");
    }
    file_write(site, url, Some(token.to_owned()))?;
    Ok("owner-only file (0600)")
}
pub fn logout(site: &str, url: &str) -> Result<()> {
    let _lock = credential_lock(site, url)?;
    clear_session(site, url)
}
pub fn clear_session(site: &str, url: &str) -> Result<()> {
    // A tombstone suppresses any older Keychain value, even in a headless session.
    file_write(site, url, None)?;
    if keychain_allowed() {
        let _ = entry(site, url)?.delete_credential();
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct SavedToken {
    site: String,
    origin: String,
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<Session>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub issuer: String,
    pub client_id: String,
    pub audience: String,
    pub expires_at: u64,
    pub refresh_token: Option<String>,
}
fn file_error() -> Error {
    Error::new("credential_file_unsafe", "Cannot safely access the credential file.",
        "Use an owner-only credentials directory (0700) and regular token files (0600); no symlinks. POLIS_TOKEN_<SITE> can override storage.", 3)
}
fn credential_path(site: &str, url: &str) -> Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    name(site)?;
    let parent = path()?.parent().unwrap().join("credentials");
    std::fs::create_dir_all(parent.parent().unwrap()).map_err(|_| file_error())?;
    match std::fs::DirBuilder::new().mode(0o700).create(&parent) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(file_error()),
    }
    let m = std::fs::symlink_metadata(&parent).map_err(|_| file_error())?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
        return Err(file_error());
    }
    let key = serde_json::to_vec(&(site, url)).unwrap();
    Ok(parent.join(format!(
        "{}.json",
        uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, &key)
    )))
}
fn file_read(site: &str, url: &str) -> Result<Option<SavedToken>> {
    use std::{
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let path = credential_path(site, url)?;
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(file_error()),
    };
    let m = file.metadata().map_err(|_| file_error())?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.nlink() != 1
    {
        return Err(file_error());
    }
    let mut bytes = Vec::new();
    file.take(100_001)
        .read_to_end(&mut bytes)
        .map_err(|_| file_error())?;
    if bytes.len() > 100_000 {
        return Err(file_error());
    }
    let value: SavedToken = serde_json::from_slice(&bytes).map_err(|_| file_error())?;
    if value.site != site || value.origin != url {
        return Err(file_error());
    }
    if let Some(t) = &value.token {
        validate_token(t)?;
    }
    Ok(Some(value))
}
fn file_write(site: &str, url: &str, token: Option<String>) -> Result<()> {
    use std::io::Write;
    // Validate any existing target before atomic replacement; never follow a link.
    file_read(site, url)?;
    let path = credential_path(site, url)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|_| file_error())?;
    let value = SavedToken {
        site: site.into(),
        origin: url.into(),
        token,
        session: None,
    };
    let bytes = serde_json::to_vec(&value).unwrap();
    if bytes.len() > 100_000 {
        return Err(file_error());
    }
    temp.write_all(&bytes).map_err(|_| file_error())?;
    temp.as_file().sync_all().map_err(|_| file_error())?;
    temp.persist(&path).map_err(|_| file_error())?;
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct AuthConfig {
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub audience: String,
    #[serde(default)]
    pub ca_file: Option<String>,
    #[serde(default = "callback_port")]
    pub callback_port: u16,
}
fn callback_port() -> u16 {
    // Preserve the fallback for older profile files, without embedding a provider
    // registration value in Rust. Parse as Value to avoid recursive defaults.
    let defaults: serde_json::Value =
        serde_json::from_str(DEFAULTS).expect("shipped profile defaults are valid");
    let profile = defaults["default"]
        .as_str()
        .expect("shipped default profile");
    defaults["auth"][profile]["callback_port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .expect("shipped callback port is valid")
}
impl Config {
    pub fn auth(&self, site: &str) -> Result<AuthConfig> {
        let mut a = self.auth.get(site).cloned().unwrap_or(AuthConfig {
            callback_port: callback_port(),
            ..AuthConfig::default()
        });
        for (key, target) in [
            ("ISSUER", &mut a.issuer),
            ("CLIENT_ID", &mut a.client_id),
            ("AUDIENCE", &mut a.audience),
        ] {
            if let Ok(v) = std::env::var(format!("POLIS_AUTH_{key}_{}", site.to_ascii_uppercase()))
            {
                *target = v;
            }
        }
        if let Ok(v) = std::env::var(format!("POLIS_CA_FILE_{}", site.to_ascii_uppercase())) {
            a.ca_file = Some(v);
        }
        if let Ok(v) = std::env::var(format!(
            "POLIS_AUTH_CALLBACK_PORT_{}",
            site.to_ascii_uppercase()
        )) {
            a.callback_port = v.parse().map_err(|_| {
                Error::input("Callback port must be an integer from 0 through 65535.")
            })?;
        }
        Ok(a)
    }
}
pub fn store_file(site: &str, url: &str, token: &str) -> Result<()> {
    let _lock = credential_lock(site, url)?;
    validate_token(token)?;
    file_write(site, url, Some(token.into()))
}

// File locks serialize refresh rotation with logout/login, across CLI processes.
// Locks are released by the kernel even after an interrupted process.
pub fn credential_lock(site: &str, url: &str) -> Result<std::fs::File> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let lock = credential_path(site, url)?.with_extension("lock");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(lock)
        .map_err(|_| file_error())?;
    let m = file.metadata().map_err(|_| file_error())?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.nlink() != 1
    {
        return Err(file_error());
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Error::new(
            "credential_busy",
            "Another command is updating this site's credentials.",
            "Wait for it to finish, then rerun this command.",
            3,
        ));
    }
    Ok(file)
}
pub fn session(site: &str, url: &str) -> Result<Option<(String, Session)>> {
    let Some(saved) = file_read(site, url)? else {
        return Ok(None);
    };
    match (saved.token, saved.session) {
        (Some(token), Some(session)) => {
            if let Some(refresh) = &session.refresh_token {
                validate_token(refresh)?;
            }
            Ok(Some((token, session)))
        }
        (None, Some(_)) => Err(file_error()),
        _ => Ok(None),
    }
}
// Caller holds credential_lock through read, exchange and replacement.
pub fn store_session(site: &str, url: &str, token: &str, session: Session) -> Result<()> {
    use std::io::Write;
    validate_token(token)?;
    if let Some(refresh) = &session.refresh_token {
        validate_token(refresh)?;
    }
    file_read(site, url)?;
    let path = credential_path(site, url)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|_| file_error())?;
    let value = SavedToken {
        site: site.into(),
        origin: url.into(),
        token: Some(token.into()),
        session: Some(session),
    };
    let bytes = serde_json::to_vec(&value).unwrap();
    if bytes.len() > 100_000 {
        return Err(file_error());
    }
    temp.write_all(&bytes).map_err(|_| file_error())?;
    temp.as_file().sync_all().map_err(|_| file_error())?;
    temp.persist(&path).map_err(|_| file_error())?;
    Ok(())
}
