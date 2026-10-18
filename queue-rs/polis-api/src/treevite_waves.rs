//! Tree-invitation wave reads with scoped hybrid auth on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/treevite_waves.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.treevite_waves_db.is_none()
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
    let mut wave = None;
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "conversation_id" if cid.is_none() => {
                if value.is_empty()
                    || value.len() > 100
                    || !value.bytes().all(|b| b.is_ascii_alphanumeric())
                {
                    return None;
                }
                cid = Some(value.into_owned());
            }
            "wave" if wave.is_none() => {
                let n = value.parse::<i32>().ok()?;
                if n.to_string() != value {
                    return None;
                }
                wave = Some(n);
            }
            _ => return None,
        }
    }
    Some(contract::Request {
        conversation_id: cid?,
        wave,
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
    let (Some(pool), Some(auth_pool)) = (&app.treevite_waves_db, &app.treevite_waves_auth_db)
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
            Ok(read(c, zid, query.wave)?.map(Decision::Rows))
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

/// Keep bigint identifiers as strings and timestamps at JavaScript millisecond
/// precision. Oversized results and dates outside the staged range hand back.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    wave: Option<i32>,
) -> anyhow::Result<Option<contract::Response>> {
    let rows=c.query("SELECT id,zid,wave,parent_wave,invites_per_user,owner_invites,size, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), (created_at IS NULL OR (isfinite(created_at) AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999)) AND (updated_at IS NULL OR (isfinite(updated_at) AND EXTRACT(YEAR FROM updated_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999)) FROM treevite_waves WHERE zid=$1 AND ($2::integer IS NULL OR wave=$2) ORDER BY wave ASC LIMIT 501",&[&zid,&wave])?;
    if rows.len() > 500 {
        return Ok(None);
    }
    let mut result = Vec::new();
    for row in rows {
        if !row.try_get::<_, bool>(9)? {
            return Ok(None);
        }
        result.push(contract::Wave {
            id: row.try_get::<_, i64>(0)?.to_string(),
            zid: row.try_get(1)?,
            wave: row.try_get(2)?,
            parent_wave: row.try_get(3)?,
            invites_per_user: row.try_get(4)?,
            owner_invites: row.try_get(5)?,
            size: row.try_get(6)?,
            created_at: row.try_get(7)?,
            updated_at: row.try_get(8)?,
        });
    }
    Ok(Some(result))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn waves_preserve_wire_types_authority_and_shed_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("treevite_waves_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.treevite_waves(id bigint,zid integer,wave integer,parent_wave integer,invites_per_user integer,owner_invites integer,size integer,created_at timestamptz,updated_at timestamptz); CREATE TABLE {setup_schema}.conversations(zid integer,owner integer); CREATE TABLE {setup_schema}.users(uid integer,site_id text); INSERT INTO {setup_schema}.conversations VALUES(1,1); INSERT INTO {setup_schema}.users VALUES(1,'site'),(2,'site'),(3,NULL); INSERT INTO {setup_schema}.treevite_waves VALUES(9007199254740993,1,3,NULL,4,5,NULL,'1969-12-31 23:59:59.999999+00','2020-01-02 03:04:05.123456+03'),(1,2,1,NULL,1,1,NULL,'infinity',NULL); INSERT INTO {setup_schema}.treevite_waves SELECT x,3,x,NULL,1,1,NULL,NULL,NULL FROM generate_series(1,501) x;")).unwrap();
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
        let waves = pool.with(|c| read(c, 1, None)).await.unwrap().unwrap();
        assert_eq!(waves.len(), 1);
        assert_eq!(waves[0].id, "9007199254740993");
        assert_eq!(
            waves[0].created_at.as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            waves[0].updated_at.as_deref(),
            Some("2020-01-02T00:04:05.123Z")
        );
        assert!(waves[0].parent_wave.is_none());
        assert!(
            pool.with(|c| read(c, 1, Some(0)))
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            pool.with(|c| read(c, 1, Some(3)))
                .await
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        for zid in [2, 3] {
            assert!(
                pool.with(move |c| read(c, zid, None))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        pool.with(|c| {
            for (uid, admins, expected) in [
                (1, vec![], true),
                (2, vec![], true),
                (3, vec![], false),
                (3, vec![3], true),
            ] {
                assert_eq!(
                    crate::treevite_read::permits(c, 1, polis_auth::Uid(uid), &admins)?,
                    expected
                );
            }
            Ok(())
        })
        .await
        .unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.treevite_waves IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 4, None)).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, 4, None))
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM treevite_waves")?))
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
