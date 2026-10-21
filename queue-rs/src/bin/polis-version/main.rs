//! Offline release-number computation. No network, database, tag or publication operations.
mod git;
mod model;
mod preparation;
use anyhow::{Context, Result, bail, ensure};
use git::Git;
use model::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::PathBuf};

const SEED: &str = include_str!("seed.json");

fn history(git: &Git, stable: &str, input: &str, rule: Rule) -> Result<History> {
    let seed: Seed = serde_json::from_str(input)?;
    ensure!(
        seed.schema == "polis.release-seed/1",
        "unsupported seed schema"
    );
    let mut version = Version::parse(&seed.version)?;
    ensure!(
        git.resolve(&seed.stable_commit)? == seed.stable_commit
            && git.resolve(&seed.source_commit)? == seed.source_commit,
        "seed requires full commit identities"
    );
    let lineage = git.lineage(stable)?;
    let at = lineage
        .iter()
        .position(|s| s == &seed.stable_commit)
        .context("seed not on stable first-parent lineage")?;
    let parents = git.parents(&seed.stable_commit)?;
    ensure!(
        parents.len() == 2 && parents[1] == seed.source_commit,
        "seed source must be promotion second parent"
    );
    ensure!(
        git.run(&["show", "-s", "--format=%cI", &seed.stable_commit])? == seed.date,
        "seed timestamp mismatch"
    );
    ensure!(
        pr_number(&git.run(&["show", "-s", "--format=%s", &seed.stable_commit])?)
            == Some(seed.promotion_pr),
        "seed promotion PR mismatch"
    );
    let mut old = git.selection(&seed.stable_commit)?;
    let seed_previous = git.selection(&parents[0])?;
    let seed_prs: BTreeSet<_> = git
        .run(&[
            "log",
            "--format=%s",
            &format!("{}..{}", parents[0], parents[1]),
        ])?
        .lines()
        .filter_map(pr_number)
        .collect();
    let mut promotions = vec![Promotion {
        version: version.to_string(),
        previous_version: None,
        date: seed.date,
        stable_commit: seed.stable_commit.clone(),
        source_commit: seed.source_commit,
        migrations_shipped: added(&seed_previous, &old, Rule::Effective, true)?,
        bump_lines: vec![],
        migrations_removed: seed_previous
            .files
            .keys()
            .filter(|n| !old.files.contains_key(*n))
            .cloned()
            .collect(),
        bump: "seed".into(),
        selection_evidence: old.evidence.clone(),
        manifest_blob: old.manifest.clone(),
        promotion_pr: Some(seed.promotion_pr),
        pr_count: seed_prs.len(),
        prs: seed_prs.into_iter().collect(),
    }];
    let mut previous = seed.stable_commit;
    for commit in lineage[..at].iter().rev() {
        let parents = git.parents(commit)?;
        ensure!(
            parents.len() == 2 && parents[0] == previous,
            "history requires two-parent promotions: {commit}"
        );
        let new = git.selection(commit)?;
        let migrations = added(&old, &new, rule, true)?;
        let before = version.to_string();
        version = version.bump(!migrations.is_empty())?;
        let prs: BTreeSet<_> = git
            .run(&["log", "--format=%s", &format!("{previous}..{}", parents[1])])?
            .lines()
            .filter_map(pr_number)
            .collect();
        promotions.push(Promotion {
            version: version.to_string(),
            previous_version: Some(before),
            date: git.run(&["show", "-s", "--format=%cI", commit])?,
            stable_commit: commit.clone(),
            source_commit: parents[1].clone(),
            bump: if migrations.is_empty() {
                "patch"
            } else {
                "minor"
            }
            .into(),
            migrations_shipped: added(&old, &new, Rule::Effective, true)?,
            bump_lines: migrations,
            migrations_removed: old
                .files
                .keys()
                .filter(|n| !new.files.contains_key(*n))
                .cloned()
                .collect(),
            selection_evidence: new.evidence.clone(),
            manifest_blob: new.manifest.clone(),
            promotion_pr: pr_number(&git.run(&["show", "-s", "--format=%s", commit])?),
            pr_count: prs.len(),
            prs: prs.into_iter().collect(),
        });
        old = new;
        previous = commit.clone();
    }
    Ok(History {
        schema: "polis.release-history/1",
        rule: rule.name(),
        seed_sha256: format!("{:x}", Sha256::digest(input)),
        promotions,
    })
}

fn validate_tags(
    tags: &[(Version, String)],
    lineage: &[String],
    stable: &str,
) -> Result<Option<Version>> {
    let mut previous_index = usize::MAX;
    let mut commits = BTreeSet::new();
    for (version, commit) in tags {
        let index = lineage
            .iter()
            .position(|s| s == commit)
            .with_context(|| format!("tag v{version} is outside stable first-parent lineage"))?;
        ensure!(
            index < previous_index && commits.insert(commit),
            "conflicting or non-increasing release tags"
        );
        previous_index = index;
    }
    if let Some((version, commit)) = tags.last() {
        ensure!(
            commit == stable,
            "stable head is not tagged; complete the pending release first"
        );
        Ok(Some(*version))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Serialize)]
struct Plan {
    schema: &'static str,
    rule: &'static str,
    kind: String,
    version: String,
    previous_version: String,
    bump: String,
    reason: String,
    release_lines: Vec<String>,
    previous_stable_commit: String,
    candidate_commit: String,
    previous_tree: String,
    candidate_tree: String,
    previous_manifest_blob: Option<String>,
    candidate_manifest_blob: Option<String>,
    previous_tag: Option<String>,
    new_number: bool,
}
fn plan(
    git: &Git,
    stable: &str,
    candidate: &str,
    kind: &str,
    seed: &str,
    rule: Rule,
) -> Result<Plan> {
    let lineage = git.lineage(stable)?;
    let tags = git.tags()?;
    let tagged = validate_tags(&tags, &lineage, stable)?;
    let tail =
        if tagged.is_none() || (kind == "redeploy" && !tags.iter().any(|(_, c)| c == candidate)) {
            Some(history(git, stable, seed, rule)?)
        } else {
            None
        };
    let previous = match tagged {
        Some(v) => v,
        None => Version::parse(
            &tail
                .as_ref()
                .and_then(|h| h.promotions.last())
                .context("missing history")?
                .version,
        )?,
    };
    let old = git.selection(stable)?;
    let new = git.selection(candidate)?;
    let (version, bump, lines, reason, new_number) = if kind == "redeploy" {
        ensure!(
            lineage.contains(&candidate.to_owned()),
            "redeploy target is not a stable first-parent release"
        );
        let version = if let Some((v, _)) = tags.iter().find(|(_, c)| c == candidate) {
            v.to_string()
        } else {
            tail.as_ref()
                .and_then(|h| h.promotions.iter().find(|p| p.stable_commit == candidate))
                .context("redeploy target has no known number")?
                .version
                .clone()
        };
        (
            version,
            "none",
            vec![],
            "redeploy retains the original stable release number",
            false,
        )
    } else {
        if kind == "hotfix" {
            ensure!(
                git.ancestor(stable, candidate)?,
                "hotfix must incorporate current stable"
            );
        } else {
            let parents = git.parents(stable)?;
            ensure!(parents.len() == 2, "stable must be a two-parent promotion");
            ensure!(
                git.tree(&parents[1])? == git.tree(stable)?,
                "stable-only changes must be reconciled before promotion"
            );
            ensure!(
                git.ancestor(&parents[1], candidate)?,
                "candidate must retain previous promoted source ancestry"
            );
        }
        preparation::require_change(git, stable, candidate)?;
        let lines = added(&old, &new, rule, false)?;
        let minor = !lines.is_empty();
        (
            previous.bump(minor)?.to_string(),
            if minor { "minor" } else { "patch" },
            lines,
            if minor {
                "new selected migrations"
            } else {
                "no new selected migrations"
            },
            true,
        )
    };
    Ok(Plan {
        schema: "polis.release-plan/1",
        rule: rule.name(),
        kind: kind.into(),
        version,
        previous_version: previous.to_string(),
        bump: bump.into(),
        reason: reason.into(),
        release_lines: lines,
        previous_stable_commit: stable.into(),
        candidate_commit: candidate.into(),
        previous_tree: git.tree(stable)?,
        candidate_tree: git.tree(candidate)?,
        previous_manifest_blob: old.manifest,
        candidate_manifest_blob: new.manifest,
        previous_tag: tagged.map(|v| format!("v{v}")),
        new_number,
    })
}

struct Args {
    mode: String,
    repo: PathBuf,
    stable: String,
    candidate: Option<String>,
    kind: String,
    rule: Rule,
    seed: Option<PathBuf>,
    json: bool,
    write: bool,
}
fn args(values: impl IntoIterator<Item = String>) -> Result<Args> {
    let mut it = values.into_iter();
    let mode = it.next().context("expected history or plan (see --help)")?;
    ensure!(
        mode == "history" || mode == "plan",
        "expected history or plan"
    );
    let mut a = Args {
        mode,
        repo: PathBuf::from("."),
        stable: "origin/stable".into(),
        candidate: None,
        kind: "promotion".into(),
        rule: Rule::parse(DEFAULT_RULE)?,
        seed: None,
        json: false,
        write: false,
    };
    let mut seen = BTreeSet::new();
    while let Some(k) = it.next() {
        ensure!(seen.insert(k.clone()), "duplicate option: {k}");
        if k == "--json" {
            a.json = true;
            continue;
        }
        if k == "--write" {
            a.write = true;
            continue;
        }
        let v = it
            .next()
            .with_context(|| format!("missing value for {k}"))?;
        match k.as_str() {
            "--repo" => a.repo = v.into(),
            "--stable" => a.stable = v,
            "--candidate" => a.candidate = Some(v),
            "--kind" => a.kind = v,
            "--rule" => a.rule = Rule::parse(&v)?,
            "--history" => a.seed = Some(v.into()),
            _ => bail!("unknown option: {k}"),
        }
    }
    ensure!(
        ["promotion", "hotfix", "redeploy"].contains(&a.kind.as_str()),
        "unknown plan kind"
    );
    ensure!(
        a.mode == "plan" || (!a.write && a.candidate.is_none() && !seen.contains("--kind")),
        "history does not accept plan options"
    );
    ensure!(
        a.mode != "plan" || a.candidate.is_some(),
        "plan requires --candidate"
    );
    ensure!(
        !(a.write && a.kind == "redeploy"),
        "redeploy cannot write VERSION"
    );
    Ok(a)
}
fn write_version(git: &Git, candidate: &str, version: &str) -> Result<()> {
    ensure!(
        git.resolve("HEAD")? == candidate,
        "--write requires HEAD at candidate"
    );
    let root = PathBuf::from(git.run(&["rev-parse", "--show-toplevel"])?);
    ensure!(
        git.run(&["status", "--porcelain", "--untracked-files=normal"])?
            .lines()
            .all(|l| l.get(3..) == Some("VERSION")),
        "--write requires a clean candidate except VERSION"
    );
    save_version(&root, version)
}
fn save_version(root: &std::path::Path, version: &str) -> Result<()> {
    use std::io::Write;
    Version::parse(version)?;
    let target = root.join("VERSION");
    ensure!(
        fs::symlink_metadata(&target)?.file_type().is_file(),
        "VERSION must be a regular file"
    );
    // One writable output. No ref, index, tag, Cargo mirror or release side effect.
    let temporary = root.join(format!(".VERSION.polis-version-{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| -> Result<()> {
        file.set_permissions(fs::metadata(&target)?.permissions())?;
        writeln!(file, "{version}")?;
        file.sync_all()?;
        fs::rename(&temporary, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn run() -> Result<()> {
    let values: Vec<_> = std::env::args().skip(1).collect();
    if values == ["--help"] {
        println!(
            "polis-version history|plan [--repo PATH] [--stable REF] [--history SEED.json]\n  [--rule effective-selection|literal-manifest-lines] [--json]\nplan requires --candidate REF; optional --kind promotion|hotfix|redeploy, --write\nRead-only by default. --write updates root VERSION only. Complete local Git history/tags required.\nDefault rule: {DEFAULT_RULE}."
        );
        return Ok(());
    }
    let a = args(values)?;
    let git = Git::new(&a.repo)?;
    let seed = match a.seed {
        Some(ref p) => fs::read_to_string(p)?,
        None => SEED.into(),
    };
    let stable = git.resolve(&a.stable)?;
    if a.mode == "history" {
        let h = history(&git, &stable, &seed, a.rule)?;
        ensure!(
            git.resolve(&a.stable)? == stable,
            "stable moved during computation"
        );
        if a.json {
            println!("{}", serde_json::to_string_pretty(&h)?);
        } else {
            for p in h.promotions {
                println!(
                    "{} previous={} {} {} {} PRs={} migrations={}",
                    p.version,
                    p.previous_version.as_deref().unwrap_or("none"),
                    p.bump,
                    p.date,
                    p.stable_commit,
                    p.pr_count,
                    p.migrations_shipped.join(",")
                );
            }
        }
    } else {
        let candidate_ref = a.candidate.as_deref().context("missing candidate")?;
        let candidate = git.resolve(candidate_ref)?;
        let tags_before = git.tags()?;
        let p = plan(&git, &stable, &candidate, &a.kind, &seed, a.rule)?;
        ensure!(
            git.resolve(&a.stable)? == stable
                && git.resolve(candidate_ref)? == candidate
                && git.tags()? == tags_before,
            "release inputs moved during computation"
        );
        if a.write {
            write_version(&git, &candidate, &p.version)?;
        }
        if a.json {
            println!("{}", serde_json::to_string_pretty(&p)?)
        } else {
            println!(
                "{} (previous {}; {}: {})",
                p.version, p.previous_version, p.bump, p.reason
            );
            for line in p.release_lines {
                println!("{MIGRATIONS}/release.txt: {line}")
            }
        }
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("polis-version: {e:#}");
        std::process::exit(1)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn parse(s: &str) -> Result<Args> {
        args(s.split_whitespace().map(str::to_owned))
    }
    #[test]
    fn configured_default_is_dry() {
        let a = parse("plan --candidate HEAD").unwrap();
        assert!(!a.write);
        assert_eq!(a.rule, Rule::parse(DEFAULT_RULE).unwrap());
    }
    #[test]
    fn literal_flag() {
        assert_eq!(
            parse("history --rule literal-manifest-lines").unwrap().rule,
            Rule::Literal
        );
    }
    #[test]
    fn effective_flag() {
        assert_eq!(
            parse("history --rule effective-selection").unwrap().rule,
            Rule::Effective
        );
    }
    #[test]
    fn unknown_and_duplicate_options_refused() {
        for s in [
            "plan",
            "history --write",
            "history --candidate HEAD",
            "plan --candidate HEAD --kind bad",
            "plan --candidate HEAD --version 3.0.0",
            "history --json --json",
            "history --rule unknown",
            "plan --candidate HEAD --kind redeploy --write",
        ] {
            assert!(parse(s).is_err(), "{s}");
        }
    }
    #[test]
    fn tags_must_end_at_stable() {
        let l = vec!["new".into(), "old".into()];
        assert!(validate_tags(&[(Version(2, 0, 0), "old".into())], &l, "new").is_err());
    }
    #[test]
    fn tags_off_lineage_refused() {
        assert!(
            validate_tags(
                &[(Version(2, 0, 0), "branch".into())],
                &["stable".into()],
                "stable"
            )
            .is_err()
        );
    }
    #[test]
    fn tag_order_and_collision_refused() {
        let l = vec!["new".into(), "old".into()];
        for t in [
            vec![
                (Version(2, 0, 0), "new".into()),
                (Version(2, 1, 0), "old".into()),
            ],
            vec![
                (Version(2, 0, 0), "new".into()),
                (Version(2, 1, 0), "new".into()),
            ],
        ] {
            assert!(validate_tags(&t, &l, "new").is_err());
        }
    }
    #[test]
    fn valid_tag_baseline() {
        assert_eq!(
            validate_tags(
                &[(Version(2, 1, 0), "new".into())],
                &["new".into(), "old".into()],
                "new"
            )
            .unwrap(),
            Some(Version(2, 1, 0))
        );
    }
    #[test]
    fn no_tags_uses_seed() {
        assert_eq!(validate_tags(&[], &["new".into()], "new").unwrap(), None);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod output_tests {
    use super::*;
    fn directory() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "polis-version-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn write_only_version_and_repeat() {
        let p = directory();
        fs::write(p.join("VERSION"), "1.0\n").unwrap();
        fs::write(p.join("sentinel"), "keep").unwrap();
        save_version(&p, "2.42.0").unwrap();
        save_version(&p, "2.42.0").unwrap();
        assert_eq!(fs::read_to_string(p.join("VERSION")).unwrap(), "2.42.0\n");
        assert_eq!(fs::read_to_string(p.join("sentinel")).unwrap(), "keep");
        assert_eq!(fs::read_dir(&p).unwrap().count(), 2);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn invalid_write_preserves_original() {
        let p = directory();
        fs::write(p.join("VERSION"), "1.0\n").unwrap();
        assert!(save_version(&p, "3").is_err());
        assert_eq!(fs::read_to_string(p.join("VERSION")).unwrap(), "1.0\n");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn write_refuses_existing_temporary_file() {
        let p = directory();
        fs::write(p.join("VERSION"), "1.0\n").unwrap();
        let temp = p.join(format!(".VERSION.polis-version-{}.tmp", std::process::id()));
        fs::write(&temp, "other").unwrap();
        assert!(save_version(&p, "2.0.0").is_err());
        assert_eq!(fs::read_to_string(&temp).unwrap(), "other");
        fs::remove_dir_all(p).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn write_refuses_symlink() {
        let p = directory();
        fs::write(p.join("other"), "keep").unwrap();
        std::os::unix::fs::symlink("other", p.join("VERSION")).unwrap();
        assert!(save_version(&p, "2.0.0").is_err());
        assert_eq!(fs::read_to_string(p.join("other")).unwrap(), "keep");
        fs::remove_dir_all(p).unwrap();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod repository_tests {
    use super::*;
    // Explicit opt-in: ordinary CI has a shallow source checkout. This command
    // fails without a supplied complete history; it never silently skips a case.
    #[test]
    #[ignore = "run explicitly with POLIS_VERSION_TEST_REPO pointing to complete Polis history"]
    fn real_history_and_plans() {
        let path = std::env::var("POLIS_VERSION_TEST_REPO").unwrap();
        let git = Git::new(std::path::Path::new(&path)).unwrap();
        let stable = git
            .resolve("d2da302d0f94fb29fa0e7fde27299509c6f5f28b")
            .unwrap();
        let edge = git
            .resolve("4f50b6f28f30160a9d8a0ca3f3024ef3c03b6ec2")
            .unwrap();
        for (rule, expected, next) in [
            (Rule::Effective, "2.41.0", "2.42.0"),
            (Rule::Literal, "2.40.0", "2.41.0"),
        ] {
            let h = history(&git, &stable, SEED, rule).unwrap();
            assert_eq!(h.promotions.len(), 35);
            assert_eq!(h.promotions.last().unwrap().version, expected);
            assert_eq!(
                h.promotions.iter().filter(|p| p.bump == "minor").count(),
                if rule == Rule::Effective { 7 } else { 6 }
            );
            let json = serde_json::to_vec(&h).unwrap();
            assert_eq!(
                json,
                serde_json::to_vec(&history(&git, &stable, SEED, rule).unwrap()).unwrap()
            );
            for p in h.promotions.iter().skip(1) {
                assert_eq!(p.pr_count, p.prs.len());
                assert_eq!(git.parents(&p.stable_commit).unwrap()[1], p.source_commit);
            }
            let p = plan(&git, &stable, &edge, "promotion", SEED, rule).unwrap();
            assert_eq!(p.version, next);
            assert_eq!(p.previous_version, expected);
            assert_eq!(
                p.release_lines,
                vec!["000043_add_conversation_activity_indexes.sql"]
            );
            let rollback = &h.promotions[1];
            let p = plan(
                &git,
                &stable,
                &rollback.stable_commit,
                "redeploy",
                SEED,
                rule,
            )
            .unwrap();
            assert_eq!(p.version, rollback.version);
            assert!(!p.new_number);
            assert_eq!(p.previous_version, expected);
            let forward = plan(&git, &stable, &edge, "promotion", SEED, rule).unwrap();
            assert_eq!(forward.version, next);
            assert!(plan(&git, &stable, &stable, "promotion", SEED, rule).is_err());
            assert!(plan(&git, &stable, &edge, "hotfix", SEED, rule).is_err());
            assert!(plan(&git, &stable, &edge, "redeploy", SEED, rule).is_err());
            let older = &h.promotions[10].stable_commit;
            let newer = &h.promotions[11].stable_commit;
            let hotfix = plan(&git, older, newer, "hotfix", SEED, rule).unwrap();
            assert_eq!(hotfix.bump, "patch");
            assert_eq!(hotfix.version, h.promotions[11].version);
            assert!(plan(&git, newer, older, "hotfix", SEED, rule).is_err());
            let before = &h.promotions[9].stable_commit;
            let after = &h.promotions[10].stable_commit;
            assert_eq!(
                plan(&git, before, after, "hotfix", SEED, rule)
                    .unwrap()
                    .bump,
                "minor"
            );
            assert_eq!(
                h.promotions[6].bump,
                if rule == Rule::Effective {
                    "patch"
                } else {
                    "minor"
                }
            );
            assert_eq!(
                h.promotions[7].bump,
                if rule == Rule::Effective {
                    "minor"
                } else {
                    "patch"
                }
            );
        }
        let mut bad: serde_json::Value = serde_json::from_str(SEED).unwrap();
        bad["source_commit"] = serde_json::json!(edge);
        assert!(history(&git, &stable, &bad.to_string(), Rule::Effective).is_err());
        assert!(history(&git, &edge, SEED, Rule::Effective).is_err());
        assert!(write_version(&git, &edge, "2.42.0").is_err());
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod contract_tests;
