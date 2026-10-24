//! Social participant rows on independent, bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/ptptois.rs"]
mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.ptptois_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let raw = req.query()?;
    if raw.len() > 4096 {
        return None;
    }
    let mut cid = None;
    let mut moderation = None;
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        match k.as_ref() {
            "conversation_id" if cid.is_none() => cid = Some(v.into_owned()),
            "mod" if moderation.is_none() => {
                let n = v.parse::<i32>().ok()?;
                if n.to_string() != v {
                    return None;
                }
                moderation = Some(n);
            }
            _ => return None,
        }
    }
    let cid = cid?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(contract::Request {
        conversation_id: cid,
        moderation,
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
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.ptptois_db, &app.ptptois_auth_db) else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let identity = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?;
        let uid = identity.uid().map(|v| v.0);
        let developer = uid.is_some_and(|v| app.legacy_admin_uids.contains(&v));
        let cid = query.conversation_id.clone();
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        pool.with(move |c| read(c, zid, uid, developer, &query))
            .await
            .ok()
            .flatten()
    })
    .await;
    match result {
        Ok(Some(response)) => match serde_json::to_string(&response) {
            Ok(body) => route::json_text(req, res, 200, body),
            Err(_) => route::bad_gateway(),
        },
        _ => route::bad_gateway(),
    }
}
/// The source has no final ORDER BY: admit at most one row, with no invented sort.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    uid: Option<i32>,
    developer: bool,
    query: &contract::Request,
) -> anyhow::Result<Option<contract::Response>> {
    let conv = c.query(
        "SELECT owner,is_data_open FROM conversations WHERE zid=$1 LIMIT 2",
        &[&zid],
    )?;
    if conv.len() != 1 {
        return Ok(None);
    }
    let owner: Option<i32> = conv[0].try_get(0)?;
    let open: Option<bool> = conv[0].try_get(1)?;
    let count=c.query_one("SELECT count(*) FROM (SELECT 1 FROM participants WHERE zid=$1 AND ($2::integer IS NULL OR mod=$2) LIMIT 100000) bounded",&[&zid,&query.moderation])?.try_get::<_,i64>(0)?;
    if count > 99999 {
        return Ok(None);
    }
    let rows=c.query("WITH p AS (SELECT uid,pid,mod FROM participants WHERE zid=$1 AND ($3::integer IS NULL OR mod=$3)), final_set AS (SELECT * FROM p LIMIT 99999), x AS (SELECT * FROM xids WHERE owner=$2 AND x_profile_image_url IS NOT NULL), a AS (SELECT f.mod,x.x_profile_image_url,x.xid,x.x_name,f.pid FROM final_set f LEFT JOIN x ON f.uid=x.uid WHERE x.xid IS NOT NULL), bounded AS (SELECT *,coalesce(octet_length(x_profile_image_url),0)+coalesce(octet_length(xid),0)+coalesce(octet_length(x_name),0)<=8192 AS fits FROM a) SELECT mod,CASE WHEN fits THEN x_profile_image_url END,CASE WHEN fits THEN xid END,CASE WHEN fits THEN x_name END,pid,fits FROM bounded LIMIT 2",&[&zid,&owner,&query.moderation])?;
    if uid.is_none_or(|u| Some(u) != owner) && !developer && open != Some(true) {
        return Ok(Some(vec![]));
    }
    if rows.len() > 1 {
        return Ok(None);
    }
    let Some(row) = rows.first() else {
        return Ok(Some(vec![]));
    };
    if !row.try_get::<_, bool>(5)? {
        return Ok(None);
    }
    let profile: String = row.try_get(1)?;
    let xid: String = row.try_get(2)?;
    let name: Option<String> = row.try_get(3)?;
    let nested = !profile.is_empty() || !xid.is_empty();
    Ok(Some(vec![contract::Participant {
        moderation: row.try_get(0)?,
        x_profile_image_url: (!nested).then(|| profile.clone()),
        xid: (!nested).then_some(xid),
        x_name: if nested { None } else { name.clone() },
        pid: row.try_get(4)?,
        x_info: nested.then_some(contract::XInfo {
            x_profile_image_url: profile,
            x_name: name,
        }),
        conversation_id: query.conversation_id.clone(),
    }]))
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "ptptois_tests.rs"]
mod tests;
