//! `polis-topic-map from-run`: the map of a run stored before the step was
//! switched on, made from that run's own stored families.
//!
//! It reads, on one connection in one read-only snapshot, the run record
//! (`pd_run_record`) and the codec files of the three families the map is
//! drawn from (`pd_result_artifact_wire`, each from the batch the record
//! names), then calls [`stored::store`], the function the pipeline's step
//! calls. So for one run the two write the same bytes: the step from the
//! families it has just written, this from the same families as stored.
//!
//! A stored batch is immutable, so this never writes to the database: it
//! writes the family's codec file (and the document) to a directory. When the
//! run's batch already holds a map (the step was on), it also says whether
//! the stored map equals the one made here.
use crate::stored::{self, RunIdentity, Wires};
use serde_json::Value;

/// One family as the run record names it.
#[derive(Clone, Debug, PartialEq)]
pub struct FamilyRef {
    pub artifact_id: String,
    pub batch_id: String,
    pub sha256: String,
}

/// What a run record says about a run's map: who it belongs to, where its
/// three input families are, and where its stored map is, if it has one.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub run: RunIdentity,
    /// The three input families, in [`stored::INPUTS`] order.
    pub inputs: Vec<FamilyRef>,
    pub stored: Option<FamilyRef>,
}

fn field<'v>(v: &'v Value, key: &str) -> Result<&'v str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("the run record has no {key}"))
}

/// The plan for one run, from its record (`pd_run_record(env, job)`).
/// Refuses a run that has not succeeded, and a run that did not produce one
/// of the three families itself (a family carried forward from an earlier
/// batch is another run's), or produced them in different batches.
pub fn plan(env: &str, job: &str, record: &Value) -> Result<Plan, String> {
    if record.is_null() {
        return Err(format!("no job {job} in env {env}"));
    }
    if field(record, "job_id")? != job {
        return Err("the run record is another job's".into());
    }
    let state = record["state"]
        .as_str()
        .or_else(|| record["status"].as_str())
        .unwrap_or_default();
    if state != "succeeded" {
        return Err(format!("the run has not succeeded (state {state})"));
    }
    let zid = record["zid"]
        .as_i64()
        .ok_or("the run record has no conversation")?;
    let families = record["families"]
        .as_array()
        .ok_or("the run record lists no families")?;
    let find = |name: &str| -> Result<Option<(String, FamilyRef)>, String> {
        let mut found = families.iter().filter(|f| f["family"] == name);
        let Some(f) = found.next() else {
            return Ok(None);
        };
        if found.next().is_some() {
            return Err(format!("the run record lists {name} twice"));
        }
        Ok(Some((
            field(f, "job_id")?.to_owned(),
            FamilyRef {
                artifact_id: field(f, "artifact_id")?.to_owned(),
                batch_id: field(f, "batch_id")?.to_owned(),
                sha256: field(f, "content_sha256")?.to_owned(),
            },
        )))
    };
    let mut inputs = Vec::new();
    for name in stored::INPUTS {
        let (producer, family) = find(name)?.ok_or_else(|| format!("the run stored no {name}"))?;
        if producer != job {
            return Err(format!(
                "the run did not produce its own {name} (it is job {producer}'s)"
            ));
        }
        inputs.push(family);
    }
    let batch_id = inputs[0].batch_id.clone();
    if inputs.iter().any(|f| f.batch_id != batch_id) {
        return Err("the run's families are in different batches".into());
    }
    let stored = find(stored::FAMILY)?
        .filter(|(producer, _)| producer == job)
        .map(|(_, f)| f);
    let config = &record["config_effective"];
    let scope = config["result_scope"]
        .as_str()
        .ok_or("the run names no result scope")?
        .to_owned();
    let selection = match &config["selection"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => return Err("the run's selection is not a name".into()),
    };
    Ok(Plan {
        run: RunIdentity {
            env: env.to_owned(),
            job_id: job.to_owned(),
            run_id: field(record, "run_id")?.to_owned(),
            batch_id,
            conversation_id: zid,
            scope,
            selection,
            models: record["manifest"]["models"].clone(),
            // Read from the run's own stored map when it has one (`read`).
            execution: stored::execution_unavailable(BEFORE_THE_STEP),
        },
        inputs,
        stored,
    })
}

/// Why a run stored before the step has no execution record.
pub const BEFORE_THE_STEP: &str = "the run was stored before its steps were recorded with its map";

/// A run's map made again from its stored families.
pub struct Made {
    pub stored: stored::Stored,
    /// The batch's own map family, when it has one.
    pub already: Option<String>,
}

/// Read one run and make its map. One read-only, repeatable-read
/// transaction, so the record and the families are one snapshot.
pub fn read(client: &mut postgres::Client, env: &str, job: &str) -> Result<Made, String> {
    let db = |e: postgres::Error| format!("database: {e}");
    let mut tx = client
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .map_err(db)?;
    tx.batch_execute("SET LOCAL statement_timeout='120s'")
        .map_err(db)?;
    let record: Option<Value> = tx
        .query_one("SELECT pd_run_record($1,$2::text::uuid)", &[&env, &job])
        .map_err(db)?
        .get(0);
    let mut plan = plan(env, job, &record.unwrap_or(Value::Null))?;
    let mut wire = |name: &str, f: &FamilyRef| -> Result<String, String> {
        let row = tx
            .query_one(
                "SELECT w->>'wire', w->>'batch_id', w->>'sha256' \
                 FROM (SELECT pd_result_artifact_wire($1,($2::text)::uuid,$3) AS w) s",
                &[&env, &f.artifact_id, &name],
            )
            .map_err(db)?;
        let (text, batch, sha): (Option<String>, Option<String>, Option<String>) =
            (row.get(0), row.get(1), row.get(2));
        if batch.as_deref() != Some(f.batch_id.as_str())
            || sha.as_deref() != Some(f.sha256.as_str())
        {
            return Err(format!("{name} is not the batch the run record names"));
        }
        text.ok_or_else(|| format!("{name} has no stored bytes"))
    };
    let positions = wire(stored::POSITIONS, &plan.inputs[0])?;
    let assignments = wire(stored::ASSIGNMENTS, &plan.inputs[1])?;
    let names = wire(stored::NAMES, &plan.inputs[2])?;
    let already = match &plan.stored {
        Some(f) => Some(wire(stored::FAMILY, f)?),
        None => None,
    };
    drop(tx);
    // The run's execution record is the one it stored with its map; a run
    // stored before the step says it has none.
    if let Some(wire) = &already {
        plan.run.execution = stored::stored_execution(wire)?.unwrap_or_else(|| {
            stored::execution_unavailable("the run's stored map holds no execution record")
        });
    }
    let stored = stored::store(
        &plan.run,
        &Wires {
            positions: &positions,
            assignments: &assignments,
            names: &names,
        },
    )?;
    Ok(Made { stored, already })
}

/// The queue login the Delphi daemon uses, from the same settings
/// (`QUEUE_DATABASE_URL`, `POLIS_JOBS_TRANSPORT`, `POLIS_JOBS_CA_FILE`,
/// `POLIS_JOBS_HOST_ALLOWLIST`, `POLIS_JOBS_PASSWORD_FILE`) and the same
/// transport rules. Only `pd_run_record` and `pd_result_artifact_wire` are
/// called, both granted to that login.
pub fn connect(get: impl Fn(&str) -> Option<String>) -> Result<postgres::Client, String> {
    use polis_queue_adapter::jobs::config::TransportKind;
    let dsn = get("QUEUE_DATABASE_URL")
        .filter(|s| !s.trim().is_empty())
        .ok_or("QUEUE_DATABASE_URL is required")?;
    let transport = match get("POLIS_JOBS_TRANSPORT").as_deref().unwrap_or("tls") {
        "tls" => TransportKind::Tls {
            ca_file: get("POLIS_JOBS_CA_FILE")
                .filter(|s| !s.is_empty())
                .ok_or("tls transport requires POLIS_JOBS_CA_FILE")?
                .into(),
            host_allowlist: get("POLIS_JOBS_HOST_ALLOWLIST")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        },
        "local" => TransportKind::Local,
        "loopback" => TransportKind::Loopback,
        _ => return Err("POLIS_JOBS_TRANSPORT must be tls, local or loopback".into()),
    };
    let password = get("POLIS_JOBS_PASSWORD_FILE")
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    polis_queue_adapter::jobs::transport::Connector::from_parts(
        &dsn,
        &transport,
        password.as_deref(),
        "polis-topic-map/1",
    )
    .and_then(|c| c.connect())
    .map_err(|e| e.to_string())
}
