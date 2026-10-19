//! `GET`/`HEAD /api/v3/delphi/run?job_id=<uuid>`: one Delphi job's run record
//! (`delphi-run/1`) for a moderator of the job's conversation.
//!
//! The record is one call to `pd_run_record(env, job)` (migration 000041) on
//! this route's own bounded pool, a login in `polis_queue_executor`; that
//! function reads the record in one statement, so its fields are one
//! snapshot. Identity, the moderator rule and the conversation's zinvite are
//! read on a second bounded pool (Node's read login by default). Neither pool
//! is a participation pool, and no connection is held across another call.
//!
//! The rule is Node's `GET /api/v3/delphi/logs`: `hybridAuth`, then
//! `isModerator(zid, uid)` for the job's conversation. Without a bearer token
//! the answer is `hybridAuth`'s 401; a token this process cannot verify hands
//! the request back (502), so no identity is ever built here from an
//! unverified claim. Rust-only: Node has no handler for the path, so a hand
//! back reaches Node's 404.
use crate::delphi_job_result::{
    AttemptNumber, ConversationId, Failure, FailureCode, JobPromptVersions, MathEnv, MathTick,
    ModelName, ReportId, Timestamp,
};
use crate::delphi_run::{
    Attempt, AttemptId, AttemptOutcome, CodeVersion, Computation, ContractVersion, DelphiRun,
    DelphiRunFields, FamilyBatch, FamilyOutput, FamilyOutputs, FamilyPublication, FamilyState,
    Generation, GraphId, GraphNode, JobId, JobKind, LeaseEpoch, MaxAttempts, Origin,
    ProviderRequest, ResultFamily, RunCost, RunId, RunInputs, RunModels, RunOutputs, RunRef,
    ScopeKey, Sha256, Stage, StageState, UpstreamInput, VoteHighWaterMark,
};
use crate::wire::{Invalid, JsMap, Json};
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use serde::Deserialize;
use std::collections::BTreeMap;
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/delphi_run_read.rs"]
mod contract;
pub use contract::PATH;

/// The request after the method, body and query checks, with the raw
/// `Authorization` header.
pub struct Parsed {
    authorization: Option<String>,
    request: contract::Request,
}

pub fn parse(app: &App, req: &Request) -> Option<Parsed> {
    if app.delphi_run_db.is_none()
        || app.delphi_run_auth_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
    {
        return None;
    }
    let raw = req.query().unwrap_or("");
    if raw.len() > 1024 {
        return None;
    }
    // Exactly one plain `job_id` (or none). Any other parameter, a repeat or
    // a structured key stays with Node.
    let mut job_id = None;
    let mut seen = false;
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if k != "job_id" || seen || v.len() > 100 {
            return None;
        }
        seen = true;
        if !v.is_empty() {
            job_id = Some(v.into_owned());
        }
    }
    Some(Parsed {
        authorization: req.headers.get("authorization").map(str::to_owned),
        request: contract::Request { job_id },
    })
}

/// The record read: two slots, one statement each. The function walks the
/// job's publication chain, so its statement timeout is the route's widest.
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: std::time::Duration::from_millis(50),
        statement_timeout: std::time::Duration::from_millis(2000),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}

/// Identity, moderator rule and zinvite: indexed single-row reads.
pub fn auth_pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(50),
        statement_timeout: std::time::Duration::from_millis(100),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}

/// The whole request, from the first read to the encoded record.
const DEADLINE: std::time::Duration = std::time::Duration::from_millis(2500);

enum Answer {
    Unauthenticated,
    Missing,
    NotFound,
    Denied,
    Record(String),
}

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Ok(Some(answer)) = tokio::time::timeout(DEADLINE, answer(app, query)).await else {
        return route::bad_gateway();
    };
    let (status, body) = match answer {
        Answer::Unauthenticated => (401, to_json(&contract::Unauthenticated::no_token())),
        Answer::Missing => (400, to_json(&contract::Refusal::missing())),
        Answer::NotFound => (404, to_json(&contract::Refusal::not_found())),
        Answer::Denied => (403, to_json(&contract::Refusal::denied())),
        Answer::Record(bytes) => (200, Some(bytes)),
    };
    match body {
        Some(body) => route::json_text(req, res, status, body),
        None => route::bad_gateway(),
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Option<String> {
    crate::wire::to_json(value).ok()
}

/// `None` hands the request back to Node.
async fn answer(app: &App, query: Parsed) -> Option<Answer> {
    let (Some(pool), Some(auth_pool)) = (&app.delphi_run_db, &app.delphi_run_auth_db) else {
        return None;
    };
    // hybridAuth runs before the handler: no bearer token, no job lookup.
    let Some(raw) = query
        .authorization
        .as_deref()
        .filter(|h| h.starts_with("Bearer "))
    else {
        return Some(Answer::Unauthenticated);
    };
    let uid = crate::hybrid_read::resolve(
        Some(raw),
        app.participant_verifier.as_deref(),
        app.read_oidc.as_deref(),
        auth_pool,
    )
    .await?
    .uid()?;
    let Some(job_id) = query.request.job_id else {
        return Some(Answer::Missing);
    };
    // Job ids are lowercase canonical uuids; any other spelling names no job.
    let Ok(job) = JobId::new(job_id) else {
        return Some(Answer::NotFound);
    };
    let env = app.delphi_run_env.clone();
    let job_text = job.as_str().to_owned();
    let text = pool
        .with(move |c| {
            Ok(c.query_one(
                "SELECT pd_run_record($1::text,($2::text)::uuid)::text",
                &[&env, &job_text],
            )?
            .try_get::<_, Option<String>>(0)?)
        })
        .await
        .ok()?;
    let Some(text) = text else {
        return Some(Answer::NotFound);
    };
    let raw: Raw = serde_json::from_str(&text).ok()?;
    let zid = raw.zid;
    let admins = app.legacy_admin_uids.clone();
    let (permitted, zinvite) = auth_pool
        .with(move |c| {
            let permitted = crate::treevite_read::permits(c, zid, uid, &admins)?;
            let zinvite = c
                .query_opt(
                    "SELECT zinvite FROM zinvites WHERE zid=$1 ORDER BY created ASC NULLS LAST, zinvite ASC LIMIT 1",
                    &[&zid],
                )?
                .map(|r| r.try_get::<_, String>(0))
                .transpose()?;
            Ok((permitted, zinvite))
        })
        .await
        .ok()?;
    if !permitted {
        return Some(Answer::Denied);
    }
    let conversation = ConversationId::new(zinvite?).ok()?;
    let run = record(raw, conversation).ok()?;
    Some(Answer::Record(crate::wire::to_json(&run).ok()?))
}

// --- the function's document -----------------------------------------------

/// `pd_run_record`'s object. Field names are the function's.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Raw {
    job_id: JobId,
    zid: i32,
    report_id: Option<ReportId>,
    origin: Origin,
    kind: JobKind,
    run_id: Option<RunId>,
    parent_job_id: Option<JobId>,
    status: StageState,
    pinned: bool,
    created_at: Timestamp,
    completed_at: Option<Timestamp>,
    config_effective: JsMap<String, Json>,
    code_version: Option<CodeVersion>,
    manifest_sha256: Option<Sha256>,
    stage: Option<Stage>,
    state: Option<StageState>,
    max_attempts: Option<u8>,
    last_error_code: Option<String>,
    attempt: Option<RawAttempt>,
    graph: Option<RawGraph>,
    nodes: Vec<RawNode>,
    manifest: Option<RawManifest>,
    provider_requests: Vec<ProviderRequest>,
    families: Vec<RawFamily>,
    /// For each artifact that produced a listed batch, the run each family
    /// resolves to in that artifact's own bundle.
    bundles: BTreeMap<String, BTreeMap<String, RawRef>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAttempt {
    attempt_id: AttemptId,
    number: u32,
    lease_epoch: u64,
    outcome: AttemptOutcome,
    started_at: Timestamp,
    ended_at: Option<Timestamp>,
    process_exit_confirmed_at: Option<Timestamp>,
    error_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGraph {
    graph_id: GraphId,
    root_job_id: JobId,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNode {
    job_id: JobId,
    run_id: RunId,
    stage: Stage,
    state: StageState,
    max_attempts: u8,
    attempt: Option<RawAttempt>,
}

/// The finalized output manifest's `inputs`, `models` and `cost`
/// (`polis-jobs.output-manifest/1` and `/2`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    inputs: Option<RawInputs>,
    models: Option<RawModels>,
    cost: Option<RawCost>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInputs {
    math_env: Option<MathEnv>,
    math_tick: Option<MathTick>,
    math_caching_tick: Option<MathTick>,
    comment_set_sha256: Option<Sha256>,
    vote_hwm: Option<VoteHighWaterMark>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawModels {
    embed: Option<ModelName>,
    topic: Option<ModelName>,
    narrative: Option<ModelName>,
    /// The clustering's model id and seed: only on the manifest of a run that
    /// clustered (the daemon accepts the two together or neither).
    #[serde(default)]
    cluster: Option<ModelName>,
    #[serde(default)]
    cluster_seed: Option<u64>,
}

/// `provider_batches` is not read: the record's provider requests are the
/// executor's own rows, recorded before each submission.
#[derive(Debug, Deserialize)]
struct RawCost {
    llm_tokens_in: Option<u64>,
    llm_tokens_out: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFamily {
    family: String,
    batch_id: AttemptId,
    job_id: JobId,
    run_id: Option<RunId>,
    origin: Origin,
    content_sha256: Sha256,
    row_count: u64,
    scope: Option<ScopeKey>,
    generation: Option<u64>,
    served: bool,
    /// The artifact the batch belongs to (a key of `bundles`).
    artifact_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRef {
    job_id: JobId,
    run_id: Option<RunId>,
}

fn missing(what: &str) -> Invalid {
    Invalid(format!("{what} is not recorded"))
}

fn to_attempt(a: RawAttempt, max_attempts: Option<u8>) -> Result<Attempt, Invalid> {
    Ok(Attempt {
        attempt_id: a.attempt_id,
        number: AttemptNumber::new(a.number)?,
        lease_epoch: LeaseEpoch::new(a.lease_epoch)?,
        max_attempts: MaxAttempts::new(max_attempts.ok_or_else(|| missing("max_attempts"))?)?,
        outcome: a.outcome,
        started_at: a.started_at,
        ended_at: a.ended_at,
        process_exit_confirmed_at: a.process_exit_confirmed_at,
    })
}

/// A failure code is the recorded code's name before any `:` detail, when it
/// is one of the contract's closed codes; a cancelled job's is `cancelled`.
/// Anything else is not a recorded failure code, and the failure is `null`.
fn failure(
    state: StageState,
    last: Option<(&Attempt, Option<&str>)>,
    job_code: Option<&str>,
) -> Option<Failure> {
    let (attempt, attempt_code) = last?;
    let at = attempt.ended_at.clone()?;
    let code = match state {
        StageState::Cancelled => FailureCode::Cancelled,
        StageState::Dead => {
            let name = attempt_code.or(job_code)?.split(':').next()?;
            FailureCode::ALL
                .into_iter()
                .filter(|c| *c != FailureCode::Cancelled)
                .find(|c| {
                    serde_json::to_value(c)
                        .ok()
                        .is_some_and(|v| v.as_str() == Some(name))
                })?
        }
        _ => return None,
    };
    Some(Failure {
        code,
        stage: None,
        attempt: attempt.number,
        at,
    })
}

/// Builds the record. Not recorded anywhere yet, so always `null`: the math
/// snapshot, the statement model, prompt versions and the label. The
/// clustering model and seed are the manifest's, `null` when it names none.
pub fn record(raw: Raw, conversation_id: ConversationId) -> Result<DelphiRun, Invalid> {
    let state = raw.state.unwrap_or(raw.status);
    let attempt_code = raw.attempt.as_ref().and_then(|a| a.error_code.clone());
    let attempt = raw
        .attempt
        .map(|a| to_attempt(a, raw.max_attempts))
        .transpose()?;
    let failure = failure(
        state,
        attempt.as_ref().map(|a| (a, attempt_code.as_deref())),
        raw.last_error_code.as_deref(),
    );
    let nodes = raw
        .nodes
        .into_iter()
        .map(|n| {
            Ok(GraphNode {
                job_id: n.job_id,
                run_id: n.run_id,
                stage: n.stage,
                state: n.state,
                attempt: n
                    .attempt
                    .map(|a| to_attempt(a, Some(n.max_attempts)))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, Invalid>>()?;
    let (inputs, models, cost) = match raw.manifest {
        Some(m) => (m.inputs, m.models, m.cost),
        None => (None, None, None),
    };
    let mut families = FamilyOutputs::new();
    for f in raw.families {
        let family = ResultFamily::parse(&f.family)
            .ok_or_else(|| Invalid(format!("{} is not a result family", f.family)))?;
        // The full pipeline clears the retired math families with an empty
        // copy each run; no new run produces a legacy family, so an empty one
        // from a queued run is not listed.
        if matches!(family, ResultFamily::Legacy(_))
            && f.origin == Origin::Queued
            && f.row_count == 0
        {
            continue;
        }
        let resolved = raw
            .bundles
            .get(&f.artifact_id)
            .ok_or_else(|| missing(&format!("the bundle of {}", f.family)))?;
        let upstream = family
            .upstream()
            .iter()
            .map(|u| {
                let r = resolved
                    .get(u.as_str())
                    .ok_or_else(|| missing(&format!("the {} run of {}", u.as_str(), f.family)))?;
                Ok(UpstreamInput {
                    family: *u,
                    job_id: r.job_id.clone(),
                    run_id: r.run_id.clone(),
                })
            })
            .collect::<Result<Vec<_>, Invalid>>()?;
        let computation = Computation {
            producer: RunRef {
                job_id: f.job_id,
                run_id: f.run_id,
            },
            upstream,
        };
        let batch = FamilyBatch {
            batch_id: f.batch_id,
            content_sha256: f.content_sha256,
            row_count: f.row_count,
        };
        let publication = FamilyPublication {
            scope: f.scope.ok_or_else(|| missing("a publication scope"))?,
            generation: Generation::new(
                f.generation
                    .ok_or_else(|| missing("a publication generation"))?,
            )?,
        };
        let state = if f.served {
            FamilyState::Succeeded {
                computation,
                batch,
                publication,
            }
        } else {
            FamilyState::Superseded {
                computation,
                batch,
                publication,
            }
        };
        families.insert(FamilyOutput { family, state })?;
    }
    let models = models.map_or(
        RunModels {
            embedding: None,
            cluster: None,
            cluster_seed: None,
            topic_names: None,
            narrative: None,
            statement: None,
        },
        |m| RunModels {
            embedding: m.embed,
            cluster: m.cluster,
            cluster_seed: m.cluster_seed,
            topic_names: m.topic,
            narrative: m.narrative,
            statement: None,
        },
    );
    let (root_job_id, graph_id) = match raw.graph {
        Some(g) => (g.root_job_id, Some(g.graph_id)),
        None => (raw.job_id.clone(), None),
    };
    DelphiRun::new(DelphiRunFields {
        contract_version: ContractVersion,
        job_id: raw.job_id,
        run_id: raw.run_id,
        root_job_id,
        parent_job_id: raw.parent_job_id,
        graph_id,
        conversation_id,
        report_id: raw.report_id,
        origin: raw.origin,
        kind: raw.kind,
        stage: raw.stage,
        state,
        attempt,
        nodes,
        math_snapshot: None,
        inputs: inputs.map(|i| RunInputs {
            math_env: i.math_env,
            math_tick: i.math_tick,
            math_caching_tick: i.math_caching_tick,
            comment_set_sha256: i.comment_set_sha256,
            vote_hwm: i.vote_hwm,
        }),
        config_effective: raw.config_effective,
        code_version: raw.code_version,
        models,
        prompt_versions: JobPromptVersions {
            topic_names: None,
            narrative: None,
            statement: None,
        },
        outputs: RunOutputs {
            manifest_sha256: raw.manifest_sha256,
            families,
        },
        cost: RunCost {
            llm_tokens_in: cost.as_ref().and_then(|c| c.llm_tokens_in),
            llm_tokens_out: cost.as_ref().and_then(|c| c.llm_tokens_out),
            provider_requests: raw.provider_requests,
        },
        pinned: raw.pinned,
        label: None,
        created_at: raw.created_at,
        completed_at: raw.completed_at,
        failure,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONVERSATION: &str = "local-dynamo-1424";
    /// pd_run_record's output and the route's bytes for three jobs of one
    /// real local sequence (delphi-run-run.sh): a full pipeline run, a
    /// collective-statement save over its topics, and a second full
    /// pipeline run, read after all three finished.
    const FIXTURES: [(&str, &str, &str); 3] = [
        (
            "first",
            include_str!("../conformance/delphi-run-fixtures/first.record.json"),
            include_str!("../conformance/delphi-run-fixtures/first.json"),
        ),
        (
            "statement",
            include_str!("../conformance/delphi-run-fixtures/statement.record.json"),
            include_str!("../conformance/delphi-run-fixtures/statement.json"),
        ),
        (
            "second",
            include_str!("../conformance/delphi-run-fixtures/second.record.json"),
            include_str!("../conformance/delphi-run-fixtures/second.json"),
        ),
    ];

    fn raw(text: &str) -> Raw {
        serde_json::from_str(text).unwrap()
    }
    fn conversation() -> ConversationId {
        ConversationId::new(CONVERSATION).unwrap()
    }
    fn value(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn the_records_of_a_real_sequence_are_byte_stable() {
        for (name, record_text, golden) in FIXTURES {
            let run = record(raw(record_text), conversation()).unwrap();
            let bytes = crate::wire::to_json(&run).unwrap();
            assert_eq!(bytes, golden.trim_end(), "{name}");
            // The golden bytes are a delphi-run/1 record in their own right.
            let decoded: DelphiRun = serde_json::from_str(golden).unwrap();
            assert_eq!(crate::wire::to_json(&decoded).unwrap(), bytes, "{name}");
        }
    }

    #[test]
    fn family_states_follow_the_served_pointer() {
        let first = value(FIXTURES[0].2);
        let statement = value(FIXTURES[1].2);
        let second = value(FIXTURES[2].2);
        let states = |v: &serde_json::Value| -> Vec<(String, String)> {
            v["outputs"]["families"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    (
                        f["family"].as_str().unwrap().to_owned(),
                        f["state"].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        };
        // The second run replaced every family the first produced.
        assert!(states(&first).iter().all(|(_, s)| s == "superseded"));
        assert!(!states(&first).is_empty());
        // The statement is still served; the first run's families it carried are not.
        for (family, state) in states(&statement) {
            let expected = if family == "Delphi_CollectiveStatement" {
                "succeeded"
            } else {
                "superseded"
            };
            assert_eq!(state, expected, "{family}");
        }
        assert!(states(&second).iter().all(|(_, s)| s == "succeeded"));
        // The statement was written over the first run's topics, also on the
        // second run's record, which carries it.
        let topics_run = first["job_id"].as_str().unwrap();
        for v in [&statement, &second] {
            let carried = v["outputs"]["families"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["family"] == "Delphi_CollectiveStatement")
                .unwrap();
            assert_eq!(carried["producer"]["job_id"], statement["job_id"]);
            assert_eq!(carried["upstream"][0]["job_id"], topics_run);
        }
        // Generations: the first run published 1, the statement 2, the second 3.
        let generation = |v: &serde_json::Value, family: &str| {
            v["outputs"]["families"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["family"] == family)
                .unwrap()["publication"]["generation"]
                .as_u64()
                .unwrap()
        };
        assert_eq!(generation(&first, "Delphi_UMAPGraph"), 1);
        assert_eq!(generation(&second, "Delphi_CollectiveStatement"), 2);
        assert_eq!(generation(&second, "Delphi_UMAPGraph"), 3);
    }

    #[test]
    fn not_recorded_fields_are_null_never_invented() {
        for (name, _, golden) in FIXTURES {
            let v = value(golden);
            assert!(v["math_snapshot"].is_null(), "{name}");
            assert!(v["label"].is_null(), "{name}");
            for key in ["topic_names", "narrative", "statement"] {
                assert!(v["prompt_versions"][key].is_null(), "{name} {key}");
            }
            assert!(v["models"]["statement"].is_null(), "{name}");
            // These runs' manifests name no clustering, so neither does the record.
            for key in ["cluster", "cluster_seed"] {
                assert!(v["models"][key].is_null(), "{name} {key}");
            }
        }
        // A synchronous save has no manifest, so no inputs and no models.
        let statement = value(FIXTURES[1].2);
        assert!(statement["inputs"].is_null());
        assert!(statement["models"]["embedding"].is_null());
    }

    #[test]
    fn a_manifest_that_names_its_clustering_names_it_on_the_record() {
        let mut doc = value(FIXTURES[0].1);
        doc["manifest"]["models"]["cluster"] = "delphi-umap-evoc/1".into();
        doc["manifest"]["models"]["cluster_seed"] = 42.into();
        let run = record(serde_json::from_value(doc.clone()).unwrap(), conversation()).unwrap();
        let v = value(&crate::wire::to_json(&run).unwrap());
        assert_eq!(v["models"]["cluster"], "delphi-umap-evoc/1");
        assert_eq!(v["models"]["cluster_seed"], 42);
        assert_eq!(v["models"]["embedding"], "all-MiniLM-L6-v2");
        // A seed without its clustering model is not a record the contract takes.
        doc["manifest"]["models"]
            .as_object_mut()
            .unwrap()
            .remove("cluster");
        assert!(record(serde_json::from_value(doc).unwrap(), conversation()).is_err());
    }

    #[test]
    fn a_runs_empty_retired_families_are_left_out_and_a_nonempty_one_is_refused() {
        let text = FIXTURES[2].1;
        let mut doc = value(text);
        let listed = doc["families"].as_array().unwrap().len();
        let empty_legacy = doc["families"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| {
                f["row_count"] == 0
                    && matches!(
                        ResultFamily::parse(f["family"].as_str().unwrap()),
                        Some(ResultFamily::Legacy(_))
                    )
            })
            .count();
        assert!(empty_legacy > 0);
        let run = record(raw(text), conversation()).unwrap();
        assert_eq!(run.outputs.families.iter().count(), listed - empty_legacy);
        let family = doc["families"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|f| f["family"] == "Delphi_PCAResults")
            .unwrap();
        family["row_count"] = 3.into();
        assert!(record(serde_json::from_value(doc).unwrap(), conversation()).is_err());
    }

    #[test]
    fn a_family_whose_upstream_run_is_unrecorded_is_refused() {
        let mut doc = value(FIXTURES[0].1);
        let artifact = doc["families"][0]["artifact_id"]
            .as_str()
            .unwrap()
            .to_owned();
        doc["bundles"][&artifact]
            .as_object_mut()
            .unwrap()
            .remove("Delphi_CommentEmbeddings");
        assert!(record(serde_json::from_value(doc).unwrap(), conversation()).is_err());
    }

    #[test]
    fn failures_use_only_the_contracts_closed_codes() {
        let attempt = Attempt {
            attempt_id: AttemptId::new("00000000-0000-4000-8000-000000000001").unwrap(),
            number: AttemptNumber::new(2).unwrap(),
            lease_epoch: LeaseEpoch::new(2).unwrap(),
            max_attempts: MaxAttempts::new(3).unwrap(),
            outcome: AttemptOutcome::Dead,
            started_at: Timestamp::new("2026-10-19T00:00:00.000000+00:00").unwrap(),
            ended_at: Some(Timestamp::new("2026-10-19T00:01:00.000000+00:00").unwrap()),
            process_exit_confirmed_at: None,
        };
        let code = |state, own: Option<&str>, job: Option<&str>| {
            failure(state, Some((&attempt, own)), job).map(|f| f.code)
        };
        let dead = StageState::Dead;
        assert_eq!(
            code(dead, Some("stage_failed:1"), None),
            Some(FailureCode::StageFailed)
        );
        assert_eq!(
            code(dead, None, Some("manifest_invalid")),
            Some(FailureCode::ManifestInvalid)
        );
        assert_eq!(
            code(dead, Some("timeout"), None),
            Some(FailureCode::Timeout)
        );
        for unrecorded in [
            "interrupted_by_shutdown",
            "manifest_row_unrecorded",
            "cancelled",
        ] {
            assert_eq!(code(dead, Some(unrecorded), None), None, "{unrecorded}");
        }
        assert_eq!(
            code(StageState::Cancelled, None, None),
            Some(FailureCode::Cancelled)
        );
        assert_eq!(code(StageState::Succeeded, Some("timeout"), None), None);
        let f = failure(dead, Some((&attempt, Some("timeout"))), None).unwrap();
        assert_eq!(f.attempt.get(), 2);
        assert!(f.stage.is_none());
        assert_eq!(f.at.as_str(), "2026-10-19T00:01:00.000000+00:00");
        // No attempt, or one that has not ended: no failure.
        assert!(failure(StageState::Cancelled, None, None).is_none());
    }

    #[test]
    fn refusals_keep_the_delphi_logs_shapes() {
        for (value, bytes) in [
            (
                to_json(&contract::Unauthenticated::no_token()),
                r#"{"error":"No authentication token found"}"#,
            ),
            (
                to_json(&contract::Refusal::missing()),
                r#"{"status":"error","message":"job_id is required"}"#,
            ),
            (
                to_json(&contract::Refusal::not_found()),
                r#"{"status":"error","message":"Job not found"}"#,
            ),
            (
                to_json(&contract::Refusal::denied()),
                r#"{"status":"error","message":"polis_err_delphi_run_auth"}"#,
            ),
        ] {
            assert_eq!(value.unwrap(), bytes);
        }
    }
}
