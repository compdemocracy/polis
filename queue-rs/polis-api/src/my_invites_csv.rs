//! Participant-owned invitation CSV on independent, bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/my_invites_csv.rs"]
mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.my_invites_csv_db.is_none()
        || req.path() != PATH
        || req.headers.get("authorization").is_none()
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
    let pairs = url::form_urlencoded::parse(raw.as_bytes()).collect::<Vec<_>>();
    if pairs.len() != 1 || pairs[0].0 != "conversation_id" {
        return None;
    }
    let cid = pairs[0].1.as_ref();
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(contract::Request {
        conversation_id: cid.into(),
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
    let (Some(pool), Some(auth_pool)) = (&app.my_invites_csv_db, &app.my_invites_csv_auth_db)
    else {
        return route::bad_gateway();
    };
    let utc_dates = matches!(std::env::var("TZ").ok().as_deref(), Some("UTC" | "Etc/UTC"));
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let uid = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?
        .uid()?;
        let cid = query.conversation_id;
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        pool.with(move |c| read(c, zid, uid.0, utc_dates))
            .await
            .ok()
            .flatten()
    })
    .await;
    match result {
        Ok(Some(response)) => {
            let Some(stamp) = timestamp(crate::clock::now_ms() as u64) else {
                return route::bad_gateway();
            };
            route::csv_attachment(
                req,
                res,
                &format!(
                    "my_treevite_invites_{}_{}.csv",
                    response.conversation_id, stamp
                ),
                response.csv,
            )
        }
        _ => route::bad_gateway(),
    }
}

fn timestamp(ms: u64) -> Option<String> {
    if ms > 253402300799999 {
        return None;
    }
    let date = crate::http::http_date(ms / 1000);
    let parts = date.split_whitespace().collect::<Vec<_>>();
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| *m == parts[2])?
        + 1;
    Some(format!(
        "{}-{month:02}-{}T{}-{:03}Z",
        parts[3],
        parts[1],
        parts[4].replace(':', "-"),
        ms % 1000
    ))
}
fn date_string(seconds: i64) -> Option<String> {
    if !(0..=253402300799).contains(&seconds) {
        return None;
    }
    let d = crate::http::http_date(seconds as u64);
    let p = d.split_whitespace().collect::<Vec<_>>();
    Some(format!(
        "{} {} {} {}",
        p[0].trim_end_matches(','),
        p[2],
        p[1],
        p[3]
    ))
}
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    uid: i32,
    utc_dates: bool,
) -> anyhow::Result<Option<contract::Response>> {
    let codes = c.query("SELECT zinvite FROM zinvites WHERE zid=$1 LIMIT 2", &[&zid])?;
    if codes.len() != 1 {
        return Ok(None);
    }
    let cid: String = codes[0].try_get(0)?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Ok(None);
    }
    let rows = c.query(
        "SELECT pid FROM participants WHERE zid=$1 AND uid=$2 LIMIT 2",
        &[&zid, &uid],
    )?;
    if rows.len() > 1 {
        return Ok(None);
    }
    let pid = match rows.first() {
        Some(r) => r.try_get::<_, i32>(0)?,
        None => -1,
    };
    let mut csv = String::from("invite_code,status,created_at");
    if pid == -1 {
        csv.push('\n');
        return Ok(Some(contract::Response {
            conversation_id: cid,
            csv,
        }));
    }
    if pid < 0 {
        return Ok(None);
    }
    let rows=c.query("SELECT CASE WHEN octet_length(invite_code)<=8192 THEN invite_code END,floor(extract(epoch FROM created_at))::bigint FROM treevite_invites WHERE zid=$1 AND invite_owner_pid=$2 AND status=0 ORDER BY id ASC LIMIT 201",&[&zid,&pid])?;
    if rows.len() > 200 || (!rows.is_empty() && !utc_dates) {
        return Ok(None);
    }
    for row in rows {
        let Some(code) = row.try_get::<_, Option<String>>(0)? else {
            return Ok(None);
        };
        let date = match row.try_get::<_, Option<i64>>(1)? {
            Some(s) => {
                let Some(d) = date_string(s) else {
                    return Ok(None);
                };
                d
            }
            None => String::new(),
        };
        csv.push('\n');
        csv.push_str(&contract::escape(&code));
        csv.push_str(",unused,");
        csv.push_str(&date);
        if csv.len() > 65536 {
            return Ok(None);
        }
    }
    Ok(Some(contract::Response {
        conversation_id: cid,
        csv,
    }))
}
#[cfg(all(test, feature = "db-tests"))]
#[path = "my_invites_csv_tests.rs"]
mod tests;
