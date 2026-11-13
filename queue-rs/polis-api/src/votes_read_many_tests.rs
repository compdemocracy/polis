//! The answer for a participant with more than one row, which only an
//! observation of a copy builds: the rows the one-row answer is made of, each
//! the same object, for the latest rows and for the history.
use super::*;

const PARTICIPANT: i32 = 6;

#[tokio::test]
async fn the_answer_for_many_rows_is_the_one_row_answers_together() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("vote_reads_many_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE SCHEMA {setup_schema};SET search_path={setup_schema};CREATE TABLE zinvites(zid integer,zinvite text);CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote smallint,weight_x_32767 smallint,modified bigint);INSERT INTO zinvites(zid,zinvite) VALUES(8,'fixture');")).unwrap();
        for (tid, choice) in [
            crate::votes::VoteChoice::Agree,
            crate::votes::VoteChoice::Disagree,
            crate::votes::VoteChoice::Pass,
        ]
        .into_iter()
        .enumerate()
        {
            let stored = crate::votes::StorageConvention::CURRENT.encode(choice) as i16;
            c.execute(
                "INSERT INTO votes_latest_unique(zid,pid,tid,vote,weight_x_32767,modified) VALUES(8,$1,$2,$3,$4,$5)",
                &[&PARTICIPANT, &(tid as i32), &stored, &(tid as i16), &(1_700_000_000_000_i64 + tid as i64)],
            )
            .unwrap();
        }
    })
    .await
    .unwrap();
    let mut config: postgres::Config = url.parse().unwrap();
    config.options(&format!("-c search_path={schema}"));
    let pool = crate::db::Pool::new(
        polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config)),
        pool_limits(),
    );
    // The live read hands the participant back, with its reason.
    assert_eq!(
        pool.with(|c| read_reasoned(c, 8, PARTICIPANT, None, false, "fixture"))
            .await
            .unwrap(),
        Err(MANY_ROWS)
    );
    assert!(
        pool.with(|c| read(c, 8, PARTICIPANT, None, false, "fixture"))
            .await
            .unwrap()
            .is_none()
    );
    let Ok(Js::Arr(many)) = pool
        .with(|c| read_many(c, 8, PARTICIPANT, None, false, "fixture"))
        .await
        .unwrap()
    else {
        panic!("an array of rows")
    };
    assert_eq!(many.len(), 3);
    let mut seen = std::collections::BTreeSet::new();
    for row in &many {
        let Some(Js::Num(tid)) = row.as_obj().and_then(|row| row.get("tid")) else {
            panic!("a row with its tid")
        };
        let tid = *tid as i32;
        let Some(Js::Arr(one)) = pool
            .with(move |c| read(c, 8, PARTICIPANT, Some(tid), false, "fixture"))
            .await
            .unwrap()
        else {
            panic!("the one-row answer")
        };
        assert_eq!(one.as_slice(), std::slice::from_ref(row), "tid {tid}");
        seen.insert(tid);
    }
    assert_eq!(seen.len(), 3);
    // One row, no row, and a code that is not the conversation's own: the
    // same answers the live read gives.
    for (tid, cid) in [(Some(0), "fixture"), (Some(9), "fixture"), (None, "alias")] {
        let live = pool
            .with(move |c| read_reasoned(c, 8, PARTICIPANT, tid, false, cid))
            .await
            .unwrap();
        let many = pool
            .with(move |c| read_many(c, 8, PARTICIPANT, tid, false, cid))
            .await
            .unwrap();
        if tid.is_some() {
            assert_eq!(many, live, "{tid:?} {cid}");
        } else {
            assert_eq!(many, Err("conversation_code"));
        }
    }
    tokio::task::spawn_blocking(move || {
        drop(pool);
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    })
    .await
    .unwrap();
}
