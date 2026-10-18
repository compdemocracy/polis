//! Empty report reads with moderator authority on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/reports_read.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.reports_read_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let raw = req.query().unwrap_or_default();
    if raw.len() > 4096 {
        return None;
    }
    let mut cid = None;
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        if key != "conversation_id"
            || cid.is_some()
            || value.is_empty()
            || value.len() > 100
            || !value.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return None;
        }
        cid = Some(value.into_owned());
    }
    Some(contract::Request {
        conversation_id: cid,
    })
}

enum Decision {
    Denied,
    Empty,
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.reports_read_db, &app.reports_read_auth_db) else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let identity = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            query.conversation_id.as_deref(),
        )
        .await?;
        let uid = identity.uid().map(|u| u.0);
        let zid = if let Some(cid) = query.conversation_id {
            let zid = auth_pool
                .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
                .await
                .ok()
                .flatten()?;
            if zid <= 0 {
                return None;
            }
            let uid = uid?;
            let admins = app.legacy_admin_uids.clone();
            let allowed = pool
                .with(move |c| crate::treevite_read::permits(c, zid, polis_auth::Uid(uid), &admins))
                .await
                .ok()?;
            if !allowed {
                return Some(Decision::Denied);
            }
            Some(zid)
        } else {
            None
        };
        // Node reads report rows on primary. Release the separate authority
        // connection before using this route's primary identity/data pool.
        auth_pool
            .with(move |c| read(c, zid, uid))
            .await
            .ok()
            .flatten()
            .map(|_| Decision::Empty)
    })
    .await;
    match result {
        Ok(Some(Decision::Denied)) => route::fail_json(
            req,
            res,
            403,
            crate::js::Js::Str("polis_err_permissions".into()),
        ),
        Ok(Some(Decision::Empty)) => route::json(req, res, &crate::js::Js::Arr(Vec::new())),
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

/// Populated report rows and report-capability reads remain Node work.
pub fn read(
    c: &mut postgres::Client,
    zid: Option<i32>,
    uid: Option<i32>,
) -> anyhow::Result<Option<contract::EmptyResponse>> {
    let rows = if let Some(zid) = zid {
        c.query("SELECT 1 FROM reports WHERE zid=$1 LIMIT 1", &[&zid])?
    } else {
        c.query("SELECT 1 FROM reports WHERE zid IN (SELECT zid FROM conversations WHERE owner=$1) LIMIT 1",&[&uid])?
    };
    Ok(rows.is_empty().then_some([]))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn empty_report_scopes_primary_reads_and_locked_read_shedding() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("reports_read_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(zid integer,owner integer); CREATE TABLE {setup_schema}.users(uid integer,site_id text); CREATE TABLE {setup_schema}.reports(zid integer); INSERT INTO {setup_schema}.conversations VALUES(1,1),(2,2),(3,3),(4,NULL); INSERT INTO {setup_schema}.users VALUES(1,'a'),(2,'b'),(3,NULL); INSERT INTO {setup_schema}.reports VALUES(1),(3),(4);")).unwrap();
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
        for (zid, uid) in [(Some(2), Some(1)), (None, Some(2)), (None, None)] {
            assert_eq!(
                pool.with(move |c| read(c, zid, uid)).await.unwrap(),
                Some([])
            );
        }
        for (zid, uid) in [
            (Some(1), Some(2)),
            (Some(3), None),
            (None, Some(1)),
            (None, Some(3)),
        ] {
            assert!(
                pool.with(move |c| read(c, zid, uid))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        pool.with(|c| {
            assert!(crate::treevite_read::permits(
                c,
                1,
                polis_auth::Uid(1),
                &[]
            )?);
            assert!(!crate::treevite_read::permits(
                c,
                1,
                polis_auth::Uid(2),
                &[]
            )?);
            assert!(crate::treevite_read::permits(
                c,
                1,
                polis_auth::Uid(2),
                &[2]
            )?);
            assert!(!crate::treevite_read::permits(
                c,
                3,
                polis_auth::Uid(3),
                &[]
            )?);
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
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, Some(2), Some(1))).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, Some(2), Some(1)))
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM reports")?))
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
