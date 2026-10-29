//! Moderator-only statement reads on independent, bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/moderation_comments.rs"]
mod contract;
pub use contract::PATH;

#[derive(Debug, PartialEq)]
pub enum ParseError {
    Handback,
    BadRequest,
}

pub fn parse(app: &App, req: &Request) -> Result<contract::Request, ParseError> {
    if app.moderation_comments_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return Err(ParseError::Handback);
    }
    let raw = req.query().unwrap_or("");
    if raw.len() > 4096 {
        return Err(ParseError::Handback);
    }
    parse_query(raw)
}

fn parse_query(raw: &str) -> Result<contract::Request, ParseError> {
    // Use the same qs types and getInt implementation as the Node twin:
    // repeated and bracketed keys are arrays/objects, never scalar integers.
    let values = crate::params::parse_query(raw);
    if values
        .iter()
        .any(|(key, _)| !["conversation_id", "mod", "limit", "offset"].contains(&key.as_str()))
    {
        return Err(ParseError::Handback);
    }
    let Some(crate::js::Js::Str(cid)) = values.get("conversation_id") else {
        return Err(ParseError::BadRequest);
    };
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(ParseError::BadRequest);
    }
    let integer = |key: &str| {
        values
            .get(key)
            .map(|v| route::get_int(v).ok_or(ParseError::BadRequest))
            .transpose()
    };
    // Parse supported keys before deciding whether a numeric mod is in-domain.
    let status = integer("mod")?;
    let limit = integer("limit")?;
    let offset = integer("offset")?.unwrap_or(0.0);
    // The page always selects a bounded page and one moderation state.
    let status = status.ok_or(ParseError::Handback)?;
    let limit = limit.ok_or(ParseError::Handback)?;
    if ![-1.0, 0.0, 1.0].contains(&status) {
        return Err(ParseError::Handback);
    }
    Ok(contract::Request {
        conversation_id: cid.clone(),
        r#mod: status as i32,
        limit: if limit > 0.0 {
            limit.min(500.0) as i32
        } else {
            50
        },
        offset: offset.max(0.0),
    })
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
enum Decision {
    Denied,
    Rows(contract::Response),
    InvalidOffset,
}

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let query = match parse(app, req) {
        Ok(query) => query,
        Err(ParseError::BadRequest) => return route::parameter_error(app, req, res),
        Err(ParseError::Handback) => return route::bad_gateway(),
    };
    let (Some(pool), Some(auth_pool)) = (
        &app.moderation_comments_db,
        &app.moderation_comments_auth_db,
    ) else {
        return route::bad_gateway();
    };
    let admins = app.legacy_admin_uids.clone();
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        // Missing or unverifiable identities never become anonymous list reads.
        // This purpose-specific route has no participant-visible response.
        let Some(uid) = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await
        .and_then(|identity| identity.uid()) else {
            return Some(Decision::Denied);
        };
        let cid = query.conversation_id.clone();
        let authority = auth_pool
            .with(move |c| {
                let Some(zid) = crate::db::zid_for_conversation_id(c, &cid)?.filter(|zid| *zid > 0)
                else {
                    return Ok(None);
                };
                Ok(crate::treevite_read::permits(c, zid, uid, &admins)?.then_some(zid))
            })
            .await
            .ok()?;
        let Some(zid) = authority else {
            return Some(Decision::Denied);
        };
        // PostgreSQL accepts OFFSET as a signed bigint. Node has already rounded
        // the decimal prefix to a JavaScript Number; out-of-range values fail
        // its query with polis_err_get_comments, not a parser error or handback.
        if !query.offset.is_finite() || query.offset >= 9_223_372_036_854_775_808.0 {
            return Some(Decision::InvalidOffset);
        }
        // No list-pool acquisition, statement query or count precedes authority.
        pool.with(move |c| read(c, zid, &query))
            .await
            .ok()
            .map(Decision::Rows)
    })
    .await;
    match result {
        Ok(Some(Decision::Denied)) => {
            route::fail_json(req, res, 403, crate::js::Js::Str(contract::DENIED.into()))
        }
        Ok(Some(Decision::InvalidOffset)) => route::fail_json(
            req,
            res,
            500,
            crate::js::Js::Str("polis_err_get_comments".into()),
        ),
        Ok(Some(Decision::Rows(response))) => match encode(&response) {
            Ok(body) => route::json_text(req, res, 200, body),
            Err(_) => route::bad_gateway(),
        },
        _ => route::bad_gateway(),
    }
}
fn encode(response: &contract::Response) -> anyhow::Result<String> {
    // Retain declaration order and JavaScript number spelling (including -0).
    Ok(crate::js::stringify(&crate::js::parse(
        &serde_json::to_string(response)?,
    )?))
}
/// Match Node's status filter, separate count and unordered LIMIT/OFFSET query.
/// Activity, velocity and strict moderation never hide rows from moderators.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    query: &contract::Request,
) -> anyhow::Result<contract::Response> {
    let total: i64 = c
        .query_one(
            "select count(*) from comments where comments.zid = $1 and comments.mod = $2",
            &[&zid, &query.r#mod],
        )?
        .try_get(0)?;
    let rows = c.query("select comments.*, comments.velocity::text AS node_velocity from comments where comments.zid = $1 and comments.mod = $2 LIMIT $3 OFFSET $4", &[&zid, &query.r#mod, &i64::from(query.limit), &(query.offset as i64)])?;
    let comments = rows
        .iter()
        .map(|r| {
            Ok(contract::Comment {
                txt: r.try_get("txt")?,
                tid: r.try_get("tid")?,
                is_meta: r.try_get("is_meta")?,
                // pg's text protocol rounds REAL before Node parses it, unlike f32->f64.
                velocity: r
                    .try_get::<_, Option<String>>("node_velocity")?
                    .map(|v| crate::js::string_to_number(&v)),
                r#mod: r.try_get("mod")?,
                active: r.try_get("active")?,
                conversation_id: query.conversation_id.clone(),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(contract::Response {
        comments,
        pagination: contract::Pagination {
            limit: query.limit,
            offset: query.offset as i64,
            total,
            has_more: query.offset + f64::from(query.limit) < total as f64,
        },
    })
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "moderation_comments_tests.rs"]
mod tests;
