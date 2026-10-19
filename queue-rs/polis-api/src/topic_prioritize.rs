//! Public topic-prioritization availability on a dedicated bounded read-only pool.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/topic_prioritize.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.topic_prioritize_db.is_none()
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
    let Some(pool) = &app.topic_prioritize_db else {
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

/// The optimistic Delphi flag means only that a report exists. No Delphi query
/// is performed by Node here. Tied newest timestamps remain Node work.
pub fn read(c: &mut postgres::Client, cid: &str) -> anyhow::Result<Option<contract::Response>> {
    let mappings = c.query("SELECT zid FROM zinvites WHERE zinvite=$1 LIMIT 2", &[&cid])?;
    if mappings.len() != 1 {
        return Ok(None);
    }
    let zid: i32 = mappings[0].try_get(0)?;
    if zid <= 0 {
        return Ok(None);
    }
    let rows = c.query(
        "SELECT report_id,created FROM reports WHERE zid=$1 ORDER BY created DESC LIMIT 2",
        &[&zid],
    )?;
    if rows.is_empty() {
        return Ok(Some(contract::Response::Empty(contract::Empty {
            status: "success".into(),
            conversation_id: cid.into(),
            has_report: false,
            has_delphi_data: false,
            message: "No report available for this conversation".into(),
        })));
    }
    let created: Option<i64> = rows[0].try_get(1)?;
    if rows.len() > 1 && rows[1].try_get::<_, Option<i64>>(1)? == created {
        return Ok(None);
    }
    Ok(Some(contract::Response::Report(contract::Report {
        status: "success".into(),
        conversation_id: cid.into(),
        report_id: rows[0].try_get(0)?,
        has_report: true,
        has_delphi_data: true,
        report_created: created.map(|n| n.to_string()),
    })))
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn newest_report_null_order_bigint_and_locked_read_shedding() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("topic_prioritize_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.zinvites(zid integer,zinvite text); CREATE TABLE {setup_schema}.reports(zid integer,report_id text,created bigint); INSERT INTO {setup_schema}.zinvites VALUES(1,'one'),(2,'empty'),(3,'tie'),(4,'null'),(5,'ambiguous'),(6,'ambiguous'); INSERT INTO {setup_schema}.reports VALUES(1,'older',1),(1,'newest',9223372036854775807),(3,'tieA',10),(3,'tieB',10),(4,'ordinary',20),(4,'nullDate',NULL);")).unwrap();
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
        let contract::Response::Report(report) =
            pool.with(|c| read(c, "one")).await.unwrap().unwrap()
        else {
            panic!("expected report");
        };
        assert_eq!(report.report_id, "newest");
        assert_eq!(
            report.report_created.as_deref(),
            Some("9223372036854775807")
        );
        assert!(report.has_delphi_data);
        let contract::Response::Report(report) =
            pool.with(|c| read(c, "null")).await.unwrap().unwrap()
        else {
            panic!("expected report");
        };
        assert_eq!(report.report_id, "nullDate");
        assert!(report.report_created.is_none());
        let empty = pool.with(|c| read(c, "empty")).await.unwrap().unwrap();
        assert_eq!(
            serde_json::to_string(&empty).unwrap(),
            r#"{"status":"success","conversation_id":"empty","has_report":false,"has_delphi_data":false,"message":"No report available for this conversation"}"#
        );
        for cid in ["tie", "ambiguous", "missing"] {
            assert!(pool.with(move |c| read(c, cid)).await.unwrap().is_none());
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, "empty")).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(matches!(
            pool.with(|c| read(c, "empty")).await.unwrap(),
            Some(contract::Response::Empty(_))
        ));
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM reports")?))
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
