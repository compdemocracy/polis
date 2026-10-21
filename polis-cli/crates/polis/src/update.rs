//! Explicit executable updates. This module never reads site credentials.
use polis_contracts::{Error, Result};
use reqwest::blocking::Client;
use semver::Version;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};
use url::Url;

pub const DEFAULT_RELEASE_BASE: &str = "https://api.github.com/repos/compdemocracy/polis/releases";
const MAX_ARCHIVE: u64 = 200 * 1024 * 1024;
const MAX_BINARY: u64 = 300 * 1024 * 1024;

fn fail(message: &str) -> Error {
    Error::new("update_failed", message, "The installed executable is unchanged unless stated otherwise. Check the release source and install directory, then run polis update explicitly again.", 1)
}
fn valid_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| Error::input("Invalid release URL."))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::input("Release URLs require HTTPS (HTTP is allowed only on loopback), no credentials, and no fragment."));
    }
    Ok(url)
}
fn get(client: &Client, url: Url, limit: u64) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .map_err(|_| fail("Cannot download release data."))?;
    if !response.status().is_success() {
        return Err(fail("Release server returned an unsuccessful status."));
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail("Cannot read release data."))?;
    if bytes.len() as u64 > limit {
        return Err(fail("Release data exceeds its size limit."));
    }
    Ok(bytes)
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Manifest {
    schema: String,
    version: String,
    commit: String,
    target: String,
    source: String,
    binary_sha256: String,
}
fn target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        _ => Err(fail("No release target for this operating system and CPU.")),
    }
}
fn latest(client: &Client, base: Url) -> Result<(Version, Release)> {
    let mut chosen: Option<(Version, Release)> = None;
    for page in 1..=10 {
        let mut url = base.clone();
        url.query_pairs_mut()
            .append_pair("per_page", "100")
            .append_pair("page", &page.to_string());
        let releases: Vec<Release> = serde_json::from_slice(&get(client, url, 8 * 1024 * 1024)?)
            .map_err(|_| fail("Invalid release list."))?;
        let last = releases.len() < 100;
        for release in releases {
            if release.draft || release.prerelease {
                continue;
            }
            let Some(version) = release
                .tag_name
                .strip_prefix("cli-v")
                .and_then(|s| Version::parse(s).ok())
            else {
                continue;
            };
            if !version.pre.is_empty() || !version.build.is_empty() {
                continue;
            }
            if chosen.as_ref().is_none_or(|(v, _)| version > *v) {
                chosen = Some((version, release));
            }
        }
        if last {
            return chosen.ok_or_else(|| fail("No published stable CLI release was found."));
        }
    }
    Err(fail(
        "Release list exceeds ten pages; cannot determine the latest CLI release.",
    ))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn unpack(
    bytes: &[u8],
    name: &str,
    version: &Version,
    platform: &str,
) -> Result<(Vec<u8>, Manifest)> {
    let root = name
        .strip_suffix(".tar.gz")
        .ok_or_else(|| fail("Invalid archive name."))?;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder.take(MAX_BINARY + 1024 * 1024));
    let mut binary = None;
    let mut manifest = None;
    let mut seen = std::collections::BTreeSet::new();
    for entry in archive
        .entries()
        .map_err(|_| fail("Invalid release archive."))?
    {
        let mut entry = entry.map_err(|_| fail("Invalid archive member."))?;
        let path = entry.path().map_err(|_| fail("Invalid archive path."))?;
        let path = path.to_str().ok_or_else(|| fail("Invalid archive path."))?;
        let part = path
            .strip_prefix(&format!("{root}/"))
            .ok_or_else(|| fail("Unexpected archive directory."))?
            .to_owned();
        if !matches!(
            part.as_str(),
            "polis" | "manifest.json" | "LICENSE" | "README.txt"
        ) || !entry.header().entry_type().is_file()
            || !seen.insert(part.clone())
        {
            return Err(fail("Unexpected, linked, or duplicate archive member."));
        }
        let limit = if part == "polis" {
            MAX_BINARY
        } else {
            64 * 1024
        };
        if entry.size() > limit {
            return Err(fail("Archive member exceeds its size limit."));
        }
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|_| fail("Cannot read archive member."))?;
        match part.as_str() {
            "polis" => binary = Some(data),
            "manifest.json" => {
                manifest = Some(
                    serde_json::from_slice::<Manifest>(&data)
                        .map_err(|_| fail("Invalid release manifest."))?,
                )
            }
            _ => (),
        }
    }
    if seen.len() != 4 {
        return Err(fail("Incomplete release archive."));
    }
    let binary = binary.ok_or_else(|| fail("Release archive lacks polis."))?;
    let manifest = manifest.ok_or_else(|| fail("Release archive lacks a manifest."))?;
    if manifest.schema != "polis-cli-release/1"
        || manifest.version != version.to_string()
        || manifest.target != platform
        || manifest.source != "clean-checkout"
        || manifest.commit.len() != 40
        || !manifest
            .commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || manifest.binary_sha256 != digest(&binary)
        || binary.is_empty()
        || root != format!("polis-{version}-{}-{platform}", &manifest.commit[..12])
    {
        return Err(fail(
            "Release manifest, target, source, or binary checksum does not match.",
        ));
    }
    Ok((binary, manifest))
}
#[cfg(unix)]
fn install(executable: &Path, binary: &[u8], expected: &str) -> Result<()> {
    install_with_directory_sync(executable, binary, expected, fs::File::sync_all)
}
#[cfg(unix)]
fn install_with_directory_sync(
    executable: &Path,
    binary: &[u8],
    expected: &str,
    mut sync_directory: impl FnMut(&fs::File) -> std::io::Result<()>,
) -> Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let parent = executable
        .parent()
        .ok_or_else(|| fail("Cannot locate installation directory."))?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(parent.join(".polis-update.lock"))
        .map_err(|_| fail("Cannot open the update lock in the installation directory."))?;
    // Keep the lock inode: deleting it allows another updater to lock a different inode.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(fail("Another update is in progress."));
    }
    let meta = fs::symlink_metadata(executable)
        .map_err(|_| fail("Cannot inspect installed executable."))?;
    if !meta.is_file() || executable.file_name().is_none_or(|name| name != "polis") {
        return Err(fail(
            "Install the executable as a regular file named polis before updating.",
        ));
    }
    if digest(&fs::read(executable).map_err(|_| fail("Cannot recheck installed executable."))?)
        != expected
    {
        return Err(fail(
            "The installed executable changed while downloading; run the installed version again.",
        ));
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| fail("Installation directory is not writable."))?;
    staged
        .write_all(binary)
        .map_err(|_| fail("Cannot stage the new executable."))?;
    staged
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o755))
        .map_err(|_| fail("Cannot set executable permissions."))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|_| fail("Cannot sync the new executable."))?;
    let mut backup = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| fail("Cannot stage the previous executable."))?;
    let mut original =
        fs::File::open(executable).map_err(|_| fail("Cannot read installed executable."))?;
    std::io::copy(&mut original, &mut backup)
        .map_err(|_| fail("Cannot preserve the previous executable."))?;
    backup
        .as_file()
        .set_permissions(fs::Permissions::from_mode(
            meta.permissions().mode() & 0o777,
        ))
        .map_err(|_| fail("Cannot set backup permissions."))?;
    backup
        .as_file()
        .sync_all()
        .map_err(|_| fail("Cannot sync the previous executable."))?;
    backup
        .persist(parent.join("polis.prev"))
        .map_err(|_| fail("Cannot save polis.prev."))?;
    let directory =
        fs::File::open(parent).map_err(|_| fail("Cannot open installation directory."))?;
    sync_directory(&directory).map_err(|_| fail("Cannot sync polis.prev."))?;
    staged
        .persist(executable)
        .map_err(|_| fail("Cannot atomically replace polis; polis.prev has been saved."))?;
    sync_directory(&directory).map_err(|_| {
        let mut error = Error::new(
            "update_sync_failed",
            "The executable was replaced and polis.prev saved, but syncing the directory failed.",
            "Inspect polis --version before retrying; installation durability is uncertain.",
            7,
        );
        error.outcome = "unknown";
        error
    })?;
    Ok(())
}
#[cfg(not(unix))]
fn install(_: &Path, _: &[u8], _: &str) -> Result<()> {
    Err(fail("This platform does not support CLI updates."))
}

pub fn execute(base: Option<&str>, timeout: u64) -> Result<Value> {
    let platform = target()?;
    let configured = base
        .map(str::to_owned)
        .or_else(|| std::env::var("POLIS_RELEASE_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_RELEASE_BASE.to_owned());
    let base = valid_url(&configured)?;
    if base.query().is_some() {
        return Err(Error::input(
            "Release base URL must not have query parameters.",
        ));
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent("polis-cli-updater")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5
                || valid_url(attempt.url().as_str()).is_err()
                || (attempt.previous().iter().any(|u| u.scheme() == "https")
                    && attempt.url().scheme() != "https")
            {
                attempt.error("Invalid release redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| fail("Cannot create release client."))?;
    let executable =
        std::env::current_exe().map_err(|_| fail("Cannot locate running executable."))?;
    let installed_digest =
        digest(&fs::read(&executable).map_err(|_| fail("Cannot read installed executable."))?);
    let (version, release) = latest(&client, base)?;
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| fail("Invalid installed version."))?;
    if version <= current {
        return Ok(
            json!({"state":"up_to_date", "version":current.to_string(), "commit":env!("POLIS_BUILD_COMMIT"), "latest":version.to_string(), "message":"No newer stable CLI release is available."}),
        );
    }
    let suffix = format!("-{platform}.tar.gz");
    let candidates: Vec<_> = release
        .assets
        .iter()
        .filter(|a| a.name.starts_with(&format!("polis-{version}-")) && a.name.ends_with(&suffix))
        .collect();
    if candidates.len() != 1 {
        return Err(fail(
            "The latest CLI release does not contain exactly one archive for this platform.",
        ));
    }
    let asset = candidates[0];
    if !asset
        .name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
    {
        return Err(fail("Invalid release asset name."));
    }
    let checksums: Vec<_> = release
        .assets
        .iter()
        .filter(|a| a.name == format!("{}.sha256", asset.name))
        .collect();
    if checksums.len() != 1 {
        return Err(fail(
            "The release must contain one checksum for this archive.",
        ));
    }
    let checksum = get(
        &client,
        valid_url(&checksums[0].browser_download_url)?,
        1024,
    )?;
    let bytes = get(
        &client,
        valid_url(&asset.browser_download_url)?,
        MAX_ARCHIVE,
    )?;
    let expected = format!("{}  {}\n", digest(&bytes), asset.name);
    if checksum != expected.as_bytes() {
        return Err(fail("Release archive checksum mismatch."));
    }
    let (binary, manifest) = unpack(&bytes, &asset.name, &version, platform)?;
    install(&executable, &binary, &installed_digest)?;
    Ok(
        json!({"state":"updated", "from":{"version":current.to_string(),"commit":env!("POLIS_BUILD_COMMIT")}, "to":{"version":version.to_string(),"commit":manifest.commit}, "target":platform, "backup":"polis.prev", "changes":release.body.unwrap_or_default(), "message":"Updated polis; the previous executable is saved as polis.prev."}),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn directory_sync_failure_after_replacement_reports_unknown() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("polis");
        fs::write(&executable, b"original executable").unwrap();
        fs::write(directory.path().join("polis.prev"), b"older backup").unwrap();
        let mut syncs = 0;
        let error = install_with_directory_sync(
            &executable,
            b"new executable",
            &digest(b"original executable"),
            |directory| {
                syncs += 1;
                if syncs == 2 {
                    Err(std::io::Error::from_raw_os_error(libc::EIO))
                } else {
                    directory.sync_all()
                }
            },
        )
        .unwrap_err();
        assert_eq!(syncs, 2);
        assert_eq!(error.exit, 7);
        let response = polis_contracts::envelope("unresolved", &Err(error));
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "update_sync_failed");
        assert_eq!(response["error"]["outcome"], "unknown");
        assert_eq!(
            response["error"]["message"],
            "The executable was replaced and polis.prev saved, but syncing the directory failed."
        );
        assert_eq!(
            response["error"]["action"],
            "Inspect polis --version before retrying; installation durability is uncertain."
        );
        assert_eq!(fs::read(&executable).unwrap(), b"new executable");
        assert_eq!(
            fs::read(directory.path().join("polis.prev")).unwrap(),
            b"original executable"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn changed_executable_during_download_is_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("polis");
        fs::write(&executable, b"another installed version").unwrap();
        fs::write(directory.path().join("polis.prev"), b"prior backup").unwrap();
        assert!(install(&executable, b"download", &digest(b"original version")).is_err());
        assert_eq!(fs::read(&executable).unwrap(), b"another installed version");
        assert_eq!(
            fs::read(directory.path().join("polis.prev")).unwrap(),
            b"prior backup"
        );
    }

    #[test]
    fn live_lock_refuses_replacement_and_released_lock_allows_it() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("polis");
        fs::write(&executable, b"original").unwrap();
        let lock = fs::File::create(directory.path().join(".polis-update.lock")).unwrap();
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert!(install(&executable, b"download", &digest(b"original")).is_err());
        assert_eq!(fs::read(&executable).unwrap(), b"original");
        assert!(!directory.path().join("polis.prev").exists());
        drop(lock);
        install(&executable, b"download", &digest(b"original")).unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"download");
        assert_eq!(
            fs::read(directory.path().join("polis.prev")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn backup_failure_preserves_executable_and_cleans_staging() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("polis");
        fs::write(&executable, b"original").unwrap();
        fs::create_dir(directory.path().join("polis.prev")).unwrap();
        assert!(install(&executable, b"download", &digest(b"original")).is_err());
        assert_eq!(fs::read(&executable).unwrap(), b"original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
    }
}
