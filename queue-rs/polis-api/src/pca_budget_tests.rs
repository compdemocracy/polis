//! Real database cache pressure in a separate process, so unrelated parallel
//! tests cannot affect the resident-memory assertion.
use super::*;

fn resident_bytes() -> usize {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find(|line| line.starts_with("VmHWM:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<usize>()
            .unwrap()
            * 1024
    }
    #[cfg(not(target_os = "linux"))]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        assert!(out.status.success());
        std::str::from_utf8(&out.stdout)
            .unwrap()
            .trim()
            .parse::<usize>()
            .unwrap()
            * 1024
    }
}

#[test]
fn database_cache_budget_limits_retained_bytes_and_resident_memory() {
    const CHILD: &str = "POLIS_PCA_MEMORY_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pca::budget_tests::database_cache_budget_limits_retained_bytes_and_resident_memory",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        // Write the child's summary directly so successful default-capture
        // test runs still show the measured peak and its remaining margin.
        use std::io::Write;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout
            .lines()
            .filter(|line| line.starts_with("cache pressure summary:"))
        {
            writeln!(std::io::stdout(), "{line}").unwrap();
        }
        println!("{stdout}");
        assert!(
            output.status.success(),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("pca_budget_{}", std::process::id());
        let data_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../delphi/real_data");
        let directory = std::fs::read_dir(data_root)
            .unwrap()
            .map(|entry| entry.unwrap())
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with("-biodiversity")
            })
            .unwrap()
            .path();
        let fixture = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap())
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with("_math_blob.json")
            })
            .unwrap()
            .path();
        let input = std::fs::read_to_string(fixture).unwrap();
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema};
                SET search_path={setup_schema};
                CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
                CREATE INDEX ON math_main(zid,math_env);"
            ))
            .unwrap();
            c.execute(
                "INSERT INTO math_main SELECT zid, 'memory', 0, $1::text::jsonb
                 FROM generate_series(1,300) zid",
                &[&input],
            )
            .unwrap();
        })
        .await
        .unwrap();
        let mut config: postgres::Config = url.parse().unwrap();
        config.options(&format!("-c search_path={schema}"));
        let connector = polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config));
        let limits = db::Limits {
            size: 1,
            acquire_timeout: std::time::Duration::from_secs(2),
            statement_timeout: std::time::Duration::from_secs(3),
            max_lifetime: std::time::Duration::from_secs(60),
        };
        let db = db::Pool::new(connector, limits);
        let pca = Pca::with_budget(db, "memory".into(), 300, DEFAULT_CACHE_BYTES);
        let mut peak = resident_bytes();
        let mut previous = 0;
        for zid in 1..=300 {
            let item = pca.get_pca(zid, -1.0).await.unwrap().unwrap();
            assert!(!item.gzip.is_empty());
            drop(item);
            let Js::Obj(health) = pca.health() else {
                panic!("cache health");
            };
            let bytes = health.get("bytes").map(js_number).unwrap() as usize;
            assert!(
                bytes <= DEFAULT_CACHE_BYTES,
                "{zid} entries retain {bytes} bytes"
            );
            if zid % 20 == 0 {
                peak = peak.max(resident_bytes());
                println!("cache pressure: requests={zid} bytes={bytes} rss_peak={peak}");
            }
            previous = bytes;
        }
        assert!(previous > 0);
        let Js::Obj(health) = pca.health() else {
            panic!("cache health");
        };
        assert!(health.get("evictionsBytes").map(js_number).unwrap() > 0.0);
        // This isolated public-body workload measured ~207 MiB on Linux
        // with a 192 MiB budget: round its ~15 MiB excess up to 32 MiB.
        // Retain the existing Linux ceiling by reserving another 160 MiB.
        // Native macOS debug runs measured 346-374 MiB: round the largest
        // ~182 MiB excess up to 192 MiB, then leave 64 MiB of headroom.
        // These are workload-specific test ceilings, not process limits or
        // claims about arbitrary request concurrency and response buffers.
        let mib = 1024 * 1024;
        let (overhead, headroom) = if cfg!(target_os = "linux") {
            (32 * mib, 160 * mib)
        } else {
            (192 * mib, 64 * mib)
        };
        let ceiling = DEFAULT_CACHE_BYTES + overhead + headroom;
        println!(
            "cache pressure summary: platform={} budget={} peak={} ceiling={} margin={}",
            std::env::consts::OS,
            DEFAULT_CACHE_BYTES,
            peak,
            ceiling,
            ceiling.saturating_sub(peak)
        );
        assert!(
            peak < ceiling,
            "resident memory {peak} exceeds the test ceiling {ceiling}"
        );
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    });
}
