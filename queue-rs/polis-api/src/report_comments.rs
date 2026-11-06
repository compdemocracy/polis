//! Report statement reads on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
    votes::{StorageConvention, VoteChoice},
};
#[path = "../../polis-contracts/src/report_comments.rs"]
mod contract;
pub use contract::PATH;
#[derive(Debug, PartialEq)]
pub enum ParseError {
    Handback,
    BadRequest,
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
pub fn parse(app: &App, req: &Request) -> Result<contract::Request, ParseError> {
    if app.report_comments_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|v| v != "0")
        || req.headers.get("cookie").is_some()
    {
        return Err(ParseError::Handback);
    }
    let raw = req.query().unwrap_or_default();
    if raw.len() > 4096 {
        return Err(ParseError::Handback);
    }
    parse_query(raw)
}
fn parse_query(raw: &str) -> Result<contract::Request, ParseError> {
    let values = crate::params::parse_query(raw);
    if values
        .iter()
        .any(|(key, _)| !["conversation_id", "report_id", "mod_gt"].contains(&key.as_str()))
    {
        return Err(ParseError::Handback);
    }
    let string = |key| {
        let Some(crate::js::Js::Str(value)) = values.get(key) else {
            return Err(ParseError::BadRequest);
        };
        if value.is_empty() || value.encode_utf16().count() > 100 {
            return Err(ParseError::BadRequest);
        }
        Ok(value.clone())
    };
    let conversation_id = string("conversation_id")?;
    let report_id = string("report_id")?;
    let level = values
        .get("mod_gt")
        .map(|v| route::get_int(v).ok_or(ParseError::BadRequest))
        .transpose()?
        .unwrap_or(-2.0);
    if ![-2.0, -1.0, 0.0].contains(&level) {
        return Err(ParseError::Handback);
    }
    Ok(contract::Request {
        conversation_id,
        report_id,
        mod_gt: level as i32,
    })
}
enum Decision {
    UnknownReport,
    Rows(contract::Response),
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let query = match parse(app, req) {
        Ok(query) => query,
        Err(ParseError::BadRequest) => return route::parameter_error(app, req, res),
        Err(ParseError::Handback) => return route::bad_gateway(),
    };
    let (Some(pool), Some(auth_pool)) = (&app.report_comments_db, &app.report_comments_auth_db)
    else {
        return route::bad_gateway();
    };
    let admins = app.legacy_admin_uids.clone();
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let identity = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?;
        let cid = query.conversation_id.clone();
        let context = auth_pool
            .with(move |c| {
                let Some(zid) = crate::db::zid_for_conversation_id(c, &cid)?.filter(|z| *z > 0)
                else {
                    return Ok(None);
                };
                let moderator = match identity.uid() {
                    Some(uid) => crate::treevite_read::permits(c, zid, uid, &admins)?,
                    None => false,
                };
                Ok(Some((zid, !moderator)))
            })
            .await
            .ok()
            .flatten()?;
        // The report lookup and statement reads use this route's replica pool.
        // No math, model, translation provider or selection read is needed for
        // these eight fields. Identity has released its connection already.
        pool.with(move |c| {
            let (zid, visible) = context;
            let Some(report) = c.query_opt(
                "SELECT zid FROM reports WHERE report_id=$1",
                &[&query.report_id],
            )?
            else {
                return Ok(Some(Decision::UnknownReport));
            };
            // An unrelated report is outside this report-page contract. Node
            // retains the overloaded route's independent report lookup.
            if report.try_get::<_, i32>(0)? != zid {
                return Ok(None);
            }
            let strict = c
                .query_opt(
                    "SELECT strict_moderation FROM conversations WHERE zid=$1",
                    &[&zid],
                )?
                .map(|r| r.try_get::<_, Option<bool>>(0))
                .transpose()?
                .flatten()
                .unwrap_or(false);
            read(c, zid, query.mod_gt, visible, strict).map(|rows| Some(Decision::Rows(rows)))
        })
        .await
        .ok()
        .flatten()
    })
    .await;
    match result {
        Ok(Some(Decision::UnknownReport)) => route::parameter_error(app, req, res),
        Ok(Some(Decision::Rows(rows))) => match serde_json::to_string(&rows) {
            Ok(body) => route::json_text(req, res, 200, body),
            Err(_) => route::bad_gateway(),
        },
        _ => route::bad_gateway(),
    }
}
fn read(
    c: &mut postgres::Client,
    zid: i32,
    level: i32,
    visible: bool,
    strict: bool,
) -> anyhow::Result<contract::Response> {
    let mut sql = String::from(
        "select * from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)",
    );
    let mut params: Vec<&(dyn postgres::types::ToSql + Sync)> = vec![&zid];
    if level > -2 {
        sql.push_str(" and comments.mod > ($2)");
        params.push(&level);
    }
    if visible {
        sql.push_str(" and comments.active = true and comments.velocity > 0");
        sql.push_str(if strict {
            " and comments.mod = 1"
        } else {
            " and comments.mod != -1"
        });
    }
    // Preserve Node's unordered join and first occurrence of each tid.
    let rows = c.query(&sql, &params)?;
    let Some(first) = rows.first() else {
        return Ok(Vec::new());
    };
    // Node pg keeps the last column with a duplicate name. SELECT * is
    // intentional: changing its width can change this unordered join's plan.
    // foo.tid is nullable for an unvoted comment; comments.tid is the last tid.
    let tid_column = first
        .columns()
        .iter()
        .rposition(|col| col.name() == "tid")
        .ok_or_else(|| anyhow::anyhow!("report statement identity missing"))?;
    let mut counts = std::collections::HashMap::<i32, [u64; 3]>::new();
    for row in &rows {
        let bins = counts.entry(row.try_get(tid_column)?).or_default();
        let index = match StorageConvention::CURRENT
            .decode(row.try_get::<_, Option<i16>>("vote")?.map(i32::from))
        {
            Some(VoteChoice::Agree) => Some(0),
            Some(VoteChoice::Disagree) => Some(1),
            Some(VoteChoice::Pass) => Some(2),
            None => None,
        };
        if let Some(index) = index {
            bins[index] = u64::try_from(row.try_get::<_, Option<i64>>("count")?.unwrap_or(0))?;
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        let tid = row.try_get(tid_column)?;
        if !seen.insert(tid) {
            continue;
        }
        let [agree_count, disagree_count, pass_count] = counts[&tid];
        result.push(contract::Comment {
            txt: row.try_get("txt")?,
            tid,
            is_meta: row.try_get("is_meta")?,
            pid: row.try_get("pid")?,
            agree_count,
            disagree_count,
            pass_count,
            count: agree_count + disagree_count + pass_count,
        });
    }
    Ok(result)
}
#[cfg(test)]
#[path = "report_comments_tests.rs"]
mod tests;
