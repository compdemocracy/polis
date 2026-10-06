//! The `polis-queue/2` foundation migration the daemon runs on (000023) lives
//! in the repository's migration chain, `server/postgres/migrations`, sealed
//! by digest next to its down script. These checks need no database: the two
//! files are present and match their seal, the up script admits exactly the
//! stages the daemon knows, and with the flag off the daemon exits 0 before it
//! touches any connection string.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use polis_queue_adapter::jobs::config::KNOWN_STAGES;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};

const UP: &str = "000023_create_delphi_foundation.sql";
const DOWN: &str = "down/000023_drop_delphi_foundation.sql";
const SEAL: &str = "down/000023-files.sha256";

fn migrations() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/postgres/migrations")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `shasum -a 256` lines: `<hex>  <path>`.
fn seal() -> BTreeMap<String, String> {
    let text = fs::read_to_string(migrations().join(SEAL)).unwrap();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let (hex, path) = l.split_once("  ").unwrap();
            (path.trim().to_string(), hex.trim().to_string())
        })
        .collect()
}

#[test]
fn the_foundation_migration_is_in_the_repository_chain_and_sealed() {
    let dir = migrations();
    for rel in [UP, DOWN, SEAL] {
        assert!(
            dir.join(rel).is_file(),
            "missing {}",
            dir.join(rel).display()
        );
    }
    let seal = seal();
    assert_eq!(
        seal.len(),
        2,
        "the seal names exactly the up and down scripts"
    );
    for rel in [UP, DOWN] {
        let pinned = seal
            .get(rel)
            .unwrap_or_else(|| panic!("{rel} is not sealed"));
        let actual = sha256_hex(&fs::read(dir.join(rel)).unwrap());
        assert_eq!(
            &actual, pinned,
            "{rel} differs from its seal; reseal in the same reviewed change"
        );
    }
}

#[test]
fn the_up_script_admits_exactly_the_daemon_stages_beside_noop() {
    let text = fs::read_to_string(migrations().join(UP)).unwrap();
    assert!(text.contains("CHECK(contract_version='polis-queue/2')"));
    let admitted = format!(
        "CHECK(stage IN ('noop',{}))",
        KNOWN_STAGES
            .iter()
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert!(text.contains(&admitted), "stage CHECK must be {admitted}");
}

#[test]
fn flag_off_exits_zero_before_any_connection() {
    // Everything but the flag is set, and the DSN points at a closed loopback
    // port: a daemon that read it would fail fast, not exit 0.
    let out = Command::new(env!("CARGO_BIN_EXE_polis-jobs"))
        .env_clear()
        .env("QUEUE_DATABASE_URL", "postgresql://nobody@127.0.0.1:1/none")
        .env("QUEUE_ENV", "dev")
        .env("POLIS_JOBS_TRANSPORT", "loopback")
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
