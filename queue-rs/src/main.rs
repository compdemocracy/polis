//! Bounded JSONL test/operator transport; DSN comes from the environment.
use anyhow::Result;
use polis_queue_adapter::{Completion, Database, Request};
use serde_json::json;
use std::io::{self, BufRead, Read, Write};

fn run() -> Result<()> {
    let enabled = std::env::var("POLIS_QUEUE_SUBSTRATE_ENABLED")
        .is_ok_and(|v| ["1", "true", "yes", "on"].contains(&v.to_lowercase().as_str()));
    let db = Database::new(
        &std::env::var("QUEUE_DATABASE_URL")?,
        &std::env::var("QUEUE_ENV")?,
        enabled,
        std::env::var("NODE_ENV").is_ok_and(|v| v == "production"),
    )?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let n = input.by_ref().take(65537).read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        anyhow::ensure!(
            n <= 65536 && line.last() == Some(&b'\n'),
            "queue_frame_limit"
        );
        let result = serde_json::from_slice::<Request>(&line)
            .map_err(anyhow::Error::from)
            .and_then(|r| db.call(&r));
        let reply = match result {
            Ok(Completion::Committed(value)) => json!({"reply": value}),
            Ok(Completion::Unknown(value)) => json!({"uncertain": value}),
            Err(error) => {
                json!({"error":"queue_refused", "sqlstate": error.downcast_ref::<postgres::Error>().and_then(|e| e.code()).map(|c| c.code())})
            }
        };
        writeln!(output, "{reply}")?;
        output.flush()?;
    }
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("queue_adapter_refused");
        std::process::exit(1);
    }
}
