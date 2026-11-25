//! `polis-delphi-shadow`: admits the free-only Delphi shadow's runs, one at a
//! time, paced (see `polis_queue_adapter::shadow`). Exits 0 immediately unless
//! `DELPHI_SHADOW_ENABLED=1`. Exit 2: invalid configuration (a served env
//! among it) or an unreadable state file. `--version` prints the name and the
//! crate version and exits 0 without reading the environment.
//!
//! `polis-delphi-shadow daemon` starts the shadow's job daemon instead: it
//! refuses (exit 2) unless `QUEUE_ENV` and `DELPHI_RESULT_ENV` are the same
//! shadow env, and then replaces itself with `polis-jobs`, adding the thread
//! counts of `daemon::thread_settings` to its environment (none unless the
//! container is fenced below the box's CPUs) and logging what it decided.
//!
//! With `DELPHI_SHADOW_DERIVED_BACKFILL=1` it replaces itself with
//! `polis-topic-map shadow-scheduler`, the same scheduler with the backfill
//! of derived topic maps (`shadow::backfill`); off, it never does.
//!
//! `polis-delphi-shadow threads` prints those settings, one `KEY=value` line
//! each (nothing when the container is not fenced), and exits 0; it reads
//! nothing but the process's own CPUs and environment.
use polis_queue_adapter::shadow::{backfill, config, daemon, scheduler};
use serde_json::json;
use std::os::unix::process::CommandExt;

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("polis-delphi-shadow {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("threads") => {
            let cpus = daemon::read_cpus();
            for (k, v) in daemon::thread_settings(&cpus, |k| std::env::var(k).ok()) {
                println!("{k}={v}");
            }
            return;
        }
        Some("daemon") => {
            if let Err(e) = daemon::check(|k| std::env::var(k).ok()) {
                eprintln!("{e}");
                std::process::exit(scheduler::EXIT_CONFIG);
            }
            let cpus = daemon::read_cpus();
            let settings = daemon::thread_settings(&cpus, |k| std::env::var(k).ok());
            let set: serde_json::Map<String, serde_json::Value> = settings
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone().into()))
                .collect();
            scheduler::log(
                "threads",
                json!({"cpus_online": cpus.online, "cpus_affinity": cpus.affinity,
                       "cpu_quota": cpus.quota, "cpus_usable": cpus.usable(), "set": set}),
            );
            // exec returns only when it failed.
            let e = std::process::Command::new(daemon::DAEMON)
                .envs(settings)
                .exec();
            eprintln!("polis-delphi-shadow: daemon: {}: {e}", daemon::DAEMON);
            std::process::exit(scheduler::EXIT_CONFIG);
        }
        Some(_) => {
            eprintln!("polis-delphi-shadow: the only arguments are daemon, threads and --version");
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
    if cfg.derived.enabled {
        // The backfill asks through the derived jobs' admission, which this
        // binary cannot link: the same scheduler runs from the binary that
        // can. exec returns only when it failed.
        let e = std::process::Command::new(backfill::SCHEDULER)
            .arg("shadow-scheduler")
            .exec();
        eprintln!("polis-delphi-shadow: {}: {e}", backfill::SCHEDULER);
        std::process::exit(scheduler::EXIT_CONFIG);
    }
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
