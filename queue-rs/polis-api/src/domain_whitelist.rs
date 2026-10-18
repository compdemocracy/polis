//! Site domain whitelist with verified hybrid auth on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/domain_whitelist.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.domain_whitelist_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some_and(|q| !q.is_empty())
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    Some(contract::Request::default())
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(_query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Some(pool) = &app.domain_whitelist_db else {
        return route::bad_gateway();
    };
    let Some(auth_pool) = &app.domain_whitelist_auth_db else {
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
        pool.with(move |client| read(client, uid))
            .await
            .ok()
            .flatten()
    })
    .await;
    let Ok(Some(response)) = result else {
        return route::bad_gateway();
    };
    let Ok(encoded) = serde_json::to_string(&response) else {
        return route::bad_gateway();
    };
    let Ok(value) = crate::js::parse(&encoded) else {
        return route::bad_gateway();
    };
    route::json(req, res, &value)
}

pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}

/// No ordering is imposed on Node's legacy duplicate rows. Multiple rows are
/// unsupported, so Node retains its own choice instead of Rust inventing one.
pub fn read(
    client: &mut postgres::Client,
    uid: polis_auth::Uid,
) -> anyhow::Result<Option<contract::Response>> {
    let rows=client.query("SELECT domain_whitelist FROM site_domain_whitelist WHERE site_id = (SELECT site_id FROM users WHERE uid = $1)", &[&uid.0])?;
    if rows.len() > 1 {
        return Ok(None);
    }
    let value = rows
        .first()
        .map(|r| r.try_get::<_, Option<String>>(0))
        .transpose()?
        .flatten()
        .unwrap_or_default();
    Ok(Some(contract::Response {
        domain_whitelist: value,
    }))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    use polis_auth::Uid;
    #[tokio::test]
    async fn whitelist_reads_only_the_verified_users_site_and_hands_back_duplicates() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("domain_whitelist_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
              CREATE TABLE users(uid integer,site_id text);
              CREATE TABLE site_domain_whitelist(site_id text,domain_whitelist text);
              INSERT INTO users VALUES(1,'a'),(2,'b'),(3,NULL),(4,'empty'),(5,'null'),(6,'duplicates');
              INSERT INTO site_domain_whitelist VALUES('a','a.example.invalid'),('b','b.example.invalid'),('null',NULL),('duplicates','one'),('duplicates','two');")).unwrap();
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
        for (uid, expected) in [
            (1, "a.example.invalid"),
            (2, "b.example.invalid"),
            (3, ""),
            (4, ""),
            (5, ""),
            (99, ""),
        ] {
            assert_eq!(
                pool.with(move |c| read(c, Uid(uid)))
                    .await
                    .unwrap()
                    .unwrap()
                    .domain_whitelist,
                expected
            );
        }
        assert!(pool.with(|c| read(c, Uid(6))).await.unwrap().is_none());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.site_domain_whitelist IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, Uid(1))).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(pool.with(|c| read(c, Uid(1))).await.unwrap().is_some());
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM site_domain_whitelist")?))
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
