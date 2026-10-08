//! The `polis-jobs` binary's start-up answers that need no database:
//! `--version`, the disabled exit, and the refusal of a password file that is
//! not there (the queue login's secret was never written). Runs with plain
//! `cargo test`; the database-backed refusals (contract, login boundary) are
//! in `jobs_integration.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::{Command, Output};

fn bin() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_polis-jobs"));
    c.env_clear();
    c
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[test]
fn version_prints_the_crate_version_and_exits_zero() {
    let out: Output = bin().arg("--version").output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert_eq!(
        text(&out.stdout),
        format!("polis-jobs {}\n", env!("CARGO_PKG_VERSION"))
    );
    // --version wins over an enabled configuration and touches nothing.
    let out = bin()
        .arg("--version")
        .env("POLIS_JOBS_ENABLED", "1")
        .env("POLIS_JOBS_JOURNAL_DIR", "/proc/forbidden/journal")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn disabled_exits_zero_without_reading_anything_else() {
    let out = bin().output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let out = bin()
        .env("POLIS_JOBS_ENABLED", "0")
        .env("POLIS_JOBS_PASSWORD_FILE", "/nonexistent/queue-login")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn a_missing_password_file_refuses_with_exit_two() {
    let journal = std::env::temp_dir().join(format!("polis-jobs-cli-{}", std::process::id()));
    let out = bin()
        .env("POLIS_JOBS_ENABLED", "1")
        .env("QUEUE_ENV", "test")
        .env(
            "QUEUE_DATABASE_URL",
            "postgresql://polis_jobs@127.0.0.1:9/x",
        )
        .env("POLIS_JOBS_TRANSPORT", "loopback")
        .env("POLIS_JOBS_JOURNAL_DIR", journal.display().to_string())
        .env("POLIS_JOBS_PASSWORD_FILE", "/nonexistent/queue-login")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&journal);
    let err = text(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{err}");
    assert!(err.contains("unreadable password file"), "{err}");
}
