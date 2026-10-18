//! Empty developer conversation reads with developer authority on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/all_conversations.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.all_conversations_db.is_none()
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
    let mut email = None;
    let mut limit = None;
    let mut offset = None;
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "owner_email" if email.is_none() => {
                if value.len() > 999 || !value.is_ascii() {
                    return None;
                }
                email = Some(value.trim_matches(' ').to_owned());
            }
            "limit" if limit.is_none() => {
                let n = value.parse::<u32>().ok()?;
                if !(1..=9999).contains(&n) || n.to_string() != value {
                    return None;
                }
                limit = Some(n.min(500));
            }
            "offset" if offset.is_none() => {
                let n = value.parse::<u32>().ok()?;
                if n > 99_999_999 || n.to_string() != value {
                    return None;
                }
                offset = Some(n);
            }
            _ => return None,
        }
    }
    Some(contract::Request {
        owner_email: email,
        limit: limit.unwrap_or(50),
        offset: offset.unwrap_or(0),
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
    let (Some(pool), Some(auth_pool)) = (&app.all_conversations_db, &app.all_conversations_auth_db)
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
        let email = query.owner_email.clone();
        pool.with(move |c| read(c, email.as_deref()))
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
        Ok(Some(Decision::Empty)) => {
            let Ok(bytes) = serde_json::to_string(&query.empty()) else {
                return route::bad_gateway();
            };
            let Ok(value) = crate::js::parse(&bytes) else {
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

/// A matching row remains Node work, even if the requested page would be empty.
pub fn read(c: &mut postgres::Client, email: Option<&str>) -> anyhow::Result<Option<()>> {
    let pattern = email.filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
    let rows=c.query("SELECT 1 FROM conversations c LEFT JOIN users u ON u.uid=c.owner WHERE ($1::text IS NULL OR u.email ILIKE $1) LIMIT 1",&[&pattern])?;
    Ok(rows.is_empty().then_some(()))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn empty_matching_set_preserves_email_filter_and_sheds_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("all_conversations_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(owner integer); CREATE TABLE {setup_schema}.users(uid integer,email text); INSERT INTO {setup_schema}.conversations VALUES(1),(2),(NULL); INSERT INTO {setup_schema}.users VALUES(1,'Owner@fixture.invalid'),(2,NULL);")).unwrap();
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
        for email in [Some("absent"), Some("fixture.example"), Some("NULL")] {
            assert_eq!(pool.with(move |c| read(c, email)).await.unwrap(), Some(()));
        }
        for email in [
            None,
            Some(""),
            Some("owner@FIXTURE"),
            Some("%"),
            Some("_"),
            Some("Owner"),
        ] {
            assert!(pool.with(move |c| read(c, email)).await.unwrap().is_none());
        }
        let request = contract::Request {
            owner_email: Some("absent".into()),
            limit: 500,
            offset: 99_999_999,
        };
        assert_eq!(
            serde_json::to_string(&request.empty()).unwrap(),
            r#"{"conversations":[],"pagination":{"limit":500,"offset":99999999,"total":0,"hasMore":false}}"#
        );
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, Some("absent"))).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert_eq!(
            pool.with(|c| read(c, Some("absent"))).await.unwrap(),
            Some(())
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
