use super::{
    database::{Database, actor},
    *,
};

fn fixture(label: &str, newest_weight: f64) -> Database {
    let db = Database::new(label);
    let mut c = db.connect();
    c.batch_execute(
        "INSERT INTO users(uid) VALUES(1);
         INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
         ALTER TABLE participants DISABLE TRIGGER USER;
         INSERT INTO participants(zid,pid,uid) VALUES(1,0,1);
         ALTER TABLE participants ENABLE TRIGGER USER;
         INSERT INTO comments(zid,pid,uid,txt,lang,created)
         SELECT 1,0,1,'Generated statement ' || t,'en',1700000000000+t
         FROM generate_series(0,1199) t ORDER BY t;",
    )
    .unwrap();
    let priorities = serde_json::json!({"comment-priorities": {"1199": newest_weight}});
    c.execute(
        "INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data) VALUES(1,'test',0,0,$1::text::jsonb)",
        &[&priorities.to_string()],
    )
    .unwrap();
    assert_eq!(
        c.query_one("SELECT count(*) FROM comments WHERE zid=1 AND active=true AND mod != -1 AND velocity>0", &[])
            .unwrap().get::<_, i64>(0),
        1200
    );
    db
}

fn selected(db: &Database, unit: f64) -> serde_json::Value {
    let result = complete(&mut db.connect(), &actor(), "test", unit, None).unwrap();
    serde_json::to_value(result.next_comment.unwrap()).unwrap()
}

#[test]
fn writer_next_draws_from_every_eligible_comment() {
    let db = fixture("all_candidates", 1.0);
    let comment = selected(&db, 0.9999);
    assert_eq!(comment["remaining"], 1200);
    assert_eq!(comment["total"], 1200);
    assert_eq!(
        comment["tid"], 1199,
        "the newest eligible comment must enter the draw"
    );
    assert_eq!(comment["randomN"], 0.9999 * 1200.0);
}

#[test]
fn writer_next_includes_newest_comment_priority() {
    let db = fixture("newest_priority", 10000.0);
    let comment = selected(&db, 0.5);
    assert_eq!(
        comment["tid"], 1199,
        "the newest comment's weight must enter the draw"
    );
    assert_eq!(comment["randomN"], 0.5 * 11199.0);
}
