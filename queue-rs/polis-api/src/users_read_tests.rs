use super::*;
#[derive(Default)]
struct Fake {
    record: Option<i32>,
    fail_lookup: bool,
    lookups: usize,
    users: Vec<i32>,
    details: usize,
}
fn user(uid: i32) -> User {
    User {
        uid,
        email: None,
        hname: None,
        has_xid: false,
        x_info: None,
        finished_tutorial: false,
        site_ids: [None],
        created: 0.0,
    }
}
impl Store for Fake {
    fn xid_uid(&mut self, _: &str, _: i32) -> anyhow::Result<Option<i32>> {
        self.lookups += 1;
        anyhow::ensure!(!self.fail_lookup, "lookup unavailable");
        Ok(self.record)
    }
    fn user(&mut self, uid: i32) -> anyhow::Result<User> {
        self.users.push(uid);
        Ok(user(uid))
    }
    fn xid_info(&mut self, _: &str, _: i32) -> anyhow::Result<Option<XInfo>> {
        self.details += 1;
        Ok(None)
    }
}
fn pair() -> Query {
    Query {
        xid: Some("external-user".into()),
        owner: Some(100),
    }
}
#[test]
fn owner_record_self_and_numeric_admin_are_the_only_authorities() {
    for uid in [100, 200, 900] {
        let mut db = Fake {
            record: Some(200),
            ..Default::default()
        };
        assert!(matches!(
            read(&mut db, Some(uid), &[900], &pair()).unwrap(),
            Decision::User(_)
        ));
        assert_eq!(db.users, vec![200]);
        assert_eq!(db.lookups, 1);
        assert_eq!(db.details, 1);
    }
}
#[test]
fn unrelated_user_is_denied_before_any_user_or_profile_read() {
    for record in [Some(200), None] {
        let mut db = Fake {
            record,
            ..Default::default()
        };
        assert!(matches!(
            read(&mut db, Some(300), &[900], &pair()).unwrap(),
            Decision::Denied
        ));
        assert!(db.users.is_empty());
        assert_eq!(db.details, 0);
        assert_eq!(db.lookups, 1);
    }
}
#[test]
fn missing_record_owner_and_admin_fallback_never_repeat_xid_lookup() {
    for uid in [100, 900] {
        let mut db = Fake::default();
        let Decision::User(u) = read(&mut db, Some(uid), &[900], &pair()).unwrap() else {
            panic!("expected user")
        };
        assert_eq!(u.uid, uid);
        assert!(!u.has_xid);
        assert!(u.x_info.is_none());
        assert_eq!(db.users, vec![uid]);
        assert_eq!(db.lookups, 1);
        assert_eq!(db.details, 0);
    }
}
#[test]
fn without_the_pair_only_the_caller_is_read() {
    for q in [
        Query::default(),
        Query {
            xid: None,
            owner: Some(100),
        },
        Query {
            xid: Some("external-user".into()),
            owner: None,
        },
        Query {
            xid: Some("external-user".into()),
            owner: Some(0),
        },
    ] {
        let mut db = Fake::default();
        assert!(matches!(
            read(&mut db, Some(300), &[], &q).unwrap(),
            Decision::User(_)
        ));
        assert_eq!(db.users, vec![300]);
        assert_eq!(db.lookups, 0);
        assert_eq!(db.details, 0);
    }
}
#[test]
fn authentication_precedes_every_lookup() {
    for uid in [None, Some(0)] {
        let mut db = Fake::default();
        assert!(matches!(
            read(&mut db, uid, &[], &pair()).unwrap(),
            Decision::Unauthorized
        ));
        assert_eq!(db.lookups, 0);
        assert!(db.users.is_empty());
    }
}
#[test]
fn lookup_failure_never_reads_user_data() {
    let mut db = Fake {
        fail_lookup: true,
        ..Default::default()
    };
    assert!(read(&mut db, Some(100), &[], &pair()).is_err());
    assert!(db.users.is_empty());
    assert_eq!(db.details, 0);
}
#[test]
fn canonical_query_admission() {
    for q in [
        "",
        "xid=hello",
        "xid=%C3%A9&owner_uid=100",
        "owner_uid=100",
        "xid=hello&owner_uid=100",
        "owner_uid=0",
    ] {
        assert!(parse_query(q).is_some(), "{q}");
    }
    for q in [
        "xid=",
        "xid=a&xid=b",
        "owner_uid=1&owner_uid=2",
        "uid=200",
        "jwt_xid=hello",
        "owner_uid=1.0",
        "owner_uid=01",
        "owner_uid=2147483648",
        "xid[]=a",
        "xid=%E9&owner_uid=100",
        "xid=%ZZ%41&owner_uid=100",
        "xid=é",
        "xid=%00",
        "xid=%EF%BF%BD",
        "xid=%",
        "xid=%A",
    ] {
        assert!(parse_query(q).is_none(), "{q}");
    }
    assert!(parse_query(&format!("xid={}", "a".repeat(1000))).is_none());
}
#[cfg(feature = "db-tests")]
#[tokio::test]
async fn database_authorization_and_pool_isolation() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("users_read_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move||{
        let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema}; CREATE TABLE users(uid integer,email text,hname text,tut smallint,site_id text,created bigint); CREATE TABLE xids(uid integer,owner integer,xid text,x_profile_image_url text,x_name text,x_email text,modified bigint,zid integer,pid integer); INSERT INTO users SELECT uid,'fixture@example.invalid',NULL,0,'site',1234 FROM unnest(ARRAY[100,200,300,900]) uid; INSERT INTO xids VALUES(200,100,'external-user',NULL,'Snow 雪',NULL,1234,1,0); ")).unwrap();
    }).await.unwrap();
    let make_pool = || {
        let mut config: postgres::Config = url.parse().unwrap();
        config.options(&format!("-c search_path={schema}"));
        crate::db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config)),
            pool_limits(),
        )
    };
    let pool = make_pool();
    let independent = make_pool();
    pool.with(|c| {
        for uid in [100, 200, 900] {
            let Decision::User(u) = read(&mut PgStore(c), Some(uid), &[900], &pair())? else {
                panic!("allowed")
            };
            assert_eq!(u.uid, 200);
            assert!(u.has_xid);
            assert_eq!(u.x_info.unwrap().modified, "1234");
        }
        assert!(matches!(
            read(&mut PgStore(c), Some(300), &[], &pair())?,
            Decision::Denied
        ));
        for uid in [100, 900] {
            let q = Query {
                xid: Some("missing".into()),
                owner: Some(100),
            };
            let Decision::User(u) = read(&mut PgStore(c), Some(uid), &[900], &q)? else {
                panic!("fallback")
            };
            assert_eq!(u.uid, uid);
            assert!(u.x_info.is_none());
        }
        Ok(())
    })
    .await
    .unwrap();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lock_url = url.clone();
    let lock_schema = schema.clone();
    let lock = tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "BEGIN; LOCK TABLE {lock_schema}.users IN ACCESS EXCLUSIVE MODE"
        ))
        .unwrap();
        ready_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        c.batch_execute("ROLLBACK").unwrap();
    });
    ready_rx.await.unwrap();
    // Even an unavailable users table cannot turn a refusal into a user read.
    assert!(matches!(
        pool.with(|c| read(&mut PgStore(c), Some(300), &[], &pair()))
            .await
            .unwrap(),
        Decision::Denied
    ));
    let stalled = pool.clone();
    let task = tokio::spawn(async move {
        stalled
            .with(|c| read(&mut PgStore(c), Some(100), &[], &pair()))
            .await
    });
    assert!(independent.ping().await);
    assert!(task.await.unwrap().is_err());
    release_tx.send(()).unwrap();
    lock.await.unwrap();
    let err = pool
        .with(|c| Ok(c.batch_execute("DELETE FROM users")?))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("read-only"));
    tokio::task::spawn_blocking(move || {
        drop(pool);
        drop(independent);
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn separate_replica_retains_node_projection() {
    for replica in [None, Some(""), Some("primary")] {
        assert!(primary_topology("primary", Some("primary"), replica));
    }
    assert!(!primary_topology(
        "primary",
        Some("primary"),
        Some("replica")
    ));
    assert!(!primary_topology(
        "replica",
        Some("primary"),
        Some("replica")
    ));
    assert!(!primary_topology("replica", Some("primary"), None));
    assert!(!primary_topology("primary", None, None));
    assert!(!primary_topology("", Some(""), None));
}
