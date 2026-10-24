use super::*;
#[tokio::test]
async fn social_rows_preserve_visibility_nesting_and_shed_locked_reads() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("ptptois_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema};SET search_path={setup_schema};CREATE TABLE conversations(zid integer,owner integer,is_data_open boolean);CREATE TABLE participants(zid integer,uid integer,pid integer,mod integer);CREATE TABLE xids(owner integer,uid integer,x_profile_image_url text,xid text,x_name text);INSERT INTO conversations VALUES(1,10,false),(2,20,true);INSERT INTO participants VALUES(1,3,0,2),(2,3,0,NULL);INSERT INTO xids VALUES(10,3,'https://example.invalid/a','generated',NULL),(20,3,'','',NULL);")).unwrap();}).await.unwrap();
    let make = || {
        let mut c: postgres::Config = url.parse().unwrap();
        c.options(&format!("-c search_path={schema}"));
        crate::db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(c)),
            pool_limits(),
        )
    };
    let pool = make();
    let participation = make();
    let run = |zid, uid, developer, moderation| {
        let pool = pool.clone();
        async move {
            pool.with(move |c| {
                read(
                    c,
                    zid,
                    uid,
                    developer,
                    &contract::Request {
                        conversation_id: "4fixture".into(),
                        moderation,
                    },
                )
            })
            .await
            .unwrap()
            .unwrap()
        }
    };
    assert!(run(1, None, false, None).await.is_empty());
    let row = run(1, Some(10), false, None).await;
    assert_eq!(
        serde_json::to_string(&row).unwrap(),
        "[{\"mod\":2,\"pid\":0,\"xInfo\":{\"x_profile_image_url\":\"https://example.invalid/a\",\"x_name\":null},\"conversation_id\":\"4fixture\"}]"
    );
    assert_eq!(row, run(1, Some(99), true, None).await);
    assert!(run(1, Some(10), false, Some(0)).await.is_empty());
    assert_eq!(
        serde_json::to_string(&run(2, None, false, None).await).unwrap(),
        "[{\"x_profile_image_url\":\"\",\"xid\":\"\",\"pid\":0,\"conversation_id\":\"4fixture\"}]"
    );
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock_url = url.clone();
    let lock_schema = schema.clone();
    let lock = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN;LOCK TABLE {lock_schema}.xids IN ACCESS EXCLUSIVE MODE"
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
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        stalled
            .with(move |c| {
                entered_tx.send(()).unwrap();
                read(
                    c,
                    1,
                    Some(10),
                    false,
                    &contract::Request {
                        conversation_id: "4fixture".into(),
                        moderation: None,
                    },
                )
            })
            .await
    });
    entered_rx.await.unwrap();
    assert!(participation.ping().await);
    assert!(task.await.unwrap().is_err());
    release_tx.send(()).unwrap();
    lock.await.unwrap();
    assert!(
        format!(
            "{:#}",
            pool.with(|c| Ok(c.batch_execute("DELETE FROM participants")?))
                .await
                .unwrap_err()
        )
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
