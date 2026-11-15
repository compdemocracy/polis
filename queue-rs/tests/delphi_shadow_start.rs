//! The shadow's two processes as the container starts them: each refuses a
//! served env before it does anything else. `polis-delphi-shadow daemon`
//! starts `polis-jobs` (a stand-in on `PATH` here) only on a shadow env, and
//! the scheduler exits 2 on a served one. No database is needed.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const BIN: &str = env!("CARGO_BIN_EXE_polis-delphi-shadow");

/// A directory holding a stand-in `polis-jobs` that records that it ran, with
/// the envs it was given, and exits 7.
fn stand_in() -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("delphi-shadow-start-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("ran");
    let script = dir.join("polis-jobs");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s %s %s\\n' \"$QUEUE_ENV\" \"$DELPHI_RESULT_ENV\" \"$$\" > '{}'\nexit 7\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, marker)
}

fn run_with_pid(args: &[&str], path: &Path, env: &[(&str, &str)]) -> (u32, Output) {
    let mut c = Command::new(BIN);
    c.args(args)
        .env_clear()
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let child = c.spawn().unwrap();
    let pid = child.id();
    (pid, child.wait_with_output().unwrap())
}

fn run(args: &[&str], path: &Path, env: &[(&str, &str)]) -> Output {
    run_with_pid(args, path, env).1
}

#[test]
fn the_daemon_starts_polis_jobs_only_on_a_shadow_env() {
    let (dir, marker) = stand_in();
    let shadow = [
        ("QUEUE_ENV", "shadow-delphi-1"),
        ("DELPHI_RESULT_ENV", "shadow-delphi-1"),
        ("POLIS_JOBS_ENABLED", "1"),
    ];
    let (pid, out) = run_with_pid(&["daemon"], &dir, &shadow);
    // The stand-in's exit code, and its process is the one started: the
    // check replaced itself with polis-jobs (exec), it did not spawn it.
    assert_eq!(out.status.code(), Some(7), "{out:?}");
    let ran = std::fs::read_to_string(&marker).unwrap();
    assert_eq!(ran, format!("shadow-delphi-1 shadow-delphi-1 {pid}\n"));

    for env in [
        [
            ("QUEUE_ENV", "import-example-1"),
            ("DELPHI_RESULT_ENV", "import-example-1"),
            ("POLIS_JOBS_ENABLED", "1"),
        ],
        [
            ("QUEUE_ENV", "shadow-delphi-1"),
            ("DELPHI_RESULT_ENV", "import-example-1"),
            ("POLIS_JOBS_ENABLED", "1"),
        ],
        [
            ("QUEUE_ENV", "import-example-1"),
            ("DELPHI_RESULT_ENV", "shadow-delphi-1"),
            ("POLIS_JOBS_ENABLED", "1"),
        ],
        // Switched off is no excuse: the env is checked first.
        [
            ("QUEUE_ENV", "import-example-1"),
            ("DELPHI_RESULT_ENV", "import-example-1"),
            ("POLIS_JOBS_ENABLED", "0"),
        ],
    ] {
        std::fs::remove_file(&marker).unwrap_or(());
        let out = run(&["daemon"], &dir, &env);
        assert_eq!(out.status.code(), Some(2), "{env:?}: {out:?}");
        assert!(!marker.exists(), "{env:?}: polis-jobs ran");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("polis-delphi-shadow: daemon:"), "{stderr}");
        assert!(!stderr.contains("import-example-1"), "{stderr}");
    }
    let out = run(&["daemon"], &dir, &[]);
    assert_eq!(out.status.code(), Some(2));
    assert!(!marker.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_scheduler_refuses_a_served_env_at_start() {
    let (dir, marker) = stand_in();
    let base = [
        ("DELPHI_SHADOW_ENABLED", "1"),
        ("QUEUE_DATABASE_URL", "postgresql://q@127.0.0.1:9/db"),
        (
            "DELPHI_SHADOW_READ_DATABASE_URL",
            "postgresql://r@127.0.0.1:9/db",
        ),
        ("POLIS_JOBS_TRANSPORT", "loopback"),
        (
            "DELPHI_SHADOW_CODE_VERSION",
            "0123456789abcdef0123456789abcdef01234567",
        ),
    ];
    for extra in [
        [
            ("DELPHI_SHADOW_ENV", "import-example-1"),
            ("QUEUE_ENV", "import-example-1"),
        ],
        [
            ("DELPHI_SHADOW_ENV", "shadow-delphi-1"),
            ("QUEUE_ENV", "import-example-1"),
        ],
        [("DELPHI_SHADOW_ENV", "prod"), ("QUEUE_ENV", "")],
    ] {
        let env: Vec<_> = base.iter().chain(extra.iter()).copied().collect();
        let out = run(&[], &dir, &env);
        assert_eq!(out.status.code(), Some(2), "{extra:?}: {out:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.starts_with("polis-delphi-shadow: "), "{stderr}");
        assert!(stderr.contains("ENV"), "{stderr}");
    }
    assert!(!marker.exists(), "the scheduler never starts the daemon");
    // An argument it does not know is refused, not taken for the scheduler.
    assert_eq!(run(&["deamon"], &dir, &base).status.code(), Some(2));
    std::fs::remove_dir_all(&dir).unwrap();
}
