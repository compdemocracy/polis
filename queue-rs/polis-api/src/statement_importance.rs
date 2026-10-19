//! Public importance aggregates on their own bounded read-only pool.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/statement_importance.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<String> {
    if app.statement_importance_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
    {
        return None;
    }
    let raw = req.query()?;
    if raw.len() > 4096 {
        return None;
    }
    let pairs = url::form_urlencoded::parse(raw.as_bytes()).collect::<Vec<_>>();
    if pairs.len() != 1 || pairs[0].0 != "conversation_id" {
        return None;
    }
    let cid = pairs[0].1.as_ref();
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(cid.into())
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
// One statement gives resolution, visibility, counts and time the same snapshot.
// No vote values, participant ids or text leave storage. In particular a LEFT
// JOIN's null-extended row must not count as a vote. Only each participant's
// latest vote counts; tied timestamps prefer high_priority, as an explicit rule.
pub fn read(c: &mut postgres::Client, cid: &str) -> anyhow::Result<Option<contract::Response>> {
    let rows = c.query(
        "SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint,
        s.tid, s.important, s.voters
        FROM zinvites z JOIN conversations cv ON cv.zid=z.zid
        LEFT JOIN LATERAL (
            SELECT cm.tid, count(v.pid) FILTER (WHERE v.high_priority IS TRUE) AS important,
                count(v.pid) AS voters
            FROM comments cm LEFT JOIN LATERAL (
                SELECT DISTINCT ON (l.pid) l.pid, l.high_priority FROM votes l
                WHERE l.zid=cm.zid AND l.tid=cm.tid
                ORDER BY l.pid, l.created DESC NULLS LAST, l.high_priority DESC
            ) v ON true
            WHERE cm.zid=z.zid AND cm.active IS TRUE AND cm.velocity > 0
                AND cm.mod >= CASE WHEN cv.strict_moderation IS TRUE THEN 1 ELSE 0 END
            GROUP BY cm.tid ORDER BY cm.tid LIMIT 10001
        ) s ON true WHERE z.zinvite=$1 ORDER BY s.tid",
        &[&cid],
    )?;
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    anyhow::ensure!(
        rows.len() <= contract::MAX_STATEMENTS,
        "statement count bound"
    );
    let mut response = contract::Response {
        schema: contract::SCHEMA.into(),
        conversation_id: cid.into(),
        read_at_ms: first.try_get::<_, i64>(0)?.try_into()?,
        statements: Vec::new(),
    };
    for row in rows {
        if let Some(tid) = row.try_get::<_, Option<i32>>(1)? {
            response.statements.push(contract::Statement {
                tid,
                important: row.try_get::<_, i64>(2)?.try_into()?,
                voters: row.try_get::<_, i64>(3)?.try_into()?,
            });
        }
    }
    anyhow::ensure!(response.valid_for(cid), "invalid aggregate");
    Ok(Some(response))
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(cid) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Some(pool) = &app.statement_importance_db else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(75),
        pool.with(move |c| read(c, &cid)),
    )
    .await;
    match result {
        Ok(Ok(Some(response))) => {
            let Ok(encoded) = serde_json::to_string(&response) else {
                return route::bad_gateway();
            };
            let Ok(value) = crate::js::parse(&encoded) else {
                return route::bad_gateway();
            };
            route::json(req, res, &value)
        }
        Ok(Ok(None)) => route::fail_json(
            req,
            res,
            404,
            crate::js::Js::Str("Conversation not found".into()),
        ),
        _ => route::bad_gateway(),
    }
}
