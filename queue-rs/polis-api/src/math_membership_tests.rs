use super::*;
use crate::math_bundle::{self, Cache, Read};
#[tokio::test]
async fn whole_generations_cache_and_locations_are_isolated_and_bounded() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("math_membership_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move||{
  let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
  c.batch_execute(&format!("CREATE SCHEMA {setup_schema};SET search_path={setup_schema};CREATE TABLE math_main(zid integer,math_env text,data jsonb,math_tick bigint);CREATE TABLE math_bidtopid(zid integer,math_env text,data jsonb,math_tick bigint);CREATE TABLE math_ptptstats(zid integer,math_env text,data jsonb,math_tick bigint);CREATE TABLE math_ticks(zid integer,math_env text,math_tick bigint);CREATE TABLE participant_locations(zid integer,pid integer,lat double precision,lng double precision);INSERT INTO math_main VALUES(1,'a','{{\"base-clusters\":{{\"id\":[42,99]}},\"group-clusters\":[{{\"members\":[42]}}]}}',0);INSERT INTO math_bidtopid VALUES(1,'a','{{\"bidToPid\":[[0],[2]]}}',0);INSERT INTO math_ptptstats VALUES(1,'a','{{}}',0);INSERT INTO math_ticks VALUES(1,'a',0);INSERT INTO participant_locations VALUES(1,0,0,1e21),(1,2,10.125,-20.5);")).unwrap();
 }).await.unwrap();
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
    let cache = Cache::new(true);
    let cold = cache.get(&pool, 1, "a").await.unwrap();
    let Read::Complete(b) = cold.as_ref() else {
        panic!("coherent zero generation");
    };
    assert_eq!(b.tick, 0);
    assert_eq!(b.bid(0), Some(42));
    assert_eq!(b.bid(2), Some(99));
    assert_eq!(b.bid(9), None);
    assert_eq!(b.pids(0), Some(vec![0]));
    assert!(b.pids(-1).unwrap().is_empty());
    assert!(matches!(
        cache.get(&pool, 1, "other").await.unwrap().as_ref(),
        Read::Absent
    ));
    let locations = pool.with(|c| locations(c, 1, &[0])).await.unwrap().unwrap();
    assert_eq!(locations.len(), 1);
    assert_eq!(locations[0].lng.get(), 1e21);
    assert!(
        pool.with(|c| super::locations(c, 1, &[0, 2]))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        pool.with(|c| super::locations(c, 1, &[]))
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
    let mutate_url = url.clone();
    let mutate_schema = schema.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&mutate_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "SET search_path={mutate_schema};UPDATE math_main SET math_tick=1;"
        ))
        .unwrap();
    })
    .await
    .unwrap();
    assert_eq!(cache.get(&pool, 1, "a").await.unwrap().tick(), 0);
    assert!(matches!(
        pool.with(|c| math_bundle::read(c, 1, "a"))
            .await
            .unwrap()
            .unwrap(),
        Read::Incoherent(1)
    ));
    // The source uses wall-clock expiry; exercise the actual three-second boundary.
    tokio::time::sleep(std::time::Duration::from_millis(3001)).await;
    assert!(matches!(
        cache.get(&pool, 1, "a").await.unwrap().as_ref(),
        Read::Incoherent(1)
    ));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock_url = url.clone();
    let lock_schema = schema.clone();
    let lock = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN;LOCK TABLE {lock_schema}.math_main IN ACCESS EXCLUSIVE MODE"
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
                math_bundle::read(c, 1, "a")
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
            pool.with(|c| Ok(c.batch_execute("DELETE FROM math_main")?))
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
