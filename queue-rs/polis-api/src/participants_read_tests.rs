use super::*;
#[tokio::test]
async fn participant_projection_counts_history_preserves_bigints_and_sheds_locks() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("participants_read_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move||{
        let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema}; CREATE TABLE participants(pid integer,uid integer,zid integer,vote_count integer,last_interaction bigint,subscribed integer,last_notified bigint,nsli smallint,mod integer,created bigint); CREATE TABLE votes(zid integer,pid integer,vote smallint); INSERT INTO participants VALUES(0,1,1,999,9223372036854775807,2,NULL,3,1,1700000000000),(1,2,1,NULL,0,0,NULL,0,0,NULL);")).unwrap();
        let vote=crate::votes::StorageConvention::CURRENT.encode(crate::votes::VoteChoice::Agree) as i16;
        c.execute("INSERT INTO votes(zid,pid,vote) VALUES(1,0,$1),(1,0,$1)",&[&vote]).unwrap();
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
    assert_eq!(pool.with(|c| read(c, 1, 99)).await.unwrap(), Some(None));
    let first = pool
        .with(|c| read(c, 1, 1))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first.pid, Some(0));
    assert_eq!(first.vote_count, Some(2));
    assert_eq!(
        first.last_interaction.as_deref(),
        Some("9223372036854775807")
    );
    assert!(first.last_notified.is_none());
    let second = pool
        .with(|c| read(c, 1, 2))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(second.vote_count.is_none());
    assert!(second.created.is_none());
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock_url = url.clone();
    let lock_schema = schema.clone();
    let locked = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN; LOCK TABLE {lock_schema}.votes IN ACCESS EXCLUSIVE MODE"
        ))
        .unwrap();
        ready_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        c.batch_execute("ROLLBACK").unwrap();
    });
    ready_rx.await.unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let stalled = pool.clone();
    let task = tokio::spawn(async move {
        stalled
            .with(move |c| {
                entered_tx.send(()).unwrap();
                read(c, 1, 1)
            })
            .await
    });
    entered_rx.await.unwrap();
    assert!(participation.ping().await);
    assert!(task.await.unwrap().is_err());
    release_tx.send(()).unwrap();
    locked.await.unwrap();
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
