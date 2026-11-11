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
    // This checks shared reads, not request latency. Give this cache instance a
    // watchdog independent of the production caller and pool deadlines.
    let timeout = std::time::Duration::from_secs(30);
    let cache = Arc::new(Priorities::with_test_flight_timeout(4, timeout));
    let barrier = Arc::new(Barrier::new(3));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let mut client = f.connect();
            let cache = cache.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                cache
                    .read_until(&mut client, 1, "test", std::time::Instant::now() + timeout)
                    .unwrap()
            })
        })
        .collect();
    barrier.wait();
    // The counter excludes the leader: two callers have one joining reader.
    cache.wait_for_joiners(1);
    f.client.batch_execute("ROLLBACK").unwrap();
    for t in threads {
        let data = t.join().unwrap().unwrap();
        assert_eq!(js::stringify(&data), r#"{"comment-priorities":{"0":2}}"#);
    }
    let count: i64 = f
        .client
        .query_one("SELECT last_value FROM reads", &[])
        .unwrap()
        .get(0);
    assert_eq!(count, 1, "overlapping callers must share one read");
}

/// `math_main.data` is jsonb in a database built from the migrations and json
/// in an installation whose database predates them. The priorities read gives
/// the same answer and the same refusal on both, and refuses a column of any
/// other type. A json column keeps a document's text as written (spacing,
/// repeated keys, number spelling); jsonb normalises it.
#[test]
fn json_and_jsonb_math_columns_give_the_same_priorities() {
    let mut f = Fixture::new();
    let documents = [
        r#"{"comment-priorities":{"0":2,"1":0.5,"9":4},"unneeded":"wide payload"}"#,
        "{ \"n\" : 5,\n\t\"comment-priorities\" : { \"9\" : 4e0 , \"1\":5E-1,\"0\":2.0, \"2\":0, \"3\":null, \"5\":false } ,\r\n \"tids\":[1,2] }",
        r#"{"comment-priorities":{"0":1},"comment-priorities":{"0":2,"0":3,"1":7}}"#,
        r#"{"comment-priorities":{"1":6,"10":1.50}}"#,
        r#"{"comment-priorities":{}}"#,
        r#"{"comment-priorities":null}"#,
        r#"{"comment-priorities":[1,2]}"#,
        r#"{"n":1}"#,
        "{}",
        "[1]",
        "3",
        "\"x\"",
        "null",
    ];
    let mut reads: Vec<Vec<Result<Option<String>, String>>> = vec![];
    for data_type in ["jsonb", "json"] {
        // The type is set here, whatever shape the test database gives a
        // newly created table.
        f.client
            .batch_execute(&format!(
                "DELETE FROM math_main;
                 ALTER TABLE math_main ALTER COLUMN data TYPE {data_type} USING data::text::{data_type}"
            ))
            .unwrap();
        for (zid, document) in documents.iter().enumerate() {
            f.client
                .execute(
                    &format!("INSERT INTO math_main VALUES($1,'test',$2,$3::text::{data_type})"),
                    &[&(zid as i32), &(zid as i64 + 5), document],
                )
                .unwrap();
        }
        let stored: String = f
            .client
            .query_one("SELECT pg_typeof(data)::text FROM math_main LIMIT 1", &[])
            .unwrap()
            .get(0);
        assert_eq!(stored, data_type);
        reads.push(
            (0..=documents.len())
                .map(|zid| {
                    Priorities::new(4)
                        .read(&mut f.client, zid as i32, "test")
                        .map(|data| data.map(|data| js::stringify(&data)))
                        .map_err(|error| format!("{error:#}"))
                })
                .collect(),
        );
    }
    assert_eq!(reads[0], reads[1], "jsonb and json differ");
    let priorities = |text: &str| Ok(Some(format!("{{\"comment-priorities\":{text}}}")));
    let refused = || Err("unsupported math shape".to_owned());
    let expected = [
        priorities(r#"{"0":2,"1":0.5,"9":4}"#),
        priorities(r#"{"0":2,"1":0.5,"2":0,"3":null,"5":false,"9":4}"#),
        // The last of a repeated key is the one read, on both types.
        priorities(r#"{"0":3,"1":7}"#),
        priorities(r#"{"1":6,"10":1.5}"#),
        priorities("{}"),
        priorities("null"),
        priorities("[1,2]"),
        Ok(Some("{}".to_owned())),
        Ok(Some("{}".to_owned())),
        refused(),
        refused(),
        refused(),
        refused(),
        // No committed row for the conversation.
        Ok(None),
    ];
    for (zid, expected) in expected.iter().enumerate() {
        assert_eq!(&reads[1][zid], expected, "document {zid}");
    }
    // Nothing remembers the column's type: on this one connection the same
    // statement gives the same answer after the type changes under it.
    f.client
        .batch_execute("ALTER TABLE math_main ALTER COLUMN data TYPE jsonb")
        .unwrap();
    let cache = Priorities::new(4);
    let first = cache.read(&mut f.client, 0, "test").unwrap().unwrap();
    f.client
        .batch_execute("ALTER TABLE math_main ALTER COLUMN data TYPE json")
        .unwrap();
    assert_eq!(
        Priorities::new(4)
            .read(&mut f.client, 0, "test")
            .unwrap()
            .unwrap(),
        first
    );
    // A generation already held is revalidated without its document on json
    // too: the tick is all that is read.
    cache.expire(0, "test");
    f.client
        .batch_execute("UPDATE math_main SET data='{\"comment-priorities\":{\"0\":9}}' WHERE zid=0")
        .unwrap();
    assert_eq!(
        cache.read(&mut f.client, 0, "test").unwrap().unwrap(),
        first
    );
    // A column of any other type is refused by the statement itself.
    f.client
        .batch_execute("ALTER TABLE math_main ALTER COLUMN data TYPE text")
        .unwrap();
    assert!(Priorities::new(4).read(&mut f.client, 0, "test").is_err());
}
