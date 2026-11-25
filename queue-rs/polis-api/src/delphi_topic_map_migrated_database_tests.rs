//! The route on a database built by the release migrations, read with the
//! login that applied them. That is the application's own login where no
//! dedicated topic map login is set: the deploy applies the migrations with
//! `DATABASE_URL`, and Compose gives the route `DATABASE_URL` when
//! `POLIS_API_DELPHI_TOPIC_MAP_DATABASE_URL` is not set.
//!
//! The applying login here is what a managed primary's own login is: it may
//! log in and create roles, owns the database, and is not a superuser. The
//! release chain makes it a member of `polis_queue_owner` (000019), the role
//! that owns the result store's views and functions (000028, 000041); the
//! route reads them, `reports` and `comments` (owned by the login, 000000)
//! with nothing granted for it. The run is written by a second login, a member
//! of `polis_queue_executor` only, as a Delphi daemon writes it, through the
//! release's own functions. Both of the route's pools use the applying login,
//! as they do when no dedicated login is set.
//!
//! Needs `--features db-tests` and POLIS_API_TEST_DATABASE_URL (a superuser
//! URL to a throwaway server that trusts local logins); it creates and drops
//! its own database and logins.
use super::database_tests::{JOB, map_family, stored};
use super::*;
use super::{ZID, bytes, document, get, header, text};
use polis_queue_adapter::jobs::transport::Connector;
use postgres::{Client, NoTls};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ENV: &str = "test";
const REPORT: &str = "r0examplereportid0000";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Migrated {
    admin: postgres::Config,
    name: String,
    app: String,
    writer: String,
}

impl Migrated {
    fn new() -> Self {
        let admin: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
            .unwrap()
            .parse()
            .unwrap();
        let pid = std::process::id();
        let (name, app, writer) = (
            format!("topic_map_migrated_{pid}"),
            format!("topic_map_app_{pid}"),
            format!("topic_map_writer_{pid}"),
        );
        let mut su = admin.connect(NoTls).unwrap();
        // One statement each: DROP and CREATE DATABASE refuse a transaction.
        for sql in [
            format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"),
            format!("DROP ROLE IF EXISTS {writer}"),
            format!("DROP ROLE IF EXISTS {app}"),
            format!("CREATE ROLE {app} LOGIN CREATEROLE"),
            format!("CREATE DATABASE {name} OWNER {app}"),
        ] {
            su.batch_execute(&sql).unwrap();
        }
        // The chain creates cluster roles on its first apply to a server, and
        // a creator holds ADMIN on what it creates, neither inheriting nor
        // SET (PostgreSQL 16 and later). Where an earlier run on this server
        // already created them, give the login exactly that, so the chain's
        // own grants decide the rest, as on a first apply.
        let existing: Vec<String> = su
            .query(
                "SELECT rolname FROM pg_roles WHERE NOT rolcanlogin AND rolname NOT LIKE 'pg\\_%'",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        for role in existing {
            su.batch_execute(&format!(
                "GRANT {role} TO {app} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE"
            ))
            .unwrap();
        }
        let db = Self {
            admin,
            name,
            app,
            writer,
        };
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../server/postgres/migrations");
        let release = polis_migrate::load(&root).unwrap();
        let mut runner = polis_migrate::connect(&db.url(&db.app)).unwrap();
        polis_migrate::apply(&mut runner, &release).unwrap();
        drop(runner);
        let mut owner = db.config(&db.name, &db.app).connect(NoTls).unwrap();
        let super_: bool = owner
            .query_one("SELECT rolsuper FROM pg_roles WHERE rolname=current_user", &[])
            .unwrap()
            .get(0);
        assert!(!super_, "the applying login is not a superuser");
        db.config(&db.name, "postgres")
            .connect(NoTls)
            .unwrap()
            .batch_execute(&format!(
                "CREATE ROLE {} LOGIN; GRANT polis_queue_executor TO {};",
                db.writer, db.writer
            ))
            .unwrap();
        db
    }

    fn config(&self, dbname: &str, user: &str) -> postgres::Config {
        let mut c = self.admin.clone();
        c.dbname(dbname).user(user).password("");
        c
    }

    fn url(&self, user: &str) -> String {
        let host = match &self.admin.get_hosts()[0] {
            postgres::config::Host::Tcp(h) => h.clone(),
            #[allow(unreachable_patterns)]
            _ => "127.0.0.1".into(),
        };
        let port = self.admin.get_ports().first().copied().unwrap_or(5432);
        format!(
            "postgresql://{user}@{host}:{port}/{}?sslmode=disable",
            self.name
        )
    }

    fn connect(&self, user: &str) -> Client {
        self.config(&self.name, user).connect(NoTls).unwrap()
    }

    /// One run through the release's functions with the executor login,
    /// storing `wire` as its map family: admitted, claimed, put, sealed, its
    /// exit confirmed, its manifest logged, finalized and so served.
    fn writer_run(&self, scope: &str, config: Value, wire: &str) -> String {
        let (job, run_id, owner, attempt) = (
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
        );
        let key = format!("topic-map-{job}");
        let sha = hex(&Sha256::digest(key.as_bytes()));
        let mut ex = self.connect(&self.writer);
        let one = |ex: &mut Client, sql: &str, args: &[&(dyn postgres::types::ToSql + Sync)]| -> Value {
            ex.query_one(sql, args).unwrap().get(0)
        };
        let reply = one(
            &mut ex,
            "SELECT pd_writer_admit($1,$2,$3,'generated-test',$4,$5,$6,$7,'delphi_full_pipeline',NULL,$8,repeat('b',40))",
            &[&ENV, &ZID, &scope, &key, &sha, &job, &run_id, &config],
        );
        assert_eq!(reply["outcome"], "enqueued", "{reply}");
        let claim = one(
            &mut ex,
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(claim["job_id"], job.to_string().as_str(), "{claim}");
        let epoch: i64 = claim["lease_epoch"]
            .as_i64()
            .unwrap_or_else(|| claim["lease_epoch"].as_str().unwrap().parse().unwrap());
        let wire = wire.replace(JOB, &job.to_string());
        let put = one(
            &mut ex,
            "SELECT pd_result_put_family($1,$2,$3,$4,$5,$6,$7)",
            &[&ENV, &job, &owner, &attempt, &epoch, &contract::FAMILY, &wire],
        );
        assert_eq!(put["sha256"], hex(&Sha256::digest(wire.as_bytes())), "{put}");
        let seal = one(
            &mut ex,
            "SELECT pd_result_seal($1,$2,$3,$4,$5)",
            &[&ENV, &job, &owner, &attempt, &epoch],
        );
        let exit = one(
            &mut ex,
            "SELECT pq_end_attempt($1,$2,$3,$4,$5,'confirm_exit',NULL::text,true)",
            &[&ENV, &job, &owner, &attempt, &epoch],
        );
        assert_eq!(exit["outcome"], "exit_confirmed", "{exit}");
        let manifest = serde_json::to_string(&json!({
            "schema": "polis-jobs.output-manifest/2", "job_id": job.to_string(),
            "attempt_id": attempt.to_string(), "stage": "delphi_full_pipeline", "phase": "run",
            "outcome": "succeeded", "inputs": {}, "outputs": [], "models": {}, "cost": {},
            "results": seal,
        }))
        .unwrap();
        self.connect("postgres")
            .execute(
                "INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES($1,$2,0,'manifest',$3)",
                &[&ENV, &attempt, &manifest],
            )
            .unwrap();
        let done = one(
            &mut ex,
            "SELECT pq_finalize($1,$2,$3,$4,$5,'file:///generated/output-manifest.json',$6)",
            &[
                &ENV,
                &job,
                &owner,
                &attempt,
                &epoch,
                &hex(&Sha256::digest(manifest.as_bytes())),
            ],
        );
        assert_eq!(done["outcome"], "succeeded", "{done}");
        job.to_string()
    }
}

impl Drop for Migrated {
    fn drop(&mut self) {
        if let Ok(mut su) = self.admin.connect(NoTls) {
            let _ = su.batch_execute(&format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                self.name
            ));
            let _ = su.batch_execute(&format!("DROP ROLE IF EXISTS {}", self.writer));
            // The login granted itself the chain's roles; where that keeps it,
            // a throwaway server keeps it too.
            let _ = su.batch_execute(&format!("DROP ROLE IF EXISTS {}", self.app));
        }
    }
}

fn with(target: &str, headers: &[(&str, &str)]) -> Request {
    let mut req = get(target);
    let mut all = vec![("host", "localhost"), ("x-forwarded-proto", "https")];
    all.extend_from_slice(headers);
    req.headers = crate::http::Headers::from_raw(all);
    req
}

#[test]
fn the_login_that_applied_the_migrations_serves_a_stored_map() {
    let db = Migrated::new();
    let map = stored(document(500, "j"));
    {
        let mut c = db.connect(&db.app);
        c.batch_execute(&format!(
            "INSERT INTO users(uid,hname) VALUES(1,'generated topic map owner');
             INSERT INTO conversations(zid,owner,topic) VALUES({ZID},1,'generated topic map proof');
             INSERT INTO reports(report_id,zid) VALUES('{REPORT}',{ZID});"
        ))
        .unwrap();
        // How the login reaches the result store: through the role that owns
        // it, which the chain made it a member of; not through the
        // executor's grants.
        let reach: (bool, bool) = {
            let r = c
                .query_one(
                    "SELECT pg_has_role(current_user,'polis_queue_owner','USAGE'),
                            pg_has_role(current_user,'polis_queue_executor','USAGE')",
                    &[],
                )
                .unwrap();
            (r.get(0), r.get(1))
        };
        eprintln!("applying login inherits polis_queue_owner={} polis_queue_executor={}", reach.0, reach.1);
        assert!(reach.0, "the chain makes its applier a member of polis_queue_owner");
    }
    let job = db.writer_run(
        "delphi",
        json!({"selection": "participant_visible/1"}),
        &map_family(ZID, &map),
    );
    let mut app = super::app();
    let login = Connector::Plain(Box::new(db.config(&db.name, &db.app)));
    app.delphi_topic_map_db = Some(crate::db::Pool::new(login, pool_limits()));
    let login = Connector::Plain(Box::new(db.config(&db.name, &db.app)));
    app.delphi_topic_map_auth_db = Some(crate::db::Pool::new(login, auth_pool_limits()));
    app.delphi_topic_map_env = ENV.into();
    let app = Arc::new(app);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let url = format!("/api/v3/delphi/topicMap?report_id={REPORT}");
            let out = crate::dispatch(
                app.clone(),
                None,
                with(&url, &[("accept-encoding", "gzip")]),
            )
            .await;
            assert_eq!(out.status, 200, "{}", String::from_utf8_lossy(&bytes(&out)));
            assert_eq!(bytes(&out), map.gzip);
            assert_eq!(header(&out, contract::HEADER_JOB), Some(job.as_str()));
            assert_eq!(header(&out, contract::HEADER_SOURCE), Some("served"));
            let out = crate::dispatch(app.clone(), None, with(&url, &[])).await;
            assert_eq!(out.status, 200);
            assert_eq!(text(&out), map.document);
            // The report's runs, newest first: the same login, the same objects.
            let out = crate::dispatch(
                app.clone(),
                None,
                with(&format!("{url}&list=jobs"), &[]),
            )
            .await;
            let body = text(&out);
            assert_eq!(out.status, 200, "{body}");
            assert!(body.contains(&job), "{body}");
            assert_eq!(app.delphi_topic_map.busy(), 0);
        });
    // The route's sessions are read only, whatever the login may write.
    let pool = crate::db::Pool::new(
        Connector::Plain(Box::new(db.config(&db.name, &db.app))),
        pool_limits(),
    );
    let read_only = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(pool.with(|c| {
            Ok(c.query_one("SHOW transaction_read_only", &[])?
                .get::<_, String>(0))
        }))
        .unwrap();
    assert_eq!(read_only, "on");
}
