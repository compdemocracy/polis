//! `polis-delphi-shadow`: the scheduler of the free-only Delphi shadow.
//!
//! It admits, one at a time, full-pipeline runs of live conversations whose
//! comment set changed since their last shadow run, under a result env no
//! reader serves (`shadow-delphi-1` by default; any env not starting with
//! `shadow-` is refused). A `polis-jobs` daemon claiming that env runs them.
//! It is paced like the math backfill: it pauses while the database is slow,
//! while the math engine trails the votes, below a disk floor, at a daily
//! cap and on the operator's pause file, and rests after each run for its
//! duty cycle. With `DELPHI_SHADOW_TWIN_EVERY=N`, every Nth first run that
//! succeeds is repeated once on the same comment set and the two clusterings
//! are compared (`twin`). It is off unless `DELPHI_SHADOW_ENABLED=1`.
//!
//! The shadow's daemon is the ordinary `polis-jobs`, started through
//! `polis-delphi-shadow daemon`, which refuses any env that is not a shadow
//! env (`daemon`). Before each admission the scheduler also holds the bytes
//! the shadow has added to the database under a budget and a daily cap
//! (`storage`).
//!
//! What it touches, and what it never touches: see `db`.
pub mod config;
pub mod daemon;
pub mod db;
pub mod plan;
pub mod scheduler;
pub mod state;
pub mod storage;
pub mod twin;
