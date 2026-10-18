//! Empty participant-owned invites on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/treevite_my_invites.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.treevite_my_invites_db.is_none()
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

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (
        &app.treevite_my_invites_db,
        &app.treevite_my_invites_auth_db,
    ) else {
        return route::bad_gateway();
    };
    let Some(raw) = req.headers.get("authorization") else {
        return route::bad_gateway();
    };
    let Some(verifier) = app.participant_verifier.as_deref() else {
        return route::bad_gateway();
    };
    let Some(identity) = verifier.verify(
        raw,
        &query.conversation_id,
        (crate::clock::now_ms() / 1000.0) as u64,
    ) else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let (zid, pid) = auth_pool
            .with(move |c| {
                let Some(zid) = crate::db::zid_for_conversation_id(c, &query.conversation_id)?
                else {
                    return Ok(None);
                };
                if zid <= 0 {
                    return Ok(None);
                }
                Ok(
                    polis_auth::participant::resolve(c, polis_auth::Zid(zid), &identity)?
                        .map(|pid| (zid, pid.0 as i32)),
                )
            })
            .await
            .ok()
            .flatten()?;
        pool.with(move |c| read(c, zid, pid)).await.ok().flatten()
    })
    .await;
    match result {
        Ok(Some(response)) => {
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

/// Populated participant-owned invitations retain Node's credential response.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    pid: i32,
) -> anyhow::Result<Option<contract::EmptyResponse>> {
    let rows = c.query(
        "SELECT 1 FROM treevite_invites WHERE zid=$1 AND invite_owner_pid=$2 AND status=0 LIMIT 1",
        &[&zid, &pid],
    )?;
    Ok(rows.is_empty().then_some([]))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn empty_invites_preserve_participant_status_scope_and_shed_locks() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("treevite_my_invites_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.treevite_invites(zid integer,invite_owner_pid integer,status integer); INSERT INTO {setup_schema}.treevite_invites VALUES(1,3,0),(1,4,1),(1,5,NULL);")).unwrap();
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
        for (zid, pid) in [(1, 4), (1, 5), (2, 3)] {
            let response = pool
                .with(move |c| read(c, zid, pid))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::to_string(&response).unwrap(), "[]");
        }
        assert!(pool.with(|c| read(c, 1, 3)).await.unwrap().is_none());
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 1, 4)).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, 1, 4))
                .await
                .unwrap()
                .unwrap()
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
