//! Metadata selection is a read exposed over POST; no participation pool or writes.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/metadata_query.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.metadata_query_db.is_none()
        || app.metadata_query_auth_db.is_none()
        || req.method != "POST"
        || req.path() != PATH
        || req.query().is_some()
        || req.headers.get("authorization").is_none()
        || req.headers.get("cookie").is_some()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-encoding").is_some()
        || !matches!(
            req.headers.get("content-type"),
            Some("application/json" | "application/json; charset=utf-8")
        )
        || req.body.len() > 16384
        || req.headers.get("content-length") != Some(req.body.len().to_string().as_str())
    {
        return None;
    }
    let query: contract::Request = serde_json::from_slice(&req.body).ok()?;
    if query.conversation_id.is_empty()
        || query.conversation_id.len() > 100
        || !query
            .conversation_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric())
        || query.pmaids.len() > 256
    {
        return None;
    }
    Some(query)
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.metadata_query_db, &app.metadata_query_auth_db)
    else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        let uid = crate::hybrid_read::resolve_scoped(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
            Some(&query.conversation_id),
        )
        .await?
        .uid()?;
        let cid = query.conversation_id.clone();
        let zid = auth_pool
            .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
            .await
            .ok()
            .flatten()?;
        if zid <= 0 {
            return None;
        }
        if query.pmaids.is_empty() {
            return Some(Vec::new());
        }
        pool.with(move |c| read(c, zid, uid.0, &query.pmaids))
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
fn read(
    c: &mut postgres::Client,
    zid: i32,
    uid: i32,
    pmaids: &[i32],
) -> anyhow::Result<Option<contract::Response>> {
    use postgres::fallible_iterator::FallibleIterator;
    // Node invokes its callback even when the owner lookup finds no row. Do
    // not introduce an owner-only restriction. Query failures remain on Node.
    let member = c.query(
        "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
        &[&zid, &uid],
    )?;
    if member
        .first()
        .and_then(|r| r.get::<_, Option<i32>>(0))
        .is_none_or(|p| p < 0)
    {
        c.query(
            "SELECT zid FROM conversations WHERE zid = ($1) AND owner = ($2);",
            &[&zid, &uid],
        )?;
    }
    if pmaids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    // Keep the exact unchecked-answer query and its natural row order. In
    // particular, choices are intentionally not filtered by conversation.
    // Every interpolated value has already been decoded as an i32, never SQL.
    let choices = pmaids
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "select pid from participants where zid = ($1) and pid not in (select pid from participant_metadata_choices where alive = TRUE and pmaid in (select pmaid from participant_metadata_answers where alive = TRUE and zid = ($2) and pmaid not in ({choices})));"
    );
    let params: [&(dyn postgres::types::ToSql + Sync); 2] = [&zid, &zid];
    let mut rows = c.query_raw(&sql, params)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        if result.len() == 1000 {
            return Ok(None);
        }
        result.push(row.try_get::<_, Option<i32>>(0)?);
    }
    Ok(Some(result))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unchecked_answers_keep_legacy_scope_nulls_and_row_bounds() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        tokio::task::spawn_blocking(move|| {
            let mut c=postgres::Client::connect(&url,postgres::NoTls).unwrap();
            let schema=format!("metadata_query_cases_{}",std::process::id());
            c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
                CREATE TABLE participants(zid integer,pid integer,uid integer);
                CREATE TABLE conversations(zid integer,owner integer);
                CREATE TABLE participant_metadata_answers(zid integer,pmaid integer,alive boolean);
                CREATE TABLE participant_metadata_choices(zid integer,pid integer,pmaid integer,alive boolean);
                INSERT INTO participants VALUES(1,2,10),(1,0,11),(1,1,12),(2,0,13);
                INSERT INTO conversations VALUES(1,10);
                INSERT INTO participant_metadata_answers VALUES(1,1,true),(1,2,true),(1,3,false),(2,4,true);
                INSERT INTO participant_metadata_choices VALUES(1,0,1,true),(2,1,2,true),(1,2,3,true),(1,2,2,false);" )).unwrap();
            // The legacy callback does not enforce owner or membership.
            assert_eq!(read(&mut c,1,999,&[1]).unwrap().unwrap(),vec![Some(2),Some(0)]);
            assert_eq!(read(&mut c,1,999,&[2]).unwrap().unwrap(),vec![Some(2),Some(1)]);
            assert_eq!(read(&mut c,1,10,&[1,2,1]).unwrap().unwrap(),vec![Some(2),Some(0),Some(1)]);
            assert_eq!(read(&mut c,1,10,&[0]).unwrap().unwrap(),vec![Some(2)]);
            assert!(read(&mut c,1,10,&[]).unwrap().unwrap().is_empty());
            c.batch_execute("INSERT INTO participant_metadata_choices VALUES(2,NULL,2,true)").unwrap();
            assert!(read(&mut c,1,10,&[1]).unwrap().unwrap().is_empty());
            c.batch_execute("DELETE FROM participant_metadata_choices; INSERT INTO participants SELECT 3,n,9999 FROM generate_series(0,999)n").unwrap();
            assert_eq!(read(&mut c,3,999,&[1]).unwrap().unwrap().len(),1000);
            c.batch_execute("INSERT INTO participants VALUES(3,1000,9999)").unwrap();
            assert!(read(&mut c,3,999,&[1]).unwrap().is_none());
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE")).unwrap();
        }).await.unwrap();
    }
    #[tokio::test]
    async fn metadata_work_sheds_its_own_pool_and_cannot_write() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let make_pool = || {
            let config: postgres::Config = url.parse().unwrap();
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config)),
                pool_limits(),
            )
        };
        let pool = make_pool();
        let participation = make_pool();
        assert!(pool.ping().await);
        assert!(participation.ping().await);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let busy = pool.clone();
        let task = tokio::spawn(async move {
            busy.with(move |c| {
                let _ = tx.send(());
                c.batch_execute("SELECT pg_sleep(5)")?;
                Ok(())
            })
            .await
        });
        rx.await.unwrap();
        assert!(participation.ping().await);
        assert!(pool.with(|_| Ok(())).await.is_err());
        assert!(task.await.unwrap().is_err());
        let err = pool
            .with(|c| {
                c.batch_execute("CREATE TABLE should_not_create(a integer)")?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(pool);
            drop(participation);
        })
        .await
        .unwrap();
    }
}
