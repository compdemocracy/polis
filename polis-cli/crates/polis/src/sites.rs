use crate::profiles::{self, AuthConfig, Config};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::Path,
};

fn unsafe_config() -> Error {
    Error::input("Cannot safely update site configuration. Use an owned directory without group/other write access and a regular, owned profiles.json file; no symlinks or hard links.")
}

fn check_file(file: &File) -> Result<()> {
    let m = file.metadata().map_err(|_| unsafe_config())?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.nlink() != 1
        || m.mode() & 0o022 != 0
    {
        return Err(unsafe_config());
    }
    Ok(())
}

fn saved(path: &Path) -> Result<Value> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::to_value(Config::default()).unwrap())
        }
        Err(_) => return Err(unsafe_config()),
    };
    check_file(&file)?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unsafe_config())?;
    if bytes.len() > 1024 * 1024 {
        return Err(Error::input("Site configuration exceeds 1 MiB."));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::input("Invalid profiles.json. Correct the file before continuing."))
}

fn configuration_lock(path: &Path) -> Result<File> {
    let dir = path.parent().unwrap();
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|_| unsafe_config())?;
    let m = std::fs::symlink_metadata(dir).map_err(|_| unsafe_config())?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
        return Err(unsafe_config());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join("profiles.lock"))
        .map_err(|_| unsafe_config())?;
    check_file(&lock)?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Error::input(
            "Another polis command is updating sites. Retry after it finishes.",
        ));
    }
    Ok(lock)
}

fn auth(m: &ArgMatches) -> Result<AuthConfig> {
    let defaults = Config::default();
    let mut a = AuthConfig {
        callback_port: defaults.auth[&defaults.default].callback_port,
        ..AuthConfig::default()
    };
    for (key, field) in [
        ("issuer", &mut a.issuer),
        ("client-id", &mut a.client_id),
        ("audience", &mut a.audience),
    ] {
        if let Some(value) = m.get_one::<String>(key) {
            if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
                return Err(Error::input(
                    "Authentication settings must be nonempty printable text, at most 2048 bytes.",
                ));
            }
            *field = value.clone();
        }
    }
    if let Some(port) = m.get_one::<u16>("callback-port") {
        a.callback_port = *port;
    }
    if !a.issuer.is_empty() {
        let u = url::Url::parse(&a.issuer).map_err(|_| Error::input("Invalid issuer URL."))?;
        let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(u.scheme() == "https" || (u.scheme() == "http" && local))
            || u.host_str().is_none()
            || !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
        {
            return Err(Error::input("Issuer must use HTTPS (HTTP only on loopback), without credentials, query or fragment."));
        }
    }
    Ok(a)
}

pub fn load(selected: Option<&str>) -> Result<Config> {
    let config: Config = serde_json::from_value(saved(&profiles::path()?)?)
        .map_err(|_| Error::input("Invalid profiles.json. Correct the file before continuing."))?;
    config.with_overrides(selected)
}

pub fn execute(path: &str, m: &ArgMatches, effective: &Config, selected: &str) -> Result<Value> {
    if path == "site list" {
        let stored: Config = serde_json::from_value(saved(&profiles::path()?)?).map_err(|_| {
            Error::input("Invalid profiles.json. Correct the file before continuing.")
        })?;
        for (name, origin) in &effective.sites {
            profiles::name(name)?;
            if !origin.is_empty() {
                polis_client::base_url(origin)?;
            }
        }
        let rows: Vec<Value> = effective
            .sites
            .iter()
            .map(|(name, origin)| {
                json!({
                    "name":name, "url":origin, "selected":name == selected,
                    "saved_default":name == &stored.default,
                })
            })
            .collect();
        return Ok(json!({"sites":rows,"selected":selected,"saved_default":stored.default}));
    }
    let requested = m.get_one::<String>("name").unwrap();
    profiles::name(requested)?;
    let defaults = Config::default();
    if requested == "default" && path != "site use" {
        return Err(Error::input(
            "The name default is reserved for pol.is. Use site use default to return to it.",
        ));
    }
    let name = if requested == "default" {
        &defaults.default
    } else {
        requested
    };
    // Validate all supplied values before creating directories or opening a lock.
    let added = if path == "site add" {
        let origin = polis_client::base_url(m.get_one::<String>("url").unwrap())?.to_string();
        Some((origin, auth(m)?))
    } else {
        None
    };
    let file = profiles::path()?;
    let _lock = configuration_lock(&file)?;
    let mut raw = saved(&file)?;
    let mut config: Config = serde_json::from_value(raw.clone())
        .map_err(|_| Error::input("Invalid profiles.json. Correct the file before continuing."))?;
    let defaults = Config::default();
    let builtin = &defaults.default;
    match path {
        "site add" => {
            if config.sites.contains_key(name) || name == builtin {
                return Err(Error::input("Site name already exists. Choose another name; existing sign-in settings are never overwritten."));
            }
            let (origin, auth) = added.unwrap();
            config.sites.insert(name.clone(), origin);
            config.auth.insert(name.clone(), auth);
        }
        "site use" => {
            if name == builtin && !config.sites.contains_key(builtin) {
                config
                    .sites
                    .entry(builtin.clone())
                    .or_insert_with(|| defaults.sites[builtin].clone());
                config
                    .auth
                    .entry(builtin.clone())
                    .or_insert_with(|| defaults.auth[builtin].clone());
            }
            config.url(name)?;
            config.default = name.clone();
        }
        "site remove" => {
            if name == builtin {
                return Err(Error::input("The built-in pol.is site cannot be removed."));
            }
            if config.sites.remove(name).is_none() {
                return Err(Error::input("Unknown site name."));
            }
            config.auth.remove(name);
            if config.default == *name {
                config.default = builtin.clone();
                config
                    .sites
                    .entry(builtin.clone())
                    .or_insert_with(|| defaults.sites[builtin].clone());
                config
                    .auth
                    .entry(builtin.clone())
                    .or_insert_with(|| defaults.auth[builtin].clone());
            }
        }
        _ => unreachable!(),
    }
    // Preserve extension keys and never persist environment overrides.
    raw["default"] = json!(config.default);
    raw["sites"] = json!(config.sites);
    let mut stored_auth = raw.get("auth").cloned().unwrap_or_else(|| json!({}));
    if !stored_auth.is_object() {
        return Err(Error::input("Invalid auth settings in profiles.json."));
    }
    if path == "site add" {
        stored_auth[name] = json!(config.auth[name]);
    }
    if path == "site remove" {
        stored_auth.as_object_mut().unwrap().remove(name);
        if stored_auth.get(builtin).is_none() {
            if let Some(a) = config.auth.get(builtin) {
                stored_auth[builtin] = json!(a);
            }
        }
    }
    if path == "site use" && name == builtin && stored_auth.get(builtin).is_none() {
        if let Some(auth) = config.auth.get(builtin) {
            stored_auth[builtin] = json!(auth);
        }
    }
    raw["auth"] = stored_auth;
    let bytes = serde_json::to_vec_pretty(&raw).unwrap();
    if bytes.len() > 1024 * 1024 {
        return Err(Error::input("Site configuration exceeds 1 MiB."));
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(file.parent().unwrap()).map_err(|_| unsafe_config())?;
    temp.write_all(&bytes).map_err(|_| unsafe_config())?;
    temp.as_file().sync_all().map_err(|_| unsafe_config())?;
    temp.persist(&file).map_err(|_| unsafe_config())?;
    Ok(
        json!({"name":name,"saved_default":config.default,"state":match path {"site add"=>"added","site use"=>"selected",_=>"removed"},
        "note":"Site configuration only. Sign-ins are scoped to site name and origin. Removing an alias does not revoke or delete its sign-in; log out before removal if needed. POLIS_SITE and --site override the saved default."}),
    )
}

/// Human context goes to stderr so raw tokens, exports and JSON stay pipeable.
pub fn print_header(config: &Config, site: &str) {
    // The shipped default origin comes from defaults.json, not a literal.
    let defaults = Config::default();
    let shipped = polis_client::base_url(&defaults.sites[&defaults.default])
        .map(|u| u.origin().ascii_serialization())
        .ok();
    match config.url(site).and_then(polis_client::base_url) {
        Ok(url) => {
            let origin = url.origin().ascii_serialization();
            if shipped.as_deref() != Some(origin.as_str()) {
                eprintln!("Site: {site} ({origin})");
            }
        }
        Err(_) => eprintln!("Site: {site}"),
    }
}
