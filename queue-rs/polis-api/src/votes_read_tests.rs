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
        // The columns are named: this table has every column of the migrations'
        // `votes`, so a test database in the shape of an older installation
        // stores them in that installation's order.
        c.execute("INSERT INTO votes(zid,pid,tid,vote,weight_x_32767,created,high_priority) VALUES(1,0,0,$1,23,9223372036854775807,true)",&[&stored]).unwrap();
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

/// Node answers with its `SELECT *` rows, so the keys of its answer are the
/// columns of `votes` in their stored order. A database built from the
/// migrations and an installation whose database predates them store those
/// columns in different orders. The answer follows the stored order in both,
/// and a table with another set of columns is handed back.
#[test]
fn history_keys_follow_the_stored_column_order_as_node_does() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    let stored =
        crate::votes::StorageConvention::CURRENT.encode(crate::votes::VoteChoice::Agree) as i16;
    let wire = crate::votes::WIRE_AGREE;
    let migrations = "zid integer,pid integer,tid integer,vote smallint,weight_x_32767 smallint,created bigint,high_priority boolean";
    let older = "zid integer,pid integer,tid integer,vote smallint,created bigint,weight_x_32767 smallint,high_priority boolean";
    let cases = [
        (
            migrations,
            Some(format!(
                r#"[{{"pid":0,"tid":4,"vote":{wire},"weight_x_32767":23,"created":"9223372036854775807","high_priority":true,"weight":null,"conversation_id":"fixture"}}]"#
            )),
        ),
        (
            older,
            Some(format!(
                r#"[{{"pid":0,"tid":4,"vote":{wire},"created":"9223372036854775807","weight_x_32767":23,"high_priority":true,"weight":null,"conversation_id":"fixture"}}]"#
            )),
        ),
        (
            "high_priority boolean,created bigint,weight_x_32767 smallint,vote smallint,tid integer,pid integer,zid integer",
            Some(format!(
                r#"[{{"high_priority":true,"created":"9223372036854775807","weight_x_32767":23,"vote":{wire},"tid":4,"pid":0,"weight":null,"conversation_id":"fixture"}}]"#
            )),
        ),
        // Another set of columns is a schema this reader does not model.
        (
            "zid integer,pid integer,tid integer,vote smallint,created bigint,weight_x_32767 smallint,high_priority boolean,added integer",
            None,
        ),
        (
            "zid integer,pid integer,tid integer,vote smallint,created bigint,weight_x_32767 smallint",
            None,
        ),
    ];
    for (index, (columns, expected)) in cases.into_iter().enumerate() {
        let schema = format!("vote_read_order_{}_{index}", std::process::id());
        // The table is created under another name and renamed, so that it
        // keeps the order written here in every test database.
        c.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path={schema};
             CREATE TABLE zinvites(zid integer,zinvite text);
             INSERT INTO zinvites VALUES(1,'fixture');
             CREATE TABLE votes_as_written({columns});
             ALTER TABLE votes_as_written RENAME TO votes;"
        ))
        .unwrap();
        let high_priority = if columns.contains("high_priority") {
            ("high_priority,", "true,")
        } else {
            ("", "")
        };
        c.execute(
            &format!(
                "INSERT INTO votes({}zid,pid,tid,vote,weight_x_32767,created) VALUES({}1,0,4,$1,23,9223372036854775807)",
                high_priority.0, high_priority.1
            ),
            &[&stored],
        )
        .unwrap();
        let names: Vec<String> = c.query("SELECT * FROM votes", &[]).unwrap()[0]
            .columns()
            .iter()
            .map(|column| column.name().to_owned())
            .collect();
        assert_eq!(
            names,
            columns
                .split(',')
                .map(|column| column.split(' ').next().unwrap().to_owned())
                .collect::<Vec<_>>(),
            "the table keeps the order written in the test"
        );
        let answer = read(&mut c, 1, 0, None, true, "fixture")
            .unwrap()
            .map(|value| crate::js::stringify(&value));
        assert_eq!(answer, expected, "{columns}");
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    }
}
