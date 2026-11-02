use super::*;
#[test]
fn visibility_projection_order_and_cap_on_postgres() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    // Temporary tables isolate the test and disappear with this connection.
    c.batch_execute("CREATE TEMP TABLE conversations(zid integer,strict_moderation boolean);
        CREATE TEMP TABLE comments(zid integer,tid integer,txt text,created bigint,
            active boolean,velocity real,mod integer,pid integer);
        INSERT INTO conversations VALUES(1,false),(2,true),(3,NULL);
        INSERT INTO comments VALUES
        (1,0,'accepted',20,true,1,1,7),
        (1,1,'unmoderated',10,true,1,0,7),
        (1,2,'own rejected',1,true,1,-1,7),
        (1,3,'own hidden',2,false,1,1,7),
        (1,4,'own muted',3,true,0,1,7),
        (1,5,'null moderation',4,true,1,NULL,7),
        (1,6,'null activity',5,NULL,1,1,7),
        (1,7,'null velocity',6,true,NULL,1,7);
        INSERT INTO comments SELECT 2,tid,txt,created,active,velocity,mod,pid FROM comments WHERE zid=1;
        INSERT INTO comments SELECT 3,tid,txt,created,active,velocity,mod,pid FROM comments WHERE zid=1;").unwrap();
    for (zid, expected) in [(1, vec![1, 0]), (2, vec![0]), (3, vec![1, 0]), (4, vec![])] {
        let rows = read(&mut c, zid).unwrap();
        assert_eq!(rows.iter().map(|r| r.tid).collect::<Vec<_>>(), expected);
        for row in rows {
            let value = serde_json::to_value(row).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 2);
            assert!(value.get("txt").is_some());
            assert!(value.get("tid").is_some());
        }
    }
    c.batch_execute(
        "INSERT INTO comments SELECT 1, n, 'visible', n+100, true, 1, 1, 8
        FROM generate_series(10,1010) n",
    )
    .unwrap();
    let rows = read(&mut c, 1).unwrap();
    assert_eq!(rows.len(), 999);
    assert_eq!(rows[0].tid, 1);
    assert_eq!(rows[998].tid, 1006);
}
