//! Legacy logs on dedicated bounded pools. Unsupported values and unavailable
//! reads return 502 so Node remains the authority for their response bytes.
use crate::{
    http::{Outgoing, Request},
    js::{self, Js},
    route::{self, App, Res},
};
use anyhow::{Result, ensure};
use postgres::{Client, IsolationLevel};
use serde_json::Value;
#[path = "../../polis-contracts/src/delphi_logs.rs"]
mod contract;
pub use contract::PATH;

pub struct Parsed {
    authorization: Option<String>,
    request: contract::Request,
}
pub fn parse(app: &App, req: &Request) -> Option<Parsed> {
    if app.delphi_logs_db.is_none()
        || app.delphi_logs_auth_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|v| v != "0")
    {
        return None;
    }
    let raw = req.query().unwrap_or("");
    if raw.len() > 1024 {
        return None;
    }
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
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(200),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
pub fn auth_pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        statement_timeout: std::time::Duration::from_millis(50),
        ..pool_limits()
    }
}

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(parsed) = parse(app, req) else {
        return route::bad_gateway();
    };
    match tokio::time::timeout(std::time::Duration::from_millis(750), answer(app, parsed)).await {
        Ok(Some((status, body))) => route::json_text(req, res, status, body),
        _ => route::bad_gateway(),
    }
}
fn refusal(status: u16, body: impl serde::Serialize) -> Option<(u16, String)> {
    Some((status, crate::wire::to_json(&body).ok()?))
}
async fn answer(app: &App, parsed: Parsed) -> Option<(u16, String)> {
    let auth = app.delphi_logs_auth_db.as_ref()?;
    let raw = match parsed
        .authorization
        .as_deref()
        .filter(|s| s.starts_with("Bearer "))
    {
        Some(raw) => raw,
        None => return refusal(401, contract::Unauthenticated::no_token()),
    };
    let uid = crate::hybrid_read::resolve(
        Some(raw),
        app.participant_verifier.as_deref(),
        app.read_oidc.as_deref(),
        auth,
    )
    .await?
    .uid()?;
    let Some(job_id) = parsed.request.job_id else {
        return refusal(400, contract::Refusal::missing());
    };
    let env = app.delphi_logs_env.clone();
    let scope = app.delphi_logs_scope.clone();
    let job = job_id.clone();
    let found = app
        .delphi_logs_db
        .as_ref()?
        .with(move |c| read(c, &env, scope.as_deref(), &job))
        .await
        .ok()?;
    let Some((conversation, events)) = found else {
        return refusal(404, contract::Refusal::not_found());
    };
    let admins = app.legacy_admin_uids.clone();
    let permitted = auth
        .with(move |c| {
            let zid =
                if !conversation.is_empty() && conversation.bytes().all(|b| b.is_ascii_digit()) {
                    conversation.parse::<i32>().ok()
                } else {
                    crate::db::zid_for_conversation_id(c, &conversation)?
                };
            zid.map(|zid| crate::treevite_read::permits(c, zid, uid, &admins))
                .transpose()
        })
        .await
        .ok()?;
    match permitted {
        None => refusal(404, contract::Refusal::not_found()),
        Some(false) => refusal(403, contract::Refusal::denied()),
        Some(true) => refusal(200, events),
    }
}

/// The same snapshot and active-row precedence as Node's GetCommand adapter.
fn read(
    c: &mut Client,
    env: &str,
    scope: Option<&str>,
    job: &str,
) -> Result<Option<(String, Vec<contract::Event>)>> {
    let mut tx = c
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()?;
    let rows=tx.query("SELECT conversation_id FROM public.delphi_result_jobs WHERE env=$1 AND ($2::text IS NULL OR scope_key=$2) AND job_id=$3", &[&env,&scope,&job])?;
    ensure!(rows.len() <= 1, "ambiguous active job");
    if let Some(row) = rows.first() {
        let conversation: String = row.try_get(0)?;
        let status: Option<String> = tx
            .query_one(
                "SELECT public.pq_job_status($1::text,($2::text)::uuid)::text",
                &[&env, &job],
            )?
            .try_get(0)?;
        let status: Value = serde_json::from_str(status.as_deref().unwrap_or("null"))?;
        let mut events = Vec::new();
        if let Some(attempt) = status.get("attempt_id").and_then(Value::as_str) {
            let bytes: i64 = tx.query_one("SELECT coalesce(sum(octet_length(line)),0)::bigint FROM public.pq_attempt_logs($1::text,($2::text)::uuid,NULL,1000) WHERE stream IN ('stdout','stderr')", &[&env,&attempt])?.try_get(0)?;
            ensure!(bytes <= 1024 * 1024, "native log input cap");
            for row in tx.query("SELECT floor(extract(epoch FROM ts)*1000)::bigint, CASE stream WHEN 'stderr' THEN 'ERROR' ELSE 'INFO' END, line FROM public.pq_attempt_logs($1::text,($2::text)::uuid,NULL,1000) WHERE stream IN ('stdout','stderr')", &[&env,&attempt])? {
                let timestamp=row.try_get(0)?; let level: String=row.try_get(1)?; let line: String=row.try_get(2)?;
                events.push(contract::Event {timestamp:Some(timestamp),message:format!("[DELPHI JOB {job}] {level}: {line}")});
            }
        }
        ensure!(
            crate::wire::to_json(&events)?.len() <= 1024 * 1024,
            "log response cap"
        );
        return Ok(Some((conversation, events)));
    }
    // A Get for an unknown native id scans the current legacy controls. Bound
    // the complete scan before allocation; never return a partial archive.
    let size: i64=tx.query_one("SELECT coalesce(sum(octet_length(codec_wire)),0)::bigint FROM public.delphi_result_legacy_controls WHERE env=$1 AND family='Delphi_JobQueue' AND ($2::text IS NULL OR scope_key=$2)", &[&env,&scope])?.try_get(0)?;
    ensure!(size <= 4 * 1024 * 1024, "legacy archive cap");
    let mut found: Option<Value> = None;
    let mut all = std::collections::BTreeMap::<String, Value>::new();
    for row in tx.query("SELECT codec_wire FROM public.delphi_result_legacy_controls WHERE env=$1 AND family='Delphi_JobQueue' AND ($2::text IS NULL OR scope_key=$2) ORDER BY zid,scope_key", &[&env,&scope])? {
        let wire: String=row.try_get(0)?;
        let mut lines=wire.lines();
        let header: Value=serde_json::from_str(lines.next().unwrap_or(""))?;
        ensure!(header["codec"]=="delphi-storage-codec/1" && header["family"]=="Delphi_JobQueue","archive family");
        for line in lines {
            let tag: Value=serde_json::from_str(line)?;
            let id = tag["job_id"]["S"].as_str().ok_or_else(||anyhow::anyhow!("unsupported archived job id"))?;
            if let Some(previous)=all.insert(id.to_owned(),tag.clone()) {ensure!(previous==tag,"ambiguous archive");}
            if id!=job { continue; }
            if let Some(previous)=&found { ensure!(previous==&tag,"ambiguous archived job"); }
            found=Some(tag);
        }
    }
    let Some(tag) = found else {
        return Ok(None);
    };
    let Some(conversation) = tag["conversation_id"]["S"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        // Other JavaScript coercions are Node-owned, including numeric metadata.
        anyhow::bail!("unsupported archived conversation");
    };
    let logs = tag
        .get("logs")
        .map(attribute)
        .transpose()?
        .unwrap_or(Js::Null);
    let events = log_events(logs, job)
        .ok_or_else(|| anyhow::anyhow!("unsupported archived log timestamp"))?;
    ensure!(
        crate::wire::to_json(&events)?.len() <= 1024 * 1024,
        "log response cap"
    );
    Ok(Some((conversation.to_owned(), events)))
}
fn attribute(v: &Value) -> Result<Js> {
    if let Some(s) = v.get("S").and_then(Value::as_str) {
        return Ok(Js::Str(s.into()));
    }
    if let Some(b) = v.get("BOOL").and_then(Value::as_bool) {
        return Ok(Js::Bool(b));
    }
    if v.get("NULL") == Some(&Value::Bool(true)) {
        return Ok(Js::Null);
    }
    if let Some(list) = v.get("L").and_then(Value::as_array) {
        return Ok(Js::Arr(list.iter().map(attribute).collect::<Result<_>>()?));
    }
    if let Some(map) = v.get("M").and_then(Value::as_object) {
        let mut obj = js::Obj::new();
        for (key, value) in map {
            obj.set(key, attribute(value)?);
        }
        return Ok(Js::Obj(obj));
    }
    // Set, binary and numeric coercions stay with the legacy adapter.
    anyhow::bail!("unsupported archived log attribute")
}
fn log_events(raw: Js, job: &str) -> Option<Vec<contract::Event>> {
    let parsed = match raw {
        // JavaScript accepts lone surrogate escapes; the UTF-8 parser does
        // not. Such valid JSON must hand back, never become an empty log list.
        Js::Str(s) if s.to_ascii_lowercase().contains("\\ud") => return None,
        Js::Str(s) => js::parse(&s).unwrap_or(Js::Null),
        other => other,
    };
    let Some(Js::Arr(entries)) = parsed.as_obj().and_then(|o| o.get("entries")) else {
        return Some(Vec::new());
    };
    if entries.len() > 1000 {
        return None;
    }
    entries
        .iter()
        .map(|entry| {
            let field = |key| entry.as_obj().and_then(|o| o.get(key));
            let timestamp = match field("timestamp") {
                None | Some(Js::Null) => None,
                Some(Js::Str(s)) if s.is_empty() => None,
                Some(Js::Str(s)) => Some(iso_millis(s)?),
                _ => return None,
            };
            let level = field("level")
                .filter(|v| v.truthy())
                .map(Js::to_js_string)
                .unwrap_or_else(|| "INFO".into());
            let message = field("message")
                .filter(|v| !matches!(v, Js::Null))
                .map(Js::to_js_string)
                .unwrap_or_default();
            Some(contract::Event {
                timestamp,
                message: format!("[DELPHI JOB {job}] {level}: {message}"),
            })
        })
        .collect()
}
/// ISO timestamps only. Date.parse's other grammars stay with Node. Legacy
/// Python timestamps without a zone are admitted only under explicit UTC.
pub(crate) fn iso_millis(s: &str) -> Option<i64> {
    let s = if let Some(s) = s.strip_suffix('Z') {
        s
    } else {
        if std::env::var("TZ").ok().as_deref() != Some("UTC") {
            return None;
        }
        s
    };
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> {
        let p = b.get(a..z)?;
        if !p.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(p).ok()?.parse().ok()
    };
    let y = num(0, 4)?;
    let m = num(5, 7)?;
    let d = num(8, 10)?;
    let h = num(11, 13)?;
    let min = num(14, 16)?;
    let sec = num(17, 19)?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 || sec > 59 {
        return None;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if d > days[(m - 1) as usize] {
        return None;
    }
    let ms = if b.len() == 19 {
        0
    } else {
        if b[19] != b'.' || b.len() == 20 || !b[20..].iter().all(u8::is_ascii_digit) {
            return None;
        }
        let mut f = 0;
        for i in 20..23 {
            f = f * 10 + i64::from(b.get(i).copied().unwrap_or(b'0') - b'0');
        }
        f
    };
    let year = y - i64::from(m <= 2);
    let era = year.div_euclid(400);
    let yo = year - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let days = era * 146097 + yo * 365 + yo / 4 - yo / 100 + doy - 719468;
    Some(((days * 24 + h) * 60 + min) * 60000 + sec * 1000 + ms)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iso_dates_keep_node_millisecond_truncation() {
        assert_eq!(iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_millis("1969-12-31T23:59:59.999999Z"), Some(-1));
        assert_eq!(
            iso_millis("2023-11-14T20:21:00.123456Z"),
            Some(1699993260123)
        );
        assert!(iso_millis("2023-02-29T00:00:00Z").is_none());
        assert!(iso_millis("2024-02-29T00:00:00Z").is_some());
        assert!(iso_millis("Tue, 14 Nov 2023 00:00:00 GMT").is_none());
    }
    #[test]
    fn log_projection_preserves_order_and_javascript_strings() {
        assert!(
            log_events(
                Js::Str(r#"{"entries":[{"message":"\ud800"}]}"#.into()),
                "job"
            )
            .is_none()
        );

        let raw=js::parse(r#"{"entries":[{"timestamp":"1970-01-01T00:00:00Z","level":false,"message":{"x":1}},null,{"level":["WARN",3],"message":["x",null,2]}]}"#).unwrap();
        assert_eq!(
            crate::wire::to_json(&log_events(raw, "job").unwrap()).unwrap(),
            r#"[{"timestamp":0,"message":"[DELPHI JOB job] INFO: [object Object]"},{"message":"[DELPHI JOB job] INFO: "},{"message":"[DELPHI JOB job] WARN,3: x,,2"}]"#
        );
        assert!(
            log_events(
                js::parse(r#"{"entries":[{"timestamp":"not a date"}]}"#).unwrap(),
                "job"
            )
            .is_none()
        );
    }
}
