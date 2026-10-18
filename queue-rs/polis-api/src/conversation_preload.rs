//! Public conversation preload fields on a dedicated bounded read-only pool.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/conversation_preload.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.conversation_preload_db.is_none()
        || req.headers.get("authorization").is_some()
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
    if cid.is_empty() || cid.len() > 300 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
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
    let Some(pool) = &app.conversation_preload_db else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(75),
        pool.with(move |c| read(c, &query.conversation_id)),
    )
    .await;
    let Ok(Ok(Some(response))) = result else {
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

/// Node projects these fields without converting its bigint creation timestamp
/// or replacing SQL NULL auth flags. Unknown/ambiguous mappings stay with Node.
pub fn read(c: &mut postgres::Client, cid: &str) -> anyhow::Result<Option<contract::Response>> {
    let rows=c.query("SELECT c.topic,c.description,c.created::text,c.link_url,c.parent_url,c.vis_type,c.write_type,c.importance_enabled,c.help_type,c.bgcolor,c.help_color,c.help_bgcolor,c.style_btn,c.auth_opt_allow_3rdparty FROM conversations c JOIN zinvites z ON c.zid=z.zid WHERE z.zinvite=$1 LIMIT 2",&[&cid])?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let row = &rows[0];
    Ok(Some(contract::Response {
        topic: row.try_get(0)?,
        description: row.try_get(1)?,
        created: row.try_get(2)?,
        link_url: row.try_get(3)?,
        parent_url: row.try_get(4)?,
        vis_type: row.try_get(5)?,
        write_type: row.try_get(6)?,
        importance_enabled: row.try_get(7)?,
        help_type: row.try_get(8)?,
        bgcolor: row.try_get(9)?,
        help_color: row.try_get(10)?,
        help_bgcolor: row.try_get(11)?,
        style_btn: row.try_get(12)?,
        auth_needed_to_vote: false,
        auth_needed_to_write: false,
        auth_opt_allow_3rdparty: row.try_get(13)?,
        conversation_id: cid.into(),
    }))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preload_preserves_nulls_bigints_and_sheds_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("conversation_preload_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(zid integer,topic text,description text,created bigint,link_url text,parent_url text,vis_type integer,write_type integer,importance_enabled boolean,help_type integer,bgcolor text,help_color text,help_bgcolor text,style_btn text,auth_opt_allow_3rdparty boolean); CREATE TABLE {setup_schema}.zinvites(zid integer,zinvite text); INSERT INTO {setup_schema}.conversations VALUES(1,NULL,NULL,9223372036854775807,NULL,NULL,0,1,false,1,NULL,NULL,NULL,NULL,NULL),(2,'雪','public',NULL,'link','parent',2,0,true,0,'blue','red','white','round',false); INSERT INTO {setup_schema}.zinvites VALUES(1,'first'),(2,'second'),(1,'ambiguous'),(2,'ambiguous');")).unwrap();
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
        let first = pool.with(|c| read(c, "first")).await.unwrap().unwrap();
        assert_eq!(first.created.as_deref(), Some("9223372036854775807"));
        assert!(first.topic.is_none() && first.auth_opt_allow_3rdparty.is_none());
        assert!(!first.auth_needed_to_vote && !first.auth_needed_to_write);
        let second = pool.with(|c| read(c, "second")).await.unwrap().unwrap();
        assert_eq!(second.topic.as_deref(), Some("雪"));
        assert_eq!(second.auth_opt_allow_3rdparty, Some(false));
        assert!(second.created.is_none());
        assert_eq!(second.vis_type, 2);
        assert!(second.importance_enabled);
        for cid in ["missing", "ambiguous"] {
            assert!(pool.with(move |c| read(c, cid)).await.unwrap().is_none());
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, "first")).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert_eq!(
            pool.with(|c| read(c, "first"))
                .await
                .unwrap()
                .unwrap()
                .conversation_id,
            "first"
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
