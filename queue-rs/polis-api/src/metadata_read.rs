//! Aggregate metadata reads with scoped hybrid auth on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/metadata_read.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.metadata_read_db.is_none()
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
    let Some(pool) = &app.metadata_read_db else {
        return route::bad_gateway();
    };
    let Some(auth_pool) = &app.metadata_read_auth_db else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?;
        let cid = query.conversation_id.clone();
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        pool.with(move |c| read(c, zid)).await.ok().flatten()
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

/// Preserve Node's scalar choice assignment and inclusion of inactive rows.
/// Unordered duplicate choices and oversized/irregular data stay with Node.
pub fn read(c: &mut postgres::Client, zid: i32) -> anyhow::Result<Option<contract::Response>> {
    use std::collections::{BTreeMap, BTreeSet};
    let questions = c.query(
        "SELECT pmqid,key FROM participant_metadata_questions WHERE zid=$1 LIMIT 1001",
        &[&zid],
    )?;
    let answers = c.query(
        "SELECT pmaid,pmqid,value FROM participant_metadata_answers WHERE zid=$1 LIMIT 1001",
        &[&zid],
    )?;
    let choices = c.query(
        "SELECT pmqid,pmaid,pid FROM participant_metadata_choices WHERE zid=$1 LIMIT 1001",
        &[&zid],
    )?;
    if questions.len() > 1000 || answers.len() > 1000 || choices.len() > 1000 {
        return Ok(None);
    }
    if questions.is_empty() {
        return Ok(Some(contract::Response::default()));
    }
    let mut kvp = BTreeMap::new();
    let mut keys = BTreeMap::new();
    let mut values = BTreeMap::new();
    for row in questions {
        let id: i32 = row.try_get(0)?;
        if id <= 0 || kvp.insert(id, BTreeMap::new()).is_some() {
            return Ok(None);
        }
        keys.insert(id, row.try_get::<_, Option<String>>(1)?);
    }
    for row in answers {
        let id: i32 = row.try_get(0)?;
        let parent: Option<i32> = row.try_get(1)?;
        let Some(options) = parent.and_then(|id| kvp.get_mut(&id)) else {
            return Ok(None);
        };
        if id <= 0 || values.contains_key(&id) {
            return Ok(None);
        }
        options.insert(id, contract::Selection::Unselected(Vec::new()));
        values.insert(id, row.try_get::<_, Option<String>>(2)?);
    }
    let mut seen = BTreeSet::new();
    for row in choices {
        let parent: Option<i32> = row.try_get(0)?;
        let answer: Option<i32> = row.try_get(1)?;
        let (Some(parent), Some(answer)) = (parent, answer) else {
            return Ok(None);
        };
        let Some(slot) = kvp
            .get_mut(&parent)
            .and_then(|options| options.get_mut(&answer))
        else {
            return Ok(None);
        };
        if !seen.insert((parent, answer)) {
            return Ok(None);
        }
        *slot = contract::Selection::Participant(row.try_get(2)?);
    }
    Ok(Some(contract::Response {
        kvp: Some(kvp),
        keys: Some(keys),
        values: Some(values),
    }))
}
#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn aggregate_preserves_scalar_null_and_inactive_data_and_sheds_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("metadata_read_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
                CREATE TABLE participant_metadata_questions(zid integer,pmqid integer,key text,alive boolean);
                CREATE TABLE participant_metadata_answers(zid integer,pmaid integer,pmqid integer,value text,alive boolean);
                CREATE TABLE participant_metadata_choices(zid integer,pmqid integer,pmaid integer,pid integer,alive boolean);
                INSERT INTO participant_metadata_questions VALUES(2,10,'inactive',false),(3,11,NULL,true),(4,12,'orphan',true),(5,13,'duplicate',true);
                INSERT INTO participant_metadata_answers VALUES(2,20,10,NULL,false),(3,21,11,'unselected',true),(4,22,999,'orphan',true),(5,23,13,'duplicate',true);
                INSERT INTO participant_metadata_choices VALUES(2,10,20,7,false),(5,13,23,7,true),(5,13,23,8,true);
                INSERT INTO participant_metadata_questions SELECT 6,generate_series(1,1001),'oversized',true;")).unwrap();
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
        assert_eq!(
            serde_json::to_string(&pool.with(|c| read(c, 1)).await.unwrap().unwrap()).unwrap(),
            "{}"
        );
        assert_eq!(
            serde_json::to_string(&pool.with(|c| read(c, 2)).await.unwrap().unwrap()).unwrap(),
            r#"{"kvp":{"10":{"20":7}},"keys":{"10":"inactive"},"values":{"20":null}}"#
        );
        assert_eq!(
            serde_json::to_string(&pool.with(|c| read(c, 3)).await.unwrap().unwrap()).unwrap(),
            r#"{"kvp":{"11":{"21":[]}},"keys":{"11":null},"values":{"21":"unselected"}}"#
        );
        for zid in [4, 5, 6] {
            assert!(pool.with(move |c| read(c, zid)).await.unwrap().is_none());
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("BEGIN; LOCK TABLE {lock_schema}.participant_metadata_questions IN ACCESS EXCLUSIVE MODE")).unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let stalled = pool.clone();
        let task = tokio::spawn(async move { stalled.with(|c| read(c, 1)).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(
            pool.with(|c| read(c, 1))
                .await
                .unwrap()
                .unwrap()
                .kvp
                .is_none()
        );
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM participant_metadata_questions")?))
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
