//! Legacy visualization validation and PostgreSQL job metadata. Dedicated
//! bounded pools; DynamoDB/S3 results and unsupported metadata stay with Node.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use anyhow::{Result, ensure};
use postgres::{Client, IsolationLevel};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
#[path = "../../polis-contracts/src/delphi_visualizations.rs"]
mod contract;
pub use contract::PATH;
pub struct Parsed {
    report_id: Option<String>,
    job_id: Option<String>,
}
pub fn parse(app: &App, req: &Request) -> Option<Parsed> {
    if app.delphi_visualizations_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
    {
        return None;
    }
    // Node does not authenticate this public report route. Preserve the old
    // validation-only admission when PostgreSQL result reads are not configured.
    let pg = app.delphi_visualizations_result_db.is_some();
    if !pg && (req.headers.get("authorization").is_some() || req.headers.get("cookie").is_some()) {
        return None;
    }
    let raw = req.query().unwrap_or("");
    if raw.len() > 1024 {
        return None;
    }
    let mut report_id = None;
    let mut job_id = None;
    let mut seen = BTreeSet::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if (k != "report_id" && (!pg || k != "job_id"))
            || !seen.insert(k.clone())
            || v.len() > 100
            || !v
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        if !v.is_empty() {
            if k == "report_id" {
                report_id = Some(v.into_owned());
            } else {
                job_id = Some(v.into_owned());
            }
        }
    }
    Some(Parsed { report_id, job_id })
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
pub fn result_pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        statement_timeout: std::time::Duration::from_millis(200),
        ..pool_limits()
    }
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Ok(Some((status, body))) = tokio::time::timeout(
        std::time::Duration::from_millis(if app.delphi_visualizations_result_db.is_some() {
            750
        } else {
            75
        }),
        answer(app, query),
    )
    .await
    else {
        return route::bad_gateway();
    };
    route::json_text(req, res, status, body)
}
async fn answer(app: &App, query: Parsed) -> Option<(u16, String)> {
    let Some(id) = query.report_id else {
        return Some((
            400,
            crate::wire::to_json(&contract::Request::missing()).ok()?,
        ));
    };
    let lookup = id.clone();
    let zid = app
        .delphi_visualizations_db
        .as_ref()?
        .with(move |c| {
            Ok(c.query_opt(
                "SELECT zid FROM reports WHERE report_id=$1 LIMIT 1",
                &[&lookup],
            )?
            .map(|r| r.try_get::<_, Option<i32>>(0))
            .transpose()?)
        })
        .await
        .ok()?;
    if zid.is_some() && app.delphi_visualizations_result_db.is_none() {
        return None;
    }
    let zid = zid.flatten();
    let Some(zid) = zid.filter(|z| *z != 0) else {
        return Some((
            404,
            crate::wire::to_json(&contract::Request::unknown(id)).ok()?,
        ));
    };
    let pool = app.delphi_visualizations_result_db.as_ref()?;
    let env = app.delphi_visualizations_env.clone();
    let scope = app.delphi_visualizations_scope.clone();
    let mut jobs = pool
        .with(move |c| read(c, &env, scope.as_deref(), zid))
        .await
        .ok()?;
    if let Some(job) = query.job_id {
        jobs.retain(|j| j.job_id == job);
    }
    let body = crate::wire::to_json(&contract::JobsResponse {
        status: contract::Success::Success,
        report_id: id,
        visualizations: Vec::new(),
        jobs,
    })
    .ok()?;
    if body.len() > 1024 * 1024 {
        return None;
    }
    Some((200, body))
}
#[derive(Clone)]
struct Item {
    id: String,
    created: Option<String>,
    job: contract::Job,
}
fn string_field(tag: &Value, name: &str) -> Result<Option<String>> {
    match tag.get(name) {
        None => Ok(None),
        Some(v) if v.get("NULL") == Some(&Value::Bool(true)) => Ok(None),
        Some(v) => Ok(Some(
            v.get("S")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("unsupported metadata scalar"))?
                .to_owned(),
        )),
    }
}
fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !matches!(id, "__proto__" | "constructor" | "prototype")
        && crate::js::array_index(id).is_none()
}
fn archived(tag: &Value) -> Result<Item> {
    let id = string_field(tag, "job_id")?.ok_or_else(|| anyhow::anyhow!("missing job id"))?;
    ensure!(safe_id(&id), "unsupported job id");
    let created = string_field(tag, "created_at")?;
    ensure!(
        created.as_ref().is_none_or(|s| s.is_ascii()),
        "unsupported metadata ordering"
    );
    let results = match string_field(tag, "job_results")? {
        Some(s) if !s.is_empty() => {
            ensure!(
                !s.to_ascii_lowercase().contains("\\ud"),
                "unsupported surrogate escape"
            );
            match crate::js::parse(&s) {
                Ok(v) => serde_json::from_str(&crate::js::stringify(&v))?,
                Err(_) => crate::wire::Json::Null,
            }
        }
        _ => crate::wire::Json::Null,
    };
    Ok(Item {
        id: id.clone(),
        created: created.clone(),
        job: contract::Job {
            job_id: id,
            status: nonempty(string_field(tag, "status")?).unwrap_or_else(|| "unknown".into()),
            created_at: nonempty(created),
            started_at: nonempty(string_field(tag, "started_at")?),
            completed_at: nonempty(string_field(tag, "completed_at")?),
            results,
            archived: Some(true),
            work_live: false,
        },
    })
}
fn native(row: &postgres::Row) -> Result<Item> {
    let id: String = row.try_get("job_id")?;
    ensure!(safe_id(&id), "unsupported job id");
    let created: Option<String> = row.try_get("created_at")?;
    Ok(Item {
        id: id.clone(),
        created: created.clone(),
        job: contract::Job {
            job_id: id,
            status: row.try_get("status")?,
            created_at: nonempty(created),
            started_at: None,
            completed_at: nonempty(row.try_get("completed_at")?),
            results: crate::wire::Json::Null,
            archived: None,
            work_live: true,
        },
    })
}
fn read(c: &mut Client, env: &str, scope: Option<&str>, zid: i32) -> Result<Vec<contract::Job>> {
    // Conservative one-page bound: never collapse Node's multi-snapshot paging
    // into one snapshot. Larger listings go to Node, without partial results.
    ensure!(
        (1..=999999999).contains(&zid),
        "unsupported archive conversation range"
    );
    let conversation = zid.to_string();
    let mut tx = c
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()?;
    let bytes:i64=tx.query_one("SELECT coalesce((SELECT sum(octet_length(codec_wire)) FROM public.delphi_result_legacy_controls WHERE env=$1 AND family='Delphi_JobQueue' AND zid=$3 AND ($2::text IS NULL OR scope_key=$2)),0)::bigint + coalesce((SELECT sum(octet_length(row_to_json(v)::text)) FROM public.delphi_result_jobs v WHERE env=$1 AND conversation_id=$4 AND ($2::text IS NULL OR scope_key=$2)),0)::bigint",&[&env,&scope,&zid,&conversation])?.try_get(0)?;
    ensure!(bytes <= 512 * 1024, "single-page metadata bound");
    let rows=tx.query("SELECT job_id,conversation_id,report_id,status,job_type,job_config,created_at,completed_at,error,env,scope_key FROM public.delphi_result_jobs WHERE env=$1 AND conversation_id=$3 AND ($2::text IS NULL OR scope_key=$2)",&[&env,&scope,&conversation])?;
    ensure!(rows.len() <= 1000, "job count bound");
    let active = rows
        .iter()
        .map(|r| r.try_get::<_, String>("job_id"))
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    let mut seen = BTreeMap::<String, Value>::new();
    let mut items = Vec::new();
    for row in tx.query("SELECT codec_wire FROM public.delphi_result_legacy_controls WHERE env=$1 AND family='Delphi_JobQueue' AND zid=$3 AND ($2::text IS NULL OR scope_key=$2) ORDER BY zid,scope_key",&[&env,&scope,&zid])?{
        let wire:String=row.try_get(0)?;let mut lines=wire.lines();let header:Value=serde_json::from_str(lines.next().unwrap_or(""))?;
        ensure!(header["codec"]=="delphi-storage-codec/1"&&header["family"]=="Delphi_JobQueue","archive family");
        for line in lines{
            let tag:Value=serde_json::from_str(line)?;let id=tag["job_id"]["S"].as_str().ok_or_else(||anyhow::anyhow!("unsupported archive job id"))?;
            if active.contains(id){continue;}
            if let Some(old)=seen.insert(id.to_owned(),tag.clone()){ensure!(old==tag,"ambiguous archived job");continue;}
            if tag["conversation_id"]["S"].as_str()!=Some(conversation.as_str()){continue;}
            let item=archived(&tag)?;if item.created.is_some(){items.push(item);}
        }
    }
    for row in &rows {
        let item = native(row)?;
        if item.created.is_some() {
            items.push(item);
        }
    }
    ensure!(items.len() <= 1000, "job count bound");
    items.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    tx.rollback()?;
    // Node performs liveness after the result adapter's snapshot. Preserve
    // that boundary. A sweep this bounded pool cannot finish is Node's to
    // answer: Node's own sweep may succeed and report a job finished.
    let rows = c.query(
        include_str!("delphi_visualizations_liveness.sql"),
        &[&env, &conversation, &scope],
    )?;
    ensure!(rows.len() <= 1000, "liveness job count bound");
    let mut live = BTreeMap::new();
    let mut fresh = Vec::new();
    for row in rows {
        let item = native(&row)?;
        live.insert(item.id.clone(), row.try_get::<_, bool>("work_live")?);
        fresh.push(item);
    }
    let mut ids = BTreeSet::new();
    let mut jobs = Vec::new();
    for mut item in items {
        if item.job.archived.is_none() {
            item.job.work_live = live.get(&item.id).copied().unwrap_or(true);
        }
        ids.insert(item.id);
        jobs.push(item.job);
    }
    for mut item in fresh {
        if ids.insert(item.id.clone()) {
            item.job.work_live = live.get(&item.id).copied().unwrap_or(true);
            jobs.push(item.job);
        }
    }
    Ok(jobs)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_fields_and_result_property_order_match_node() {
        let tag = serde_json::json!({"job_id":{"S":"job-a"},"created_at":{"S":""},"job_results":{"S":"{\"z\":1,\"a\":2}"},"status":{"S":""}});
        assert_eq!(
            crate::wire::to_json(&archived(&tag).unwrap().job).unwrap(),
            r#"{"jobId":"job-a","status":"unknown","createdAt":null,"startedAt":null,"completedAt":null,"results":{"z":1,"a":2},"archived":true,"workLive":false}"#
        );
    }
    #[test]
    fn unsafe_identifiers_and_unmodelled_scalar_coercions_hand_back() {
        for id in ["__proto__", "constructor", "0", "4294967294", ""] {
            assert!(!safe_id(id));
        }
        assert!(safe_id("batch_report_generated"));
        assert!(archived(&serde_json::json!({"job_id":{"S":"job-a"},"status":{"N":"1"}})).is_err());
    }
}
