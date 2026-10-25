use super::*;
#[tokio::test]
async fn rows_bounds_and_isolated_lock_pressure() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("link_pages_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema}; CREATE TABLE zinvites(zid integer,zinvite text); CREATE UNIQUE INDEX ON zinvites(zinvite); CREATE TABLE conversations(zid integer,topic text,description text,created bigint); INSERT INTO zinvites VALUES(1,'4fixture'),(2,'4empty'),(3,'4large'),(4,'4orphan'); INSERT INTO conversations VALUES(1,'<b>topic</b>','🙂 & text',1700000000000),(2,'',NULL,9223372036854775807),(3,repeat('x',16385),NULL,0);")).unwrap();
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
    for (cid, title, desc) in [
        ("4fixture", "<b>topic</b>", Some("🙂 & text")),
        ("4empty", "9223372036854775807", None),
    ] {
        assert_eq!(
            pool.with(move |c| read(
                c,
                &contract::Request {
                    page: Page::Moderation,
                    conversation_id: cid.into()
                }
            ))
            .await
            .unwrap(),
            Some(Response::moderation(cid, title, desc))
        );
    }
    for cid in ["4fixture", "4empty", "4large", "4orphan"] {
        assert_eq!(
            pool.with(move |c| read(
                c,
                &contract::Request {
                    page: Page::Participation,
                    conversation_id: cid.into()
                }
            ))
            .await
            .unwrap(),
            Some(Response::participation(cid))
        );
    }
    for cid in ["4large", "4orphan", "4absent"] {
        assert!(
            pool.with(move |c| read(
                c,
                &contract::Request {
                    page: Page::Moderation,
                    conversation_id: cid.into()
                }
            ))
            .await
            .unwrap()
            .is_none()
        );
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
    let task = tokio::spawn(async move {
        stalled
            .with(|c| {
                read(
                    c,
                    &contract::Request {
                        page: Page::Moderation,
                        conversation_id: "4fixture".into(),
                    },
                )
            })
            .await
    });
    assert!(participation.ping().await);
    assert!(task.await.unwrap().is_err());
    release_tx.send(()).unwrap();
    locked.await.unwrap();
    assert!(
        pool.with(|c| Ok(c.batch_execute("DELETE FROM conversations")?))
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only")
    );
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
