//! Names the release of the rustc compiling this crate as the cfg
//! `polis_rustc_release` (and as the environment value
//! `POLIS_RUSTC_RELEASE`, for the tests). Some byte bounds in
//! `src/reserve.rs` rest on the standard library's implementation, not its
//! documentation, so they hold under the release they were reviewed on
//! (`REVIEWED_RUSTC`) and refuse under any other. If the release cannot be
//! read, none is named, and they refuse.
//!
//! This runs at build time only. Nothing under `src/` reads the environment,
//! a file or a process; the source scan holds `src/` to that.
//!
//! `POLIS_ROUTING_PLAN_UNREVIEWED_STD`, when set, names no release, so that
//! the refusal can be tested under the reviewed rustc. It can only make the
//! bounds refuse, never admit.
use std::process::Command;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed=POLIS_ROUTING_PLAN_UNREVIEWED_STD");
    println!("cargo::rustc-check-cfg=cfg(polis_rustc_release, values(any()))");
    let release = if std::env::var_os("POLIS_ROUTING_PLAN_UNREVIEWED_STD").is_some() {
        None
    } else {
        let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        Command::new(rustc)
            .arg("-vV")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|text| {
                text.lines()
                    .find_map(|line| line.strip_prefix("release: ").map(str::to_owned))
            })
            .filter(|r| {
                r.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            })
    };
    println!(
        "cargo::rustc-env=POLIS_RUSTC_RELEASE={}",
        release.as_deref().unwrap_or("unknown")
    );
    if let Some(r) = release {
        println!("cargo::rustc-cfg=polis_rustc_release=\"{r}\"");
    }
}
