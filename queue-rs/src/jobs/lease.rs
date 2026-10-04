//! Per-job heartbeat (build spec §1.3 "job task"). Every
//! `POLIS_JOBS_HEARTBEAT_SECONDS` it calls `pq_heartbeat` on its own
//! connection. A `fenced` reply (cancel, expiry, a newer epoch) sets the
//! fenced flag; so does having no successful heartbeat for a whole lease,
//! since the lease is then gone whether or not the database can say so. The
//! job task then kills and reaps the child's group. The thread keeps running
//! until the attempt's final RPC has returned.
use super::{rpc::Rpc, transport::Connector};
use crate::Completion;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct LeaseState {
    pub fenced: AtomicBool,
    pub stop: AtomicBool,
    pub last_ok: Mutex<Option<String>>,
}

pub struct Heartbeat {
    pub state: Arc<LeaseState>,
    handle: Option<JoinHandle<()>>,
}

impl Heartbeat {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        connector: Arc<Connector>,
        env: String,
        job: String,
        owner: String,
        attempt: String,
        epoch: String,
        lease_seconds: u32,
        every: Duration,
    ) -> Self {
        let state = Arc::new(LeaseState::default());
        let shared = state.clone();
        let handle = std::thread::spawn(move || {
            let mut rpc = Rpc::new(connector, &env);
            let mut last_success = Instant::now();
            let mut next = Instant::now() + every;
            let lease = Duration::from_secs(u64::from(lease_seconds));
            while !shared.stop.load(Ordering::SeqCst) {
                if Instant::now() < next {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                next = Instant::now() + every;
                let args: Vec<Value> = vec![
                    json!(env),
                    json!(job),
                    json!(owner),
                    json!(attempt),
                    json!(epoch),
                    json!(lease_seconds),
                ];
                match rpc.call("pq_heartbeat", &args) {
                    Ok(Completion::Committed(reply)) => match reply["outcome"].as_str() {
                        Some("owned") => {
                            last_success = Instant::now();
                            if let Ok(mut g) = shared.last_ok.lock() {
                                *g = Some(super::now_rfc3339());
                            }
                        }
                        _ => {
                            shared.fenced.store(true, Ordering::SeqCst);
                        }
                    },
                    Ok(Completion::Unknown(_)) | Err(_) => {
                        // Retry soon; the lease decides, not one lost call.
                        next = Instant::now() + Duration::from_secs(1).min(every);
                    }
                }
                if last_success.elapsed() >= lease {
                    shared.fenced.store(true, Ordering::SeqCst);
                }
            }
        });
        Self {
            state,
            handle: Some(handle),
        }
    }

    pub fn fenced(&self) -> bool {
        self.state.fenced.load(Ordering::SeqCst)
    }

    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        self.state.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// A job task that unwinds (a panic) drops its heartbeat: renewal stops, the
/// lease expires and the reaper parks the job `exit_unconfirmed`, instead of
/// a live lease being renewed for an attempt nobody will end.
impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.halt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dropped_heartbeat_stops_its_thread() {
        let state = Arc::new(LeaseState::default());
        let shared = state.clone();
        let handle = std::thread::spawn(move || {
            while !shared.stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let hb = Heartbeat {
            state: state.clone(),
            handle: Some(handle),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _owned = hb;
            panic!("job task panicked");
        }));
        assert!(result.is_err());
        assert!(state.stop.load(Ordering::SeqCst));
    }
}
