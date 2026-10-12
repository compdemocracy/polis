//! The `polis-queue/2` foundation migration the daemon runs on (000023), the
//! `polis-queue/3` large-class migration (000024) and the retention migration
//! (000026, on /3) live in the
//! repository's migration chain, `server/postgres/migrations`, each sealed by
//! digest next to its down script. These checks need no database: the files
//! are present and match their seal, the up scripts admit exactly the stages
//! and classes the daemon knows, and with the flag off the daemon exits 0
//! before it touches any connection string.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use polis_queue_adapter::jobs::config::{KNOWN_STAGES, LARGE_STAGES};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};

const UP: &str = "000023_create_delphi_foundation.sql";
const DOWN: &str = "down/000023_drop_delphi_foundation.sql";
const SEAL: &str = "down/000023-files.sha256";
const UP_LARGE: &str = "000024_create_polis_queue_large_class.sql";
const DOWN_LARGE: &str = "down/000024_drop_polis_queue_large_class.sql";
const SEAL_LARGE: &str = "down/000024-files.sha256";
const UP_RETENTION: &str = "000026_create_polis_queue_retention.sql";
const DOWN_RETENTION: &str = "down/000026_drop_polis_queue_retention.sql";
const SEAL_RETENTION: &str = "down/000026-files.sha256";

fn migrations() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/postgres/migrations")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `shasum -a 256` lines: `<hex>  <path>`.
fn seal(path: &str) -> BTreeMap<String, String> {
    let text = fs::read_to_string(migrations().join(path)).unwrap();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let (hex, path) = l.split_once("  ").unwrap();
            (path.trim().to_string(), hex.trim().to_string())
        })
        .collect()
}

fn sealed_in_the_chain(up: &str, down: &str, seal_path: &str) {
    let dir = migrations();
    for rel in [up, down, seal_path] {
        assert!(
            dir.join(rel).is_file(),
            "missing {}",
            dir.join(rel).display()
        );
    }
    let seal = seal(seal_path);
    assert_eq!(
        seal.len(),
        2,
        "the seal names exactly the up and down scripts"
    );
    for rel in [up, down] {
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
fn the_foundation_migration_is_in_the_repository_chain_and_sealed() {
    sealed_in_the_chain(UP, DOWN, SEAL);
}

#[test]
fn the_large_class_migration_is_in_the_repository_chain_and_sealed() {
    sealed_in_the_chain(UP_LARGE, DOWN_LARGE, SEAL_LARGE);
}

#[test]
fn the_retention_migration_is_in_the_repository_chain_and_sealed() {
    sealed_in_the_chain(UP_RETENTION, DOWN_RETENTION, SEAL_RETENTION);
}

/// 000026 leaves the contract at /3 and the stage and class sets alone; it
/// adds the parked read, the usage read and the bounded sweep.
#[test]
fn the_retention_up_script_adds_reads_and_the_sweep_only() {
    let text = fs::read_to_string(migrations().join(UP_RETENTION)).unwrap();
    assert!(!text.contains("contract_version='polis-queue/4'"));
    assert!(!text.contains("CHECK(stage IN"));
    assert!(!text.contains("CHECK(worker_class IN"));
    for f in [
        "CREATE FUNCTION public.pq_class_parked(p_env text,p_worker_class text,p_after_job uuid,p_limit integer)",
        "CREATE FUNCTION public.pq_queue_usage(p_env text)",
        "CREATE FUNCTION public.pq_sweep(p_env text,p_sweep uuid,p_page integer,p_max_pages integer)",
    ] {
        assert!(text.contains(f), "missing {f}");
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

/// 000024 admits the large class and its one stage beside what 000023
/// admits, binds them to each other, and moves the contract to /3.
#[test]
fn the_large_class_up_script_admits_class_large_and_stage_math_rebuild() {
    let text = fs::read_to_string(migrations().join(UP_LARGE)).unwrap();
    assert!(text.contains("CHECK(contract_version='polis-queue/3')"));
    let stages = format!(
        "CHECK(stage IN ('noop',{}))",
        KNOWN_STAGES
            .iter()
            .chain(LARGE_STAGES.iter())
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert!(text.contains(&stages), "stage CHECK must be {stages}");
    assert!(text.contains("CHECK(worker_class IN ('noop','delphi','large'))"));
    assert!(text.contains("CHECK((stage='math_rebuild') = (worker_class='large'))"));
    assert!(text.contains("CREATE FUNCTION public.pq_class_depth(p_env text,p_worker_class text)"));
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
