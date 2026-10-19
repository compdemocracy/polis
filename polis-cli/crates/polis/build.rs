use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=POLIS_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=POLIS_BUILD_SOURCE");
    let commit = env::var("POLIS_BUILD_COMMIT").unwrap_or_else(|_| "unknown".into());
    assert!(
        commit == "unknown"
            || (commit.len() == 40
                && commit
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())),
        "POLIS_BUILD_COMMIT must be a full lowercase Git commit or unknown"
    );
    let source = env::var("POLIS_BUILD_SOURCE").unwrap_or_else(|_| "development".into());
    assert!(
        matches!(
            source.as_str(),
            "development" | "clean-checkout" | "unverified-archive"
        ),
        "invalid POLIS_BUILD_SOURCE"
    );
    assert!(
        source != "clean-checkout" || commit != "unknown",
        "clean-checkout requires a commit"
    );
    println!("cargo:rustc-env=POLIS_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=POLIS_BUILD_SOURCE={source}");
}
