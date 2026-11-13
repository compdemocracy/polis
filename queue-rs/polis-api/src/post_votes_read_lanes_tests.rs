//! One shadow listener, the two observers and the three read lanes. A flood
//! of copies of reads, on every read lane at once and with every connection
//! of every read lane's pools held, leaves the observations of votes and of
//! comments as they are with no copy of a read at all: the same number, each
//! with the same outcome and classes, each inside its admission deadline,
//! none shed, and none waiting for a connection.
//!
//! Every fixture vote is written through `append`, the vote writer's own
//! sign-aware path.
use super::database_tests::{
    VOTES, connector, contention, counter, digest, fixture, flood, park, runtime, timely,
};
use super::*;
use crate::shadow::reads::{self, Route};
use std::sync::atomic::AtomicBool;

/// A shadow process's state with both observers and the three read lanes,
/// each lane observing at most `reads_per_second` copies a second.
fn app_with_read_lanes(
    connector: impl Fn() -> Connector,
    public: &[u8],
    reads_per_second: u32,
) -> Arc<App> {
    let mut app = App::new(&cfg(), db::Pool::new(connector(), read_limits()));
    app.post_votes_observe = Some(vote_observer(&connector, public));
    app.post_comments_observe = Some(comments::observer_with(
        connector(),
        connector(),
        public,
        vec![],
        1000,
    ));
    for route in Route::ALL {
        reads::install(&mut app, route, reads_per_second, |_, _| Ok(connector())).unwrap();
    }
    app.next_comment_plain = true;
    Arc::new(app)
}

/// A read of the fixture conversation as nginx's mirror would send it.
fn read_copy(route: Route, id: &str) -> Request {
    let query = match route {
        // The fixture's participant: two rows.
        Route::Votes => "conversation_id=2fixture&pid=0",
        Route::Comments | Route::NextComment => "conversation_id=2fixture",
    };
    let mut req = mirrored(
        "GET",
        &format!("{}?{query}", route.path()),
        Some(route.selector()),
        "",
        None,
        id,
    );
    req.headers = crate::http::Headers::from_raw([
        ("host", "localhost"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", id),
        ("x-polis-shadow", route.selector()),
    ]);
    req
}

#[test]
fn a_flood_of_read_copies_leaves_vote_and_comment_observations_unchanged() {
    let keys = signing();
    let db = fixture("read_lanes_flood");
    let before = digest(&db.config);
    let member = token(&keys);
    let authorization = format!("Bearer {member}");
    let texts: Vec<String> = (0..6)
        .map(|n| format!("Generated observed comment {n}"))
        // A text that exists: a duplicate.
        .chain(["Generated comment 3".to_owned()])
        .collect();
    let mut phases = vec![];
    for flooded in [false, true] {
        let app = app_with_read_lanes(connector(&db), &keys.public, 20);
        let rt = runtime();
        let phase = rt.block_on(async {
            let lane = shadow::Lane::new(1000);
            let votes = app.post_votes_observe.as_ref().unwrap();
            let comment_observer = app.post_comments_observe.as_ref().unwrap();
            let [(_, comment_reads), (_, comment_readback)] = comment_observer.startup_pools();
            let stop = Arc::new(AtomicBool::new(false));
            let mut held = vec![];
            let mut flooding = vec![];
            if flooded {
                // Every connection of every read lane's pools is held.
                for read_lane in app.read_lanes.built() {
                    for (_, pool) in read_lane.pools() {
                        let size = pool.health(true).as_obj().unwrap().get("limit").cloned();
                        let Some(Js::Num(size)) = size else {
                            panic!("a pool's limit")
                        };
                        held.extend(park(pool, size as usize).await);
                    }
                }
                for route in Route::ALL {
                    flooding.push(tokio::spawn(flood(
                        app.clone(),
                        lane.clone(),
                        move |_, id| read_copy(route, id),
                        stop.clone(),
                    )));
                }
                // Every read lane has shed before the first vote is sent.
                tokio::time::timeout(Duration::from_secs(30), async {
                    loop {
                        let health: Value =
                            serde_json::from_str(&health_body(shadow::health(&app, &lane).await))
                                .unwrap();
                        if Route::ALL
                            .iter()
                            .all(|route| counter(&health, route.health_key(), "shed") > 0)
                        {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                })
                .await
                .expect("every read lane sheds");
            }
            let waits_before = [
                contention(&votes.reads),
                contention(&votes.readback),
                contention(comment_reads),
                contention(comment_readback),
            ];
            let mut vote_lines = vec![];
            for (tid, choice) in VOTES {
                let id = request_id();
                let req = vote_copy(&vote_body(tid, choice), Some(member.as_str()), &id);
                assert_eq!(
                    shadow::accept(app.clone(), lane.clone(), req).await.status,
                    204
                );
                let line = vote_line(&id).await;
                vote_lines.push(json!([
                    line["outcome"],
                    line["admitted"],
                    line["status"],
                    line["reason"],
                    line["zid"],
                    line["follow_on"],
                    line["remaining"],
                    line["total"],
                    line["candidates"],
                    line["weights_tick"],
                    line["prev"],
                    line["node_vote"],
                    timely(&line),
                ]));
            }
            let mut comment_lines = vec![];
            for text in &texts {
                let id = request_id();
                let req = comments::copy(&comment_body(text), Some(authorization.as_str()), &id);
                assert_eq!(
                    shadow::accept(app.clone(), lane.clone(), req).await.status,
                    204
                );
                let line = comments::observation(&id).await;
                comment_lines.push(json!([
                    line["outcome"],
                    line["admitted"],
                    line["status"],
                    line["reason"],
                    line["strict"],
                    line["text_row"],
                    line["node_comment"],
                    line["node_vote"],
                    line["readback_s"],
                    timely(&line),
                ]));
            }
            let waits_after = [
                contention(&votes.reads),
                contention(&votes.readback),
                contention(comment_reads),
                contention(comment_readback),
            ];
            // While every read connection is still held.
            let held_health: Value =
                serde_json::from_str(&health_body(shadow::health(&app, &lane).await)).unwrap();
            stop.store(true, Ordering::SeqCst);
            let mut sent = 0;
            for task in flooding {
                sent += task.await.unwrap();
            }
            drop(held);
            tokio::time::timeout(Duration::from_secs(30), async {
                while app.read_lanes.built().any(|lane| lane.in_flight() != 0) {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("the read lanes drain");
            let health: Value =
                serde_json::from_str(&health_body(shadow::health(&app, &lane).await)).unwrap();
            (
                vote_lines,
                comment_lines,
                waits_before,
                waits_after,
                sent,
                health,
                held_health,
            )
        });
        drop(app);
        drop(rt);
        phases.push(phase);
    }
    let (quiet, flooded) = (&phases[0], &phases[1]);
    // The flood was one: far more copies than the lanes' rate, on each lane.
    assert!(flooded.4 > 600, "only {} read copies were sent", flooded.4);
    for route in Route::ALL {
        let key = route.health_key();
        assert!(counter(&flooded.5, key, "shed") > 100, "{}", flooded.5);
        assert!(counter(&flooded.5, key, "observed") >= 10, "{}", flooded.5);
        // No read was served while every connection it could have used was
        // held, and each lane had observed copies by then.
        assert_eq!(counter(&flooded.6, key, "wouldServe"), 0, "{}", flooded.6);
        assert!(
            counter(&flooded.6, key, "wouldHandBack") > 0,
            "{}",
            flooded.6
        );
        assert_eq!(counter(&quiet.5, key, "observed"), 0);
        assert_eq!(counter(&quiet.5, key, "shed"), 0);
    }
    // The vote observations: the same count, and each the same.
    assert_eq!(quiet.0.len(), VOTES.len());
    assert_eq!(
        quiet.0, flooded.0,
        "vote observations changed under a flood of reads"
    );
    for line in &flooded.0 {
        assert_eq!(line[0], "would_serve", "{line}");
        assert_eq!(line[12], true, "admission ran past its deadline: {line}");
    }
    // The comment observations too.
    assert_eq!(quiet.1.len(), texts.len());
    assert_eq!(
        quiet.1, flooded.1,
        "comment observations changed under a flood of reads"
    );
    for (n, line) in flooded.1.iter().enumerate() {
        let (outcome, status) = if n < 6 {
            ("would_serve", 200)
        } else {
            ("would_answer", 409)
        };
        assert_eq!(line[0], outcome, "{line}");
        assert_eq!(line[2], status, "{line}");
        assert_eq!(line[9], true, "admission ran past its deadline: {line}");
    }
    for phase in [quiet, flooded] {
        assert_eq!(
            counter(&phase.5, "postVotes", "observed"),
            VOTES.len() as u64
        );
        assert_eq!(
            counter(&phase.5, "postVotes", "wouldServe"),
            VOTES.len() as u64
        );
        assert_eq!(counter(&phase.5, "postVotes", "shed"), 0);
        assert_eq!(
            counter(&phase.5, "postComments", "observed"),
            texts.len() as u64
        );
        assert_eq!(counter(&phase.5, "postComments", "wouldServe"), 6);
        assert_eq!(counter(&phase.5, "postComments", "wouldAnswer"), 1);
        assert_eq!(counter(&phase.5, "postComments", "shed"), 0);
        assert_eq!(
            phase.2, phase.3,
            "a vote or comment observation waited for a connection, timed out or failed"
        );
    }
    assert_eq!(digest(&db.config), before, "an observation changed a row");
}
