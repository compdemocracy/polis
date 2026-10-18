//! Bounded bucket mapping reads on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/bid_to_pid.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.bid_to_pid_db.is_none()
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
    let mut tick = None;
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
            "math_tick" if tick.is_none() => {
                let n = value.parse::<i32>().ok()?;
                if n.to_string() != value {
                    return None;
                }
                tick = Some(n);
            }
            _ => return None,
        }
    }
    Some(contract::Request {
        conversation_id: cid?,
        math_tick: tick.unwrap_or(0),
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    NotModified,
    Rows(contract::Response),
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.bid_to_pid_db, &app.bid_to_pid_auth_db) else {
        return route::bad_gateway();
    };
    let env = app.math_env.clone();
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?;
        let cid = query.conversation_id;
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        pool.with(move |c| read(c, zid, &env, query.math_tick))
            .await
            .ok()
            .flatten()
    })
    .await;
    match result {
        Ok(Some(Decision::NotModified)) => route::empty_end(req, res, 304),
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

const LATEST_GENERATION: i32 = -1;
/// Node compares the embedded tick, not the table's math_tick column. A missing
/// embedded tick never satisfies its stale comparison. Preserve that behavior.
pub fn read(
    c: &mut postgres::Client,
    zid: i32,
    env: &str,
    tick: i32,
) -> anyhow::Result<Option<Decision>> {
    let rows=c.query("SELECT CASE WHEN octet_length(data::text)<=1048576 THEN data::text END FROM math_bidtopid WHERE zid=$1 AND math_env=$2 LIMIT 2",&[&zid,&env])?;
    if rows.is_empty() {
        return Ok(Some(Decision::NotModified));
    }
    if rows.len() != 1 {
        return Ok(None);
    }
    let Some(text) = rows[0].try_get::<_, Option<String>>(0)? else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(&text)?;
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if let Some(embedded) = object.get("math_tick") {
        let Some(embedded) = embedded
            .as_i64()
            .filter(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n))
        else {
            return Ok(None);
        };
        let requested = if tick == 0 { LATEST_GENERATION } else { tick };
        if embedded <= i64::from(requested) {
            return Ok(Some(Decision::NotModified));
        }
    }
    let Some(mapping) = object.get("bidToPid") else {
        return Ok(None);
    };
    let Ok(mapping) = serde_json::from_value::<Vec<Vec<u32>>>(mapping.clone()) else {
        return Ok(None);
    };
    if mapping.len() > 1000 || mapping.iter().map(Vec::len).sum::<usize>() > 10000 {
        return Ok(None);
    }
    Ok(Some(Decision::Rows(contract::Response {
        bid_to_pid: mapping,
    })))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn mapping_order_embedded_freshness_bounds_and_locked_read_shedding() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("bid_to_pid_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.math_bidtopid(zid integer,math_env text,math_tick bigint,data jsonb);")).unwrap();
            let rows=[(1,serde_json::json!({"math_tick":0,"bidToPid":[[3,1],[]]})),(2,serde_json::json!({"bidToPid":[[2]]})),(3,serde_json::json!({"math_tick":5,"bidToPid":[]})),(4,serde_json::json!({"bidToPid":[["2"]]})),(5,serde_json::Value::Null),(6,serde_json::json!({"bidToPid":vec![vec![0];1001]})),(7,serde_json::json!({"bidToPid":[vec![0;10001]]})),(8,serde_json::json!({"bidToPid":[],"padding":"x".repeat(1048576)})),(9,serde_json::json!({"math_tick":null,"bidToPid":[]}))];
            for (zid,value) in rows {c.execute(&format!("INSERT INTO {setup_schema}.math_bidtopid VALUES($1,'test',99,$2::text::jsonb)"),&[&zid,&value.to_string()]).unwrap();}
            c.batch_execute(&format!("INSERT INTO {setup_schema}.math_bidtopid SELECT 10,math_env,math_tick,data FROM {setup_schema}.math_bidtopid WHERE zid IN (1,2)")).unwrap();
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
        for tick in [0, LATEST_GENERATION] {
            let Some(Decision::Rows(response)) =
                pool.with(move |c| read(c, 1, "test", tick)).await.unwrap()
            else {
                panic!("expected mapping");
            };
            assert_eq!(response.bid_to_pid, vec![vec![3, 1], vec![]]);
        }
        assert_eq!(
            pool.with(|c| read(c, 1, "test", 1)).await.unwrap(),
            Some(Decision::NotModified)
        );
        assert!(matches!(
            pool.with(|c| read(c, 2, "test", i32::MAX)).await.unwrap(),
            Some(Decision::Rows(_))
        ));
        for zid in [3, 11] {
            assert_eq!(
                pool.with(move |c| read(c, zid, "test", 5)).await.unwrap(),
                Some(Decision::NotModified)
            );
        }
        for zid in 4..=10 {
            assert!(
                pool.with(move |c| read(c, zid, "test", 0))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            pool.with(|c| read(c, 1, "other", 0)).await.unwrap(),
            Some(Decision::NotModified)
        );
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.math_bidtopid IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 2, "test", 0)).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(matches!(
            pool.with(|c| read(c, 2, "test", 0)).await.unwrap(),
            Some(Decision::Rows(_))
        ));
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM math_bidtopid")?))
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
