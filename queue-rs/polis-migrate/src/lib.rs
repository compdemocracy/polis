//! One migration history, one connection and one database advisory lock.
//! SQL files remain immutable; only their optional outer BEGIN/COMMIT is removed.
mod indexes;
mod sql;
use anyhow::{Context, Result, bail, ensure};
use postgres::{
    Client, GenericClient,
    config::{Host, SslMode},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

pub struct Migration {
    pub name: String,
    pub checksum: String,
    pub body: String,
    pub retired: bool,
}
// Fixed database-wide key, shared by apply/reconcile. A different DB has its own lock.
pub const LOCK: i64 = 0x506f6c69734d6967;
const HISTORY: &str = "CREATE TABLE public.migrations (
 name text PRIMARY KEY, checksum text NOT NULL CHECK(length(checksum)=64),
 status text NOT NULL CHECK(status IN ('APPLIED','ADOPTED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_by text NOT NULL DEFAULT session_user,
 legacy_completed_at bigint[] NOT NULL DEFAULT '{}');
 REVOKE ALL ON public.migrations FROM PUBLIC;
 GRANT SELECT ON public.migrations TO PUBLIC;";

pub fn load(dir: &Path) -> Result<Vec<Migration>> {
    let mut files = BTreeMap::new();
    let mut versions = std::collections::BTreeSet::new();
    let selected = manifest(dir, "release.txt")?;
    let held = manifest(dir, "held.txt")?;
    ensure!(
        selected.is_disjoint(&held),
        "release and held manifests overlap"
    );
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("non-UTF8 migration name"))?;
        if !name.ends_with(".sql") {
            continue;
        }
        ensure!(
            entry.file_type()?.is_file(),
            "migration must be a regular file: {name}"
        );
        ensure!(
            name.len() > 11
                && name.as_bytes()[..6].iter().all(u8::is_ascii_digit)
                && name.as_bytes()[6] == b'_'
                && name.as_bytes()[7..name.len() - 4]
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'_'),
            "invalid migration name: {name}"
        );
        ensure!(
            versions.insert(name[..6].to_owned()),
            "duplicate migration number: {name}"
        );
        let source = fs::read_to_string(entry.path())?;
        files.insert(
            name.clone(),
            Migration {
                name: name.clone(),
                checksum: format!("{:x}", Sha256::digest(source.as_bytes())),
                body: sql::body(&source)?,
                retired: matches!(&name[..6], "000004" | "000005" | "000007"),
            },
        );
    }
    for name in selected.iter().chain(&held) {
        ensure!(
            files.contains_key(name),
            "manifest migration is missing: {name}"
        );
    }
    for name in files.keys() {
        ensure!(
            selected.contains(name) || held.contains(name),
            "migration absent from release/held manifest: {name}"
        );
    }
    let migrations: Vec<_> = files
        .into_values()
        .filter(|m| selected.contains(&m.name))
        .collect();
    ensure!(
        migrations
            .first()
            .is_some_and(|m| m.name == "000000_initial.sql"),
        "missing initial migration"
    );
    Ok(migrations)
}

fn manifest(dir: &Path, file: &str) -> Result<std::collections::BTreeSet<String>> {
    let text = fs::read_to_string(dir.join(file)).with_context(|| format!("read {file}"))?;
    let mut names = std::collections::BTreeSet::new();
    for name in text
        .lines()
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
    {
        ensure!(
            name.len() > 11
                && name.as_bytes()[..6].iter().all(u8::is_ascii_digit)
                && name.as_bytes()[6] == b'_'
                && name.ends_with(".sql")
                && name.as_bytes()[7..name.len() - 4]
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'_'),
            "invalid migration in {file}: {name}"
        );
        ensure!(
            names.insert(name.to_owned()),
            "duplicate migration in {file}: {name}"
        );
    }
    Ok(names)
}

// Retired historical DDL is never executable, even on a fresh installation.
// Check catalog absence directly; no temporary functions or user-data reads.
fn retired_absent(client: &mut impl GenericClient, m: &Migration) -> Result<bool> {
    let (tables, columns): (&[&str], &[(&str, &str)]) = match &m.name[..6] {
        "000004" => (&["waitinglist"], &[]),
        "000005" => (
            &[
                "slack_oauth_access_tokens",
                "slack_users",
                "slack_user_invites",
                "slack_bot_events",
                "stripe_accounts",
                "stripe_subscriptions",
                "coupons_for_free_upgrades",
                "lti_users",
                "lti_context_memberships",
                "canvas_assignment_callback_info",
                "canvas_assignment_conversation_info",
                "lti_oauthv1_credentials",
            ],
            &[
                ("conversations", "is_slack"),
                ("conversations", "lti_users_only"),
                ("users", "plan"),
            ],
        ),
        "000007" => (
            &["geolocation_cache"],
            &[
                ("participants_extended", "country_code_iso"),
                ("participants_extended", "encrypted_maxmind_response_city"),
                ("participants_extended", "ip_address"),
                ("participants_extended", "latitude"),
                ("participants_extended", "location"),
                ("participants_extended", "longitude"),
                ("participants_extended", "x_forwarded_for"),
            ],
        ),
        _ => bail!("not a retired migration: {}", m.name),
    };
    for table in tables {
        if exists(client, &format!("public.{table}"))? {
            return Ok(false);
        }
    }
    for (table, column) in columns {
        let present: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.' || $1) AND attname=$2 AND attnum>0 AND NOT attisdropped)", &[table, column])?.get(0);
        if present {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn connect(dsn: &str) -> Result<Client> {
    let mut cfg: postgres::Config = dsn
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid DATABASE_URL"))?;
    cfg.connect_timeout(Duration::from_secs(10))
        .application_name("polis-migrate");
    ensure!(
        !cfg.get_hosts().is_empty() && cfg.get_hostaddrs().is_empty(),
        "DATABASE_URL must name a host and cannot use hostaddr"
    );
    if cfg.get_ssl_mode() == SslMode::Disable {
        // Docker-local tests may use service DNS; remote plaintext is never implicit.
        ensure!(
            std::env::var("POLIS_MIGRATE_ALLOW_PLAINTEXT").as_deref() == Ok("local")
                || cfg.get_hosts().iter().all(|h| match h {
                    Host::Tcp(h) => h.parse::<std::net::IpAddr>().is_ok_and(|a| a.is_loopback()),
                    #[cfg(unix)]
                    Host::Unix(p) => p.is_absolute(),
                }),
            "plaintext requires loopback/socket or explicit POLIS_MIGRATE_ALLOW_PLAINTEXT=local"
        );
        cfg.connect(postgres::NoTls)
            .context("connect to migration database")
    } else {
        // require encryption and validate hostname + certificate even with sslmode=require.
        cfg.ssl_mode(SslMode::Require);
        let mut tls = native_tls::TlsConnector::builder();
        if let Ok(path) = std::env::var("POLIS_MIGRATE_CA_FILE") {
            let bytes = fs::read(path).context("read migration CA file")?;
            // RDS and local CA bundles can contain several certificates.
            for pem in String::from_utf8(bytes)?.split_inclusive("-----END CERTIFICATE-----") {
                if pem.contains("-----BEGIN CERTIFICATE-----") {
                    tls.add_root_certificate(native_tls::Certificate::from_pem(pem.as_bytes())?);
                }
            }
        }
        cfg.connect(postgres_native_tls::MakeTlsConnector::new(tls.build()?))
            .context("connect to migration database (verified TLS)")
    }
}

fn setup(client: &mut Client) -> Result<()> {
    let version: i32 = client
        .query_one("SELECT current_setting('server_version_num')::integer", &[])?
        .get(0);
    ensure!(version >= 170000, "PostgreSQL 17 or newer is required");
    client.batch_execute("SET standard_conforming_strings=on; SET search_path=pg_catalog,public; SET statement_timeout='5min'; SET lock_timeout='5s'; SET idle_in_transaction_session_timeout='30s'; SET transaction_timeout='5min';")?;
    Ok(())
}
fn exists(client: &mut impl GenericClient, name: &str) -> Result<bool> {
    Ok(client
        .query_one("SELECT to_regclass($1) IS NOT NULL", &[&name])?
        .get(0))
}
fn history(
    client: &mut impl GenericClient,
    migrations: &[Migration],
) -> Result<BTreeMap<String, String>> {
    ensure!(
        exists(client, "public.migrations")?,
        "migration history missing; run polis-migrate apply for a fresh database, or reconcile for an existing database (docs/migrations.md)"
    );
    let rows = client
        .query(
            "SELECT name, checksum, status FROM public.migrations ORDER BY name",
            &[],
        )
        .context("unreconciled legacy history; run polis-migrate reconcile")?;
    let mut result = BTreeMap::new();
    for row in rows {
        let name: String = row.get(0);
        let checksum: String = row.get(1);
        let status: String = row.get(2);
        ensure!(
            matches!(status.as_str(), "APPLIED" | "ADOPTED"),
            "unverified history: {name}"
        );
        let m = migrations.iter().find(|m| m.name == name).ok_or_else(|| {
            anyhow::anyhow!("history names migration absent from this release: {name}")
        })?;
        ensure!(
            checksum == m.checksum,
            "migration checksum mismatch: {name}; restore the released source; do not replay it"
        );
        ensure!(
            result.insert(name.clone(), checksum).is_none(),
            "duplicate history: {name}"
        );
    }
    Ok(result)
}
pub fn check(client: &mut Client, migrations: &[Migration]) -> Result<()> {
    setup(client)?;
    let mut tx = client.build_transaction().read_only(true).start()?;
    let applied = history(&mut tx, migrations)?;
    let pending: Vec<_> = migrations
        .iter()
        .filter(|m| !applied.contains_key(&m.name))
        .map(|m| m.name.as_str())
        .collect();
    ensure!(
        pending.is_empty(),
        "pending migrations: {}; run polis-migrate apply before starting the server",
        pending.join(", ")
    );
    tx.commit()?;
    println!("migration check: {} ready", migrations.len());
    Ok(())
}
fn lock(client: &mut Client) -> Result<()> {
    setup(client)?;
    // A blocking SELECT pg_advisory_lock retains a snapshot while waiting.
    // CREATE INDEX CONCURRENTLY in the holder can wait for that same snapshot,
    // deadlocking two runners. Each try returns before the bounded client wait,
    // so no server statement/snapshot is held by the waiting runner.
    println!("waiting for migration lock");
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    loop {
        let acquired: bool = client
            .query_one("SELECT pg_try_advisory_lock($1)", &[&LOCK])?
            .get(0);
        if acquired {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "timed out waiting for migration lock; another runner is still active"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("migration lock acquired");
    Ok(())
}
fn record(
    client: &mut impl GenericClient,
    m: &Migration,
    status: &str,
    legacy: &[i64],
) -> Result<()> {
    client.execute("INSERT INTO public.migrations(name,checksum,status,legacy_completed_at) VALUES($1,$2,$3,$4)", &[&m.name,&m.checksum,&status,&legacy])?;
    Ok(())
}
pub fn apply(client: &mut Client, migrations: &[Migration]) -> Result<usize> {
    lock(client)?;
    let count = apply_locked(client, migrations)?;
    client.query_one("SELECT pg_advisory_unlock($1)", &[&LOCK])?;
    Ok(count)
}

fn apply_locked(client: &mut Client, migrations: &[Migration]) -> Result<usize> {
    // Validate history and every pending retirement before CREATE HISTORY or
    // unrelated forward DDL. A refusal leaves the database unchanged.
    let prior = if exists(client, "public.migrations")? {
        history(client, migrations)?
    } else {
        BTreeMap::new()
    };
    for m in migrations
        .iter()
        .filter(|m| m.retired && !prior.contains_key(&m.name))
    {
        ensure!(
            retired_absent(client, m)?,
            "retired migration {} still has removed objects; no changes made; explicit operator review required",
            m.name
        );
    }
    // A no-history populated DB is never treated as a fresh install. Check ALL
    // public relations, not only conversations, before allowing 000000.
    if !exists(client, "public.migrations")? {
        let populated: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f')) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace) OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace AND typtype IN ('e','d'))", &[])?.get(0);
        ensure!(
            !populated,
            "existing database has no history; run reconcile before apply; 000000 will not be replayed"
        );
        client.batch_execute(HISTORY)?;
    }
    let applied = history(client, migrations)?;
    let mut count = 0;
    for m in migrations.iter().filter(|m| !applied.contains_key(&m.name)) {
        if m.name.starts_with("000000_") {
            let existing: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f') AND relname <> 'migrations') OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace) OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace AND typtype IN ('e','d'))", &[])?.get(0);
            ensure!(
                !existing,
                "refusing initial migration on an existing schema; reconcile first"
            );
        }
        if m.name == "000022_add_poll_timestamp_indexes.sql" {
            // Source-bound special execution; never silently reinterpret a new
            // version of this SQL. The original body below still checks both
            // definitions before its history row commits.
            ensure!(
                m.checksum == "14efc95b14787b52d70680ea06cfef020cd2224e82495258fd8eb324501b7b3e",
                "000022 source changed; review the concurrent execution contract"
            );
            indexes::prepare(client)?;
        }
        let mut tx = client.transaction()?;
        tx.batch_execute("SET LOCAL standard_conforming_strings=on; SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5min'; SET LOCAL transaction_timeout='5min';")?;
        let status = if m.retired {
            ensure!(
                retired_absent(&mut tx, m)?,
                "retired migration {} has retained objects; refusing adoption",
                m.name
            );
            "ADOPTED"
        } else {
            tx.batch_execute(&m.body).with_context(|| {
                format!("migration {} failed (transaction not committed)", m.name)
            })?;
            // Restore the login's context after queue scripts SET LOCAL ROLE.
            tx.batch_execute("RESET ROLE; SET LOCAL search_path=pg_catalog,public")?;
            "APPLIED"
        };
        record(&mut tx, m, status, &[])?;
        tx.commit().with_context(|| {
            format!(
                "commit outcome unknown for {}; reconnect and check history before retrying",
                m.name
            )
        })?;
        println!("{status} {}", m.name);
        if status == "APPLIED" {
            count += 1;
        }
    }
    println!("applied {count} migration(s)");
    Ok(count)
}

// Reuse the queue's existing catalog verifiers for older Docker installations.
// Only temporary catalog-reading functions are installed here, never queue DDL.
fn queue_version(tx: &mut impl GenericClient, migrations: &[Migration]) -> Result<u32> {
    let present: bool = tx.query_one("SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND (starts_with(relname,'polis_queue_') OR starts_with(relname,'delphi_'))) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND (starts_with(proname,'pq_') OR starts_with(proname,'pd_')))",&[])?.get(0);
    if !present {
        return Ok(0);
    }
    ensure!(
        exists(tx, "public.polis_queue_install")?,
        "partial queue installation; no adoption committed"
    );
    let mut definitions = 0;
    for m in migrations
        .iter()
        .filter(|m| m.name.starts_with("000019_") || m.name.starts_with("000024_"))
    {
        for statement in sql::statements(&m.body)? {
            if [
                "pq_catalog",
                "pq_assert_catalog",
                "pq_assert_signatures",
                "pq_assert_functions",
                "pd_state",
                "pq3_state",
            ]
            .iter()
            .any(|name| {
                statement.starts_with(&format!("CREATE OR REPLACE FUNCTION pg_temp.{name}("))
            }) {
                tx.batch_execute(&statement)?;
                definitions += 1;
            }
        }
    }
    ensure!(
        definitions == 7,
        "queue adoption verifier definitions changed; review the catalog contract"
    );
    if exists(tx, "public.polis_queue_large_class_install")? {
        ensure!(
            exists(tx, "public.delphi_foundation_install")?,
            "partial queue /3 installation"
        );
        let ok: bool=tx.query_one("SELECT (SELECT count(*)=1 FROM public.polis_queue_large_class_install) AND EXISTS(SELECT 1 FROM public.polis_queue_large_class_install WHERE singleton AND installed=pg_temp.pq3_state()) AND (SELECT count(*)=1 FROM public.delphi_foundation_install) AND (SELECT count(*)=1 AND bool_and(contract_version='polis-queue/3') FROM public.polis_queue_install)",&[])?.get(0);
        ensure!(ok, "queue /3 catalog postconditions fail");
        Ok(24)
    } else if exists(tx, "public.delphi_foundation_install")? {
        let ok: bool=tx.query_one("SELECT (SELECT count(*)=1 FROM public.delphi_foundation_install) AND EXISTS(SELECT 1 FROM public.delphi_foundation_install WHERE singleton AND installed=pg_temp.pd_state()) AND (SELECT count(*)=1 AND bool_and(contract_version='polis-queue/2') FROM public.polis_queue_install)",&[])?.get(0);
        ensure!(ok, "queue /2 catalog postconditions fail");
        Ok(23)
    } else {
        tx.batch_execute("SELECT pg_temp.pq_assert_catalog(false); SELECT pg_temp.pq_assert_signatures(false); SELECT pg_temp.pq_assert_functions(false)").context("queue /1 catalog postconditions fail")?;
        ensure!(
            tx.query_one("SELECT count(*)=1 FROM public.polis_queue_install", &[])?
                .get::<_, bool>(0),
            "queue /1 install record missing"
        );
        Ok(19)
    }
}

/// Adoption is explicitly bounded by the operator, but every file is checked.
/// The missing 19 queue is a known hole in the pre-runner production baseline.
/// Existing queues use their catalog verifiers, never install-row presence alone.
pub fn reconcile(
    client: &mut Client,
    migrations: &[Migration],
    dir: &Path,
    through: &str,
) -> Result<usize> {
    ensure!(
        through.len() == 6 && through.bytes().all(|b| b.is_ascii_digit()),
        "--through requires six digits"
    );
    ensure!(
        migrations.iter().any(|m| &m.name[..6] == through),
        "unknown --through version"
    );
    lock(client)?;
    let count = reconcile_locked(client, migrations, dir, through)?;
    client.query_one("SELECT pg_advisory_unlock($1)", &[&LOCK])?;
    Ok(count)
}

fn reconcile_locked(
    client: &mut Client,
    migrations: &[Migration],
    dir: &Path,
    through: &str,
) -> Result<usize> {
    let mut tx = client.transaction()?;
    let modern = tx.query_one("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='migrations' AND column_name='checksum')", &[])?.get::<_,bool>(0);
    if modern {
        history(&mut tx, migrations)?;
        bail!("history is already reconciled; use apply/check");
    }
    ensure!(
        !exists(&mut tx, "public.schema_migrations")?,
        "another schema_migrations ledger exists; resolve its unverified rows before reconciliation"
    );
    let mut legacy: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    if exists(&mut tx, "public.migrations")? {
        for row in tx.query(
            "SELECT name,completed_at FROM public.migrations ORDER BY name,completed_at",
            &[],
        )? {
            let name: String = row.get(0);
            ensure!(
                migrations
                    .iter()
                    .any(|m| m.name == name && &m.name[..6] <= through),
                "legacy history contains unknown/renamed/later migration {name}; resolve against its catalog, never replay blindly"
            );
            legacy.entry(name).or_default().push(row.get(1));
        }
    }
    // Helpers are transaction-local and contain only catalog reads.
    tx.batch_execute(&fs::read_to_string(dir.join("adoption/helpers.sql"))?)?;
    let queue = queue_version(&mut tx, migrations)?;
    ensure!(
        queue <= through.parse::<u32>()?,
        "queue is newer than --through; select its actual installed version"
    );
    let mut adopted = Vec::new();
    for m in migrations.iter().filter(|m| &m.name[..6] <= through) {
        let number = m.name[..6].parse::<u32>()?;
        if matches!(number, 19 | 23 | 24) {
            if queue >= number {
                adopted.push(m);
            } else {
                ensure!(
                    !legacy.contains_key(&m.name),
                    "legacy queue history row was not verified: {}",
                    m.name
                );
            }
            continue;
        }
        let path = dir.join("adoption").join(&m.name);
        let query = fs::read_to_string(path).with_context(|| {
            format!(
                "no adoption contract for {}; stop and review this existing installation",
                m.name
            )
        })?;
        let ok: bool = tx
            .query_one(&query, &[])
            .with_context(|| format!("catalog check for {}", m.name))?
            .get(0);
        ensure!(
            ok,
            "catalog postconditions fail for {}; no adoption rows committed; inspect schema before retrying",
            m.name
        );
        adopted.push(m);
    }
    for name in legacy.keys() {
        ensure!(
            adopted.iter().any(|m| m.name == *name),
            "legacy row not verified: {name}"
        );
    }
    if exists(&mut tx, "public.migrations")? {
        tx.batch_execute("DROP TABLE public.migrations")?;
    }
    tx.batch_execute(HISTORY)?;
    for m in &adopted {
        record(
            &mut tx,
            m,
            "ADOPTED",
            legacy.get(&m.name).map(Vec::as_slice).unwrap_or(&[]),
        )?;
    }
    tx.commit()?;
    for m in &adopted {
        println!("ADOPTED {}", m.name);
    }
    println!(
        "adopted {} migration(s); no migration SQL replayed",
        adopted.len()
    );
    Ok(adopted.len())
}

/// Release deployment: classify history while holding the same lock as apply.
/// The 000022 bound is this release's reviewed legacy contract, not a guess
/// from a failed apply. Later/partial/unknown schemas must still pass reconcile.
pub fn deploy(client: &mut Client, migrations: &[Migration], dir: &Path) -> Result<()> {
    lock(client)?;
    let modern: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='migrations' AND column_name='checksum')", &[])?.get(0);
    let populated: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f')) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace) OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace AND typtype IN ('e','d'))", &[])?.get(0);
    ensure!(
        !exists(client, "public.schema_migrations")?,
        "another schema_migrations ledger exists; resolve it before deployment"
    );
    if !modern && populated {
        ensure!(
            migrations.iter().any(|m| m.name.starts_with("000022_")),
            "deploy requires the reviewed 000022 adoption bound"
        );
        reconcile_locked(client, migrations, dir, "000022")?;
    }
    apply_locked(client, migrations)?;
    check(client, migrations)?;
    client.query_one("SELECT pg_advisory_unlock($1)", &[&LOCK])?;
    Ok(())
}
