#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use polis_auth::*;

#[test]
fn node_site_equality_owner_and_administrator_matrix() {
    let url = std::env::var("POLIS_AUTH_TEST_DATABASE_URL")
        .expect("db-tests requires POLIS_AUTH_TEST_DATABASE_URL");
    let mut db = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    // Temporary tables shadow any permanent ones on this test connection only.
    // No production schema is read or altered; disconnect removes the fixture.
    db.batch_execute("create temp table users(uid int primary key, site_id text); create temp table conversations(zid int primary key, owner int); insert into users values (1,'a'),(2,'a'),(3,'b'),(4,NULL),(5,NULL),(6,''),(7,''),(8,'A'); insert into conversations values (10,1),(20,3),(30,4),(40,6),(50,99);").unwrap();
    let mut comparisons = 0;
    for zid in [10, 20, 30, 40, 50, 999] {
        for uid in [1, 2, 3, 4, 5, 6, 7, 8, 99, 100] {
            for admin in [false, true] {
                let admins = if admin { vec![Uid(uid)] } else { vec![] };
                let principal = Principal::User {
                    uid: Uid(uid),
                    oidc_sub: None,
                };
                // Independently spell the reference's JS admin bypass and SQL
                // isModerator predicate; this is not the crate's SQL constant.
                let reference=admin || db.query_one("select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = $2)) and zid = $1",&[&zid,&uid]).unwrap().get::<_,i64>(0)>=1;
                let auth = Authority::for_conversation(
                    &mut PostgresLookup(&mut db),
                    Zid(zid),
                    &principal,
                    Level::Moderator,
                    &admins,
                )
                .unwrap();
                assert_eq!(
                    require(auth, Level::Moderator, "refused").is_ok(),
                    reference,
                    "moderator {zid}/{uid}/{admin}"
                );
                let owner = db
                    .query(
                        "select * from conversations where zid=$1 and owner=$2",
                        &[&zid, &uid],
                    )
                    .unwrap();
                let auth = Authority::for_conversation(
                    &mut PostgresLookup(&mut db),
                    Zid(zid),
                    &principal,
                    Level::Owner,
                    &admins,
                )
                .unwrap();
                assert_eq!(
                    require(auth, Level::Owner, "refused").is_ok(),
                    !owner.is_empty(),
                    "owner {zid}/{uid}/{admin}"
                );
                comparisons += 2;
            }
        }
    }
    assert_eq!(comparisons, 240);
    // Pin the surprising edges directly, independently of the reference SQL.
    for (zid, uid, expected) in [
        (10, 1, true),
        (10, 2, true),
        (10, 3, false),
        (10, 8, false),
        (30, 4, false),
        (30, 5, false),
        (40, 6, true),
        (40, 7, true),
        (50, 99, false),
    ] {
        assert_eq!(
            PostgresLookup(&mut db)
                .permits(Zid(zid), Uid(uid), Level::Moderator)
                .unwrap(),
            expected
        );
    }
    db.batch_execute("drop table conversations; set search_path = pg_temp")
        .unwrap();
    assert_eq!(
        PostgresLookup(&mut db).permits(Zid(10), Uid(1), Level::Moderator),
        Err(Unavailable)
    );
}
