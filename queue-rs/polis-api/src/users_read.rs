//! User reads with owner, administrator, or record-self authorization.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/users_read.rs"]
pub(crate) mod contract;
pub use contract::PATH;
use contract::{Request as Query, Response as User, XInfo};
const DENIED: &str = "polis_err_get_user_not_authorized";
#[derive(Debug)]
enum Decision {
    Unauthorized,
    Denied,
    User(Box<User>),
}
trait Store {
    fn xid_uid(&mut self, xid: &str, owner: i32) -> anyhow::Result<Option<i32>>;
    fn user(&mut self, uid: i32) -> anyhow::Result<User>;
    fn xid_info(&mut self, xid: &str, owner: i32) -> anyhow::Result<Option<XInfo>>;
}
// Neither query fields nor a token's XID are authority. Identity is resolved
// separately before this function; only the three comparisons below grant access.
fn read<S: Store>(
    store: &mut S,
    uid: Option<i32>,
    admins: &[i32],
    query: &Query,
) -> anyhow::Result<Decision> {
    let Some(uid) = uid.filter(|u| *u != 0) else {
        return Ok(Decision::Unauthorized);
    };
    let mut selected = uid;
    let mut lookup = None;
    if let (Some(xid), Some(owner)) = (
        query.xid.as_deref().filter(|s| !s.is_empty()),
        query.owner.filter(|v| *v != 0),
    ) {
        let record_uid = store.xid_uid(xid, owner)?;
        if uid != owner && !admins.contains(&uid) && record_uid != Some(uid) {
            return Ok(Decision::Denied);
        }
        if let Some(target) = record_uid {
            selected = target;
            lookup = Some((xid, owner));
        }
    }
    let mut user = store.user(selected)?;
    // The absent-record branch never repeats the lookup: a record inserted
    // after authorization cannot add another user's profile to the fallback.
    if let Some((xid, owner)) = lookup {
        user.x_info = store.xid_info(xid, owner)?;
    }
    user.has_xid = user.x_info.is_some();
    Ok(Decision::User(Box::new(user)))
}
struct PgStore<'a>(&'a mut postgres::Client);
impl Store for PgStore<'_> {
    fn xid_uid(&mut self, xid: &str, owner: i32) -> anyhow::Result<Option<i32>> {
        let rows = self.0.query(
            "SELECT uid FROM xids WHERE xid=$1 AND owner=$2 LIMIT 2",
            &[&xid, &owner],
        )?;
        anyhow::ensure!(rows.len() <= 1, "ambiguous XID");
        rows.first()
            .map(|r| r.try_get(0).map_err(Into::into))
            .transpose()
    }
    fn user(&mut self, uid: i32) -> anyhow::Result<User> {
        let rows = self.0.query(
            "SELECT email,hname,tut,site_id,created FROM users WHERE uid=$1 LIMIT 2",
            &[&uid],
        )?;
        anyhow::ensure!(rows.len() == 1, "user unavailable");
        let r = &rows[0];
        Ok(User {
            uid,
            email: r.try_get(0)?,
            hname: r.try_get(1)?,
            finished_tutorial: r.try_get::<_, Option<i16>>(2)?.is_some_and(|v| v != 0),
            site_ids: [r.try_get(3)?],
            created: r.try_get::<_, Option<i64>>(4)?.unwrap_or(0) as f64,
            has_xid: false,
            x_info: None,
        })
    }
    fn xid_info(&mut self, xid: &str, owner: i32) -> anyhow::Result<Option<XInfo>> {
        let rows = self.0.query("SELECT uid,xid,x_profile_image_url,x_name,x_email,modified::text,zid,pid FROM xids WHERE xid=$1 AND owner=$2 LIMIT 2", &[&xid,&owner])?;
        anyhow::ensure!(rows.len() <= 1, "ambiguous XID");
        rows.first()
            .map(|r| {
                Ok(XInfo {
                    uid: r.try_get(0)?,
                    xid: r.try_get(1)?,
                    x_profile_image_url: r.try_get(2)?,
                    x_name: r.try_get(3)?,
                    x_email: r.try_get(4)?,
                    modified: r.try_get(5)?,
                    zid: r.try_get(6)?,
                    pid: r.try_get(7)?,
                })
            })
            .transpose()
    }
}
pub fn parse(app: &App, req: &Request) -> Option<Query> {
    if app.users_read_db.is_none()
        || app.users_read_auth_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    parse_query(req.query().unwrap_or_default())
}
fn parse_query(raw: &str) -> Option<Query> {
    // Express 3 keeps a value verbatim when decodeURIComponent throws.
    // Match the report parser's admission: ambiguous decoding stays on Node.
    let b = raw.as_bytes();
    if raw.len() > 4096
        || !raw.is_ascii()
        || (0..b.len()).any(|i| {
            b[i] == b'%'
                && !(i + 2 < b.len()
                    && b[i + 1].is_ascii_hexdigit()
                    && b[i + 2].is_ascii_hexdigit())
        })
    {
        return None;
    }
    let mut query = Query::default();
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if v.contains(['\0', '\u{FFFD}']) {
            return None;
        }
        match k.as_ref() {
            "xid" if query.xid.is_none() && !v.is_empty() && v.encode_utf16().count() <= 999 => {
                query.xid = Some(v.into_owned())
            }
            "owner_uid" if query.owner.is_none() => {
                let n = v.parse::<i32>().ok()?;
                if n.to_string() != v {
                    return None;
                }
                query.owner = Some(n);
            }
            _ => return None,
        }
    }
    Some(query)
}
// Node reads XIDs on the primary and user rows on its optional replica.
// This initial adapter admits only the single-database topology; it must not
// substitute fresh primary data for a separately configured replica's result.
pub fn primary_topology(users: &str, primary: Option<&str>, replica: Option<&str>) -> bool {
    primary.is_some_and(|p| !p.is_empty() && users == p)
        && replica.is_none_or(|r| r.is_empty() || Some(r) == primary)
}
pub fn pool_limits() -> crate::db::Limits {
    crate::xid_report::pool_limits()
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.users_read_db, &app.users_read_auth_db) else {
        return route::bad_gateway();
    };
    let admins = app.legacy_admin_uids.clone();
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let identity = crate::hybrid_read::resolve(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
        )
        .await?;
        let uid = identity.uid().map(|u| u.0);
        if uid.is_none() {
            return Some(Decision::Unauthorized);
        }
        pool.with(move |c| read(&mut PgStore(c), uid, &admins, &query))
            .await
            .ok()
    })
    .await;
    match result {
        Ok(Some(Decision::Unauthorized)) => route::fail_json(
            req,
            res,
            401,
            crate::js::Js::Str("Authentication required".into()),
        ),
        Ok(Some(Decision::Denied)) => {
            route::fail_json(req, res, 403, crate::js::Js::Str(DENIED.into()))
        }
        Ok(Some(Decision::User(user))) => {
            let Ok(text) = serde_json::to_string(&user) else {
                return route::bad_gateway();
            };
            let Ok(value) = crate::js::parse(&text) else {
                return route::bad_gateway();
            };
            route::json(req, res, &value)
        }
        _ => route::bad_gateway(),
    }
}
#[cfg(test)]
#[path = "users_read_tests.rs"]
mod tests;
