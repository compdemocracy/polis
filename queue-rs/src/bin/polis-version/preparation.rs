//! Ignore only the version fields emitted by release preparation. Unknown layouts
//! remain substantive changes; this is deliberately not a general TOML rewriter.
use crate::{git::Git, model::Version};
use anyhow::{Context, Result, ensure};

pub fn require_change(git: &Git, stable: &str, candidate: &str) -> Result<()> {
    // No rename detection or pathname quoting: every added/deleted file and mode
    // change is substantive, even if its path is a supported mirror.
    let raw = git.bytes(&[
        "diff",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-z",
        stable,
        candidate,
        "--",
    ])?;
    require_product_change(&raw, |id| git.bytes(&["cat-file", "blob", id]))
}

fn require_product_change(raw: &[u8], mut blob: impl FnMut(&str) -> Result<Vec<u8>>) -> Result<()> {
    let raw = std::str::from_utf8(raw)?;
    let mut entries = raw.split_terminator('\0');
    let mut substantive = false;
    while let Some(header) = entries.next() {
        let path = entries.next().context("missing changed path")?;
        let fields: Vec<_> = header.trim_start_matches(':').split_whitespace().collect();
        ensure!(fields.len() == 5, "invalid raw change record");
        if fields[0] != "100644" || fields[1] != "100644" || fields[4] != "M" {
            substantive = true;
        } else if path != "VERSION" {
            if matches!(path, "polis-cli/Cargo.toml" | "polis-cli/Cargo.lock") {
                let old = blob(fields[2])?;
                let new = blob(fields[3])?;
                substantive |= !mirror_only(path, &old, &new);
            } else {
                substantive = true;
            }
        }
    }
    ensure!(
        substantive,
        "empty promotion or version-only preparation does not allocate a release"
    );
    Ok(())
}

fn mirror_only(path: &str, old: &[u8], new: &[u8]) -> bool {
    match (normalized(path, old), normalized(path, new)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn normalized(path: &str, bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    // A section-looking line inside a multiline TOML string is not a section.
    // Generated mirrors use no such strings; refuse to normalize unfamiliar input.
    if text.contains("\"\"\"") || text.contains("'''") {
        return None;
    }
    match path {
        "polis-cli/Cargo.toml" => {
            let mut workspace = false;
            let mut count = 0;
            let mut out = String::new();
            for line in text.split_inclusive('\n') {
                if line.trim_start().starts_with('[') {
                    workspace = line.trim() == "[workspace.package]";
                }
                if workspace && version_line(line) {
                    count += 1;
                    out.push_str("version = \"<release>\"");
                    if line.ends_with('\n') {
                        out.push('\n');
                    }
                } else {
                    out.push_str(line);
                }
            }
            (count == 1).then_some(out)
        }
        "polis-cli/Cargo.lock" => {
            let mut out = String::new();
            let mut seen = std::collections::BTreeSet::new();
            let mut blocks = text.split("[[package]]\n");
            out.push_str(blocks.next()?);
            for block in blocks {
                out.push_str("[[package]]\n");
                // These two crates inherit the CLI workspace version. The shared
                // contracts crate and registry/git packages have independent versions.
                let name = block.lines().next()?;
                let local = matches!(name, "name = \"polis\"" | "name = \"polis-client\"")
                    && !block.lines().any(|l| {
                        l.trim_start().starts_with("source")
                            || l.trim_start().starts_with("checksum")
                    });
                let mut count = 0;
                for line in block.split_inclusive('\n') {
                    if local && version_line(line) {
                        count += 1;
                        out.push_str("version = \"<release>\"");
                        if line.ends_with('\n') {
                            out.push('\n');
                        }
                    } else {
                        out.push_str(line);
                    }
                }
                if local && (count != 1 || !seen.insert(name)) {
                    return None;
                }
            }
            (!seen.is_empty()).then_some(out)
        }
        _ => None,
    }
}

fn version_line(line: &str) -> bool {
    line.strip_suffix('\n')
        .unwrap_or(line)
        .strip_prefix("version = \"")
        .and_then(|s| s.strip_suffix('"'))
        .is_some_and(|s| Version::parse(s).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    const MANIFEST: &str = "[workspace]\nmembers = [\"crates/polis\"]\n[workspace.package]\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace.dependencies]\nserde = { version = \"1\" }\n[profile.release]\nlto = \"thin\"\n";
    const LOCK: &str = "version = 4\n\n[[package]]\nname = \"polis\"\nversion = \"0.1.0\"\ndependencies = [\"polis-client\"]\n\n[[package]]\nname = \"polis-client\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"polis-contracts\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
    fn record(path: &str, old: &str, new: &str) -> String {
        format!(":100644 100644 {old} {new} M\0{path}\0")
    }
    fn check(records: &str, extra_code: bool) -> Result<()> {
        let mut records = records.to_owned();
        if extra_code {
            records.push_str(&record("README.md", "old", "new"));
        }
        require_product_change(records.as_bytes(), |id| {
            Ok(match id {
                "manifest-old" => MANIFEST.to_owned(),
                "manifest-new" => MANIFEST.replace("0.1.0", "2.42.0"),
                "lock-old" => LOCK.to_owned(),
                "lock-new" => LOCK.replacen("0.1.0", "2.42.0", 2),
                "dependency-new" => MANIFEST.replace("version = \"1\"", "version = \"2\""),
                _ => anyhow::bail!("unexpected blob {id}"),
            }
            .into_bytes())
        })
    }
    #[test]
    fn new_release_guard_rejects_empty_and_combined_preparation() {
        // Ordinary and hotfix plans call this same guard after ancestry checks.
        let version = record("VERSION", "old", "new");
        let manifest = record("polis-cli/Cargo.toml", "manifest-old", "manifest-new");
        let lock = record("polis-cli/Cargo.lock", "lock-old", "lock-new");
        for changes in [
            String::new(),
            version.clone(),
            manifest.clone(),
            lock.clone(),
            format!("{version}{manifest}{lock}"),
        ] {
            assert!(check(&changes, false).is_err());
            assert!(check(&changes, true).is_ok());
        }
        assert!(
            check(
                &record("polis-cli/Cargo.toml", "manifest-old", "dependency-new"),
                false
            )
            .is_ok()
        );
    }
    #[test]
    fn mode_changes_additions_deletions_and_unusual_paths_count() {
        for header in [
            ":100644 100755 old new M",
            ":000000 100644 zero new A",
            ":100644 000000 old zero D",
            ":100644 120000 old new T",
        ] {
            for path in ["VERSION", "polis-cli/Cargo.toml", "polis-cli/Cargo.lock"] {
                assert!(check(&format!("{header}\0{path}\0"), false).is_ok());
            }
        }
        assert!(check(&record("VERSION\nREADME.md", "old", "new"), false).is_ok());
    }
    #[test]
    fn preparation_workspace_version_is_ignored() {
        assert!(mirror_only(
            "polis-cli/Cargo.toml",
            MANIFEST.as_bytes(),
            MANIFEST.replace("0.1.0", "2.42.0").as_bytes()
        ));
    }
    #[test]
    fn preparation_local_package_versions_are_ignored() {
        let next = LOCK.replacen("0.1.0", "2.42.0", 2);
        assert!(mirror_only(
            "polis-cli/Cargo.lock",
            LOCK.as_bytes(),
            next.as_bytes()
        ));
    }
    #[test]
    fn dependency_and_build_changes_remain_substantive() {
        for (a, b) in [
            ("version = \"1\"", "version = \"2\""),
            ("thin", "fat"),
            ("2021", "2024"),
            ("crates/polis", "crates/other"),
        ] {
            let next = MANIFEST.replace("0.1.0", "2.42.0").replace(a, b);
            assert!(
                !mirror_only("polis-cli/Cargo.toml", MANIFEST.as_bytes(), next.as_bytes()),
                "{a}"
            );
        }
    }
    #[test]
    fn dependency_contract_and_lock_format_versions_remain_substantive() {
        for next in [
            LOCK.replace("1.0.0", "1.1.0"),
            LOCK.replace(
                "name = \"polis-contracts\"\nversion = \"0.1.0\"",
                "name = \"polis-contracts\"\nversion = \"0.2.0\"",
            ),
            LOCK.replace("version = 4", "version = 3"),
            LOCK.replace("[\"polis-client\"]", "[\"serde\"]"),
        ] {
            assert!(!mirror_only(
                "polis-cli/Cargo.lock",
                LOCK.as_bytes(),
                next.as_bytes()
            ));
        }
    }
    #[test]
    fn registry_package_with_local_name_is_not_a_mirror() {
        let old = LOCK.replace(
            "name = \"polis\"\n",
            "name = \"polis\"\nsource = \"registry+example\"\n",
        );
        assert!(!mirror_only(
            "polis-cli/Cargo.lock",
            old.as_bytes(),
            old.replacen("0.1.0", "2.42.0", 1).as_bytes()
        ));
    }
    #[test]
    fn unfamiliar_layouts_and_unrelated_files_are_not_ignored() {
        for path in [
            "polis-cli/Cargo.toml",
            "polis-cli/Cargo.lock",
            "queue-rs/Cargo.toml",
        ] {
            for old in [
                "",
                "version = \"0.1.0\"",
                "x = '''\n[workspace.package]\nversion = \"0.1.0\"\n'''\n",
                "x = \"\"\"\n[workspace.package]\nversion = \"0.1.0\"\n\"\"\"\n",
            ] {
                assert!(!mirror_only(
                    path,
                    old.as_bytes(),
                    old.replace("0.1.0", "2.42.0").as_bytes()
                ));
            }
        }
    }
    #[test]
    fn other_bytes_in_supported_mirrors_are_preserved() {
        for (path, old) in [
            ("polis-cli/Cargo.toml", MANIFEST),
            ("polis-cli/Cargo.lock", LOCK),
        ] {
            for next in [
                format!("{old}\n"),
                format!("{old}# comment\n"),
                old.trim_end().to_owned(),
                old.replace("0.1.0", "invalid"),
            ] {
                assert!(!mirror_only(path, old.as_bytes(), next.as_bytes()));
            }
        }
    }
}
