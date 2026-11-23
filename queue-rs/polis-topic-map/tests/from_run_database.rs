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
