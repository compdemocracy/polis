//! Bucket and location reads on independent, bounded, read-only pools.
use crate::{
    http::{Outgoing, Request},
    math_bundle::Read,
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/math_membership.rs"]
mod contract;
use contract::Kind;
pub use contract::{BID_PATH, LOCATIONS_PATH};
pub fn matches(path: &str) -> bool {
    matches!(path, BID_PATH | LOCATIONS_PATH)
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    let kind = match req.path() {
        BID_PATH => Kind::Bid,
        LOCATIONS_PATH => Kind::Locations,
        _ => return None,
    };
    let enabled = match kind {
        Kind::Bid => app.bid_db.is_some(),
        Kind::Locations => app.locations_db.is_some(),
    };
    if !enabled
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    if kind == Kind::Bid && req.headers.get("authorization").is_none() {
        return None;
    }
    let raw = req.query()?;
    if raw.len() > 4096 {
        return None;
    }
    let (mut cid, mut tick, mut gid) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        match k.as_ref() {
            "conversation_id" if cid.is_none() => cid = Some(v.into_owned()),
            "math_tick" if kind == Kind::Bid && tick.is_none() => {
                let n = v.parse::<i32>().ok()?;
                if n.to_string() != v {
                    return None;
                }
                tick = Some(n);
            }
            "gid" if kind == Kind::Locations && gid.is_none() => {
                let n = v.parse::<i32>().ok()?;
                if n.to_string() != v {
                    return None;
                }
                gid = Some(n);
            }
            _ => return None,
        }
    }
    let cid = cid?;
    if cid.is_empty()
        || cid.len() > 100
        || !cid.bytes().all(|b| b.is_ascii_alphanumeric())
        || (kind == Kind::Locations && gid.is_none())
    {
        return None;
    }
    Some(contract::Request {
        kind,
        conversation_id: cid,
        math_tick: tick.unwrap_or(-1),
        gid,
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
    let (Some(pool), Some(auth_pool)) = (match query.kind {
        Kind::Bid => (&app.bid_db, &app.bid_auth_db),
        Kind::Locations => (&app.locations_db, &app.locations_auth_db),
    }) else {
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
        let cid = query.conversation_id;
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        let bundle = app.math_bundle.get(pool, zid, &app.math_env).await?;
        let encoded = match query.kind {
            Kind::Bid => {
                let uid = identity.uid()?.0;
                let pid = pool
                    .with(move |c| {
                        let rows = c.query(
                            "SELECT pid FROM participants WHERE zid=$1 AND uid=$2 LIMIT 2",
                            &[&zid, &uid],
                        )?;
                        Ok(if rows.len() == 1 {
                            Some(rows[0].try_get::<_, i32>(0)?)
                        } else {
                            None
                        })
                    })
                    .await
                    .ok()
                    .flatten()?;
                if pid < 0 || bundle.tick() <= i64::from(query.math_tick) {
                    return None;
                }
                let bid = match bundle.as_ref() {
                    Read::Complete(b) => b.bid(pid),
                    _ => None,
                };
                serde_json::to_string(&contract::Bid { bid }).ok()?
            }
            Kind::Locations => {
                let pids = match bundle.as_ref() {
                    Read::Complete(b) if b.tick > -1 => b.pids(query.gid?)?,
                    _ => vec![],
                };
                let response = pool
                    .with(move |c| locations(c, zid, &pids))
                    .await
                    .ok()
                    .flatten()?;
                serde_json::to_string(&response).ok()?
            }
        };
        crate::js::parse(&encoded).ok()
    })
    .await;
    match result {
        Ok(Some(value)) => route::json(req, res, &value),
        _ => route::bad_gateway(),
    }
}
pub fn locations(
    c: &mut postgres::Client,
    zid: i32,
    pids: &[i32],
) -> anyhow::Result<Option<Vec<contract::Location>>> {
    if pids.len() > 16384 {
        return Ok(None);
    }
    let rows = c.query(
        "SELECT lat,lng FROM participant_locations WHERE zid=$1 AND pid=ANY($2) LIMIT 2",
        &[&zid, &pids],
    )?;
    if rows.len() > 1 {
        return Ok(None);
    }
    let mut out = Vec::new();
    for row in rows {
        let lat: f64 = row.try_get(0)?;
        let lng: f64 = row.try_get(1)?;
        if !lat.is_finite() || !lng.is_finite() {
            return Ok(None);
        }
        out.push(contract::Location {
            lat: crate::wire::JsNumber::new(lat)?,
            lng: crate::wire::JsNumber::new(lng)?,
            n: 1,
        });
    }
    Ok(Some(out))
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "math_membership_tests.rs"]
mod tests;
