//! `polis-jobs`: runs Delphi jobs from the `polis-queue/2` Postgres queue.
//! Exits 0 immediately unless `POLIS_JOBS_ENABLED=1`. Exit 2: invalid
//! configuration or an unwritable journal. Exit 3: the database lacks the
//! `polis-queue/2` contract.
use polis_queue_adapter::jobs::{claim, config};

fn main() {
    match config::load(|k| std::env::var(k).ok()) {
        Ok(config::Load::Disabled) => std::process::exit(0),
        Ok(config::Load::Ready(cfg)) => std::process::exit(claim::run(*cfg)),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(claim::EXIT_CONFIG);
        }
    }
}
