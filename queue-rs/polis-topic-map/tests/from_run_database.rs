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
        let release = polis_migrate::load(&root).unwrap();
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
}
