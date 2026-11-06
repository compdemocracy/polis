use super::*;
#[test]
fn report_query_levels_and_malformed_scalars() {
    for level in [-2, -1, 0] {
        let query = parse_query(&format!(
            "conversation_id=generated&report_id=rGenerated&mod_gt={level}"
        ))
        .unwrap();
        assert_eq!(query.mod_gt, level);
    }
    for extra in [
        "&lang=fr",
        "&translate=true",
        "&pid=4",
        "&limit=1",
        "&mod=1",
    ] {
        assert_eq!(
            parse_query(&format!(
                "conversation_id=generated&report_id=rGenerated&mod_gt=-2{extra}"
            )),
            Err(ParseError::Handback)
        );
    }
    for raw in [
        "conversation_id=generated",
        "report_id=rGenerated",
        "conversation_id=generated&report_id=",
        "conversation_id=generated&report_id[]=rGenerated",
        "conversation_id=generated&report_id=rGenerated&mod_gt=bad",
        "conversation_id=generated&report_id=rGenerated&mod_gt=0&mod_gt=0",
    ] {
        assert_eq!(parse_query(raw), Err(ParseError::BadRequest), "{raw}");
    }
}
#[cfg(feature = "db-tests")]
#[test]
fn report_rows_visibility_levels_counts_and_no_math_dependency() {
    use crate::votes::{StorageConvention, VoteChoice};
    let mut c = postgres::Client::connect(
        &std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap(),
        postgres::NoTls,
    )
    .unwrap();
    c.batch_execute("CREATE TEMP TABLE comments(zid integer,tid integer,txt text,is_meta boolean,pid integer,mod integer,active boolean,velocity real);
    INSERT INTO comments VALUES
    (1,0,'pending',false,7,0,true,1),
    (1,1,'accepted',true,8,1,true,1),
    (1,2,'rejected',false,9,-1,true,1),
    (1,3,'inactive',false,10,1,false,1),
    (1,4,'muted',NULL,NULL,1,true,0),
    (1,5,NULL,NULL,NULL,NULL,true,1),
    (2,1,'other conversation',false,90,1,true,1);").unwrap();
    // Statement moderation states above are independent of stored vote choices.
    c.batch_execute("CREATE TEMP TABLE votes_latest_unique(zid integer,tid integer,vote smallint)")
        .unwrap();
    for choice in [
        VoteChoice::Agree,
        VoteChoice::Agree,
        VoteChoice::Disagree,
        VoteChoice::Pass,
    ] {
        let stored = i16::try_from(StorageConvention::CURRENT.encode(choice)).unwrap();
        c.execute("INSERT INTO votes_latest_unique VALUES(1,1,$1)", &[&stored])
            .unwrap();
    }
    for (visible, strict, level, expected) in [
        (true, false, -2, vec![0, 1]),
        (true, true, -2, vec![1]),
        (true, false, 0, vec![1]),
        (false, false, -2, vec![0, 1, 2, 3, 4, 5]),
        (false, false, -1, vec![0, 1, 3, 4]),
        (false, false, 0, vec![1, 3, 4]),
    ] {
        let rows = read(&mut c, 1, level, visible, strict).unwrap();
        let mut tids: Vec<_> = rows.iter().map(|r| r.tid).collect();
        tids.sort();
        assert_eq!(tids, expected);
        let accepted = rows.iter().find(|r| r.tid == 1).unwrap();
        assert_eq!(
            (
                accepted.agree_count,
                accepted.disagree_count,
                accepted.pass_count,
                accepted.count
            ),
            (2, 1, 1, 4)
        );
        for row in rows {
            assert_eq!(
                serde_json::to_value(row)
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .len(),
                8
            );
        }
    }
    assert!(read(&mut c, 99, -2, true, false).unwrap().is_empty());
}
