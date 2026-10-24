//! Existing participant selection writes. Hand-back is exclusively before mutation.
//! No identity creation, token issuance, schema change or route activation.
use crate::{
    config, db,
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use polis_auth::participant;
use std::{sync::Arc, time::Duration};
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/topic_selection_writes.rs"]
mod contract;
use contract::{Data, Method, Response, SuccessMessage};
pub(crate) const MAX_BODY_BYTES: usize = 65536;

pub(crate) struct Writer {
    reads: Arc<db::Pool>,
    publications: Arc<db::Pool>,
    writes: Arc<db::Pool>,
    verifier: participant::Verifier,
    env: String,
    scope: Option<String>,
    pending: Arc<tokio::sync::Semaphore>,
    #[cfg(all(test, feature = "db-tests"))]
    after_mutation: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(all(test, feature = "db-tests"))]
    before_mutation: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl Writer {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        if std::env::var("POLIS_API_TOPIC_SELECTION_WRITES")
            .ok()
            .as_deref()
            != Some("1")
        {
            return Ok(None);
        }
        // The remote DynamoDB paging branch belongs wholly to Node. Never
        // guess null attribution merely because its backend is unsupported.
        anyhow::ensure!(
            std::env::var("DELPHI_RESULT_BACKEND").ok().as_deref() == Some("postgres"),
            "selection writes require explicit Postgres result backend"
        );
        let dsn = std::env::var("POLIS_API_TOPIC_SELECTION_WRITES_DATABASE_URL")?;
        let key = std::fs::read(std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")?)?;
        let verifier = participant::Verifier::new(
            &key,
            &std::env::var("POLIS_JWT_ISSUER")?,
            &std::env::var("POLIS_JWT_AUDIENCE")?,
        )
        .context("participant verification configuration")?;
        let env = std::env::var("DELPHI_RESULT_ENV")?;
        anyhow::ensure!(!env.is_empty(), "result environment required");
        Ok(Some(Self {
            reads: db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-selection-admission/1")?,
                limits(50),
            ),
            publications: db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-selection-publications/1")?,
                limits(100),
            ),
            writes: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-selection-writes/1")?,
                limits(1000),
            ),
            pending: Arc::new(tokio::sync::Semaphore::new(8)),
            #[cfg(all(test, feature = "db-tests"))]
            after_mutation: None,
            #[cfg(all(test, feature = "db-tests"))]
            before_mutation: None,
            verifier,
            env,
            scope: std::env::var("DELPHI_RESULT_SCOPE")
                .ok()
                .filter(|s| !s.is_empty()),
        }))
    }
}
fn limits(ms: u64) -> db::Limits {
    db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(25),
        statement_timeout: Duration::from_millis(ms),
        max_lifetime: Duration::from_secs(300),
    }
}
struct Input {
    method: Method,
    cid: String,
    selections: Option<String>,
    count: i32,
}
fn parse(req: &Request) -> Option<Input> {
    let method = match req.method.as_str() {
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        _ => return None,
    };
    if req.path() != contract::PATH
        || req.query().is_some_and(|q| !q.is_empty())
        || req.body.len() > MAX_BODY_BYTES
        || ["cookie", "content-encoding", "transfer-encoding"]
            .iter()
            .any(|h| req.headers.get(h).is_some())
        || !matches!(
            req.headers.get("content-type"),
            Some("application/json" | "application/json; charset=utf-8")
        )
    {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&req.body).ok()?;
    let obj = value.as_object()?;
    if obj
        .keys()
        .any(|k| !matches!(k.as_str(), "conversation_id" | "selections"))
    {
        return None;
    }
    let cid = obj.get("conversation_id")?.as_str()?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let (selections, count) = if method == Method::Delete {
        (None, 0)
    } else {
        let values = obj.get("selections")?.as_array()?;
        // This is a supported slice, not a new API validation rule. Node owns
        // strings, objects, unbounded arrays, and any unsupported element.
        if values.len() > 256 || !values.iter().all(exact_json) {
            return None;
        }
        (
            Some(serde_json::to_string(values).ok()?),
            i32::try_from(values.len()).ok()?,
        )
    };
    Some(Input {
        method,
        cid: cid.into(),
        selections,
        count,
    })
}
// Only exactly representable JSON numbers are admitted; Node owns other
// numbers so Rust cannot preserve a different integer than JSON.parse did.
fn exact_json(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Number(n) => n
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991),
        serde_json::Value::Array(a) => a.iter().all(exact_json),
        serde_json::Value::Object(o) => o.values().all(exact_json),
        _ => true,
    }
}
pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    app.topic_selection_writer.is_some()
        && app.production
        && parse(req).is_some()
        && app.cors.resolve(&req.headers).is_ok()
        && (app.dev_mode
            || app.use_network_host
            || req.headers.get("x-forwarded-proto") == Some("https"))
}
#[derive(Clone)]
struct Member {
    zid: i32,
    pid: i32,
}
fn admit(
    c: &mut postgres::Client,
    cid: &str,
    identity: &participant::Verified,
) -> Result<Option<Member>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(None);
    };
    // Reuse the same verified-token and durable membership admission used by
    // the vote writer. A signed pid alone is never write authority here.
    let Some(pid) = participant::resolve(c, polis_auth::Zid(zid), identity)? else {
        return Ok(None);
    };
    let row = c.query_one(
        "SELECT xid_required,use_xid_whitelist FROM conversations WHERE zid=$1",
        &[&zid],
    )?;
    if row.try_get::<_, Option<bool>>(0)?.unwrap_or(false)
        || row.try_get::<_, Option<bool>>(1)?.unwrap_or(false)
    {
        return Ok(None);
    }
    Ok(Some(Member {
        zid,
        pid: pid.0 as i32,
    }))
}
fn publication(
    c: &mut postgres::Client,
    zid: i32,
    env: &str,
    scope: Option<&str>,
) -> Result<Option<String>> {
    let rows=match scope {
        Some(scope)=>c.query("SELECT job_id FROM public.delphi_result_publications WHERE env=$1 AND zid=$2 AND scope_key=$3",&[&env,&zid,&scope])?,
        None=>c.query("SELECT job_id FROM public.delphi_result_publications WHERE env=$1 AND zid=$2",&[&env,&zid])?,
    };
    // Node treats missing or ambiguous publication as null, retaining prior
    // attribution through COALESCE. Failed reads have the same null result.
    if rows.len() != 1 {
        return Ok(None);
    }
    Ok(rows[0]
        .try_get::<_, Option<String>>(0)?
        .filter(|s| !s.is_empty()))
}
fn mutate(
    c: &mut postgres::Client,
    a: &Member,
    input: Input,
    job: Option<String>,
) -> Result<Option<Response>> {
    if input.method == Method::Delete {
        let rows = c.query(
            "DELETE FROM topic_agenda_selections WHERE zid=$1 AND pid=$2 RETURNING zid,pid",
            &[&a.zid, &a.pid],
        )?;
        return Ok(Some(Response::success(
            if rows.is_empty() {
                SuccessMessage::Absent
            } else {
                SuccessMessage::Deleted
            },
            None,
        )));
    }
    let json = input.selections.context("admitted selections")?;
    let params: &[&(dyn postgres::types::ToSql + Sync)] =
        &[&a.zid, &a.pid, &json, &job, &input.count];
    let (row,message)=match input.method {
        Method::Post=>(c.query_one("INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,delphi_job_id,total_selections,created_at,updated_at) VALUES($1,$2,$3::text::jsonb,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(zid,pid) DO UPDATE SET archetypal_selections=EXCLUDED.archetypal_selections,delphi_job_id=COALESCE(EXCLUDED.delphi_job_id,topic_agenda_selections.delphi_job_id),total_selections=EXCLUDED.total_selections,updated_at=CURRENT_TIMESTAMP RETURNING total_selections,delphi_job_id",params)?,SuccessMessage::Saved),
        Method::Put=>{
            // One autocommit statement updates only an existing row. A completed
            // zero-row result positively proves no write and may return to Node's
            // separate INSERT branch. An error or unknown completion is terminal.
            let Some(row)=c.query_opt("UPDATE topic_agenda_selections SET archetypal_selections=$3::text::jsonb,delphi_job_id=COALESCE($4,delphi_job_id),total_selections=$5,updated_at=CURRENT_TIMESTAMP WHERE zid=$1 AND pid=$2 RETURNING total_selections,delphi_job_id",params)? else {
                return Ok(None);
            };
            (row,SuccessMessage::Updated)
        },
        Method::Delete=>unreachable!(),
    };
    Ok(Some(Response::success(
        message,
        Some(Data {
            conversation_id: a.zid.to_string(),
            participant_id: a.pid.to_string(),
            selections_count: contract::SelectionCount::Integer(row.try_get(0)?),
            job_id: row.try_get(1)?,
        }),
    )))
}
pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let (Some(writer), Some(input)) = (&app.topic_selection_writer, parse(req)) else {
        return route::bad_gateway();
    };
    if !app.production
        || !(app.dev_mode
            || app.use_network_host
            || req.headers.get("x-forwarded-proto") == Some("https"))
    {
        return route::bad_gateway();
    }
    let Some(identity) = req.headers.get("authorization").and_then(|h| {
        writer
            .verifier
            .verify(h, &input.cid, (crate::clock::now_ms() / 1000.0) as u64)
    }) else {
        return route::bad_gateway();
    };
    let Ok(pending) = writer.pending.clone().try_acquire_owned() else {
        return route::bad_gateway();
    };
    let cid = input.cid.clone();
    let admitted = tokio::time::timeout(
        Duration::from_millis(100),
        writer.reads.with(move |c| admit(c, &cid, &identity)),
    )
    .await;
    let Ok(Ok(Some(member))) = admitted else {
        return route::bad_gateway();
    };
    // Admission connection and permit have been returned before publication
    // lookup. Its separate one-slot pool never borrows a participation slot.
    let job = if input.method == Method::Delete {
        None
    } else {
        let env = writer.env.clone();
        let scope = writer.scope.clone();
        let zid = member.zid;
        match tokio::time::timeout(
            Duration::from_millis(150),
            writer
                .publications
                .with(move |c| publication(c, zid, &env, scope.as_deref())),
        )
        .await
        {
            Ok(Ok(job)) => job,
            // An incomplete lookup is unsupported; no mutation has started.
            Err(_) => return route::bad_gateway(),
            Ok(Err(_)) => None,
        }
    };
    let method = input.method;
    let pool = writer.writes.clone();
    // After mutation there is no retry, hand-back or cancellation. The task
    // owns the operation even if the caller disappears or its deadline expires.
    #[cfg(all(test, feature = "db-tests"))]
    let after_mutation = writer.after_mutation.clone();
    #[cfg(all(test, feature = "db-tests"))]
    let before_mutation = writer.before_mutation.clone();
    let task = tokio::spawn(async move {
        let _pending = pending;
        let result = pool
            .with(move |c| {
                #[cfg(all(test, feature = "db-tests"))]
                if let Some(hook) = before_mutation {
                    hook();
                }
                mutate(c, &member, input, job)
            })
            .await;
        #[cfg(all(test, feature = "db-tests"))]
        if let (Ok(Some(_)), Some(hook)) = (&result, after_mutation) {
            tokio::task::spawn_blocking(move || hook()).await?;
        }
        result
    });
    let response = match tokio::time::timeout(Duration::from_millis(1100), task).await {
        Ok(Ok(Ok(Some(body)))) => (200, body),
        Ok(Ok(Ok(None))) => return route::bad_gateway(),
        _ => (500, Response::failure(method)),
    };
    match serde_json::to_string(&response.1) {
        Ok(body) => route::json_text(req, res, response.0, body),
        Err(_) => route::json_text(
            req,
            res,
            500,
            serde_json::to_string(&Response::failure(method)).unwrap_or_default(),
        ),
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "topic_selection_writes_tests.rs"]
mod tests;
