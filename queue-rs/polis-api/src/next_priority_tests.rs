use super::*;
use postgres::NoTls;
use std::sync::{Arc, Barrier};

struct Fixture {
    client: Client,
    url: String,
    schema: String,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!(
            "next_priorities_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        let mut client = Client::connect(&url, NoTls).unwrap();
        client.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
            CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
            INSERT INTO math_main VALUES(1,'test',0,'{{\"comment-priorities\":{{\"0\":2}},\"unneeded\":\"wide payload\"}}');")).unwrap();
        Self {
            client,
            url,
            schema,
        }
    }
    fn connect(&self) -> Client {
        let mut c = Client::connect(&self.url, NoTls).unwrap();
        c.batch_execute(&format!("SET search_path={}", self.schema))
            .unwrap();
        c
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .client
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema));
    }
}
fn expire(cache: &Priorities, _data: &Js) {
    cache.expire(1, "test");
}
#[test]
fn priority_projection_excludes_unrelated_math_fields() {
    let mut f = Fixture::new();
    let data = Priorities::new(4)
        .read(&mut f.client, 1, "test")
        .unwrap()
        .unwrap();
    assert_eq!(js::stringify(&data), r#"{"comment-priorities":{"0":2}}"#);
}
#[test]
fn unchanged_generation_retains_parsed_priorities() {
    let mut f = Fixture::new();
    let cache = Priorities::new(4);
    let data = cache.read(&mut f.client, 1, "test").unwrap().unwrap();
    expire(&cache, &data);
    // Changing bytes without publishing a tick must not replace the committed entry.
    f.client
        .batch_execute("UPDATE math_main SET data='{\"comment-priorities\":{\"0\":9}}'")
        .unwrap();
    assert_eq!(cache.read(&mut f.client, 1, "test").unwrap().unwrap(), data);
}
#[test]
fn overlapping_priority_reads_issue_one_statement() {
    let mut f = Fixture::new();
    f.client.batch_execute("ALTER TABLE math_main RENAME TO stored_math;
        CREATE SEQUENCE reads;
        CREATE FUNCTION counted_tick(t bigint) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('reads'); RETURN t; END $$;
        CREATE VIEW math_main AS SELECT zid,math_env,counted_tick(math_tick) AS math_tick,data FROM stored_math;").unwrap();
    f.client
        .batch_execute("BEGIN; LOCK TABLE stored_math IN ACCESS EXCLUSIVE MODE")
        .unwrap();
    let cache = Arc::new(Priorities::new(4));
    let barrier = Arc::new(Barrier::new(3));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let mut client = f.connect();
            let cache = cache.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                cache.read(&mut client, 1, "test").unwrap()
            })
        })
        .collect();
    barrier.wait();
    cache.wait_for_joiners(1);
    f.client.batch_execute("ROLLBACK").unwrap();
    for t in threads {
        assert!(t.join().unwrap().is_some());
    }
    let count: i64 = f
        .client
        .query_one("SELECT last_value FROM reads", &[])
        .unwrap()
        .get(0);
    assert_eq!(count, 1, "overlapping callers must share one read");
}
