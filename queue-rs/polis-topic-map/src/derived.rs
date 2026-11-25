//! A derived job: a job that reads one finished run's stored results and
//! writes only what it adds. The first operation is the topic map of a stored
//! run; the next ones are added here, in Rust, never as names in SQL.
//!
//! **Identity.** A derived job is named by its key: the full SHA-256 of a
//! canonical object holding the operation, the operation's version, the env
//! and the source job it reads, and nothing else (no asker, no time, no image,
//! no current pointer). The database keeps that key for good
//! (`pd_derived_admit`, migration 000050): two requests with the same key, at
//! once or a month apart, after a restart, whatever state the first job is in
//! (queued, running, succeeded, dead, cancelled), get the same job back. A
//! new operation version is a new key, and so a new job.
//!
//! **Source.** Admission refuses, with one word ([`Refusal::word`]), unless
//! the source is a succeeded run of the same env and conversation (checked in
//! SQL, under the key's lock) whose stored result holds the operation's
//! inputs, each produced by the source itself in one batch, under the comment
//! rule and with the hashes the asker declared (checked here, from the
//! source's own run record). The admitted job's configuration records what it
//! was made from (`config_effective.derived.source`) and the database records
//! the source as its declared input, so a reader can say "made by job Y from
//! run X".
//!
//! **Switch.** Nothing is admitted unless `POLIS_JOBS_DERIVED_ADMISSION=1`;
//! with it off, [`admit`] answers [`Refusal::SwitchedOff`] without touching
//! the database.
use crate::{from_run, stored};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The switch, default off.
pub const SWITCH: &str = "POLIS_JOBS_DERIVED_ADMISSION";
/// The schema of the object whose hash is the key.
pub const KEY_SCHEMA: &str = "polis-derived.key/1";
/// The schema of the specification stored with the job.
pub const SPEC_SCHEMA: &str = "polis-derived/1";
/// The admission actor every asker shares: who asked is never part of the
/// identity.
pub const ACTOR: &str = "derived";

/// A derived operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    /// The topic map of a stored run, from its UMAP positions, cluster
    /// assignments and topic names.
    TopicMap,
}

impl Operation {
    pub fn name(self) -> &'static str {
        match self {
            Self::TopicMap => "topic_map",
        }
    }
    /// The versions an executor exists for. A version changes only when what
    /// the operation makes from the same source would change.
    pub fn versions(self) -> &'static [u32] {
        match self {
            Self::TopicMap => &[1],
        }
    }
    /// The stored families the operation reads from its source.
    pub fn inputs(self) -> &'static [&'static str] {
        match self {
            Self::TopicMap => &stored::INPUTS,
        }
    }
}

/// Why a request was refused. Nothing is written for a refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `POLIS_JOBS_DERIVED_ADMISSION` is not `1`.
    SwitchedOff,
    /// The operation has no executor at this version.
    OperationVersion,
    /// The source job id is not a job id.
    SourceId,
    /// No job with that id.
    SourceMissing,
    /// The source is another env's.
    SourceEnv,
    /// The source is another conversation's than declared.
    SourceConversation,
    /// The source has not succeeded (or has no sealed output).
    SourceNotSucceeded,
    /// The source's result lacks an input, holds one twice, holds one another
    /// job produced, or holds them in different batches.
    SourceIncomplete,
    /// The source ran under another comment rule than declared.
    SourceRule,
    /// The source's stored inputs have other hashes than declared.
    SourceHash,
    /// The key is held by a job with another specification.
    KeyConflict,
}

impl Refusal {
    pub fn word(self) -> &'static str {
        match self {
            Self::SwitchedOff => "switched_off",
            Self::OperationVersion => "operation_version",
            Self::SourceId => "source_id",
            Self::SourceMissing => "source_missing",
            Self::SourceEnv => "source_env",
            Self::SourceConversation => "source_conversation",
            Self::SourceNotSucceeded => "source_not_succeeded",
            Self::SourceIncomplete => "source_incomplete",
            Self::SourceRule => "source_rule",
            Self::SourceHash => "source_hash",
            Self::KeyConflict => "key_conflict",
        }
    }
    fn from_word(word: &str) -> Option<Self> {
        [
            Self::SourceMissing,
            Self::SourceEnv,
            Self::SourceConversation,
            Self::SourceNotSucceeded,
        ]
        .into_iter()
        .find(|r| r.word() == word)
    }
}

/// One request for a derived job.
#[derive(Clone, Debug)]
pub struct Request {
    pub operation: Operation,
    pub version: u32,
    pub env: String,
    pub source_job_id: String,
    /// What the asker expects of the source; each is checked, none is part of
    /// the key.
    pub conversation_id: i32,
    /// The comment rule the source ran under (`None`: recorded without one).
    pub selection: Option<String>,
    /// The SHA-256 of each input family, in [`Operation::inputs`] order, when
    /// the asker has them.
    pub inputs_sha256: Option<Vec<String>>,
    /// Who asked: logged, never part of the identity.
    pub asker: String,
}

/// An admitted job: new, or the one the key already names.
#[derive(Clone, Debug, PartialEq)]
pub struct Admitted {
    pub job_id: String,
    pub state: String,
    pub key: String,
    /// The specification stored with the job (`config_effective.derived`).
    pub spec: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    Enqueued(Admitted),
    Existing(Admitted),
    Refused(Refusal),
}

/// A lowercase canonical job id, or `None` when `id` is not one.
pub fn canonical_job_id(id: &str) -> Option<String> {
    let id = id.to_ascii_lowercase();
    let ok = id.len() == 36
        && id.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    ok.then_some(id)
}

fn quoted(s: &str) -> String {
    Value::from(s).to_string()
}

/// The canonical object whose SHA-256 is the key: keys in sorted order, no
/// white space, the job id lowercase. Written out by hand so that no
/// serializer setting can change its bytes.
pub fn key_object(operation: Operation, version: u32, env: &str, source_job_id: &str) -> String {
    format!(
        "{{\"env\":{},\"operation\":{},\"schema\":{},\"source_job_id\":{},\"version\":{}}}",
        quoted(env),
        quoted(operation.name()),
        quoted(KEY_SCHEMA),
        quoted(&source_job_id.to_ascii_lowercase()),
        version
    )
}

/// The key: 64 lowercase hex characters.
pub fn key(operation: Operation, version: u32, env: &str, source_job_id: &str) -> String {
    hex(&Sha256::digest(
        key_object(operation, version, env, source_job_id).as_bytes(),
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The specification stored with the job: the key, what it was made from (all
/// read from the source's record, never from the asker), and nothing that
/// changes between two requests for the same key.
pub fn spec(req: &Request, key: &str, plan: &from_run::Plan) -> Value {
    let families: Vec<Value> = req
        .operation
        .inputs()
        .iter()
        .zip(&plan.inputs)
        .map(|(family, f)| {
            json!({"family": family, "artifact_id": f.artifact_id, "batch_id": f.batch_id, "sha256": f.sha256})
        })
        .collect();
    json!({
        "schema": SPEC_SCHEMA,
        "key": key,
        "operation": req.operation.name(),
        "version": req.version,
        "env": req.env,
        "source": {
            "job_id": plan.run.job_id,
            "run_id": plan.run.run_id,
            "batch_id": plan.run.batch_id,
            "conversation_id": plan.run.conversation_id,
            "scope": plan.run.scope,
            "selection": plan.run.selection,
            "families": families,
        },
    })
}

/// Checks the source's record against the request: the inputs are the
/// source's own, in one batch, under the declared rule and hashes.
pub fn check_source(req: &Request, record: &Value) -> Result<from_run::Plan, Refusal> {
    if record.is_null() {
        return Err(Refusal::SourceMissing);
    }
    let plan = from_run::plan(&req.env, &req.source_job_id, record).map_err(|_| {
        if record["state"].as_str().or(record["status"].as_str()) != Some("succeeded") {
            Refusal::SourceNotSucceeded
        } else {
            Refusal::SourceIncomplete
        }
    })?;
    if plan.run.conversation_id != i64::from(req.conversation_id) {
        return Err(Refusal::SourceConversation);
    }
    if plan.run.selection != req.selection {
        return Err(Refusal::SourceRule);
    }
    if let Some(expected) = &req.inputs_sha256 {
        let stored: Vec<&str> = plan.inputs.iter().map(|f| f.sha256.as_str()).collect();
        if expected.iter().map(String::as_str).ne(stored) {
            return Err(Refusal::SourceHash);
        }
    }
    Ok(plan)
}

fn reply_to_admission(reply: &Value, key: &str) -> Result<Admission, String> {
    let admitted = || -> Result<Admitted, String> {
        Ok(Admitted {
            job_id: reply["job_id"]
                .as_str()
                .ok_or("the admission reply names no job")?
                .to_owned(),
            state: reply["state"].as_str().unwrap_or_default().to_owned(),
            key: key.to_owned(),
            spec: reply["derived"].clone(),
        })
    };
    match reply["outcome"].as_str() {
        Some("enqueued") => Ok(Admission::Enqueued(admitted()?)),
        Some("existing") => Ok(Admission::Existing(admitted()?)),
        Some("conflict") => Ok(Admission::Refused(Refusal::KeyConflict)),
        Some("refused") => reply["reason"]
            .as_str()
            .and_then(Refusal::from_word)
            .map(Admission::Refused)
            .ok_or_else(|| format!("unknown refusal in {reply}")),
        _ => Err(format!("unexpected admission reply {reply}")),
    }
}

fn call(
    client: &mut postgres::Client,
    req: &Request,
    key: &str,
    spec: Option<&Value>,
    code: &str,
) -> Result<Value, String> {
    let spec = spec.map(Value::to_string);
    client
        .query_one(
            "SELECT public.pd_derived_admit($1,$2,$3::text::uuid,$4,$5::text::jsonb,$6)",
            &[
                &req.env,
                &key,
                &req.source_job_id,
                &req.conversation_id,
                &spec,
                &code,
            ],
        )
        .and_then(|row| row.try_get(0))
        .map_err(|e| format!("derived admission: {e}"))
}

/// One line on standard error for every answer, so a refusal is recorded
/// where the asker's other lines are.
fn log(req: &Request, key: Option<&str>, answer: &Result<Admission, String>) {
    let (outcome, detail) = match answer {
        Ok(Admission::Enqueued(a)) => ("enqueued", json!(a.job_id)),
        Ok(Admission::Existing(a)) => ("existing", json!(a.job_id)),
        Ok(Admission::Refused(r)) => ("refused", json!(r.word())),
        Err(e) => ("error", json!(e)),
    };
    eprintln!(
        "{}",
        json!({"event": "derived_admission", "outcome": outcome, "detail": detail,
            "operation": req.operation.name(), "version": req.version, "env": req.env,
            "source_job_id": req.source_job_id, "key": key, "asker": req.asker})
    );
}

/// The one admission path for every asker (scheduler, operator, test).
/// `get` reads the environment (the switch); `code` is the deployed build's
/// image digest (40 to 64 hex), recorded with the job, never part of its key.
/// `Err` is a database or transport failure; every refusal is `Ok`.
pub fn admit(
    client: &mut postgres::Client,
    get: impl Fn(&str) -> Option<String>,
    req: &Request,
    code: &str,
) -> Result<Admission, String> {
    let mut key_made = None;
    let answer = (|| {
        if get(SWITCH).as_deref() != Some("1") {
            return Ok(Admission::Refused(Refusal::SwitchedOff));
        }
        if !req.operation.versions().contains(&req.version) {
            return Ok(Admission::Refused(Refusal::OperationVersion));
        }
        let Some(source) = canonical_job_id(&req.source_job_id) else {
            return Ok(Admission::Refused(Refusal::SourceId));
        };
        let req = Request {
            source_job_id: source,
            ..req.clone()
        };
        let k = key(req.operation, req.version, &req.env, &req.source_job_id);
        key_made = Some(k.clone());
        // The key first: an existing job is the answer whatever its source
        // looks like now.
        // A refusal from the database (missing, other env or conversation,
        // not succeeded) also comes back here, before any record is read.
        let looked = call(client, &req, &k, None, code)?;
        if looked["outcome"] != "none" {
            return reply_to_admission(&looked, &k);
        }
        let record: Value = client
            .query_one(
                "SELECT public.pd_run_record($1,$2::text::uuid)",
                &[&req.env, &req.source_job_id],
            )
            .and_then(|row| row.try_get::<_, Option<Value>>(0))
            .map_err(|e| format!("source record: {e}"))?
            .unwrap_or(Value::Null);
        let plan = match check_source(&req, &record) {
            Ok(plan) => plan,
            Err(refusal) => return Ok(Admission::Refused(refusal)),
        };
        let spec = spec(&req, &k, &plan);
        reply_to_admission(&call(client, &req, &k, Some(&spec), code)?, &k)
    })();
    log(req, key_made.as_deref(), &answer);
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "00000000-0000-4000-8000-00000000a001";

    #[test]
    fn the_key_is_the_hash_of_operation_version_env_and_source_only() {
        let object = key_object(Operation::TopicMap, 1, "prod", SOURCE);
        assert_eq!(
            object,
            r#"{"env":"prod","operation":"topic_map","schema":"polis-derived.key/1","source_job_id":"00000000-0000-4000-8000-00000000a001","version":1}"#
        );
        let k = key(Operation::TopicMap, 1, "prod", SOURCE);
        assert_eq!(k.len(), 64);
        assert!(
            k.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert_eq!(
            k,
            key(Operation::TopicMap, 1, "prod", &SOURCE.to_uppercase())
        );
    }

    #[test]
    fn another_version_env_or_source_is_another_key() {
        let k = key(Operation::TopicMap, 1, "prod", SOURCE);
        assert_ne!(k, key(Operation::TopicMap, 2, "prod", SOURCE));
        assert_ne!(k, key(Operation::TopicMap, 1, "shadow", SOURCE));
        assert_ne!(
            k,
            key(
                Operation::TopicMap,
                1,
                "prod",
                "00000000-0000-4000-8000-00000000a002"
            )
        );
    }

    #[test]
    fn job_ids_are_checked_and_lowercased() {
        assert_eq!(
            canonical_job_id(&SOURCE.to_uppercase()).as_deref(),
            Some(SOURCE)
        );
        for bad in [
            "",
            "not-a-job",
            "00000000-0000-4000-8000-00000000a00g",
            "00000000000040008000000000000a001",
        ] {
            assert_eq!(canonical_job_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn every_refusal_word_is_one_word() {
        for r in [
            Refusal::SwitchedOff,
            Refusal::OperationVersion,
            Refusal::SourceId,
            Refusal::SourceMissing,
            Refusal::SourceEnv,
            Refusal::SourceConversation,
            Refusal::SourceNotSucceeded,
            Refusal::SourceIncomplete,
            Refusal::SourceRule,
            Refusal::SourceHash,
            Refusal::KeyConflict,
        ] {
            assert!(
                r.word()
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_')
            );
        }
    }
}
