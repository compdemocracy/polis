//! Deployment-only idle process. No PgStore, worker, migration or pc_* calls.
//! The observer group remains NOLOGIN; the service uses its separate login.
use polis_coordinator::database::{Database, parse};
use postgres::Client;
use std::{env, thread, time::Duration};

const LOGIN: &str = "polis_coordinator_observer_login";
const GROUP: &str = "polis_coordinator_observer";
type Result<T> = std::result::Result<T, &'static str>;

fn connection() -> Result<Client> {
    for (key, expected) in [
        ("COORDINATOR_MODE", "inactive"),
        ("COORDINATOR_WRITER_ENABLED", "false"),
        ("P026_RESERVATION_BYTES", "0"),
    ] {
        if env::var(key).unwrap_or_else(|_| expected.into()) != expected {
            return Err("IDLE_MODE_REFUSED");
        }
    }
    if env::var_os("COORDINATOR_DB_PASSWORD_FILE").is_none() {
        return Err("IDLE_PASSWORD_FILE_REQUIRED");
    }
    let dsn = env::var("DATABASE_URL").map_err(|_| "IDLE_CONFIG_REFUSED")?;
    let hosts: Vec<String> = env::var("COORDINATOR_DB_HOST_ALLOWLIST")
        .map_err(|_| "IDLE_CONFIG_REFUSED")?
        .split(',')
        .map(|s| s.trim().to_owned())
        .collect();
    let parsed = parse(&dsn, &hosts, true).map_err(|e| e.token())?;
    if parsed.get_user() != Some(LOGIN) {
        return Err("IDLE_LOGIN_REFUSED");
    }
    Database::from_env()
        .map_err(|e| e.token())?
        .connect()
        .map_err(|e| e.token())
}

fn verify(client: &mut Client) -> Result<()> {
    // Session settings and catalog SELECTs only. No application payload is read.
    client.batch_execute("SET default_transaction_read_only=on; SET search_path=pg_catalog; SET statement_timeout='5s'; SET lock_timeout='1s'; SET application_name='polis-coordinator-idle'")
        .map_err(|_| "IDLE_QUERY_REFUSED")?;
    let mut tx = client
        .build_transaction()
        .read_only(true)
        .start()
        .map_err(|_| "IDLE_QUERY_REFUSED")?;
    let identity = tx.query_one("SELECT session_user=$1 AND current_user=$1,
        current_setting('transaction_read_only')='on',
        coalesce((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()),false),
        NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
        FROM pg_catalog.pg_roles WHERE rolname=session_user", &[&LOGIN])
        .map_err(|_| "IDLE_QUERY_REFUSED")?;
    for i in 0..4 {
        if !identity
            .try_get::<_, bool>(i)
            .map_err(|_| "IDLE_QUERY_REFUSED")?
        {
            return Err("IDLE_AUTHORITY_REFUSED");
        }
    }
    let groups = tx.query("SELECT rolname::text,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
        FROM pg_catalog.pg_roles WHERE rolname<>session_user AND pg_catalog.pg_has_role(session_user,oid,'MEMBER') ORDER BY rolname", &[])
        .map_err(|_| "IDLE_QUERY_REFUSED")?;
    if groups.len() != 1
        || groups[0]
            .try_get::<_, String>(0)
            .map_err(|_| "IDLE_QUERY_REFUSED")?
            != GROUP
    {
        return Err("IDLE_AUTHORITY_REFUSED");
    }
    for i in 1..7 {
        if groups[0]
            .try_get::<_, bool>(i)
            .map_err(|_| "IDLE_QUERY_REFUSED")?
        {
            return Err("IDLE_AUTHORITY_REFUSED");
        }
    }
    let rights = tx.query_one("SELECT
        pg_catalog.pg_has_role(session_user,$1,'USAGE'),
        EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND
          (pg_catalog.has_table_privilege(session_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR
           pg_catalog.has_any_column_privilege(session_user,c.oid,'INSERT,UPDATE'))),
        EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND pg_catalog.starts_with(p.proname::text,'pc_') AND pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE'))",
        &[&GROUP]).map_err(|_| "IDLE_QUERY_REFUSED")?;
    if !rights
        .try_get::<_, bool>(0)
        .map_err(|_| "IDLE_QUERY_REFUSED")?
        || rights
            .try_get::<_, bool>(1)
            .map_err(|_| "IDLE_QUERY_REFUSED")?
        || rights
            .try_get::<_, bool>(2)
            .map_err(|_| "IDLE_QUERY_REFUSED")?
    {
        return Err("IDLE_AUTHORITY_REFUSED");
    }
    tx.rollback().map_err(|_| "IDLE_QUERY_REFUSED")
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let once = args == ["--check"];
    if !args.is_empty() && !once {
        return Err("IDLE_COMMAND_REFUSED");
    }
    let mut client = connection()?;
    loop {
        verify(&mut client)?;
        println!("COORDINATOR_IDLE_VERIFIED");
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(60));
    }
}

fn main() {
    if let Err(code) = run() {
        eprintln!("{code}");
        std::process::exit(1);
    }
}
