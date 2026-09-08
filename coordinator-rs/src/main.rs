use anyhow::{Result, bail};
use polis_coordinator::{
    config::Config,
    fault::Fault,
    lease::LeaseState,
    store::{PgStore, ResultsStore},
};
use serde_json::json;

fn run() -> Result<()> {
    Fault::reject_release_control()?;
    let mode = std::env::args().nth(1).unwrap_or_else(|| "run".into());
    if mode == "stages" {
        println!("{}", json!(polis_coordinator::fault::STAGES));
        return Ok(());
    }
    let config = Config::from_env()?;
    let mut store = PgStore::connect(config)?;
    match mode.as_str() {
        "migrate" => store.migrate(),
        "once" => {
            let n = store.once()?;
            println!("{}", json!({"status":"DONE","published":n}));
            Ok(())
        }
        #[cfg(feature = "fault-injection")]
        "publish-fixture" => {
            let marker: bool = store
                .client
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM p026_test_marker WHERE namespace=$1)",
                    &[&store.config.math_env],
                )?
                .get(0);
            anyhow::ensure!(marker, "test database required");
            let path = std::env::args()
                .nth(2)
                .ok_or_else(|| anyhow::anyhow!("fixture path required"))?;
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
            let zid: i32 = serde_json::from_value(v["zid"].clone())?;
            let payloads: polis_coordinator::store::Payloads =
                serde_json::from_value(v["payloads"].clone())?;
            let epoch = store.acquire(zid)?.ok_or(LeaseState::Unavailable)?;
            let expected = v["expected_tick"].as_i64();
            let result = store.publish(zid, expected, epoch, v["checkpoint"].clone(), &payloads)?;
            store.release(zid, epoch)?;
            println!("{result:?}");
            Ok(())
        }
        "reader" => {
            let consumer = std::env::args().nth(2).unwrap_or_else(|| "cli".into());
            let bundles = store.reader_page(&consumer)?;
            println!("{}", serde_json::to_string(&bundles)?);
            Ok(())
        }
        "read" => {
            let zid: i32 = std::env::args()
                .nth(2)
                .ok_or_else(|| anyhow::anyhow!("zid required"))?
                .parse()?;
            if let polis_coordinator::store::Current::Coherent(b) = store.load_current(zid)? {
                store
                    .fault
                    .hit("bundle_pinned", &json!({"zid":zid,"tick":b.math_tick}))?;
                store.fault.hit(
                    "before_companion_join",
                    &json!({"zid":zid,"tick":b.math_tick}),
                )?;
                println!("{}", serde_json::to_string(&b)?);
                Ok(())
            } else {
                bail!("absent/inconsistent bundle")
            }
        }
        "scan" => {
            let after: i32 = std::env::args()
                .nth(2)
                .unwrap_or_else(|| "0".into())
                .parse()?;
            store.fault.hit("before_sweep", &json!({"after":after}))?;
            let rows = store.scan_current(after, store.config.page_size)?;
            store.fault.hit("after_sweep", &json!({"rows":rows}))?;
            println!("{}", serde_json::to_string(&rows)?);
            Ok(())
        }
        "poll" => {
            let high: i64 = std::env::args()
                .nth(2)
                .unwrap_or_else(|| "0".into())
                .parse()?;
            store.fault.hit("before_cursor", &json!({"high":high}))?;
            let rows =
                store.poll_changes(high, store.config.window, (-1, 0), store.config.page_size)?;
            store.fault.hit("after_cursor", &json!({"rows":rows}))?;
            println!("{}", serde_json::to_string(&rows)?);
            Ok(())
        }
        "run" => loop {
            if let Err(e) = store.cycle() {
                // Only a superseded owner ends the daemon.
                if LeaseState::of(&e).is_some_and(|s| !s.recoverable()) {
                    return Err(e);
                }
                tracing::error!(error=%e,"cycle failed; cursor retained for retry");
                if store.client.is_closed()
                    && let Ok(reconnected) = PgStore::connect(store.config.clone())
                {
                    store = reconnected;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(store.config.poll_ms));
        },
        _ => bail!("unknown command"),
    }
}
fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .init();
    if let Err(e) = run() {
        let code = LeaseState::of(&e).map_or(1, LeaseState::exit_code);
        let sqlstate = e
            .downcast_ref::<postgres::Error>()
            .and_then(|e| e.code())
            .map(|c| c.code());
        tracing::error!(error=%e,exit_code=code,sqlstate,"coordinator failed");
        std::process::exit(code);
    }
}
