//! Empty recent-conversation reads with developer authority on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/recent_activity.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.recent_activity_db.is_none()
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
    let raw = req.query().unwrap_or_default();
    if raw.len() > 4096 {
        return None;
    }
    let mut since = None;
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        if key != "sinceUnixTimestamp" || since.is_some() {
            return None;
        }
        let parsed = value.parse::<i64>().ok()?;
        if !(0..=9_007_199_254_740).contains(&parsed) || parsed.to_string() != value {
            return None;
        }
        since = Some(parsed);
    }
    Some(contract::Request {
        since_unix_timestamp: since,
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
    let (Some(pool), Some(auth_pool)) = (&app.recent_activity_db, &app.recent_activity_auth_db)
    else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let uid = crate::hybrid_read::resolve(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
        )
        .await?
        .uid()?;
        if !app.legacy_admin_uids.contains(&uid.0) {
            return Some(Decision::Denied);
        }
        let since = query
            .since_unix_timestamp
            .map(|s| s * 1000)
            .unwrap_or_else(|| (crate::clock::now_ms() - 604_800_000.0) as i64);
        pool.with(move |c| read(c, since))
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
            crate::js::Js::Str("polis_err_no_access_for_this_user".into()),
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

/// Populated SELECT * responses remain with Node until their schema-wide wire
/// representation is staged. The inclusive timestamp boundary matches Node.
pub fn read(
    c: &mut postgres::Client,
    since: i64,
) -> anyhow::Result<Option<contract::EmptyResponse>> {
    let rows = c.query(
        "SELECT 1 FROM conversations c WHERE c.modified >= $1
         OR (c.modified IS NOT NULL AND EXISTS (SELECT 1 FROM votes v WHERE v.zid=c.zid AND v.created >= $1))
         OR (c.modified IS NOT NULL AND EXISTS (SELECT 1 FROM comments m WHERE m.zid=c.zid AND (m.created >= $1 OR m.modified >= $1))) LIMIT 1",
        &[&since],
    )?;
    Ok(rows.is_empty().then_some([]))
}
#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn inclusive_timestamp_empty_slice_sheds_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("recent_activity_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(zid int, modified bigint); CREATE TABLE {setup_schema}.votes(zid int, created bigint); CREATE TABLE {setup_schema}.comments(zid int, created bigint, modified bigint); INSERT INTO {setup_schema}.conversations VALUES(1,2000),(2,NULL),(3,1),(4,1); INSERT INTO {setup_schema}.votes VALUES(2,9000),(3,3000); INSERT INTO {setup_schema}.comments VALUES(4,4000,5000);")).unwrap();
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
        for zid in [5001, 9007199254740000] {
            assert!(
                pool.with(move |c| read(c, zid))
                    .await
                    .unwrap()
                    .unwrap()
                    .is_empty()
            );
        }
        for since in [2000, 3000, 4000, 5000] {
            assert!(pool.with(move |c| read(c, since)).await.unwrap().is_none());
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.conversations IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 5001)).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, 5001))
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM conversations")?))
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
