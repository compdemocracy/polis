//! Empty topic selection reads on a dedicated bounded primary read-only pool.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/topic_selections.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.topic_selections_db.is_none()
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
    let Some(pool) = &app.topic_selections_db else {
        return route::bad_gateway();
    };
    let identity = if let Some(raw) = req.headers.get("authorization") {
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
        Some(identity)
    } else {
        None
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(75),
        pool.with(move |c| {
            let Some(zid) = crate::db::zid_for_conversation_id(c, &query.conversation_id)? else {
                return Ok(None);
            };
            if zid <= 0 {
                return Ok(None);
            }
            let pid = if let Some(identity) = identity {
                let Some(pid) =
                    polis_auth::participant::resolve(c, polis_auth::Zid(zid), &identity)?
                else {
                    return Ok(None);
                };
                Some(pid.0 as i32)
            } else {
                None
            };
            read(c, zid, pid)
        }),
    )
    .await;
    match result {
        Ok(Ok(Some(response))) => {
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

/// Without a participant, Node returns before querying selections. Verified
/// participant requests are served only when their primary selection set is empty.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    pid: Option<i32>,
) -> anyhow::Result<Option<contract::EmptyResponse>> {
    if let Some(pid) = pid
        && !c
            .query(
                "SELECT 1 FROM topic_agenda_selections WHERE zid=$1 AND pid=$2 LIMIT 1",
                &[&zid, &pid],
            )?
            .is_empty()
    {
        return Ok(None);
    }
    Ok(Some(contract::EmptyResponse::default()))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn empty_selection_scope_preserves_anonymous_result_and_sheds_locks() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("topic_selections_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.topic_agenda_selections(zid integer,pid integer); INSERT INTO {setup_schema}.topic_agenda_selections VALUES(1,3);")).unwrap();
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
        for (zid, pid) in [(1, None), (1, Some(4)), (2, Some(3))] {
            let response = pool
                .with(move |c| read(c, zid, pid))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_string(&response).unwrap(),
                r#"{"status":"success","message":"No selections found","data":null}"#
            );
        }
        assert!(pool.with(|c| read(c, 1, Some(3))).await.unwrap().is_none());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.topic_agenda_selections IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 1, Some(4))).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(pool.with(|c| read(c, 1, Some(4))).await.unwrap().is_some());
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM topic_agenda_selections")?))
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
