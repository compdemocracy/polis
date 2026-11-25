//! The backfill command against a real PostgreSQL 17 with the release
//! migration chain: a writer run is admitted, claimed and finalized through
//! the release's own functions, storing the public fixture's three families
//! and the map the pipeline's step makes from them. `polis-topic-map
//! from-run`, reading that stored run with the queue login, writes the same
//! family file byte for byte and says the stored map is the same. A second
//! run of the same conversation under another comment rule stores its own map
//! in its own batch and scope; neither replaces or mixes with the other. A run
//! stored without a map (the step off) gets the map the step would have
//! stored. And a family file of any other shape is refused by the catalog.
//!
//! Needs `--features db-tests` and POLIS_JOBS_TEST_DATABASE_URL (a superuser
//! URL to a throwaway cluster); it creates and drops its own database.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_map::stored::{self, RunIdentity, Wires};
use postgres::{Client, NoTls};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;

const ENV: &str = "shadow-topic-map";

/// The release chain creates cluster-wide roles: two fresh databases
/// migrated at once can race on them, so databases are made one at a time.
static MIGRATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn admin_url() -> String {
    std::env::var("POLIS_JOBS_TEST_DATABASE_URL")
        .expect("POLIS_JOBS_TEST_DATABASE_URL is required with --features db-tests")
}

fn url_for(db: &str, user: &str) -> String {
    let mut config: postgres::Config = admin_url().parse().unwrap();
    config.dbname(db).user(user);
    let host = match &config.get_hosts()[0] {
        postgres::config::Host::Tcp(h) => h.clone(),
        #[allow(unreachable_patterns)]
        _ => "127.0.0.1".into(),
    };
    let port = config.get_ports().first().copied().unwrap_or(5432);
    format!("postgresql://{user}@{host}:{port}/{db}")
}

struct Db {
    name: String,
    login: String,
}

impl Db {
    fn new() -> Self {
        Self::build(None)
    }
    /// A database migrated by the release less every migration whose name
    /// starts with `prefix` (the state just before it).
    fn new_without(prefix: &str) -> Self {
        Self::build(Some(prefix))
    }
    fn build(without: Option<&str>) -> Self {
        let id = Uuid::new_v4().simple().to_string();
        let name = format!("topic_map_{}", &id[..16]);
        let login = format!("topic_map_exec_{}", &id[..12]);
        let _one = MIGRATE.lock().unwrap_or_else(|e| e.into_inner());
        Client::connect(&admin_url(), NoTls)
            .unwrap()
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        let dsn = url_for(&name, "postgres");
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server/postgres/migrations");
        let mut release = polis_migrate::load(&root).unwrap();
        if let Some(prefix) = without {
            release.migrations.retain(|m| !m.name.starts_with(prefix));
        }
        let mut runner = polis_migrate::connect(&format!("{dsn}?sslmode=disable")).unwrap();
        polis_migrate::apply(&mut runner, &release).unwrap();
        drop(runner);
        Client::connect(&dsn, NoTls)
            .unwrap()
            .batch_execute(&format!(
                "CREATE ROLE {login} LOGIN; GRANT polis_queue_executor TO {login};
                 INSERT INTO users(uid,hname) VALUES(1,'generated topic map owner');
                 INSERT INTO conversations(zid,owner,topic) VALUES(1424,1,'generated topic map proof');"
            ))
            .unwrap();
        Db { name, login }
    }
    fn admin(&self) -> Client {
        Client::connect(&url_for(&self.name, "postgres"), NoTls).unwrap()
    }
    fn executor(&self) -> Client {
        Client::connect(&url_for(&self.name, &self.login), NoTls).unwrap()
    }
    fn call(&self, sql: &str, args: &[&(dyn postgres::types::ToSql + Sync)]) -> Value {
        self.executor().query_one(sql, args).unwrap().get(0)
    }

    /// One writer run through the release's functions: admitted under `scope`
    /// with `config`, claimed, its families put and sealed, its exit
    /// confirmed, its manifest logged, finalized. `families` is what the
    /// run's step puts: the three inputs, and the map when `map` is set.
    fn writer_run(
        &self,
        scope: &str,
        config: Value,
        run: &support::Run,
        map: bool,
    ) -> (RunIdentity, Option<String>) {
        let (job, run_id, owner, attempt) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let key = format!("topic-map-{job}");
        let sha = hex(&Sha256::digest(key.as_bytes()));
        let reply = self.call(
            "SELECT pd_writer_admit($1,1424,$2,'generated-test',$3,$4,$5,$6,'delphi_full_pipeline',NULL,$7,repeat('b',40))",
            &[&ENV, &scope, &key, &sha, &job, &run_id, &config],
        );
        assert_eq!(reply["outcome"], "enqueued", "{reply}");
        let claim = self.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(claim["job_id"], job.to_string().as_str(), "{claim}");
        let epoch: i64 = claim["lease_epoch"]
            .as_i64()
            .unwrap_or_else(|| claim["lease_epoch"].as_str().unwrap().parse().unwrap());
        let identity = RunIdentity {
            env: ENV.into(),
            job_id: job.to_string(),
            run_id: run_id.to_string(),
            batch_id: attempt.to_string(),
            conversation_id: 1424,
            scope: scope.into(),
            selection: config["selection"].as_str().map(str::to_owned),
            models: support::models(),
            execution: support::execution(),
        };
        let mut families = vec![
            (stored::POSITIONS, run.positions.clone()),
            (stored::ASSIGNMENTS, run.assignments.clone()),
            (stored::NAMES, run.names.clone()),
        ];
        let made = map.then(|| {
            stored::store(
                &identity,
                &Wires {
                    positions: &run.positions,
                    assignments: &run.assignments,
                    names: &run.names,
                },
            )
            .unwrap()
            .wire
        });
        if let Some(wire) = &made {
            families.push((stored::FAMILY, wire.clone()));
        }
        let mut ex = self.executor();
        for (family, wire) in &families {
            let put: Value = ex
                .query_one(
                    "SELECT pd_result_put_family($1,$2,$3,$4,$5,$6,$7)",
                    &[&ENV, &job, &owner, &attempt, &epoch, family, wire],
                )
                .unwrap()
                .get(0);
            assert_eq!(
                put["sha256"],
                hex(&Sha256::digest(wire.as_bytes())),
                "{family}"
            );
        }
        let seal: Value = ex
            .query_one(
                "SELECT pd_result_seal($1,$2,$3,$4,$5)",
                &[&ENV, &job, &owner, &attempt, &epoch],
            )
            .unwrap()
            .get(0);
        let exit: Value = ex
            .query_one(
                "SELECT pq_end_attempt($1,$2,$3,$4,$5,'confirm_exit',NULL::text,true)",
                &[&ENV, &job, &owner, &attempt, &epoch],
            )
            .unwrap()
            .get(0);
        assert_eq!(exit["outcome"], "exit_confirmed", "{exit}");
        let manifest = serde_json::to_string(&json!({
            "schema": "polis-jobs.output-manifest/2", "job_id": job.to_string(), "attempt_id": attempt.to_string(),
            "stage": "delphi_full_pipeline", "phase": "run", "outcome": "succeeded",
            "inputs": {}, "outputs": [], "models": support::models(), "cost": {}, "results": seal,
        }))
        .unwrap();
        self.admin()
            .execute(
                "INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES($1,$2,0,'manifest',$3)",
                &[&ENV, &attempt, &manifest],
            )
            .unwrap();
        let done: Value = ex
            .query_one(
                "SELECT pq_finalize($1,$2,$3,$4,$5,'file:///generated/output-manifest.json',$6)",
                &[
                    &ENV,
                    &job,
                    &owner,
                    &attempt,
                    &epoch,
                    &hex(&Sha256::digest(manifest.as_bytes())),
                ],
            )
            .unwrap()
            .get(0);
        assert_eq!(done["outcome"], "succeeded", "{done}");
        (identity, made)
    }

    /// `polis-topic-map from-run` with the queue login, as the Delphi daemon
    /// would run it: (exit code, the family file, standard error).
    fn backfill(&self, job: &str) -> (i32, String, String) {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("from-run-{job}"));
        let out = Command::new(env!("CARGO_BIN_EXE_polis-topic-map"))
            .args(["from-run", "--env", ENV, "--job", job, "--out"])
            .arg(&dir)
            .env_clear()
            .env("QUEUE_DATABASE_URL", url_for(&self.name, &self.login))
            .env("POLIS_JOBS_TRANSPORT", "loopback")
            .output()
            .unwrap();
        let wire =
            std::fs::read_to_string(dir.join("Delphi_TopicMapDocument.jsonl")).unwrap_or_default();
        (
            out.status.code().unwrap_or(-1),
            wire,
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }

    fn record(&self, job: &str) -> Value {
        self.call("SELECT pd_run_record($1,$2::text::uuid)", &[&ENV, &job])
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        if let Ok(mut admin) = Client::connect(&admin_url(), NoTls) {
            let _ = admin.batch_execute(&format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE); DROP ROLE IF EXISTS {}",
                self.name, self.login
            ));
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_backfill_writes_the_steps_bytes_for_the_same_stored_run() {
    let db = Db::new();
    let run = support::run("biodiversity", 1424, None);
    let rule = json!({"selection": "participant_visible/1"});
    let (identity, made) = db.writer_run("delphi", rule, &run, true);
    let stored_wire = made.unwrap();

    // The run record lists the map as the run's own, in the run's batch.
    let record = db.record(&identity.job_id);
    let map: Vec<&Value> = record["families"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["family"] == stored::FAMILY)
        .collect();
    assert_eq!(map.len(), 1, "{record}");
    assert_eq!(map[0]["job_id"], identity.job_id.as_str());
    assert_eq!(map[0]["batch_id"], identity.batch_id.as_str());
    assert_eq!(map[0]["scope"], "delphi");
    // The three parts of the map and the run's execution record.
    assert_eq!(map[0]["row_count"], 4);

    let (code, wire, stderr) = db.backfill(&identity.job_id);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        wire, stored_wire,
        "the backfill's family file is the step's"
    );
    assert!(stderr.contains("stored map: the same bytes"), "{stderr}");
}

#[test]
fn two_rules_store_two_maps_in_their_own_batches_and_a_run_without_one_gets_the_steps() {
    let db = Db::new();
    let run = support::run("biodiversity", 1424, None);
    let (visible, visible_map) = db.writer_run(
        "delphi",
        json!({"selection": "participant_visible/1"}),
        &run,
        true,
    );
    let (all, all_map) = db.writer_run(
        "delphi:all_comments",
        json!({"selection": "all_comments/1"}),
        &run,
        true,
    );
    let (visible_map, all_map) = (visible_map.unwrap(), all_map.unwrap());
    assert_ne!(visible_map, all_map);
    // Each scope's served map is its own run's, from its own batch.
    let mut admin = db.admin();
    for (identity, wire) in [(&visible, &visible_map), (&all, &all_map)] {
        let served: Value = admin
            .query_one(
                "SELECT pd_result_artifact_wire($1,s.artifact_id,$3) FROM delphi_graph_served s \
                 WHERE s.env=$1 AND s.zid=1424 AND s.scope_key=$2",
                &[&ENV, &identity.scope, &stored::FAMILY],
            )
            .unwrap()
            .get(0);
        assert_eq!(served["wire"], wire.as_str(), "{}", identity.scope);
        assert_eq!(served["batch_id"], identity.batch_id.as_str());
        let doc: Value = serde_json::from_str(
            serde_json::from_str::<Value>(wire.lines().nth(1).unwrap()).unwrap()["body"]["S"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(doc["provenance"]["scope"], identity.scope.as_str());
        assert_eq!(doc["provenance"]["jobId"], identity.job_id.as_str());
    }

    // A later run in the first scope with the step off stores no map: its own
    // batch holds none, and the record names the earlier run as the map's
    // producer, which the backfill does not take for this run's.
    let (later, none) = db.writer_run(
        "delphi",
        json!({"selection": "participant_visible/1"}),
        &run,
        false,
    );
    assert!(none.is_none());
    let own: Option<Value> = admin
        .query_one(
            "SELECT pd_result_artifact_wire($1,a.artifact_id,$3) FROM delphi_artifacts a \
             WHERE a.env=$1 AND a.job_id=$2::text::uuid AND a.output_role='result'",
            &[&ENV, &later.job_id, &stored::FAMILY],
        )
        .unwrap()
        .get(0);
    assert!(own.is_none(), "{own:?}");
    let carried: Vec<Value> = db.record(&later.job_id)["families"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["family"] == stored::FAMILY)
        .cloned()
        .collect();
    assert_eq!(carried.len(), 1);
    assert_eq!(carried[0]["job_id"], visible.job_id.as_str());
    let (code, wire, stderr) = db.backfill(&later.job_id);
    assert_eq!(code, 0, "{stderr}");
    assert!(stderr.contains("stored map: none"), "{stderr}");
    // A run stored without its map recorded no execution with it: the
    // backfill says so rather than guess.
    let later = RunIdentity {
        execution: stored::execution_unavailable(polis_topic_map::from_run::BEFORE_THE_STEP),
        ..later
    };
    let expected = stored::store(
        &later,
        &Wires {
            positions: &run.positions,
            assignments: &run.assignments,
            names: &run.names,
        },
    )
    .unwrap();
    assert_eq!(wire, expected.wire);
}

#[test]
fn the_catalog_refuses_the_family_under_another_key() {
    let db = Db::new();
    let job = Uuid::new_v4();
    let (owner, attempt) = (Uuid::new_v4(), Uuid::new_v4());
    let reply = db.call(
        "SELECT pd_writer_admit($1,1424,'delphi','generated-test',$2,repeat('c',64),$3,gen_random_uuid(),'delphi_full_pipeline',NULL,'{}'::jsonb,repeat('b',40))",
        &[&ENV, &job.to_string(), &job],
    );
    assert_eq!(reply["outcome"], "enqueued", "{reply}");
    let claim = db.call(
        "SELECT pq_claim($1,1::smallint,$2,$3,60,'delphi')",
        &[&ENV, &owner, &attempt],
    );
    let epoch: i64 = claim["lease_epoch"].as_i64().unwrap_or(1);
    let wrong = "{\"codec\":\"delphi-storage-codec/1\",\"family\":\"Delphi_TopicMapDocument\",\"key\":[\"conversation_id\"]}\n";
    let err = db
        .executor()
        .query_one(
            "SELECT pd_result_put_family($1,$2,$3,$4,$5,'Delphi_TopicMapDocument',$6)",
            &[&ENV, &job, &owner, &attempt, &epoch, &wrong],
        )
        .unwrap_err();
    assert!(
        err.to_string().contains("invalid result codec header")
            || format!("{err:?}").contains("invalid result codec header"),
        "{err:?}"
    );
}

// Derived jobs (migration 000050): one lasting job per key, whoever asks and
// whenever, and a checked source.

mod derived_jobs {
    use super::*;
    use polis_topic_map::derived::{self, Admission, Operation, Refusal, Request};

    const CODE: &str = "cccccccccccccccccccccccccccccccccccccccc";
    const RULE: &str = "participant_visible/1";

    fn on(key: &str) -> Option<String> {
        (key == derived::SWITCH).then(|| "1".into())
    }

    fn request(source: &str, asker: &str) -> Request {
        Request {
            operation: Operation::TopicMap,
            version: 1,
            env: ENV.into(),
            source_job_id: source.into(),
            conversation_id: 1424,
            selection: Some(RULE.into()),
            inputs_sha256: None,
            asker: asker.into(),
        }
    }

    fn source(db: &Db) -> RunIdentity {
        let run = support::run("biodiversity", 1424, None);
        db.writer_run("delphi", json!({ "selection": RULE }), &run, false)
            .0
    }

    fn count(db: &Db) -> i64 {
        db.admin()
            .query_one("SELECT count(*) FROM delphi_jobs WHERE kind='derived'", &[])
            .unwrap()
            .get(0)
    }

    fn job_of(a: &Admission) -> String {
        match a {
            Admission::Enqueued(x) | Admission::Existing(x) => x.job_id.clone(),
            Admission::Refused(r) => panic!("refused: {}", r.word()),
        }
    }

    #[test]
    fn one_job_per_key_for_any_asker_after_a_day_a_restart_or_its_end() {
        let db = Db::new();
        let src = source(&db);
        let mut ex = db.executor();
        let first = derived::admit(&mut ex, on, &request(&src.job_id, "scheduler"), CODE).unwrap();
        let Admission::Enqueued(made) = &first else {
            panic!("{first:?}")
        };
        let job = made.job_id.clone();

        // What the job was made from, in its record and as its declared input.
        let row = db
            .admin()
            .query_one(
                "SELECT d.config_effective, q.stage, q.worker_class, i.producer_job_id::text, i.input_role
                 FROM delphi_jobs d JOIN polis_queue_jobs q USING(env,job_id)
                 JOIN delphi_job_inputs i ON i.consumer_job_id=d.job_id
                 WHERE d.job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        let config: Value = row.get(0);
        assert_eq!(config["derived"]["source"]["job_id"], src.job_id.as_str());
        assert_eq!(config["derived"]["source"]["run_id"], src.run_id.as_str());
        assert_eq!(
            config["derived"]["source"]["batch_id"],
            src.batch_id.as_str()
        );
        assert_eq!(config["derived"]["source"]["selection"], RULE);
        assert_eq!(config["derived"]["key"], made.key.as_str());
        assert_eq!(
            config["result_scope"],
            format!("derived:{}", made.key).as_str()
        );
        assert_eq!(row.get::<_, String>(1), "delphi_derived");
        assert_eq!(row.get::<_, String>(2), "derived");
        assert_eq!(row.get::<_, String>(3), src.job_id);
        assert_eq!(row.get::<_, String>(4), "source");

        // Another asker; then a new connection, as after a restart.
        let again = derived::admit(&mut ex, on, &request(&src.job_id, "operator"), CODE).unwrap();
        assert!(
            matches!(&again, Admission::Existing(a) if a.job_id == job),
            "{again:?}"
        );
        let mut fresh = db.executor();
        let restart =
            derived::admit(&mut fresh, on, &request(&src.job_id, "scheduler"), CODE).unwrap();
        assert!(
            matches!(&restart, Admission::Existing(a) if a.job_id == job),
            "{restart:?}"
        );

        // A day later: every 24-hour request alias has expired.
        db.admin()
            .execute(
                "UPDATE polis_queue_requests SET binding_expires_at=clock_timestamp()-interval '1 hour'",
                &[],
            )
            .unwrap();
        let later = derived::admit(&mut fresh, on, &request(&src.job_id, "later"), CODE).unwrap();
        assert!(
            matches!(&later, Admission::Existing(a) if a.job_id == job),
            "{later:?}"
        );

        // Running, then ended dead: still the same job, never a second.
        let (owner, attempt) = (Uuid::new_v4(), Uuid::new_v4());
        let old_class = db.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(
            old_class["outcome"], "none",
            "a delphi daemon never claims it: {old_class}"
        );
        let claim = db.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'derived')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(claim["job_id"], job.as_str(), "{claim}");
        let running = derived::admit(&mut fresh, on, &request(&src.job_id, "x"), CODE).unwrap();
        assert!(
            matches!(&running, Admission::Existing(a) if a.state == "running"),
            "{running:?}"
        );
        let epoch: i64 = claim["lease_epoch"].as_str().unwrap().parse().unwrap();
        let job_uuid: Uuid = job.parse().unwrap();
        let dead = db.call(
            "SELECT pq_fail($1,$2,$3,$4,$5,true,'generated_failure',true)",
            &[&ENV, &job_uuid, &owner, &attempt, &epoch],
        );
        assert_eq!(dead["state"], "dead", "{dead}");
        let after = derived::admit(&mut fresh, on, &request(&src.job_id, "y"), CODE).unwrap();
        assert!(
            matches!(&after, Admission::Existing(a) if a.job_id == job && a.state == "dead"),
            "{after:?}"
        );

        // Another operation version is another key, and has no executor yet.
        let v2 = Request {
            version: 2,
            ..request(&src.job_id, "y")
        };
        assert_eq!(
            derived::admit(&mut fresh, on, &v2, CODE).unwrap(),
            Admission::Refused(Refusal::OperationVersion)
        );
        assert_ne!(
            derived::key(Operation::TopicMap, 2, ENV, &src.job_id),
            made.key
        );
        assert_eq!(count(&db), 1);
    }

    #[test]
    fn simultaneous_requests_make_one_job() {
        let db = Db::new();
        let src = source(&db);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let jobs: Vec<String> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let (barrier, db, src) = (barrier.clone(), &db, &src);
                    s.spawn(move || {
                        let mut ex = db.executor();
                        barrier.wait();
                        let a = derived::admit(
                            &mut ex,
                            on,
                            &request(&src.job_id, &format!("asker-{i}")),
                            CODE,
                        )
                        .unwrap();
                        job_of(&a)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(jobs.iter().all(|j| j == &jobs[0]), "{jobs:?}");
        assert_eq!(count(&db), 1);
    }

    #[test]
    fn refusals_name_what_is_wrong_and_write_nothing() {
        let db = Db::new();
        let src = source(&db);
        let mut ex = db.executor();
        let refused =
            |ex: &mut Client, req: Request, get: fn(&str) -> Option<String>| match derived::admit(
                ex, get, &req, CODE,
            )
            .unwrap()
            {
                Admission::Refused(r) => r,
                other => panic!("{other:?}"),
            };
        let base = || request(&src.job_id, "t");
        assert_eq!(refused(&mut ex, base(), |_| None), Refusal::SwitchedOff);
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    env: "another-env".into(),
                    ..base()
                },
                on
            ),
            Refusal::SourceEnv
        );
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    conversation_id: 9999,
                    ..base()
                },
                on
            ),
            Refusal::SourceConversation
        );
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    selection: Some("all/1".into()),
                    ..base()
                },
                on
            ),
            Refusal::SourceRule
        );
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    inputs_sha256: Some(vec!["0".repeat(64); 3]),
                    ..base()
                },
                on
            ),
            Refusal::SourceHash
        );
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    source_job_id: Uuid::new_v4().to_string(),
                    ..base()
                },
                on
            ),
            Refusal::SourceMissing
        );
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    source_job_id: "not-a-job".into(),
                    ..base()
                },
                on
            ),
            Refusal::SourceId
        );
        // A source still waiting to run.
        let (queued, run_id) = (Uuid::new_v4(), Uuid::new_v4());
        let reply = db.call(
            "SELECT pd_writer_admit($1,1424,'delphi-queued','generated-test','queued-source',repeat('a',64),$2,$3,'delphi_full_pipeline',NULL,$4,repeat('b',40))",
            &[&ENV, &queued, &run_id, &json!({ "selection": RULE })],
        );
        assert_eq!(reply["outcome"], "enqueued", "{reply}");
        assert_eq!(
            refused(
                &mut ex,
                Request {
                    source_job_id: queued.to_string(),
                    ..base()
                },
                on
            ),
            Refusal::SourceNotSucceeded
        );
        assert_eq!(count(&db), 0);
        // The declared hashes, when right, admit.
        let record = db.record(&src.job_id);
        let plan = polis_topic_map::from_run::plan(ENV, &src.job_id, &record).unwrap();
        let shas = plan.inputs.iter().map(|f| f.sha256.clone()).collect();
        let ok = derived::admit(
            &mut ex,
            on,
            &Request {
                inputs_sha256: Some(shas),
                ..base()
            },
            CODE,
        )
        .unwrap();
        assert!(matches!(ok, Admission::Enqueued(_)), "{ok:?}");
        assert_eq!(count(&db), 1);
    }

    fn file(name: &str) -> String {
        std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../server/postgres/migrations")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn the_down_file_reverses_000050_only_while_no_derived_job_exists() {
        let down = file("down/000050_remove_derived_jobs.sql");
        let with_job = Db::new();
        let src = source(&with_job);
        let mut ex = with_job.executor();
        job_of(&derived::admit(&mut ex, on, &request(&src.job_id, "t"), CODE).unwrap());
        let err = with_job.admin().batch_execute(&down).unwrap_err();
        assert!(format!("{err:?}").contains("derived jobs exist"), "{err:?}");
        assert_eq!(count(&with_job), 1);

        let db = Db::new();
        db.admin().batch_execute(&down).unwrap();
        let gone: Option<String> = db
            .admin()
            .query_one("SELECT to_regprocedure('public.pd_derived_admit(text,text,uuid,integer,jsonb,text)')::text", &[])
            .unwrap()
            .get(0);
        assert_eq!(gone, None);
        let checks: String = db
            .admin()
            .query_one(
                "SELECT string_agg(pg_get_constraintdef(oid),' ' ORDER BY conname) FROM pg_constraint
                 WHERE conrelid IN ('polis_queue_jobs'::regclass,'delphi_jobs'::regclass) AND contype='c'",
                &[],
            )
            .unwrap()
            .get(0);
        assert!(!checks.contains("derived"), "{checks}");
        // The ordinary writer path still works after the reversal, and the
        // forward file applies again.
        source(&db);
        db.admin()
            .batch_execute(&file("000050_add_derived_jobs.sql"))
            .unwrap();
        let src = source(&db);
        let mut ex = db.executor();
        job_of(&derived::admit(&mut ex, on, &request(&src.job_id, "t"), CODE).unwrap());
    }
    #[test]
    fn review_existing_key_checks_rule() {
        let db = Db::new();
        let src = source(&db);
        let mut ex = db.executor();
        job_of(&derived::admit(&mut ex, on, &request(&src.job_id, "first"), CODE).unwrap());
        let mut req = request(&src.job_id, "second");
        req.selection = Some("all/1".into());
        let actual = derived::admit(&mut ex, on, &req, CODE).unwrap();
        assert_eq!(actual, Admission::Refused(Refusal::SourceRule));
    }
    #[test]
    fn review_existing_key_checks_hashes() {
        let db = Db::new();
        let src = source(&db);
        let mut ex = db.executor();
        job_of(&derived::admit(&mut ex, on, &request(&src.job_id, "first"), CODE).unwrap());
        let mut req = request(&src.job_id, "second");
        req.inputs_sha256 = Some(vec!["0".repeat(64); 3]);
        let actual = derived::admit(&mut ex, on, &req, CODE).unwrap();
        assert_eq!(actual, Admission::Refused(Refusal::SourceHash));
    }
}

/// The derived stage's worker against the release chain: it stores the map
/// `from-run` makes, in its own batch, and every way an attempt can end ends
/// in one stored map or one recorded outcome.
mod derived_worker {
    use super::*;
    use polis_topic_map::derived::{self, Admission, Operation, Request};
    use polis_topic_map::from_run;
    use polis_topic_map::worker::{self, CrashAt, Pass, Worker};

    const CODE: &str = "cccccccccccccccccccccccccccccccccccccccc";

    fn on(key: &str) -> Option<String> {
        (key == derived::SWITCH).then(|| "1".into())
    }

    /// A succeeded source run (no map of its own) and its admitted derived job.
    fn admitted(db: &Db, keep: Option<usize>) -> (RunIdentity, String, String) {
        let run = support::run("biodiversity", 1424, keep);
        let (src, _) = db.writer_run("delphi", json!({}), &run, false);
        let req = Request {
            operation: Operation::TopicMap,
            version: 1,
            env: ENV.into(),
            source_job_id: src.job_id.clone(),
            conversation_id: 1424,
            selection: None,
            inputs_sha256: None,
            asker: "test".into(),
        };
        match derived::admit(&mut db.executor(), on, &req, CODE).unwrap() {
            Admission::Enqueued(a) => (src, a.job_id, a.key),
            other => panic!("{other:?}"),
        }
    }

    /// A worker as a fresh process on any box would start it: it has no
    /// directory, journal or box identity, only the queue login.
    fn worker(db: &Db) -> Worker {
        let (url, login) = (url_for(&db.name, &db.login), db.login.clone());
        let get = move |k: &str| match k {
            "QUEUE_DATABASE_URL" => Some(url.clone()),
            "POLIS_JOBS_TRANSPORT" => Some("loopback".into()),
            _ => None,
        };
        let _ = login;
        let connector = worker::connector(&get).unwrap();
        Worker::new(worker::Config {
            env: ENV.into(),
            connector: std::sync::Arc::new(connector),
            reader: Box::new(move |deadline| {
                worker::connector(&get)
                    .unwrap()
                    .connect_bounded(deadline, std::time::Duration::from_secs(30))
                    .map_err(|e| e.to_string())
            }),
            lease_seconds: 60,
            bounds: worker::Bounds::default(),
        })
        .unwrap()
    }

    /// Every family of a job's batches: (batch, family, codec bytes).
    fn families_of(db: &Db, job: &str) -> Vec<(String, String, String)> {
        db.admin()
            .query(
                "SELECT f.batch_id::text, f.family, f.codec_wire FROM delphi_result_families f
                 JOIN delphi_result_batches b USING(env,batch_id)
                 WHERE b.job_id=$1::text::uuid ORDER BY 1,2",
                &[&job],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2)))
            .collect()
    }

    fn count(db: &Db, sql: &str) -> i64 {
        db.admin().query_one(sql, &[]).unwrap().get(0)
    }

    /// The served pointers of a derived scope, with the batch each names.
    fn served(db: &Db, key: &str) -> Vec<String> {
        db.admin()
            .query(
                "SELECT a.attempt_id::text FROM delphi_graph_served s
                 JOIN delphi_artifacts a ON a.env=s.env AND a.artifact_id=s.artifact_id
                 WHERE s.env=$1 AND s.scope_key=$2",
                &[&ENV, &format!("derived:{key}")],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }

    fn owned_by(wire: &str, from: &str, to: &str) -> String {
        wire.replace(
            &format!("\"job_id\":{{\"S\":\"{from}\"}}"),
            &format!("\"job_id\":{{\"S\":\"{to}\"}}"),
        )
    }

    fn state(db: &Db, job: &str) -> (String, Option<String>) {
        let r = db
            .admin()
            .query_one(
                "SELECT state, last_error_code FROM polis_queue_jobs WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        (r.get(0), r.get(1))
    }

    fn make_eligible(db: &Db, job: &str) {
        db.admin()
            .execute(
                "UPDATE polis_queue_jobs SET eligible_at=clock_timestamp()-interval '1 second'
                 WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
    }

    #[test]
    fn the_worker_stores_from_runs_bytes_in_its_own_batch_and_nothing_upstream() {
        let db = Db::new();
        let (src, job, key) = admitted(&db, None);
        let source_before = families_of(&db, &src.job_id);
        let families_before = count(&db, "SELECT count(*) FROM delphi_result_families");
        let rows_before = count(&db, "SELECT count(*) FROM delphi_result_rows");
        let (code, from_run_wire, err) = db.backfill(&src.job_id);
        assert_eq!(code, 0, "{err}");

        let mut w = worker(&db);
        let pass = w.pass().unwrap();
        assert!(
            matches!(&pass, Pass::Stored { outcome, finalize, .. } if outcome == "map" && finalize == "succeeded"),
            "{pass:?}"
        );
        assert_eq!(w.pass().unwrap(), Pass::Idle);
        assert_eq!(state(&db, &job).0, "succeeded");

        // Only the map family, in the derived job's own batch.
        let mine = families_of(&db, &job);
        assert_eq!(
            mine.len(),
            1,
            "{:?}",
            mine.iter().map(|f| &f.1).collect::<Vec<_>>()
        );
        assert_eq!(mine[0].1, stored::FAMILY);
        // The document, gzip and digest are from-run's bytes; only the outer
        // rows' owner differs (four rows: document, gzip, digest, execution).
        assert_eq!(
            from_run_wire
                .matches(&format!("\"job_id\":{{\"S\":\"{}\"}}", src.job_id))
                .count(),
            4
        );
        assert_eq!(owned_by(&from_run_wire, &src.job_id, &job), mine[0].2);
        assert_ne!(from_run_wire, mine[0].2);
        // The source's batch is unchanged and no upstream family was copied.
        assert_eq!(families_of(&db, &src.job_id), source_before);
        assert_eq!(
            count(&db, "SELECT count(*) FROM delphi_result_families"),
            families_before + 1
        );
        assert_eq!(
            count(&db, "SELECT count(*) FROM delphi_result_rows"),
            rows_before + 4
        );
        // Published once, under the derived job's own scope.
        assert_eq!(served(&db, &key), vec![mine[0].0.clone()]);
    }

    #[test]
    fn a_source_with_nothing_to_draw_ends_in_one_stored_no_map() {
        let db = Db::new();
        let (_, job, key) = admitted(&db, Some(2));
        let mut w = worker(&db);
        let pass = w.pass().unwrap();
        assert!(
            matches!(&pass, Pass::Stored { outcome, .. } if outcome == "too_few_comments"),
            "{pass:?}"
        );
        assert_eq!(state(&db, &job).0, "succeeded");
        assert_eq!(w.pass().unwrap(), Pass::Idle);
        let mine = families_of(&db, &job);
        assert_eq!(mine.len(), 1);
        assert!(
            mine[0]
                .2
                .contains("\"reason\":{\"S\":\"too_few_comments\"}")
        );
        assert_eq!(served(&db, &key).len(), 1);
    }

    #[test]
    fn a_changed_source_ends_dead_with_one_word_and_is_never_retried() {
        let db = Db::new();
        let (src, job, _) = admitted(&db, None);
        // A family's digest is tied to its bytes by the table's own CHECK, so
        // the source cannot drift under its record; here the job's recorded
        // digest of the positions disagrees with the source's record.
        let _ = &src;
        db.admin()
            .execute(
                "UPDATE delphi_jobs SET config_effective=jsonb_set(config_effective,
                 '{derived,source,families,0,sha256}',to_jsonb(repeat('0',64)))
                 WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        let mut w = worker(&db);
        let pass = w.pass().unwrap();
        assert!(
            matches!(&pass, Pass::Failed { code, state, .. } if code == "source_changed" && state == "dead"),
            "{pass:?}"
        );
        assert_eq!(w.pass().unwrap(), Pass::Idle);
        assert!(families_of(&db, &job).is_empty());
    }

    #[test]
    fn a_lost_finalize_reply_is_the_same_success() {
        let db = Db::new();
        let (_, job, key) = admitted(&db, None);
        let mut w = worker(&db);
        let pass = w.pass_until(Some(CrashAt::LoseFinalizeReply)).unwrap();
        assert!(
            matches!(&pass, Pass::Stored { finalize, .. } if finalize == "already_succeeded"),
            "{pass:?}"
        );
        assert_eq!(families_of(&db, &job).len(), 1);
        assert_eq!(served(&db, &key).len(), 1);
    }

    /// Expire a job's lease now, by moving the lease's end into the past.
    fn expire(db: &Db, job: &str) {
        db.admin()
            .execute(
                "UPDATE polis_queue_jobs SET locked_until=clock_timestamp()-interval '1 second'
                 WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
    }

    /// The job's current token: (owner, attempt, epoch).
    fn token(db: &Db, job: &str) -> (Uuid, Uuid, i64) {
        let r = db
            .admin()
            .query_one(
                "SELECT owner_id,attempt_id,lease_epoch FROM polis_queue_jobs WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2))
    }

    /// `pq_finalize` under a token, with the manifest that attempt logged.
    fn finalize(db: &Db, job: &str, t: (Uuid, Uuid, i64)) -> Value {
        let sha: Option<String> = db
            .admin()
            .query_opt(
                "SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM polis_queue_logs
                 WHERE attempt_id=$1 AND stream='manifest' LIMIT 1",
                &[&t.1],
            )
            .unwrap()
            .map(|r| r.get(0));
        let job: Uuid = job.parse().unwrap();
        db.call(
            "SELECT pq_finalize($1,$2,$3,$4,$5,$6,$7)",
            &[
                &ENV,
                &job,
                &t.0,
                &t.1,
                &t.2,
                &format!("file://derived/{}/output-manifest.json", t.1),
                &sha.unwrap_or_else(|| "0".repeat(64)),
            ],
        )
    }

    /// A put and a seal under an old token are refused by fencing.
    fn assert_stale_writes_fenced(db: &Db, job: &str, old: (Uuid, Uuid, i64), wire: &str) {
        let job: Uuid = job.parse().unwrap();
        let put = db.executor().query_one(
            "SELECT pd_result_put_family($1,$2,$3,$4,$5,'Delphi_TopicMapDocument',$6)",
            &[&ENV, &job, &old.0, &old.1, &old.2, &wire],
        );
        let seal = db.executor().query_one(
            "SELECT pd_result_seal($1,$2,$3,$4,$5)",
            &[&ENV, &job, &old.0, &old.1, &old.2],
        );
        for err in [put.unwrap_err(), seal.unwrap_err()] {
            assert!(
                format!("{err:?}").contains("result writer fenced"),
                "{err:?}"
            );
        }
    }

    fn unconfirmed(db: &Db, job: &str) -> i64 {
        db.admin()
            .query_one(
                "SELECT count(*) FROM polis_queue_attempts
                 WHERE job_id=$1::text::uuid AND process_exit_confirmed_at IS NULL",
                &[&job],
            )
            .unwrap()
            .get(0)
    }

    /// A worker vanishes after the put, after the seal, or just before
    /// finalize, and nothing of it survives (no file was ever written). Its
    /// lease expires; the reaper ends the attempt as an ordinary retry; a
    /// second worker runs the job again and stores the same bytes in a batch
    /// of its own. The first returns late: its put and seal are refused by
    /// fencing, and when both finalize at once the late one is `fenced` and
    /// the current one `succeeded`; asked again, `already_succeeded`. One
    /// served pointer, naming the winner; no exit proof was given by anyone.
    #[test]
    fn a_vanished_worker_at_each_seam_is_retried_from_the_database_alone() {
        let db = Db::new();
        for crash in [
            CrashAt::AfterPut,
            CrashAt::AfterSeal,
            CrashAt::BeforeFinalize,
        ] {
            let (_, job, key) = admitted(&db, None);
            let mut first = worker(&db);
            assert!(matches!(
                first.pass_until(Some(crash)).unwrap(),
                Pass::Crashed { .. }
            ));
            let old = token(&db, &job);
            expire(&db, &job);
            let mut second = worker(&db);
            second.reap().unwrap();
            assert_eq!(
                state(&db, &job),
                ("retry_wait".into(), Some("lease_expired".into())),
                "{crash:?}"
            );
            make_eligible(&db, &job);
            assert!(matches!(
                second.pass_until(Some(CrashAt::BeforeFinalize)).unwrap(),
                Pass::Crashed { .. }
            ));
            let new = token(&db, &job);
            assert_ne!(old.1, new.1);
            let batches = families_of(&db, &job);
            assert_eq!(batches.len(), 2, "{crash:?}");
            assert_eq!(batches[0].2, batches[1].2, "the same bytes in each batch");
            assert_stale_writes_fenced(&db, &job, old, &batches[0].2);
            let barrier = std::sync::Barrier::new(2);
            let (late, current) = std::thread::scope(|s| {
                let late = s.spawn(|| {
                    barrier.wait();
                    finalize(&db, &job, old)
                });
                barrier.wait();
                let current = finalize(&db, &job, new);
                (late.join().unwrap(), current)
            });
            assert_eq!(late["outcome"], "fenced", "{crash:?} {late}");
            assert_eq!(current["outcome"], "succeeded", "{crash:?} {current}");
            assert_eq!(finalize(&db, &job, new)["outcome"], "already_succeeded");
            assert_eq!(finalize(&db, &job, old)["outcome"], "fenced");
            assert_eq!(served(&db, &key), vec![new.1.to_string()], "{crash:?}");
            let terminal: String = db
                .admin()
                .query_one(
                    "SELECT terminal_attempt_id::text FROM polis_queue_jobs WHERE job_id=$1::text::uuid",
                    &[&job],
                )
                .unwrap()
                .get(0);
            assert_eq!(terminal, new.1.to_string());
            assert_eq!(unconfirmed(&db, &job), 2, "no exit proof was given");
            assert_eq!(second.pass().unwrap(), Pass::Idle);
            assert_eq!(first.pass().unwrap(), Pass::Idle);
        }
    }

    /// The box is gone and a worker starts elsewhere with an empty disk: the
    /// job is picked up without anyone confirming anything. And a worker
    /// restarted on the same box (here the same process, which has no more
    /// to go on than a new one) picks up its own lost attempt the same way.
    #[test]
    fn a_lost_box_or_a_restart_on_the_same_box_needs_no_operator() {
        let db = Db::new();
        // Another box.
        let (_, job, key) = admitted(&db, None);
        let mut a = worker(&db);
        a.pass_until(Some(CrashAt::AfterSeal)).unwrap();
        drop(a);
        expire(&db, &job);
        let mut b = worker(&db);
        b.reap().unwrap();
        make_eligible(&db, &job);
        let pass = b.pass().unwrap();
        assert!(
            matches!(&pass, Pass::Stored { finalize, .. } if finalize == "succeeded"),
            "{pass:?}"
        );
        assert_eq!(served(&db, &key).len(), 1);
        // The same box: the same worker, after its own attempt was lost.
        let (_, job, key) = admitted(&db, None);
        let mut same = worker(&db);
        same.pass_until(Some(CrashAt::AfterPut)).unwrap();
        expire(&db, &job);
        same.reap().unwrap();
        make_eligible(&db, &job);
        let pass = same.pass().unwrap();
        assert!(matches!(&pass, Pass::Stored { .. }), "{pass:?}");
        assert_eq!(served(&db, &key).len(), 1);
        assert_eq!(families_of(&db, &job).len(), 2);
    }

    /// Two workers ask for one job at the same moment: one runs it, the
    /// other finds nothing; one family, one served pointer.
    #[test]
    fn two_workers_racing_for_one_job_store_one_map() {
        let db = Db::new();
        let (_, job, key) = admitted(&db, None);
        let (mut a, mut b) = (worker(&db), worker(&db));
        let barrier = std::sync::Barrier::new(2);
        let (pa, pb) = std::thread::scope(|s| {
            let ta = s.spawn(|| {
                barrier.wait();
                a.pass().unwrap()
            });
            let tb = s.spawn(|| {
                barrier.wait();
                b.pass().unwrap()
            });
            (ta.join().unwrap(), tb.join().unwrap())
        });
        let stored = [&pa, &pb]
            .iter()
            .filter(|p| matches!(p, Pass::Stored { .. }))
            .count();
        assert_eq!(stored, 1, "{pa:?} {pb:?}");
        assert!(pa == Pass::Idle || pb == Pass::Idle, "{pa:?} {pb:?}");
        assert_eq!(families_of(&db, &job).len(), 1);
        assert_eq!(served(&db, &key).len(), 1);
    }

    /// A claim that committed while its reply was lost (the worker went away
    /// without writing anything anywhere): when the lease expires the job is
    /// an ordinary retry and the next worker stores it. Today's code parked
    /// this `exit_unconfirmed` for an operator.
    #[test]
    fn an_abandoned_committed_claim_is_picked_up_after_its_lease() {
        let db = Db::new();
        let (_, job, key) = admitted(&db, None);
        let (owner, attempt) = (Uuid::new_v4(), Uuid::new_v4());
        let committed = db.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'derived')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(committed["job_id"], job.as_str());
        expire(&db, &job);
        let mut w = worker(&db);
        w.reap().unwrap();
        assert_eq!(
            state(&db, &job),
            ("retry_wait".into(), Some("lease_expired".into()))
        );
        make_eligible(&db, &job);
        assert!(matches!(w.pass().unwrap(), Pass::Stored { .. }));
        assert_eq!(served(&db, &key).len(), 1);
    }

    /// An uncertain reply to the claim's COMMIT is settled by the database:
    /// renewing the exact token succeeds when the claim committed (the job
    /// is then run under it), and is fenced when it did not (the job is left
    /// queued and the next claim takes it). No new token is used for a claim
    /// that may have committed, and nothing is read from a file.
    #[test]
    fn an_uncertain_claim_is_settled_by_renewing_its_exact_token() {
        let db = Db::new();
        // Committed: the worker's own owner and attempt, reply kept.
        let (_, job, key) = admitted(&db, None);
        let mut w = worker(&db);
        let owner: Uuid = w.owner.parse().unwrap();
        let attempt = Uuid::new_v4();
        let reply = db.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'derived')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(reply["job_id"], job.as_str());
        let pass = w
            .pass_after_uncertain_claim(&attempt.to_string(), &reply)
            .unwrap();
        assert!(
            matches!(&pass, Pass::Stored { finalize, .. } if finalize == "succeeded"),
            "{pass:?}"
        );
        assert_eq!(served(&db, &key).len(), 1);
        let attempts: i64 = count(
            &db,
            &format!("SELECT count(*) FROM polis_queue_attempts WHERE job_id='{job}'"),
        );
        assert_eq!(attempts, 1, "run under the uncertain claim's own token");

        // Not committed: the same reply, but its transaction rolled back.
        let (_, job, key) = admitted(&db, None);
        let attempt = Uuid::new_v4();
        let mut ex = db.executor();
        let mut tx = ex.transaction().unwrap();
        let reply: Value = tx
            .query_one(
                "SELECT pq_claim($1,1::smallint,$2,$3,60,'derived')",
                &[&ENV, &owner, &attempt],
            )
            .unwrap()
            .get(0);
        tx.rollback().unwrap();
        assert_eq!(reply["job_id"], job.as_str());
        assert_eq!(
            w.pass_after_uncertain_claim(&attempt.to_string(), &reply)
                .unwrap(),
            Pass::Idle
        );
        assert_eq!(state(&db, &job).0, "queued");
        assert!(matches!(w.pass().unwrap(), Pass::Stored { .. }));
        assert_eq!(served(&db, &key).len(), 1);
    }

    /// A derived attempt that fails ends without any exit proof, and a job
    /// whose attempts all expire ends dead once its budget is spent; nothing
    /// parks for an operator.
    #[test]
    fn failures_and_a_spent_budget_end_without_exit_proof() {
        let db = Db::new();
        let (_, job, _) = admitted(&db, None);
        let max: i32 = db
            .admin()
            .query_one(
                "SELECT max_attempts FROM polis_queue_jobs WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap()
            .get(0);
        for _ in 0..max {
            let mut w = worker(&db);
            make_eligible(&db, &job);
            assert!(matches!(
                w.pass_until(Some(CrashAt::AfterPut)).unwrap(),
                Pass::Crashed { .. }
            ));
            expire(&db, &job);
            w.reap().unwrap();
        }
        let (s, code) = state(&db, &job);
        assert_eq!(s, "dead", "{code:?}");
        assert_eq!(unconfirmed(&db, &job), i64::from(max));
        // An ordinary failure, permanent: pq_fail with no proof.
        let (_, job, _) = admitted(&db, None);
        db.admin()
            .execute(
                "UPDATE delphi_jobs SET config_effective=jsonb_set(config_effective,
                 '{derived,source,families,0,sha256}',to_jsonb(repeat('0',64)))
                 WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        let pass = worker(&db).pass().unwrap();
        assert!(
            matches!(&pass, Pass::Failed { state, .. } if state == "dead"),
            "{pass:?}"
        );
        assert_eq!(unconfirmed(&db, &job), 1, "no proof was recorded");
        // Its scope is released: the unconfirmed attempt does not hold it.
        let held: String = db
            .admin()
            .query_one(
                "SELECT scope_key FROM delphi_job_guards WHERE env=$1 AND root_job_id=$2::text::uuid",
                &[&ENV, &job],
            )
            .unwrap()
            .get(0);
        let released: bool = db
            .admin()
            .query_one("SELECT pd_release_scope($1,$2)", &[&ENV, &held])
            .unwrap()
            .get(0);
        assert!(released);
    }

    /// The same functions still protect every other stage exactly as before:
    /// a full-pipeline writer job claimed and abandoned without exit proof
    /// cannot be finalized or ended without proof, parks `exit_unconfirmed`
    /// at the reaper, stays parked after its delay, is not claimed, and
    /// keeps its scope held.
    #[test]
    fn a_job_of_any_other_stage_still_requires_exit_proof() {
        let db = Db::new();
        let (job, run, owner, attempt) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let scope = "generated-other-stage";
        let key = format!("other-{job}");
        let sha = hex(&Sha256::digest(key.as_bytes()));
        let reply = db.call(
            "SELECT pd_writer_admit($1,1424,$2,'generated-test',$3,$4,$5,$6,'delphi_full_pipeline',NULL,'{}'::jsonb,repeat('b',40))",
            &[&ENV, &scope, &key, &sha, &job, &run],
        );
        assert_eq!(reply["outcome"], "enqueued", "{reply}");
        let claim = db.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'delphi')",
            &[&ENV, &owner, &attempt],
        );
        assert_eq!(claim["job_id"], job.to_string().as_str());
        let t = token(&db, &job.to_string());
        let fin = db.executor().query_one(
            "SELECT pq_finalize($1,$2,$3,$4,$5,'file:///generated/output-manifest.json',repeat('0',64))",
            &[&ENV, &job, &t.0, &t.1, &t.2],
        );
        assert!(format!("{:?}", fin.unwrap_err()).contains("process exit proof required"));
        let end = db.executor().query_one(
            "SELECT pq_end_attempt($1,$2,$3,$4,$5,'retry','generated',false)",
            &[&ENV, &job, &t.0, &t.1, &t.2],
        );
        assert!(format!("{:?}", end.unwrap_err()).contains("process exit proof required"));
        let end = db.executor().query_one(
            "SELECT pq_fail($1,$2,$3,$4,$5,false,'generated',NULL)",
            &[&ENV, &job, &t.0, &t.1, &t.2],
        );
        assert!(format!("{:?}", end.unwrap_err()).contains("process exit proof required"));
        let job = job.to_string();
        expire(&db, &job);
        db.call("SELECT pq_reap($1,NULL,100,'delphi')", &[&ENV]);
        assert_eq!(
            state(&db, &job),
            ("parked".into(), Some("exit_unconfirmed".into()))
        );
        make_eligible(&db, &job);
        db.call("SELECT pq_reap($1,NULL,100,'delphi')", &[&ENV]);
        assert_eq!(state(&db, &job).0, "parked");
        db.admin()
            .execute(
                "UPDATE polis_queue_jobs SET state='queued' WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        let none = db.call(
            "SELECT pq_claim($1,1::smallint,$2,$3,60,'delphi')",
            &[&ENV, &Uuid::new_v4(), &Uuid::new_v4()],
        );
        assert_eq!(none["outcome"], "none", "{none}");
        db.admin()
            .execute(
                "UPDATE delphi_jobs SET status='dead' WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap();
        let held: String = db
            .admin()
            .query_one(
                "SELECT scope_key FROM delphi_job_guards WHERE env=$1 AND root_job_id=$2::text::uuid",
                &[&ENV, &job],
            )
            .unwrap()
            .get(0);
        let released: bool = db
            .admin()
            .query_one("SELECT pd_release_scope($1,$2)", &[&ENV, &held])
            .unwrap()
            .get(0);
        assert!(!released, "the unconfirmed attempt still holds its scope");
    }

    /// The down file restores every function to its 000049 definition.
    #[test]
    fn the_down_file_restores_every_function_exactly() {
        let defs = |db: &Db| -> std::collections::BTreeMap<String, String> {
            db.admin()
                .query(
                    "SELECT p.oid::regprocedure::text, pg_get_functiondef(p.oid) FROM pg_proc p
                     WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'",
                    &[],
                )
                .unwrap()
                .iter()
                .map(|r| (r.get(0), r.get(1)))
                .collect()
        };
        let before = defs(&Db::new_without("000050"));
        let after = Db::new();
        let forward = defs(&after);
        after
            .admin()
            .batch_execute(
                &std::fs::read_to_string(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
                        "../../server/postgres/migrations/down/000050_remove_derived_jobs.sql",
                    ),
                )
                .unwrap(),
            )
            .unwrap();
        let back = defs(&after);
        // Normalize only the six documented whole-line substitutions, in
        // their exact function signatures. Compare the entire map afterward:
        // an extra overload, a missing function or any other edit must fail.
        // Read the historical local name from its declaration. Only the
        // exact six full lines below may change; no line is exempted.
        let original_writer = &before["pd_writer_admit(text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text)"];
        let original_name = original_writer
            .lines()
            .find_map(|line| {
                line.strip_prefix("DECLARE frame text; conf jsonb; reply jsonb;")
                    .and_then(|s| s.strip_suffix(" text;"))
            })
            .unwrap();
        assert!(!original_name.is_empty());
        assert!(
            original_name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'_')
        );
        let mut expected = before.clone();
        for (name, substitutions) in [
            (
                "pd_enqueue(text,integer,text,text,text,text,uuid,uuid,text,text,text,text,smallint,integer,text,text,text,jsonb)",
                vec![(
                    format!(
                        " -- The poison latch (no {original_name} is held): the scope's last three jobs all dead\n"
                    ),
                    " -- The poison latch (no scope is held): the scope's last three jobs all dead\n",
                )],
            ),
            (
                "pd_writer_admit(text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text)",
                vec![
                    (
                        format!(
                            "DECLARE frame text; conf jsonb; reply jsonb;{original_name} text;\n"
                        ),
                        "DECLARE frame text; conf jsonb; reply jsonb;writer_scope text;\n",
                    ),
                    (
                        format!(
                            " {original_name}='writer:'||public.pd_graph_hash(jsonb_build_array(p_zid,p_scope));\n"
                        ),
                        " writer_scope='writer:'||public.pd_graph_hash(jsonb_build_array(p_zid,p_scope));\n",
                    ),
                    (
                        format!(" PERFORM public.pd_release_scope(p_env,{original_name});\n"),
                        " PERFORM public.pd_release_scope(p_env,writer_scope);\n",
                    ),
                    (
                        format!(
                            " reply=public.pd_enqueue(p_env,p_zid,{original_name},p_actor,p_key,p_sha,p_run,p_job,\n"
                        ),
                        " reply=public.pd_enqueue(p_env,p_zid,writer_scope,p_actor,p_key,p_sha,p_run,p_job,\n",
                    ),
                    (
                        format!("  p_stage,p_report,{original_name},conf);\n"),
                        "  p_stage,p_report,writer_scope,conf);\n",
                    ),
                ],
            ),
        ] {
            let definition = expected.get_mut(name).unwrap();
            for (old, new) in substitutions {
                assert_eq!(definition.matches(old.as_str()).count(), 1, "{name}: {old}");
                *definition = definition.replacen(old.as_str(), new, 1);
            }
        }
        assert_eq!(
            expected, back,
            "down must restore every normalized definition"
        );
        let changed = before
            .iter()
            .filter(|(name, def)| forward.get(*name) != Some(def))
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        assert!(
            changed.contains(&"pq_reap_one(text,uuid)".to_owned()),
            "{changed:?}"
        );
        println!("FUNCTIONS_REPLACED_BY_000050 {changed:?}");
    }

    /// The worker reaches no model and no pipeline: its source has no
    /// process spawn and its crate depends on nothing that runs one.
    #[test]
    fn the_worker_starts_no_process_and_links_no_pipeline() {
        let src =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/worker.rs")).unwrap();
        for word in ["Command::new", "process::Command", "python", "spawn("] {
            assert!(!src.contains(word), "{word}");
        }
        let manifest =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        for word in ["pyo3", "ort", "onnx", "tch", "reqwest", "hyper"] {
            assert!(!manifest.contains(&format!("\n{word} =")), "{word}");
        }
    }
    #[test]
    fn source_read_deadline_interrupts_silent_transport() {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener, TcpStream};
        use std::time::{Duration, Instant};
        let db = Db::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dbport = admin_url().parse::<postgres::Config>().unwrap().get_ports()[0];
        let proxy = std::thread::spawn(move || {
            let (mut front, _) = listener.accept().unwrap();
            let mut back = TcpStream::connect(("127.0.0.1", dbport)).unwrap();
            let (mut f, mut b) = (front.try_clone().unwrap(), back.try_clone().unwrap());
            let reply = std::thread::spawn(move || {
                let _ = std::io::copy(&mut b, &mut f);
            });
            let mut buf = [0u8; 65536];
            let mut peer_closed = false;
            loop {
                let n = front.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                if buf[..n].windows(17).any(|w| w == b"START TRANSACTION")
                    || buf[..n].windows(5).any(|w| w == b"BEGIN")
                {
                    // Keep the TCP session established; SQL timeouts cannot see this withheld request.
                    front
                        .set_read_timeout(Some(Duration::from_millis(800)))
                        .unwrap();
                    peer_closed = front.read(&mut [0u8; 1]).is_ok_and(|n| n == 0);
                    break;
                }
                back.write_all(&buf[..n]).unwrap();
            }
            let _ = front.shutdown(Shutdown::Both);
            let _ = back.shutdown(Shutdown::Both);
            reply.join().unwrap();
            peer_closed
        });
        let dsn = format!("postgresql://{}@127.0.0.1:{port}/{}", db.login, db.name);
        let mut client = from_run::connect(|k| match k {
            "QUEUE_DATABASE_URL" => Some(dsn.clone()),
            "POLIS_JOBS_TRANSPORT" => Some("loopback".into()),
            _ => None,
        })
        .unwrap();
        let bounds = worker::Bounds {
            deadline: Duration::from_millis(100),
            statement: Duration::from_millis(50),
            ..worker::Bounds::default()
        };
        let start = Instant::now();
        let result = worker::read_source(
            &mut client,
            ENV,
            "00000000-0000-4000-8000-000000000001",
            bounds,
        );
        let elapsed = start.elapsed();
        let peer_closed = proxy.join().unwrap();
        assert!(result.is_err());
        println!(
            "SILENT_TRANSPORT deadline_ms=100 statement_ms=50 elapsed_ms={} peer_closed={peer_closed}",
            elapsed.as_millis()
        );
        assert!(peer_closed, "deadline must close the source socket");
        assert!(
            elapsed < Duration::from_millis(500),
            "source deadline did not interrupt transport: {elapsed:?}"
        );
    }
}

/// The shadow scheduler's backfill of derived maps (`shadow::backfill`), with
/// the real admission, over successive cycles of the real scheduler.
mod backfill {
    use super::*;
    use polis_queue_adapter::shadow::{
        backfill::{self as shadow_backfill, Admitter, Outcome, Source},
        config, scheduler,
    };
    use polis_topic_map::backfill::TopicMap;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    const RULE: &str = "participant_visible/1";

    fn on(k: &str) -> Option<String> {
        (k == polis_topic_map::derived::SWITCH).then(|| "1".to_owned())
    }

    /// The real admitter, counting its calls; refusing, once each, the jobs
    /// named in `refuse` (as the admission would, by its word).
    struct Counting {
        inner: TopicMap<fn(&str) -> Option<String>>,
        asked: Rc<RefCell<Vec<String>>>,
        refuse: Vec<String>,
        switched: bool,
    }

    impl Admitter for Counting {
        fn switched_on(&self) -> bool {
            self.switched
        }
        fn alias(&self, env: &str, job: &str) -> String {
            self.inner.alias(env, job)
        }
        fn admit(&mut self, c: &mut Client, s: &Source, code: &str) -> Result<Outcome, String> {
            self.asked.borrow_mut().push(s.job_id.clone());
            if self.refuse.contains(&s.job_id) {
                return Ok(Outcome::Refused("source_rule".into()));
            }
            self.inner.admit(c, s, code)
        }
        fn inputs(&self) -> &'static [&'static str] {
            self.inner.inputs()
        }
        fn map_family(&self) -> &'static str {
            self.inner.map_family()
        }
    }

    fn counting(asked: &Rc<RefCell<Vec<String>>>, refuse: &[&str]) -> Box<Counting> {
        Box::new(Counting {
            inner: TopicMap { get: on },
            asked: asked.clone(),
            refuse: refuse.iter().map(|s| (*s).to_owned()).collect(),
            switched: true,
        })
    }

    fn cfg(db: &Db, dir: &std::path::Path, extra: &[(&str, &str)]) -> config::Config {
        let mut m: HashMap<String, String> = [
            ("DELPHI_SHADOW_ENABLED", "1".to_owned()),
            ("DELPHI_SHADOW_ENV", ENV.to_owned()),
            ("QUEUE_DATABASE_URL", url_for(&db.name, &db.login)),
            (
                "DELPHI_SHADOW_READ_DATABASE_URL",
                url_for(&db.name, "postgres"),
            ),
            ("POLIS_JOBS_TRANSPORT", "loopback".to_owned()),
            (
                "DELPHI_SHADOW_CODE_VERSION",
                "0123456789abcdef0123456789abcdef01234567".to_owned(),
            ),
            (
                "DELPHI_SHADOW_STATE_PATH",
                dir.join("state.json").display().to_string(),
            ),
            (
                "DELPHI_SHADOW_PAUSE_FILE",
                dir.join("pause").display().to_string(),
            ),
            ("DELPHI_SHADOW_DISK_PATH", dir.display().to_string()),
            ("DELPHI_SHADOW_DISK_FREE_MIN_MB", "0".to_owned()),
            ("DELPHI_SHADOW_DISK_USED_MAX_PCT", "100".to_owned()),
            ("DELPHI_SHADOW_DUTY_CYCLE", "1".to_owned()),
            ("DELPHI_SHADOW_PROBE_MAX_MS", "5000".to_owned()),
            ("DELPHI_SHADOW_BENCHMARK", "c1424".to_owned()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        for (k, v) in extra {
            m.insert((*k).to_owned(), (*v).to_owned());
        }
        match config::load(|k| m.get(k).cloned()).unwrap() {
            config::Load::Ready(c) => *c,
            config::Load::Disabled => panic!("disabled"),
        }
    }

    fn dir() -> PathBuf {
        let d =
            PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("backfill-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    thread_local! {
        static ALL: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// Every line this thread's schedulers wrote since the test began
    /// (`kept_lines` hands each line out once).
    fn all() -> Vec<String> {
        ALL.with(|a| {
            a.borrow_mut().extend(scheduler::kept_lines());
            a.borrow().clone()
        })
    }

    /// Lines of one event among those kept since `from`.
    fn events(name: &str, from: usize) -> Vec<Value> {
        all()[from..]
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l.split_once(' ')?.1).ok())
            .filter(|v| v["event"] == name)
            .collect()
    }

    fn derived_jobs(db: &Db) -> Vec<(String, String)> {
        db.admin()
            .query(
                "SELECT (config_effective#>>'{derived,source,job_id}'), status FROM delphi_jobs \
                 WHERE kind='derived' ORDER BY created_at",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }

    fn cancel(db: &Db, job: &str) {
        let mut c = db.admin();
        let status: Value = c
            .query_one("SELECT pq_job_status($1,$2::text::uuid)", &[&ENV, &job])
            .unwrap()
            .get(0);
        let version: i64 = status["mgmt_version"].as_str().unwrap().parse().unwrap();
        c.query_one(
            "SELECT pq_cancel($1,$2::text::uuid,$3)",
            &[&ENV, &job, &version],
        )
        .unwrap();
    }

    fn cycles(s: &mut scheduler::Scheduler<'_>, n: usize) {
        for _ in 0..n {
            s.cycle().unwrap();
        }
    }

    #[test]
    fn every_stored_run_without_a_map_is_asked_once_bounded_and_then_the_inventory_is_empty() {
        scheduler::keep_lines();
        ALL.with(|a| a.borrow_mut().clear());
        let db = Db::new();
        db.admin()
            .execute(
                "INSERT INTO zinvites(zid,zinvite) VALUES(1424,'c1424')",
                &[],
            )
            .unwrap();
        let run = support::run("biodiversity", 1424, None);
        let rule = |r: &str| json!({ "selection": r });
        // Replaced: a later run of the same rule takes its publication.
        let a = db.writer_run("delphi", rule(RULE), &run, false).0.job_id;
        let with_map = db.writer_run("delphi", rule(RULE), &run, true).0.job_id;
        let other_rule = db
            .writer_run("delphi:all", rule("all_comments/1"), &run, false)
            .0
            .job_id;
        let current = db.writer_run("delphi", rule(RULE), &run, false).0.job_id;
        // One whose derived job another asker made, then cancelled.
        let asked_before = db.writer_run("delphi:x", rule(RULE), &run, false).0.job_id;
        let mut ex = db.executor();
        let mut operator = TopicMap { get: on };
        let source = Source {
            env: ENV.into(),
            job_id: asked_before.clone(),
            zid: 1424,
            selection: Some(RULE.into()),
        };
        assert_eq!(
            operator.admit(&mut ex, &source, &"c".repeat(40)).unwrap(),
            Outcome::Enqueued
        );
        cancel(&db, &derived_jobs(&db)[0].0.clone().pipe_job(&db));
        let d = dir();
        let asked = Rc::new(RefCell::new(Vec::new()));
        let extra = [
            ("DELPHI_SHADOW_DERIVED_BACKFILL", "1"),
            ("DELPHI_SHADOW_DERIVED_PER_CYCLE", "2"),
            ("DELPHI_SHADOW_DERIVED_DAILY", "3"),
        ];
        let c = cfg(&db, &d, &extra);
        let from = all().len();
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        // Two asked in the first cycle (the per-cycle bound), oldest first;
        // the third waits (the daily cap: three today, the operator's
        // included); then the backlog holds.
        cycles(&mut s, 1);
        assert_eq!(*asked.borrow(), vec![a.clone(), other_rule.clone()]);
        assert_eq!(
            events("derived_held", from)[0]["reason"],
            "derived_daily_cap"
        );
        cycles(&mut s, 3);
        assert_eq!(asked.borrow().len(), 2);
        let lines = events("derived_backfill", from);
        assert_eq!(lines[0]["admitted"], 2, "{lines:?}");
        assert_eq!(lines[0]["with_map"], 1);
        assert_eq!(lines[0]["derived"], 1);
        assert_eq!(lines[0]["without_map"], 3);
        assert!(
            events("derived_held", from)
                .iter()
                .any(|l| l["reason"] == "backlog")
        );
        // The operator's pause holds it.
        std::fs::write(d.join("pause"), "").unwrap();
        let n = asked.borrow().len();
        for job in derived_job_ids(&db) {
            if job_status(&db, &job) == "queued" {
                cancel(&db, &job);
            }
        }
        cycles(&mut s, 2);
        assert_eq!(asked.borrow().len(), n);
        assert!(
            events("derived_held", from)
                .iter()
                .any(|l| l["reason"] == "operator")
        );
        std::fs::remove_file(d.join("pause")).unwrap();
        // The daily cap (three today, the operator's included): nothing more.
        cycles(&mut s, 2);
        assert_eq!(asked.borrow().len(), n);
        assert!(
            events("derived_held", from)
                .iter()
                .any(|l| l["reason"] == "derived_daily_cap")
        );
        drop(s);
        // A restart with a higher cap, refusing the last one: asked once.
        let c = cfg(
            &db,
            &d,
            &[extra[0], extra[1], ("DELPHI_SHADOW_DERIVED_DAILY", "10")],
        );
        let from = all().len();
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[current.as_str()]));
        cycles(&mut s, 4);
        assert_eq!(asked.borrow().iter().filter(|j| **j == current).count(), 1);
        assert_eq!(
            events("derived_backfill", from)[0]["refused"]["source_rule"],
            1
        );
        let empty = events("derived_inventory_empty", from);
        assert_eq!(empty.len(), 1, "{:?}", all());
        assert_eq!(
            empty[0]["message"],
            "every stored run has a map or a recorded outcome"
        );
        assert_eq!(empty[0]["refused_before"], 1);
        drop(s);
        // Another restart: the refusal was this process's only; asked again,
        // admitted, and nothing is duplicated.
        let from = all().len();
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 4);
        assert_eq!(asked.borrow().iter().filter(|j| **j == current).count(), 2);
        let sources: Vec<String> = derived_jobs(&db).into_iter().map(|(s, _)| s).collect();
        let mut want = vec![
            asked_before.clone(),
            a.clone(),
            other_rule.clone(),
            current.clone(),
        ];
        let mut got = sources.clone();
        want.sort();
        got.sort();
        assert_eq!(got, want, "one derived job per run without a map");
        assert!(!sources.contains(&with_map));
        assert_eq!(events("derived_inventory_empty", from).len(), 1);
        // No backfill line names a conversation, its code, or a job; no line
        // at all names the code.
        let word = |line: &str, w: &str| {
            line.match_indices(w).any(|(i, _)| {
                !line[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                    && !line[i + w.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphanumeric())
            })
        };
        for line in all() {
            assert!(!word(&line, "c1424"), "{line}");
            if line.contains("\"derived_") {
                for id in [&a, &with_map, &other_rule, &current, &asked_before] {
                    assert!(!line.contains(id.as_str()), "{line}");
                }
                assert!(!word(&line, "1424"), "{line}");
            }
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    fn derived_job_ids(db: &Db) -> Vec<String> {
        db.admin()
            .query(
                "SELECT job_id::text FROM delphi_jobs WHERE kind='derived'",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }

    fn job_status(db: &Db, job: &str) -> String {
        db.admin()
            .query_one(
                "SELECT status FROM delphi_jobs WHERE job_id=$1::text::uuid",
                &[&job],
            )
            .unwrap()
            .get(0)
    }

    trait PipeJob {
        fn pipe_job(&self, db: &Db) -> String;
    }
    impl PipeJob for String {
        /// The derived job made from source `self`.
        fn pipe_job(&self, db: &Db) -> String {
            db.admin()
                .query_one(
                    "SELECT job_id::text FROM delphi_jobs WHERE kind='derived' \
                     AND config_effective#>>'{derived,source,job_id}'=$1",
                    &[self],
                )
                .unwrap()
                .get(0)
        }
    }

    #[test]
    fn off_means_no_query_and_no_line_and_admission_off_reads_nothing() {
        scheduler::keep_lines();
        ALL.with(|a| a.borrow_mut().clear());
        let db = Db::new();
        db.admin()
            .execute(
                "INSERT INTO zinvites(zid,zinvite) VALUES(1424,'c1424')",
                &[],
            )
            .unwrap();
        let run = support::run("biodiversity", 1424, None);
        db.writer_run("delphi", json!({ "selection": RULE }), &run, false);
        let d = dir();
        let asked = Rc::new(RefCell::new(Vec::new()));
        // Off: the admitter is there, the switch is not.
        let c = cfg(&db, &d, &[]);
        let from = all().len();
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 6);
        assert_eq!(s.derived.queries, 0);
        assert!(asked.borrow().is_empty());
        assert!(
            all()[from..].iter().all(|l| !l.contains("derived")),
            "{:?}",
            &all()[from..]
        );
        drop(s);
        // On, with admission off: held, still no inventory query.
        let c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let from = all().len();
        let mut off = counting(&asked, &[]);
        off.switched = false;
        let mut s = scheduler::Scheduler::new(&c).unwrap().with_admitter(off);
        cycles(&mut s, 6);
        assert_eq!(s.derived.queries, 0);
        assert!(asked.borrow().is_empty());
        assert!(
            events("derived_held", from)
                .iter()
                .any(|l| l["reason"] == "admission_off")
        );
        assert!(derived_job_ids(&db).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_full_run_waiting_or_running_holds_the_backfill() {
        scheduler::keep_lines();
        ALL.with(|a| a.borrow_mut().clear());
        let db = Db::new();
        let mut a = db.admin();
        a.execute(
            "INSERT INTO zinvites(zid,zinvite) VALUES(1424,'c1424')",
            &[],
        )
        .unwrap();
        let run = support::run("biodiversity", 1424, None);
        db.writer_run("delphi", json!({ "selection": RULE }), &run, false);
        // Comments enough for a full run of the benchmark conversation.
        a.batch_execute(
            "INSERT INTO participants(zid,uid) VALUES(1424,1);
             INSERT INTO comments(zid,pid,uid,txt,mod,active)
               SELECT 1424,(SELECT pid FROM participants WHERE zid=1424),1,'generated comment '||g,0,true
               FROM generate_series(1,40) g;",
        )
        .unwrap();
        let d = dir();
        let asked = Rc::new(RefCell::new(Vec::new()));
        let c = cfg(
            &db,
            &d,
            &[
                ("DELPHI_SHADOW_DERIVED_BACKFILL", "1"),
                ("DELPHI_SHADOW_MIN_COMMENTS", "5"),
            ],
        );
        let from = all().len();
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 6);
        assert!(s.state.in_flight.is_some(), "{:?}", &all()[from..]);
        assert!(asked.borrow().is_empty());
        assert_eq!(s.derived.queries, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_inventory_page_uses_the_history_index_and_key_lookups() {
        let db = Db::new();
        let mut a = db.admin();
        a.batch_execute(
            "INSERT INTO delphi_jobs(job_id,env,zid,kind,origin,status,config_effective)
               SELECT gen_random_uuid(),'shadow-bulk',1424,'full_pipeline','legacy_import','succeeded','{}'
               FROM generate_series(1,20000);
             ANALYZE delphi_jobs; ANALYZE delphi_artifacts; ANALYZE delphi_result_batches;
             ANALYZE delphi_result_families; ANALYZE delphi_job_aliases;",
        )
        .unwrap();
        let mut tx = a.transaction().unwrap();
        let inputs: Vec<String> = stored::INPUTS.iter().map(|s| (*s).to_owned()).collect();
        let zids = vec![1424i32];
        let plan: Vec<String> = tx
            .query(
                &format!("EXPLAIN {}", shadow_backfill::PAGE_SQL),
                &[
                    &"shadow-bulk",
                    &zids,
                    &i32::MIN,
                    &"-infinity",
                    &"00000000-0000-0000-0000-000000000000",
                    &shadow_backfill::PAGE,
                    &shadow_backfill::RUN_KIND,
                    &inputs,
                    &stored::FAMILY,
                ],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        let text = plan.join("\n");
        println!("{text}");
        assert!(text.contains("delphi_jobs_history"), "{text}");
        assert!(!text.contains("Seq Scan on delphi_jobs "), "{text}");
        // The per-job lookups: index lookups once the tables are not tiny
        // (forced here, where they are).
        tx.batch_execute("SET LOCAL enable_seqscan=off; SET LOCAL enable_hashjoin=off; SET LOCAL enable_mergejoin=off")
            .unwrap();
        let text: String = tx
            .query(
                &format!("EXPLAIN {}", shadow_backfill::PAGE_SQL),
                &[
                    &"shadow-bulk",
                    &zids,
                    &i32::MIN,
                    &"-infinity",
                    &"00000000-0000-0000-0000-000000000000",
                    &shadow_backfill::PAGE,
                    &shadow_backfill::RUN_KIND,
                    &inputs,
                    &stored::FAMILY,
                ],
            )
            .unwrap()
            .iter()
            .map(|r| r.get::<_, String>(0))
            .collect::<Vec<_>>()
            .join("\n");
        for index in [
            "delphi_artifacts_env_job_id_output_role_key",
            "delphi_result_batches_env_artifact_id_key",
            "delphi_result_families_pkey",
        ] {
            assert!(text.contains(index), "{index} not in\n{text}");
        }

        let keys = vec!["derived/1:".to_owned() + &"0".repeat(64)];
        let plan: Vec<String> = tx
            .query(
                &format!("EXPLAIN {}", shadow_backfill::ALIASES_SQL),
                &[&keys],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert!(
            plan.join("\n").contains("delphi_job_aliases_pkey"),
            "{plan:?}"
        );
    }
    #[test]
    fn review_refusals_respect_the_per_cycle_call_limit() {
        let db = Db::new();
        db.admin()
            .execute(
                "INSERT INTO zinvites(zid,zinvite) VALUES(1424,'c1424')",
                &[],
            )
            .unwrap();
        let run = support::run("biodiversity", 1424, None);
        let sources: Vec<String> = (0..7)
            .map(|_| {
                db.writer_run("delphi", json!({"selection": RULE}), &run, false)
                    .0
                    .job_id
            })
            .collect();
        let d = dir();
        let c = cfg(
            &db,
            &d,
            &[
                ("DELPHI_SHADOW_DERIVED_BACKFILL", "1"),
                ("DELPHI_SHADOW_DERIVED_PER_CYCLE", "2"),
            ],
        );
        let asked = Rc::new(RefCell::new(Vec::new()));
        let refs: Vec<&str> = sources.iter().map(String::as_str).collect();
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &refs));
        cycles(&mut s, 1);
        let n = asked.borrow().len();
        let _ = std::fs::remove_dir_all(&d);
        assert!(
            n <= 2,
            "configured call limit 2; observed {n} admission calls"
        );
    }

    #[test]
    fn review_each_pause_gate_reaches_backfill() {
        use polis_queue_adapter::shadow::{
            plan::{self, Pause},
            storage,
        };
        scheduler::keep_lines();
        ALL.with(|a| a.borrow_mut().clear());
        let db = Db::new();
        db.admin()
            .execute(
                "INSERT INTO zinvites(zid,zinvite) VALUES(1424,'c1424')",
                &[],
            )
            .unwrap();
        let run = support::run("biodiversity", 1424, None);
        db.writer_run("delphi", json!({"selection": RULE}), &run, false);
        let d = dir();
        for pause_case in [
            "operator",
            "disk",
            "db_latency",
            "math_lag",
            "storage_budget",
            "storage_daily",
            "storage_unmeasured",
        ] {
            let mut c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
            let asked = Rc::new(RefCell::new(Vec::new()));
            if pause_case == "operator" {
                std::fs::write(&c.pause_file, "").unwrap();
            }
            if pause_case == "disk" {
                c.disk_free_min_mb = u64::MAX;
            }
            if pause_case == "db_latency" {
                c.probe_max = std::time::Duration::ZERO;
            }
            // Only timestamps are needed by math_lag: a temporary view substitutes
            // the timestamp source in this disposable database; no vote is seeded.
            if pause_case == "math_lag" {
                db.admin().batch_execute("ALTER TABLE votes RENAME TO saved_votes; CREATE VIEW votes AS SELECT now_as_millis() AS created").unwrap();
            }
            let mut s = scheduler::Scheduler::new(&c)
                .unwrap()
                .with_admitter(counting(&asked, &[]));
            s.state.storage.reconciled = true;
            if pause_case == "storage_budget" {
                s.state.storage.bytes = c.storage_budget_bytes;
            }
            if pause_case == "storage_daily" {
                // Use an already counted day with a positive limit in a fresh config.
                drop(s);
                c.storage_daily_bytes = Some(1);
                s = scheduler::Scheduler::new(&c)
                    .unwrap()
                    .with_admitter(counting(&asked, &[]));
                s.state.storage.reconciled = true;
                s.state.storage.roll_day(scheduler::now_ms());
                s.state.storage.day_bytes = 1;
            }
            if pause_case == "storage_unmeasured" {
                s.state.storage.pending.push(storage::Pending {
                    env: ENV.into(),
                    job_id: Uuid::new_v4().to_string(),
                    zid: 1424,
                    comments: 0,
                    set: None,
                });
                // A failing indexed measure leaves its pending record intact.
                db.admin()
                    .batch_execute("ALTER TABLE delphi_result_families RENAME TO saved_families")
                    .unwrap();
            }
            let from = all().len();
            cycles(&mut s, 1);
            assert_eq!(s.derived.queries, 0, "{pause_case}");
            assert!(asked.borrow().is_empty(), "{pause_case}");
            assert!(
                events("derived_held", from)
                    .iter()
                    .any(|x| x["reason"] == pause_case),
                "{pause_case}: {:?}",
                all()
            );
            println!("PAUSE {pause_case}: no inventory, no admission");
            if pause_case == "operator" {
                std::fs::remove_file(&c.pause_file).unwrap();
            }
            if pause_case == "math_lag" {
                db.admin()
                    .batch_execute("DROP VIEW votes; ALTER TABLE saved_votes RENAME TO votes")
                    .unwrap();
            }
            if pause_case == "storage_unmeasured" {
                db.admin()
                    .batch_execute("ALTER TABLE saved_families RENAME TO delphi_result_families")
                    .unwrap();
            }
        }
        // Every pure pause, including hysteresis, remains in the derived path;
        // only the full-run daily count is intentionally ignored.
        let c = cfg(&db, &d, &[]);
        let mut st =
            polis_queue_adapter::shadow::state::State::load(&c.state_path, &c.env).unwrap();
        st.day_runs = c.daily_runs;
        st.storage.reconciled = true;
        let disk = Some(plan::Disk {
            free_mb: u64::MAX,
            used_pct: 0.0,
        });
        let signal = polis_queue_adapter::shadow::db::Signals {
            probe_ms: 0.0,
            math_lag_ms: 0,
        };
        assert_eq!(
            plan::pause(&c, &st, false, disk, Some(&signal), None),
            Some(Pause::DailyCap)
        );
        assert_eq!(
            plan::derived_pause(&c, &st, false, disk, Some(&signal), None),
            None
        );
        let signal = polis_queue_adapter::shadow::db::Signals {
            probe_ms: c.probe_max.as_secs_f64() * 750.0,
            math_lag_ms: 0,
        };
        assert_eq!(
            plan::derived_pause(&c, &st, false, disk, Some(&signal), Some(Pause::DbLatency)),
            Some(Pause::DbLatency)
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn review_finished_derived_bytes_reach_storage_budget() {
        review_finished_map(None);
    }

    /// A job that stores no map (two rows): the smallest the estimate sees.
    /// Run it also with the longest env the settings allow (64 bytes) by
    /// setting `ENV` to one; the estimate counts the env per row.
    #[test]
    fn review_storage_small_no_map_estimate() {
        review_finished_map(Some(2));
    }

    fn review_finished_map(steps: Option<usize>) {
        use polis_topic_map::worker::{self, Worker};
        let db = Db::new();
        db.admin()
            .execute(
                "INSERT INTO zinvites(zid,zinvite) VALUES(1424,'c1424')",
                &[],
            )
            .unwrap();
        let run = support::run("biodiversity", 1424, steps);
        db.writer_run("delphi", json!({"selection": RULE}), &run, false);
        let d = dir();
        let c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let asked = Rc::new(RefCell::new(Vec::new()));
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 1);
        // The derived maps' own budget is held to one reading of the
        // database (process memory); the full runs' ledger never counts them.
        let before = s.derived.stored.bytes().expect("read at the first cycle");
        let runs = (s.state.storage.bytes, s.state.storage.day_bytes);
        let url = url_for(&db.name, &db.login);
        let get = move |k: &str| match k {
            "QUEUE_DATABASE_URL" => Some(url.clone()),
            "POLIS_JOBS_TRANSPORT" => Some("loopback".into()),
            _ => None,
        };
        let mut w = Worker::new(worker::Config {
            env: ENV.into(),
            connector: std::sync::Arc::new(worker::connector(&get).unwrap()),
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
        println!("worker: {:?}", w.pass().unwrap());
        assert_eq!(job_status(&db, &derived_job_ids(&db)[0]), "succeeded");
        // The next beat reads the finished map.
        s.derived.stored.read_ms -= polis_queue_adapter::shadow::storage::DERIVED_READ_MS;
        cycles(&mut s, 3);
        let after = s.derived.stored.bytes().unwrap();
        assert_eq!(
            (s.state.storage.bytes, s.state.storage.day_bytes),
            runs,
            "the full runs' ledger never counts a derived job"
        );
        {
            use polis_queue_adapter::shadow::storage;
            let job = derived_job_ids(&db)[0].clone();
            let mut admin = db.admin();
            let mut tx = admin.transaction().unwrap();
            let m = storage::measure(&mut tx, ENV, &job, 1424).unwrap();
            let t = s.derived.stored.read.unwrap();
            println!(
                "MAP measure={m:?} total={} reading={t:?} row ratio={:.3} job ratio={:.3}",
                m.total(),
                t.row_bytes as f64 / m.result_row_bytes as f64,
                t.bytes as f64 / m.total() as f64
            );
            assert_eq!(m.embeddings, 0, "a derived job stores no embeddings");
            assert_eq!(t.families, m.families);
            assert_eq!(t.log_bytes, m.log_bytes);
            assert_eq!(t.family_bytes, m.family_bytes);
            // An estimate, measured above on this map; not a proven bound.
            assert!(
                t.row_bytes >= m.result_row_bytes,
                "the estimate stays above here"
            );
            assert!(t.bytes >= m.total());
        }
        // The same state file is saved by run() every cycle. Verify no new file
        // is necessary to observe the stored result's contribution.
        let _ = std::fs::remove_dir_all(&d);
        assert!(
            after > before,
            "derived map succeeded; accounted bytes stayed {before} -> {after}"
        );
    }

    #[test]
    fn review_inventory_large_tables_and_multi_conversation_paging() {
        let db = Db::new();
        let run = support::run("biodiversity", 1424, None);
        let src = db
            .writer_run("delphi", json!({"selection":RULE}), &run, false)
            .0;
        let mut admitter = TopicMap { get: on };
        assert_eq!(
            admitter
                .admit(
                    &mut db.executor(),
                    &Source {
                        env: ENV.into(),
                        job_id: src.job_id,
                        zid: 1424,
                        selection: Some(RULE.into())
                    },
                    &"c".repeat(40)
                )
                .unwrap(),
            Outcome::Enqueued
        );
        let mut a = db.admin();
        // Planner-only rows in a disposable database; no worker lifecycle claim.
        // Referential triggers are disabled only while filling these tables.
        a.batch_execute(r#"
          SET session_replication_role=replica;
          CREATE TEMP TABLE bulk AS SELECT g, (2000+g%100)::int zid, gen_random_uuid() job, gen_random_uuid() artifact, gen_random_uuid() batch, gen_random_uuid() run FROM generate_series(1,40000) g;
          INSERT INTO delphi_jobs(job_id,env,zid,kind,origin,status,config_effective,output_manifest_digest,created_at)
            SELECT job, 'shadow-bulk', zid, 'full_pipeline','legacy_import','succeeded', '{"result_scope":"delphi","selection":"participant_visible/1"}', decode(repeat('a',64),'hex'), '2026-01-01'::timestamptz + (g/100)*interval '1 second' FROM bulk;
          INSERT INTO delphi_artifacts(env,artifact_id,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
            SELECT 'shadow-bulk',artifact,job,run,batch,'result','generated-plan','{}',encode(sha256('{}'::bytea),'hex'),2 FROM bulk;
          INSERT INTO delphi_result_batches(env,batch_id,job_id,run_id,sealed_sha,artifact_id)
            SELECT 'shadow-bulk',batch,job,run,repeat('a',64),artifact FROM bulk;
          INSERT INTO delphi_result_families(env,batch_id,family,codec_wire,content_sha,row_count)
            SELECT 'shadow-bulk',batch,f,'',encode(sha256(''::bytea),'hex'),0 FROM bulk CROSS JOIN unnest(ARRAY['Delphi_UMAPGraph','Delphi_CommentHierarchicalClusterAssignments','Delphi_CommentClustersLLMTopicNames']) f;
          INSERT INTO delphi_job_aliases(public_id,job_id,source) SELECT 'derived/1:'||lpad(g::text,64,'0'),job,'derived' FROM bulk;
          INSERT INTO polis_queue_jobs SELECT (jsonb_populate_record(NULL::polis_queue_jobs,to_jsonb(q)||jsonb_build_object('env','shadow-bulk','job_id',b.job,'run_id',b.run,'state','succeeded'))).* FROM polis_queue_jobs q CROSS JOIN bulk b WHERE q.env='shadow-topic-map' AND q.worker_class='derived';
          SET session_replication_role=origin;
          ANALYZE polis_queue_jobs;
          ANALYZE delphi_jobs; ANALYZE delphi_artifacts; ANALYZE delphi_result_batches; ANALYZE delphi_result_families; ANALYZE delphi_job_aliases;
        "#).unwrap();
        let zids: Vec<i32> = (2000..2100).collect();
        let inputs: Vec<String> = stored::INPUTS.iter().map(|s| (*s).to_owned()).collect();
        for (label, cursor) in [
            (
                "first",
                (
                    i32::MIN,
                    "-infinity",
                    "00000000-0000-0000-0000-000000000000",
                ),
            ),
            (
                "middle",
                (
                    2050,
                    "2026-01-01 00:03:20+00",
                    "00000000-0000-0000-0000-000000000000",
                ),
            ),
        ] {
            let plan = a
                .query(
                    &format!("EXPLAIN (ANALYZE, BUFFERS) {}", shadow_backfill::PAGE_SQL),
                    &[
                        &"shadow-bulk",
                        &zids,
                        &cursor.0,
                        &cursor.1,
                        &cursor.2,
                        &shadow_backfill::PAGE,
                        &shadow_backfill::RUN_KIND,
                        &inputs,
                        &stored::FAMILY,
                    ],
                )
                .unwrap()
                .iter()
                .map(|r| r.get::<_, String>(0))
                .collect::<Vec<_>>()
                .join("\n");
            println!("PLAN {label}\n{plan}");
        }
        let plan = a
            .query(
                &format!("EXPLAIN (ANALYZE, BUFFERS) {}", shadow_backfill::TODAY_SQL),
                &[&"shadow-bulk", &0f64, &shadow_backfill::DERIVED_KIND],
            )
            .unwrap()
            .iter()
            .map(|r| r.get::<_, String>(0))
            .collect::<Vec<_>>()
            .join("\n");
        println!("PLAN daily-broad-epoch-control\n{plan}");
        let today = (scheduler::now_ms().div_euclid(86_400_000) * 86_400) as f64;
        let plan = a
            .query(
                &format!("EXPLAIN (ANALYZE, BUFFERS) {}", shadow_backfill::TODAY_SQL),
                &[&"shadow-bulk", &today, &shadow_backfill::DERIVED_KIND],
            )
            .unwrap()
            .iter()
            .map(|r| r.get::<_, String>(0))
            .collect::<Vec<_>>()
            .join("\n");
        println!("PLAN daily-current-day\n{plan}");
        let keys: Vec<String> = (1..=200).map(|n| format!("derived/1:{n:064}")).collect();
        let plan = a
            .query(
                &format!(
                    "EXPLAIN (ANALYZE, BUFFERS) {}",
                    shadow_backfill::ALIASES_SQL
                ),
                &[&keys],
            )
            .unwrap()
            .iter()
            .map(|r| r.get::<_, String>(0))
            .collect::<Vec<_>>()
            .join("\n");
        println!("PLAN aliases\n{plan}");
        let def: String = a
            .query_one(
                "SELECT pg_get_functiondef('pq_class_depth(text,text)'::regprocedure)",
                &[],
            )
            .unwrap()
            .get(0);
        let sql = def
            .split_once(" SELECT count(*)")
            .unwrap()
            .1
            .split_once(";\n RETURN")
            .unwrap()
            .0;
        let sql = format!("SELECT count(*){sql}")
            .replace("INTO c FROM", "FROM")
            .replace("p_env", "'shadow-bulk'")
            .replace("p_worker_class", "'derived'");
        let plan = a
            .query(&format!("EXPLAIN (ANALYZE, BUFFERS) {sql}"), &[])
            .unwrap()
            .iter()
            .map(|r| r.get::<_, String>(0))
            .collect::<Vec<_>>()
            .join("\n");
        println!("PLAN class-depth-exact-body\n{plan}");
        let mut cursor = (
            i32::MIN,
            "-infinity".into(),
            "00000000-0000-0000-0000-000000000000".into(),
        );
        let mut seen = std::collections::BTreeSet::new();
        let mut tx = a.transaction().unwrap();
        loop {
            let rows = shadow_backfill::page(
                &mut tx,
                "shadow-bulk",
                &zids,
                &cursor,
                &stored::INPUTS,
                stored::FAMILY,
            )
            .unwrap();
            if rows.is_empty() {
                break;
            }
            for r in &rows {
                assert!(r.finished && r.complete && !r.own_map);
                assert!(seen.insert(r.job_id.clone()), "duplicate");
            }
            let last = rows.last().unwrap();
            cursor = (last.zid, last.created_at.clone(), last.job_id.clone());
        }
        assert_eq!(seen.len(), 40000);
        println!("PAGING: 40000 unique runs in 100 conversations");
    }

    /// On a database with no derived jobs, the switched-off scheduler's whole
    /// log lines equal those of the scheduler built from the base commit.
    #[test]
    #[ignore = "requires REVIEW_BASE_SHADOW: a polis-delphi-shadow binary built from the base commit"]
    fn review_process_exec_stop_and_off_log_parity() {
        use std::io::BufRead;
        use std::process::Stdio;
        use std::time::{Duration, Instant};
        let db = Db::new();
        let d = dir();
        let topic = PathBuf::from(env!("CARGO_BIN_EXE_polis-topic-map"));
        let shadow = topic.parent().unwrap().join("polis-delphi-shadow");
        let base = std::env::var("REVIEW_BASE_SHADOW")
            .map(PathBuf::from)
            .unwrap();
        let environment = |on: bool| {
            let mut m: HashMap<String, String> = [
                ("DELPHI_SHADOW_ENABLED", "1".to_string()),
                ("DELPHI_SHADOW_ENV", ENV.to_string()),
                ("QUEUE_DATABASE_URL", url_for(&db.name, &db.login)),
                (
                    "DELPHI_SHADOW_READ_DATABASE_URL",
                    url_for(&db.name, "postgres"),
                ),
                ("POLIS_JOBS_TRANSPORT", "loopback".into()),
                ("DELPHI_SHADOW_CODE_VERSION", "c".repeat(40)),
                (
                    "DELPHI_SHADOW_STATE_PATH",
                    d.join("state.json").display().to_string(),
                ),
                ("DELPHI_SHADOW_DISK_PATH", d.display().to_string()),
                (
                    "DELPHI_SHADOW_PAUSE_FILE",
                    d.join("pause").display().to_string(),
                ),
                ("DELPHI_SHADOW_DISK_FREE_MIN_MB", "0".into()),
                ("DELPHI_SHADOW_DISK_USED_MAX_PCT", "100".into()),
                ("DELPHI_SHADOW_PROBE_MAX_MS", "5000".into()),
                ("PATH", topic.parent().unwrap().display().to_string()),
                ("POLIS_JOBS_DERIVED_ADMISSION", "1".into()),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v))
            .collect();
            if on {
                m.insert("DELPHI_SHADOW_DERIVED_BACKFILL".into(), "1".into());
            }
            m
        };
        let run = |binary: &std::path::Path, on: bool, signal: &str| {
            let _ = std::fs::remove_file(d.join("state.json"));
            let mut child = Command::new(binary)
                .env_clear()
                .envs(environment(on))
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let out = child.stdout.take().unwrap();
            let err = child.stderr.take().unwrap();
            let errors = std::thread::spawn(move || {
                std::io::BufReader::new(err)
                    .lines()
                    .map_while(Result::ok)
                    .collect::<Vec<_>>()
            });
            let (send, recv) = std::sync::mpsc::channel();
            let read = std::thread::spawn(move || {
                let mut lines = vec![];
                for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                    lines.push(line.clone());
                    let _ = send.send(line);
                }
                lines
            });
            let end = Instant::now() + Duration::from_secs(20);
            let mut reached = false;
            while Instant::now() < end {
                if let Ok(line) = recv.recv_timeout(Duration::from_millis(100))
                    && line.contains(if on {
                        "\"event\":\"derived_inventory_empty\""
                    } else {
                        "\"event\":\"idle\""
                    })
                {
                    reached = true;
                    break;
                }
                if child.try_wait().unwrap().is_some() {
                    break;
                }
            }
            let process = Command::new("/bin/ps")
                .args(["-p", &child.id().to_string(), "-o", "command="])
                .output()
                .unwrap();
            println!(
                "PROCESS on={on}: {}",
                String::from_utf8_lossy(&process.stdout)
            );
            if on && reached {
                assert!(
                    String::from_utf8_lossy(&process.stdout)
                        .contains("polis-topic-map shadow-scheduler")
                );
            }
            let _ = Command::new("/bin/kill")
                .args([signal, &child.id().to_string()])
                .status();
            let status = child.wait().unwrap();
            let lines = read.join().unwrap();
            let errors = errors.join().unwrap();
            assert!(reached, "{status}: {lines:?} {errors:?}");
            assert_eq!(status.code(), Some(0));
            assert!(errors.is_empty(), "{errors:?}");
            assert!(lines.iter().any(|l| l.contains("\"event\":\"stopped\"")));
            let files = std::fs::read_dir(&d)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert_eq!(files, vec!["state.json"]);
            lines
        };
        let before = run(&base, false, "-TERM");
        let off = run(&shadow, false, "-TERM");
        assert_eq!(before, off, "off-path log bytes changed");
        println!("OFF PARITY: {} identical whole lines", off.len());
        for signal in ["-TERM", "-INT"] {
            let lines = run(&shadow, true, signal);
            println!(
                "ON {signal}: {} lines, exited 0, only state.json",
                lines.len()
            );
        }
        std::fs::write(d.join("state.json"), "invalid").unwrap();
        for on in [false, true] {
            let out = Command::new(&shadow)
                .env_clear()
                .envs(environment(on))
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(2));
            assert!(
                String::from_utf8_lossy(&out.stderr)
                    .starts_with("polis-delphi-shadow: state file:")
            );
        }
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn review_admission_off_returns_before_additional_set_reads_at_daily_cap() {
        scheduler::keep_lines();
        ALL.with(|a| a.borrow_mut().clear());
        let db = Db::new();
        let d = dir();
        let c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let asked = Rc::new(RefCell::new(Vec::new()));
        let mut off = counting(&asked, &[]);
        off.switched = false;
        let mut s = scheduler::Scheduler::new(&c).unwrap().with_admitter(off);
        s.state.roll_day(scheduler::now_ms());
        s.state.day_runs = c.daily_runs;
        s.state.storage.reconciled = true;
        // At the full-run daily cap the old scheduler never reads a roster or
        // current set. A disabled admission must not introduce those reads.
        db.admin()
            .batch_execute("ALTER TABLE comments RENAME TO held_comments")
            .unwrap();
        cycles(&mut s, 1);
        let lines = all();
        assert!(asked.borrow().is_empty());
        assert_eq!(s.derived.queries, 0);
        let _ = std::fs::remove_dir_all(d);
        assert!(
            events("derived_held", 0)
                .iter()
                .any(|l| l["reason"] == "admission_off"),
            "admission-off should return before set reads: {lines:?}"
        );
        assert!(
            !lines
                .iter()
                .any(|l| l.contains("derived_unread") || l.contains("roster_unread")),
            "unexpected set read: {lines:?}"
        );
    }

    fn review_cancelled_map(db: &Db) -> String {
        let run = support::run("biodiversity", 1424, Some(2));
        let src = db
            .writer_run("delphi", json!({"selection": RULE}), &run, false)
            .0;
        assert_eq!(
            TopicMap { get: on }
                .admit(
                    &mut db.executor(),
                    &Source {
                        env: ENV.into(),
                        job_id: src.job_id,
                        zid: 1424,
                        selection: Some(RULE.into()),
                    },
                    &"c".repeat(40)
                )
                .unwrap(),
            Outcome::Enqueued
        );
        let id = derived_job_ids(db)
            .into_iter()
            .find(|id| job_status(db, id) == "queued")
            .unwrap();
        cancel(db, &id);
        id
    }

    /// The scheduler's real save and load across the backfill's switch: on,
    /// off, on. Two budgets that never mix: the full runs' ledger is the same
    /// in every phase (no derived job is ever in it), and the derived jobs'
    /// bytes are one reading of the database, made only with the backfill on.
    #[test]
    fn review_storage_survives_switching_backfill_off() {
        use polis_queue_adapter::shadow::storage;
        scheduler::keep_lines();
        let db = Db::new();
        review_cancelled_map(&db);
        let d = dir();
        let on = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let asked = Rc::new(RefCell::new(Vec::new()));
        let mut s = scheduler::Scheduler::new(&on)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 2);
        let runs = s.state.storage.bytes;
        let derived = s.derived.stored.bytes().expect("read with the backfill on");
        assert_eq!(derived, storage::JOB_BYTES, "one cancelled derived job");
        s.state.save(&on.state_path).unwrap();
        drop(s);
        let off = cfg(&db, &d, &[]);
        let mut s = scheduler::Scheduler::new(&off).unwrap();
        let from = all().len();
        cycles(&mut s, 2);
        let during = s.state.storage.bytes;
        assert!(
            events("derived_storage", from).is_empty(),
            "off: no reading"
        );
        assert_eq!(s.derived.stored.read, None);
        s.state.save(&off.state_path).unwrap();
        drop(s);
        let mut s = scheduler::Scheduler::new(&on)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 2);
        let after = s.state.storage.bytes;
        let derived_after = s.derived.stored.bytes().unwrap();
        println!(
            "ON-OFF-ON: runs {runs} -> {during} -> {after}; derived {derived} -> {derived_after}"
        );
        std::fs::remove_dir_all(d).unwrap();
        assert_eq!(during, runs, "off: the full runs' ledger is unchanged");
        assert_eq!(after, runs, "on again: the full runs' ledger is unchanged");
        assert_eq!(
            derived_after, derived,
            "the derived reading does not move with the switch"
        );
    }

    /// A state file first listed with the backfill off, then read with it on,
    /// and a fresh state file listed with it on: the full runs' ledger is the
    /// same in all three (the listing never includes a derived job), and the
    /// derived job is counted once, by its own budget's reading.
    #[test]
    fn review_storage_counts_once_after_switching_backfill_on() {
        use polis_queue_adapter::shadow::storage;
        let db = Db::new();
        review_cancelled_map(&db);
        let d = dir();
        let c = cfg(&db, &d, &[]);
        let mut s = scheduler::Scheduler::new(&c).unwrap();
        cycles(&mut s, 2);
        let before = s.state.storage.bytes;
        s.state.save(&c.state_path).unwrap();
        drop(s);
        let c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let asked = Rc::new(RefCell::new(Vec::new()));
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 2);
        let after = s.state.storage.bytes;
        let fresh_dir = dir();
        let fc = cfg(&db, &fresh_dir, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let mut f = scheduler::Scheduler::new(&fc)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut f, 2);
        let fresh = f.state.storage.bytes;
        println!(
            "OFF-ON: runs before={before} after={after} fresh={fresh} derived={:?} fresh derived={:?}",
            s.derived.stored.bytes(),
            f.derived.stored.bytes()
        );
        std::fs::remove_dir_all(d).unwrap();
        std::fs::remove_dir_all(fresh_dir).unwrap();
        assert_eq!(after, before, "the full runs' ledger is unchanged");
        assert_eq!(fresh, before, "a fresh listing leaves the derived job out");
        assert_eq!(
            s.derived.stored.bytes(),
            Some(storage::JOB_BYTES),
            "counted once"
        );
        assert_eq!(f.derived.stored.bytes(), Some(storage::JOB_BYTES));
    }

    /// A full runs' ledger saved by an older release, whose listing counted a
    /// derived job as a run (built here from this release's own listing plus
    /// that job's measure, which is what the older listing measured): this
    /// release never adds to it, subtracts from it or rereads it, and the
    /// derived job's bytes are read apart, for their own budget. Neither
    /// number is ever the sum of the two.
    #[test]
    fn review_storage_old_ledger_is_kept_and_derived_read_apart() {
        use polis_queue_adapter::shadow::storage;
        let db = Db::new();
        let job = review_cancelled_map(&db);
        let d = dir();
        let c = cfg(&db, &d, &[]);
        let mut s = scheduler::Scheduler::new(&c).unwrap();
        cycles(&mut s, 2);
        let m = {
            let mut admin = db.admin();
            let mut tx = admin.transaction().unwrap();
            storage::measure(&mut tx, ENV, &job, 1424).unwrap().total()
        };
        let old = s.state.storage.bytes + m;
        s.state.storage.bytes = old;
        s.state.save(&c.state_path).unwrap();
        drop(s);
        let c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let asked = Rc::new(RefCell::new(Vec::new()));
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 3);
        println!(
            "OLD LEDGER: runs {old} -> {}; derived {:?}",
            s.state.storage.bytes,
            s.derived.stored.bytes()
        );
        std::fs::remove_dir_all(d).unwrap();
        assert_eq!(
            s.state.storage.bytes, old,
            "the saved ledger is kept as saved"
        );
        assert_eq!(s.derived.stored.bytes(), Some(storage::JOB_BYTES));
    }

    #[test]
    fn review_storage_finds_a_late_terminal_commit() {
        let db = Db::new();
        let template = review_cancelled_map(&db);
        let d = dir();
        // A genuine uncommitted row, with a simulated earlier completion clock:
        // no sleep is necessary to reproduce the completion/commit ordering.
        let mut admin = db.admin();
        let mut tx = admin.transaction().unwrap();
        tx.batch_execute("SET LOCAL session_replication_role=replica")
            .unwrap();
        tx.execute("INSERT INTO delphi_jobs SELECT (jsonb_populate_record(NULL::delphi_jobs, to_jsonb(j) || jsonb_build_object('job_id',gen_random_uuid(),'completed_at',j.completed_at - interval '121 seconds'))).* FROM delphi_jobs j WHERE job_id=$1::text::uuid", &[&template]).unwrap();
        let c = cfg(&db, &d, &[("DELPHI_SHADOW_DERIVED_BACKFILL", "1")]);
        let asked = Rc::new(RefCell::new(Vec::new()));
        let mut s = scheduler::Scheduler::new(&c)
            .unwrap()
            .with_admitter(counting(&asked, &[]));
        cycles(&mut s, 1);
        assert_eq!(s.derived.stored.read.unwrap().jobs, 1);
        tx.commit().unwrap();
        // The next beat (`storage::DERIVED_READ_MS`) reads again.
        s.derived.stored.read_ms -= polis_queue_adapter::shadow::storage::DERIVED_READ_MS;
        cycles(&mut s, 1);
        let measured = s.derived.stored.read.unwrap().jobs;
        let rows: i64 = db
            .admin()
            .query_one("SELECT count(*) FROM delphi_jobs WHERE kind='derived'", &[])
            .unwrap()
            .get(0);
        println!("LATE commit: rows={rows} measured={measured}");
        std::fs::remove_dir_all(d).unwrap();
        assert_eq!(
            measured, rows as u64,
            "committed terminal jobs must eventually be accounted"
        );
    }

    #[test]
    fn review_storage_large_restart_and_env_daily_count() {
        use polis_queue_adapter::shadow::{plan, storage};
        scheduler::keep_lines();
        ALL.with(|a| a.borrow_mut().clear());
        let db = Db::new();
        let template = review_cancelled_map(&db);
        let mut a = db.admin();
        // Planner and accounting-only filler, not real worker executions.
        a.batch_execute("SET session_replication_role=replica")
            .unwrap();
        a.execute("INSERT INTO delphi_jobs SELECT (jsonb_populate_record(NULL::delphi_jobs, to_jsonb(j) || jsonb_build_object('job_id',gen_random_uuid(),'zid',2000+g%100,'created_at','2026-01-01T00:00:00Z','completed_at','2026-01-01T00:00:00Z'::timestamptz + g*interval '1 second'))).* FROM delphi_jobs j CROSS JOIN generate_series(1,40000) g WHERE job_id=$1::text::uuid", &[&template]).unwrap();
        a.batch_execute("SET session_replication_role=origin; ANALYZE delphi_jobs")
            .unwrap();
        let now = scheduler::now_ms();
        let since = (now.div_euclid(86_400_000) * 86_400) as f64;
        let today: i64 = a
            .query_one(shadow_backfill::TODAY_SQL, &[&ENV, &since, &"derived"])
            .unwrap()
            .get(0);
        assert_eq!(today, 1);
        // A job outside every configured set still consumes this env's day;
        // a different env does not. Neither change touches participant data.
        a.batch_execute("SET session_replication_role=replica")
            .unwrap();
        a.execute(
            "UPDATE delphi_jobs SET zid=99999 WHERE job_id=$1::text::uuid",
            &[&template],
        )
        .unwrap();
        a.execute("INSERT INTO delphi_jobs SELECT (jsonb_populate_record(NULL::delphi_jobs,to_jsonb(j)||jsonb_build_object('job_id',gen_random_uuid(),'env','shadow-other'))).* FROM delphi_jobs j WHERE job_id=$1::text::uuid", &[&template]).unwrap();
        a.batch_execute("SET session_replication_role=origin")
            .unwrap();
        let today: i64 = a
            .query_one(shadow_backfill::TODAY_SQL, &[&ENV, &since, &"derived"])
            .unwrap()
            .get(0);
        assert_eq!(today, 1);
        // Each derived job's attempt, family and log lines, as a real one
        // stores them (one family of a 2.5 KB wire), for the reading's plan.
        a.batch_execute(
            "SET session_replication_role=replica;
             INSERT INTO polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome)
               SELECT env,gen_random_uuid(),job_id,gen_random_uuid(),1,'succeeded'
               FROM delphi_jobs WHERE kind='derived';
             INSERT INTO delphi_result_families(env,batch_id,family,codec_wire,content_sha,row_count)
               SELECT q.env,q.attempt_id,'topic_map',x.w,encode(sha256(convert_to(x.w,'UTF8')),'hex'),20
               FROM polis_queue_attempts q JOIN delphi_jobs j USING(env,job_id),
                    LATERAL (SELECT string_agg(md5(q.attempt_id::text||g::text),'')||chr(10) AS w
                             FROM generate_series(1,80) g) x
               WHERE j.kind='derived';
             INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line)
               SELECT q.env,q.attempt_id,s,'stdout','derived map stored'
               FROM polis_queue_attempts q JOIN delphi_jobs j USING(env,job_id),
                    generate_series(0,1) s WHERE j.kind='derived';
             SET session_replication_role=origin;
             ANALYZE delphi_jobs; ANALYZE polis_queue_attempts;
             ANALYZE delphi_result_families; ANALYZE polis_queue_logs",
        )
        .unwrap();
        let day = (now.div_euclid(86_400_000) * 86_400_000) as f64;
        for pass in ["first", "second"] {
            let started = std::time::Instant::now();
            let plan = a
                .query(
                    &format!(
                        "EXPLAIN (ANALYZE, BUFFERS) {}",
                        storage::derived_total_sql()
                    ),
                    &[&ENV, &day],
                )
                .unwrap();
            println!(
                "DERIVED TOTAL PLAN {pass} ({:?})\n{}",
                started.elapsed(),
                plan.iter()
                    .map(|r| r.get::<_, String>(0))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        let d = dir();
        let c = cfg(
            &db,
            &d,
            &[
                ("DELPHI_SHADOW_DERIVED_BACKFILL", "1"),
                ("DELPHI_SHADOW_DERIVED_STORAGE_BYTES", "1048576"),
            ],
        );
        let asked = Rc::new(RefCell::new(Vec::new()));
        for restart in 0..2 {
            let mut s = scheduler::Scheduler::new(&c)
                .unwrap()
                .with_admitter(counting(&asked, &[]));
            s.state.storage.reconciled = true;
            let from = all().len();
            cycles(&mut s, 1);
            let t = s.derived.stored.read.expect("read at the first cycle");
            assert_eq!(t.jobs, 40_001);
            assert_eq!(t.families, 40_001);
            assert_eq!(t.log_lines, 80_002);
            cycles(&mut s, 1);
            assert_eq!(
                events("derived_storage", from).len(),
                1,
                "one reading a beat"
            );
            assert!(asked.borrow().is_empty());
            assert_eq!(s.derived.queries, 0);
            let signals = polis_queue_adapter::shadow::db::Signals {
                probe_ms: 0.0,
                math_lag_ms: 0,
            };
            assert_eq!(
                plan::pause(
                    &c,
                    &s.state,
                    false,
                    Some(plan::Disk {
                        free_mb: u64::MAX,
                        used_pct: 0.0
                    }),
                    Some(&signals),
                    None
                ),
                None,
                "derived bytes never hold full runs (their budget at its default)"
            );
            s.state.save(&c.state_path).unwrap();
            println!(
                "RESTART {restart}: 40001 terminal jobs read in one statement at the first cycle ({} bytes), over the derived budget, full runs not held",
                t.bytes
            );
        }
        assert!(
            events("derived_held", 0)
                .iter()
                .any(|l| l["reason"] == "derived_storage_budget")
        );
        std::fs::remove_dir_all(d).unwrap();
    }
}
