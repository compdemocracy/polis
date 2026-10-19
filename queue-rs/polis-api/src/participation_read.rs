//! Owner-only participation summaries (PID counts) with scoped hybrid auth on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/participation_read.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.participation_read_db.is_none()
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
    let mut strict = None;
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
            "strict" if strict.is_none() => {
                strict = Some(match value.as_ref() {
                    "true" => true,
                    "false" => false,
                    _ => return None,
                });
            }
            _ => return None,
        }
    }
    Some(contract::Request {
        conversation_id: cid?,
        strict: strict.unwrap_or(false),
    })
}

enum Decision {
    Denied,
    Rows(Read),
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) =
        (&app.participation_read_db, &app.participation_read_auth_db)
    else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let (zid, uid) =
            crate::treevite_read::identity(app, req, auth_pool, &query.conversation_id).await?;
        pool.with(move |c| {
            if !owner(c, zid, uid)? {
                return Ok(Some(Decision::Denied));
            }
            Ok(read(c, zid, query.strict)?.map(Decision::Rows))
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
            crate::js::Js::Str("polis_err_get_participation_auth".into()),
        ),
        Ok(Some(Decision::Rows(Read::MissingXids))) => route::fail_json(req,res,409,crate::js::Js::Str("polis_err_get_participation_missing_xids This conversation has no xids for its participants.".into())),
        Ok(Some(Decision::Rows(Read::Rows(response)))) => {
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

pub fn owner(c: &mut postgres::Client, zid: i32, uid: polis_auth::Uid) -> anyhow::Result<bool> {
    use polis_auth::{Authority, Level, PostgresLookup, Principal, Zid};
    let identity = Principal::User {
        uid,
        oidc_sub: None,
    };
    let authority = Authority::for_conversation(
        &mut PostgresLookup(c),
        Zid(zid),
        &identity,
        Level::Owner,
        &[],
    )
    .map_err(|_| anyhow::anyhow!("authority lookup unavailable"))?;
    Ok(authority == Authority::Owner)
}
#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    MissingXids,
    Rows(contract::Response),
}
/// Count events without reading vote values. XID-based summaries and oversized
/// PID sets remain with Node; authority has already been checked by the caller.
pub fn read(c: &mut postgres::Client, zid: i32, strict: bool) -> anyhow::Result<Option<Read>> {
    let votes = c.query(
        "SELECT pid,count(*) FROM votes WHERE zid=$1 GROUP BY pid LIMIT 1001",
        &[&zid],
    )?;
    let comments = c.query(
        "SELECT pid,count(*) FROM comments WHERE zid=$1 GROUP BY pid LIMIT 1001",
        &[&zid],
    )?;
    if votes.len() > 1000 || comments.len() > 1000 {
        return Ok(None);
    }
    let xids=c.query("SELECT 1 FROM xids JOIN participants p ON xids.uid=p.uid WHERE p.zid=$1 AND xids.owner IN (SELECT owner FROM conversations WHERE zid=$1) LIMIT 1",&[&zid])?;
    if !xids.is_empty() {
        return Ok(None);
    }
    if strict {
        return Ok(Some(Read::MissingXids));
    }
    let mut result = contract::Response::new();
    for (rows, is_vote) in [(votes, true), (comments, false)] {
        for row in rows {
            let Some(pid) = row.try_get::<_, Option<i32>>(0)? else {
                return Ok(None);
            };
            let count: i64 = row.try_get(1)?;
            if pid < 0 || !(0..=9_007_199_254_740_991).contains(&count) {
                return Ok(None);
            }
            let entry = result.entry(pid).or_default();
            if is_vote {
                entry.votes = count as u64;
            } else {
                entry.comments = count as u64;
            }
        }
    }
    if result.len() > 1000 {
        return Ok(None);
    }
    Ok(Some(Read::Rows(result)))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn owner_pid_counts_strict_refusal_and_locked_read_shedding() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("participation_read_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            // Vote values are neither inserted nor read by this fixture.
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(zid integer,owner integer); CREATE TABLE {setup_schema}.votes(zid integer,pid integer); CREATE TABLE {setup_schema}.comments(zid integer,pid integer); CREATE TABLE {setup_schema}.participants(zid integer,pid integer,uid integer); CREATE TABLE {setup_schema}.xids(uid integer,owner integer,xid text); INSERT INTO {setup_schema}.conversations VALUES(1,1),(2,2); INSERT INTO {setup_schema}.comments VALUES(1,0),(1,0),(1,2),(4,-1); INSERT INTO {setup_schema}.participants VALUES(2,0,2); INSERT INTO {setup_schema}.xids VALUES(2,2,'fixture'); INSERT INTO {setup_schema}.comments SELECT 3,x FROM generate_series(1,1001) x;")).unwrap();
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
        let Read::Rows(counts) = pool.with(|c| read(c, 1, false)).await.unwrap().unwrap() else {
            panic!("expected PID summary");
        };
        assert_eq!(counts.keys().copied().collect::<Vec<_>>(), vec![0, 2]);
        assert_eq!(
            counts[&0],
            contract::Counts {
                votes: 0,
                comments: 2
            }
        );
        assert_eq!(counts[&2].comments, 1);
        assert_eq!(
            pool.with(|c| read(c, 1, true)).await.unwrap(),
            Some(Read::MissingXids)
        );
        assert_eq!(
            pool.with(|c| read(c, 5, false)).await.unwrap(),
            Some(Read::Rows(contract::Response::new()))
        );
        for zid in [2, 3, 4] {
            assert!(
                pool.with(move |c| read(c, zid, false))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        pool.with(|c| {
            assert!(owner(c, 1, polis_auth::Uid(1))?);
            assert!(!owner(c, 1, polis_auth::Uid(2))?);
            assert!(owner(c, 2, polis_auth::Uid(2))?);
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
                "BEGIN; LOCK TABLE {lock_schema}.comments IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 1, false)).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(matches!(
            pool.with(|c| read(c, 1, false)).await.unwrap(),
            Some(Read::Rows(_))
        ));
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM comments")?))
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
