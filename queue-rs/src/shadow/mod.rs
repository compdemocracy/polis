//! `polis-delphi-shadow`: the scheduler of the free-only Delphi shadow.
//!
//! It admits, one at a time, full-pipeline runs of live conversations whose
//! comment set changed since their last shadow run, under a result env no
//! reader serves (`shadow-delphi-1` by default; any env not starting with
//! `shadow-` is refused). A `polis-jobs` daemon claiming that env runs them.
//! It is paced like the math backfill: it pauses while the database is slow,
//! while the math engine trails the votes, below a disk floor, at a daily
//! cap and on the operator's pause file, and rests after each run for its
//! duty cycle. It is off unless `DELPHI_SHADOW_ENABLED=1`.
//!
//! What it touches, and what it never touches: see `db`.
pub mod config;
pub mod db;
pub mod plan;
pub mod scheduler;
pub mod state;
