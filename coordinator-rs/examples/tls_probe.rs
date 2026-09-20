//! Local transport probe: no schema, migration or coordinator admission needed.
fn main() {
    let result = (|| -> anyhow::Result<()> {
        let mut client = polis_coordinator::database::Database::from_env()?.connect()?;
        let ssl: bool = client
            .query_one(
                "SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()",
                &[],
            )?
            .get(0);
        anyhow::ensure!(ssl, "DB-TLS-MISSING");
        println!("TLS-VERIFIED");
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
