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

// These tests share process-named database/logins and cluster-wide migration
// roles. Hold the lock through teardown, not just through migration setup.
static MIGRATED: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Migrated {
    _exclusive: std::sync::MutexGuard<'static, ()>,
    admin: postgres::Config,
    name: String,
    app: String,
    writer: String,
}

impl Migrated {
    fn new() -> Self {
        let exclusive = MIGRATED.lock().unwrap_or_else(|e| e.into_inner());
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
            _exclusive: exclusive,
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
            .query_one(
                "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
                &[],
            )
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
        self.writer_families(scope, config, &[(contract::FAMILY, wire)])
    }

    fn writer_families(&self, scope: &str, config: Value, families: &[(&str, &str)]) -> String {
        let (job, run_id, owner, attempt) = (
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
        );
        let key = format!("topic-map-{job}");
        let sha = hex(&Sha256::digest(key.as_bytes()));
        let mut ex = self.connect(&self.writer);
        let one = |ex: &mut Client,
                   sql: &str,
                   args: &[&(dyn postgres::types::ToSql + Sync)]|
         -> Value { ex.query_one(sql, args).unwrap().get(0) };
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
        for (family, wire) in families {
            let wire = wire.replace(JOB, &job.to_string());
            let put = one(
                &mut ex,
                "SELECT pd_result_put_family($1,$2,$3,$4,$5,$6,$7)",
                &[&ENV, &job, &owner, &attempt, &epoch, family, &wire],
            );
            assert_eq!(
                put["sha256"],
                hex(&Sha256::digest(wire.as_bytes())),
                "{put}"
            );
        }
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
        eprintln!(
            "applying login inherits polis_queue_owner={} polis_queue_executor={}",
            reach.0, reach.1
        );
        assert!(
            reach.0,
            "the chain makes its applier a member of polis_queue_owner"
        );
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
            let out =
                crate::dispatch(app.clone(), None, with(&format!("{url}&list=jobs"), &[])).await;
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
#[path = "review_topic_map_support.rs"]
mod review_support;

#[test]
fn review_real_worker_to_route() {
    use polis_topic_map::{derived, stored as store, worker};
    let db = Migrated::new();
    db.connect(&db.app)
        .batch_execute(&format!(
            "INSERT INTO users(uid,hname) VALUES(1,'generated owner');
         INSERT INTO conversations(zid,owner,topic) VALUES({ZID},1,'generated');
         INSERT INTO reports(report_id,zid) VALUES('{REPORT}',{ZID});"
        ))
        .unwrap();
    let run = review_support::run("biodiversity", ZID as i64, None);
    let x = db.writer_families(
        "delphi",
        json!({"selection":"participant_visible/1"}),
        &[
            (store::POSITIONS, &run.positions),
            (store::ASSIGNMENTS, &run.assignments),
            (store::NAMES, &run.names),
        ],
    );
    let request = derived::Request {
        operation: derived::Operation::TopicMap,
        version: 1,
        env: ENV.into(),
        source_job_id: x.clone(),
        conversation_id: ZID,
        selection: Some("participant_visible/1".into()),
        inputs_sha256: None,
        asker: "test".into(),
    };
    let admission = derived::admit(
        &mut db.connect(&db.writer),
        |k| (k == derived::SWITCH).then(|| "1".into()),
        &request,
        &"c".repeat(40),
    )
    .unwrap();
    let y = match admission {
        derived::Admission::Enqueued(a) => a.job_id,
        a => panic!("{a:?}"),
    };
    let make_app = || {
        let mut app = super::app();
        app.delphi_topic_map_db = Some(crate::db::Pool::new(
            Connector::Plain(Box::new(db.config(&db.name, &db.app))),
            pool_limits(),
        ));
        app.delphi_topic_map_auth_db = Some(crate::db::Pool::new(
            Connector::Plain(Box::new(db.config(&db.name, &db.app))),
            auth_pool_limits(),
        ));
        app.delphi_topic_map_env = ENV.into();
        app.delphi_topic_map_derived = true;
        Arc::new(app)
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let url = format!("/api/v3/delphi/topicMap?report_id={REPORT}&job_id={x}");
    let out = rt.block_on(crate::dispatch(make_app(), None, with(&url, &[])));
    assert_eq!(out.status, 200, "{}", text(&out));
    assert_eq!(
        serde_json::from_str::<Value>(&text(&out)).unwrap()["reason"],
        "map_pending"
    );
    let dsn = db.url(&db.writer);
    let get = move |k: &str| match k {
        "QUEUE_DATABASE_URL" => Some(dsn.clone()),
        "POLIS_JOBS_TRANSPORT" => Some("loopback".into()),
        _ => None,
    };
    let mut w = worker::Worker::new(worker::Config {
        env: ENV.into(),
        connector: Arc::new(worker::connector(&get).unwrap()),
        reader: Box::new(move |deadline| {
            worker::connector(&get)
                .unwrap()
                .connect_bounded(deadline, std::time::Duration::from_secs(30))
                .map_err(|e| e.to_string())
        }),
        lease_seconds: 60,
        bounds: worker::Bounds::default(),
    })
    .unwrap();
    let pass = w.pass().unwrap();
    eprintln!("worker {pass:?}");
    assert!(
        matches!(pass,worker::Pass::Stored{ref outcome,ref finalize,..} if outcome=="map" && finalize=="succeeded")
    );
    let app = make_app();
    let out = rt.block_on(crate::dispatch(app.clone(), None, with(&url, &[])));
    eprintln!(
        "real worker route status={} body_prefix={}",
        out.status,
        text(&out).chars().take(160).collect::<String>()
    );
    assert_eq!(out.status, 200, "{}", text(&out));
    assert_eq!(header(&out, contract::HEADER_JOB), Some(x.as_str()));
    assert_eq!(header(&out, contract::HEADER_MADE_BY), Some(y.as_str()));
    let doc: Value = serde_json::from_str(&text(&out)).unwrap();
    assert!(doc.get("reason").is_none(), "{doc}");
    let default = rt.block_on(crate::dispatch(
        app.clone(),
        None,
        with(&format!("/api/v3/delphi/topicMap?report_id={REPORT}"), &[]),
    ));
    assert_eq!(default.status, 200);
    assert_eq!(bytes(&default), bytes(&out));
    assert_eq!(header(&default, contract::HEADER_JOB), Some(x.as_str()));
    let list = rt.block_on(crate::dispatch(
        app.clone(),
        None,
        with(
            &format!("/api/v3/delphi/topicMap?report_id={REPORT}&list=jobs"),
            &[],
        ),
    ));
    eprintln!("real worker list {}", text(&list));
    let listed: Value = serde_json::from_str(&text(&list)).unwrap();
    assert_eq!(listed["jobs"][0]["current"], true);
    assert_eq!(listed["jobs"][0]["map"]["job_id"], y);
    // Query plan under the real views, at successively larger histories.
    let mut owner = db.connect(&db.app);
    for n in [1000i32, 10000] {
        owner.execute("INSERT INTO delphi_jobs(job_id,env,zid,kind,origin,status,config_effective) SELECT gen_random_uuid(),$1,$2,'full_pipeline','legacy_import','succeeded','{}' FROM generate_series(1,$3)",&[&ENV,&ZID,&n]).unwrap();
        owner.batch_execute("ANALYZE delphi_jobs").unwrap();
        let key = derived::key(derived::Operation::TopicMap, 1, ENV, &x);
        let ids = vec![x.clone()];
        let keys = vec![key.clone()];
        let plan = owner
            .query(REVIEW_PLAN, &[&ENV, &ZID, &ids, &keys, &ZID.to_string()])
            .unwrap();
        for row in plan {
            eprintln!("PLAN added={n} {}", row.get::<_, String>(0));
        }
    }
    owner.execute("UPDATE delphi_jobs SET kind='derived',config_effective=jsonb_build_object('derived',jsonb_build_object('key',encode(sha256(convert_to(job_id::text,'UTF8')),'hex'),'source',jsonb_build_object('job_id',job_id::text))) WHERE origin='legacy_import'",&[]).unwrap();
    owner.batch_execute("ANALYZE delphi_jobs").unwrap();
    let mut ids = vec![x.clone()];
    ids.extend((0..50).map(|_| uuid::Uuid::new_v4().to_string()));
    let keys: Vec<String> = ids
        .iter()
        .map(|id| derived::key(derived::Operation::TopicMap, 1, ENV, id))
        .collect();
    for row in owner
        .query(REVIEW_PLAN, &[&ENV, &ZID, &ids, &keys, &ZID.to_string()])
        .unwrap()
    {
        eprintln!("PLAN derived_history {}", row.get::<_, String>(0));
    }
    // The exact lookup the route makes, at the same history, for the same 51 runs.
    let aliases: Vec<String> = keys.iter().map(|k| format!("derived/1:{k}")).collect();
    let scopes: Vec<String> = keys.iter().map(|k| format!("derived:{k}")).collect();
    let explain = format!(
        "EXPLAIN (ANALYZE, BUFFERS) {}",
        crate::delphi_topic_map::PRODUCERS
    );
    for row in owner
        .query(
            &explain,
            &[&ENV, &ZID, &ids, &keys, &aliases, &scopes, &ZID.to_string()],
        )
        .unwrap()
    {
        eprintln!("PLAN exact_list {}", row.get::<_, String>(0));
    }
    let mut ex = db.connect(&db.writer);
    let alias = format!(
        "derived/1:{}",
        derived::key(derived::Operation::TopicMap, 1, ENV, &x)
    );
    assert!(
        ex.query(
            "SELECT job_id FROM delphi_job_aliases WHERE public_id=$1",
            &[&alias]
        )
        .is_err()
    );
    owner.batch_execute("GRANT SELECT(public_id,job_id,source) ON public.delphi_job_aliases TO polis_queue_executor").unwrap();
    let exact=ex.query_one("SELECT j.job_id FROM public.delphi_job_aliases a JOIN public.delphi_result_jobs j ON j.job_id=a.job_id::text WHERE a.public_id=$1 AND a.source='derived' AND j.env=$2 AND j.conversation_id=$3 AND j.job_type='derived' AND j.job_config->'derived'->'source'->>'job_id'=$4",&[&alias,&ENV,&ZID.to_string(),&x]).unwrap().get::<_,String>(0);
    assert_eq!(exact, y);
    eprintln!("exact alias grant lookup returned expected producer");
    for row in ex.query("EXPLAIN (ANALYZE, BUFFERS) SELECT job_id FROM delphi_job_aliases WHERE public_id=$1 AND source='derived'",&[&alias]).unwrap(){eprintln!("PLAN exact {}",row.get::<_,String>(0));}
    // Existing lookup RPC is callable read-only, but introduces an advisory lock.
    let mut c = db.connect(&db.writer);
    c.batch_execute("BEGIN READ ONLY").unwrap();
    let lookup: Value = c
        .query_one(
            "SELECT pd_derived_admit($1,$2,$3::text::uuid,$4,NULL,NULL)",
            &[
                &ENV,
                &derived::key(derived::Operation::TopicMap, 1, ENV, &x),
                &x,
                &ZID,
            ],
        )
        .unwrap()
        .get(0);
    let locks: i64 = c
        .query_one(
            "SELECT count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'",
            &[],
        )
        .unwrap()
        .get(0);
    eprintln!(
        "read-only existing RPC outcome={} advisory_locks={locks}",
        lookup["outcome"]
    );
    c.batch_execute("ROLLBACK").unwrap();
    drop(w);
}

const REVIEW_PLAN: &str = r#"EXPLAIN (ANALYZE, BUFFERS) WITH s AS (SELECT * FROM unnest($3::text[],$4::text[]) AS s(source,key)),          j AS (SELECT s.source, s.key, j.job_id, j.status,                 j.job_config->'derived'->'source'->>'job_id' AS made_from                FROM public.delphi_result_jobs j JOIN s ON j.job_config->'derived'->>'key'=s.key                WHERE j.env=$1 AND j.conversation_id=$5 AND j.job_type='derived')          SELECT j.source, j.job_id, j.status, j.made_from,           (SELECT p.artifact_id::text FROM public.delphi_result_publications p            WHERE p.env=$1 AND p.zid=$2 AND p.scope_key='derived:'||j.key AND p.job_id=j.job_id LIMIT 1)          FROM j"#;
