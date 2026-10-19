//! Empty legacy conversation reads with verified identity on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/legacy_conversations.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.legacy_conversations_db.is_none()
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
    let mut limit = None;
    let mut include_all = None;
    let mut active = None;
    let mut draft = None;
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "limit" if limit.is_none() => {
                let n = value.parse::<u32>().ok()?;
                if !(1..=9999).contains(&n) || n.to_string() != value {
                    return None;
                }
                limit = Some(n);
            }
            "include_all_conversations_i_am_in" if include_all.is_none() => {
                include_all = Some(value.parse::<bool>().ok()?)
            }
            "is_active" if active.is_none() => active = Some(value.parse::<bool>().ok()?),
            "is_draft" if draft.is_none() => draft = Some(value.parse::<bool>().ok()?),
            _ => return None,
        }
    }
    Some(contract::Request {
        limit: limit.unwrap_or(999),
        include_all: include_all.unwrap_or(false),
        is_active: active,
        is_draft: draft,
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
    let (Some(pool), Some(auth_pool)) = (
        &app.legacy_conversations_db,
        &app.legacy_conversations_auth_db,
    ) else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let identity = crate::hybrid_read::resolve(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
        )
        .await?;
        let Some(uid) = identity.uid() else {
            return Some(Decision::Denied);
        };
        pool.with(move |c| read(c, uid.0, &query))
            .await
            .ok()
            .flatten()
            .map(|_| Decision::Empty)
    })
    .await;
    match result {
        Ok(Some(Decision::Denied)) => {
            route::fail_json(req, res, 403, crate::js::Js::Str(contract::DENIED.into()))
        }
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

/// Prove the whole matching set is empty. Populated rows retain Node's computed
/// URLs and cached conversation codes, including pages that would be empty.
pub fn read(
    c: &mut postgres::Client,
    uid: i32,
    query: &contract::Request,
) -> anyhow::Result<Option<contract::EmptyResponse>> {
    let rows=c.query("SELECT 1 FROM conversations c WHERE (c.owner=$1 OR c.owner IN (SELECT uid FROM users WHERE site_id=(SELECT site_id FROM users WHERE uid=$1)) OR ($2 AND c.zid IN (SELECT zid FROM participants WHERE uid=$1))) AND ($3::boolean IS NULL OR c.is_active=$3) AND ($4::boolean IS NULL OR c.is_draft=$4) LIMIT 1",&[&uid,&query.include_all,&query.is_active,&query.is_draft])?;
    Ok(rows.is_empty().then_some([]))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    fn request() -> contract::Request {
        contract::Request {
            limit: 999,
            include_all: false,
            is_active: None,
            is_draft: None,
        }
    }
    #[tokio::test]
    async fn empty_visibility_preserves_owner_site_flags_and_isolates_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("legacy_conversations_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(zid integer,owner integer,is_active boolean,is_draft boolean); CREATE TABLE {setup_schema}.users(uid integer,site_id text); CREATE TABLE {setup_schema}.participants(zid integer,uid integer); INSERT INTO {setup_schema}.conversations VALUES(1,1,true,false),(2,2,false,true),(3,3,NULL,NULL); INSERT INTO {setup_schema}.users VALUES(1,'a'),(2,'b'),(3,NULL),(4,'a'),(5,NULL),(6,'c'); INSERT INTO {setup_schema}.participants VALUES(2,5);")).unwrap();
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
        for uid in [5, 6, 99] {
            assert_eq!(
                pool.with(move |c| read(c, uid, &request())).await.unwrap(),
                Some([])
            );
        }
        // Direct owners,including a NULL-site owner,and same-site users match.
        for uid in [1, 2, 3, 4] {
            assert!(
                pool.with(move |c| read(c, uid, &request()))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            pool.with(|c| {
                let mut q = request();
                q.include_all = true;
                read(c, 5, &q)
            })
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(
            pool.with(|c| {
                let mut q = request();
                q.include_all = true;
                q.is_active = Some(true);
                read(c, 5, &q)
            })
            .await
            .unwrap(),
            Some([])
        );
        assert_eq!(
            pool.with(|c| {
                let mut q = request();
                q.is_draft = Some(true);
                read(c, 4, &q)
            })
            .await
            .unwrap(),
            Some([])
        );
        assert_eq!(
            pool.with(|c| {
                let mut q = request();
                q.is_active = Some(false);
                read(c, 3, &q)
            })
            .await
            .unwrap(),
            Some([])
        );
        assert_eq!(
            serde_json::to_string(&([] as contract::EmptyResponse)).unwrap(),
            "[]"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 6, &request())).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, 6, &request()))
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
