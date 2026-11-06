//! Request-only connection setup observation. No pool owns this state.
//!
//! Tokio task locals do not propagate to spawned tasks. Detached vote dispatch,
//! the notification lane, revocation refresh and /health pings record nothing.
//! The pool explicitly carries a handle across spawn_blocking for request work.
use std::{
    ptr,
    sync::{
        Arc,
        atomic::{AtomicPtr, AtomicU64, Ordering},
    },
    time::Instant,
};

tokio::task_local! {
    pub(crate) static OBSERVATION: Arc<Observation>;
}

/// An append-only list: one allocation per cold setup, none per warm checkout
/// or SQL statement. Nodes live until the request AND all blocking work end.
#[derive(Default)]
pub(crate) struct Observation {
    head: AtomicPtr<Setup>,
}
struct Setup {
    next: *mut Setup,
    started: Instant,
    // Zero is running; otherwise elapsed nanoseconds + 1, with a failure bit.
    ended: AtomicU64,
}
const FAILED: u64 = 1 << 63;

pub(crate) struct Scope<'a> {
    // Borrow keeps the whole list alive through completion, even after timeout.
    setup: &'a Setup,
    succeeded: bool,
}
impl Scope<'_> {
    pub(crate) fn succeeded(&mut self) {
        self.succeeded = true;
    }
}
impl Drop for Scope<'_> {
    fn drop(&mut self) {
        let elapsed = self
            .setup
            .started
            .elapsed()
            .as_nanos()
            .min(u128::from(FAILED - 2)) as u64;
        self.setup.ended.store(
            (elapsed + 1) | if self.succeeded { 0 } else { FAILED },
            Ordering::Release,
        );
    }
}

#[derive(Default)]
pub(crate) struct Snapshot {
    pub(crate) count: u64,
    pub(crate) failed: u64,
    pub(crate) ms: f64,
    pub(crate) in_flight: u64,
}
impl Observation {
    pub(crate) fn begin(&self) -> Scope<'_> {
        let raw = Box::into_raw(Box::new(Setup {
            next: ptr::null_mut(),
            started: Instant::now(),
            ended: AtomicU64::new(0),
        }));
        let mut head = self.head.load(Ordering::Acquire);
        loop {
            // SAFETY: this node is still private after every failed CAS. Its
            // Box ownership was relinquished before any other thread can see it.
            unsafe { (*raw).next = head };
            match self
                .head
                .compare_exchange_weak(head, raw, Ordering::Release, Ordering::Acquire)
            {
                Ok(_) => {
                    // Ownership transfers to the list. No node is removed while
                    // any handle or scope exists, so readers need no reclamation.
                    // SAFETY: published node remains alive for this borrow of self.
                    return Scope {
                        setup: unsafe { &*raw },
                        succeeded: false,
                    };
                }
                Err(current) => head = current,
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let mut next = self.head.load(Ordering::Acquire);
        let now = Instant::now();
        let mut out = Snapshot::default();
        let mut nanos = 0_u128;
        while !next.is_null() {
            // SAFETY: acquire sees initialized next/started. They never change
            // after publication; only ended is mutable (atomic). self is alive.
            let setup = unsafe { &*next };
            let age = now.saturating_duration_since(setup.started).as_nanos();
            let ended = setup.ended.load(Ordering::Acquire);
            let elapsed = u128::from((ended & !FAILED).saturating_sub(1));
            out.count += 1;
            if ended == 0 || elapsed > age {
                out.in_flight += 1;
                nanos += age;
            } else {
                out.failed += u64::from(ended & FAILED != 0);
                nanos += elapsed;
            }
            next = setup.next;
        }
        out.ms = (nanos as f64 / 1000.0).round() / 1000.0;
        out
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        let mut next = *self.head.get_mut();
        while !next.is_null() {
            // SAFETY: the last owner has gone; no scope or reader can remain.
            // Each allocation was transferred exactly once by begin().
            let node = unsafe { Box::from_raw(next) };
            next = node.next;
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::time::Duration;

    #[test]
    fn db_connect_scope_records_unwind_as_failure_and_stops_the_clock() {
        let observation = Observation::default();
        let panic = std::panic::catch_unwind(|| {
            let _scope = observation.begin();
            std::thread::sleep(Duration::from_millis(2));
            panic!("setup failed before completion");
        });
        assert!(panic.is_err());
        let first = observation.snapshot();
        assert_eq!((first.count, first.failed, first.in_flight), (1, 1, 0));
        assert!(first.ms >= 2.0);
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(first.ms, observation.snapshot().ms);
    }

    #[test]
    fn db_connect_parallel_setups_sum_time_and_keep_all_records() {
        let observation = Arc::new(Observation::default());
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let observation = observation.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut scope = observation.begin();
                    barrier.wait();
                    barrier.wait();
                    scope.succeeded();
                })
            })
            .collect();
        barrier.wait();
        std::thread::sleep(Duration::from_millis(2));
        let running = observation.snapshot();
        assert_eq!(
            (running.count, running.failed, running.in_flight),
            (8, 0, 8)
        );
        assert!(running.ms >= 16.0);
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let done = observation.snapshot();
        assert_eq!((done.count, done.failed, done.in_flight), (8, 0, 0));
        assert!(done.ms >= running.ms);
    }

    #[tokio::test]
    async fn db_connect_detached_tasks_do_not_inherit_the_request() {
        let observation = Arc::new(Observation::default());
        OBSERVATION
            .scope(observation.clone(), async {
                assert!(OBSERVATION.try_with(Arc::clone).is_ok());
                tokio::spawn(async {
                    assert!(OBSERVATION.try_with(Arc::clone).is_err());
                })
                .await
                .unwrap();
            })
            .await;
        assert_eq!(observation.snapshot().count, 0);
    }
}
