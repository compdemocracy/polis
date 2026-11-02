#![allow(dead_code)]
use polis_auth::{
    Zid,
    admission::{Entry, Identity, PreparedRecovery, Request},
};
use postgres::{Client, NoTls};
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);

pub struct Fixture {
    pub db: Client,
    pub schema: String,
    pub url: String,
}
impl Fixture {
    pub fn new() -> Self {
        let url = std::env::var("POLIS_AUTH_TEST_DATABASE_URL")
            .expect("db-tests requires a disposable database");
        let mut db = Client::connect(&url, NoTls).unwrap();
        let schema = format!(
            "admission_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        db.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path TO {schema}"
        ))
        .unwrap();
        // The relevant production constraints and defaults. No votes are seeded.
        db.batch_execute("CREATE TABLE users(uid serial primary key, created bigint default 1700000000000, site_id text default md5(random()::text), is_owner boolean default false, site_owner boolean default true);
          CREATE TABLE conversations(zid int primary key,owner int references users(uid),is_active boolean default true,use_xid_whitelist boolean default false,xid_required boolean not null default false,participant_count int default 0);
          CREATE TABLE participants(pid int not null,zid int references conversations(zid),uid int references users(uid),created bigint default 1700000000000,unique(zid,pid),unique(zid,uid));
          CREATE TABLE participants_extended(zid int references conversations(zid),uid int references users(uid),unique(zid,uid));
          CREATE TABLE xids(owner int references users(uid),uid int references users(uid),xid text not null,zid int references conversations(zid),pid int,x_name varchar(746),x_email varchar(256),x_profile_image_url varchar(3000),unique(owner,xid),foreign key(zid,pid) references participants(zid,pid) on delete set null);
          CREATE TABLE xid_whitelist(owner int references users(uid),xid text,zid int,unique(owner,xid));
          CREATE TABLE oidc_user_mappings(oidc_sub varchar(255) primary key,uid int not null unique references users(uid));").unwrap();
        db.batch_execute(include_str!(
            "../../../../server/postgres/migrations/000013_create_treevite.sql"
        ))
        .unwrap();
        // Execute the real production allocator, changing only its schema.
        let migration = include_str!(
            "../../../../server/postgres/migrations/000044_pid_auto_transaction_lock.sql"
        );
        let function = migration
            .split("\nCREATE OR REPLACE FUNCTION")
            .nth(1)
            .unwrap()
            .split("DROP TRIGGER")
            .next()
            .unwrap();
        db.batch_execute(&format!("CREATE OR REPLACE FUNCTION{} CREATE TRIGGER pid_auto BEFORE INSERT ON participants FOR EACH ROW EXECUTE FUNCTION pid_auto();", function.replace("public.pid_auto", "pid_auto"))).unwrap();
        db.batch_execute("INSERT INTO users(uid,is_owner,site_id) VALUES(1,true,'owner'),(2,false,'member'),(3,false,'third'); SELECT setval('users_uid_seq',3); INSERT INTO conversations(zid,owner) VALUES(1,1),(2,1),(3,1); INSERT INTO treevite_waves(zid,wave,invites_per_user,owner_invites) VALUES(1,1,0,1); INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES(1,1,'invite');").unwrap();
        Self { db, schema, url }
    }
    pub fn connect(&self) -> Client {
        let mut db = Client::connect(&self.url, NoTls).unwrap();
        db.batch_execute(&format!(
            "SET search_path TO {}; SET application_name='{}'",
            self.schema, self.schema
        ))
        .unwrap();
        db
    }
    pub fn wait_for_locks(&mut self, count: i64) {
        let start = std::time::Instant::now();
        loop {
            let waiting: i64 = self.db.query_one("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", &[&self.schema]).unwrap().get(0);
            if waiting == count {
                return;
            }
            assert!(
                start.elapsed() < std::time::Duration::from_secs(3),
                "workers did not contend on the database lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    pub fn counts(&mut self) -> Vec<i64> {
        [
            "users",
            "participants",
            "participants_extended",
            "xids",
            "treevite_login_codes",
        ]
        .iter()
        .map(|table| {
            self.db
                .query_one(&format!("SELECT count(*) FROM {table}"), &[])
                .unwrap()
                .get(0)
        })
        .collect()
    }
    pub fn assert_clean(&mut self) {
        assert_eq!(self.counts(), vec![3, 0, 0, 0, 0]);
        assert_eq!(
            self.db
                .query_one(
                    "SELECT participant_count FROM conversations WHERE zid=1",
                    &[]
                )
                .unwrap()
                .get::<_, i32>(0),
            0
        );
        assert_eq!(
            self.db
                .query_one("SELECT status FROM treevite_invites WHERE id=1", &[])
                .unwrap()
                .get::<_, i16>(0),
            0
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .db
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema));
    }
}
pub fn request(identity: Identity<'_>) -> Request<'_> {
    Request {
        zid: Zid(1),
        identity,
        entry: Entry::Participation {
            create_if_missing: true,
        },
        admin_uids: &[],
        x_name: None,
        x_email: None,
        x_profile_image_url: None,
    }
}
pub fn invite() -> Entry<'static> {
    Entry::Invite {
        code: "invite",
        recovery: PreparedRecovery {
            code: "generated-code",
            bcrypt_hash: "prepared-on-crypto-worker",
            lookup: "generated-lookup",
            fingerprint_key: b"generated-key",
        },
    }
}
