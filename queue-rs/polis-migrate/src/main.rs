use anyhow::{Result, bail};
use std::{env, path::PathBuf};
fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_default();
    if matches!(command.as_str(), "--help" | "-h") {
        println!(
            "polis-migrate deploy|apply|check|reconcile [--dir PATH] [--through NNNNNN]\nDATABASE_URL is read from the environment; reconcile requires --through. See docs/migrations.md."
        );
        return Ok(());
    }
    let mut dir = PathBuf::from(
        env::var("POLIS_MIGRATIONS_DIR").unwrap_or_else(|_| "server/postgres/migrations".into()),
    );
    let mut through = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dir" => {
                dir = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--dir needs a path"))?
                    .into()
            }
            "--through" => {
                through = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--through needs a version"))?,
                )
            }
            _ => bail!("unknown argument: {arg}"),
        }
    }
    if !matches!(command.as_str(), "deploy" | "apply" | "check" | "reconcile") {
        bail!("expected deploy, apply, check or reconcile (see --help)");
    }
    if (command == "reconcile") != through.is_some() {
        bail!("only reconcile requires --through NNNNNN");
    }
    let migrations = polis_migrate::load(&dir)?;
    let dsn = env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let mut client = polis_migrate::connect(&dsn)?;
    match command.as_str() {
        "deploy" => polis_migrate::deploy(&mut client, &migrations, &dir)?,
        "apply" => {
            polis_migrate::apply(&mut client, &migrations)?;
        }
        "check" => polis_migrate::check(&mut client, &migrations)?,
        "reconcile" => {
            polis_migrate::reconcile(
                &mut client,
                &migrations,
                &dir,
                through.as_deref().unwrap_or(""),
            )?;
        }
        _ => unreachable!(),
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        // Do not print connection strings, SQL statements or database error DETAIL
        // (which may quote row values). Context + SQLSTATE are sufficient here.
        for cause in error.chain() {
            if let Some(pg) = cause.downcast_ref::<postgres::Error>() {
                if let Some(db) = pg.as_db_error() {
                    eprintln!(
                        "database refused migration: SQLSTATE {} (inspect the named migration)",
                        db.code().code()
                    );
                } else {
                    eprintln!(
                        "database connection failed; check connectivity and TLS configuration"
                    );
                }
                break;
            }
            eprintln!("{cause}");
        }
        std::process::exit(1);
    }
}
