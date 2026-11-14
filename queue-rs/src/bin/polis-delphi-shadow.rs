//! `polis-delphi-shadow`: admits the free-only Delphi shadow's runs, one at a
//! time, paced (see `polis_queue_adapter::shadow`). Exits 0 immediately unless
//! `DELPHI_SHADOW_ENABLED=1`. Exit 2: invalid configuration (a served env
//! among it) or an unreadable state file. `--version` prints the name and the
//! crate version and exits 0 without reading the environment.
//!
//! `polis-delphi-shadow daemon` starts the shadow's job daemon instead: it
//! refuses (exit 2) unless `QUEUE_ENV` and `DELPHI_RESULT_ENV` are the same
//! shadow env, and then replaces itself with `polis-jobs`.
use polis_queue_adapter::shadow::{config, daemon, scheduler};
use std::os::unix::process::CommandExt;

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("polis-delphi-shadow {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("daemon") => {
            if let Err(e) = daemon::check(|k| std::env::var(k).ok()) {
                eprintln!("{e}");
                std::process::exit(scheduler::EXIT_CONFIG);
            }
            // exec returns only when it failed.
            let e = std::process::Command::new(daemon::DAEMON).exec();
            eprintln!("polis-delphi-shadow: daemon: {}: {e}", daemon::DAEMON);
            std::process::exit(scheduler::EXIT_CONFIG);
        }
        Some(_) => {
            eprintln!("polis-delphi-shadow: the only arguments are daemon and --version");
            std::process::exit(scheduler::EXIT_CONFIG);
        }
        None => {}
    }
    let cfg = match config::load(|k| std::env::var(k).ok()) {
        Ok(config::Load::Disabled) => std::process::exit(0),
        Ok(config::Load::Ready(cfg)) => cfg,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(scheduler::EXIT_CONFIG);
        }
    };
    scheduler::install_signal_handlers();
    let mut s = match scheduler::Scheduler::new(&cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("polis-delphi-shadow: state file: {e}");
            std::process::exit(scheduler::EXIT_CONFIG);
        }
    };
    std::process::exit(s.run());
}
