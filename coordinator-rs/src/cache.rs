//! Bounded warm bundle cache (CO02/CO07 cache-contention stage).
//!
//! It holds the last *coherent published bundle* for a conversation so an
//! unchanged conversation does not re-read the three results tables on every
//! pass. It is not a warm worker/Conversation cache: every changed source is
//! still recomputed from the full authoritative prefix.
//!
//! Two properties matter and are exercised by the R06 stage:
//! 1. lookup and LRU touch are one `&mut self` operation, so an eviction can
//!    never interleave between "get" and "move to end" (the Python poller's
//!    R06 `KeyError`), and
//! 2. a cached bundle is only usable if its generation still equals the
//!    conversation's current `math_tick`, so an update by any other writer
//!    turns the entry into a miss instead of a lost update.
use crate::{fault::Fault, store::Bundle};
use anyhow::Result;
use serde_json::json;

pub struct WarmCache {
    capacity: usize,
    /// Least recently used first.
    entries: Vec<(i32, Box<Bundle>)>,
}
impl WarmCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: Vec::new(),
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn contains(&self, zid: i32) -> bool {
        self.entries.iter().any(|(id, _)| *id == zid)
    }
    /// Remove and return the entry for `zid` when it still matches the current
    /// generation. A stale entry is dropped, never returned.
    pub fn take(&mut self, zid: i32, current_tick: Option<i64>) -> Option<Box<Bundle>> {
        let index = self.entries.iter().position(|(id, _)| *id == zid)?;
        let (_, bundle) = self.entries.remove(index);
        if current_tick == Some(bundle.math_tick) {
            Some(bundle)
        } else {
            tracing::info!(zid, cached = bundle.math_tick, ?current_tick, "stale warm entry discarded");
            None
        }
    }
    /// Insert as most recently used, evicting the least recently used entry.
    /// The eviction is announced at the contract's cache-contention stage.
    pub fn insert(&mut self, fault: &Fault, zid: i32, bundle: Box<Bundle>) -> Result<()> {
        if self.capacity == 0 {
            return Ok(());
        }
        self.entries.retain(|(id, _)| *id != zid);
        while self.entries.len() + 1 > self.capacity {
            let victim = self.entries.first().map(|(id, _)| *id);
            fault.hit(
                "cache_eviction_contends_with_same_zid_update",
                &json!({"evicted_zid":victim,"inserted_zid":zid,
                    "capacity":self.capacity,"cache_len":self.entries.len()}),
            )?;
            self.entries.remove(0);
        }
        self.entries.push((zid, bundle));
        Ok(())
    }
}
