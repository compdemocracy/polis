//! Installs or removes `tests/older_database_shape.sql` on the test server
//! named by `POLIS_API_TEST_DATABASE_URL`: in that database, where tests
//! create their schemas, and in `template1`, which every database a test
//! creates is copied from. While it is installed, every table the crate's
//! database tests create under one of the names that file lists comes out in
//! the shape of an installation whose database predates the migrations.
//!
//!   cargo run --locked -p polis-api --example older_database_shape -- install
//!   cargo run --locked -p polis-api --example older_database_shape -- remove
//!
//! `template1` is shared by the whole server, so use this only on a server
//! that belongs to the test run. `remove` is safe to run when nothing is
//! installed.
use anyhow::{Context, Result, bail};
use postgres::{Client, Config, NoTls};

const INSTALL: &str = include_str!("../tests/older_database_shape.sql");
const REMOVE: &str = "DROP EVENT TRIGGER IF EXISTS older_database_shape;
                      DROP SCHEMA IF EXISTS older_database_shape CASCADE;";

fn main() -> Result<()> {
    let action = std::env::args().nth(1).unwrap_or_default();
    let sql = match action.as_str() {
        "install" => INSTALL,
        "remove" => REMOVE,
        _ => bail!("usage: older_database_shape install|remove"),
    };
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL")
        .context("POLIS_API_TEST_DATABASE_URL names the test database")?;
    let tests: Config = url
        .parse()
        .context("POLIS_API_TEST_DATABASE_URL is not a PostgreSQL URL")?;
    let mut template = tests.clone();
    template.dbname("template1");
    for (name, config) in [("the test database", tests), ("template1", template)] {
        // Quiet the notices of DROP ... IF EXISTS.
        let mut client: Client = config
            .connect(NoTls)
            .with_context(|| format!("connecting to {name}"))?;
        client
            .batch_execute(&format!("SET client_min_messages = warning; {sql}"))
            .with_context(|| format!("older database shape: {action} in {name}"))?;
    }
    println!("older database shape: {action} done in the test database and in template1");
    Ok(())
}
