//! Comment routing's precomputed plans, in this process's memory only.
//! Dormant: nothing in this crate calls anything here (no route, no
//! handler, no startup step); the switch that would is not built yet.

pub(crate) mod cache;

#[cfg(test)]
mod cache_tests;
