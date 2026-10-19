//! Moderator-only typed assignments for one immutable Delphi job.
//! Own result and auth pools; no shared participation pool or connection held
//! while authenticating. The existing run-record route is the companion for
//! per-family producer job/run/batch/digest provenance, including inherited
//! assignments. Neither route rewrites the delphi-job-result/1 schema.
use crate::delphi_job_result::*;
use crate::delphi_run::{DelphiRun, JobId, StageState};
use crate::wire::{Invalid, JsMap};
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use serde::Deserialize;
use std::collections::BTreeMap;
#[path = "../../polis-contracts/src/delphi_result_read.rs"]
mod contract;
const FAMILY: &str = "Delphi_CommentHierarchicalClusterAssignments";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ROWS: u64 = 100_000;
pub fn matches(path: &str) -> bool {
    path.starts_with(contract::PREFIX)
}

// Projection for immutable artifact lookup; the full document is separately
// validated through the same typed run-record builder used by its companion.
#[derive(Deserialize)]
struct Projection {
    zid: i32,
    families: Vec<Artifact>,
}
#[derive(Deserialize)]
struct Artifact {
    family: String,
    artifact_id: String,
    row_count: u64,
}

/// The request after the method, body and query checks, with the raw
/// `Authorization` header.
pub struct Parsed {
    authorization: Option<String>,
    request: contract::Request,
}

pub fn parse(app: &App, req: &Request) -> Option<Parsed> {
    if app.delphi_result_db.is_none()
        || app.delphi_result_auth_db.is_none()
        || !matches(req.path())
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
    let job_id = req.path().strip_prefix(contract::PREFIX)?;
    if job_id.is_empty() || job_id.len() > 100 || job_id.contains('/') {
        return None;
    }
    // This first slice admits exactly one explicit family. An omitted,
    // repeated, structured or unsupported selector is never silently widened.
    let pairs: Vec<_> = url::form_urlencoded::parse(raw.as_bytes()).collect();
    if pairs.len() != 1 || pairs[0].0 != "families" || pairs[0].1 != "assignments" {
        return None;
    }
    Some(Parsed {
        authorization: req.headers.get("authorization").map(str::to_owned),
        request: contract::Request {
            job_id: job_id.into(),
        },
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
    let (Some(pool), Some(auth_pool)) = (&app.delphi_result_db, &app.delphi_result_auth_db) else {
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
    let job_id = query.request.job_id;
    // Job ids are lowercase canonical uuids; any other spelling names no job.
    let Ok(job) = JobId::new(job_id) else {
        return Some(Answer::NotFound);
    };
    let env = app.delphi_result_env.clone();
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
    if text.len() > MAX_BYTES {
        return None;
    }
    let raw: Projection = serde_json::from_str(&text).ok()?;
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
    let record =
        crate::delphi_run_read::record(serde_json::from_str(&text).ok()?, conversation).ok()?;
    // Resolve once at this job, then read only that immutable artifact. A later
    // publication cannot redirect this request to a different producer.
    let assignments = if record.state == StageState::Succeeded {
        let mut families = raw.families.iter().filter(|f| f.family == FAMILY);
        if let Some(f) = families.next() {
            if families.next().is_some() || f.row_count > MAX_ROWS {
                return None;
            }
            let artifact = uuid::Uuid::parse_str(&f.artifact_id).ok()?.to_string();
            if artifact != f.artifact_id {
                return None;
            }
            let env = app.delphi_result_env.clone();
            let text: String = pool
                .with(move |c| {
                    Ok(c.query_one(
                "SELECT pd_result_artifact_family($1::text,($2::text)::uuid,$3::text)::text",
                &[&env, &artifact, &FAMILY],
            )?.try_get(0)?)
                })
                .await
                .ok()?;
            if text.len() > MAX_BYTES {
                return None;
            }
            Some(decode_assignments(&text, zid, f.row_count).ok()?)
        } else {
            None
        }
    } else {
        None
    };
    let result = envelope(record, assignments)?;
    let bytes = crate::wire::to_json(&result).ok()?;
    (bytes.len() <= MAX_BYTES).then_some(Answer::Record(bytes))
}

fn envelope(run: DelphiRun, assignments: Option<Assignments>) -> Option<DelphiJobResult> {
    let job_id = PublicJobId::new(run.job_id.as_str().to_owned()).ok()?;
    let run_id = run
        .run_id
        .as_ref()
        .map(|id| RunId::new(id.as_str().to_owned()))
        .transpose()
        .ok()?;
    // Unknown counts stay null. Model identities come from the finalized
    // manifest, never from today's deployment defaults or a placeholder.
    let inputs = run.models.topic_names.clone().map(|topic_names| JobInputs {
        math_tick: run.inputs.as_ref().and_then(|i| i.math_tick),
        math_env: run.inputs.as_ref().and_then(|i| i.math_env.clone()),
        vote_count: None,
        comment_count: None,
        model: JobModels {
            topic_names,
            narrative: run.models.narrative.clone(),
            statement: run.models.statement.clone(),
            embedding: run.models.embedding.clone(),
        },
        prompt_version: run.prompt_versions.clone(),
    });
    match run.state {
        StageState::Succeeded => Some(DelphiJobResult::Ready(Box::new(Ready {
            job_id,
            run_id,
            conversation_id: run.conversation_id.clone(),
            report_id: run.report_id.clone(),
            as_of: run.completed_at.clone()?,
            inputs: inputs?,
            pinned: run.pinned,
            label: run.label.clone(),
            outputs: DelphiJobOutputs {
                assignments,
                ..Default::default()
            },
        }))),
        StageState::Queued if run.attempt.is_none() => Some(DelphiJobResult::Pending(Pending {
            job_id,
            run_id,
            conversation_id: run.conversation_id.clone(),
            report_id: run.report_id.clone(),
            as_of: None,
            inputs,
            pinned: run.pinned,
            label: run.label.clone(),
        })),
        StageState::Running => Some(DelphiJobResult::Running(Running {
            job_id,
            run_id,
            conversation_id: run.conversation_id.clone(),
            report_id: run.report_id.clone(),
            as_of: run.attempt.as_ref()?.started_at.clone(),
            inputs,
            attempt: run.attempt.as_ref()?.number,
            pinned: run.pinned,
            label: run.label.clone(),
        })),
        StageState::Dead | StageState::Cancelled => Some(DelphiJobResult::Failed(Failed {
            job_id,
            run_id,
            conversation_id: run.conversation_id.clone(),
            report_id: run.report_id.clone(),
            as_of: run.attempt.as_ref()?.started_at.clone(),
            inputs,
            attempt: run.attempt.as_ref()?.number,
            failure: run.failure.clone()?,
            pinned: run.pinned,
            label: run.label.clone(),
        })),
        _ => None,
    }
}

// Only consumed attributes are decoded. Auxiliary storage attributes do not
// cross the wire. Reject non-integral numbers, wrong tags, conflicting ids,
// duplicate comments and noncanonical layer keys instead of coercing them.
fn decode_assignments(text: &str, zid: i32, count: u64) -> Result<Assignments, Invalid> {
    let fail = || Invalid("invalid stored assignments".into());
    let rows: Vec<BTreeMap<String, serde_json::Value>> =
        serde_json::from_str(text).map_err(|_| fail())?;
    if rows.len() as u64 != count || count > MAX_ROWS {
        return Err(fail());
    }
    let tagged = |value: &serde_json::Value, tag: &str| -> Result<String, Invalid> {
        let map = value.as_object().ok_or_else(fail)?;
        if map.len() != 1 {
            return Err(fail());
        }
        map.get(tag)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .ok_or_else(fail)
    };
    let mut ordered = BTreeMap::new();
    for row in rows {
        if tagged(row.get("conversation_id").ok_or_else(fail)?, "S")? != zid.to_string() {
            return Err(fail());
        }
        let tid: u32 = tagged(row.get("comment_id").ok_or_else(fail)?, "N")?
            .parse()
            .map_err(|_| fail())?;
        let mut layers = BTreeMap::new();
        for (key, value) in row.iter().filter(|(key, _)| key.starts_with("layer")) {
            let layer = key
                .strip_prefix("layer")
                .and_then(|x| x.strip_suffix("_cluster_id"))
                .ok_or_else(fail)?;
            let layer_id: u32 = layer.parse().map_err(|_| fail())?;
            if layer_id.to_string() != layer {
                return Err(fail());
            }
            // The producer's fixed model has slots for layers it did not
            // compute. Exactly {"NULL":true} means no assignment for that
            // layer, not cluster zero or the unassigned-cluster sentinel.
            if value == &serde_json::json!({"NULL":true}) {
                continue;
            }
            let n = tagged(value, "N")?;
            let cluster: Cluster = serde_json::from_str(&n).map_err(|_| fail())?;
            layers.insert(LayerId::new(layer_id), cluster);
        }
        if ordered.insert(Tid::new(tid), layers).is_some() {
            return Err(fail());
        }
    }
    let mut out = JsMap::new();
    for (tid, layers) in ordered {
        let mut values = JsMap::new();
        for (layer, cluster) in layers {
            values.insert(layer, cluster)?;
        }
        out.insert(tid, values)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn row(tid: u32, cluster: i32) -> serde_json::Value {
        json!({"conversation_id":{"S":"1424"},"comment_id":{"N":tid.to_string()},
            "layer0_cluster_id":{"N":cluster.to_string()}})
    }
    #[test]
    fn tagged_assignments_keep_numeric_order_and_refuse_ambiguous_values() {
        let text = serde_json::to_string(&vec![row(10, 3), row(2, 1)]).unwrap();
        let result = decode_assignments(&text, 1424, 2).unwrap();
        assert_eq!(
            crate::wire::to_json(&result).unwrap(),
            r#"{"2":{"0":1},"10":{"0":3}}"#
        );
        assert!(decode_assignments(&text, 1425, 2).is_err());
        assert!(decode_assignments(&text, 1424, 1).is_err());
        assert!(
            decode_assignments(
                &serde_json::to_string(&vec![row(2, 1), row(2, 3)]).unwrap(),
                1424,
                2
            )
            .is_err()
        );
        for value in [
            json!({"N":"1.5"}),
            json!({"S":"1"}),
            json!({"N":"1","S":"1"}),
            json!({"NULL":false}),
        ] {
            let mut r = row(0, 1);
            r["layer0_cluster_id"] = value;
            assert!(decode_assignments(&json!([r]).to_string(), 1424, 1).is_err());
        }
        let mut missing_layer = row(0, 1);
        missing_layer["layer1_cluster_id"] = json!({"NULL":true});
        assert_eq!(
            crate::wire::to_json(
                &decode_assignments(&json!([missing_layer]).to_string(), 1424, 1).unwrap()
            )
            .unwrap(),
            r#"{"0":{"0":1}}"#
        );
        let mut r = row(0, 1);
        r["layer00_cluster_id"] = json!({"N":"1"});
        assert!(decode_assignments(&json!([r]).to_string(), 1424, 1).is_err());
        assert_eq!(
            crate::wire::to_json(&decode_assignments("[]", 1424, 0).unwrap()).unwrap(),
            "{}"
        );
    }
    #[test]
    fn result_contract_preserves_job_identity_and_omits_unrequested_families() {
        let raw = include_str!("../conformance/delphi-run-fixtures/first.record.json");
        let run = crate::delphi_run_read::record(
            serde_json::from_str(raw).unwrap(),
            ConversationId::new("local-dynamo-1424").unwrap(),
        )
        .unwrap();
        let assignments = decode_assignments(&json!([row(2, 1)]).to_string(), 1424, 1).unwrap();
        let result = envelope(run.clone(), Some(assignments)).unwrap();
        let text = crate::wire::to_json(&result).unwrap();
        assert_eq!(DelphiJobResult::from_json(&text).unwrap(), result);
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["job_id"], run.job_id.as_str());
        assert_eq!(value["run_id"], run.run_id.as_ref().unwrap().as_str());
        assert_eq!(value["as_of"], run.completed_at.as_ref().unwrap().as_str());
        assert_eq!(value["omitted"].as_array().unwrap().len(), 8);
        assert_eq!(value["outputs"], json!({"assignments":{"2":{"0":1}}}));
        assert!(value.get("publication").is_none());
        // Never substitute current configuration or the inherited producer's
        // models for an unrecorded model on the requested job.
        let raw = include_str!("../conformance/delphi-run-fixtures/statement.record.json");
        let run = crate::delphi_run_read::record(
            serde_json::from_str(raw).unwrap(),
            ConversationId::new("local-dynamo-1424").unwrap(),
        )
        .unwrap();
        assert!(envelope(run, None).is_none());
    }
}
