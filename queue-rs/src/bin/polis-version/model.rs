use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MIGRATIONS: &str = "server/postgres/migrations";
pub const DEFAULT_RULE: &str = "effective-selection";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    Effective,
    Literal,
}
impl Rule {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "effective-selection" => Ok(Self::Effective),
            "literal-manifest-lines" => Ok(Self::Literal),
            _ => bail!("unknown counting rule: {s}"),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Effective => "effective-selection",
            Self::Literal => "literal-manifest-lines",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);
impl Version {
    pub fn parse(s: &str) -> Result<Self> {
        let p: Vec<_> = s.split('.').collect();
        ensure!(
            p.len() == 3
                && p.iter().all(|v| !v.is_empty()
                    && v.bytes().all(|b| b.is_ascii_digit())
                    && (v.len() == 1 || !v.starts_with('0'))),
            "expected canonical MAJOR.MINOR.PATCH: {s}"
        );
        Ok(Self(p[0].parse()?, p[1].parse()?, p[2].parse()?))
    }
    pub fn bump(self, minor: bool) -> Result<Self> {
        Ok(if minor {
            Self(
                self.0,
                self.1
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("minor overflow"))?,
                0,
            )
        } else {
            Self(
                self.0,
                self.1,
                self.2
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("patch overflow"))?,
            )
        })
    }
}
impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

pub fn valid_name(name: &str) -> bool {
    name.len() > 11
        && name.as_bytes()[..6].iter().all(u8::is_ascii_digit)
        && name.as_bytes()[6] == b'_'
        && name.ends_with(".sql")
        && name.as_bytes()[7..name.len() - 4]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}
pub fn manifest(text: &str) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    let mut numbers = BTreeSet::new();
    for line in text
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        ensure!(valid_name(line), "invalid migration filename: {line}");
        ensure!(
            numbers.insert(line[..6].to_owned()) && names.insert(line.to_owned()),
            "duplicate migration number: {line}"
        );
    }
    Ok(names)
}

#[derive(Clone, Debug)]
pub struct Selection {
    pub files: BTreeMap<String, String>, // selected filename -> Git blob identity
    pub manifest: Option<String>,
    pub evidence: String,
}
impl Selection {
    pub fn counted(&self, rule: Rule) -> BTreeSet<String> {
        if rule == Rule::Literal && self.manifest.is_none() {
            BTreeSet::new()
        } else {
            self.files.keys().cloned().collect()
        }
    }
}
pub fn added(
    old: &Selection,
    new: &Selection,
    rule: Rule,
    historical: bool,
) -> Result<Vec<String>> {
    if !historical {
        ensure!(
            new.manifest.is_some(),
            "prospective release requires release.txt"
        );
        for (name, blob) in &old.files {
            ensure!(
                new.files.get(name) == Some(blob),
                "released migration removed, renamed or edited: {name}"
            );
        }
    }
    Ok(new
        .counted(rule)
        .difference(&old.counted(rule))
        .cloned()
        .collect())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Seed {
    pub schema: String,
    pub version: String,
    pub stable_commit: String,
    pub source_commit: String,
    pub date: String,
    pub promotion_pr: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Promotion {
    pub version: String,
    pub previous_version: Option<String>,
    pub date: String,
    pub stable_commit: String,
    pub source_commit: String,
    pub migrations_shipped: Vec<String>,
    pub bump_lines: Vec<String>,
    pub migrations_removed: Vec<String>,
    pub bump: String,
    pub selection_evidence: String,
    pub manifest_blob: Option<String>,
    pub promotion_pr: Option<u64>,
    pub pr_count: usize,
    pub prs: Vec<u64>,
}
#[derive(Debug, Serialize)]
pub struct History {
    pub schema: &'static str,
    pub rule: &'static str,
    pub seed_sha256: String,
    pub promotions: Vec<Promotion>,
}

// Public PR references in merge subjects and squash subjects, not arbitrary body mentions.
pub fn pr_number(subject: &str) -> Option<u64> {
    let n = if let Some(tail) = subject.strip_prefix("Merge pull request #") {
        tail.split_whitespace().next()?
    } else {
        subject.strip_suffix(')')?.rsplit_once("(#")?.1
    };
    n.parse::<u64>().ok().filter(|n| *n > 0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn selection(manifest: bool, rows: &[(&str, &str)]) -> Selection {
        Selection {
            files: rows
                .iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect(),
            manifest: manifest.then(|| "blob".into()),
            evidence: "test".into(),
        }
    }
    const A: &str = "000001_one.sql";
    const B: &str = "000002_two.sql";
    #[test]
    fn canonical_versions() {
        for s in ["2.0.0", "0.1.12", "100.99.1"] {
            assert_eq!(Version::parse(s).unwrap().to_string(), s);
        }
    }
    #[test]
    fn invalid_versions() {
        for s in [
            "2.0",
            "v2.0.0",
            "02.0.0",
            "2.00.0",
            "2.0.0-dev",
            "2.0.0+dev",
            " 2.0.0",
            "2.0.-1",
            "2.0.0\n",
        ] {
            assert!(Version::parse(s).is_err(), "{s}");
        }
    }
    #[test]
    fn patch_and_minor_never_major() {
        let v = Version(2, 9, 4);
        assert_eq!(v.bump(false).unwrap(), Version(2, 9, 5));
        assert_eq!(v.bump(true).unwrap(), Version(2, 10, 0));
    }
    #[test]
    fn overflow_refused() {
        assert!(Version(2, u64::MAX, 0).bump(true).is_err());
        assert!(Version(2, 0, u64::MAX).bump(false).is_err());
    }
    #[test]
    fn comments_blank_reorder() {
        assert_eq!(
            manifest(&format!("# hi\n\n{B}\n{A}\n")).unwrap(),
            manifest(&format!("{A}\n{B}\n")).unwrap()
        );
    }
    #[test]
    fn invalid_manifest_names() {
        for s in [
            "../000001_a.sql",
            "00001_a.sql",
            "000001_a.sql ",
            " 000001_a.sql",
            "000001_a-b.sql",
            "000001_é.sql",
            "000001_.sql",
        ] {
            assert!(manifest(s).is_err(), "{s}");
        }
    }
    #[test]
    fn duplicate_names_and_numbers() {
        for s in [format!("{A}\n{A}"), format!("{A}\n000001_other.sql")] {
            assert!(manifest(&s).is_err());
        }
    }
    #[test]
    fn patch_when_unchanged_or_only_held_added() {
        let s = selection(true, &[(A, "a")]);
        assert!(added(&s, &s, Rule::Effective, false).unwrap().is_empty());
    }
    #[test]
    fn selected_from_held_counts() {
        let a = selection(true, &[(A, "a")]);
        let b = selection(true, &[(A, "a"), (B, "b")]);
        assert_eq!(added(&a, &b, Rule::Effective, false).unwrap(), vec![B]);
    }
    #[test]
    fn many_migrations_one_minor() {
        let a = selection(true, &[]);
        let b = selection(true, &[(A, "a"), (B, "b")]);
        assert_eq!(
            Version(2, 1, 9)
                .bump(!added(&a, &b, Rule::Effective, false).unwrap().is_empty())
                .unwrap(),
            Version(2, 2, 0)
        );
    }
    #[test]
    fn first_manifest_does_not_reship() {
        let a = selection(false, &[(A, "a")]);
        let b = selection(true, &[(A, "a")]);
        assert!(added(&a, &b, Rule::Effective, true).unwrap().is_empty());
        assert_eq!(added(&a, &b, Rule::Literal, true).unwrap(), vec![A]);
    }
    #[test]
    fn premanifest_migration_effective_only() {
        let a = selection(false, &[(A, "a")]);
        let b = selection(false, &[(A, "a"), (B, "b")]);
        assert_eq!(added(&a, &b, Rule::Effective, true).unwrap(), vec![B]);
        assert!(added(&a, &b, Rule::Literal, true).unwrap().is_empty());
    }
    #[test]
    fn historical_revert_then_reintroduction() {
        let a = selection(true, &[(A, "a")]);
        let b = selection(false, &[(A, "a"), (B, "b")]);
        assert_eq!(added(&a, &b, Rule::Effective, true).unwrap(), vec![B]);
        assert!(added(&a, &b, Rule::Literal, true).unwrap().is_empty());
        assert!(added(&b, &a, Rule::Effective, true).unwrap().is_empty());
        assert_eq!(added(&b, &a, Rule::Literal, true).unwrap(), vec![A]);
    }
    #[test]
    fn prospective_removal_refused_for_both_rules() {
        let a = selection(true, &[(A, "a")]);
        let b = selection(true, &[]);
        for r in [Rule::Effective, Rule::Literal] {
            assert!(added(&a, &b, r, false).is_err());
        }
    }
    #[test]
    fn prospective_edit_refused() {
        assert!(
            added(
                &selection(true, &[(A, "a")]),
                &selection(true, &[(A, "changed")]),
                Rule::Effective,
                false
            )
            .is_err()
        );
    }
    #[test]
    fn prospective_manifest_removal_refused() {
        let a = selection(true, &[(A, "a")]);
        assert!(added(&a, &selection(false, &[(A, "a")]), Rule::Literal, false).is_err());
    }
    #[test]
    fn added_then_removed_not_shipped() {
        let a = selection(true, &[(A, "a")]);
        assert!(added(&a, &a, Rule::Effective, false).unwrap().is_empty());
    }
    #[test]
    fn public_pr_subjects_only() {
        assert_eq!(
            pr_number("Merge pull request #123 from org/branch"),
            Some(123)
        );
        assert_eq!(pr_number("A change (#456)"), Some(456));
        assert_eq!(pr_number("references #456"), None);
    }
}

pub fn selected_blobs(
    blobs: &BTreeMap<String, String>,
    names: &BTreeSet<String>,
) -> Result<BTreeMap<String, String>> {
    use anyhow::Context;
    let mut numbers = BTreeSet::new();
    for name in blobs.keys().filter(|n| n.ends_with(".sql")) {
        ensure!(
            valid_name(name) && numbers.insert(name[..6].to_owned()),
            "invalid or duplicate migration number: {name}"
        );
    }
    names
        .iter()
        .map(|name| {
            ensure!(valid_name(name), "invalid selected migration: {name}");
            Ok((
                name.clone(),
                blobs
                    .get(name)
                    .with_context(|| format!("selected migration missing: {name}"))?
                    .clone(),
            ))
        })
        .collect()
}

pub fn legacy_names(
    dockerfile: &str,
    blobs: &BTreeMap<String, String>,
) -> Result<BTreeSet<String>> {
    let instructions: Vec<_> = dockerfile
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    ensure!(
        instructions
            == [
                "FROM postgres:17-alpine",
                "COPY ./postgres/migrations/*.sql /docker-entrypoint-initdb.d/"
            ],
        "unrecognized or ambiguous legacy initializer; explicit selection evidence required"
    );
    Ok(blobs
        .keys()
        .filter(|n| n.ends_with(".sql"))
        .cloned()
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod selection_tests {
    use super::*;
    #[test]
    fn selected_file_must_exist() {
        assert!(
            selected_blobs(&BTreeMap::new(), &BTreeSet::from(["000001_one.sql".into()])).is_err()
        );
    }
    #[test]
    fn duplicate_number_in_unselected_file_refused() {
        let b = BTreeMap::from([
            ("000001_one.sql".into(), "a".into()),
            ("000001_two.sql".into(), "b".into()),
        ]);
        assert!(selected_blobs(&b, &BTreeSet::from(["000001_one.sql".into()])).is_err());
    }
    #[test]
    fn legacy_selection_must_be_known() {
        let good = "FROM postgres:17-alpine\nCOPY ./postgres/migrations/*.sql /docker-entrypoint-initdb.d/";
        let b = BTreeMap::from([
            ("000001_one.sql".into(), "a".into()),
            ("held.txt".into(), "b".into()),
        ]);
        assert_eq!(
            legacy_names(good, &b).unwrap(),
            BTreeSet::from(["000001_one.sql".into()])
        );
        for bad in [
            "FROM postgres:17-alpine".to_owned(),
            format!("{good}\nRUN change-selection"),
            format!("{good}\nADD extra /docker-entrypoint-initdb.d/"),
        ] {
            assert!(legacy_names(&bad, &b).is_err());
        }
    }
}
