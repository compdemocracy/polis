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
/// The shipped default profile (pol.is). Its token variable carries no profile suffix.
fn default_profile() -> String {
    let defaults: serde_json::Value =
        serde_json::from_str(DEFAULTS).expect("shipped profile defaults are valid");
    defaults["default"]
        .as_str()
        .expect("shipped default profile")
        .to_owned()
}
fn profile_token_env(site: &str) -> String {
    format!("POLIS_TOKEN_{}", site.to_ascii_uppercase())
}
/// The token override variable to show users: `POLIS_TOKEN` for the shipped pol.is
/// profile, `POLIS_TOKEN_<PROFILE>` for developer profiles.
pub fn token_env(site: &str) -> String {
    if site == default_profile() {
        "POLIS_TOKEN".into()
    } else {
        profile_token_env(site)
    }
}
/// Variables read in order. The pol.is profile still accepts its older
/// profile-suffixed name, so existing overrides keep working.
fn token_envs(site: &str) -> Vec<String> {
    if site == default_profile() {
        vec!["POLIS_TOKEN".into(), profile_token_env(site)]
    } else {
        vec![profile_token_env(site)]
    }
}
pub fn token_override_present(site: &str) -> bool {
    token_envs(site)
        .iter()
        .any(|name| std::env::var_os(name).is_some())
}
fn token_override(site: &str) -> Result<Option<String>> {
    for name in token_envs(site) {
        match std::env::var(&name) {
            Ok(t) => {
                validate_token(&t)?;
                return Ok(Some(t));
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(Error::input(
                    "Token environment variable is not valid text.",
                ))
            }
            Err(std::env::VarError::NotPresent) => {}
        }
    }
    Ok(None)
}
/// Child processes (browser launchers) never inherit bearer overrides.
pub fn strip_token_env(command: &mut std::process::Command) {
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key == "POLIS_TOKEN" || key.starts_with("POLIS_TOKEN_") {
            command.env_remove(key.as_ref());
        }
    }
}
macro_rules! token_env_help {
    () => {
        "POLIS_TOKEN (POLIS_TOKEN_<PROFILE> for developer profiles)"
    };
}
pub const STORAGE_KEYCHAIN: &str = "macOS Keychain";
pub const STORAGE_FILE: &str = "owner-only file (0600)";

// Credential backends. On macOS an interactive sign-in stores the credential record
// in the login Keychain and leaves a secret-free pointer in the credential file. The
// file then still carries the lock, the binding and logout tombstones, so a pointer
// or tombstone decides which backend is current and stale Keychain items stay
// suppressed. The owner-only file holds the record itself when the Keychain is not
// available, under --no-interactive, with --with-token, and on other platforms.
const DEFAULT_KEYCHAIN_SERVICE: &str = "org.pol.is.cli";
fn keychain_service() -> Result<String> {
    match std::env::var("POLIS_KEYCHAIN_SERVICE") {
        Ok(v) if !v.is_empty() && v.len() <= 128 && !v.chars().any(char::is_control) => Ok(v),
        Ok(_) | Err(std::env::VarError::NotUnicode(_)) => Err(Error::input(
            "POLIS_KEYCHAIN_SERVICE must be 1–128 printable characters.",
        )),
        Err(std::env::VarError::NotPresent) => Ok(DEFAULT_KEYCHAIN_SERVICE.into()),
    }
}
/// POLIS_KEYCHAIN=off keeps every credential in the owner-only file store and
/// never calls the Keychain; the CLI's own tests and headless agents run this way.
fn keychain_supported() -> bool {
    cfg!(target_os = "macos") && std::env::var_os("POLIS_KEYCHAIN").is_none_or(|v| v != "off")
}

#[cfg(target_os = "macos")]
mod no_ui {
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
    }
    /// While held, Keychain calls fail instead of showing an unlock or access dialog.
    pub struct Guard;
    pub fn guard() -> Option<Guard> {
        // SAFETY: a process-wide flag with no pointer arguments.
        (unsafe { SecKeychainSetUserInteractionAllowed(0) } == 0).then_some(Guard)
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: as above; restores the default.
            unsafe {
                SecKeychainSetUserInteractionAllowed(1);
            }
        }
    }
}
#[cfg(not(target_os = "macos"))]
mod no_ui {
    pub struct Guard;
    pub fn guard() -> Option<Guard> {
        None
    }
}

fn store_error() -> Error {
    if keychain_allowed() {
        Error::new(
            "credential_store_unavailable",
            "Cannot access the macOS Keychain.",
            concat!(
                "Unlock your login Keychain and allow polis access, or use ",
                token_env_help!(),
                "."
            ),
            3,
        )
    } else {
        Error::new(
            "credential_store_unavailable",
            "The saved sign-in is in the macOS Keychain, which needs an unlock or access approval; --no-interactive does not show that dialog.",
            concat!("Run polis auth status once in a terminal and allow access, or use ", token_env_help!(), "."),
            3,
        )
    }
}
/// Runs one Keychain call; under --no-interactive it fails rather than prompting.
fn with_keychain<T>(
    site: &str,
    url: &str,
    f: impl FnOnce(&keyring::Entry) -> keyring::Result<T>,
) -> Result<keyring::Result<T>> {
    if !keychain_supported() {
        return Err(store_error());
    }
    let _guard = if keychain_allowed() {
        None
    } else {
        Some(no_ui::guard().ok_or_else(store_error)?)
    };
    let entry = keyring::Entry::new(&keychain_service()?, &format!("{site}@{url}"))
        .map_err(|_| store_error())?;
    Ok(f(&entry))
}
fn keychain_get(site: &str, url: &str) -> Result<Option<String>> {
    match with_keychain(site, url, |e| e.get_password())? {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(store_error()),
    }
}
fn keychain_set(site: &str, url: &str, value: &str) -> Result<()> {
    with_keychain(site, url, |e| e.set_password(value))?.map_err(|_| store_error())
}
fn keychain_delete(site: &str, url: &str) {
    let _ = with_keychain(site, url, |e| e.delete_credential());
}
/// The current credential record: file record, Keychain record named by a pointer,
/// tombstone (token and session both None), or None when nothing was ever saved.
fn load(site: &str, url: &str) -> Result<Option<SavedToken>> {
    let Some(file) = file_read(site, url)? else {
        return Ok(None);
    };
    if !file.keychain {
        return Ok(Some(file));
    }
    // A pointer whose Keychain item was removed reads as signed out.
    let Some(raw) = keychain_get(site, url)? else {
        return Ok(Some(SavedToken::tombstone(site, url)));
    };
    let record: SavedToken = serde_json::from_str(&raw).map_err(|_| store_error())?;
    if record.site != site || record.origin != url || record.keychain {
        return Err(store_error());
    }
    if let Some(t) = &record.token {
        validate_token(t)?;
    }
    Ok(Some(record))
}
/// Caller holds credential_lock. Writes the record to the Keychain when preferred and
/// available, otherwise to the owner-only file; returns the backend used.
fn persist(site: &str, url: &str, record: &SavedToken, keychain: bool) -> Result<&'static str> {
    // Validate any existing target before replacement; never follow a link.
    let previous = file_read(site, url)?;
    if keychain && keychain_supported() {
        let value = serde_json::to_string(record).unwrap();
        if keychain_set(site, url, &value).is_ok() {
            write_record(site, url, &SavedToken::pointer(site, url))?;
            return Ok(STORAGE_KEYCHAIN);
        }
    }
    write_record(site, url, record)?;
    // The file record now wins over any older Keychain item. Remove the copy this
    // record replaces (best effort, never prompting under --no-interactive).
    if previous.is_some_and(|p| p.keychain) {
        keychain_delete(site, url);
    }
    Ok(STORAGE_FILE)
}
pub fn token(site: &str, url: &str) -> Result<Option<String>> {
    if let Some(t) = token_override(site)? {
        return Ok(Some(t));
    }
    if let Some(saved) = load(site, url)? {
        return Ok(saved.token);
    }
    // Manual tokens saved by older versions live in the Keychain without a pointer.
    if !keychain_allowed() || !keychain_supported() {
        return Ok(None);
    }
    match keychain_get(site, url)? {
        Some(t) if !t.starts_with('{') => {
            validate_token(&t)?;
            Ok(Some(t))
        }
        _ => Ok(None),
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

/// Saves a manual access token: the Keychain for an interactive run on macOS,
/// otherwise the owner-only file.
pub fn store(site: &str, url: &str, token: &str) -> Result<&'static str> {
    let _lock = credential_lock(site, url)?;
    validate_token(token)?;
    persist(
        site,
        url,
        &SavedToken::record(site, url, token, None),
        keychain_allowed(),
    )
}
pub fn logout(site: &str, url: &str) -> Result<()> {
    let _lock = credential_lock(site, url)?;
    clear_session(site, url)
}
pub fn clear_session(site: &str, url: &str) -> Result<()> {
    // A tombstone suppresses any older Keychain value, even in a headless session.
    let previous = file_read(site, url)?;
    write_record(site, url, &SavedToken::tombstone(site, url))?;
    if keychain_supported() && (keychain_allowed() || previous.is_some_and(|p| p.keychain)) {
        keychain_delete(site, url);
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct SavedToken {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    participant_login: Option<String>,
    site: String,
    origin: String,
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<Session>,
    /// A secret-free pointer: the record itself is in the macOS Keychain.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    keychain: bool,
}
impl SavedToken {
    fn record(site: &str, url: &str, token: &str, session: Option<Session>) -> Self {
        Self {
            participant_login: None,
            site: site.into(),
            origin: url.into(),
            token: Some(token.into()),
            session,
            keychain: false,
        }
    }
    fn tombstone(site: &str, url: &str) -> Self {
        Self {
            participant_login: None,
            site: site.into(),
            origin: url.into(),
            token: None,
            session: None,
            keychain: false,
        }
    }
    fn pointer(site: &str, url: &str) -> Self {
        Self {
            keychain: true,
            ..Self::tombstone(site, url)
        }
    }
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
        concat!("Use an owner-only credentials directory (0700) and regular token files (0600); no symlinks. ", token_env_help!(), " can override storage."), 3)
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
    if value.site != site
        || value.origin != url
        || (value.keychain && (value.token.is_some() || value.session.is_some()))
    {
        return Err(file_error());
    }
    if let Some(t) = &value.token {
        validate_token(t)?;
    }
    Ok(Some(value))
}
/// Atomically replaces the credential file. Callers validate the existing target
/// with file_read first; the temporary file never follows a link.
fn write_record(site: &str, url: &str, value: &SavedToken) -> Result<()> {
    use std::io::Write;
    let path = credential_path(site, url)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|_| file_error())?;
    let bytes = serde_json::to_vec(value).unwrap();
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
/// `--with-token`: always the owner-only file.
pub fn store_file(site: &str, url: &str, token: &str) -> Result<()> {
    let _lock = credential_lock(site, url)?;
    validate_token(token)?;
    persist(
        site,
        url,
        &SavedToken::record(site, url, token, None),
        false,
    )
    .map(|_| ())
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
            "Another polis command is updating the saved credentials.",
            "Wait for it to finish, then rerun this command.",
            3,
        ));
    }
    Ok(file)
}
pub fn session(site: &str, url: &str) -> Result<Option<(String, Session)>> {
    let Some(saved) = load(site, url)? else {
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
/// Caller holds credential_lock through read, exchange and replacement. A new sign-in
/// goes to the Keychain when interactive on macOS; a refresh rotation stays in the
/// backend that holds the current record, falling back to the file if the Keychain
/// cannot be written (the issuer may already have consumed the old refresh token).
pub fn store_session(
    site: &str,
    url: &str,
    token: &str,
    session: Session,
    rotation: bool,
) -> Result<&'static str> {
    validate_token(token)?;
    if let Some(refresh) = &session.refresh_token {
        validate_token(refresh)?;
    }
    let keychain = if rotation {
        file_read(site, url)?.is_some_and(|p| p.keychain)
    } else {
        keychain_allowed()
    };
    persist(
        site,
        url,
        &SavedToken::record(site, url, token, Some(session)),
        keychain,
    )
}

// Participant records always use the owner-only file, never the account token
// override or Keychain. The normalized origin cannot contain a fragment, and
// conversation IDs are alphanumeric, so the scope is disjoint from account keys.
pub fn participant_scope(origin: &str, conversation: &str) -> Result<String> {
    crate::public_id(conversation)?;
    Ok(format!(
        "{}#participant={conversation}",
        polis_client::base_url(origin)?
    ))
}
pub struct ParticipantCredential {
    pub token: String,
    pub login_code: Option<String>,
}
pub fn participant_load(site: &str, scope: &str) -> Result<Option<ParticipantCredential>> {
    let Some(record) = file_read(site, scope)? else {
        return Ok(None);
    };
    if record.keychain || record.session.is_some() {
        return Err(file_error());
    }
    if let Some(code) = &record.participant_login {
        validate_token(code)?;
    }
    record
        .token
        .map(|token| {
            Ok(ParticipantCredential {
                token,
                login_code: record.participant_login,
            })
        })
        .transpose()
}
/// Caller holds credential_lock for this participant scope through the request
/// and replacement. Future participant actions save their issued token here too.
pub fn participant_store(
    site: &str,
    scope: &str,
    token: &str,
    login_code: Option<String>,
) -> Result<()> {
    validate_token(token)?;
    if let Some(code) = &login_code {
        validate_token(code)?;
    }
    let mut record = SavedToken::record(site, scope, token, None);
    record.participant_login = login_code;
    file_read(site, scope)?;
    write_record(site, scope, &record)
}
