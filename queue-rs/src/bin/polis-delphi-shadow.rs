//! `polis-delphi-shadow`: admits the free-only Delphi shadow's runs, one at a
//! time, paced (see `polis_queue_adapter::shadow`). Exits 0 immediately unless
//! `DELPHI_SHADOW_ENABLED=1`. Exit 2: invalid configuration or an unreadable
//! state file. `--version` prints the name and the crate version and exits 0
//! without reading the environment.
use polis_queue_adapter::shadow::{config, scheduler};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("polis-delphi-shadow {}", env!("CARGO_PKG_VERSION"));
        return;
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
