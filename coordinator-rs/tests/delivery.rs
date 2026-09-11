use anyhow::Result;
use polis_coordinator::metrics::{BoundedSink, Sink};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

struct Blocked(mpsc::Receiver<()>);
impl Sink for Blocked {
    fn write(&mut self, _: &Value) -> Result<()> {
        let _ = self.0.recv();
        Ok(())
    }
    fn describe(&self) -> String {
        "blocked".into()
    }
}
#[test]
fn blocked_sink_bounds_queue_and_shutdown() -> Result<()> {
    let (release, wait) = mpsc::channel();
    let mut sink = BoundedSink::new(Box::new(Blocked(wait)), 2);
    let start = Instant::now();
    for _ in 0..1000 {
        sink.write(&json!({"value":1}))?;
    }
    assert!(sink.dropped() >= 997);
    drop(sink);
    assert!(start.elapsed() < Duration::from_secs(2));
    drop(release);
    Ok(())
}
struct Broken(Arc<AtomicU64>);
impl Sink for Broken {
    fn write(&mut self, _: &Value) -> Result<()> {
        self.0.fetch_add(1, Ordering::Release);
        anyhow::bail!("private device error must never be logged")
    }
    fn describe(&self) -> String {
        "broken".into()
    }
}
#[test]
fn failed_device_counts_without_blocking_producer() -> Result<()> {
    let calls = Arc::new(AtomicU64::new(0));
    let mut sink = BoundedSink::new(Box::new(Broken(calls.clone())), 2);
    sink.write(&json!({"value":1}))?;
    let end = Instant::now() + Duration::from_secs(2);
    while sink.dropped() == 0 && Instant::now() < end {
        std::thread::yield_now();
    }
    assert_eq!(calls.load(Ordering::Acquire), 1);
    assert_eq!(sink.dropped(), 1);
    Ok(())
}
#[test]
fn oversized_metric_is_refused_before_queueing() {
    let (_release, wait) = mpsc::channel();
    let mut sink = BoundedSink::new(Box::new(Blocked(wait)), 1);
    assert!(sink.write(&json!({"data":"x".repeat(16385)})).is_err());
}
