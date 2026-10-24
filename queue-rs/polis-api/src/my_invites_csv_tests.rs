use super::*;
#[tokio::test]
async fn csv_ownership_null_dates_escaping_and_independent_pool() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("my_csv_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move||{
  let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
  c.batch_execute(&format!("CREATE SCHEMA {setup_schema};SET search_path={setup_schema};CREATE TABLE zinvites(zid integer,zinvite text);CREATE TABLE participants(zid integer,uid integer,pid integer);CREATE TABLE treevite_invites(id bigint,zid integer,invite_owner_pid integer,invite_code text,status smallint,created_at timestamptz);INSERT INTO zinvites VALUES(1,'4csvfixture');INSERT INTO participants VALUES(1,1,0),(1,2,1);INSERT INTO treevite_invites VALUES(1,1,0,'plain',0,'2020-02-29 23:59:59.999+00'),(3,1,0,'ignored',1,NULL);")).unwrap();
  c.execute("INSERT INTO treevite_invites VALUES(2,1,0,$1,0,NULL)",&[&"comma,quote\"line\nnext"]).unwrap();
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
    let response = pool.with(|c| read(c, 1, 1, true)).await.unwrap().unwrap();
    assert_eq!(
        response.csv,
        "invite_code,status,created_at\nplain,unused,Sat Feb 29 2020\n\"comma,quote\"\"line\nnext\",unused,"
    );
    assert!(pool.with(|c| read(c, 1, 1, false)).await.unwrap().is_none());
    assert_eq!(
        pool.with(|c| read(c, 1, 2, false))
            .await
            .unwrap()
            .unwrap()
            .csv,
        "invite_code,status,created_at"
    );
    assert_eq!(
        pool.with(|c| read(c, 1, 99, false))
            .await
            .unwrap()
            .unwrap()
            .csv,
        "invite_code,status,created_at\n"
    );
    assert_eq!(
        timestamp(1700000000123).as_deref(),
        Some("2023-11-14T22-13-20-123Z")
    );
    assert_eq!(date_string(0).as_deref(), Some("Thu Jan 01 1970"));
    assert!(date_string(-1).is_none());
    assert_eq!(contract::escape("carriage\rreturn"), "carriage\rreturn");
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock_url = url.clone();
    let lock_schema = schema.clone();
    let lock = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN;LOCK TABLE {lock_schema}.treevite_invites IN ACCESS EXCLUSIVE MODE"
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
                read(c, 1, 1, true)
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
            pool.with(|c| Ok(c.batch_execute("DELETE FROM treevite_invites")?))
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
