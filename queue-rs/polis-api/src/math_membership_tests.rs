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
    let mut previous = None;
    let mut stored = (0.0, 0.0);
    let cold = wait_for_generation(
        &cache,
        &pool,
        "a",
        "a reused whole generation",
        |read, started, finished| {
            assert!(matches!(read.as_ref(), Read::Complete(b) if b.tick == 0));
            let reused = previous
                .as_ref()
                .is_some_and(|last| std::sync::Arc::ptr_eq(last, read));
            if !reused {
                // A new whole generation is read and stored only during this call.
                stored = (started, finished);
            }
            previous = Some(read.clone());
            reused
        },
    )
    .await;
    let Read::Complete(b) = cold.as_ref() else {
        panic!("coherent zero generation");
    };
    assert_eq!(b.tick, 0);
    assert_eq!(b.bid(0), Some(42));
    assert_eq!(b.bid(2), Some(99));
    assert_eq!(b.bid(9), None);
    assert_eq!(b.pids(0), Some(vec![0]));
    assert!(b.pids(-1).unwrap().is_empty());
    wait_for_generation(&cache, &pool, "other", "Absent", |read, _, _| {
        assert!(matches!(read.as_ref(), Read::Absent));
        true
    })
    .await;
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
    assert!(matches!(
        pool.with(|c| math_bundle::read(c, 1, "a"))
            .await
            .unwrap()
            .unwrap(),
        Read::Incoherent(1)
    ));
    // Setup may already have outlasted the cached generation. Observe its
    // replacement instead of assuming a fixed sleep makes a refresh succeed.
    // Each read is bracketed by the cache's own clock, so load moves neither
    // three-second bound: no replacement before, no stored generation after.
    wait_for_generation(
        &cache,
        &pool,
        "a",
        "Incoherent(1)",
        |read, started, finished| match read.as_ref() {
            Read::Incoherent(1) => {
                assert!(
                    finished >= stored.0 + 3000.0,
                    "replaced before three seconds: stored {stored:?}, read {started}..{finished}"
                );
                true
            }
            Read::Complete(_) => {
                assert!(
                    std::sync::Arc::ptr_eq(read, &cold),
                    "only the original whole generation may remain before expiry: {read:?}"
                );
                assert!(
                    started < stored.1 + 3000.0,
                    "served after three seconds: stored {stored:?}, read {started}..{finished}"
                );
                false
            }
            other => panic!("unexpected replacement generation: {other:?}"),
        },
    )
    .await;
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

// A cache miss uses the real bounded pool. Retry only a confirmed database
// failure; unexpected data must still fail the caller's assertions immediately.
async fn wait_for_generation(
    cache: &Cache,
    pool: &std::sync::Arc<crate::db::Pool>,
    environment: &str,
    expected: &str,
    mut accept: impl FnMut(&std::sync::Arc<Read>, f64, f64) -> bool,
) -> std::sync::Arc<Read> {
    let mut unavailable = 0;
    let observed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let before = pool.evidence.snapshot();
            let started = crate::clock::now_ms();
            match cache.get(pool, 1, environment).await {
                Some(read) if accept(&read, started, crate::clock::now_ms()) => break read,
                Some(_) => {}
                None => {
                    let after = pool.evidence.snapshot();
                    assert!(
                        after[2] > before[2] || after[4] > before[4],
                        "refresh lost a generation without a database failure: {before:?} -> {after:?}"
                    );
                    unavailable += 1;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    observed.unwrap_or_else(|_| {
        panic!(
            "cache never exposed {expected}; unavailable attempts: {unavailable}; pool: {:?}",
            pool.evidence.snapshot()
        )
    })
}

/// The three math documents are jsonb in a database built from the migrations
/// and json in an installation whose database predates them. The whole
/// generation read gives the same answer on both, and refuses statistics kept
/// in a column of any other type.
#[test]
fn json_and_jsonb_math_columns_give_the_same_generation() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    let schema = format!("math_bundle_types_{}", std::process::id());
    c.batch_execute(&format!(
        "CREATE SCHEMA {schema}; SET search_path={schema};
         CREATE TABLE math_main(zid integer,math_env text,data text,math_tick bigint);
         CREATE TABLE math_bidtopid(zid integer,math_env text,data text,math_tick bigint);
         CREATE TABLE math_ptptstats(zid integer,math_env text,data text,math_tick bigint);
         CREATE TABLE math_ticks(zid integer,math_env text,math_tick bigint);"
    ))
    .unwrap();
    let main = r#"{"base-clusters":{"id":[42,99]},"group-clusters":[{"members":[42]}],"n":2}"#;
    let spaced = "{ \"group-clusters\" : [ { \"members\" : [ 99 ] } ] ,\n\t\"base-clusters\" : { \"id\" : [ 42 , 99 ] } }";
    // (zid, main, mapping, statistics, ticks of mapping, statistics, math_ticks)
    type Case = (
        i32,
        &'static str,
        Option<&'static str>,
        Option<&'static str>,
        [i64; 3],
    );
    let cases: Vec<Case> = vec![
        (
            1,
            main,
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some("{}"),
            [7; 3],
        ),
        (
            2,
            spaced,
            Some("{ \"bidToPid\" : [ [ 0 , 1 ] , [ 2 ] ] }"),
            Some(" { \"a\" : 1 } "),
            [7; 3],
        ),
        (
            3,
            main,
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some("null"),
            [7; 3],
        ),
        (
            4,
            main,
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some(" null\n"),
            [7; 3],
        ),
        (5, main, Some(r#"{"bidToPid":[[0],[2]]}"#), None, [7; 3]),
        (6, main, Some("null"), Some("{}"), [7; 3]),
        (7, main, Some("\tnull "), Some("{}"), [7; 3]),
        (8, main, None, Some("{}"), [7; 3]),
        (
            9,
            main,
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some("[1]"),
            [7, 6, 7],
        ),
        (
            10,
            main,
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some("0"),
            [7; 3],
        ),
        (
            11,
            main,
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some("\"null\""),
            [7; 3],
        ),
        (
            12,
            "[1]",
            Some(r#"{"bidToPid":[[0],[2]]}"#),
            Some("false"),
            [7; 3],
        ),
    ];
    let mut reads: Vec<Vec<String>> = vec![];
    for data_type in ["jsonb", "json"] {
        // The types are set here, whatever shape the test database gives a
        // newly created table.
        c.batch_execute(&format!(
            "TRUNCATE math_main, math_bidtopid, math_ptptstats, math_ticks;
             ALTER TABLE math_main ALTER COLUMN data TYPE {data_type} USING data::{data_type};
             ALTER TABLE math_bidtopid ALTER COLUMN data TYPE {data_type} USING data::{data_type};
             ALTER TABLE math_ptptstats ALTER COLUMN data TYPE {data_type} USING data::{data_type};"
        ))
        .unwrap();
        for (zid, main, mapping, statistics, ticks) in &cases {
            c.execute(
                &format!("INSERT INTO math_main VALUES($1,'a',$2::text::{data_type},7)"),
                &[zid, main],
            )
            .unwrap();
            if let Some(mapping) = mapping {
                c.execute(
                    &format!("INSERT INTO math_bidtopid VALUES($1,'a',$2::text::{data_type},$3)"),
                    &[zid, mapping, &ticks[0]],
                )
                .unwrap();
            }
            if let Some(statistics) = statistics {
                c.execute(
                    &format!("INSERT INTO math_ptptstats VALUES($1,'a',$2::text::{data_type},$3)"),
                    &[zid, statistics, &ticks[1]],
                )
                .unwrap();
            }
            c.execute(
                "INSERT INTO math_ticks VALUES($1,'a',$2)",
                &[zid, &ticks[2]],
            )
            .unwrap();
        }
        assert_eq!(
            c.query_one(
                "SELECT pg_typeof(m.data)::text, pg_typeof(b.data)::text, pg_typeof(p.data)::text
                 FROM math_main m, math_bidtopid b, math_ptptstats p LIMIT 1",
                &[]
            )
            .map(|row| [row.get::<_, String>(0), row.get(1), row.get(2)])
            .unwrap(),
            [data_type; 3]
        );
        reads.push(
            (1..=13)
                .map(|zid| format!("{:?}", math_bundle::read(&mut c, zid, "a").unwrap()))
                .collect(),
        );
    }
    assert_eq!(reads[0], reads[1], "jsonb and json differ");
    let complete = |read: &str| read.starts_with("Some(Complete(");
    for (index, expected) in [
        (1, "complete"),
        (2, "complete"),
        (3, "incoherent"),
        (4, "incoherent"),
        (5, "incoherent"),
        (6, "incoherent"),
        (7, "incoherent"),
        (8, "incoherent"),
        (9, "incoherent"),
        (10, "complete"),
        (11, "complete"),
        (12, "refused"),
        (13, "absent"),
    ] {
        let read = reads[1][index - 1].as_str();
        let found = if complete(read) {
            "complete"
        } else if read == "Some(Incoherent(7))" {
            "incoherent"
        } else if read == "Some(Absent)" {
            "absent"
        } else if read == "None" {
            "refused"
        } else {
            read
        };
        assert_eq!(found, expected, "conversation {index}: {read}");
    }
    // The members of the first two generations, read from a json column.
    for (zid, pid, bid) in [(1, 2, Some(99)), (2, 1, Some(42)), (2, 2, Some(99))] {
        let Some(Read::Complete(bundle)) = math_bundle::read(&mut c, zid, "a").unwrap() else {
            panic!("conversation {zid} is a complete generation");
        };
        assert_eq!(bundle.bid(pid), bid);
    }
    // Statistics in a column that is neither jsonb nor json are refused.
    c.batch_execute("ALTER TABLE math_ptptstats ALTER COLUMN data TYPE text")
        .unwrap();
    assert!(math_bundle::read(&mut c, 1, "a").unwrap().is_none());
    c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
}
