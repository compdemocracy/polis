//! The database's declaration of the stored vote sign, read at startup and
//! at every source snapshot (P-078).
//!
//! Migration 000025 gives the database one row, `public.vote_convention`,
//! naming which stored value means "agree". The coordinator reads votes
//! raw and normalizes them with `STORAGE_AGREE_VALUE` (`config.rs`), so a
//! build made for one sign must refuse a database that declares none, a
//! contract it does not know, or the other sign: serving it would digest and
//! publish every vote inverted. Nothing here guesses; an absent row is a
//! refusal, never a default.
//!
//! The decision is a pure function over what the database answered
//! ([`DatabaseConvention`] → [`judge`]), so it is tested without a database.
//! The messages are mirrored by the server (`server/src/votes/dbConvention.ts`)
//! and the engine (`delphi/polismath/utils/vote_convention_boot.py`).
use anyhow::{Result, anyhow, bail};
use postgres::GenericClient;
use std::fmt;

/// The installed-surface contracts this build understands.
pub const SUPPORTED_CONTRACTS: &[i32] = &[1];
pub const GUIDE: &str = "docs/vote-convention-upgrade.md";
pub const MIGRATION: &str = "server/postgres/migrations/000025_vote_convention.sql";

const PRESENT_SQL: &str = "SELECT to_regclass('public.vote_convention') IS NOT NULL AND to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present";
const ROW_SQL: &str =
    "SELECT version, agree_value, contract_version FROM public.vote_convention_current()";

/// What the database declares, before it is judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseConvention {
    /// No table or no function: migration 000025 is not applied.
    NoTable,
    /// The table exists and holds no row: the operator has not declared the sign.
    NoRow,
    Declared {
        version: i32,
        agree_value: i16,
        contract_version: i32,
    },
}

/// Why this build may not run against the database. Closed set; the token is
/// what a log line or exit mapper sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NotInstalled(String),
    Undeclared(String),
    ContractUnsupported(String),
    Mismatch(String),
}
impl Refusal {
    pub fn token(&self) -> &'static str {
        match self {
            Self::NotInstalled(_) => "vote_convention_not_installed",
            Self::Undeclared(_) => "vote_convention_undeclared",
            Self::ContractUnsupported(_) => "vote_convention_contract_unsupported",
            Self::Mismatch(_) => "vote_convention_mismatch",
        }
    }
    pub fn message(&self) -> &str {
        match self {
            Self::NotInstalled(m)
            | Self::Undeclared(m)
            | Self::ContractUnsupported(m)
            | Self::Mismatch(m) => m,
        }
    }
}
impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.token(), self.message())
    }
}
impl std::error::Error for Refusal {}

fn signed(value: i64) -> String {
    if value > 0 {
        format!("+{value}")
    } else {
        value.to_string()
    }
}

/// The exact command an operator runs to declare an existing database's sign.
pub fn declare_command(agree: i64) -> String {
    format!("make vote-convention-declare AGREE={}", signed(agree))
}

/// What the database declares, without judging it. Works on a client or
/// inside a transaction, so a snapshot reads the row with its votes.
pub fn read(client: &mut impl GenericClient) -> Result<DatabaseConvention> {
    let present: bool = client.query_one(PRESENT_SQL, &[])?.get(0);
    if !present {
        return Ok(DatabaseConvention::NoTable);
    }
    let rows = client.query(ROW_SQL, &[])?;
    match rows.as_slice() {
        [] => Ok(DatabaseConvention::NoRow),
        [row] => Ok(DatabaseConvention::Declared {
            version: row.try_get(0)?,
            agree_value: row.try_get(1)?,
            contract_version: row.try_get(2)?,
        }),
        _ => Err(anyhow!(
            "Polis cannot start: public.vote_convention_current() returned {} rows; exactly one is required. Nothing has been changed. Guide: {GUIDE}#inconsistent",
            rows.len()
        )),
    }
}

/// The decision: may a build made for `built_for` (the configured
/// `STORAGE_AGREE_VALUE`) run against what the database declares?
pub fn judge(found: DatabaseConvention, component: &str, built_for: i64) -> Result<(), Refusal> {
    let prefix = format!("Polis cannot start ({component}):");
    match found {
        DatabaseConvention::NoTable => Err(Refusal::NotInstalled(format!(
            "{prefix} this database has no vote_convention table, so it does not record which stored vote value means \"agree\". \
Migration 000025 has not been applied. Nothing has been changed. Next: back up the database, apply {MIGRATION} (see docs/migrations.md), \
then, if the database already holds votes, run \"{}\". Guide: {GUIDE}#guard",
            declare_command(built_for)
        ))),
        DatabaseConvention::NoRow => Err(Refusal::Undeclared(format!(
            "{prefix} this database does not record which stored vote value means \"agree\". Older Polis databases store agree as {}; \
this release no longer assumes it. Nothing has been changed. Next: back up the database, then declare its convention with \"{}\" \
(AGREE={} only if your deployment reversed its vote signs itself). Guide: {GUIDE}#declare",
            signed(built_for),
            declare_command(built_for),
            signed(-built_for)
        ))),
        DatabaseConvention::Declared {
            version,
            agree_value,
            contract_version,
        } => {
            if !SUPPORTED_CONTRACTS.contains(&contract_version) {
                return Err(Refusal::ContractUnsupported(format!(
                    "{prefix} this database uses vote convention contract {contract_version}; this release understands {}. \
A newer Polis release changed the database. Nothing has been changed. Next: run that newer release, or restore the backup taken before it. \
Guide: {GUIDE}#a-newer-database",
                    SUPPORTED_CONTRACTS
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            if i64::from(agree_value) != built_for {
                return Err(Refusal::Mismatch(format!(
                    "{prefix} this database declares vote convention version {version} (agree = {}), but this release of the {component} \
is built for agree = {}. Running it would read and write every vote inverted. Nothing has been changed. \
Next: run a Polis release built for the declared convention, or restore the database this release was built for. Guide: {GUIDE}#mismatch",
                    signed(i64::from(agree_value)),
                    signed(built_for)
                )));
            }
            Ok(())
        }
    }
}

/// Read and judge; the declared version on success, the operator message
/// (as an error carrying the [`Refusal`]) otherwise.
pub fn require(client: &mut impl GenericClient, component: &str, built_for: i64) -> Result<i32> {
    let found = read(client)?;
    judge(found, component, built_for)?;
    match found {
        DatabaseConvention::Declared { version, .. } => Ok(version),
        _ => bail!("unreachable: a judged convention is declared"),
    }
}
