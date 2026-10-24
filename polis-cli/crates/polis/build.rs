use std::{env, path::Path, process::Command};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repository root");
    for name in [
        "VERSION",
        "VERSION_STABLE_COMMIT",
        "scripts/build_identity.py",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(name).display());
    }
    for name in [
        "POLIS_BUILD_COMMIT",
        "GIT_HASH",
        "POLIS_BUILD_SOURCE",
        "POLIS_BUILD_DISTANCE",
        "POLIS_BUILD_TAG",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    // Resolve paths through Git so linked worktrees track their own HEAD and
    // the common refs/tags/packed-refs as well as ordinary checkouts.
    for name in ["HEAD", "refs", "packed-refs", "index", "shallow"] {
        if let Ok(result) = Command::new("git")
            .current_dir(&root)
            .args(["rev-parse", "--git-path", name])
            .output()
        {
            if result.status.success() {
                let value = String::from_utf8(result.stdout).expect("Git path");
                println!(
                    "cargo:rerun-if-changed={}",
                    root.join(value.trim()).display()
                );
            }
        }
    }
    let result = Command::new("python3")
        .arg(root.join("scripts/build_identity.py"))
        .args(["--format", "env"])
        .output()
        .expect("Python 3 is required to generate the shared Polis build identity");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = String::from_utf8(result.stdout).expect("build identity");
    for line in text.lines() {
        let (key, value) = line.split_once('=').expect("identity field");
        let name = match key {
            "version_base" => "POLIS_VERSION_BASE",
            "version_display" => "POLIS_VERSION_DISPLAY",
            "commit" => "POLIS_BUILD_COMMIT",
            "distance" => "POLIS_BUILD_DISTANCE",
            "source" => "POLIS_BUILD_SOURCE",
            _ => continue,
        };
        println!("cargo:rustc-env={name}={value}");
    }
}
