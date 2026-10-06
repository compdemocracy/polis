//! `polis-jobs`: runs jobs of one worker class (`POLIS_JOBS_WORKER_CLASS`:
//! `delphi`, the Delphi stages, or `large`, the math rebuild) from the
//! Postgres queue. Exits 0 immediately unless `POLIS_JOBS_ENABLED=1`. Exit 2:
//! invalid configuration or an unwritable journal. Exit 3: the database lacks
//! a contract the class may run on (`polis-queue/2` or `/3` for `delphi`,
//! `/3` for `large`).
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
