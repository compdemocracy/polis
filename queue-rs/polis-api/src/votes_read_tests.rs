use super::*;
#[tokio::test]
async fn database_rows_convention_null_history_bounds_and_isolated_pressure() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("vote_reads_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move|| {
        let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE SCHEMA {setup_schema};SET search_path={setup_schema};CREATE TABLE zinvites(zid integer,zinvite text);CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote smallint,weight_x_32767 smallint,modified bigint);CREATE TABLE votes(zid integer,pid integer,tid integer,vote smallint,weight_x_32767 smallint,created bigint,high_priority boolean);INSERT INTO zinvites VALUES(1,'fixture');")).unwrap();
        let stored=crate::votes::StorageConvention::CURRENT.encode(crate::votes::VoteChoice::Agree) as i16;
        c.execute("INSERT INTO votes_latest_unique VALUES(1,0,0,$1,23,9223372036854775807)",&[&stored]).unwrap();
        c.execute("INSERT INTO votes VALUES(1,0,0,$1,23,9223372036854775807,true)",&[&stored]).unwrap();
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
    let row = pool
        .with(|c| read(c, 1, 0, None, false, "fixture"))
        .await
        .unwrap()
        .unwrap();
    let contract::Response::Latest(rows) = contract::Response::decode(
        false,
        false,
        200,
        "application/json",
        crate::js::stringify(&row).as_bytes(),
    )
    .unwrap() else {
        panic!("latest response")
    };
    assert_eq!(rows[0].vote.0, Some(i16::from(crate::votes::WIRE_AGREE)));
    assert_eq!(rows[0].modified.as_deref(), Some("9223372036854775807"));
    let row = pool
        .with(|c| read(c, 1, 0, None, true, "fixture"))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        contract::Response::decode(
            true,
            false,
            200,
            "application/json",
            crate::js::stringify(&row).as_bytes()
        )
        .unwrap(),
        contract::Response::History(_)
    ));
    assert_eq!(
        pool.with(|c| read(c, 1, 0, Some(1), false, "fixture"))
            .await
            .unwrap(),
        Some(Js::Arr(vec![]))
    );
    assert!(
        pool.with(|c| read(c, 1, 0, None, false, "alias"))
            .await
            .unwrap()
            .is_none()
    );
    let write_url = url.clone();
    let write_schema = schema.clone();
    tokio::task::spawn_blocking(move|| {let mut c=postgres::Client::connect(&write_url,postgres::NoTls).unwrap();c.batch_execute(&format!("SET search_path={write_schema};UPDATE votes_latest_unique SET vote=NULL,weight_x_32767=NULL,modified=NULL;")).unwrap();}).await.unwrap();
    let row = pool
        .with(|c| read(c, 1, 0, None, false, "fixture"))
        .await
        .unwrap()
        .unwrap();
    let contract::Response::Latest(rows) = contract::Response::decode(
        false,
        false,
        200,
        "application/json",
        crate::js::stringify(&row).as_bytes(),
    )
    .unwrap() else {
        panic!("latest response")
    };
    assert_eq!(rows[0].vote.0, None);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock_url = url.clone();
    let lock_schema = schema.clone();
    let locked = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN;LOCK TABLE {lock_schema}.votes_latest_unique IN ACCESS EXCLUSIVE MODE"
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
            .with(|c| read(c, 1, 0, None, false, "fixture"))
            .await
    });
    assert!(participation.ping().await);
    assert!(task.await.unwrap().is_err());
    release_tx.send(()).unwrap();
    locked.await.unwrap();
    let error = pool
        .with(|c| Ok(c.batch_execute("DELETE FROM votes")?))
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("read-only"));
    let write_url = url.clone();
    let write_schema = schema.clone();
    tokio::task::spawn_blocking(move|| {let mut c=postgres::Client::connect(&write_url,postgres::NoTls).unwrap();c.batch_execute(&format!("SET search_path={write_schema};INSERT INTO votes_latest_unique(zid,pid,tid) VALUES(1,0,1);INSERT INTO votes(zid,pid,tid) VALUES(1,0,1);")).unwrap();}).await.unwrap();
    assert!(
        pool.with(|c| read(c, 1, 0, None, false, "fixture"))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        pool.with(|c| read(c, 1, 0, None, true, "fixture"))
            .await
            .unwrap()
            .is_none()
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
