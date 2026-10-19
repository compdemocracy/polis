//! Authenticated moderator XID report reads on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/xid_report.rs"]
mod contract;
pub fn matches(path: &str) -> bool {
    path.strip_prefix(contract::PREFIX)
        .is_some_and(|s| !s.is_empty() && !s.contains('/'))
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.xid_report_db.is_none()
        || app.xid_report_auth_db.is_none()
        || !matches(req.path())
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some()
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("authorization").is_none()
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let uuid = req
        .path()
        .strip_prefix(contract::PREFIX)?
        .strip_suffix("-xid.csv")?;
    // Narrow canonical UUID paths avoid Express decoding and parameter coercions.
    if uuid.len() != 36
        || !uuid.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    Some(contract::Request { uuid: uuid.into() })
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
enum Decision {
    Denied,
    Rows(contract::Response),
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(auth_pool)) = (&app.xid_report_db, &app.xid_report_auth_db) else {
        return route::bad_gateway();
    };
    let admins = app.legacy_admin_uids.clone();
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        // Required hybrid auth precedes the UUID lookup, just as in Node.
        // Resolve only existing identities; unsupported token kinds go to Node.
        let uid = crate::hybrid_read::resolve(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
        )
        .await?
        .uid()?;
        // The primary identity connection is released before replica work.
        pool.with(move |c| read_authorized(c, &query.uuid, uid, &admins))
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
            crate::js::Js::Str("polis_err_xid_report_auth".into()),
        ),
        Ok(Some(Decision::Rows(response))) => route::csv(req, res, &response.csv()),
        _ => route::bad_gateway(),
    }
}
fn resolve_uuid(c: &mut postgres::Client, uuid: &str) -> anyhow::Result<Option<i32>> {
    let mappings = c.query(
        "SELECT zid FROM zinvites WHERE uuid=$1::text::uuid LIMIT 2",
        &[&uuid],
    )?;
    if mappings.len() != 1 {
        return Ok(None);
    }
    Ok(Some(mappings[0].try_get(0)?))
}
fn read_authorized(
    c: &mut postgres::Client,
    uuid: &str,
    uid: polis_auth::Uid,
    admins: &[i32],
) -> anyhow::Result<Option<Decision>> {
    let Some(zid) = resolve_uuid(c, uuid)? else {
        return Ok(None);
    };
    // Missing UUIDs remain Node's 404 before any moderator refusal. No CSV
    // query runs until the exact site-moderator/numeric-admin rule succeeds.
    if !crate::treevite_read::permits(c, zid, uid, admins)? {
        return Ok(Some(Decision::Denied));
    }
    Ok(read_rows(c, zid)?.map(Decision::Rows))
}
#[cfg(all(test, feature = "db-tests"))]
fn read(c: &mut postgres::Client, uuid: &str) -> anyhow::Result<Option<contract::Response>> {
    let Some(zid) = resolve_uuid(c, uuid)? else {
        return Ok(None);
    };
    read_rows(c, zid)
}
/// Match Node's replica UUID lookup and owner-based participant join. Duplicate
/// participant IDs have unspecified stable-sort order and remain Node work.
fn read_rows(c: &mut postgres::Client, zid: i32) -> anyhow::Result<Option<contract::Response>> {
    let rows=c.query("SELECT p.pid,CASE WHEN octet_length(x.xid)<=4096 THEN x.xid ELSE NULL END FROM xids x INNER JOIN participants p ON x.uid=p.uid WHERE p.zid=$1 AND x.owner IN (SELECT owner FROM conversations WHERE zid=$1) ORDER BY p.pid LIMIT 257",&[&zid])?;
    if rows.len() > 256 {
        return Ok(None);
    }
    let mut result = Vec::new();
    let mut last = None;
    let mut bytes = 0;
    for row in rows {
        let pid: Option<i32> = row.try_get(0)?;
        let xid: Option<String> = row.try_get(1)?;
        let (Some(pid), Some(xid)) = (pid, xid) else {
            return Ok(None);
        };
        if last == Some(pid) || xid.len() > 4096 {
            return Ok(None);
        }
        bytes += xid.len();
        if bytes > 32768 {
            return Ok(None);
        }
        last = Some(pid);
        result.push(contract::Row {
            participant: pid,
            xid,
        });
    }
    Ok(Some(contract::Response { rows: result }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_quoting_empty_and_unicode_match_node() {
        let empty = contract::Response { rows: vec![] };
        assert_eq!(empty.csv(), "participant,xid\n");
        let value = contract::Response {
            rows: vec![contract::Row {
                participant: 0,
                xid: "comma,quote\"\r\n雪".into(),
            }],
        };
        assert_eq!(
            value.csv(),
            "participant,xid\n0,\"comma,quote\"\"\r\n雪\"\n"
        );
    }
}
#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    #[tokio::test]
    async fn moderator_gate_join_bounds_and_locked_read_shedding() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("xid_report_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
   let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
   c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema}; CREATE TABLE zinvites(uuid uuid,zid integer); CREATE TABLE conversations(zid integer,owner integer); CREATE TABLE users(uid integer,site_id text); INSERT INTO users VALUES(10,'site'),(11,'site'),(12,'other'),(20,NULL); CREATE TABLE participants(zid integer,uid integer,pid integer); CREATE TABLE xids(owner integer,uid integer,xid text); INSERT INTO zinvites VALUES('00000000-0000-4000-8000-000000000001',1),('00000000-0000-4000-8000-000000000002',2),('00000000-0000-4000-8000-000000000003',1),('00000000-0000-4000-8000-000000000003',2),('00000000-0000-4000-8000-000000000004',3),('00000000-0000-4000-8000-000000000005',4),('00000000-0000-4000-8000-000000000006',5); INSERT INTO conversations VALUES(1,10),(2,20),(3,30),(4,40),(5,50); INSERT INTO participants VALUES(1,101,2),(1,102,0),(1,103,1),(2,101,0),(3,301,0),(5,501,NULL); INSERT INTO xids VALUES(10,101,'second'),(10,102,'first'),(99,103,'wrong owner'),(30,301,'a'),(30,301,'b'),(50,501,'null pid'); INSERT INTO participants SELECT 4,1000+n,n FROM generate_series(0,256) n; INSERT INTO xids SELECT 40,1000+n,'00000000-0000-4000-8000-000000000005' FROM generate_series(0,256) n;")).unwrap();
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
        pool.with(|c| {
            let uuid = "00000000-0000-4000-8000-000000000001";
            for (uid, admins, allowed) in [
                (10, vec![], true),
                (11, vec![], true),
                (12, vec![], false),
                (12, vec![12], true),
            ] {
                let result = read_authorized(c, uuid, polis_auth::Uid(uid), &admins)?;
                assert_eq!(matches!(result, Some(Decision::Rows(_))), allowed);
                assert_eq!(matches!(result, Some(Decision::Denied)), !allowed);
            }
            assert!(matches!(
                read_authorized(
                    c,
                    "00000000-0000-4000-8000-000000000002",
                    polis_auth::Uid(20),
                    &[]
                )?,
                Some(Decision::Denied)
            ));
            assert!(
                read_authorized(
                    c,
                    "00000000-0000-4000-8000-000000000007",
                    polis_auth::Uid(12),
                    &[]
                )?
                .is_none()
            );
            // Oversized result sets cannot mask an earlier moderator refusal.
            assert!(matches!(
                read_authorized(
                    c,
                    "00000000-0000-4000-8000-000000000005",
                    polis_auth::Uid(12),
                    &[]
                )?,
                Some(Decision::Denied)
            ));
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            pool.with(|c| read(c, "00000000-0000-4000-8000-000000000001"))
                .await
                .unwrap()
                .unwrap()
                .csv(),
            "participant,xid\n0,\"first\"\n2,\"second\"\n"
        );
        assert_eq!(
            pool.with(|c| read(c, "00000000-0000-4000-8000-000000000002"))
                .await
                .unwrap()
                .unwrap()
                .csv(),
            "participant,xid\n"
        );
        for uuid in [
            "00000000-0000-4000-8000-000000000007",
            "00000000-0000-4000-8000-000000000003",
            "00000000-0000-4000-8000-000000000004",
            "00000000-0000-4000-8000-000000000005",
            "00000000-0000-4000-8000-000000000006",
        ] {
            assert!(pool.with(move |c| read(c, uuid)).await.unwrap().is_none());
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.xids IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move {
            stalled
                .with(|c| read(c, "00000000-0000-4000-8000-000000000001"))
                .await
        });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert!(
            pool.with(|c| read(c, "00000000-0000-4000-8000-000000000001"))
                .await
                .unwrap()
                .is_some()
        );
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM xids")?))
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
