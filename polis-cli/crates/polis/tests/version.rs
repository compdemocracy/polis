use std::process::Command;

#[test]
fn version_identifies_source_without_credentials_or_network() {
    for flag in ["--version", "-V"] {
        let dir = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_polis"))
            .args([flag])
            .env("POLIS_CONFIG_DIR", dir.path().join("absent"))
            .env("POLIS_KEYCHAIN", "off")
            .output()
            .unwrap();
        assert!(out.status.success());
        let commit = option_env!("POLIS_BUILD_COMMIT").unwrap_or("unknown");
        let source = option_env!("POLIS_BUILD_SOURCE").unwrap_or("development");
        assert_eq!(
            String::from_utf8(out.stdout).unwrap().trim(),
            format!(
                "polis {} (commit {commit}; {source})",
                env!("CARGO_PKG_VERSION")
            )
        );
        assert!(out.stderr.is_empty());
        assert!(!dir.path().join("absent").exists());
    }
}
