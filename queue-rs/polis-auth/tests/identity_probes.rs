//! Execute the exact aggregate queries on the released schema, with triggers.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used)]

use postgres::{Client, NoTls};
use std::sync::atomic::{AtomicUsize, Ordering};

fn database(run: impl FnOnce(&mut Client)) {
    // Queue migrations create cluster-wide roles. Serialize these isolated
    // databases so first-use role creation cannot race between test threads.
    static MIGRATIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let migration_lock = MIGRATIONS.lock().unwrap();
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let url = std::env::var("POLIS_AUTH_TEST_DATABASE_URL").unwrap();
    let mut config: postgres::Config = url.parse().unwrap();
    let name = format!(
        "identity_probes_{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    struct Cleanup {
        admin: Client,
        name: String,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.admin
                .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
                .unwrap();
        }
    }
    let mut cleanup = Cleanup {
        admin: config.connect(NoTls).unwrap(),
        name,
    };
    cleanup
        .admin
        .batch_execute(&format!("CREATE DATABASE {}", cleanup.name))
        .unwrap();
    config.dbname(&cleanup.name);
    let mut db = config.connect(NoTls).unwrap();
    let migrations =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/postgres/migrations");
    let release = std::fs::read_to_string(migrations.join("release.txt")).unwrap();
    for name in release
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
    {
        let sql = std::fs::read_to_string(migrations.join(name)).unwrap();
        if sql.contains("-- polis-migrate: concurrent-indexes") {
            // Like the release runner, send each concurrent build in autocommit.
            for statement in sql.lines().filter(|line| line.starts_with("CREATE INDEX ")) {
                db.batch_execute(statement)
                    .unwrap_or_else(|e| panic!("migration {name}: {e:?}"));
            }
        } else {
            db.batch_execute(&sql)
                .unwrap_or_else(|e| panic!("migration {name}: {e:?}"));
        }
    }
    drop(migration_lock);
    run(&mut db);
}

const RECENT: &str = include_str!("../probes/recent-unattached-users.sql");
const MISSING_XID: &str = include_str!("../probes/participants-missing-owner-xids.sql");
const MISSING_PID: &str = include_str!("../probes/xids-missing-participant-id.sql");

fn count(db: &mut impl postgres::GenericClient, sql: &str) -> i64 {
    let rows = db.query(sql, &[]).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].len(), 1);
    rows[0].get(0)
}

fn owners(db: &mut impl postgres::GenericClient) {
    db.batch_execute(
        "INSERT INTO users(uid,created) VALUES (100,0),(200,0),(300,0);
        INSERT INTO conversations(zid,owner,xid_required,use_xid_whitelist)
        VALUES (10,100,true,false),(20,200,false,true),(30,100,false,false);",
    )
    .unwrap();
}

#[test]
fn empty_tables_return_one_zero_count_per_probe() {
    database(|db| {
        let mut tx = db.build_transaction().read_only(true).start().unwrap();
        for sql in [RECENT, MISSING_XID, MISSING_PID] {
            assert_eq!(count(&mut tx, sql), 0);
        }
    });
}

#[test]
fn recent_users_excludes_members_mappings_old_null_and_future_timestamps() {
    database(|db| {
        let mut tx = db.transaction().unwrap();
        owners(&mut tx);
        let now: i64 = tx
            .query_one(
                "SELECT (extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint",
                &[],
            )
            .unwrap()
            .get(0);
        for (uid, created) in [
            (1, Some(now)),
            (2, Some(now - 86400000)),
            (3, Some(now - 86400001)),
            (4, Some(now + 1)),
            (5, None),
            (6, Some(now)),
            (7, Some(now)),
            (8, Some(now)),
        ] {
            tx.execute(
                "INSERT INTO users(uid,created) VALUES ($1,$2)",
                &[&uid, &created],
            )
            .unwrap();
        }
        tx.batch_execute(
            "INSERT INTO participants(zid,uid) VALUES (10,6),(20,6),(10,8);
            INSERT INTO oidc_user_mappings(uid,oidc_sub) VALUES (7,'seven'),(8,'eight');",
        )
        .unwrap();
        assert_eq!(count(&mut tx, RECENT), 2);
    });
}

#[test]
fn missing_xid_probe_catches_failed_upsert_and_excludes_owner_bound_accounts() {
    database(|db| {
        owners(db);
        db.batch_execute("INSERT INTO users(uid) VALUES (1),(2),(3),(4),(5);
            INSERT INTO participants(zid,uid) VALUES (10,1),(20,2),(10,3),(30,4),(10,100),(20,100),(10,5);
            INSERT INTO xids(owner,uid,xid,zid,pid) VALUES
              (100,3,'healthy',10,2),(100,3,'healthy-alias',10,2),
              (200,100,'owner-bound',20,1),(300,5,'other-owner',NULL,NULL);").unwrap();
        let mut tx = db.build_transaction().read_only(true).start().unwrap();
        // Both requirement flags count a committed member with no XID row.
        // An other-owner-only binding still lacks the required owner binding.
        // The owner participating in its own conversation and the same account
        // bound under owner 200 are excluded, as is the unrestricted member.
        assert_eq!(count(&mut tx, MISSING_XID), 3);
        assert_eq!(
            count(
                &mut tx,
                "SELECT count(*) FROM participants WHERE uid IN (1,2) AND NOT EXISTS (SELECT 1 FROM xids WHERE xids.uid=participants.uid)"
            ),
            2
        );
        // The former query missed both failed-upsert cases and counted the
        // owner in its own conversation instead.
        assert_eq!(
            count(
                &mut tx,
                "SELECT count(*) FROM participants p JOIN conversations c USING(zid) WHERE p.uid=100 AND EXISTS (SELECT 1 FROM xids x WHERE x.uid=p.uid AND x.owner<>c.owner) AND NOT EXISTS (SELECT 1 FROM xids x WHERE x.uid=p.uid AND x.owner=c.owner)"
            ),
            1
        );
        tx.rollback().unwrap();
        db.batch_execute("INSERT INTO xids(owner,uid,xid) VALUES (100,1,'repaired'),(200,2,'repaired'),(100,5,'repaired-other');").unwrap();
        assert_eq!(count(db, MISSING_XID), 0);
    });
}

#[test]
fn missing_pid_probe_requires_exact_membership_and_includes_participant_zero() {
    database(|db| {
        owners(db);
        db.batch_execute(
            "INSERT INTO users(uid) VALUES (1),(2),(3),(4);
            INSERT INTO participants(zid,uid) VALUES (10,1),(10,2),(20,3);
            INSERT INTO xids(owner,uid,xid,zid,pid) VALUES
              (100,1,'a',10,NULL),(200,1,'b',10,NULL),(100,2,'c',10,1),
              (100,3,'d',10,NULL),(100,4,'e',10,NULL),(300,1,'f',NULL,NULL),(200,3,'g',20,0);",
        )
        .unwrap();
        let mut tx = db.build_transaction().read_only(true).start().unwrap();
        assert_eq!(count(&mut tx, MISSING_PID), 2);
        assert_eq!(count(&mut tx, "SELECT count(*) FROM xids"), 7);
    });
}
