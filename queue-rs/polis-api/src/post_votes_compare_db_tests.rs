//! The routing comparison in the vote shadow, against a database: what the
//! key being absent, a conversation not on the list, a refusal, a shed
//! comparison and the live writer's selection each leave unchanged, and what
//! a line of a listed copy never carries.
//!
//! Every valid fixture vote is written through `append`, the writer's own
//! sign-aware path (the vote-sign rules); no vote value is ever logged. The
//! conversation codes are made up.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::database_tests::{blocking, connector, field, fixture, observer_for, runtime};
use super::*;
use observe::compare::{self, Compare, ROUTING_KEYS};

/// The values of a line that are timings or the request's own id: masked
/// before two lines are compared.
const MASKED: &[&str] = &[
    "request_id",
    "queue_ms",
    "admission_ms",
    "selection_ms",
    "total_ms",
    "readback_s",
];

/// A copy's line as printed, found by its request id, without asserting its
/// keys (a listed copy's line has the routing keys after `LINE_KEYS`).
fn raw_line(id: &str) -> Option<String> {
    let marker = format!("\"request_id\":\"{id}\"");
    shadow::recorded()
        .into_iter()
        .find(|line| line.contains(&marker) && line.contains("\"shadow_observation\""))
}

async fn raw(id: &str) -> String {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(line) = raw_line(id) {
                return line;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no observation line for {id}"))
}

/// The line's keys in printed order, and its values with the timings and the
/// request id masked: what two lines of the same copy must share.
fn masked(line: &str) -> (Vec<String>, Value) {
    let mut value: Value = serde_json::from_str(line).unwrap();
    for key in MASKED {
        if let Some(v) = value.get_mut(*key) {
            *v = Value::Null;
        }
    }
    (printed_keys(line), value)
}

/// The line without its routing keys, masked.
fn masked_without_routing(line: &str) -> (Vec<String>, Value) {
    let (keys, mut value) = masked(line);
    for key in ROUTING_KEYS {
        value.as_object_mut().unwrap().remove(key);
    }
    let keys = keys
        .into_iter()
        .filter(|key| !ROUTING_KEYS.contains(&key.as_str()))
        .collect();
    (keys, value)
}

fn listed_keys() -> Vec<String> {
    LINE_KEYS
        .iter()
        .chain(ROUTING_KEYS.iter())
        .map(|key| (*key).to_owned())
        .collect()
}

fn unlisted_keys() -> Vec<String> {
    LINE_KEYS.iter().map(|key| (*key).to_owned()).collect()
}

/// An observer on `db` whose routing comparison is built from the key's
/// value `key` (None: the key is absent).
fn app_with(db: &Database, keys: &Signing, key: Option<&str>) -> Arc<App> {
    let mut observer = observer_for(db, keys);
    observer.compare = key.and_then(|raw| Compare::new(raw).unwrap());
    shadow_app(connector(db), Some(observer))
}

fn comparison(app: &App) -> &Compare {
    app.post_votes_observe
        .as_ref()
        .unwrap()
        .compare
        .as_deref()
        .expect("a comparison")
}

fn entered(app: &App) -> u64 {
    comparison(app)
        .entered
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// The comparison's entry points called on this thread so far.
fn called() -> u64 {
    compare::CALLED.with(std::cell::Cell::get)
}

/// The selections' weights dropped on this thread so far: a copy whose
/// selection carried them drops them here.
fn weights_dropped() -> u64 {
    compare::WEIGHTS_DROPPED.with(std::cell::Cell::get)
}

async fn send(app: &Arc<App>, lane: &Arc<shadow::Lane>, body: &Value, token: &str) -> String {
    let id = request_id();
    let out = shadow::accept(app.clone(), lane.clone(), copy(body, Some(token), &id)).await;
    assert_eq!(out.status, 204);
    raw(&id).await
}

/// The same copies, in the same order, through a fresh observer each: the
/// lines, in order.
fn lines_of(db: &Database, keys: &Signing, key: Option<&str>, bodies: &[Value]) -> Vec<String> {
    let app = app_with(db, keys, key);
    let member = token(keys, "2fixture");
    runtime().block_on(async {
        let lane = shadow::Lane::new(1000);
        let mut lines = vec![];
        for body in bodies {
            lines.push(send(&app, &lane, body, &member).await);
        }
        lines
    })
}

/// Copies on statements 2, 4 and 6 of the fixture: each would serve a next
/// statement from 8 candidates.
fn three_copies() -> Vec<Value> {
    [2, 4, 6]
        .into_iter()
        .map(|tid| vote_body("2fixture", tid, VoteChoice::Agree))
        .collect()
}

fn set_priorities(db: &Database, priorities: &Value) {
    db.connect()
        .execute(
            "UPDATE math_main SET data=$1::text::jsonb WHERE zid=1",
            &[&priorities.to_string()],
        )
        .unwrap();
}

/// Test 5. With the key absent the line has exactly today's keys in today's
/// order and today's values, and `/health` has no `routingCompare`.
#[test]
fn compare_off_line_and_health_unchanged() {
    let keys = signing();
    let db = fixture("compare_off");
    let app = app_with(&db, &keys, None);
    let member = token(&keys, "2fixture");
    runtime().block_on(async {
        let lane = shadow::Lane::new(1000);
        for body in three_copies() {
            let line = send(&app, &lane, &body, &member).await;
            assert_eq!(printed_keys(&line), unlisted_keys(), "{line}");
            assert!(!line.contains("routing_") && !line.contains("agrees_with_today"));
            let value: Value = serde_json::from_str(&line).unwrap();
            assert_line_shape(&value);
            assert_eq!(
                json!([
                    value["outcome"],
                    value["status"],
                    value["zid"],
                    value["follow_on"],
                    value["weights_tick"],
                    value["candidates"],
                    value["remaining"],
                    value["total"],
                    value["node_vote"],
                ]),
                json!(["would_serve", 200, 1, "complete", 7, 8, 9, 12, "absent"]),
                "{line}"
            );
        }
        let health = body_of(shadow::health(&app, &lane).await);
        assert!(health.get("routingCompare").is_none(), "{health}");
        assert_eq!(health["postVotes"]["wouldServe"], 3);
    });
}

/// Test 6. With the key absent nothing of the comparison is called, and the
/// cached weights gain no holder. The witness: the same harness with the
/// copy's conversation listed calls it and adds the keys.
#[test]
fn compare_off_calls_nothing_witnessed() {
    let keys = signing();
    let db = fixture("compare_off_witness");
    let member = token(&keys, "2fixture");
    for (key, listed) in [(None, false), (Some("2fixture"), true)] {
        let app = app_with(&db, &keys, key);
        let cache = app.post_votes_observe.as_ref().unwrap().priorities.clone();
        let config = db.config.clone();
        runtime().block_on(async {
            let lane = shadow::Lane::new(1000);
            // One copy warms the cache; then its weights' holders are counted.
            let bodies = three_copies();
            send(&app, &lane, &bodies[0], &member).await;
            let weights = blocking({
                let cache = cache.clone();
                move || {
                    let mut c = config.connect(postgres::NoTls).unwrap();
                    cache
                        .snapshot(&mut c, 1, "test")
                        .unwrap()
                        .validate()
                        .unwrap()
                }
            })
            .await;
            let holders = Arc::strong_count(&weights);
            let before = called();
            let dropped = weights_dropped();
            let mut lines = vec![];
            for body in &bodies[1..] {
                lines.push(send(&app, &lane, body, &member).await);
            }
            assert_eq!(
                Arc::strong_count(&weights),
                holders,
                "the comparison kept the weights"
            );
            if listed {
                assert!(called() > before, "the witness: listed, it is called");
                for line in &lines {
                    assert_eq!(printed_keys(line), listed_keys(), "{line}");
                }
            } else {
                assert_eq!(called(), before, "off called the comparison");
                assert_eq!(weights_dropped(), dropped, "off carried the weights");
                for line in &lines {
                    assert_eq!(printed_keys(line), unlisted_keys(), "{line}");
                }
            }
        });
    }
}

/// Test 7. The key set, the conversation not on it: nothing is computed, the
/// selection carries no weights, the line is the off line and `/health`'s
/// counts do not move.
#[test]
fn compare_unlisted_writes_nothing_computes_nothing() {
    let keys = signing();
    let db = fixture("compare_unlisted");
    let bodies = three_copies();
    let off = lines_of(&db, &keys, None, &bodies);
    let app = app_with(&db, &keys, Some("2example00,3example01"));
    let member = token(&keys, "2fixture");
    let dropped = weights_dropped();
    let unlisted = runtime().block_on(async {
        let lane = shadow::Lane::new(1000);
        let mut lines = vec![];
        for body in &bodies {
            lines.push(send(&app, &lane, body, &member).await);
        }
        assert_eq!(
            weights_dropped(),
            dropped,
            "an unlisted copy's selection carried the weights"
        );
        let health = body_of(shadow::health(&app, &lane).await);
        let counts = &health["routingCompare"];
        for key in [
            "compared",
            "agreed",
            "differed",
            "refused",
            "noSelection",
            "tooManyCandidates",
            "shed",
            "timedOut",
        ] {
            assert_eq!(counts[key], 0, "{key}: {health}");
        }
        assert_eq!(counts["conversations"], 2);
        assert!(!health.to_string().contains("example0"), "{health}");
        lines
    });
    assert_eq!(entered(&app), 0, "an unlisted copy entered the comparison");
    for (off, unlisted) in off.iter().zip(&unlisted) {
        assert_eq!(printed_keys(unlisted), unlisted_keys(), "{unlisted}");
        assert_eq!(masked(unlisted), masked(off), "unlisted differs from off");
    }
    // The selection an unlisted copy makes carries no weights; asked for, it
    // does (the witness).
    let mut c = db.connect();
    for ask in [false, true] {
        let mut selection = Selection::new(2);
        selection.compare = ask;
        let dropped = weights_dropped();
        next_selecting(&mut c, &actor(), "test", 0.5, None, Some(&mut selection)).unwrap();
        assert_eq!(selection.weights.is_some(), ask, "compare={ask}");
        drop(selection);
        assert_eq!(weights_dropped() - dropped, u64::from(ask), "compare={ask}");
    }
}

/// Test 3. A refused comparison changes nothing of today's: every existing
/// key equals the same copy's with the key absent, the read-back and the memo
/// included.
#[test]
fn compare_refusal_changes_nothing() {
    let keys = signing();
    let db = fixture("compare_refusal");
    // Above the library's ceiling of 1e150: the writer draws, the library
    // refuses.
    // Statement 9 is a candidate of every copy below.
    set_priorities(&db, &json!({"comment-priorities": {"4": 1.5, "9": 1e151}}));
    let bodies = three_copies();
    let off = lines_of(&db, &keys, None, &bodies);
    let on = lines_of(&db, &keys, Some("2fixture"), &bodies);
    for (off, on) in off.iter().zip(&on) {
        let value: Value = serde_json::from_str(on).unwrap();
        assert_eq!(printed_keys(on), listed_keys(), "{on}");
        assert_eq!(value["routing_compare"], "refused", "{on}");
        assert_eq!(value["routing_refusal"], "unsupported_legacy_weight");
        assert!(value["agrees_with_today"].is_null());
        assert!(value["routing_p_band"].is_null());
        assert_eq!(value["routing_generation"], "same");
        assert_eq!(masked_without_routing(on), masked(off), "{on}");
    }
}

/// Test 4. A negative stored weight is handed back by admission
/// (`priorities_invalid`) and never reaches the comparison.
#[test]
fn negative_weight_hands_back_before_compare() {
    let keys = signing();
    let db = fixture("compare_negative");
    set_priorities(&db, &json!({"comment-priorities": {"4": -1}}));
    let app = app_with(&db, &keys, Some("2fixture"));
    let member = token(&keys, "2fixture");
    runtime().block_on(async {
        let lane = shadow::Lane::new(1000);
        let line = send(
            &app,
            &lane,
            &vote_body("2fixture", 2, VoteChoice::Agree),
            &member,
        )
        .await;
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["reason"], "priorities_invalid", "{line}");
        assert_eq!(printed_keys(&line), unlisted_keys(), "{line}");
    });
    assert_eq!(entered(&app), 0);
}

/// Test 11. The comparison adds no statement and no connection: the reads
/// and read-back pools' evidence moves by the same amounts for the same
/// copies with the key absent and listing their conversation, and the shadow
/// still reports exactly those two pools.
#[test]
fn compare_no_sql_no_connection() {
    let keys = signing();
    let db = fixture("compare_no_sql");
    let member = token(&keys, "2fixture");
    let mut seen = vec![];
    for key in [None, Some("2fixture")] {
        let app = app_with(&db, &keys, key);
        let observer = app.post_votes_observe.as_ref().unwrap();
        let (reads, readback) = (observer.reads.clone(), observer.readback.clone());
        let before = (reads.evidence.snapshot(), readback.evidence.snapshot());
        let pools = runtime().block_on(async {
            let lane = shadow::Lane::new(1000);
            for body in three_copies() {
                send(&app, &lane, &body, &member).await;
            }
            body_of(shadow::health(&app, &lane).await)["postVotes"]["pools"].clone()
        });
        let after = (reads.evidence.snapshot(), readback.evidence.snapshot());
        let delta = |a: [usize; 6], b: [usize; 6]| -> Vec<usize> {
            a.iter().zip(b).map(|(a, b)| a - b).collect()
        };
        let mut names: Vec<&String> = pools.as_object().unwrap().keys().collect();
        names.sort();
        assert_eq!(names, ["readback", "reads"], "{pools}");
        seen.push((delta(after.0, before.0), delta(after.1, before.1)));
    }
    assert_eq!(seen[1], seen[0], "the comparison used the pools");
    assert!(seen[0].0[0] > 0, "the copies read: {seen:?}");
}

/// Test 10 (the database half). A comparison held past the bound gives
/// `timed_out` and its line is printed with today's keys and values; the next
/// copy, while that draw still holds the one permit, gives `shed`; once the
/// draw ends a copy is compared.
#[test]
fn compare_sheds_first_on_the_line() {
    let keys = signing();
    let db = fixture("compare_shed");
    let bodies = three_copies();
    let off = lines_of(&db, &keys, None, &bodies);
    let app = app_with(&db, &keys, Some("2fixture"));
    let member = token(&keys, "2fixture");
    let on = runtime().block_on(async {
        let lane = shadow::Lane::new(1000);
        let hold = Duration::from_millis(1500);
        *comparison(&app).hold.lock().unwrap() = Some(hold);
        let first = send(&app, &lane, &bodies[0], &member).await;
        let second = send(&app, &lane, &bodies[1], &member).await;
        *comparison(&app).hold.lock().unwrap() = None;
        // The held draw keeps its permit until it ends.
        tokio::time::sleep(hold).await;
        let third = send(&app, &lane, &bodies[2], &member).await;
        vec![first, second, third]
    });
    for (line, outcome) in on.iter().zip(["timed_out", "shed", "compared"]) {
        let value: Value = serde_json::from_str(line).unwrap();
        assert_eq!(value["routing_compare"], outcome, "{line}");
        assert_eq!(printed_keys(line), listed_keys(), "{line}");
    }
    for (off, on) in off.iter().zip(&on) {
        assert_eq!(masked_without_routing(on), masked(off), "{on}");
    }
}

/// A conversation with distinctive numbers: participant 777777, user 888888,
/// statements 900000 to 900005, the code `2scan0code`.
fn scan_fixture(label: &str) -> Database {
    let db = Database::new(label);
    let mut c = db.connect();
    c.batch_execute(
        "INSERT INTO users(uid) VALUES(888888);
         INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
         INSERT INTO zinvites(zid,zinvite) VALUES(1,'2scan0code');
         ALTER TABLE participants DISABLE TRIGGER USER;
         INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,777777,888888,0);
         ALTER TABLE participants ENABLE TRIGGER USER;
         INSERT INTO comments(zid,pid,uid,txt,lang,created)
         SELECT 1,777777,888888,'Distinctive words ' || t,'en',1700000000000+t FROM generate_series(0,5) t ORDER BY t;
         UPDATE comments SET tid = tid + 900000 WHERE zid = 1;",
    )
    .unwrap();
    let priorities = json!({"comment-priorities": {"900002": 3, "900003": 0.5}});
    c.execute(
        "INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data) VALUES(1,'test',7,0,$1::text::jsonb)",
        &[&priorities.to_string()],
    )
    .unwrap();
    db
}

fn scan_actor() -> Admitted {
    let mut a = actor();
    a.pid = 777777;
    a.uid = 888888;
    a
}

fn scan_token(keys: &Signing) -> String {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    encode(
        &Header::new(Algorithm::RS256),
        &json!({
            "uid":888888,"pid":777777,"conversation_id":"2scan0code","sub":"anon:888888",
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,
            "anonymous_participant":true
        }),
        &keys.private,
    )
    .unwrap()
}

/// The keys whose values may be numbers, and none of them may be an
/// identifier: the counts, the conversation, the generation and timings.
const NUMBER_KEYS: &[&str] = &[
    "admitted",
    "status",
    "queue_ms",
    "admission_ms",
    "selection_ms",
    "total_ms",
    "readback_s",
    "zid",
    "remaining",
    "total",
    "candidates",
    "weights_tick",
];

fn assert_never_written(line: &str, token: &str) {
    for forbidden in [
        "777777",
        "888888",
        "900000",
        "900001",
        "900002",
        "900003",
        "900004",
        "900005",
        "Distinctive",
        "2scan0code",
        "Bearer",
        "anon:",
        "1e151",
        "1e+151",
        "Unsupported",
        "weight(",
        "[",
        &token[..24],
    ] {
        assert!(!line.contains(forbidden), "{forbidden} in {line}");
    }
    let value: Value = serde_json::from_str(line).unwrap();
    for (key, v) in value.as_object().unwrap() {
        if v.is_number() {
            assert!(NUMBER_KEYS.contains(&key.as_str()), "{key} is a number");
        }
        assert!(!v.is_array() && !v.is_object(), "{key} is not flat");
    }
    for key in ROUTING_KEYS {
        assert!(!value[key].is_number(), "{key} is a number");
    }
    assert_eq!(printed_keys(line), listed_keys(), "{line}");
}

/// Test 8 (the database scan). A listed copy's line, compared, refused and
/// with no selection, never carries the participant or any identifier of one,
/// a comment id or text, a vote value, the candidates, a refusal's text or the
/// code on the list.
#[test]
fn compare_line_never_writes_identifiers() {
    let keys = signing();
    let db = scan_fixture("compare_scan");
    let app = app_with(&db, &keys, Some("2scan0code"));
    let member = scan_token(&keys);
    let mut c = db.connect();
    append(&mut c, &scan_actor(), &field(900000, VoteChoice::Agree)).unwrap();
    let config = db.config.clone();
    let lines = runtime().block_on(async {
        let lane = shadow::Lane::new(1000);
        let body = |tid| vote_body("2scan0code", tid, VoteChoice::Disagree);
        let compared = send(&app, &lane, &body(900001), &member).await;
        // Above the ceiling: refused.
        blocking({
            let config = config.clone();
            move || {
                config
                    .connect(postgres::NoTls)
                    .unwrap()
                    .execute(
                        "UPDATE math_main SET data='{\"comment-priorities\":{\"900003\":1e151}}'::jsonb, math_tick=8 WHERE zid=1",
                        &[],
                    )
                    .unwrap();
            }
        })
        .await;
        let refused = send(&app, &lane, &body(900002), &member).await;
        // Every statement but the copy's voted: nothing left to select.
        blocking(move || {
            let mut c = config.connect(postgres::NoTls).unwrap();
            for tid in [900001, 900002, 900003, 900004] {
                append(&mut c, &scan_actor(), &field(tid, VoteChoice::Pass)).unwrap();
            }
        })
        .await;
        let empty = send(&app, &lane, &body(900005), &member).await;
        vec![compared, refused, empty]
    });
    for (line, outcome) in lines.iter().zip(["compared", "refused", "no_selection"]) {
        let value: Value = serde_json::from_str(line).unwrap();
        assert_eq!(value["routing_compare"], outcome, "{line}");
        assert_never_written(line, &member);
    }
}

/// Test 12. The fields the comparison added to the selection cannot alter the
/// live path: `next`, the live writer's call, and `next_selecting` asked for
/// the comparison's weights, with the copy's statement one already voted,
/// return the same bytes, with and without a language.
#[test]
fn live_next_unchanged_by_compare_fields() {
    let db = fixture("compare_live_next");
    let mut c = db.connect();
    let a = actor();
    // The fixture's member voted on 0 and 1.
    for unit in [0.0, 0.25, 0.5, 0.75, 0.9999] {
        for lang in [None, Some("fr")] {
            let live = next(&mut c, &a, "test", unit, lang).unwrap();
            let mut selection = Selection::new(0);
            selection.compare = true;
            let observed =
                next_selecting(&mut c, &a, "test", unit, lang, Some(&mut selection)).unwrap();
            assert!(selection.weights.is_some());
            assert_eq!(
                observed.as_ref().map(js::stringify),
                live.as_ref().map(js::stringify),
                "unit {unit} lang {lang:?}"
            );
            assert!(live.is_some());
        }
    }
}
