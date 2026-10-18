//! Existing email-invite capability reads on an isolated primary read-only pool.
use crate::{
    http::{Outgoing, Request},
    js::{Js, Obj},
    route::{self, App, Res},
};
// Both workspaces compile the same shared contract module.
#[path = "../../polis-contracts/src/einvites_read.rs"]
mod contract;
pub use contract::PATH;
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.einvites_read_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
        || req.headers.get("authorization").is_some()
    {
        return None;
    }
    let raw = req.query()?;
    if raw.len() > 1024 {
        return None;
    }
    let mut code = None;
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if k != "einvite"
            || code.is_some()
            || v.is_empty()
            || v.len() > 100
            || !v
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        code = Some(v.into_owned());
    }
    Some(contract::Request { einvite: code? })
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
    let Some(pool) = &app.einvites_read_db else {
        return route::bad_gateway();
    };
    let Ok(Ok(Some(value))) = tokio::time::timeout(
        std::time::Duration::from_millis(75),
        pool.with(move |c| read(c, &query.einvite)),
    )
    .await
    else {
        return route::bad_gateway();
    };
    route::json(req, res, &json(&value))
}
fn json(value: &contract::Response) -> Js {
    let mut o = Obj::new();
    o.set("einvite", Js::Str(value.einvite.clone()));
    o.set(
        "email",
        value
            .email
            .as_ref()
            .map_or(Js::Null, |s| Js::Str(s.clone())),
    );
    // node-postgres leaves BIGINT as a decimal string, including unsafe JS integers.
    o.set(
        "created",
        value
            .created
            .as_ref()
            .map_or(Js::Null, |s| Js::Str(s.clone())),
    );
    Js::Obj(o)
}
pub fn read(c: &mut postgres::Client, code: &str) -> anyhow::Result<Option<contract::Response>> {
    let rows=c.query("SELECT einvite,CASE WHEN octet_length(email)<=4096 THEN email ELSE NULL END,created::text,(email IS NULL OR octet_length(email)<=4096) FROM einvites WHERE einvite=$1 LIMIT 2",&[&code])?;
    if rows.len() != 1 || !rows[0].try_get::<_, bool>(3)? {
        return Ok(None);
    }
    Ok(Some(contract::Response {
        einvite: rows[0].try_get(0)?,
        email: rows[0].try_get(1)?,
        created: rows[0].try_get(2)?,
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_column_order_nulls_unicode_and_bigint_strings() {
        let v = contract::Response {
            einvite: "fixture".into(),
            email: Some("quote\"\r\n雪@example.invalid".into()),
            created: Some("9223372036854775807".into()),
        };
        assert_eq!(
            crate::js::stringify(&json(&v)),
            serde_json::to_string(&v).unwrap()
        );
        let v = contract::Response {
            einvite: "null".into(),
            email: None,
            created: None,
        };
        assert_eq!(
            crate::js::stringify(&json(&v)),
            r#"{"einvite":"null","email":null,"created":null}"#
        );
    }
}

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    #[tokio::test]
    async fn exact_capability_nulls_and_bounded_primary_pool() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("einvites_read_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema}; CREATE TABLE einvites(einvite text,email text,created bigint); INSERT INTO einvites VALUES('populated','fixture@example.invalid',9223372036854775807),('null',NULL,NULL),('duplicate','a',1),('duplicate','b',2),('oversized',repeat('x',4097),1);")).unwrap();}).await.unwrap();
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
        let v = pool.with(|c| read(c, "populated")).await.unwrap().unwrap();
        assert_eq!(v.created.as_deref(), Some("9223372036854775807"));
        assert_eq!(v.email.as_deref(), Some("fixture@example.invalid"));
        let v = pool.with(|c| read(c, "null")).await.unwrap().unwrap();
        assert!(v.email.is_none() && v.created.is_none());
        for code in ["missing", "Populated", "duplicate", "oversized"] {
            assert!(pool.with(move |c| read(c, code)).await.unwrap().is_none());
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.einvites IN ACCESS EXCLUSIVE MODE"
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
        let task = tokio::spawn(async move { stalled.with(|c| read(c, "populated")).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert!(pool.with(|c| read(c, "populated")).await.unwrap().is_some());
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM einvites")?))
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
