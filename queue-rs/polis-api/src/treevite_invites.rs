//! Tree-invitation wave reads with scoped hybrid auth on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/treevite_invites.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.treevite_invites_db.is_none()
        || req.headers.get("authorization").is_none()
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
    let mut values = std::collections::BTreeMap::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        if key == "conversation_id" && cid.is_none() {
            if value.is_empty()
                || value.len() > 100
                || !value.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return None;
            }
            cid = Some(value.into_owned());
        } else if ["wave_id", "status", "limit", "offset"].contains(&key.as_ref())
            && !values.contains_key(key.as_ref())
        {
            let n = value.parse::<i32>().ok()?;
            if n.to_string() != value {
                return None;
            }
            values.insert(key.into_owned(), n);
        } else {
            return None;
        }
    }
    Some(contract::Request {
        conversation_id: cid?,
        wave_id: values.get("wave_id").copied(),
        status: values.get("status").copied(),
        limit: values
            .get("limit")
            .copied()
            .filter(|n| *n > 0)
            .unwrap_or(50)
            .min(500),
        offset: values.get("offset").copied().unwrap_or(0).max(0),
    })
}

enum Decision {
    Denied,
    Rows(contract::Response),
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.treevite_invites_db, &app.treevite_invites_auth_db)
    else {
        return route::bad_gateway();
    };
    let admins = app.legacy_admin_uids.clone();
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let (zid, uid) =
            crate::treevite_read::identity(app, req, auth_pool, &query.conversation_id).await?;
        pool.with(move |c| {
            if !crate::treevite_read::permits(c, zid, uid, &admins)? {
                return Ok(Some(Decision::Denied));
            }
            Ok(read(c, zid, &query)?.map(Decision::Rows))
        })
        .await
        .ok()
        .flatten()
    })
    .await;
    match result {
        Ok(Some(Decision::Denied)) => route::fail_json(
            req,
            res,
            403,
            crate::js::Js::Str("polis_err_treevite_not_conversation_owner".into()),
        ),
        Ok(Some(Decision::Rows(response))) => {
            let Ok(encoded) = serde_json::to_string(&response) else {
                return route::bad_gateway();
            };
            let Ok(value) = crate::js::parse(&encoded) else {
                return route::bad_gateway();
            };
            route::json(req, res, &value)
        }
        _ => route::bad_gateway(),
    }
}

pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}

/// A bounded complete matching set detects unspecified ordering at ties. The
/// independent count must agree before the page and metadata can be served.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    query: &contract::Request,
) -> anyhow::Result<Option<contract::Response>> {
    let wave_id = query.wave_id.map(i64::from);
    let rows=c.query("SELECT i.id,i.zid,i.wave_id,i.invite_code,i.status,i.invite_used_by_pid, to_char(i.invite_used_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),w.wave, (i.invite_used_at IS NULL OR (isfinite(i.invite_used_at) AND EXTRACT(YEAR FROM i.invite_used_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999)) AND (i.created_at IS NULL OR (isfinite(i.created_at) AND EXTRACT(YEAR FROM i.created_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999)) AND (i.updated_at IS NULL OR (isfinite(i.updated_at) AND EXTRACT(YEAR FROM i.updated_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999)),i.created_at::text FROM treevite_invites i LEFT JOIN treevite_waves w ON i.wave_id=w.id WHERE i.zid=$1 AND i.invite_owner_pid IS NULL AND ($2::bigint IS NULL OR i.wave_id=$2) AND ($3::integer IS NULL OR i.status=$3) ORDER BY i.created_at DESC LIMIT 1001",&[&zid,&wave_id,&query.status])?;
    if rows.len() > 1000 {
        return Ok(None);
    }
    let total:i32=c.query_one("SELECT count(*)::int FROM treevite_invites WHERE zid=$1 AND invite_owner_pid IS NULL AND ($2::bigint IS NULL OR wave_id=$2) AND ($3::integer IS NULL OR status=$3)",&[&zid,&wave_id,&query.status])?.try_get(0)?;
    if total as usize != rows.len() {
        return Ok(None);
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut invites = Vec::new();
    for row in rows {
        if !row.try_get::<_, bool>(10)? || !seen.insert(row.try_get::<_, Option<String>>(11)?) {
            return Ok(None);
        }
        invites.push(contract::Invite {
            id: row.try_get::<_, i64>(0)?.to_string(),
            zid: row.try_get(1)?,
            wave_id: row.try_get::<_, i64>(2)?.to_string(),
            invite_code: row.try_get(3)?,
            status: row.try_get(4)?,
            invite_used_by_pid: row.try_get(5)?,
            invite_used_at: row.try_get(6)?,
            created_at: row.try_get(7)?,
            updated_at: row.try_get(8)?,
            wave: row.try_get(9)?,
        });
    }
    Ok(Some(contract::Response {
        invites: invites
            .into_iter()
            .skip(query.offset as usize)
            .take(query.limit as usize)
            .collect(),
        pagination: contract::Pagination {
            limit: query.limit,
            offset: query.offset,
            total,
            has_more: i64::from(query.offset) + i64::from(query.limit) < i64::from(total),
        },
    }))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    fn query() -> contract::Request {
        contract::Request {
            conversation_id: "fixture".into(),
            wave_id: None,
            status: None,
            limit: 50,
            offset: 0,
        }
    }

    #[tokio::test]
    async fn invites_preserve_pagination_and_shed_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("treevite_invites_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.treevite_waves(id bigint,wave integer); CREATE TABLE {setup_schema}.treevite_invites(id bigint,zid integer,wave_id bigint,invite_code text,status smallint,invite_owner_pid integer,invite_used_by_pid integer,invite_used_at timestamptz,created_at timestamptz,updated_at timestamptz); INSERT INTO {setup_schema}.treevite_waves VALUES(9,3); INSERT INTO {setup_schema}.treevite_invites VALUES(9007199254740993,1,9,'alpha',0,NULL,NULL,NULL,'2020-01-02 03:04:05.123456+03',NULL),(2,1,9,'beta',1,NULL,3,'1969-12-31 23:59:59.999999+00',NULL,NULL),(3,1,9,'owned',0,4,NULL,NULL,NULL,NULL),(4,2,9,'tie1',0,NULL,NULL,NULL,NULL,NULL),(5,2,9,'tie2',0,NULL,NULL,NULL,NULL,NULL),(6,3,9,'infinite',0,NULL,NULL,NULL,'infinity',NULL); INSERT INTO {setup_schema}.treevite_invites SELECT x,4,9,'large',0,NULL,NULL,NULL,to_timestamp(x),NULL FROM generate_series(1,1001) x;")).unwrap();
        }).await.unwrap();
        let make_pool = || {
            let mut c: postgres::Config = url.parse().unwrap();
            c.options(&format!("-c search_path={schema}"));
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(c)),
                pool_limits(),
            )
        };
        let pool = make_pool();
        let participation = make_pool();
        let first = pool.with(|c| read(c, 1, &query())).await.unwrap().unwrap();
        assert_eq!(first.invites.len(), 2);
        assert_eq!(first.pagination.total, 2);
        assert_eq!(first.invites[0].id, "2"); // DESC orders NULL first.
        assert_eq!(
            first.invites[0].invite_used_at.as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(first.invites[1].id, "9007199254740993");
        assert_eq!(
            first.invites[1].created_at.as_deref(),
            Some("2020-01-02T00:04:05.123Z")
        );
        assert_eq!(first.invites[1].wave, Some(3));
        let second = pool
            .with(|c| {
                let mut q = query();
                q.limit = 1;
                q.offset = 1;
                read(c, 1, &q)
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.invites.len(), 1);
        assert!(!second.pagination.has_more);
        let first_page = pool
            .with(|c| {
                let mut q = query();
                q.limit = 1;
                read(c, 1, &q)
            })
            .await
            .unwrap()
            .unwrap();
        assert!(first_page.pagination.has_more);
        let filtered = pool
            .with(|c| {
                let mut q = query();
                q.wave_id = Some(9);
                q.status = Some(0);
                read(c, 1, &q)
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(filtered.invites.len(), 1);
        assert_eq!(filtered.pagination.total, 1);
        for zid in [2, 3, 4] {
            assert!(
                pool.with(move |c| read(c, zid, &query()))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.treevite_invites IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let stalled = pool.clone();
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 5, &query())).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, 5, &query()))
                .await
                .unwrap()
                .unwrap()
                .invites
                .is_empty()
        );
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM treevite_invites")?))
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(pool);
            drop(participation);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
}
