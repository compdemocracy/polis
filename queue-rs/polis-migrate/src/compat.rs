//! Forward compatibility: which applied migrations a release may run beside
//! without listing them.
//!
//! The ledger `compat.txt` declares, per migration, whether a release that does
//! NOT list it still runs correctly once it is applied (`additive`) or not
//! (`breaking`). The deploying runner records each declaration in the history
//! row (`public.migrations.compat`), because an older release cannot read a
//! newer release's files: the database is the only thing both share. A history
//! row this release does not list is tolerated only when its recorded
//! declaration is `additive`; a missing declaration counts as `breaking`.
use anyhow::{Result, bail, ensure};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compat {
    Additive,
    Breaking,
}

impl Compat {
    pub fn parse(text: &str) -> Option<Compat> {
        match text {
            "additive" => Some(Compat::Additive),
            "breaking" => Some(Compat::Breaking),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Compat::Additive => "additive",
            Compat::Breaking => "breaking",
        }
    }
}

/// Valid migration file name, as release.txt and held.txt require.
pub fn valid_name(name: &str) -> bool {
    name.len() > 11
        && name.as_bytes()[..6].iter().all(u8::is_ascii_digit)
        && name.as_bytes()[6] == b'_'
        && name.ends_with(".sql")
        && name.as_bytes()[7..name.len() - 4]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// Parse `compat.txt`: `<migration file> <additive|breaking>` per line, single
/// space, `#` comments. Every name must be in the release or held manifest.
/// The file is optional; an undeclared migration is recorded with no
/// declaration, which every reader treats as `breaking`.
pub fn ledger(text: &str, known: &BTreeSet<String>) -> Result<BTreeMap<String, Compat>> {
    let mut out = BTreeMap::new();
    for line in text
        .lines()
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
    {
        let fields: Vec<&str> = line.split(' ').collect();
        ensure!(
            fields.len() == 2 && valid_name(fields[0]),
            "invalid line in compat.txt: {line}"
        );
        let compat = Compat::parse(fields[1]).ok_or_else(|| {
            anyhow::anyhow!("invalid declaration in compat.txt (additive|breaking): {line}")
        })?;
        ensure!(
            known.contains(fields[0]),
            "compat.txt declares a migration absent from release/held manifest: {}",
            fields[0]
        );
        ensure!(
            out.insert(fields[0].to_owned(), compat).is_none(),
            "duplicate migration in compat.txt: {}",
            fields[0]
        );
    }
    Ok(out)
}

pub struct Row {
    pub name: String,
    pub checksum: String,
    pub status: String,
    pub compat: Option<String>,
}

/// What this release knows: its selected migrations and its held ones.
pub struct Known<'a> {
    pub selected: Vec<(&'a str, &'a str)>,
    pub held: Vec<(&'a str, &'a str)>,
}

#[derive(Debug, Default)]
pub struct History {
    /// Selected migrations recorded as applied: name -> checksum.
    pub applied: BTreeMap<String, String>,
    /// The recorded declaration of each applied selected migration.
    pub recorded: BTreeMap<String, Option<Compat>>,
    /// Applied migrations this release does not select, declared additive.
    pub tolerated: Vec<String>,
}

/// Classify history rows against a release. Pure: no database access.
pub fn classify(rows: &[Row], known: &Known) -> Result<History> {
    let mut history = History::default();
    let mut seen = BTreeSet::new();
    for row in rows {
        let name = row.name.as_str();
        ensure!(
            matches!(row.status.as_str(), "APPLIED" | "ADOPTED"),
            "unverified history: {name}"
        );
        ensure!(seen.insert(name.to_owned()), "duplicate history: {name}");
        let recorded = match row.compat.as_deref() {
            None => None,
            Some(text) => Some(Compat::parse(text).ok_or_else(|| {
                anyhow::anyhow!("invalid forward-compatibility declaration in history: {name}")
            })?),
        };
        if let Some((_, checksum)) = known.selected.iter().find(|(n, _)| *n == name) {
            ensure!(
                row.checksum == *checksum,
                "migration checksum mismatch: {name}; restore the released source; do not replay it"
            );
            history
                .applied
                .insert(name.to_owned(), row.checksum.clone());
            history.recorded.insert(name.to_owned(), recorded);
            continue;
        }
        if let Some((_, checksum)) = known.held.iter().find(|(n, _)| *n == name) {
            ensure!(
                row.checksum == *checksum,
                "migration checksum mismatch: {name}; restore the released source; do not replay it"
            );
        } else if let Some((other, _)) = known
            .selected
            .iter()
            .chain(&known.held)
            .find(|(n, _)| name.len() >= 6 && n[..6] == name[..6])
        {
            bail!(
                "history names migration absent from this release: {name}; this release numbers {} as {other}",
                &name[..6]
            );
        }
        match recorded {
            Some(Compat::Additive) => history.tolerated.push(name.to_owned()),
            Some(Compat::Breaking) => bail!(
                "history names migration absent from this release: {name} (declared breaking by the release that applied it); this release cannot run against this database"
            ),
            None => bail!(
                "history names migration absent from this release: {name} (no forward-compatibility declaration recorded, so it counts as breaking); this release cannot run against this database"
            ),
        }
    }
    Ok(history)
}

/// The declaration updates a deploying release makes for its own applied
/// migrations: fill a missing declaration, and only ever tighten additive to
/// breaking. A loosening is never written; it is reported instead.
pub fn sync(
    history: &History,
    declared: &BTreeMap<String, Compat>,
) -> (Vec<(String, Compat)>, Vec<String>) {
    let mut writes = Vec::new();
    let mut kept = Vec::new();
    for (name, recorded) in &history.recorded {
        match (recorded, declared.get(name)) {
            (None, Some(want)) => writes.push((name.clone(), *want)),
            (Some(Compat::Additive), Some(Compat::Breaking)) => {
                writes.push((name.clone(), Compat::Breaking))
            }
            (Some(Compat::Breaking), Some(Compat::Additive)) => kept.push(name.clone()),
            _ => {}
        }
    }
    (writes, kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, checksum: &str, compat: Option<&str>) -> Row {
        Row {
            name: name.into(),
            checksum: checksum.into(),
            status: "APPLIED".into(),
            compat: compat.map(Into::into),
        }
    }
    fn known() -> Known<'static> {
        Known {
            selected: vec![("000000_initial.sql", "a"), ("000028_results.sql", "b")],
            held: vec![("000021_coordinator.sql", "h")],
        }
    }
    fn err(rows: &[Row]) -> String {
        match classify(rows, &known()) {
            Ok(_) => String::from("accepted"),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn ledger_parses_and_refuses_bad_lines() -> Result<()> {
        let known: BTreeSet<String> = ["000000_initial.sql".to_owned(), "000001_x.sql".to_owned()]
            .into_iter()
            .collect();
        let parsed = ledger(
            "# c\n000000_initial.sql breaking\n000001_x.sql additive\n",
            &known,
        )?;
        assert_eq!(parsed.get("000001_x.sql"), Some(&Compat::Additive));
        for bad in [
            "000001_x.sql additive extra",
            "000001_x.sql  additive",
            "000001_x.sql Additive",
            "000001_x.sql",
            "000002_y.sql additive",
            "000001_x.sql additive\n000001_x.sql additive",
            "000001_x.sql additive\r",
            "../x.sql additive",
        ] {
            assert!(ledger(bad, &known).is_err(), "accepted {bad:?}");
        }
        Ok(())
    }

    #[test]
    fn known_rows_are_checked_as_before() -> Result<()> {
        let h = classify(
            &[
                row("000000_initial.sql", "a", None),
                row("000028_results.sql", "b", Some("additive")),
            ],
            &known(),
        )?;
        assert_eq!(h.applied.len(), 2);
        assert!(h.tolerated.is_empty());
        assert!(err(&[row("000028_results.sql", "x", None)]).contains("checksum mismatch"));
        Ok(())
    }

    #[test]
    fn newer_additive_is_tolerated_and_others_refuse() -> Result<()> {
        let h = classify(&[row("000031_newer.sql", "z", Some("additive"))], &known())?;
        assert_eq!(h.tolerated, vec!["000031_newer.sql"]);
        let breaking = err(&[row("000031_newer.sql", "z", Some("breaking"))]);
        assert!(breaking.contains("history names migration absent from this release"));
        assert!(breaking.contains("declared breaking"));
        assert!(err(&[row("000031_newer.sql", "z", None)]).contains("no forward-compatibility"));
        assert!(err(&[row("000031_newer.sql", "z", Some("maybe"))]).contains("invalid"));
        Ok(())
    }

    #[test]
    fn same_number_other_name_refuses_even_if_additive() {
        let e = err(&[row("000028_renamed.sql", "z", Some("additive"))]);
        assert!(e.contains("numbers 000028 as 000028_results.sql"), "{e}");
    }

    #[test]
    fn held_rows_must_match_source_and_be_additive() -> Result<()> {
        let h = classify(
            &[row("000021_coordinator.sql", "h", Some("additive"))],
            &known(),
        )?;
        assert_eq!(h.tolerated, vec!["000021_coordinator.sql"]);
        assert!(
            err(&[row("000021_coordinator.sql", "x", Some("additive"))])
                .contains("checksum mismatch")
        );
        assert!(err(&[row("000021_coordinator.sql", "h", None)]).contains("absent"));
        Ok(())
    }

    #[test]
    fn unverified_status_still_refuses() {
        let mut r = row("000031_newer.sql", "z", Some("additive"));
        r.status = "PENDING".into();
        assert!(err(&[r]).contains("unverified history"));
    }

    #[test]
    fn sync_fills_and_only_tightens() -> Result<()> {
        let h = classify(
            &[
                row("000000_initial.sql", "a", None),
                row("000028_results.sql", "b", Some("breaking")),
            ],
            &known(),
        )?;
        let declared: BTreeMap<_, _> = [
            ("000000_initial.sql".to_owned(), Compat::Breaking),
            ("000028_results.sql".to_owned(), Compat::Additive),
        ]
        .into_iter()
        .collect();
        let (writes, kept) = sync(&h, &declared);
        assert_eq!(
            writes,
            vec![("000000_initial.sql".to_owned(), Compat::Breaking)]
        );
        assert_eq!(kept, vec!["000028_results.sql"]);
        let h = classify(
            &[row("000028_results.sql", "b", Some("additive"))],
            &known(),
        )?;
        let declared: BTreeMap<_, _> = [("000028_results.sql".to_owned(), Compat::Breaking)]
            .into_iter()
            .collect();
        assert_eq!(
            sync(&h, &declared).0,
            vec![("000028_results.sql".to_owned(), Compat::Breaking)]
        );
        Ok(())
    }
}
